// BocomHermes · LSP 客户端 MCP(本地 stdio,零业务依赖)
// 给模型一个【主动】用 LSP 的工具入口 —— opencode serve 内置的 LSP 对模型不可见(模型手里没有
// 工具能触发它,只会说 "no LSP available"),本 MCP 把 LSP 能力摆成三个工具:
//   · lsp_definition  {file,line,character} → 跳转定义,返回 file:line:col 列表;
//   · lsp_references  {file,line,character,includeDeclaration?} → 查引用,标注哪处是声明/定义;
//   · lsp_diagnostics {file?} → 诊断清单(级别/行列/消息/source);不传 file 汇总所有已打开文件。
// 设计要点:
//   · LSP server 全部随包自带(typescript-language-server / @vue/language-server / pyright),
//     按扩展名路由:ts/tsx/js/jsx/mjs/cjs/mts/cts→ts、vue→vue、py/pyi→python;
//     每个 server 单例懒启动(第一次用到才 spawn),崩溃自动重启一次,再崩就报错不折腾。
//   · server 入口相对本文件定位(__dirname/../node_modules/...):开发态=仓库 node_modules;
//     打包后 mcp/ 与三个 LSP 包都在 resources/app.asar.unpacked/ 里(见 package.json build.asarUnpack),
//     目录结构同构,同一条相对路径两边都成立。
//   · spawn 用 process.execPath(MCP 进程由 serve 以 node 拉起,execPath 即 node,与 Electron 无关)。
//   · LSP 走 Content-Length 帧(stdio);MCP 侧与家族其它 server 一样是 NDJSON(一行一条 JSON-RPC)。
//   · 行列换算:LSP 规范 line/character 是 0 基;工具入参按人类习惯 1 基,进出统一在此换算。
//   · 路径围栏:文件必须落在项目根(process.cwd(),serve spawn MCP 时继承项目目录)之内,防越权读盘。
//   · 单次 LSP 请求 15s 超时(initialize 30s,首启要拉 tsserver);MCP 进程退出时杀掉全部 LSP 子进程。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const log = (...a) => process.stderr.write('[lsp-mcp] ' + a.join(' ') + '\n')

// 项目根 = MCP 进程 cwd(serve spawn 时继承项目目录),也是路径围栏的边界
const ROOT = process.cwd()

// ── 纯函数(自测直接 import 这部分) ──

// LSP Content-Length 帧编码(注意与外层 MCP 的 NDJSON 是两套协议,别混)
export function encodeFrame(obj) {
  const s = JSON.stringify(obj)
  return 'Content-Length: ' + Buffer.byteLength(s, 'utf8') + '\r\n\r\n' + s
}

// 增量帧解码器:数据可任意分片到达,一次 data 也可能含多帧;中文等多字节内容按字节长度截
export function createFrameDecoder(onMessage) {
  let buf = Buffer.alloc(0)
  return {
    feed(chunk) {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const headEnd = buf.indexOf('\r\n\r\n')
        if (headEnd === -1) return
        const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, headEnd).toString('ascii'))
        if (!m) { buf = buf.slice(headEnd + 4); continue } // 头部损坏:丢这段头部继续,防死循环
        const len = parseInt(m[1], 10)
        if (buf.length < headEnd + 4 + len) return // 体没到齐,等下一片
        const body = buf.slice(headEnd + 4, headEnd + 4 + len).toString('utf8')
        buf = buf.slice(headEnd + 4 + len)
        try { onMessage(JSON.parse(body)) } catch (e) { log('帧 JSON 解析失败: ' + e.message) }
      }
    },
  }
}

// 扩展名 → LSP server 路由表(entry 相对 <根>/node_modules)
export const SERVER_DEFS = {
  ts:     { name: 'typescript-language-server', entry: 'typescript-language-server/lib/cli.mjs',      exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'] },
  vue:    { name: 'vue-language-server',        entry: '@vue/language-server/bin/vue-language-server.js', exts: ['.vue'] },
  python: { name: 'pyright',                    entry: 'pyright/langserver.index.js',                 exts: ['.py', '.pyi'] },
}
export function routeServer(file) {
  const ext = path.extname(String(file)).toLowerCase()
  for (const [key, def] of Object.entries(SERVER_DEFS)) if (def.exts.includes(ext)) return key
  return null
}

// didOpen 用的 languageId(与路由表分开:LSP 协议要的是语言 id 不是 server key)
const LANG_IDS = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
  '.vue': 'vue', '.py': 'python', '.pyi': 'python',
}

// 行列换算:LSP 0 基 ↔ 工具入参/出参 1 基(人类数行从 1 开始)
export const toLspPos = (line, character) => ({ line: Math.max(0, (line | 0) - 1), character: Math.max(0, (character | 0) - 1) })
export const fromLspPos = (pos) => ({ line: pos.line + 1, character: pos.character + 1 })

