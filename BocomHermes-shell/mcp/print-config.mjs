// 打印可粘贴进 opencode.json 的 MCP 注册块（自动填好本机绝对路径）。用法： node mcp/print-config.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const abs = (f) => path.join(__dirname, f).replace(/\\/g, '/')
const cfg = {
  $schema: 'https://opencode.ai/config.json',
  mcp: {
    'BocomHermes-browser': { type: 'local', command: ['node', abs('browser-mcp.mjs')], enabled: true, environment: { BOCOMHERMES_BROWSER_HEADFUL: '0' } },
    'BocomHermes-httpcap': { type: 'local', command: ['node', abs('httpcap-mcp.mjs')], enabled: true },
    'BocomHermes-git':     { type: 'local', command: ['node', abs('git-mcp.mjs')],     enabled: true },
    'BocomHermes-repro':   { type: 'local', command: ['node', abs('repro-mcp.mjs')],   enabled: true },
    'BocomHermes-mail':    { type: 'local', command: ['node', abs('mail-mcp.mjs')],    enabled: true },
    'BocomHermes-db':      { type: 'local', command: ['node', abs('db-mcp.mjs')],      enabled: true },
    'BocomHermes-orch':    { type: 'local', command: ['node', abs('orch-mcp.mjs')],    enabled: true },
    'BocomHermes-doc':     { type: 'local', command: ['node', abs('doc-mcp.mjs')],     enabled: true },
  },
}
console.log('把下面这段合并进 opencode / bocomcode 的 opencode.json（已填好本机路径）：\n')
console.log(JSON.stringify(cfg, null, 2))
console.log('\n注册后，任何 agent（含工作流 worker）即可调用：')
console.log('  浏览器：browser_navigate / browser_get_text / browser_click / browser_eval …')
console.log('  抓包  ：httpcap_start / httpcap_list / httpcap_get …')
console.log('  Git   ：git_status / git_log / git_diff / git_blame / git_show / git_branch')
console.log('  复现取证(Phase D)：list_bundles / list_evidence / get_evidence / get_dom_subtree / get_event_window')
console.log('  邮件+待办：mail_list / mail_get_full / mail_get_attachment_text / mail_send / mail_reply / mail_mark_read / mail_archive / todo_add / todo_list / todo_complete')
console.log('  数据库(OceanBase 只读)：db_tables / db_schema / db_columns_grep / db_sample / db_query')
console.log('  动态编排(自主升格)：run_workflow — 对话 Agent 判断任务复杂时自主拉起动态工作流(动态拆解+并行+人审闸)')
console.log('  文档读取：read_document — 按需把用户拖入的 PDF/DOCX/XLSX/… 抽成文本(支持分段)')
console.log('要看见浏览器窗口：把 BocomHermes-browser 的 BOCOMHERMES_BROWSER_HEADFUL 设为 "1"。')
