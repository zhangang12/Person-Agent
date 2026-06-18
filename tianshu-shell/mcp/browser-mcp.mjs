// 天枢 · 浏览器自动化 MCP（本地 stdio 服务，零依赖）
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
const HEADFUL = process.env.TIANSHU_BROWSER_HEADFUL === '1'

// ---------- 浏览器发现 ----------
const CANDS = [
  process.env.TIANSHU_BROWSER,
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
  if (!exe) throw new Error('未找到 Edge/Chrome，可设环境变量 TIANSHU_BROWSER 指向浏览器 exe')
  const port = await freePort(9333)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianshu-br-'))
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

// ---------- 工具表 ----------
const TOOLS = [
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
    const file = path.join(os.tmpdir(), 'tianshu-shot-' + Date.now() + '.png'); fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
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
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'tianshu-browser', version: '0.1.0' } })
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