// 路径围栏:解析到项目根内的绝对路径;越界(.. 逃逸 / 根外绝对路径)返回 null
export function resolveInRoot(root, file) {
  const r = path.resolve(root)
  const abs = path.resolve(r, String(file))
  const rel = path.relative(r, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

// server 入口绝对路径(开发态与打包态同构,见文件头注释)
function serverEntryPath(def) { return path.join(__dirname, '..', 'node_modules', def.entry) }

// ── LSP 客户端(单 server 进程的生命周期:懒启动 / 请求复用 / 崩溃重启一次) ──
export class LspClient {
  constructor({ serverKey, root, logf }) {
    this.key = serverKey
    this.def = SERVER_DEFS[serverKey]
    this.root = path.resolve(root)
    this.log = logf || log
    this.proc = null
    this.nextId = 1
    this.pending = new Map()      // id → {resolve,reject,timer,method}
    this.diagnostics = new Map()  // uri → {items,at}(publishDiagnostics 通知的最新快照)
    this.opened = new Set()       // 已 didOpen 的 uri(server 重启后清空,需重新 open)
    this.diagWaiters = []         // 等某 uri 第一份诊断的 {uri,resolve,timer}
    this.ready = null             // initialize 进行中的 Promise
    this.restarts = 0             // 已崩溃次数,>1 就不再重启
  }

  async ensureStarted() {
    if (this.ready) { await this.ready; return }
    if (this.restarts > 1) throw new Error(this.def.name + ' 崩溃重启过一次仍不可用,放弃(看 [lsp-mcp] 日志)')
    const entry = serverEntryPath(this.def)
    if (!fs.existsSync(entry)) throw new Error('找不到 LSP server 入口: ' + entry + '(node_modules 没装齐?)')
    this.log('spawn ' + this.def.name + ' cwd=' + this.root)
    const proc = spawn(process.execPath, [entry, '--stdio'], { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stderr.on('data', (d) => { const s = String(d).trim(); if (s) this.log(this.def.name + ' stderr: ' + s.slice(0, 300)) })
    const decode = createFrameDecoder((msg) => this._onMessage(msg))
    proc.stdout.on('data', (d) => decode.feed(d))
    proc.on('error', (e) => this._onCrash('spawn 失败: ' + e.message))
    proc.on('exit', (code, sig) => this._onCrash('进程退出 code=' + code + ' sig=' + sig))
    const init = (async () => {
      await this.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        capabilities: { textDocument: { definition: { linkSupport: true }, references: {}, publishDiagnostics: {} } },
      }, 30000) // 首启要拉 tsserver 等,给足 30s
      this.notify('initialized', {})
      this.log(this.def.name + ' 初始化完成')
    })()
    this.ready = init
    try { await init } catch (e) { this.ready = null; this._killProc(); throw e }
  }

  _onCrash(why) {
    if (!this.proc) return
    this.proc = null
    this.ready = null
    this.restarts++
    this.opened.clear()      // server 状态全丢,重启后重新 didOpen
    this.diagnostics.clear()
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(this.def.name + ' 崩溃: ' + why)) }
    this.pending.clear()
    this.log(this.def.name + ' crashed: ' + why + '(第 ' + this.restarts + ' 次)')
  }

  _onMessage(msg) {
    // 响应:有 id 且带 result/error
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(this.def.name + ' ' + p.method + ': ' + (msg.error.message || JSON.stringify(msg.error))))
      else p.resolve(msg.result)
      return
    }
    // 通知:诊断推送
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params && msg.params.uri
      if (!uri) return
      this.diagnostics.set(uri, { items: msg.params.diagnostics || [], at: Date.now() })
      this.diagWaiters = this.diagWaiters.filter((w) => {
        if (w.uri !== uri) return true
        clearTimeout(w.timer); w.resolve(); return false
      })
      return
    }
    // server 反向请求(workspace/configuration、进度登记等):一律回空,不答会挂住对端
    if (msg.id != null && msg.method) {
      const items = msg.method === 'workspace/configuration' && msg.params && Array.isArray(msg.params.items) ? msg.params.items : null
      this._send({ jsonrpc: '2.0', id: msg.id, result: items ? items.map(() => null) : null })
    }
  }

  _send(obj) { try { this.proc.stdin.write(encodeFrame(obj)) } catch (e) { this.log('写帧失败: ' + e.message) } }

  notify(method, params) { this._send({ jsonrpc: '2.0', method, params }) }

  request(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) return reject(new Error(this.def.name + ' 进程不在'))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(this.def.name + ' ' + method + ' 超时(' + Math.round(timeoutMs / 1000) + 's)——server 可能还在建索引,稍后再试'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this._send({ jsonrpc: '2.0', id, method, params })
    })
  }

  // didOpen(每 uri 一次):text 从磁盘读,语言 id 按扩展名
  async openFile(absPath) {
    const uri = pathToFileURL(absPath).href
    if (this.opened.has(uri)) return uri
    const text = await fs.promises.readFile(absPath, 'utf8')
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANG_IDS[path.extname(absPath).toLowerCase()] || 'plaintext', version: 1, text } })
    this.opened.add(uri)
    return uri
  }

  // 等某 uri 的第一份诊断推送(拿到过就立即返回;超时也返回,读到的可能为空)
  waitDiagnostics(uri, ms) {
    if (this.diagnostics.has(uri)) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.diagWaiters = this.diagWaiters.filter((w) => w.timer !== timer); resolve() }, ms)
      this.diagWaiters.push({ uri, resolve, timer })
    })
  }

  _killProc() { const p = this.proc; this.proc = null; this.ready = null; if (p) { try { p.kill() } catch {} } }
  kill() { this.restarts = 99; this._killProc() } // 主动关闭:不再触发自动重启
}

