// vitest 配置:chat 页纯函数层契约测试(node 环境,零 DOM)
// 与 ui:typecheck 的 tsconfig 互不干扰;测试文件与源码同目录(src/chat/lib/*.test.ts)
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const dir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: dir,
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
