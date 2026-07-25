// ui-vue 构建配置(Vite 6 + Vue3 + TS)
// 要点:
//  - MPA 两页:shell(主窗口,P1 重写) / lab(组件实验室,活样式 guide)
//  - vite-plugin-singlefile 把 JS/CSS 全部内联进单个 html:
//    Electron file:// 对 ES module 的 import fetch 有 CORS 限制,内联后单 html
//    零外部请求,file:// 直开可行,webview 内嵌也可行(铁律:数据不出网,禁运行时外链)
//  - 注意:vite-plugin-singlefile 的 inlineDynamicImports 与 MPA 多输入冲突,
//    故本配置按 UI_PAGE 环境变量单页出参,由 build.mjs 逐页编排(见 build.mjs 头注释)
//  - base './':相对路径,file:// 下资源定位不依赖绝对路径
//  - outDir 指向 ../ui/dist:落在 electron-builder files 白名单 "ui/**/*" 内,
//    打包配置零改动;产物提交入库(内网发包机不一定有构建环境)
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

const dir = path.dirname(fileURLToPath(import.meta.url))
const page = process.env.UI_PAGE || 'shell'   // shell | lab

export default defineConfig({
  root: dir,
  base: './',
  // isCustomElement 放行 <webview>:Electron 内嵌页标签,Vue 不当组件解析
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'webview' } } }), viteSingleFile()],
  build: {
    outDir: path.resolve(dir, '..', 'ui', 'dist'),
    emptyOutDir: false,   // 逐页构建,清理由 build.mjs 统一做一次
    rollupOptions: {
      input: path.resolve(dir, `${page}.html`),
    },
  },
})
