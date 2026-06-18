// 打印可粘贴进 opencode.json 的 MCP 注册块（自动填好本机绝对路径）。用法： node mcp/print-config.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const abs = path.join(__dirname, 'browser-mcp.mjs').replace(/\\/g, '/')
const cfg = {
  $schema: 'https://opencode.ai/config.json',
  mcp: { 'tianshu-browser': { type: 'local', command: ['node', abs], enabled: true, environment: { TIANSHU_BROWSER_HEADFUL: '0' } } },
}
console.log('把下面这段合并进 opencode / bocomcode 的 opencode.json（已填好本机路径）：\n')
console.log(JSON.stringify(cfg, null, 2))
console.log('\n注册后，任何 agent（含工作流 worker）即可调用 browser_navigate / browser_get_text 等工具。')
console.log('要看见浏览器窗口：把 TIANSHU_BROWSER_HEADFUL 设为 "1"。')
