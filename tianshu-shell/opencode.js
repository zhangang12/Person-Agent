// opencode serve 连接层 —— 按【项目目录】分池的多 serve。
// 事实：此版本 POST /session 不支持会话级目录（directory/cwd/path 均被忽略），
// 每个会话都用 serve 的启动目录。因此：一个项目目录 = 一个独立 serve（各占一端口）。
//   · 同项目多卡 → 复用同一 serve 的多个并发会话（任务隔离）
//   · 不同项目  → 各自 serve（进程级隔离）
// 终端日志一律英文，避免 Windows 控制台乱码。
const { spawn } = require('child_process')
const net = require('net')
const http = require('http')

const AUTO_ALLOW = new Set(['read', 'grep', 'glob', 'list', 'ls', 'find', 'tree'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pool = new Map()      // dirKey -> info { dir, base, port, proc, permStyle, ready }
let sampleLogged = false
const seenPartTypes = new Set()   // 每种 part 类型打印一次（确认 reasoning/text 等）

// 用 Node http 而非 fetch：智能体一轮可能跑几分钟，POST /message 在结束前一直挂着，
// 而 fetch(undici) 默认 5 分钟 headersTimeout 会把它判超时抛 "fetch failed"。http 无此超时。
function api(base, method, path, body) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(base + path) } catch (e) { return reject(e) }
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      let txt = ''; res.setEncoding('utf8')
      res.on('data', (c) => { txt += c })
      res.on('end', () => {
        const code = res.statusCode || 0
        if (code < 200 || code >= 300) return reject(new Error(`${method} ${path} -> ${code}: ${txt.slice(0, 200)}`))
        try { resolve(txt ? JSON.parse(txt) : undefined) } catch (e) { reject(new Error(`${method} ${path} -> 非 JSON 响应: ${txt.slice(0, 120)}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(0)            // 不超时：长任务期间连接保持
    if (data) req.write(data)
    req.end()
  })
}
async function healthAt(base) { try { await api(base, 'GET', '/global/health'); return true } catch { return false } }

// 找一个空闲端口（绕开被占用的，比如残留的旧 serve）
function freePort(start) {
  return new Promise((resolve) => {
    const test = (p) => {
      const s = net.createServer()
      s.once('error', () => test(p + 1))
      s.once('listening', () => s.close(() => resolve(p)))
      s.listen(p, '127.0.0.1')
    }
    test(start)
  })
}
// serve 二进制名可配：开发 = opencode，打包 exe = bocomcode（由 main 注入）
let SERVE_BIN = 'opencode'
function setServeBin(name) { if (name) SERVE_BIN = name }
function spawnServe(cwd, port) {
  return spawn(SERVE_BIN, ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    { cwd: cwd || undefined, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true })
}
async function waitHealthy(base, getExit) {
  for (let i = 0; i < 60; i++) {
    if (await healthAt(base)) return
    const ex = getExit && getExit()   // 进程提前退出（多半是找不到二进制）→ 快速失败，别空等 30s
    if (ex) throw new Error('serve 进程提前退出（' + (ex.error || ('code ' + ex.code)) + '）：请确认 ' + SERVE_BIN + ' 已安装并在 PATH 中')
    await sleep(500)
  }
  throw new Error('opencode serve start timeout (30s)')
}
async function detectPerm(base) {
  const real = async (p) => {
    try {
      const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'reject' }) })
      return !(await r.text()).includes('<!doctype html>')
    } catch { return false }
  }
  if (await real('/permission/__d__/reply')) return 'new'
  if (await real('/session/__d__/permissions/__d__')) return 'old'
  return 'new'
}

// 取得（或惰性启动）某项目目录对应的 serve；handlers 在该 serve 的事件循环里用
async function ensureServe(dir, handlers, log = console.log) {
  const key = dir || '__home__'
  const existing = pool.get(key)
  if (existing) {
    let alive = true
    try { await existing.ready } catch { alive = false }                         // 上次启动失败 → 不再复用
    if (alive && existing.proc && existing.proc.exitCode != null) alive = false   // 进程已退出 → 不再复用
    if (alive) return existing
    if (pool.get(key) === existing) pool.delete(key)
    log(`serve for [${dir || '(home)'}] not alive; restarting`)                   // 自愈：下一张卡重启它
  }
  const info = { dir, key, base: null, port: null, proc: null, permStyle: 'new' }
  info.ready = (async () => {
    const port = await freePort(4096)
    info.port = port; info.base = `http://127.0.0.1:${port}`
    log(`starting serve for [${dir || '(home)'}] on :${port}`)
    info.proc = spawnServe(dir, port)
    let exitInfo = null
    info.proc.on('exit', (code, sig) => { if (!exitInfo) exitInfo = { code, sig } })
    info.proc.on('error', (e) => { if (!exitInfo) exitInfo = { error: e.message } })
    await waitHealthy(info.base, () => exitInfo)
    info.permStyle = await detectPerm(info.base)
    log(`serve ready on :${port} (permission endpoint: ${info.permStyle})`)
    runEventLoop(info.base, handlers, log)
  })()
  pool.set(key, info)
  try { await info.ready } catch (e) { if (pool.get(key) === info) pool.delete(key); throw e }  // 失败不污染池
  return info
}

const sidOf = (s) => s?.id ?? s?.data?.id ?? s?.info?.id
async function createSession(info, title) { return sidOf(await api(info.base, 'POST', '/session', { title: title || '对话' })) }

function extractText(msg) {
  const i = msg?.info ?? msg?.data?.info ?? msg
  const parts = msg?.parts ?? msg?.data?.parts ?? i?.parts ?? []
  if (Array.isArray(parts)) return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim()
  return typeof msg === 'string' ? msg : ''
}
async function sendMessage(info, sessionId, text) {
  return extractText(await api(info.base, 'POST', `/session/${sessionId}/message`, { parts: [{ type: 'text', text }] }))
}
async function abort(info, sessionId) { try { await api(info.base, 'POST', `/session/${sessionId}/abort`) } catch {} }

// 重连用：会话是否还在（直接 GET 取不到就扫列表；未知路由会回 SPA HTML→JSON.parse 抛错→走兜底）
async function sessionExists(info, sid) {
  try { const s = await api(info.base, 'GET', `/session/${sid}`); if (sidOf(s) === sid) return true } catch {}
  try { const list = await api(info.base, 'GET', '/session'); const arr = Array.isArray(list) ? list : (list && list.data) || []; return arr.some((s) => sidOf(s) === sid) } catch { return false }
}
// 重连用：取会话历史消息，归一成 [{role,text}]；端点形态不定，逐个尝试，失败返回 []
function normalizeMessages(r) {
  const list = Array.isArray(r) ? r : (Array.isArray(r && r.messages) ? r.messages : (Array.isArray(r && r.data) ? r.data : null))
  if (!list) return null
  const out = []
  for (const m of list) {
    const role = (m && m.info && m.info.role) || (m && m.role) || (m && m.data && m.data.info && m.data.info.role)
    const text = extractText(m)
    if (text && (role === 'user' || role === 'assistant')) out.push({ role, text })
  }
  return out
}
async function getMessages(info, sid) {
  for (const p of [`/session/${sid}/message`, `/session/${sid}/messages`]) {
    try { const arr = normalizeMessages(await api(info.base, 'GET', p)); if (arr) return arr } catch {}
  }
  return []
}
async function replyPermission(info, sessionId, requestId, decision) {
  const p = info.permStyle === 'new' ? `/permission/${requestId}/reply` : `/session/${sessionId}/permissions/${requestId}`
  try { await api(info.base, 'POST', p, { reply: decision }) } catch (e) { console.error('permission reply failed:', e.message) }
}

async function runEventLoop(base, handlers, log) {
  const { onPermission, onText } = handlers || {}
  for (;;) {
    try {
      const res = await fetch(base + '/event')
      if (!res.ok || !res.body) throw new Error('/event ' + res.status)
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
      log('event stream connected (' + base + ')')
      for (;;) {
        const { value, done } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
          if (!data) continue
          let ev; try { ev = JSON.parse(data) } catch { continue }
          if (!sampleLogged && /part|message/.test(ev && ev.type || '')) { sampleLogged = true; log('SAMPLE event: ' + JSON.stringify(ev).slice(0, 700)) }
          if ((ev && ev.type || '').includes('part')) { const pt = ev.properties && ev.properties.part && ev.properties.part.type; if (pt && !seenPartTypes.has(pt)) { seenPartTypes.add(pt); log('part type: ' + pt) } }
          dispatch(ev, onPermission, onText)
        }
      }
    } catch (e) { log('event stream dropped, reconnect 2s: ' + e.message); await sleep(2000) }
  }
}
function dispatch(ev, onPermission, onText) {
  const type = ev?.type ?? ''
  const p = ev.properties ?? ev.data ?? ev
  if (type.includes('permission') && !type.includes('replied') && !type.includes('response')) {
    const sessionId = p.sessionID ?? p.sessionId ?? p.session_id
    const requestId = p.requestID ?? p.id ?? p.permissionID ?? p.permissionId
    // 工具名：bocomcode 放在 permission(字符串)、tool 是对象；公网 opencode 放在 tool(字符串)。两者兼容。
    const tn = (s) => (typeof s === 'string' && s) ? s : null
    const tool = tn(p.permission) || tn(p.tool) || (p.tool && p.tool.name) || tn(p.type) || tn(p.title)
      || (p.permission && p.permission.type) || 'unknown'
    if (requestId && onPermission) onPermission({ sessionId, requestId, tool })
    return
  }
  if (onText && type.includes('part')) {
    const part = p.part ?? p
    const ptype = part && part.type
    if (part && (ptype === 'text' || ptype === 'reasoning' || ptype === 'thinking')) {
      const text = typeof part.text === 'string' ? part.text
        : typeof part.reasoning === 'string' ? part.reasoning
        : typeof part.content === 'string' ? part.content : null
      if (text != null) {
        const sessionId = p.sessionID ?? p.sessionId ?? part.sessionID ?? part.sessionId
        const role = part.role ?? p.role ?? (p.message && p.message.role)
        const partID = part.id ?? part.partID ?? p.partID
        const kind = ptype === 'text' ? 'text' : 'reasoning'
        if (sessionId) onText({ sessionId, text, role, partID, kind })
      }
    }
  }
}

function killAll() { for (const info of pool.values()) { try { info.proc && info.proc.kill() } catch {} } pool.clear() }

module.exports = { ensureServe, createSession, sendMessage, abort, replyPermission, sessionExists, getMessages, killAll, setServeBin, AUTO_ALLOW }
