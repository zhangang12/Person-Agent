// BocomHermes · 浏览器自动化 MCP（本地 stdio 服务，零依赖）
// 给 opencode/bocomcode 的 agent 扩能：导航/取文本/点击/输入/执行JS/截图。
// 实现：用 CDP(Chrome DevTools Protocol) 驱动【系统已装的 Edge/Chrome】，
//   不依赖 playwright、不下载浏览器；WebSocket 用 Node 内置全局(需 Node 22+)。
// 数据不出网：浏览器与 CDP 全程 127.0.0.1。
// 注册到 opencode.json 的 mcp（type:local, command:["node", 本文件路径]）。见 mcp/README.md。
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const log = (...a) => process.stderr.write('[browser-mcp] ' + a.join(' ') + '\n')   // 日志走 stderr，stdout 只发协议
const HEADFUL = process.env.BOCOMHERMES_BROWSER_HEADFUL === '1'

// ---------- 浏览器发现 ----------
const CANDS = [
  process.env.BOCOMHERMES_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && (process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const findBrowser = () => CANDS.find((p) => { try { return fs.existsSync(p) } catch { return false } })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort(start) {
  return new Promise((resolve) => { const t = (p) => { const s = net.createServer(); s.once('error', () => t(p + 1)); s.once('listening', () => s.close(() => resolve(p))); s.listen(p, '127.0.0.1') }; t(start) })
}

// ---------- 极简 CDP 客户端（基于内置 WebSocket）----------
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data) } catch { return }
        if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message || 'CDP error')) : res(m.result) }
      }
    })
  }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })) }) }
  close() { try { this.ws.close() } catch {} }
}

// ---------- 浏览器会话（懒启动，单页复用）----------
let B = null
async function ensureBrowser() {
  if (B) return B
  if (typeof WebSocket === 'undefined') throw new Error('当前 Node 无内置 WebSocket（需 Node 22+），无法驱动浏览器')
  const exe = findBrowser()
  if (!exe) throw new Error('未找到 Edge/Chrome，可设环境变量 BOCOMHERMES_BROWSER 指向浏览器 exe')
  const port = await freePort(9333)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'BocomHermes-br-'))
  const args = ['--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-allow-origins=*', 'about:blank']
  if (!HEADFUL) args.unshift('--headless=new', '--disable-gpu')
  log('launch', exe, 'port', port, HEADFUL ? '(headful)' : '(headless)')
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
  const base = 'http://127.0.0.1:' + port
  let ver = null
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(base + '/json/version')).json(); break } catch { await sleep(300) } }
  if (!ver) { try { proc.kill() } catch {}; throw new Error('浏览器调试端口未就绪（30s 超时）') }
  let list = []; try { list = await (await fetch(base + '/json/list')).json() } catch {}
  let page = list.find((t) => t.type === 'page')
  if (!page) { try { page = await (await fetch(base + '/json/new', { method: 'PUT' })).json() } catch {} }
  if (!page || !page.webSocketDebuggerUrl) { try { proc.kill() } catch {}; throw new Error('拿不到页面调试端点') }
  const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  B = { proc, cdp, port, dir, base }
  return B
}
function closeBrowser() {
  if (!B) return
  try { B.cdp.close() } catch {}
  try { B.proc.kill() } catch {}
  try { fs.rmSync(B.dir, { recursive: true, force: true }) } catch {}
  B = null
}
async function evalJs(expression, awaitPromise = true) {
  const b = await ensureBrowser()
  const r = await b.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 执行异常')
  return r.result?.value
}
async function navigate(url) {
  const b = await ensureBrowser()
  await b.cdp.send('Page.navigate', { url })
  for (let i = 0; i < 60; i++) { const rs = await evalJs('document.readyState'); if (rs === 'complete' || rs === 'interactive') break; await sleep(300) }
  const title = await evalJs('document.title'); const href = await evalJs('location.href')
  return { title, url: href }
}

