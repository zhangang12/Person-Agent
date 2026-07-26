// ui-vue 构建编排:逐页 singlefile 构建
// 为什么不是 `vite build` 一条命令:vite-plugin-singlefile 靠
// output.inlineDynamicImports=true 内联,而 Rollup 该选项与 MPA 多输入互斥
// ("multiple inputs are not supported when inlineDynamicImports is true")。
// 所以每页一次独立构建(单输入可内联),由本脚本编排;
// --watch 时两个 watcher 并行,改任意源文件两页都会重出产物。
// 用法: node ui-vue/build.mjs [--watch]
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(dir, '..', 'ui', 'dist')
const configFile = path.resolve(dir, 'vite.config.ts')
const PAGES = ['shell', 'lab', 'chat', 'orch']
const watch = process.argv.includes('--watch')

fs.rmSync(outDir, { recursive: true, force: true })   // 统一清理一次

for (const p of PAGES) {
  process.env.UI_PAGE = p
  await build({
    configFile,
    logLevel: 'info',
    build: watch ? { watch: {} } : {},
  })
  console.log(`[ui-vue] page "${p}" ${watch ? 'watching' : 'built'} -> ui/dist/${p}.html`)
}