// ── server 单例注册表(每种语言一个进程,懒启动) ──
const clients = new Map()
function clientForFile(absPath) {
  const key = routeServer(absPath)
  if (!key) return { error: '不支持的文件类型 "' + (path.extname(absPath) || '(无扩展名)') + '" —— 支持 ts/tsx/js/jsx/mjs/cjs、vue、py/pyi' }
  let c = clients.get(key)
  if (!c) { c = new LspClient({ serverKey: key, root: ROOT }); clients.set(key, c) }
  return { client: c }
}

// ── 结果格式化 ──
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/') || abs

// Location 与 LocationLink 两种形态统一抽 {file,line,character}(1 基)
function locToPos(loc) {
  const uri = loc && (loc.uri || loc.targetUri)
  const range = loc && (loc.range || loc.targetSelectionRange || loc.targetRange)
  if (!uri || !range) return null
  try {
    const p = fromLspPos(range.start)
    return { file: fileURLToPath(uri), line: p.line, character: p.character }
  } catch { return null }
}

const SEV = { 1: '错误', 2: '警告', 3: '信息', 4: '提示' }
function formatDiags(entries) {
  const lines = []
  let total = 0
  for (const [uri, d] of entries) {
    const items = (d && d.items) || []
    total += items.length
    if (!items.length) continue
    let name = uri
    try { name = rel(fileURLToPath(uri)) } catch {}
    lines.push(name + ':')
    for (const it of items.slice(0, 50)) {
      const p = fromLspPos(it.range.start)
      lines.push('  [' + (SEV[it.severity] || '级别' + it.severity) + '] ' + p.line + ':' + p.character + ' ' + it.message + (it.source ? ' (' + it.source + ')' : ''))
    }
    if (items.length > 50) lines.push('  …共 ' + items.length + ' 条,只列前 50')
  }
  if (!total) return '没有诊断问题(或 server 尚未推送,仍在分析中——可稍后再调一次)'
  return '诊断(共 ' + total + ' 条):\n' + lines.join('\n')
}