// ---------- 技能(录制回放)——经本地中继调 GUI 主进程的强回放引擎 ----------
// 用户在内嵌浏览器里"录制一次→保存为技能",agent 在这里按名字复用。
// 执行不在本文件的 headless 浏览器里(那套是裸 querySelector 弱引擎),而是 relay 回
// GUI 主进程跑 replayRec(selAlt fallback + 登录态恢复 + 红框可视化,用户看得见)。
import http from 'node:http'
function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
function relayCfg() { try { return JSON.parse(fs.readFileSync(path.join(userData(), 'mail-relay.json'), 'utf8')) } catch { return null } }
function relayPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const cfg = relayCfg(); if (!cfg) return reject(new Error('找不到 mail-relay.json — 桌面智能体没在跑,先启动它'))
    const data = JSON.stringify(body || {})
    const req = http.request({ hostname: '127.0.0.1', port: cfg.port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-bocom-tok': cfg.token } }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => buf += c)
      res.on('end', () => { try { const j = JSON.parse(buf || '{}'); j.error ? reject(new Error(j.error)) : resolve(j) } catch (e) { reject(new Error('relay 响应非 JSON: ' + buf.slice(0, 200))) } })
    })
    req.on('error', (e) => reject(new Error('relay 连不上(' + cfg.port + '): ' + e.message)))
    req.write(data); req.end()
  })
}

// ---------- 工具表 ----------
const TOOLS = [
  {
    name: 'skill_list',
    description: '列出用户录制并保存的浏览器自动化技能(名称/说明/参数)。用户提到"用XX技能/按我录的流程跑一遍"或你想复用一条已录好的页面操作时,先调这个看有哪些。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_run',
    description: '按名字运行一条已保存的浏览器技能:在用户可见的内嵌浏览器里逐步自动回放(窗口没开会自动打开),跑完返回每步结果、成功断言与成败结论。params 按 skill_list 给的参数键传值,不传就用录制时的默认值(select 下拉参数传 option 的 value 字典码;跨环境字典不同时建议不传,走录制文本回退)。',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: '技能名(skill_list 返回的 name)' },
      params: { type: 'object', description: '运行时参数,如 {"p1":"6222..."}' },
      baseUrl: { type: 'string', description: '可选,环境根地址(仅 http/https origin,如 https://uat.example.com):替换录制时的环境跑 dev/uat/prod;不传用录制环境。切环境不恢复录制登录态' },
    }, required: ['name'] },
  },
  {
    name: 'skill_run_batch',
    description: '用一批数据循环运行同一条技能(数据集批跑):dataset 每行 = {参数label或key: 值},每行独立回放一遍并汇总 PASS/FAIL。适合"按物料表跑 N 条测试案例 / 批量录入"。用法:先 skill_list 看参数名 → 从 Excel/DB/文件读出数据 → 按参数 label 组行 → 调本工具。默认某行失败继续跑下一行(onError="stop" 则中止);上限 200 行,更多请分批。',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: '技能名(skill_list 返回的 name)' },
      dataset: { type: 'array', items: { type: 'object' }, description: '每行一个对象,键=参数 label(或 key),如 [{"客户手机号":"138…","金额":"8000"}, …]' },
      baseUrl: { type: 'string', description: '可选,环境根地址(http/https origin);切环境不恢复录制登录态' },
      onError: { type: 'string', enum: ['skip', 'stop'], description: '某行失败后:skip=继续下一行(默认)/ stop=中止' },
    }, required: ['name', 'dataset'] },
  },
  {
    name: 'doc_read',
    description: '读一个本地文档文件的文本内容(Excel/CSV/Word/PDF/TXT/MD/HTML/JSON/XML;Excel 转成 CSV 文本,每个 Sheet 一段)。【任务编排】链路的加工环节用它:skill_run 回放导出的文件路径在其报告的「导出/下载文件」行里,拿路径直接读,不要自己写脚本解析二进制。支持 offset/limit 分段读大文件。',
    inputSchema: { type: 'object', properties: {
      path:   { type: 'string', description: '本地文件绝对路径(如 skill_run 报告里给的下载路径)' },
      offset: { type: 'number', description: '从第几个字符开始,默认 0' },
      limit:  { type: 'number', description: '本次取多少字符,默认 8000,最大 50000(大表分段翻,别一口吞)' },
    }, required: ['path'] },
  },
  {
    name: 'skill_page_read',
    description: '【混合执行】读用户可见的内嵌浏览器当前页:URL/标题/可交互元素清单(带现成可用的选择器)/正文节选。技能回放失败被点名接管时,每步操作前先调这个确认页面状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_page_act',
    description: '【混合执行·仅接管期可用】在内嵌浏览器执行一步操作(与回放引擎同一套加固原语,框架事件触发正确)。action: click|type|type_param|select|check|enter|navigate|wait。selector 用 skill_page_read 给的现成选择器,或 __text__:tag|文本(按可见文本);严禁 :has-text()/xpath。secret 参数(密码)用 type_param+key,引擎代填,值不经过你。',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['click', 'type', 'type_param', 'select', 'check', 'enter', 'navigate', 'wait'] },
      selector: { type: 'string', description: '目标元素(click/type/type_param/select/check/enter 用)' },
      value: { type: 'string', description: 'type 的文本 / select 的 value' },
      text: { type: 'string', description: 'select 可选:按选项文本回退' },
      key: { type: 'string', description: 'type_param 用:参数键(如 p1)' },
      checked: { type: 'boolean', description: 'check 用,默认 true' },
      url: { type: 'string', description: 'navigate 用(仅 http/https)' },
      ms: { type: 'number', description: 'wait 用,毫秒(≤5000)' },
    }, required: ['action'] },
  },
  {
    name: 'skill_takeover_done',
    description: '【混合执行】接管收口:剩余流程做完(或确认无法完成)时必须调用,回放据此出报告。status: done=目标达成 / failed=无法完成(note 说明原因)。',
    inputSchema: { type: 'object', properties: { gateId: { type: 'string', description: '接管请求 id(来自接管通知)' }, status: { type: 'string', enum: ['done', 'failed'] }, note: { type: 'string', description: '一句话:做了什么/为何失败' } }, required: ['gateId', 'status'] },
  },
  { name: 'browser_navigate', description: '打开一个网址（在内置无头浏览器里），返回页面标题与最终URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_get_text', description: '获取当前页面可见正文文本(innerText)', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_get_html', description: '获取当前页面或某选择器的 HTML', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器，可空=整页' } } } },
  { name: 'browser_click', description: '点击匹配 CSS 选择器的第一个元素', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'browser_type', description: '向输入框(选择器)填入文本，可选回车提交', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] } },
  { name: 'browser_eval', description: '在页面里执行一段 JS 表达式并返回结果(JSON可序列化)', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'browser_screenshot', description: '对当前页面截图，保存为临时 PNG 并返回文件路径', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_close', description: '关闭内置浏览器、释放资源', inputSchema: { type: 'object', properties: {} } },
]

