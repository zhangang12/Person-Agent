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
const baseToEntry = new Map()   // base URL -> info;防止同一 serve 启多个事件流
let sampleLogged = false
const seenPartTypes = new Set()   // 每种 part 类型打印一次（确认 reasoning/text 等）
const partKind = new Map()        // partID -> 'reasoning'|'text'：从 message.part.updated 学到，供 message.part.delta 路由

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
// 扫端口找已经在跑的 serve:用户手动 `bocomcode serve` 起的、或自启没记进 pool 的,都能复用
// 不再无脑 freePort+spawn → 不再有"用户 4096 + 我们 4097 两个 serve 互相打架"
async function findExistingServe(startPort = 4096, endPort = 4110, log = null) {
  // 并发探,谁先回就用谁;失败的都 false 不会 reject
  const candidates = []
  for (let p = startPort; p <= endPort; p++) candidates.push(p)
  const results = await Promise.all(candidates.map((p) => healthAt(`http://127.0.0.1:${p}`).then((ok) => ok ? p : 0)))
  const found = results.filter(Boolean).sort((a, b) => a - b)   // 偏好低端口(用户最可能用 4096)
  if (found.length && log) log('scan: found existing serve on :' + found.join(', :'))
  return found.length ? { port: found[0], base: `http://127.0.0.1:${found[0]}` } : null
}

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
  const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1']
  // 抑制 bocomcode/opencode 自启 TUI:
  //   关键 — 实测 bocomcode.bat 启动脚本,默认会用 wt.exe(Windows Terminal)把 bocomcodex.exe 包一层 → 弹 TUI 窗口。
  //   开关在它自己的 env 变量 BOCOMCODE_TERMINAL=0,设了就走"直接跑 bocomcodex.exe"分支,不再开 wt 窗口。
  //   其它通用 CI/NO_COLOR/TERM=dumb 仅作兜底(若上游升版多加判定);stdio+detached+windowsHide 防控制台继承。
  const env = {
    ...process.env,
    BOCOMCODE_TERMINAL: '0',   // ← 关键:走 bocomcode.bat 里的 "无 wt.exe" 分支
    CI: '1', NONINTERACTIVE: '1', TERM: 'dumb',
    NO_COLOR: '1', FORCE_COLOR: '0',
    BOCOMCODE_NO_TUI: '1', OPENCODE_NO_TUI: '1', BOCOMCODE_HEADLESS: '1', OPENCODE_HEADLESS: '1',
  }
  const opts = {
    cwd: cwd || undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
    // ⚠ Windows: 不要 detached:true!detached 会让 cmd 自己 AllocConsole 一个新窗口,
    //   而 windowsHide 压不住"被 detached 后子进程自建"的那个 console。
    //   配 windowsHide + stdio:pipe + BOCOMCODE_TERMINAL=0 已经足够静默,加 detached 反而炸窗。
  }
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', SERVE_BIN, ...args], opts)
  }
  return spawn(SERVE_BIN, args, opts)
}
async function waitHealthy(base, getExit, log) {
  const MAX = 240   // 120s：内网首次冷启动(二进制加载 + 模型/网络握手)可能很慢，别太早判失败
  for (let i = 0; i < MAX; i++) {
    if (await healthAt(base)) return
    const ex = getExit && getExit()   // 进程真的退出了（多半是找不到二进制）→ 立即失败，不空等
    if (ex) throw new Error('serve 进程提前退出（' + (ex.error || ('code ' + ex.code)) + '）：请确认 ' + SERVE_BIN + ' 已安装并在 PATH 中')
    if (log && i > 0 && i % 20 === 0) log(`serve 仍在启动中… ${i / 2}s`)
    await sleep(500)
  }
  throw new Error('serve 启动超时（120s）：可能模型/网络握手过慢或二进制异常，请看日志里 [serve:] 行')
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

// 取得（或惰性启动）某项目目录对应的 serve；handlers 在该 serve 的事件循环里用。
// tryShare = true(默认):先扫端口找已在跑的 serve(用户手动 `bocomcode serve` 起的、上一轮启的等),
//                       有就复用,proc=null;没有才自起。
// tryShare = false:跨项目隔离场景(如 backendDir)必须自起独立 serve,因为现有 serve 的 cwd 未必匹配。
async function ensureServe(dir, handlers, log = console.log, opts = {}) {
  const { tryShare = true, scanStart = 4096, scanEnd = 4110 } = opts
  const key = dir || '__home__'
  startKeepAlive(log)   // 保活:周期 GET /global/health 只刷本会话在用的 serve(纯保活,不判死不重启)
  const existing = pool.get(key)
  if (existing) {
    let alive = true
    try { await existing.ready } catch { alive = false }
    // 用时探活一次(外部 serve 看 /global/health,自起的看 proc.exitCode)。不再后台周期 ping —— 那对保活无用。
    if (alive) {
      if (existing.proc && existing.proc.exitCode != null) alive = false
      else if (!existing.proc && !(await healthAt(existing.base))) alive = false
    }
    if (alive) return existing
    // 自起的 serve 死了 → 用时按需原地重启,复用同一 info(已绑会话引用自动跟到新 base)
    if (existing.proc && !existing.external) {
      try { await restartServe(existing, handlers, log); return existing }
      catch (e) { log(`serve restart failed: ${e.message}`) }
    }
    existing.dead = true   // 停掉它的事件循环(原由心跳设置,现在用时检测即设)
    if (pool.get(key) === existing) pool.delete(key)
    if (existing.base) baseToEntry.delete(existing.base)
    log(`serve for [${dir || '(home)'}] not alive; will rescan/restart`)
  }

  // 1) 先扫端口找已在跑的(用户手动起 / 自启没注册到 pool)
  if (tryShare) {
    const ext = await findExistingServe(scanStart, scanEnd, log)
    if (ext) {
      // 同 base 已注册 → 多 pool key 共享同一 entry,不再起第二个事件流
      const shared = baseToEntry.get(ext.base)
      if (shared) {
        pool.set(key, shared)
        log(`pool[${dir || '(home)'}] → 共享已注册 serve ${ext.base}`)
        return shared
      }
      // 第一次发现这个 base → 注册 + 启事件流(无 proc,我们不管它生死)
      const info = { dir, key, base: ext.base, port: ext.port, proc: null, permStyle: 'new', external: true }
      info.ready = (async () => {
        info.permStyle = await detectPerm(info.base)
        log(`复用外部 serve :${ext.port} for [${dir || '(home)'}] (permission: ${info.permStyle}) — 用户手动 bocomcode serve 或上轮自启`)
        runEventLoop(info, handlers, log)
        info.healthy = true   // 刚探通,先置健康;之后保活心跳每 2 分钟刷新
      })()
      baseToEntry.set(ext.base, info)
      pool.set(key, info)
      await info.ready
      return info
    }
  }

  // 2) 没找到 → 自起新 serve
  const info = { dir, key, base: null, port: null, proc: null, permStyle: 'new' }
  info.ready = (async () => {
    const port = await freePort(scanStart)
    info.port = port; info.base = `http://127.0.0.1:${port}`
    log(`starting serve for [${dir || '(home)'}] on :${port}`)
    info.proc = spawnServe(dir, port)
    const getExit = wireServeProc(info, log)
    await waitHealthy(info.base, getExit, log)
    info.permStyle = await detectPerm(info.base)
    log(`serve ready on :${port} (permission endpoint: ${info.permStyle})`)
    runEventLoop(info, handlers, log)
    info.healthy = true   // 刚探通,先置健康;之后保活心跳每 2 分钟刷新
  })()
  pool.set(key, info)
  try { await info.ready; baseToEntry.set(info.base, info) }
  catch (e) { killProc(info.proc); if (pool.get(key) === info) pool.delete(key); throw e }
  return info
}

const sidOf = (s) => s?.id ?? s?.data?.id ?? s?.info?.id
// dir:会话工作目录(本版 serve 支持 ?directory=,与 serve 启动 cwd 无关 → 复用同一 serve 也能跑不同项目)
async function createSession(info, title, dir) {
  // serve 的 ?directory= 不认 Windows 反斜杠(会剥掉盘符、删掉 \ 再当相对路径拼到自己 cwd 上 → 落到错的项目)；
  // 统一转正斜杠，serve 才能解析成正确的绝对路径。这是"项目路径生效"的关键。
  const q = dir ? ('?directory=' + encodeURIComponent(String(dir).replace(/\\/g, '/'))) : ''
  return sidOf(await api(info.base, 'POST', '/session' + q, { title: title || '对话' }))
}

function extractText(msg) {
  const i = msg?.info ?? msg?.data?.info ?? msg
  const parts = msg?.parts ?? msg?.data?.parts ?? i?.parts ?? []
  if (Array.isArray(parts)) return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim()
  return typeof msg === 'string' ? msg : ''
}
// 有的 serve（实测内网 bocomcode）POST /session/:id/message 返回 200 但 body 为空——
// 它不把组装好的助手消息塞进 POST 响应，只通过 /event 流发。POST 还可能非阻塞立即返回。
// 这时只靠 POST body 会得到空文本（→"无文本输出"），且 turn() 会过早收尾把流式 delta 丢掉。
// 兜底：POST body 没文本就轮询 GET /message 等最后一条 assistant 真正完成，返回组装文本。
// 一个回合可能被 opencode 拆成【多条 assistant 消息】:先一条只含工具调用(如 task 子agent),
// 完成后再起一条含最终答案的 text 消息。老逻辑"最后一条 assistant 有 completed 标记就返回"会在
// 那条【已完成但无 text 的工具调用消息】上过早返回空串 → 拿不到后面那条答案(表现为卡住/无文本输出)。
// 修:取最后一个 user 之后的所有 assistant 拼接;仅当【最后一条已完成且带文本】才收尾(答案总以 text 收尾)。
// 纯逻辑(可单测):给定 GET /message 的消息数组,取最后一个 user 之后的所有 assistant 消息,
// 拼它们的 text,并判断本回合是否已收尾。laDone/laText 供轮询做"完成但无文本→继续等续写"的兜底。
function pickTurnText(list) {
  let lastUserIdx = -1
  ;(list || []).forEach((m, i) => { const r = m?.info?.role ?? m?.role; if (r === 'user') lastUserIdx = i })
  const asst = (list || []).slice(lastUserIdx + 1).filter((m) => (m?.info?.role ?? m?.role) === 'assistant')
  if (!asst.length) return { done: false, text: '', laDone: false, laText: '' }
  const text = asst.map(extractText).filter(Boolean).join('\n').trim()
  const la = asst[asst.length - 1]
  const laText = extractText(la)
  const laDone = !!(la?.info?.time?.completed || la?.info?.finish)
  return { done: laDone && !!laText, text, laDone, laText }   // 收尾 = 最后一条 assistant 已完成【且带文本】
}
async function waitAssistantText(info, sessionId, maxMs = 600000) {
  const t0 = Date.now()
  let prev = '', stable = 0, doneNoTextTicks = 0
  while (Date.now() - t0 < maxMs) {
    await sleep(700)
    let raw; try { raw = await api(info.base, 'GET', `/session/${sessionId}/message`) } catch { continue }
    const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
    const r = pickTurnText(list)
    if (r.done) return r.text                                              // 最后一条已完成且带文本 → 收
    if (r.text && r.text === prev) { if (++stable >= 3) return r.text } else { stable = 0; prev = r.text }   // 无完成标记的 serve:文本稳定 ~2s
    if (r.laDone && !r.laText) { if (++doneNoTextTicks >= 42) return r.text } else { doneNoTextTicks = 0 }   // 兜底:真以无文本工具收尾(罕见),~30s 无续写才放弃
  }
  return prev
}
async function sendMessage(info, sessionId, text, model, files) {
  const parts = []
  if (text != null && text !== '') parts.push({ type: 'text', text })
  for (const f of (files || [])) {                          // 图片/文档 = file part(mime + data URL,实测格式)
    if (f && f.mime && f.url) parts.push({ type: 'file', mime: f.mime, url: f.url, ...(f.filename ? { filename: f.filename } : {}) })
  }
  if (!parts.length) parts.push({ type: 'text', text: text || '' })
  const body = { parts }
  if (model && model.providerID && model.modelID) {        // 按请求指定模型(各版本字段名兼容,多塞几个,认哪个用哪个)
    body.model = { providerID: model.providerID, modelID: model.modelID }
    body.providerID = model.providerID; body.modelID = model.modelID
  }
  const direct = extractText(await api(info.base, 'POST', `/session/${sessionId}/message`, body))
  return direct || await waitAssistantText(info, sessionId)   // 空 body（流式版 serve）→ 轮询等完成
}
// 列可用模型:GET /config/providers → 拍平成 [{providerID, modelID, name, provider}]
async function listModels(info) {
  try {
    const r = await api(info.base, 'GET', '/config/providers')
    const provs = (r && r.providers) || (r && r.all) || []
    const out = []
    for (const p of provs) {
      const models = (p && p.models) || {}
      for (const mid of Object.keys(models)) {
        const m = models[mid] || {}
        const inp = (m.capabilities || {}).input || {}
        out.push({ providerID: p.id, modelID: mid, name: m.name || mid, provider: p.name || p.id, image: !!inp.image })
      }
    }
    return out
  } catch { return [] }
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

// 事件循环每次重连都读 info.base —— 心跳重启把 serve 换到新端口后,本循环会自动接上新 base,无需重启循环。
// info.dead = true(外部 serve 被清出 pool)时退出。
async function runEventLoop(info, handlers, log) {
  const { onPermission, onText } = handlers || {}
  for (;;) {
    if (info.dead) { log('event loop stopped (' + (info.dir || '(home)') + ')'); return }
    const base = info.base
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
    } catch (e) { if (info.dead) return; log('event stream dropped, reconnect 2s: ' + e.message); await sleep(2000) }
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
    // 要改的文件 / 要跑的命令：从各种可能的字段里尽力提取，给"知情审批"用（不同 serve 字段名不一，逐个兜底）
    const argOf = (o) => {
      if (!o || typeof o !== 'object') return ''
      const inp = o.input || o.args || o.arguments || o.params || o.metadata || o
      return (inp && typeof inp === 'object')
        ? (inp.filePath || inp.path || inp.file || inp.targetFile || inp.command || inp.cmd || inp.pattern || '')
        : ''
    }
    const detail = argOf(p.tool) || argOf(p.permission) || argOf(p.metadata) || argOf(p)
      || (typeof p.title === 'string' && p.title !== tool ? p.title : '') || ''
    if (requestId && onPermission) onPermission({ sessionId, requestId, tool, detail: String(detail).slice(0, 200) })
    return
  }
  // 流式增量（本版 bocomcode 实测主路径）：message.part.delta { partID, field:'text', delta }
  // field 恒为 part 的字段名（'text'），不代表 kind；真正 reasoning/text 看该 partID 在 part.updated 声明的 type。
  // 不认 delta = 思考过程整段丢失（reasoning 只走 delta）、答案也不实时流（只靠 POST 返回兜底）。
  if (onText && type === 'message.part.delta') {
    const delta = typeof p.delta === 'string' ? p.delta : ''
    const partID = p.partID ?? p.id
    const sessionId = p.sessionID ?? p.sessionId
    if (delta && partID && sessionId) {
      const kind = partKind.get(partID) === 'reasoning' ? 'reasoning' : 'text'
      onText({ sessionId, text: delta, role: 'assistant', partID, kind, delta: true })
    }
    return
  }
  if (onText && type.includes('part')) {
    const part = p.part ?? p
    const ptype = part && part.type
    // 记下 partID → kind，供后续 delta 路由（reasoning 的快照 text 常为空，kind 只能从这里学）
    if (part && part.id && (ptype === 'reasoning' || ptype === 'thinking' || ptype === 'text')) {
      if (partKind.size > 2000) partKind.clear()
      partKind.set(part.id, ptype === 'text' ? 'text' : 'reasoning')
    }
    if (part && (ptype === 'text' || ptype === 'reasoning' || ptype === 'thinking')) {
      const text = typeof part.text === 'string' ? part.text
        : typeof part.reasoning === 'string' ? part.reasoning
        : typeof part.content === 'string' ? part.content : null
      if (text) {   // 跳过空快照（announce）——别用空串覆盖已累积的 delta
        const sessionId = p.sessionID ?? p.sessionId ?? part.sessionID ?? part.sessionId
        const role = part.role ?? p.role ?? (p.message && p.message.role)
        const partID = part.id ?? part.partID ?? p.partID
        const kind = ptype === 'text' ? 'text' : 'reasoning'
        if (sessionId) onText({ sessionId, text, role, partID, kind })
      }
    }
    else if (part && ptype === 'tool') {
      // 工具调用:把 名称/入参/结果/标题/错误 全放出来,卡片渲染成可展开的工具日志块(对齐 opencode TUI)。
      // 形状各 serve 略异:opencode 原生放 part.state.{input,output,title,error,status};逐个兜底。
      const st = (part.state && typeof part.state === 'object') ? part.state : {}
      const tnm = (typeof part.tool === 'string' && part.tool) || (typeof st.tool === 'string' && st.tool) || (typeof part.name === 'string' && part.name) || ''
      const sessionId = p.sessionID ?? p.sessionId ?? part.sessionID ?? part.sessionId
      const status = st.status || st.state || part.status || ''
      const cid = String(part.callID || part.id || part.partID || tnm || '')
      const toolInput = st.input ?? part.input ?? part.args ?? part.arguments ?? part.params ?? null
      let toolOutput = null
      for (const c of [st.output, part.output, st.result, part.result, st.metadata && st.metadata.output]) { if (typeof c === 'string' && c) { toolOutput = c; break } }
      const toolTitle = (typeof st.title === 'string' && st.title) || (typeof part.title === 'string' && part.title) || ''
      const toolError = (typeof st.error === 'string' && st.error) || (st.error && typeof st.error.message === 'string' && st.error.message) || ''
      if (sessionId && tnm) onText({ sessionId, text: tnm, role: 'assistant', partID: cid + ':tool', kind: 'tool', status: String(status || ''), toolInput, toolOutput, toolTitle, toolError })
    }
  }
}

// 给自起的 serve 子进程接上 exit/error/日志管道,返回 () => exitInfo 供 waitHealthy 早退判定。
function wireServeProc(info, log) {
  let exitInfo = null
  info.proc.on('exit', (code, sig) => { if (!exitInfo) exitInfo = { code, sig }; log(`serve :${info.port} exited (code ${code}${sig ? ' ' + sig : ''})`) })
  info.proc.on('error', (e) => { if (!exitInfo) exitInfo = { error: e.message } })
  const pipe = (s, tag) => { if (s) s.on('data', (d) => { const t = String(d).trim(); if (t) log(`[serve:${info.port}${tag}] ` + t) }) }
  pipe(info.proc.stdout, ''); pipe(info.proc.stderr, '!')
  return () => exitInfo
}

// 原地重启一个自起的 serve(复用同一 info 对象):换新端口、重新探活、重测权限端点。
// 用时按需触发(ensureServe 检测到自起的 serve 已死时调用),不再后台周期轮询。
// 事件循环一直读 info.base,换 base 后会自动重连,无需重启循环;已绑该 info 的会话引用同一对象也自动指向新 base。
async function restartServe(info, handlers, log) {
  log(`serve: restarting for [${info.dir || '(home)'}] (was :${info.port})`)
  if (info.base) baseToEntry.delete(info.base)
  killProc(info.proc)
  const port = await freePort(info.port || 4096)
  info.port = port; info.base = `http://127.0.0.1:${port}`
  info.proc = spawnServe(info.dir, port)
  const getExit = wireServeProc(info, log)
  await waitHealthy(info.base, getExit, log)
  info.permStyle = await detectPerm(info.base)
  baseToEntry.set(info.base, info)
  info.healthy = true
  log(`serve: back on :${port} (permission: ${info.permStyle})`)
}

// ── 保活心跳 ────────────────────────────────────────────────────────────────
// 周期性 GET /global/health 刷所有 serve 端口(4096-4110),把 idle 计时按住,serve 不空闲自杀。
// 纯保活:只发请求(带超时,不卡循环),返回与否都不管;不判死、不重启、不自启 —— 那些交给 ensureServe 用时处理。
// 保活心跳:POST /heartbeat(无请求体),返回 true 或 {"success":true} 即成功。返回报文细节供日志展示。
function sendHeartbeat(base, ms = 4000) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    let done = false; const fin = (o) => { if (!done) { done = true; resolve(o) } }
    let u; try { u = new URL(base + '/heartbeat') } catch { return fin({ healthy: false, status: 0, body: '(无效地址)', ms: 0 }) }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: ms, headers: { 'content-length': 0 } }, (res) => {
      let txt = ''; res.setEncoding('utf8')
      res.on('data', (c) => { txt += c })
      res.on('end', () => {
        const s = (txt || '').trim()
        let ok = false
        try { const j = JSON.parse(s); ok = j === true || (j && j.success === true) }   // true / {"success":true}
        catch { ok = s === 'true' }
        if (!ok && !s && res.statusCode >= 200 && res.statusCode < 300) ok = true        // 2xx 空 body 兜底算成功
        fin({ healthy: ok, status: res.statusCode || 0, body: s.slice(0, 200), ms: Date.now() - t0 })
      })
    })
    req.on('timeout', () => { try { req.destroy() } catch {} ; fin({ healthy: false, status: 0, body: '(超时 ' + ms + 'ms)', ms: Date.now() - t0 }) })
    req.on('error', (e) => fin({ healthy: false, status: 0, body: '(' + (e.code || e.message) + ')', ms: Date.now() - t0 }))
    req.end()   // POST 无请求体
  })
}
// 单次保活(给"立即保活"按钮用)
async function probeOnce(base) { return sendHeartbeat(base) }
let keepAliveTimer = null, keepAliveListener = null
const KEEPALIVE_MS = 120000        // 2 分钟刷一次(你要的 2-3 分钟区间,取保守的下限更稳)
// 注册保活结果监听:每拍刷完回调一次 results={port:healthy},供 UI 更新各会话窗的探活状态灯
function onKeepAlive(fn) { keepAliveListener = fn }
function startKeepAlive(log = console.log) {
  if (keepAliveTimer) return
  const tick = async () => {
    // 只保活"本会话实际在用的 serve"(baseToEntry 里登记的:自启的 + 复用的外部),不盲刷整段端口
    const infos = [...new Set(baseToEntry.values())]
    if (!infos.length) return
    const results = {}, probes = []
    await Promise.all(infos.map(async (info) => {
      if (!info || !info.base) return
      const r = await sendHeartbeat(info.base)
      info.healthy = r.healthy; info.healthyAt = Date.now()
      results[info.port] = r.healthy
      const entry = { base: info.base, port: info.port, healthy: r.healthy, status: r.status, body: r.body, ms: r.ms, at: info.healthyAt }
      probes.push(entry)
      info.probeLog = info.probeLog || []; info.probeLog.push(entry); if (info.probeLog.length > 50) info.probeLog.shift()
    }))
    if (keepAliveListener) { try { keepAliveListener(results, probes) } catch {} }
  }
  setTimeout(() => tick().catch(() => {}), 2000)   // 2s 后先探一次(等 serve 注册进 baseToEntry,日志立刻有数据)
  keepAliveTimer = setInterval(() => { tick().catch(() => {}) }, KEEPALIVE_MS)
  if (keepAliveTimer.unref) keepAliveTimer.unref()   // 不阻止进程退出
  log(`keepalive: POST /heartbeat 每 ${KEEPALIVE_MS / 1000}s 保活本会话在用的 serve(只刷在用端口)`)
}
function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null } }

// 杀掉一个 serve：Windows 经 cmd.exe 起的是孙进程，必须按进程树杀，否则端口被旧 serve 占住
function killProc(proc) {
  if (!proc || !proc.pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    else proc.kill()
  } catch {}
}
function killAll() {
  stopKeepAlive()
  // 只杀我们自己 spawn 的 serve;复用的外部 serve(proc=null/external:true)留给它的主人
  const killed = new Set()
  for (const info of pool.values()) {
    if (!info.proc || info.external) continue
    if (killed.has(info.base)) continue   // 多 dir 指向同一 entry(共享场景),只杀一次
    killProc(info.proc); killed.add(info.base)
  }
  pool.clear(); baseToEntry.clear()
}

module.exports = { ensureServe, createSession, sendMessage, listModels, abort, replyPermission, sessionExists, getMessages, killAll, setServeBin, onKeepAlive, probeOnce, AUTO_ALLOW,
  __test: { dispatch, waitAssistantText, extractText, pickTurnText } }