// ── MCP 工具实现 ──
async function callTool(name, a) {
  a = a || {}
  if (name === 'lsp_definition' || name === 'lsp_references') {
    const file = String(a.file || '').trim()
    const line = Number(a.line), character = Number(a.character)
    if (!file) return '需要 file(项目内文件路径,相对/绝对均可)'
    if (!Number.isFinite(line) || !Number.isFinite(character) || line < 1 || character < 1) return 'line/character 须为 ≥1 的整数(1 基,人类数法)'
    const abs = resolveInRoot(ROOT, file)
    if (!abs) return '路径越界:' + file + ' 不在项目目录(' + ROOT + ')内,拒绝读取'
    if (!fs.existsSync(abs)) return '文件不存在: ' + rel(abs)
    const { client, error } = clientForFile(abs)
    if (error) return error
    await client.ensureStarted()
    const uri = await client.openFile(abs)
    const position = toLspPos(line, character)
    if (name === 'lsp_definition') {
      const r = await client.request('textDocument/definition', { textDocument: { uri }, position })
      const locs = (Array.isArray(r) ? r : r ? [r] : []).map(locToPos).filter(Boolean)
      if (!locs.length) return '没有找到定义(该位置可能没有符号,或 server 还在建索引——稍后再试)'
      return '定义位置(' + locs.length + ' 处):\n' + locs.map((l) => '- ' + rel(l.file) + ':' + l.line + ':' + l.character).join('\n')
    }
    // lsp_references:顺带查一次定义,把"声明/定义处"在引用清单里标出来
    const includeDecl = a.includeDeclaration !== false
    const [refs, defs] = await Promise.all([
      client.request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: includeDecl } }),
      client.request('textDocument/definition', { textDocument: { uri }, position }).catch(() => null),
    ])
    const defKeys = new Set((Array.isArray(defs) ? defs : defs ? [defs] : []).map(locToPos).filter(Boolean).map((l) => l.file + ':' + l.line + ':' + l.character))
    const locs = (Array.isArray(refs) ? refs : refs ? [refs] : []).map(locToPos).filter(Boolean)
    if (!locs.length) return '没有找到引用' + (includeDecl ? '(含声明)' : '') + '(server 可能还在建索引——稍后再试)'
    return '引用位置(' + locs.length + ' 处' + (includeDecl ? ',含声明' : '') + '):\n' + locs.map((l) => '- ' + rel(l.file) + ':' + l.line + ':' + l.character + (defKeys.has(l.file + ':' + l.line + ':' + l.character) ? '  ← 声明/定义处' : '')).join('\n')
  }
  if (name === 'lsp_diagnostics') {
    if (a.file != null && String(a.file).trim()) {
      const abs = resolveInRoot(ROOT, String(a.file).trim())
      if (!abs) return '路径越界:' + a.file + ' 不在项目目录(' + ROOT + ')内,拒绝读取'
      if (!fs.existsSync(abs)) return '文件不存在: ' + rel(abs)
      const { client, error } = clientForFile(abs)
      if (error) return error
      await client.ensureStarted()
      const uri = await client.openFile(abs)
      await client.waitDiagnostics(uri, 10000) // 诊断是异步推送,等第一份(最多 10s)
      return formatDiags([[uri, client.diagnostics.get(uri)]])
    }
    // 不传 file:汇总所有已打开文件的最新诊断
    const entries = []
    for (const c of clients.values()) for (const [uri, d] of c.diagnostics) entries.push([uri, d])
    if (!entries.length) return '还没有任何已打开文件的诊断(先调 lsp_definition/lsp_references,或带 file 参数指定)'
    return formatDiags(entries)
  }
  throw new Error('未知工具: ' + name)
}

const TOOLS = [
  {
    name: 'lsp_definition',
    description:
      '跳转定义:给出符号在 file:line:col(1 基)的位置,返回它的定义位置列表。\n' +
      '【何时调】看代码遇到陌生函数/类/变量,想知道它到底在哪定义,比 grep 全仓精准(只走真实语义,不受同名干扰)。\n' +
      '支持 ts/tsx/js/jsx/mjs/cjs、vue、py/pyi;file 须在项目目录内。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '项目内文件路径(相对项目根或绝对路径均可)' },
        line: { type: 'number', description: '符号所在行(1 基)' },
        character: { type: 'number', description: '符号所在列(1 基,指向符号内任意字符)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_references',
    description:
      '查引用:给出符号在 file:line:col(1 基)的位置,返回全项目引用它的位置列表(结果里会标注哪处是声明/定义)。\n' +
      '【何时调】改函数签名/删代码前评估影响面——"都有谁在用它",比文本搜索准(不串同名符号)。\n' +
      '支持 ts/tsx/js/jsx/mjs/cjs、vue、py/pyi;file 须在项目目录内。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '项目内文件路径(相对项目根或绝对路径均可)' },
        line: { type: 'number', description: '符号所在行(1 基)' },
        character: { type: 'number', description: '符号所在列(1 基,指向符号内任意字符)' },
        includeDeclaration: { type: 'boolean', description: '是否把声明处也算进结果(默认 true)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_diagnostics',
    description:
      '看诊断:返回 LSP server 对文件的实时诊断清单(级别[错误/警告/信息/提示]、行列、消息、来源)。\n' +
      '【何时调】改完代码想确认没引入编译/类型错误,不必跑完整构建;传 file 看单个文件,不传则汇总本次会话所有已打开文件。\n' +
      '诊断是 server 分析完异步推送的,首次调用可能还在分析,稍后再调一次即可。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '项目内文件路径(可空;不传 = 汇总所有已打开文件)' },
      },
    },
  },
]

// ── MCP stdio 协议(NDJSON,与家族其它 server 同款) ──
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'bocomhermes-lsp', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: 'LSP 工具出错: ' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现: ' + method } })
}

// 仅作为 `node mcp/lsp-mcp.mjs` 直接运行时才进 stdio 主循环(自测 import 纯函数不触发)
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase()
if (isMain) {
  const shutdown = () => { for (const c of clients.values()) c.kill(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.on('end', shutdown) // serve 关掉 stdio 时跟着退,LSP 子进程全部带走
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle err: ' + e.message)) } })
  log('ready · root=' + ROOT)
}
