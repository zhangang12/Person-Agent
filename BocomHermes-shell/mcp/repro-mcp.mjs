// BocomHermes · 复现取证 MCP(本地 stdio 服务,零依赖)
// 给 agent 提供"按需取大块证据"的工具,配合"证据包"摘要里的 ref# 引用使用。
// 主上下文只放 ~5KB 摘要,真要细节(完整 DOM / 长 req body / 完整事件帧)agent 自己 call 这些工具拉。
// 数据全在本机 userData/evidence/,完全离线;只读,不修改任何东西。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const log = (...a) => process.stderr.write('[repro-mcp] ' + a.join(' ') + '\n')

// userData 路径(跟主应用对齐):Windows = %APPDATA%/BocomHermes-shell;macOS = ~/Library/Application Support/BocomHermes-shell;Linux = ~/.config/BocomHermes-shell
function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
const EVD = path.join(userData(), 'evidence')
const REC = path.join(userData(), 'recordings')

// ref 形如 "ref#b_lz4kj/dom" → bundleId=b_lz4kj, name=dom
function parseRef(s) {
  const m = String(s || '').match(/^(?:ref#)?([^/]+)\/(.+)$/)
  if (!m) return null
  return { bundleId: m[1], name: m[2] }
}
function readEvd(ref) {
  const p = parseRef(ref); if (!p) return null
  const fp = path.join(EVD, p.bundleId, p.name + '.txt')
  try { return { path: fp, text: fs.readFileSync(fp, 'utf8') } } catch { return null }
}

const TOOLS = [
  { name: 'list_bundles', description: '列出最近的复现包(bundleId 列表,最新在前)。看不到具体 bundleId 时先调这个。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'list_evidence', description: '列出某个复现包里所有可取的证据 ref(dom / err*-stack / req*-body / resp*-body / recording 等)', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' } }, required: ['bundleId'] } },
  { name: 'get_evidence', description: '按 ref 拉取证据全文(ref 形如 "ref#bundleId/name" 或简写 "bundleId/name")。常用于 dom / req-body / resp-body / err-stack', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, head: { type: 'number', description: '只取前 N 字符,省略=全文' } }, required: ['ref'] } },
  { name: 'get_dom_subtree', description: '从一个复现包的完整 DOM 中,按 CSS 选择器抽某个子树的 outerHTML(优先用这个而非整页 dom)', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' }, selector: { type: 'string' } }, required: ['bundleId', 'selector'] } },
  { name: 'get_event_window', description: '从录制时间线里取某一步前后 ±N 步的窗口,看用户在出问题前后做了什么。先 list_bundles 拿 recording ref。', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' }, step: { type: 'number' }, radius: { type: 'number' } }, required: ['bundleId', 'step'] } },
]

async function callTool(name, a) {
  a = a || {}
  if (name === 'list_bundles') {
    try {
      const ds = fs.readdirSync(EVD).filter((d) => /^b_/.test(d))
      const sorted = ds.map((d) => ({ id: d, m: (fs.statSync(path.join(EVD, d)).mtimeMs) })).sort((x, y) => y.m - x.m).slice(0, a.limit || 20)
      return sorted.length ? sorted.map((s) => `${s.id}  (${new Date(s.m).toISOString().replace('T', ' ').slice(0, 19)})`).join('\n') : '(暂无证据包)'
    } catch (e) { return '(读取失败:' + e.message + ')' }
  }
  if (name === 'list_evidence') {
    const d = path.join(EVD, String(a.bundleId)); let files = []
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')) } catch (e) { return '(找不到 bundle "' + a.bundleId + '":' + e.message + ')' }
    if (!files.length) return '(空)'
    const lines = files.map((n) => { const p = path.join(d, n + '.txt'); const sz = (fs.statSync(p).size); return `  ref#${a.bundleId}/${n}    (${sz}B)` })
    return '复现包 ' + a.bundleId + ' 含 ' + files.length + ' 份证据:\n' + lines.join('\n')
  }
  if (name === 'get_evidence') {
    const r = readEvd(a.ref); if (!r) return '(找不到 ref:' + a.ref + ')'
    const t = a.head ? r.text.slice(0, Number(a.head)) : r.text
    return `# ${a.ref}  (${r.text.length}B${a.head && a.head < r.text.length ? ', 取前 ' + a.head + ' 字' : ''})\n` + t
  }
  if (name === 'get_dom_subtree') {
    const r = readEvd(a.bundleId + '/dom'); if (!r) return '(找不到 bundle 的 dom,先 list_bundles 看 id 对不对)'
    // 用一个超轻的 outerHTML 抽取:不引入完整 DOM parser,用正则定位选择器目标的 outerHTML
    // 仅支持 id / class / tagname 简单选择器;复杂选择器请改用浏览器里的 picker 再来
    const sel = String(a.selector || '').trim()
    let pat
    if (sel.startsWith('#')) pat = new RegExp('<([a-zA-Z][\\w-]*)([^>]*\\bid\\s*=\\s*["\\\']' + sel.slice(1).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '["\\\'][^>]*)>', 'i')
    else if (sel.startsWith('.')) pat = new RegExp('<([a-zA-Z][\\w-]*)([^>]*\\bclass\\s*=\\s*["\\\'][^"\\\']*\\b' + sel.slice(1).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b[^"\\\']*["\\\'][^>]*)>', 'i')
    else pat = new RegExp('<(' + sel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + ')(\\s[^>]*|)>', 'i')
    const m = r.text.match(pat)
    if (!m) return '(在 DOM 里找不到选择器 "' + sel + '";支持 #id / .class / tagname)'
    const tag = m[1]
    const start = m.index
    // 从 start 起平衡 <tag>...</tag>(忽略自闭合)
    const open = new RegExp('<' + tag + '(\\s[^>]*|)>', 'gi'); open.lastIndex = start
    const close = new RegExp('</' + tag + '\\s*>', 'gi'); close.lastIndex = start
    let depth = 0, pos = start, end = -1, safety = 0
    while (safety++ < 2000) {
      open.lastIndex = pos; close.lastIndex = pos
      const o = open.exec(r.text), c = close.exec(r.text)
      if (!c) break
      if (o && o.index < c.index) { depth++; pos = o.index + o[0].length }
      else { depth--; pos = c.index + c[0].length; if (depth === 0) { end = pos; break } }
    }
    const out = end > start ? r.text.slice(start, end) : r.text.slice(start, start + 4000)
    return `# ${a.bundleId} → ${sel}  (${out.length}B)\n` + (out.length > 8000 ? out.slice(0, 8000) + '\n<!-- ...(截断,完整 outerHTML 见 ref#' + a.bundleId + '/dom) -->' : out)
  }
  if (name === 'get_event_window') {
    const r = readEvd(a.bundleId + '/recording'); if (!r) return '(找不到 bundle 的 recording — 这次没录制?)'
    let rec; try { rec = JSON.parse(r.text) } catch { return '(recording JSON 解析失败)' }
    const events = rec.events || []
    const step = Math.max(0, Math.min(events.length - 1, Number(a.step) - 1))
    const rad = Math.max(0, Number(a.radius || 3))
    const lo = Math.max(0, step - rad), hi = Math.min(events.length - 1, step + rad)
    const lines = events.slice(lo, hi + 1).map((e, i) => {
      const idx = lo + i + 1; const mark = (lo + i) === step ? ' ◀──' : ''
      return `  步 ${idx}${mark}  t=${((e.t || 0) / 1000).toFixed(1)}s  ${e.act.padEnd(8)} ${e.sel || e.url || ''}${e.text ? ' "' + e.text + '"' : ''}${e.value ? ' = "' + e.value + '"' : ''}${e.key ? ' key:' + e.key : ''}`
    })
    return `录制 ${a.bundleId} 步 ${step + 1} 的 ±${rad} 步窗口(共 ${events.length} 步):\n` + lines.join('\n')
  }
  throw new Error('未知工具:' + name)
}

// ── MCP stdio 协议 ──
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'bocomhermes-repro', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '工具出错:' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现:' + method } })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle err: ' + e.message)) } })
log('ready · evidence=' + EVD)