async function callTool(name, args) {
  args = args || {}
  if (name === 'skill_list') {
    const r = await relayPost('/skill/list', {})
    const list = r.skills || []
    if (!list.length) return '还没有已保存的技能。让用户在内嵌浏览器工具条点「● 录制」把操作跑一遍,停止后「保存为技能」即可复用。'
    const fmtRun = (lr) => lr ? (lr.ok ? `上次运行✓` : `上次运行✗(${lr.fails}步失败)`) : '未运行过'
    return list.map((s) => `· ${s.name} — ${s.description || '(无说明)'} · ${s.steps} 步 · ${fmtRun(s.lastRun)}${s.hasSuccess ? ' · 含成功断言' : ''} · 起始 ${s.startUrl}` +
      (s.params.length ? '\n  参数: ' + s.params.map((p) => `${p.key}=${p.label}${p.secret ? '(密码,必传)' : `(默认 ${p.default === '' ? '空' : p.default})`}`).join(', ') : '')).join('\n')
  }
  if (name === 'skill_run') {
    const body = { name: String(args.name || ''), params: args.params || {} }
    if (args.baseUrl) body.baseUrl = String(args.baseUrl)
    const r = await relayPost('/skill/run', body)
    let out = r.report || JSON.stringify(r)
    // 任务编排的接力棒:导出文件的【完整路径】必须回到 agent 手里(report 兜底再补一次,防主进程侧文案改动漏掉)——
    // 没有路径,"回放导出 → doc_read 加工"这条链就断在第一棒
    if (Array.isArray(r.downloads) && r.downloads.length && !out.includes(r.downloads[0])) {
      out += '\n导出/下载文件(' + r.downloads.length + ' 个,用 doc_read 读内容):\n' + r.downloads.map((p) => '  · ' + p).join('\n')
    }
    return out
  }
  if (name === 'doc_read') {
    const fp = String(args.path || '').trim()
    if (!fp) return '(path 必填:本地文件绝对路径)'
    if (!path.isAbsolute(fp)) return '(path 必须是绝对路径,收到: ' + fp + ')'
    if (!fs.existsSync(fp)) return '(文件不存在: ' + fp + ')'
    // 复用主进程同一套解析(attachments.js 无 electron 依赖,MCP 子进程可直载;xlsx/mammoth/pdf-parse 懒加载,缺依赖会给可读错误)
    const { createRequire } = await import('node:module')
    const attachments = createRequire(import.meta.url)('../src/attachments.js')
    const r = await attachments.extractLocalFile(fp)
    if (!r.ok) return 'doc_read 失败: ' + r.error
    const text = r.text || ''
    const off = Math.max(0, +args.offset || 0)
    const lim = Math.max(1, Math.min(+args.limit || 8000, 50000))
    const chunk = text.slice(off, off + lim)
    const more = off + lim < text.length
    return `[${path.basename(fp)} · ${chunk.length} / ${text.length} 字${more ? ` · 继续传 offset=${off + lim}` : ' · 已完整'}]\n──────────\n${chunk}`
  }
  if (name === 'skill_run_batch') {
    const body = { name: String(args.name || ''), dataset: Array.isArray(args.dataset) ? args.dataset : [] }
    if (args.baseUrl) body.baseUrl = String(args.baseUrl)
    if (args.onError) body.onError = String(args.onError)
    const r = await relayPost('/skill/run-batch', body)
    return r.report || JSON.stringify(r)
  }
  if (name === 'skill_page_read') {
    const r = await relayPost('/skill/page-read', {})
    return '当前页:' + r.url + (r.title ? '(' + r.title + ')' : '') + '\n\n可交互元素(→ 后为现成选择器):\n' + (r.elements || '(无)') + '\n\n正文节选:\n' + String(r.text || '').slice(0, 3000)
  }
  if (name === 'skill_page_act') {
    const body = { action: String(args.action || '') }
    for (const k of ['selector', 'value', 'text', 'key', 'url']) if (args[k] != null) body[k] = String(args[k])
    if (args.checked != null) body.checked = !!args.checked
    if (args.ms != null) body.ms = +args.ms
    const r = await relayPost('/skill/page-act', body)
    return '✓ 已执行 ' + body.action + ',当前页:' + (r.url || '')
  }
  if (name === 'skill_takeover_done') {
    const r = await relayPost('/skill/takeover-done', { gateId: String(args.gateId || ''), status: String(args.status || ''), note: String(args.note || '') })
    return '✓ 接管已收口(' + r.status + '),回放报告随之更新。'
  }
  if (name === 'browser_navigate') { const r = await navigate(String(args.url || '')); return `已打开：${r.title}\n${r.url}` }
  if (name === 'browser_get_text') { return String(await evalJs('document.body ? document.body.innerText : document.documentElement.innerText') || '').slice(0, 20000) }
  if (name === 'browser_get_html') { const sel = args.selector ? JSON.stringify(args.selector) : null; const expr = sel ? `(document.querySelector(${sel})||{}).outerHTML||''` : 'document.documentElement.outerHTML'; return String(await evalJs(expr) || '').slice(0, 40000) }
  if (name === 'browser_click') { const sel = JSON.stringify(String(args.selector)); const r = await evalJs(`(()=>{const el=document.querySelector(${sel}); if(!el) return 'NOT_FOUND'; el.click(); return 'OK';})()`); return r === 'OK' ? '已点击 ' + args.selector : '未找到元素：' + args.selector }
  if (name === 'browser_type') {
    const sel = JSON.stringify(String(args.selector)), txt = JSON.stringify(String(args.text))
    const r = await evalJs(`(()=>{const el=document.querySelector(${sel}); if(!el) return 'NOT_FOUND'; el.focus(); el.value=${txt}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';})()`)
    if (r !== 'OK') return '未找到输入框：' + args.selector
    if (args.submit) await evalJs(`(()=>{const el=document.querySelector(${sel}); if(el&&el.form) el.form.submit(); return 'OK';})()`)
    return '已输入到 ' + args.selector + (args.submit ? '（并提交）' : '')
  }
  if (name === 'browser_eval') { const v = await evalJs(String(args.expression || '')); return typeof v === 'string' ? v : JSON.stringify(v) }
  if (name === 'browser_screenshot') {
    const b = await ensureBrowser(); const r = await b.cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(os.tmpdir(), 'BocomHermes-shot-' + Date.now() + '.png'); fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return '已截图：' + file
  }
  if (name === 'browser_close') { closeBrowser(); return '已关闭浏览器' }
  throw new Error('未知工具：' + name)
}

// ---------- MCP stdio 协议（行分隔 JSON-RPC 2.0）----------
const PROTO = '2024-11-05'
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }) }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'BocomHermes-browser', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const nm = params && params.name
    try { const text = await callTool(nm, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '工具出错：' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) fail(id, -32601, '未实现的方法：' + method)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    Promise.resolve(handle(msg)).catch((e) => log('handle error', e && e.message || e))
  }
})
process.on('exit', closeBrowser)
process.on('SIGTERM', () => { closeBrowser(); process.exit(0) })
process.on('SIGINT', () => { closeBrowser(); process.exit(0) })
log('ready (headful=' + HEADFUL + ', browser=' + (findBrowser() || 'NOT FOUND') + ')')
