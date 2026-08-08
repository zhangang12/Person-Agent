// opencode serve 连接层 —— 按【项目目录】分池的多 serve。
// 防御口径：不依赖 POST /session 的会话级目录（?directory= 带上但可能被 serve 忽略，
// 各版本行为不一，统一按"会话用 serve 启动目录"设防）。因此：一个项目目录 = 一个独立 serve（各占一端口）。
//   · 同项目多卡 → 复用同一 serve 的多个并发会话（任务隔离）
//   · 不同项目  → 各自 serve（进程级隔离）
// 终端日志一律英文，避免 Windows 控制台乱码。
// 关键容错机制（细节见各函数注释）：
//   · ensureServe inflight 去重：同目录并发调用共享同一 Promise，杜绝"同目录起两个 serve、先起的成孤儿"
//   · 池键目录规范化（path.resolve，win32 小写化）；外部 serve 首个会话探 cwd，不符 → 不共享转自起
//   · POST 在飞断开自愈：先探本次消息是否已落 serve，已落转轮询继续等，未落才上抛
//   · SSE 断线重连补偿：强刷会话树 + 补摘最新 tokens；streamUp/streamAt 供上层三态健康灯
//   · 模型 4xx 黑名单：被 serve 拒过的 (base,modelID) 后续直接改默认模型，省一次必败往返
//   · children/todo 权威数据源(P3.3)：回合收尾 GET 子会话清单/todo 补学习，404 记 Set 熔断（fork 缺端点不每回合白打）
//   · prompt_async 发送通道(P3.4，knob 门控默认关)：POST 立即返回不挂起等回合，在飞断开天然免疫；404 熔断回落原路径
const { spawn } = require('child_process')
const net = require('net')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')

const AUTO_ALLOW = new Set(['read', 'grep', 'glob', 'list', 'ls', 'find', 'tree'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pool = new Map()      // dirKey -> info { dir, base, port, proc, permStyle, ready }
const baseToEntry = new Map()   // base URL -> info;防止同一 serve 启多个事件流
// R2 池键与目录比较一律规范化：path.resolve 消掉 ./ ../ 与尾斜杠差异，win32 再小写化（盘符/路径大小写不敏感）。
// 不规范的话，"D:/proj" 与 "D:/proj/" 会被当成两个项目各起一个 serve。
function normDirKey(dir) {
  if (!dir) return '__home__'
  let k = path.resolve(String(dir))
  if (process.platform === 'win32') k = k.toLowerCase()
  return k
}
function sameDir(a, b) {
  const na = a ? path.resolve(String(a)) : ''
  const nb = b ? path.resolve(String(b)) : ''
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}
// R1 并发去重：同目录（且同共享模式）的并发 ensureServe 共享同一 Promise —— 登记发生在第一个 await 之前（同步），
// 后到者直接 await 同一 Promise；finally 清除。治"同目录起两个 serve、先起的没人登记成永久孤儿"。
const inflight = new Map()   // ikey(共享模式|目录键) -> Promise<info>
let sampleLogged = false
const seenPartTypes = new Set()   // 每种 part 类型打印一次（确认 reasoning/text 等）
const seenEvTypes = new Set()     // 每种事件类型打印一次（诊断子agent映射来源等）
const loggedChildren = new Set()  // 每个子会话映射只打一次日志
// ★模块级日志句柄。本文件里 log 一直是【函数参数】(ensureServe(dir, handlers, log) 那条链才拿得到),
// 于是 createSession / sendMessage 这些没有 log 的地方压根没法留痕 —— 而它们恰恰是排障最需要看的两处。
// 2026-08-08 我在这两处加日志时直接写了 log(...),真机上当场炸成 `log is not defined`,
// plan 决策 110 毫秒就转人工(比它要修的问题更难看)。ensureServe 每次都会被调到,借它把句柄存下来。
let modLog = null
function oclog(msg) { try { if (modLog) modLog(msg) } catch { /* 排障用的东西不许把主流程带崩 */ } }
const partKind = new Map()        // partID -> 'reasoning'|'text'：从 message.part.updated 学到，供 message.part.delta 路由
const childToParent = new Map()   // 子会话ID -> 父会话ID：task 子agent 会创建带 parentID 的子会话,据此把子agent事件路由回父卡片
const childTitle = new Map()      // 子会话ID -> 标题(如 "Explore codebase (@explore subagent)"),给卡片显示子agent名
const sidBase = new Map()         // 子会话ID -> 所属 serve base：refreshSessionTree 差集回收只摘本 base 的,别误伤其它 serve 的映射
// R9 子会话映射统一登记口：三个学习点(session 事件/会话树/task 工具结果)都走这里。
// 容量粗清仿 usageBySession：超上限全清,映射丢了靠 SSE/轮询重新学,代价可接受;清 parent 映射必须连带清标题/base。
// ⚠ 必须连带清 classifiedSessions:懒刷新的触发条件是"!classifiedSessions.has && !childToParent.has",
// 只清映射不清已分类集 = 条件永不成立,在飞子 Agent 路由永断(审查实测)。
function noteChild(id, parent, title, base) {
  if (!id || !parent || id === parent) return
  if (childToParent.size > 500) { childToParent.clear(); childTitle.clear(); sidBase.clear(); classifiedSessions.clear() }
  childToParent.set(id, parent)
  if (typeof title === 'string' && title) childTitle.set(id, title)
  if (base) sidBase.set(id, base)
}
// C7 abort 快收标记：waitAssistantText 因 abort 宽限返回半截文本时登记;consumeAbortFlag 取一次即清(契约①,上层给回合标"已手动停止")
const stoppedSids = new Set()
function markStopped(sid) {
  if (!sid) return
  if (stoppedSids.size > 500) stoppedSids.clear()
  stoppedSids.add(sid)
}
function consumeAbortFlag(sid) { const had = stoppedSids.has(sid); if (had) stoppedSids.delete(sid); return had }
// C5 模型 4xx 黑名单：被 serve zod 拒过的 modelID 按 base 记录,后续发送直接跳过模型指定;notified 控制只告知上层一次
const modelBlacklist = new Map()   // base -> Map<modelID, { at, notified }>
// 静默丢弃盯防的起判时间(见 sendMessage 里 dropWatch 那段的实测依据):
// 90s 压过合法慢首字(实测最慢的正常收官 36.4s),而真故障能持续 25 分钟以上。
// 可调只为【自测】:否则一条断言要真等 90 秒。生产路径没有任何地方改它。
let DROP_WATCH_MS = 90000
function setDropWatchMs(ms) { const n = +ms; if (Number.isFinite(n) && n >= 100) DROP_WATCH_MS = n }
// 盯防的拉取间隔跟着阈值缩放:自测把阈值调到几百毫秒时,5s 一拍会永远等不到第二拍
const dropPollMs = () => Math.max(200, Math.min(5000, Math.round(DROP_WATCH_MS / 6)))
function noteModelBlacklist(base, modelID) {
  if (!base || !modelID) return
  if (modelBlacklist.size > 200) modelBlacklist.clear()
  let m = modelBlacklist.get(base)
  if (!m) { m = new Map(); modelBlacklist.set(base, m) }
  m.set(modelID, { at: Date.now(), notified: false })
}
// ── 真实 token 计量(tokens plumbing)─────────────────────────────────────────
// 卡片"上下文用量 chip / 80% 自动压缩"需要 serve 的真实用量,不是字符估算。
// 数据源(opencode 线格式,两条都接,谁有算谁):
//   ① SSE message.updated 事件:properties.info 是 assistant 消息元数据,带 tokens {input,output,reasoning,cache{read,write}}
//   ② GET /session/:sid/message 消息列表:assistant 条目的 info.tokens 同上(pollTurnParts 每轮都在拉,顺手摘)
// 归一成 { input, output, reasoning, cacheRead, cacheWrite, prompt, total, at }:
//   prompt = input + cacheRead + cacheWrite  ← 最近一次调用实际进上下文的量(水位按它算)
//   total  = prompt + output + reasoning     ← 全量(展示用)
const usageBySession = new Map()   // sid(根会话) -> 归一用量(只留最新一条 assistant 的,它含全量上下文)
// 各 serve 版本字段形状不一(tokens / usage;cache.read / cache_read;prompt_tokens / input_tokens),逐个兜底,全没有返回 null
function normalizeUsage(src) {
  if (!src || typeof src !== 'object') return null
  const t = (src.tokens && typeof src.tokens === 'object') ? src.tokens : (src.usage && typeof src.usage === 'object') ? src.usage : src
  const num = (v) => (+v > 0 ? +v : 0)
  const cache = (t.cache && typeof t.cache === 'object') ? t.cache : {}
  const input = num(t.input ?? t.input_tokens ?? t.prompt_tokens ?? t.prompt)
  const output = num(t.output ?? t.output_tokens ?? t.completion_tokens ?? t.completion)
  const reasoning = num(t.reasoning ?? t.reasoning_tokens)
  const cacheRead = num(cache.read ?? cache.cacheRead ?? t.cache_read ?? t.cacheRead)
  const cacheWrite = num(cache.write ?? cache.cacheWrite ?? t.cache_write ?? t.cacheWrite)
  const prompt = input + cacheRead + cacheWrite
  const total = prompt + output + reasoning
  if (!total) return null
  return { input, output, reasoning, cacheRead, cacheWrite, prompt, total, at: Date.now() }
}
// 记录一条 assistant 消息的用量:按消息自带 sid 登记(卡片只查根会话的;子agent是隔离上下文,不计入它的水位);新值覆盖旧值(用量单调涨,最新=最全)
function noteUsage(sid, msgInfo) {
  if (!sid) return
  const u = normalizeUsage(msgInfo)
  if (!u) return
  if (usageBySession.size > 500) usageBySession.clear()   // 粗粒度防涨:sid 全局唯一,清空只影响极老会话
  usageBySession.set(sid, u)
}
// 卡片读取通道(IPC 由装配层接):取该会话最近一次 assistant 调用的真实用量,没有返回 null(调用方回退字符估算)
function getSessionUsage(info, sid) {
  const hit = sid && usageBySession.get(sid)
  if (hit) return hit
  return null   // SSE 没报过就是真没有;GET 兜底由 pollTurnParts 顺手摘(不另发请求,内网 serve 能少打一次是一次)
}
// 顺着 parentID 链找到根(卡片对应的)会话。子agent可嵌套,最多向上走几层。
function rootSession(sid) {
  let cur = sid, guard = 0
  while (childToParent.has(cur) && guard++ < 8) cur = childToParent.get(cur)
  return cur
}
// 从 task 工具的 state 里刨出子会话ID(session事件缺失时兜底建映射)。opencode 结果开头形如 "task_id: ses_XXX"。
function extractChildSessionId(st) {
  if (!st || typeof st !== 'object') return ''
  for (const c of [st.sessionID, st.sessionId, st.metadata && (st.metadata.sessionID || st.metadata.sessionId)]) {
    if (typeof c === 'string' && c.startsWith('ses_')) return c
  }
  if (typeof st.output === 'string') { const m = st.output.match(/task_id:\s*(ses_[A-Za-z0-9]+)/); if (m) return m[1] }
  return ''
}
// 懒加载会话树:见到没见过的 sessionID 就 GET /session 拉全量,给所有带 parentID 的会话建 子→父 映射。
// 保证子agent路由不依赖 session 事件是否早发(节流 1.5s,只在出现新会话时触发;force=true 绕过节流,断线重连补偿/一次性事件防吞用)。
const classifiedSessions = new Set()   // 已分类(已知是根 or 已建映射)的会话,避免重复刷
let _lastTreeRefresh = 0, _treeRefreshing = false, _treeInflight = null
async function refreshSessionTree(base, force) {
  // force 恰逢上一次刷新在飞:等它落地再返回 —— 一次性事件(permission/question)防吞要求"返回时映射必为最新"才敢 dispatch
  if (_treeRefreshing) { if (force && _treeInflight) { try { await _treeInflight } catch {} } return }
  if (!force && Date.now() - _lastTreeRefresh < 1500) return
  _treeRefreshing = true
  _treeInflight = _refreshSessionTree(base).finally(() => { _treeRefreshing = false; _treeInflight = null })
  return _treeInflight
}
async function _refreshSessionTree(base) {
  try {
    const list = await api(base, 'GET', '/session')
    const arr = Array.isArray(list) ? list : (list && list.data) || []
    if (classifiedSessions.size > 2000) classifiedSessions.clear()   // R9 容量粗清:清了重学,代价一次懒加载
    const seen = new Set()
    for (const s of arr) {
      const info = (s && s.info) ? s.info : s
      if (!info || !info.id) continue
      seen.add(info.id)
      classifiedSessions.add(info.id)
      if (info.parentID && info.id !== info.parentID) noteChild(info.id, info.parentID, info.title, base)
    }
    // R9 差集回收:全量列表里已不存在的会话(被删/过期)从映射里摘掉 —— 只摘属于本 base 的映射,别误伤其它 serve;
    // 空列表不回收(防"200 但形状不认识 → 解析成 []"的瞬时异常把映射全清)。
    if (arr.length) {
      for (const [id, b] of sidBase) { if (b === base && !seen.has(id)) { sidBase.delete(id); childToParent.delete(id); childTitle.delete(id) } }
      for (const id of [...classifiedSessions]) { if (!seen.has(id)) classifiedSessions.delete(id) }
    }
    _lastTreeRefresh = Date.now()
  } catch {}
}

// 用 Node http 而非 fetch：智能体一轮可能跑几分钟，POST /message 在结束前一直挂着，
// 而 fetch(undici) 默认 5 分钟 headersTimeout 会把它判超时抛 "fetch failed"。http 无此超时。
function api(base, method, path, body, timeoutMs) {
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
    req.setTimeout(timeoutMs > 0 ? timeoutMs : 0, () => { req.destroy(new Error(`${method} ${path} -> 超时(${timeoutMs}ms),对端无响应`)) })   // 默认 0=不超时:长任务期间连接保持;探活类调用必须传超时,否则对端挂起=永远傻等
    if (data) req.write(data)
    req.end()
  })
}
// 探活专用 3s 超时:serve 挂起(接受连接但不应答)时快速判负,waitHealthy 才能重试/到时如实报错,而不是无声卡死
async function healthAt(base) { try { await api(base, 'GET', '/global/health', undefined, 3000); return true } catch { return false } }
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

// 找一个空闲端口（绕开被占用的，比如残留的旧 serve）。
// 必须在扫描窗内(默认 ≤4110,与 findExistingServe 的 4096-4110 同窗):爬出窗口 = 保活/扫描都找不到它,
// 且会话注册表按窗内端口管理 —— 爬满即报错,不硬爬(审查实测 restartServe 会一路爬出扫描窗)。
function freePort(start, end = 4110) {
  return new Promise((resolve, reject) => {
    const test = (p) => {
      if (p > end) return reject(new Error(`端口扫描窗 ${start}-${end} 已无空闲端口(被 ${end - start + 1} 个残留进程占满),请先清理旧 serve 再重试`))
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
let spawnServeHook = null   // 仅自测注入(__test.setSpawnHook)：替换真实 spawn,ensureServe/createSession 全流程可离线测
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
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',   // 内网无外网:opencode 内置 LSP server 探测不到会尝试联网安装(必失败),恒关;代码智能走壳层随包注册(lsp-config.js)
  }
  const opts = {
    // 无 projectDir(home 会话)显式落 os.homedir():打包后被快捷方式拉起时继承的 cwd 可能是 System32,
    // serve 起在 System32 = 工作区/快照/git 全错。cwd 目录不存在时 spawn 直接报错(好过起在错目录)。
    cwd: cwd || os.homedir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
    // ⚠ Windows: 不要 detached:true!detached 会让 cmd 自己 AllocConsole 一个新窗口,
    //   而 windowsHide 压不住"被 detached 后子进程自建"的那个 console。
    //   配 windowsHide + stdio:pipe + BOCOMCODE_TERMINAL=0 已经足够静默,加 detached 反而炸窗。
  }
  if (process.platform === 'win32') {
    // serveBin 是自由文本(settings.serveBin),含空格的路径(如 C:\Program Files\...)必须加引号,
    // 否则 cmd /c 按空格拆词找不到命令(非 win32 不走 shell,无此问题)。
    const bin = /\s/.test(SERVE_BIN) && !/^".*"$/.test(SERVE_BIN) ? `"${SERVE_BIN}"` : SERVE_BIN
    return spawn('cmd.exe', ['/d', '/s', '/c', bin, ...args], opts)
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
      const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'reject' }), signal: AbortSignal.timeout(5000) })   // 探针必须带超时:serve 挂起时 5s 判负,别让 ensureServe 无声卡死
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
// R1 并发去重外壳:同目录同共享模式的并发调用共享同一 Promise(同步登记,finally 清除),实际工作在 ensureServeInner。
async function ensureServe(dir, handlers, log = console.log, opts = {}) {
  if (log) modLog = log          // ★借这条必经之路把日志句柄存给 createSession / sendMessage 用(见 modLog 的注释)
  const ikey = ((opts && opts.tryShare === false) ? 'I|' : 'S|') + normDirKey(dir)
  const pending = inflight.get(ikey)
  if (pending) return pending
  const p = ensureServeInner(dir, handlers, log, opts)
  inflight.set(ikey, p)
  try { return await p } finally { if (inflight.get(ikey) === p) inflight.delete(ikey) }
}
async function ensureServeInner(dir, handlers, log = console.log, opts = {}) {
  // requireDirMatch(默认开):serve 的 cwd 必须与请求目录一致才复用 —— 本版 serve 忽略会话级
  // ?directory=,跨目录共享会让"切换项目"的新会话实际仍在旧 cwd 跑(工具/bash 全在错的仓库)。
  const { tryShare = true, requireDirMatch = true, scanStart = 4096, scanEnd = 4110 } = opts
  const key = normDirKey(dir)
  startKeepAlive(log)   // 保活:周期 GET /global/health 只刷本会话在用的 serve(纯保活,不判死不重启)
  let existing = pool.get(key)
  // 清跨目录共享的旧账:pool[key] 可能被早年映射到别的 cwd 的 entry
  if (existing && requireDirMatch && !sameDir(existing.dir, dir) && existing.supportsDirectory !== true) {
    log(`pool[${dir || '(home)'}] 指向 cwd=[${existing.dir || '(home)'}] 的 serve,目录不匹配 → 弃用该映射`)
    pool.delete(key); existing = null
  }
  if (existing) {
    let alive = true
    try { await existing.ready } catch { alive = false }
    // 用时探活一次(外部 serve 看 /global/health,自起的看 proc.exitCode)。不再后台周期 ping —— 那对保活无用。
    if (alive) {
      if (existing.proc && existing.proc.exitCode != null) alive = false
      else if (!existing.proc && !(await healthAt(existing.base))) alive = false
    }
    // 项目目录存亡守卫:目录被搬走/删除后 serve 进程没死、健康端点照样应答会被复用,
    // 但 git 快照/工具全在死 cwd 上持续失败(用户实测 subagent 全灭的病灶)。不在 → 退休重扫,不复用不重启。
    // home 会话(dir 空)无目录可查,跳过。
    const dirGone = !!(existing.dir && !fs.existsSync(existing.dir))
    if (alive && dirGone) { log(`serve dir gone: [${existing.dir}] (health endpoint still answers on dead cwd) — retire, will rescan`); alive = false }
    if (alive) return existing
    // 自起的 serve 死了 → 用时按需原地重启,复用同一 info(已绑会话引用自动跟到新 base);目录已死的不重启(原地重启还是死 cwd)
    if (!dirGone && existing.proc && !existing.external) {
      try { await restartServe(existing, handlers, log); return existing }
      catch (e) { log(`serve restart failed: ${e.message}`) }
    }
    existing.dead = true   // 停掉它的事件循环(原由心跳设置,现在用时检测即设)
    if (dirGone) killProc(existing.proc)   // 死 cwd 的 serve 不留:健康端点还在应答,不杀会被下次扫描又复用
    if (pool.get(key) === existing) pool.delete(key)
    if (existing.base) baseToEntry.delete(existing.base)
    log(`serve for [${dir || '(home)'}] not alive; will rescan/restart`)
  }

  // 1) 先扫端口找已在跑的(用户手动起 / 自启没注册到 pool)
  if (tryShare) {
    const ext = await findExistingServe(scanStart, scanEnd, log)
    if (ext) {
      // 同 base 已注册 → 仅当 cwd 相同(或该 serve 已探明支持会话级目录)才共享;
      // 否则落到下方自起分支 —— cwd 正确性优先于省一个进程
      const shared = baseToEntry.get(ext.base)
      if (shared) {
        if (!requireDirMatch || sameDir(shared.dir, dir) || shared.supportsDirectory === true) {
          pool.set(key, shared)
          log(`pool[${dir || '(home)'}] → 共享已注册 serve ${ext.base}`)
          return shared
        }
        log(`serve ${ext.base} cwd=[${shared.dir || '(home)'}] ≠ [${dir || '(home)'}],不共享 → 自起独立 serve`)
      } else {
        // 第一次发现这个 base → 注册 + 启事件流(无 proc,我们不管它生死)。
        // dir 记为本次请求目录(外部 serve 的真实 cwd 探不到,按"用户在项目目录里手动起 serve"的主场景假设)
        const info = { dir, key, base: ext.base, port: ext.port, proc: null, permStyle: 'new', external: true, handlers, log }
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
  }

  // 2) 没找到 → 自起新 serve
  const info = { dir, key, base: null, port: null, proc: null, permStyle: 'new', handlers, log }
  info.ready = (async () => {
    const port = await freePort(scanStart, scanEnd)   // 爬满扫描窗即报错(与 findExistingServe 同窗),不硬爬出窗口
    info.port = port; info.base = `http://127.0.0.1:${port}`
    log(`starting serve for [${dir || '(home)'}] on :${port}`)
    info.proc = spawnServeHook ? spawnServeHook(dir, port) : spawnServe(dir, port)
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
// dir:会话工作目录(?directory= 带上但【不依赖】—— 不支持的 serve 会忽略它;目录正确性靠"一目录一 serve 分池"
// + requireDirMatch + R3 外部 serve cwd 校验兜底,别把 ?directory= 当生效前提)
async function createSession(info, title, dir, agent) {
  // serve 的 ?directory= 不认 Windows 反斜杠(会剥掉盘符、删掉 \ 再当相对路径拼到自己 cwd 上 → 落到错的项目)；
  // 统一转正斜杠，serve 才能解析成正确的绝对路径。这是"项目路径生效"的关键。
  const q = dir ? ('?directory=' + encodeURIComponent(String(dir).replace(/\\/g, '/'))) : ''
  // agent(可选):会话级 Agent(build/plan/OMO 的 sisyphus 等,POST /session schema 认 agent 字段);
  // 只在显式给出时带 —— 老 serve 不认该字段时少一个被拒的面
  const sessBody = agent ? { title: title || '对话', agent: String(agent) } : { title: title || '对话' }
  // ★排障留痕(2026-08-08):真机上"应用建的会话拿到 flash-free 且挂死、curl 建的拿到 pro 且正常",
  //   而两边的 body 按代码读【应该一样】。读代码读不出差别时,就把真正发出去的东西打出来 ——
  //   这一整天最有效的几步都是这么来的(dumpRaw / session.error payload)。
  oclog('[oc] createSession ' + JSON.stringify(sessBody) + ' q=' + (q || '(无)'))
  const sid = sidOf(await api(info.base, 'POST', '/session' + q, sessBody))
  if (sid) {
    info.sids = info.sids || new Set()   // 活跃会话登记:R5 断线重连后补摘 tokens 用(粗粒度防涨)
    if (info.sids.size > 500) info.sids.clear()
    info.sids.add(sid)
  }
  // R3 外部 serve cwd 校验:注册时探不到它的真实 cwd,首个会话建好后 GET 元数据看 directory/cwd。
  // 有该字段且不匹配 → 这个 serve 不能共享:停事件循环、清映射、转自起分支再建会话(刚建的错 cwd 会话能删则删);
  // 没有该字段(内网 bocomcode 可能不返回) → 保持现状,防御优先。
  if (sid && info.external && !info.cwdChecked) {
    info.cwdChecked = true
    let cwd = ''
    try {
      const meta = await api(info.base, 'GET', `/session/${sid}`)
      const sin = (meta && meta.info) ? meta.info : meta
      cwd = (sin && (sin.directory || sin.cwd || sin.path)) || ''
    } catch {}
    const wantDir = info.dir || dir
    if (cwd && wantDir && !sameDir(cwd, wantDir)) {
      const log = info.log || console.log
      log(`external serve ${info.base} cwd=[${cwd}] != [${wantDir}], unshare -> spawn own`)
      info.dead = true   // 停它的事件循环(runEventLoop 认 info.dead)
      for (const [k, v] of pool) { if (v === info) pool.delete(k) }
      if (info.base) baseToEntry.delete(info.base)
      try { await api(info.base, 'DELETE', `/session/${sid}`) } catch {}
      const own = await ensureServe(wantDir, info.handlers, log, { tryShare: false })
      return createSession(own, title, dir)
    }
  }
  return sid
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
// P3 增量缓存:消息只增、终态(completed/finish)后冻结 → 按 msgID 缓存终态消息的 text 与 part 统计,下拍整条复用;
// 未终态消息每拍重算,但其中【终态工具】的贡献(状态/标题/结果长度)按 callID 缓存,只重算非终态工具。
// 没 msgID 的 serve 退化为全量重算。输出与旧版逐字节相同,只是少做重复功(尤其大 output 的长度统计)。
const turnTextCache = new Map()   // assistant msgID -> { done, text, nParts, rLen, tLen, finals: Map<toolKey, tLen> }
const TOOL_FINAL_RE = /complet|success|done|error|fail|cancel|abort/i
function pickTurnText(list) {
  let lastUserIdx = -1
  ;(list || []).forEach((m, i) => { const r = m?.info?.role ?? m?.role; if (r === 'user') lastUserIdx = i })
  const asst = (list || []).slice(lastUserIdx + 1).filter((m) => (m?.info?.role ?? m?.role) === 'assistant')
  if (!asst.length) return { done: false, text: '', laDone: false, laText: '' }
  if (turnTextCache.size > 1000) turnTextCache.clear()   // 粗粒度防涨:msgID 全局唯一,清空只影响老回合的重算效率
  // sig=活动指纹(助手消息数:总part数:文本长:思考长:工具忙),它变了 = 回合还在推进。思考长度必须计入 ——
  // 长思考期间 text 不动,只看 text 会把"正在想"误判成"答完了"。toolRunning=有工具 part 还没到终态:
  // 这是"文本稳定但没答完"唯一可靠的机器信号(答案截半截的根子就是文本稳定 + 工具在跑的间隙)。
  let nParts = 0, rLen = 0, toolRunning = false, tLen = 0
  const texts = []
  for (const m of asst) {
    const inf = m?.info ?? m?.data?.info ?? m ?? {}
    const mid = inf.id || inf.messageID || ''
    const mDone = !!((inf.time && inf.time.completed) || inf.finish)
    const hit = mid && turnTextCache.get(mid)
    if (hit && hit.done) {   // 整条终态冻结 → 全量复用不重算(尤其 extractText 与大 output)
      texts.push(hit.text); nParts += hit.nParts; rLen += hit.rLen; tLen += hit.tLen
      continue
    }
    const parts = (m?.parts ?? m?.data?.parts ?? m?.info?.parts) || []
    const finals = (hit && hit.finals) || new Map()
    let myR = 0, myT = 0, myRunning = false
    for (const p of parts) {
      if (!p) continue
      if (p.type === 'reasoning' || p.type === 'thinking') { myR += String(p.text || p.reasoning || p.content || '').length; continue }
      if (p.type !== 'tool') continue
      const tkey = String(p.callID || p.id || p.partID || '')
      if (tkey && finals.has(tkey)) { myT += finals.get(tkey); continue }   // 终态工具不重算(output 可能很大)
      const st = String((p.state && p.state.status) || p.status || '')
      // 工具细节也计入指纹:task 子agent 长跑期间父消息的 文本/思考 都不动,唯一会动的是工具 part 的
      // 状态/入参/结果(如子agent进度回写)。不计入的话 fan-out 长波会被空转窗口误判"没进展"提前收走。
      const len = st.length + String((p.state && (p.state.title || '')) || p.title || '').length
        + String((p.state && (p.state.output != null ? p.state.output : '')) || p.output || '').length
      myT += len
      if (st && !TOOL_FINAL_RE.test(st)) myRunning = true
      else if (tkey && st) finals.set(tkey, len)   // 只缓存终态工具的贡献
    }
    if (myRunning) toolRunning = true
    nParts += parts.length || 0
    rLen += myR; tLen += myT
    const text = extractText(m)
    texts.push(text)
    // 终态且无残留"running 工具"才整条冻结(完成消息里挂着永 running 工具的怪胎不缓存,每拍重算,行为同旧版)
    if (mid) turnTextCache.set(mid, { done: mDone && !myRunning, text, nParts: parts.length || 0, rLen: myR, tLen: myT, finals })
  }
  const text = texts.filter(Boolean).join('\n').trim()
  const la = asst[asst.length - 1]
  const laText = extractText(la)
  const laDone = !!(la?.info?.time?.completed || la?.info?.finish)
  // ★回合级错误(网关/供应商拒了这次请求)。原来这里【一个字都不看】——
  //   真机 2026-08-07:DeepSeek 返 402「Insufficient Balance」,serve 把它挂在 assistant 消息的
  //   info.error 上,而本函数只数文本与工具,于是轮询看到的是"没文本",最后返回空串;
  //   空串一路流到编排,被误诊成「nodes 是空数组但 more 不是 no」—— 一句与真相毫无关系的话,
  //   还照着这句去重问模型、烧完两轮转人工。余额不足这种事,本该第一时间原样告诉人。
  const err = errOf(la) || droppedOf(la)
  return { done: laDone && !!laText, text, laDone, laText, toolRunning, err,
    sig: asst.length + ':' + nParts + ':' + text.length + ':' + rLen + ':' + (toolRunning ? 1 : 0) + ':' + tLen }   // 收尾 = 最后一条 assistant 已完成【且带文本】
}

// ★"请求没被处理"的指纹 —— 真机 2026-08-08 实测出来的一种失败,它既不报错也不产出:
//   assistant 消息 parts 为空、没有 error、【tokens.input 与 output 都是 0】、time 里只有 created 没有 completed。
//   0 token 意味着这次请求【压根没被模型处理】(没计费、没输入),而不是"处理了但没话说"。
//   现场:工人卡 4 个回合全是这个形态,壳层按"零产出"重派,新卡又是同一个形态 —— 死循环。
//   ★根因查清了(第一版注释把它归给"模型不行",是错的):这个会话【被 abort 过】。
//   实证:把那条失败消息的原文(98 字)原样发进一个【新会话】,立刻正常返回(in 1437 / out 73 / 有 reasoning 有 text)。
//   同一份内容、同一个模型,换会话就好 —— 所以不是模型、不是长度、不是内容,是会话死了。
//   serve 对中止过的会话一律返回空消息:往里再发一遍永远是同一个结果,必须新开会话。
//   (这一整轮的连锁:挂死计时误杀 → cancelNode 里 abort 了会话 → reason 被闸门结论覆写成
//    artifact-missing → 不属 HARD_FAIL → 补做分支放行 → 把补做指令注进那个已经死掉的会话 → 空 →
//    判零产出 → 重派 → 又注进同一个死会话。前两环已在 1151902 修掉。)
//   判据必须【四条同时】成立才算,否则会把"正在飞的回合"(也没有 completed、也没 parts)误杀。
function droppedOf(m) {
  const inf = m && (m.info || m)
  if (!inf || inf.role !== 'assistant') return ''
  const parts = (m && (m.parts || (m.data && m.data.parts))) || []
  if (parts.length) return ''
  if (inf.error) return ''                                   // 有明确错误的走 errOf,别抢它的
  const t = inf.tokens || {}
  const cache = t.cache || {}
  const zero = Number(t.input || 0) === 0 && Number(t.output || 0) === 0
    && Number(t.reasoning || 0) === 0 && Number(cache.read || 0) === 0 && Number(cache.write || 0) === 0
  if (!zero) return ''
  if (!(inf.time && inf.time.created)) return ''             // 连 created 都没有的不是一条落定的消息
  if (inf.time && inf.time.completed) return ''              // 收官了却空 = 另一回事("跑完没话说"),不归这里
  return '这次请求没有被处理(0 token、无产出、无报错;modelID=' + String(inf.modelID || '?') + ')'
    + ' —— 最常见的原因是【这个会话已经被中止过】:serve 对中止过的会话一律返回空消息。'
    + '往同一个会话里再发一遍不会有不同结果,必须新开会话。'
}

// 从一条 assistant 消息里取出回合级错误,拼成一句人话。取不到就返回 ''。
// 只认【结构化的 error 字段】,不去正文里猜:猜错会把模型自己写的"出错了"当成回合失败。
function errOf(m) {
  const e = m && (m.info && m.info.error || m.error)
  if (!e) return ''
  const d = e.data || {}
  const msg = String(d.message || e.message || '').trim()
  const code = d.statusCode || d.status || ''
  const name = String(e.name || '').trim()
  const bits = [name, code ? ('HTTP ' + code) : '', msg].filter(Boolean)
  return bits.length ? bits.join(' · ') : ''
}
// maxMs=绝对上限(防永久 hang);idleMs=空转上限(sig 一直不动才算空转)。
// 口径(2026-08-04 放宽):maxMs 30min→2h、idleMs 10min→30min、工具在跑的空转放宽 25min→60min ——
// 内网慢端点大上下文 prefill + 长 reasoning 常超 10 分钟无 part 变化,旧口径把"慢"误判成"死"。
// 超时【抛错,不再返回空串】:返回 '' 会让上层无法区分"黑洞会话"和"跑完了没话说" —— 编排层照单全收记成
// status:'ok' 的空产出:不重试、不报错,空白直接流进下游上下文与最终汇总(这正是"任务全绿、成果很薄"的一条根)。
// 已经吐了半截文本的,返回半截(有总比无强);一个字都没有的,抛错让上层重试/报错。
async function waitAssistantText(info, sessionId, maxMs = 7200000, idleMs = 1800000, opts = {}) {
  const onRaw = opts && opts.onRawMessages   // P1(契约③):每拍拿到全量消息回调一次,上层同一份数据喂 pollTurnParts,消灭双轮询
  const t0 = Date.now()
  let prev = '', stable = 0, doneNoTextTicks = 0, sig = '', lastMove = Date.now(), lastErr = null, toolBusy = false, pollTimeouts = 0
  // 工具在跑(如 task 子agent的 fan-out 长波)时空转容忍放宽到 60 分钟:父消息可能整波都不动,30 分钟就收会截走半截;
  // 真黑洞仍有 maxMs 绝对上限兜底。工具不跑时维持原 idleMs。
  while (Date.now() - t0 < maxMs && Date.now() - lastMove < (toolBusy ? Math.max(idleMs, 3600000) : idleMs)) {
    // 自适应轮询:前 6 秒密探(450ms)——简单问题一完成就尽快收,少等半拍;之后疏探(750ms)——
    // 长任务不必频繁打 GET /message。实测这台 serve 首字要 12s(模型 TTFT),客户端能省的就这半秒量级。
    await sleep(Date.now() - t0 < 6000 ? 450 : 750)
    // 本次等待期间会话被 abort(用户点「停止」/看门狗收割)→ 别再傻等 serve 自然收尾(它可能永远不标 completed,
    // 一等就是 idleMs=10 分钟,用户点了停止卡片却一直转圈)。宽限 ~1.5s 让 abort 后的收尾文本落进消息,然后有啥收啥。
    if (abortedSince(sessionId, t0) && Date.now() - abortedSids.get(sessionId) > 1500) { markStopped(sessionId); return prev }   // C7:登记"已手动停止"一次性标记(契约①)
    // 单次 30s 超时:serve 半僵死(监听但不应答)时无超时 = 回合永久卡死、abort 也救不回(审查实测)。
    // 超时按普通错误记 lastErr 后 continue;【连续 3 次】超时 = serve 无响应,上抛走引擎连接中断通道(session.js 人话化认 socket hang up)。
    // abort 后的轮询改用 6s 短超时:停止途中 serve 堵了,别让用户为一次轮询陪等 30s。
    const pollTo = abortedSince(sessionId, t0) ? 6000 : 30000
    let raw; try { raw = await api(info.base, 'GET', `/session/${sessionId}/message`, undefined, pollTo); lastErr = null; pollTimeouts = 0 } catch (e) {
      lastErr = e
      if (/超时/.test(String(e && e.message || '')) && ++pollTimeouts >= 3)
        throw new Error('serve 无响应(GET /message 连续 3 次 30s 无应答,半僵死,按 socket hang up 处理):' + sessionId)
      continue
    }   // 留住最后一个错:serve 挂掉时上层才有的可查(否则=10 分钟静默 + 空结果)
    const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
    if (onRaw) { try { onRaw(list) } catch {} }
    const r = pickTurnText(list)
    prev = r.text || prev
    toolBusy = !!r.toolRunning
    // ★回合在供应商侧失败(402 余额不足 / 401 鉴权 / 4xx 参数…):有半截文本就返半截(有总比无强),
    //   一个字都没有就【抛出来】—— 返回空串会让上层完全无法区分"失败了"和"跑完了没话说",
    //   而这两者的处置完全相反(前者要告诉人并停,后者只是空产出)。
    if (r.err && !prev) throw new Error('回合失败:' + r.err)
    if (r.done) return r.text                                              // 最后一条已完成且带文本 → 收(最快路径)
    // 稳定即收的判据升级:不再按"这台 serve 有没有完成标记"二选一 ——
    //   · 完成标记打得晚的 serve(实测内网:completed 可能等会话级收尾/标题生成才落),死等它 = 简单问题也 70s(用户实测,终端 10 倍速于卡片);
    //   · 但纯文本稳定就收会截半截(文本稳定 + 工具在跑的间隙)。
    // 真正可靠的忙信号是【工具 part 的状态】+【思考还在长】(都进了 sig):
    //   sig 连续 3 拍(~2s)没动 且 没有工具在跑 且 已有正文 → 答完了,收。工具在跑/思考在长 → sig 一直变,永远不会误收。
    if (r.sig !== sig) { sig = r.sig; lastMove = Date.now(); stable = 0 }
    else if (!r.toolRunning && r.text) { if (++stable >= 3) return r.text }
    if (r.laDone && !r.laText) { if (++doneNoTextTicks >= 42) return r.text } else { doneNoTextTicks = 0 }   // 兜底:真以无文本工具收尾(罕见),~30s 无续写才放弃
  }
  if (prev) return prev
  const why = Date.now() - t0 >= maxMs ? '超过绝对上限 ' + Math.round(maxMs / 60000) + ' 分钟' : '连续 ' + Math.round(idleMs / 60000) + ' 分钟无任何进展'
  throw new Error('等待回复超时(' + why + ',serve 未产出任何文本' + (lastErr ? ';最后一次取消息失败:' + (lastErr.message || lastErr) : '') + ')')
}
// opts(可选):{ onRawMessages(list):每拍全量消息回调(契约③,P1); onModelFallback(reason):命中模型黑名单时告知上层一句话(C5);
//   promptAsync:走 prompt_async 发送通道(P3.4,knob 门控默认关) }
// P3.4 prompt_async 通道:POST /session/:id/prompt_async 立即返回(不挂起等回合),回合回收复用下方 waitAssistantText 轮询 ——
// R4 类"POST 在飞断开"问题天然免疫(请求一闪即回,没有长挂起的 POST 可断)。fork 无该端点 → 404 记 Set 熔断,
// 本次与后续都回落原 POST /message 路径(404=请求没到业务层,重发不重复);原路径上的自愈/快收等现有行为一律不动。
const promptAsyncUnsupported = new Set()   // base → prompt_async 404 熔断
async function sendMessage(info, sessionId, text, model, files, onNote, opts = {}) {
  const tSend = Date.now()   // 本次发送起点:降级/快收的"被中止"判断都只认【这之后】的 abort,不吃历史账
  const parts = []
  if (text != null && text !== '') parts.push({ type: 'text', text })
  for (const f of (files || [])) {                          // 图片/文档 = file part(mime + data URL,实测格式)
    if (f && f.mime && f.url) parts.push({ type: 'file', mime: f.mime, url: f.url, ...(f.filename ? { filename: f.filename } : {}) })
  }
  if (!parts.length) parts.push({ type: 'text', text: text || '' })
  const body = { parts }
  // 按消息级 Agent 切换(OMO/自定义 agent 兼容):POST message/prompt_async schema 均认 agent 字段;
  // 只在卡片选定非默认 agent 时带,缺省不带(走 serve 默认 build,老 serve 也少一个被拒的面)
  if (opts && opts.agent) body.agent = String(opts.agent)
  // C5 模型黑名单:这台 serve 曾 4xx 拒过这个 modelID → 本条直接不指定(省一次必败往返);首次命中经 onModelFallback 告知一句话
  const blMap = (model && model.modelID) ? modelBlacklist.get(info.base) : null
  const blEnt = blMap ? blMap.get(model.modelID) : null
  if (blEnt && !blEnt.notified) {
    blEnt.notified = true
    if (opts && opts.onModelFallback) { try { opts.onModelFallback('模型 ' + (model.name || model.modelID) + ' 曾被本机 serve 拒绝(4xx 参数校验),本条起改用默认模型发送') } catch {} }
  }
  const withModel = !!(model && model.providerID && model.modelID) && !blEnt
  oclog('[oc] send sid=' + String(sessionId).slice(0, 18) + ' 指定模型=' + (withModel ? (model.providerID + '/' + model.modelID) : '(不指定,由 serve 挑)')
    + ' agent=' + ((opts && opts.agent) || '(不带)') + ' parts=' + parts.length + ' 首段=' + String((parts[0] && parts[0].text) || '').length + '字')
  if (withModel) {                                          // 按请求指定模型(各版本字段名兼容,多塞几个,认哪个用哪个)
    body.model = { providerID: model.providerID, modelID: model.modelID }
    body.providerID = model.providerID; body.modelID = model.modelID
  }
  try {
    // P3.4 prompt_async 分支(knob 门控,默认关):catch 只包 POST 本身 —— 404 熔断后落原路径;非 404 原样上抛
    // (下方 R4 探针照常自愈)。posted 之后的等待异常不进这个 catch,绝不会因 wait 失败而重发灌双份。
    if (opts && opts.promptAsync && !promptAsyncUnsupported.has(info.base)) {
      let posted = false
      try { await api(info.base, 'POST', `/session/${sessionId}/prompt_async`, body); posted = true }
      catch (e2) {
        if (!is404(e2)) throw e2
        if (promptAsyncUnsupported.size > 100) promptAsyncUnsupported.clear()   // 粗粒度防涨(仿 childToParent)
        promptAsyncUnsupported.add(info.base)
      }
      if (posted) {
        getSessionChildren(info.base, sessionId).catch(() => {})   // P3.3 调用点A:回合收尾补一记子会话权威清单
        return await waitAssistantText(info, sessionId, undefined, undefined, opts)   // 回合回收复用现有轮询(含 C7 abort 快收)
      }
    }
    // 停止慢的根:serve 把 POST 阻塞到生成自然收尾才回,用户点「停止」后 /abort 也喊不醒它 → 卡片"正在停止"干等 90s+(实测)。
    // 解法:POST 与 abort 哨兵赛跑 —— 本卡一旦 abort,~0.4s 内赛跑输给哨兵,转去"宽限 ~3s 收半截"快收,不再陪 POST 傻等。
    let abortIv = null
    const abortWatch = new Promise((res) => {
      abortIv = setInterval(() => { if (abortedSince(sessionId, tSend)) { clearInterval(abortIv); abortIv = null; res('__aborted__') } }, 400)
    })
    // ★★【第三个赛跑者:请求被静默丢弃】(真机 2026-08-08,查实用了一整天)
    // 现场:核实片用的 opencode/mimo-v2.5-free 连 39 条全部"冻住"—— 面板上看是在思考,实则
    // 25 分钟一个字节都没有。隔离实验(并发 1/4/12 × 两个模型)钉死了它:
    //   deepseek/deepseek-v4-flash 并发 12 → 12/12 全在 2~3s 返回;mimo 并发 1 → 17 条一条不成。
    //   不是负载、不是并发、不是提示词 —— 是那个模型的接入侧不出字(额度/凭据,归用户账户侧)。
    // 而 serve 那边【1 秒内】就能看到证据:assistant 消息已建,tokens 全 0、parts 空、error 空、
    // time.completed 永不出现(原始报文实测)。droppedOf() 认得这个指纹 —— 但它只在
    // waitAssistantText 里被调用,而那个函数在【POST 返回之后】才跑。POST 永远不返回,
    // 于是这份 1 秒可见的证据一辈子没人去看:检测代码写对了,却挂在一个够不到的地方。
    // 这就是今天第七次同一个形态,也是最贵的一次(整天)。
    // 【为什么阈值这么大】要压过合法的慢首字:实测同一台 serve 上 ling-3.0-tiny-free 收官 36.4s、
    //   deepseek-v4-pro 5.1s、内网慢端点首字曾要 12s。90s 远在其上,而真故障能持续 25 分钟以上 ——
    //   两边都留足余量。只要出现【任何】part 或【任何】非零 token 就立刻停止盯防,不误伤。
    let dropIv = null
    const dropWatch = new Promise((res) => {
      const t0 = Date.now()
      dropIv = setInterval(async () => {
        if (Date.now() - t0 < DROP_WATCH_MS) return
        try {
          const raw = await api(info.base, 'GET', `/session/${sessionId}/message`, undefined, 8000)
          const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
          const asst = list.filter((m) => ((m && (m.info || m)) || {}).role === 'assistant')
          const why = droppedOf(asst[asst.length - 1])
          if (why) { clearInterval(dropIv); dropIv = null; res({ __dropped__: why }) }
        } catch { /* 拉不到就下一拍再看:盯防本身绝不能把正常回合搞崩 */ }
      }, dropPollMs())
    })
    // race 落定(含抛错)后无条件摘哨兵:POST 先完成时不清 = 每条消息泄一个 400ms 定时器(审查实测泄漏)。
    let direct
    try { direct = await Promise.race([api(info.base, 'POST', `/session/${sessionId}/message`, body), abortWatch, dropWatch]) }
    finally {
      if (abortIv) { clearInterval(abortIv); abortIv = null }
      if (dropIv) { clearInterval(dropIv); dropIv = null }
    }
    if (direct && direct.__dropped__) {
      // ★不许在原会话重发 —— serve 对中止过的会话一律返回空消息,重发永远是空(今天早上踩过,
      //   那次连锁是:误杀 → abort → 补做注进死会话 → 空 → 判零产出 → 重派 → 又注进同一个死会话)。
      //   这里只做三件事:掐掉那个永不返回的回合、把模型记进账、把真因原样抛上去,
      //   让既有的重派机制去开一张【新卡新会话】。
      try { await abort(info, sessionId) } catch { /* 已经没了就算了 */ }
      if (withModel) {
        noteModelBlacklist(info.base, model.modelID)   // 同一本账(4xx 那条也记这里):后续发送直接跳过这个模型指定
        if (onNote) { try { onNote('模型 ' + (model.name || model.modelID) + ' 收下请求后不出字(' + Math.round(DROP_WATCH_MS / 1000) + 's 内 0 token、无产出、无报错)—— 多半是这个模型的额度或凭据问题,不是网络。后续发送已改用默认模型') } catch {} }
      }
      throw new Error('回合失败:' + direct.__dropped__)
    }
    if (direct === '__aborted__') {
      markStopped(sessionId)   // 一次性"已手动停止"标记(契约①,上层给回合标)
      // 宽限自适应(停止慢的两大根:原固定 sleep(2800) + 无超时 GET):每 ~600ms 拉一次,文本连稳两拍/两拍皆空 →
      // 提前收;单次 GET 6s 超时(serve 一堵不再陪等);总预算 ~2.4s+一次 GET。既留住收尾文本,又把"点停止干等"压到秒级。
      let last = ''
      for (let i = 0; i < 4; i++) {
        await sleep(i ? 600 : 500)
        try {
          const raw = await api(info.base, 'GET', `/session/${sessionId}/message`, undefined, 6000)
          const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
          const t = pickTurnText(list).text || ''
          if (t && t === last) return t            // 连稳两拍 → 收尾文本已落定
          if (!t && !last && i >= 1) return ''     // 两拍皆空 → 没什么可收的
          last = t
        } catch { if (i >= 1 || last) return last }   // serve 堵/挂 → 有啥收啥
      }
      return last
    }
    const out = extractText(direct) || await waitAssistantText(info, sessionId, undefined, undefined, opts)   // 空 body（流式版 serve）→ 轮询等完成
    getSessionChildren(info.base, sessionId).catch(() => {})   // P3.3 调用点A:回合成功收尾补一记子会话权威清单(子 Agent 路由不依赖 SSE 早发;fire-and-forget)
    return out
  } catch (e) {
    // serve 的 zod 校验不认我们的模型字段形状(4xx)→ 去掉模型重发一次并让用户看见,
    // 而不是整条消息发不出去;其它错误原样上抛
    // "已中止不重发"只认【本次发送之后】的 abort:以前用 has(sid) 判,而 sid 从不按会话删 ——
    // 用户点过一次停止,该会话此后【永久】失去 4xx 降级重发,下一条消息直接把裸 4xx 甩给渲染端。
    if (withModel && /->\s*4\d\d/.test(String(e && e.message || '')) && !abortedSince(sessionId, tSend)) {
      if (onNote) { try { onNote('serve 拒绝了模型指定(' + (model.name || model.modelID) + '),本条已用默认模型发送') } catch {} }
      const d2 = extractText(await api(info.base, 'POST', `/session/${sessionId}/message`, { parts: body.parts }))
      noteModelBlacklist(info.base, model.modelID)   // 降级重发成功 → 记入黑名单,后续发送直接跳过模型指定
      return d2 || await waitAssistantText(info, sessionId, undefined, undefined, opts)
    }
    // R4 POST 在飞断开(连接被掐/进程重启等):请求可能已到 serve 只是响应没回来 —— 先探最后一条 user 是否就是本次内容,
    // 已落 → 转轮询继续等(无缝恢复,不重复发);未落 → 才上抛让上层重试。
    try {
      if (await lastUserMatches(info, sessionId, text, tSend)) {
        const out = await waitAssistantText(info, sessionId, undefined, undefined, opts)
        getSessionChildren(info.base, sessionId).catch(() => {})   // P3.3:断线自愈收尾同样补一记(fire-and-forget,async 调用本身不会同步抛)
        return out
      }
    } catch {}
    throw e
  }
}
// R4 探针:POST 抛错后确认"本次内容到底落没落 serve" —— 最后一条 user 消息文本与本次一致即已落;
// 纯附件消息(无文本)按创建时间认(±10s 宽容);探针本身失败 → 视为未落,原错上抛。
async function lastUserMatches(info, sessionId, text, tSend) {
  const raw = await api(info.base, 'GET', `/session/${sessionId}/message`)
  const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if ((m?.info?.role ?? m?.role) !== 'user') continue
    const want = String(text == null ? '' : text).trim()
    if (want) return extractText(m).trim() === want
    const created = +((m?.info?.time?.created) ?? (m?.time?.created) ?? 0)
    return created > 0 ? created >= tSend - 10000 : true   // 没创建时间可比对 → 宽松认(宁可多等一回合,不重发灌双份)
  }
  return false
}
// 列可用模型:GET /config/providers → 拍平成 [{providerID, modelID, name, provider}]
// 模型清单一台 serve 很少变 → 按 base 缓存 5 分钟;opts.force 绕过缓存(契约⑤,设置页"刷新"用)。拉取失败/空清单不缓存。
const modelListCache = new Map()   // base -> { at, list }
const MODEL_CACHE_MS = 300000
async function listModels(info, opts = {}) {
  const base = info && info.base
  const hit = base && modelListCache.get(base)
  if (!(opts && opts.force) && hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.list
  try {
    const r = await api(info.base, 'GET', '/config/providers')
    const provs = (r && r.providers) || (r && r.all) || []
    const out = []
    for (const p of provs) {
      const models = (p && p.models) || {}
      for (const mid of Object.keys(models)) {
        const m = models[mid] || {}
        const inp = (m.capabilities || {}).input || {}
        // ctx=模型上下文上限(tokens,来自 serve 的模型元数据 limit.context) —— 上下文用量指示按真实值算,serve 没报才由 UI 回退默认
        const lim = m.limit || m.limits || {}
        out.push({ providerID: p.id, modelID: mid, name: m.name || mid, provider: p.name || p.id, image: !!inp.image, ctx: +lim.context > 0 ? +lim.context : null })
      }
    }
    if (base && out.length) modelListCache.set(base, { at: Date.now(), list: out })
    return out
  } catch { return [] }
}
// ── Agent 清单(OMO/自定义 agent 兼容):GET /agent → [{name, description, mode, hidden, native}] ──
// mode=primary 的才可当会话主 Agent(build/plan/OMO 的 sisyphus 等),subagent(task 扇出用)不列给切换。
// 一台 serve 的 agent 清单很少变 → 按 base 缓存 5 分钟;端点不存在(老 serve)→ 熔断返回 null,调用方隐藏切换入口。
const unsupportedAgents = new Set()   // base → /agent 404 熔断
const agentListCache = new Map()      // base -> { at, list }
async function listAgents(info, opts = {}) {
  const base = info && info.base
  if (!base || unsupportedAgents.has(base)) return null
  if (!(opts && opts.force)) { const hit = agentListCache.get(base); if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.list }
  try {
    const r = await api(base, 'GET', '/agent')
    const arr = Array.isArray(r) ? r : (r && r.data)
    if (!Array.isArray(arr)) { unsupportedAgents.add(base); return null }
    const list = arr.filter((a) => a && a.name)
      .map((a) => ({ name: String(a.name), description: String(a.description || ''), mode: String(a.mode || 'primary'), hidden: !!a.hidden, native: !!a.native }))
    agentListCache.set(base, { at: Date.now(), list })
    if (agentListCache.size > 50) agentListCache.clear()
    return list
  } catch (e) { if (is404(e)) { if (unsupportedAgents.size > 50) unsupportedAgents.clear(); unsupportedAgents.add(base) } return null }
}
// 问 serve【实际加载】的配置里有没有我们的 MCP 注册 —— 配置文件写了不等于 serve 带上了(外部 serve 早于注册启动=静默没工具)。
// GET /config 是 serve 启动时装载的快照,正是我们要的"它到底认不认"。端点不存在/形状不认识 → known:false(别误报)。
async function checkMcp(info) {
  try {
    const cfg = await api(info.base, 'GET', '/config')
    const mcp = (cfg && cfg.mcp) || (cfg && cfg.config && cfg.config.mcp)
    if (!mcp || typeof mcp !== 'object') return { known: false }
    return { known: true, registered: !!(mcp['BocomHermes-browser'] || mcp['BocomHermes-mail']) }
  } catch { return { known: false } }
}

// 已中止会话登记:sendMessage 的"4xx 去模型重发"降级分支绝不能对刚被 abort 的会话重发
// (abort 会让在飞 POST 以 4xx 收尾 → 降级分支把全量 prompt 灌回死会话 = 无人收割的二次僵尸)。
const abortedSids = new Map()   // sid → 最近一次 abort 的时间戳。Map 而非 Set:判断要带时间(见 sendMessage 降级 / waitAssistantText 快收)
async function abort(info, sessionId) {
  abortedSids.set(sessionId, Date.now())
  if (abortedSids.size > 500) abortedSids.clear()   // 粗粒度防涨:sid 全局唯一,清空只影响极老会话的降级判断
  try { await api(info.base, 'POST', `/session/${sessionId}/abort`) } catch {}
}
// 「这次等待期间被 abort 了吗」:时间戳必须晚于本次等待的起点 —— 只看 has() 会把"上一轮点过停止"的会话
// 永久判成已中止(sid 从不按会话删),那正是"点过一次停止,该会话此后永久失去 4xx 降级重发"的根。
const abortedSince = (sessionId, t0) => { const at = abortedSids.get(sessionId); return at != null && at >= t0 }

// 删会话（编排决策器用）：一次编排要做几十次一次性决策，不删的话 serve 上会堆出几十段死会话。
// 删不掉不影响正确性（会话只是留着占位），所以吞错只记不抛 —— 老 serve 没有这个路由是正常的。
async function deleteSession(info, sessionId) {
  if (!info || !sessionId) return false
  try { await api(info.base, 'DELETE', `/session/${sessionId}`); return true } catch { return false }
}
// 重连用：会话是否还在（直接 GET 取不到就扫列表；未知路由会回 SPA HTML→JSON.parse 抛错→走兜底）
async function sessionExists(info, sid) {
  try { const s = await api(info.base, 'GET', `/session/${sid}`); if (sidOf(s) === sid) return true } catch {}
  try { const list = await api(info.base, 'GET', '/session'); const arr = Array.isArray(list) ? list : (list && list.data) || []; return arr.some((s) => sidOf(s) === sid) } catch { return false }
}
// 会话清单(看门狗/诊断用,原始形态:id/parentID/title/time.updated 都在)
async function listSessions(info, timeoutMs) {
  try { const list = await api(info.base, 'GET', '/session', undefined, (+timeoutMs > 0) ? +timeoutMs : undefined); return Array.isArray(list) ? list : (list && list.data) || [] } catch { return [] }
}
// 原始消息(看门狗判据要 tool 状态/time;getMessages 是归一化的,只剩 role/text)
// opts.limit(可选):拼 ?limit= 只拉最近 N 条 —— 看门狗降载只判最新一条,没它每 90s 全量拉一遍(第三参曾被静默丢弃)。
async function getRawMessages(info, sid, opts = {}) {
  const lim = (opts && +opts.limit > 0) ? '?limit=' + Math.floor(+opts.limit) : ''
  const to = (opts && +opts.timeoutMs > 0) ? +opts.timeoutMs : undefined
  try { const r = await api(info.base, 'GET', `/session/${sid}/message${lim}`, undefined, to); return Array.isArray(r) ? r : (r && r.data) || [] } catch { return [] }
}
// ── P3.3 children/todo 权威数据源(带 404 熔断回落)──────────────────────────────
// SDK 有而内网 fork 可能没有的两个端点。404 一次记 Set 熔断:之后该 base 直接返回 [] 不再发请求
// (fork 缺端点时每回合打一次是纯浪费);其它异常同样吞掉返回 [](权威源只是加分项,绝不能拖垮回合)。
const unsupportedChildren = new Set()   // base → /session/:id/children 404 熔断
const unsupportedTodo = new Set()       // base → /session/:id/todo 404 熔断
const is404 = (e) => /->\s*404\b/.test(String(e && e.message || ''))   // api 错误形如 "GET /session/x -> 404: ..."
// 待答提问兜底清单:这台 serve 的 /event 可能不推 question.asked(与流式静默同源,实测 question 工具干等 93s 无选项挂死)——
// 回合期间轮询 GET /question 待答清单就是发现通道;404 记 Set 熔断(fork 缺端点不每回合白打)。第一参容忍传 info 对象或 base 串。
const unsupportedQuestionList = new Set()   // base → GET /question 404 熔断
// 待答清单。★GET /question 是【整台 serve】的清单(端点自述 across all sessions,条目 schema 带 sessionID),
// 而同目录多张卡共用一台池化 serve 是常态 —— 不过滤就是"谁先轮到谁冒领":
// 先轮到的若是分片隐藏卡,onQuestion 走无人值守分支【当场自动拒答】,该弹提问卡的那张卡什么也不弹,
// 用户只看见回合莫名其妙地继续了。所以第二参传本卡 sessionId 时按归属过滤。
// 子会话(task 子 Agent)的提问经 rootSession 归到父卡,与 SSE dispatch 的路由同构。
// 老 fork 的条目可能不带 sessionID:这种"证不了归属"的不丢也不冒领,打 _unowned 标交给上层决定
// (可见卡放行,无人值守卡拦住 —— 别一刀切 filter,那会让兜底轮询在老 fork 上整体失效,退回 question 工具干等的老病灶)。
async function listPendingQuestions(base, sessionId) {
  base = (base && base.base) || base
  if (!base || unsupportedQuestionList.has(base)) return null
  try {
    const r = await api(base, 'GET', '/question')
    const arr = Array.isArray(r) ? r : (r && (Array.isArray(r.data) ? r.data : (Array.isArray(r.questions) ? r.questions : null)))
    if (!Array.isArray(arr) || !sessionId) return arr
    const mine = rootSession(String(sessionId))
    const out = []
    for (const q of arr) {
      const owner = q && (q.sessionID || q.sessionId)
      if (!owner) { out.push(Object.assign({ _unowned: true }, q)); continue }
      if (rootSession(String(owner)) === mine) out.push(q)
    }
    return out
  } catch (e) {
    if (is404(e)) { if (unsupportedQuestionList.size > 100) unsupportedQuestionList.clear(); unsupportedQuestionList.add(base) }
    return null
  }
}
// 子会话权威清单:成功且有数组(兼容 {data} 包装)→ 对每个带 id 的子会话 noteChild 登记
// (子 Agent 路由不再依赖 SSE 事件是否早发);返回数组。第一参容忍传 info 对象(session.js 惯例)或 base 串。
async function getSessionChildren(base, sid) {
  base = (base && base.base) || base
  if (!base || !sid || unsupportedChildren.has(base)) return []
  try {
    const r = await api(base, 'GET', `/session/${sid}/children`)
    const arr = Array.isArray(r) ? r : (r && r.data)
    if (!Array.isArray(arr)) return []
    for (const c of arr) { if (c && c.id) noteChild(c.id, sid, c.title || (c.info && c.info.title), base) }
    return arr
  } catch (e) {
    if (is404(e)) { if (unsupportedChildren.size > 100) unsupportedChildren.clear(); unsupportedChildren.add(base) }   // 粗粒度防涨(仿 childToParent)
    return []
  }
}
// serve 权威 todo:返回数组(兼容 {data}/{todos} 包装)或 [];空数组不丢人 —— 调用方据此决定动不动注册表(空/异常一律不动)。
async function getSessionTodo(base, sid) {
  base = (base && base.base) || base
  if (!base || !sid || unsupportedTodo.has(base)) return []
  try {
    const r = await api(base, 'GET', `/session/${sid}/todo`)
    const arr = Array.isArray(r) ? r : (Array.isArray(r && r.data) ? r.data : (r && r.todos))
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    if (is404(e)) { if (unsupportedTodo.size > 100) unsupportedTodo.clear(); unsupportedTodo.add(base) }
    return []
  }
}
// 「生成挂死」判据(卡死子 Agent 看门狗,判死不判慢):最后一条 assistant 未收尾(time.completed 空)
// 且没有任何在跑工具 = 模型写答案的调用挂起。实测病灶:子 Agent 探查全做完、写结论的 LLM 调用无声挂死
// (文本空、消息不收尾、serve 无请求级超时),父卡 task 永 running 拖住整波。有工具在跑一律放过 —— 慢≠死。
function generationStalled(msgs) {
  const list = Array.isArray(msgs) ? msgs : []
  let lastA = null
  for (let i = list.length - 1; i >= 0; i--) { const m = list[i]; const role = (m && m.info && m.info.role) || (m && m.role); if (role === 'assistant') { lastA = m; break } }
  if (!lastA) return false
  const inf = lastA.info || lastA
  if (inf.time && inf.time.completed) return false
  const parts = lastA.parts || (lastA.data && lastA.data.parts) || []
  return !parts.some((p) => p && p.type === 'tool' && !/complet|success|done|error|fail|cancel|abort/i.test(String((p.state && p.state.status) || p.status || '')))
}
// 重连用：取会话历史消息，归一成 [{role,text}]；端点形态不定，逐个尝试，失败返回 []
// 注入前缀剥离(仅展示层):首条用户消息在发送时被静默拼上 <个人记忆>/<项目背景>/<作答技能> 背景块,
// serve 的历史里存的是全文 —— 续接回放时不剥掉,这坨提示词会原样出现在用户自己的气泡里。只影响显示,不碰 serve 数据。
function stripInjected(t) {
  return String(t == null ? '' : t)
    .replace(/<个人记忆>[\s\S]*?<\/个人记忆>\s*/g, '')
    .replace(/<项目背景>[\s\S]*?<\/项目背景>\s*/g, '')
    .replace(/<项目知识\([^)\n]{0,80}\)>[\s\S]*?<\/项目知识>\s*/g, '')     // 首条消息懒构建注入的知识块
    .replace(/<作答技能:[^>\n]{0,120}>[\s\S]*?<\/作答技能>\s*/g, '')
    .replace(/<上轮对话接力摘要>[\s\S]*?<\/上轮对话接力摘要>\s*/g, '')   // 压缩续聊注入的摘要,同样不进用户气泡
    .replace(/<动态工作流规程>[\s\S]*?<\/动态工作流规程>\s*/g, '')          // 动态工作流(Claude Code 式)注入的主 Agent 规程
    .replace(/<多层派发主控规程>[\s\S]*?<\/多层派发主控规程>\s*/g, '')        // 多层派发注入的主控规程(续接回放同样不露)
    .replace(/<任务编排执行规程>[\s\S]*?<\/任务编排执行规程>\s*/g, '')      // 任务编排注入的单 Agent 规程
    .replace(/<任务编排·严格模式>[\s\S]*?<\/任务编排·严格模式>\s*/g, '')   // 严格模式逐步下发的包装(步骤正文保留)
    .replace(/<主控进度>[\s\S]*?<\/主控进度>\s*/g, '')                     // 分片收官注入主控的 N/M 进度消息
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, '')        // OMO/oh-my-opencode 系插件注入的提醒块(CC 同款格式,内网实测一长串)
    .replace(/<ultrawork-mode>[\s\S]*?<\/ultrawork-mode>\s*/gi, '')          // OMO keyword-detector 注入(ulw/ultrawork)
    .replace(/<[a-z0-9-]*reminder[\s\S]{0,4000}?<\/[a-z0-9-]*reminder>\s*/gi, '')   // 兜底:其它 *reminder 命名块的同族(限长防误吞整篇)
    .replace(/\s*\(系统提醒:[\s\S]*?\)\s*$/g, '')                          // 系统提醒尾巴(todoNudge 附在用户消息尾/看门狗与字节计量整条的)
    .trim()
}
// 从正文里拆 <think> 段(这个网关的模型思考常以 <think> 混在 text 里,不走标准 reasoning part):
// think=思考全文(容忍未闭合——流式中途/被截断),rest=去掉思考后的正文
function splitThink(s) {
  let t = String(s == null ? '' : s), think = []
  t = t.replace(/<think>([\s\S]*?)<\/think>/gi, (_, c) => { if (c.trim()) think.push(c.trim()); return '' })
  const open = t.search(/<think>/i)
  if (open >= 0) { const c = t.slice(open).replace(/^<think>/i, '').trim(); if (c) think.push(c); t = t.slice(0, open) }
  return { think: think.join('\n'), rest: t.replace(/<\/?think>/gi, '').trim() }
}
// 附件占位名(契约④):历史回放只给名字不给内容。mime 判 图片/音频/视频/附件,名字取 filename(url 尾段兜底,data URL 无名)。
function userFileNames(m) {
  const parts = m?.parts ?? m?.data?.parts ?? m?.info?.parts ?? []
  const out = []
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || (p.type !== 'file' && p.type !== 'image')) continue
    let name = (typeof p.filename === 'string' && p.filename) || ''
    if (!name && typeof p.url === 'string' && !p.url.startsWith('data:')) {
      try { name = decodeURIComponent(p.url.split('/').pop().split('?')[0] || '').slice(0, 80) } catch { name = '' }
    }
    const mime = String(p.mime || p.mimeType || '')
    const kind = (p.type === 'image' || mime.startsWith('image/')) ? '图片'
      : mime.startsWith('audio/') ? '音频' : mime.startsWith('video/') ? '视频' : '附件'
    out.push(kind + ' ' + (name || '未命名'))
  }
  return out
}
// 历史工具行(契约④):与 dispatch 的 tool 分支同源抽 名称/状态/标题/结果,output 截 500 字 —— 卡片续接回放工具调用历史用。
function assistantTools(parts) {
  const out = []
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || p.type !== 'tool') continue
    const st = (p.state && typeof p.state === 'object') ? p.state : {}
    const name = (typeof p.tool === 'string' && p.tool) || (typeof st.tool === 'string' && st.tool) || (typeof p.name === 'string' && p.name) || 'tool'
    let output = ''
    for (const c of [st.output, p.output, st.result, p.result, st.metadata && st.metadata.output]) { if (typeof c === 'string' && c) { output = c; break } }
    out.push({
      name,
      status: String(st.status || st.state || p.status || ''),
      title: String((typeof st.title === 'string' && st.title) || (typeof p.title === 'string' && p.title) || ''),
      output: output.slice(0, 500),
    })
  }
  return out
}
function normalizeMessages(r) {
  const list = Array.isArray(r) ? r : (Array.isArray(r && r.messages) ? r.messages : (Array.isArray(r && r.data) ? r.data : null))
  if (!list) return null
  const out = []
  for (const m of list) {
    const role = (m && m.info && m.info.role) || (m && m.role) || (m && m.data && m.data.info && m.data.info.role)
    if (role !== 'user' && role !== 'assistant') continue
    if (role === 'user') {
      const text = stripInjected(extractText(m))
      const files = userFileNames(m)   // 契约④:user 必带 files(无附件为 []);纯附件消息也要留下来供回放
      if (text || files.length) out.push({ role, text, files })
      continue
    }
    // 助手消息:思考链一并带回(历史每条的思考要能回看,不是只有最后一轮)。
    // 两个来源:①标准 reasoning/thinking part ②text 里内联的 <think>;拆出后正文只留答案
    const parts = m?.parts ?? m?.data?.parts ?? m?.info?.parts ?? []
    const rparts = Array.isArray(parts) ? parts.filter((p) => p && (p.type === 'reasoning' || p.type === 'thinking'))
      .map((p) => (typeof p.text === 'string' && p.text) || (typeof p.reasoning === 'string' && p.reasoning) || (typeof p.content === 'string' && p.content) || '')
      .filter(Boolean).join('\n') : ''
    const st = splitThink(extractText(m))
    const reasoning = [rparts, st.think].filter(Boolean).join('\n')
    const tools = assistantTools(parts)   // 契约④:assistant 必带 tools(无工具为 []);纯工具消息(无文本)也要留下来供回放
    if (st.rest || reasoning || tools.length) out.push({ role, text: st.rest, reasoning, tools })
  }
  return out
}
async function getMessages(info, sid) {
  for (const p of [`/session/${sid}/message`, `/session/${sid}/messages`]) {
    try { const arr = normalizeMessages(await api(info.base, 'GET', p)); if (arr) return arr } catch {}
  }
  return []
}
// 轮询补渲染:这台 serve 的 /event 常不推流式事件(工具/子Agent/思考全静默),卡片只能等 POST 返回一次性贴。
// 拉当前回合(最后一个 user 之后的所有 assistant)的【原始 parts】,映射成 onText 能吃的形状 → 卡片按 partID 幂等渲染。
// text/reasoning/thinking → 文本流;tool(含 task 子Agent)→ 工具块。返回 null=取消息失败,调用方跳过本次。
async function pollTurnParts(info, sid, opts = {}) {
  let raw
  try { raw = await api(info.base, 'GET', `/session/${sid}/message`, undefined, (opts && +opts.timeoutMs > 0) ? +opts.timeoutMs : undefined) } catch { return null }
  const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
  let lastUserIdx = -1
  list.forEach((m, i) => { const r = m?.info?.role ?? m?.role; if (r === 'user') lastUserIdx = i })
  const out = []
  for (const m of list.slice(lastUserIdx + 1)) {
    const role = m?.info?.role ?? m?.role
    if (role !== 'assistant') continue
    noteUsage(sid, m?.info ?? m)   // 顺手摘真实 token 用量(assistant info.tokens),卡片上下文水位用;没有该字段时自动跳过
    const parts = m?.parts ?? m?.data?.parts ?? m?.info?.parts ?? []
    for (const p of Array.isArray(parts) ? parts : []) {
      if (!p || !p.id) continue
      if (p.type === 'text' || p.type === 'reasoning' || p.type === 'thinking') {
        const text = (typeof p.text === 'string' && p.text) || (typeof p.reasoning === 'string' && p.reasoning) || (typeof p.content === 'string' && p.content) || ''
        if (text) out.push({ partID: p.id, kind: p.type === 'text' ? 'text' : 'reasoning', text })
      } else if (p.type === 'tool') {
        const st = p.state || {}
        // partID 必须与 SSE 路径(message.part.updated 处)同构:(callID || id) + ':tool' ——
        // 否则同一个工具调用会被渲染成两行(SSE 一行、轮询兜底又一行),卡片按 partID 幂等去重就失效了。
        const cid = String(p.callID || p.id || p.partID || p.tool || '')
        // taskChild 与 SSE 路径(dispatch 工具分支)同构:委派工具从 state 刨子会话ID透传(渲染端只在非空时覆写)——
        // 不补的话轮询通道的 task 块永远没 taskChild,128k 硬闸"等子会话ID再杀"在静默 serve 上永远等不到。
        const tnm = p.tool || 'tool'
        const taskChild = /^(task|delegate_task)$/i.test(tnm) ? extractChildSessionId(st) : ''
        out.push({ partID: cid + ':tool', kind: 'tool', text: tnm, status: st.status || '', input: st.input, output: st.output, title: st.title, error: st.error, taskChild })
      }
    }
  }
  return out
}
async function replyPermission(info, sessionId, requestId, decision) {
  const p = info.permStyle === 'new' ? `/permission/${requestId}/reply` : `/session/${sessionId}/permissions/${requestId}`
  try { await api(info.base, 'POST', p, { reply: decision }) } catch (e) { console.error('permission reply failed:', e.message) }
}
// 交互提问(question)应答:v1=/question/:id/reply|reject;v2=/api/session/:sid/question/:id/...(端子不存在的旧 serve 会 404)。
// reply 给调用方返回成败(卡片要据此定格提问卡/提示重答);reject 多为兜底触发,吞错打日志即可。
async function replyQuestion(info, sessionId, requestId, answers, v2) {
  const p = v2 ? `/api/session/${sessionId}/question/${requestId}/reply` : `/question/${requestId}/reply`
  await api(info.base, 'POST', p, { answers })
}
async function rejectQuestion(info, sessionId, requestId, v2) {
  const p = v2 ? `/api/session/${sessionId}/question/${requestId}/reject` : `/question/${requestId}/reject`
  try { await api(info.base, 'POST', p); console.log('auto-rejected question ' + requestId + ' (no card to answer)') }
  catch (e) { console.error('question reject failed:', e.message) }
}

// R5 断线重连补偿:SSE 断开期间可能错过 session 事件(子agent映射)与 message.updated(tokens)。
// 重连成功后:①强刷会话树(绕过节流) ②对本 serve 登记过的活跃会话摘最新 assistant 的 tokens 喂 noteUsage(上下文水位不失真)。
async function resyncAfterReconnect(info, log) {
  await refreshSessionTree(info.base, true)
  const sids = [...(info.sids || [])]
  for (const sid of sids) {
    try {
      const raw = await api(info.base, 'GET', `/session/${sid}/message`)
      const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if ((m?.info?.role ?? m?.role) === 'assistant') { noteUsage(sid, m?.info ?? m); break }
      }
    } catch {}
  }
  if (sids.length && log) log('reconnect resync done (' + sids.length + ' sessions)')
}
// 契约②: SSE 事件流状态,上层三态健康灯用。up=当前连着;at=最近一字节时间(0=从没连上过)。
function getStreamState(info) {
  return { up: !!(info && info.streamUp), at: (info && info.streamAt) || 0 }
}
// 事件循环每次重连都读 info.base —— 心跳重启把 serve 换到新端口后,本循环会自动接上新 base,无需重启循环。
// info.dead = true(外部 serve 被清出 pool)时退出。
async function runEventLoop(info, handlers, log) {
  const { onPermission, onText, onQuestion, onChildSession, onDiffStat } = handlers || {}
  let dropped = false   // 经历过断线(含对端正常收尾):重连成功后做 R5 补偿
  for (;;) {
    if (info.dead) { info.streamUp = false; log('event loop stopped (' + (info.dir || '(home)') + ')'); return }
    const base = info.base
    try {
      // 半开看门狗:serve 被重启(如为带上新 MCP 工具)时,旧 TCP 连接可能【半开挂死】——reader.read() 永远阻塞、
      // 不报错、不触发重连,而 api() 照常打到新 serve。结果:会话都正常,但工具/思考/流式全静默消失(实测踩中)。
      // serve 会定期发 server.heartbeat,连心跳都 90s 没有 = 连接已死,主动掐掉让外层循环重连。
      const ac = new AbortController()
      let lastByteAt = Date.now()
      const wd = setInterval(() => { if (Date.now() - lastByteAt > 90000) { try { ac.abort() } catch {} } }, 15000)
      let res
      try { res = await fetch(base + '/event', { signal: ac.signal }) }
      catch (e) { clearInterval(wd); throw e }
      if (!res.ok || !res.body) { clearInterval(wd); throw new Error('/event ' + res.status) }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
      info.streamUp = true; info.streamAt = Date.now()   // 契约②:健康灯置绿
      log('event stream connected (' + base + ')')
      if (dropped) { dropped = false; resyncAfterReconnect(info, log).catch(() => {}) }   // R5:重连补偿(异步,不挡事件流)
      try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break
        lastByteAt = Date.now(); info.streamAt = lastByteAt
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
          if (!data) continue
          let ev; try { ev = JSON.parse(data) } catch { continue }
          if (!sampleLogged && /part|message/.test(ev && ev.type || '')) { sampleLogged = true; log('SAMPLE event: ' + JSON.stringify(ev).slice(0, 700)) }
          // ★session.error 的 payload 【每次都打】—— 这是回合失败的唯一现场。
          // 原来只按"事件类型首次出现"打一行 `event type: session.error`,payload 一个字都不落;
          // 于是真机上回合报错时,能看到的只有下游的误诊(编排把空回答当成 schemaFail),
          // 而真正的原因躺在这个 payload 里、被丢掉了。排障最贵的从来不是修,是查不到现场。
          if ((ev && ev.type || '') === 'session.error') {
            try { log('session.error: ' + JSON.stringify(ev.properties || ev).slice(0, 900)) } catch { log('session.error(payload 无法序列化)') }
          }
          if ((ev && ev.type || '').includes('part')) { const pt = ev.properties && ev.properties.part && ev.properties.part.type; if (pt && !seenPartTypes.has(pt)) { seenPartTypes.add(pt); log('part type: ' + pt) } }
          // 诊断:每种事件类型首次出现打一次;带 parentID 的会话事件(子agent映射来源)特别标注,便于确认子agent路由是否可行
          { const et = (ev && ev.type) || ''; if (et && !seenEvTypes.has(et)) { seenEvTypes.add(et); log('event type: ' + et) }
            const si2 = ev && ev.properties && ev.properties.info
            if (si2 && si2.parentID && si2.id && String(si2.id).startsWith('ses_') && String(si2.parentID).startsWith('ses_') && !loggedChildren.has(si2.id)) { loggedChildren.add(si2.id); log('子会话映射 ' + si2.id + ' → parent ' + si2.parentID + ' (' + (si2.title || '') + ')') } }
          // 见到没分类过的会话 → 懒加载会话树建 子→父 映射(保证子agent事件能路由回父卡片)
          { const evp = ev && ev.properties; const evSid = evp && (evp.sessionID || evp.sessionId || (evp.info && (evp.info.sessionID || evp.info.id)))
            if (evSid && !classifiedSessions.has(evSid) && !childToParent.has(evSid)) {
              // permission/question 是一次性事件(serve 不重发):懒刷新是异步的、事件已按原子 sid 发出 →
              // 主进程 sessionInfo 查无 → 静默吞掉挂死(审查实测)。这两类先强制刷新(绕过节流、等在飞那次落地)再 dispatch;
              // 其它事件保持懒刷新(丢了有下一拍,不挡事件流)。
              const et0 = (ev && ev.type) || ''
              const oneShot = (et0.includes('permission') && !et0.includes('replied') && !et0.includes('response'))
                || et0 === 'question.asked' || et0 === 'question.v2.asked'
              if (oneShot) await refreshSessionTree(info.base, true)
              else refreshSessionTree(info.base)
            } }
          dispatch(ev, onPermission, onText, info, onQuestion, onChildSession, onDiffStat)
        }
      }
      } finally { clearInterval(wd) }   // 内层读循环结束(正常断/看门狗掐)都摘定时器,不漏
      info.streamUp = false; dropped = true   // 对端正常收尾也算断线:下一轮重连同样要 R5 补偿
    } catch (e) { info.streamUp = false; if (info.dead) return; dropped = true; log('event stream dropped, reconnect 2s: ' + e.message); await sleep(2000) }
  }
}
function dispatch(ev, onPermission, onText, info, onQuestion, onChildSession, onDiffStat) {
  const type = ev?.type ?? ''
  const p = ev.properties ?? ev.data ?? ev
  // 学习 子会话→父会话 映射:带 parentID 的【会话】事件(task 子agent 创建的子会话)。据此把子agent事件路由回父卡片。
  // 只认 ses_ 开头的会话ID —— message.updated 的 info.parentID 是"父消息"(msg_),别当成会话映射(否则污染 childToParent)。
  const sinfo = (p.info && typeof p.info === 'object') ? p.info : null
  if (sinfo && sinfo.parentID && sinfo.id && sinfo.id !== sinfo.parentID
      && String(sinfo.id).startsWith('ses_') && String(sinfo.parentID).startsWith('ses_')) {
    noteChild(sinfo.id, sinfo.parentID, sinfo.title, info && info.base)
    // 子会话诞生瞬间通知装配层:session.js 据此拦停"指令超限的 task 子 Agent"(128k 口径硬闸)。
    if (onChildSession) { try { onChildSession({ parentId: sinfo.parentID, childId: sinfo.id, title: sinfo.title, info }) } catch {} }
  }
  // 原始 sessionId → 根(卡片)会话 + 是否子agent + 子agent名。子会话事件据此重定向到父卡片。
  const route = (sid) => {
    const root = rootSession(sid)
    return (root && root !== sid) ? { sessionId: root, subagent: true, agentId: sid, agentName: childTitle.get(sid) || '子agent' }
                                  : { sessionId: sid, subagent: false, agentId: '', agentName: '' }
  }
  // session.diff:serve 权威改动账本(本 session 累计 files/additions/deletions)→ 进注册表,改动报告与面板用真数据
  // (编码模式的联合改动报告不再靠 git diff 估算;形状两种:d=对象{files,additions,deletions} 或文件数组,防御兼容)
  if (type === 'session.diff') {
    if (onDiffStat) {
      const d = (p && p.diff != null) ? p.diff : p
      const files = Array.isArray(d) ? d.length : (typeof (d && d.files) === 'number' ? d.files : (Array.isArray(d && d.files) ? d.files.length : 0))
      // 与其它事件同构 route() 归父卡:子会话的 diff 直接按原子 sid 发,session.js 查不到卡会被丢弃(编码分片改动账少算)。
      const r = route(p.sessionID ?? p.sessionId)
      onDiffStat({ sessionId: r.sessionId, files: files || 0, additions: (d && d.additions) || 0, deletions: (d && d.deletions) || 0, subagent: r.subagent, agentId: r.agentId, agentName: r.agentName })
    }
    return
  }
  if (type.includes('permission') && !type.includes('replied') && !type.includes('response')) {
    const { sessionId } = route(p.sessionID ?? p.sessionId ?? p.session_id)   // 子agent的审批请求也送到父卡片
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
    if (requestId && onPermission) onPermission({ sessionId, requestId, tool, detail: String(detail).slice(0, 200), serve: info })
    return
  }
  // 交互提问工具(question):路由给卡片弹【交互提问卡】让用户点选回答(经 onQuestion,应答走 replyQuestion);
  // 没有应答通道时(会话无主/通道未接)才自动 reject 兜底 —— 不拒就是挂死(实测卡 88s 等用户 Esc)。
  // v2 事件(question.v2.asked)走 /api/ 前缀端点;旧 serve 无此端点会 404,rejectQuestion 里 catch 打日志即可。
  if (type === 'question.asked' || type === 'question.v2.asked') {
    // requestId 字段名各家不一(id/requestID/questionID/requestId/question.id)——提不到就静默吞掉,
    // 工具端会一直干等(实测:52s+ 无卡、回合挂死),必须兜底拒答并把形状打进日志
    const requestId = p.id ?? p.requestID ?? p.questionID ?? p.requestId ?? p.questionId ?? (p.question && (p.question.id || p.question.requestID))
    const r = route(p.sessionID ?? p.sessionId)
    const v2 = type.includes('v2')
    if (requestId && onQuestion) onQuestion({ sessionId: r.sessionId, requestId, questions: Array.isArray(p.questions) ? p.questions : [], v2, serve: info })
    else if (info && requestId) rejectQuestion(info, p.sessionID ?? p.sessionId, requestId, v2)
    else console.error('question.asked 但提不到 requestId,payload keys=' + Object.keys(p || {}).join(','), JSON.stringify(p).slice(0, 300))
    return
  }
  // message.updated:assistant 消息元数据(含 tokens 用量)—— 真实 token 计量的 SSE 来源。
  // 摘下来登记给卡片上下文水位用;不带 tokens 的消息(user/早期快照)normalizeUsage 自动跳过。
  if (type === 'message.updated' || type === 'session.message' || type === 'message.completed') {
    const mi = (p.info && typeof p.info === 'object') ? p.info : (p.message && typeof p.message === 'object') ? p.message : null
    if (mi) noteUsage(mi.sessionID ?? mi.sessionId ?? p.sessionID ?? p.sessionId, mi)
    return
  }
  // 流式增量（本版 bocomcode 实测主路径）：message.part.delta { partID, field:'text', delta }
  // field 恒为 part 的字段名（'text'），不代表 kind；真正 reasoning/text 看该 partID 在 part.updated 声明的 type。
  // 不认 delta = 思考过程整段丢失（reasoning 只走 delta）、答案也不实时流（只靠 POST 返回兜底）。
  if (onText && type === 'message.part.delta') {
    const delta = typeof p.delta === 'string' ? p.delta : ''
    const partID = p.partID ?? p.id
    const r = route(p.sessionID ?? p.sessionId)
    if (delta && partID && r.sessionId) {
      const kind = partKind.get(partID) === 'reasoning' ? 'reasoning' : 'text'
      onText({ sessionId: r.sessionId, text: delta, role: 'assistant', partID, kind, delta: true, subagent: r.subagent, agentId: r.agentId, agentName: r.agentName })
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
        const r = route(p.sessionID ?? p.sessionId ?? part.sessionID ?? part.sessionId)
        const role = part.role ?? p.role ?? (p.message && p.message.role)
        const partID = part.id ?? part.partID ?? p.partID
        const kind = ptype === 'text' ? 'text' : 'reasoning'
        if (r.sessionId) onText({ sessionId: r.sessionId, text, role, partID, kind, subagent: r.subagent, agentId: r.agentId, agentName: r.agentName })
      }
    }
    else if (part && ptype === 'tool') {
      // 工具调用:把 名称/入参/结果/标题/错误 全放出来,卡片渲染成可展开的工具日志块(对齐 opencode TUI)。
      // 形状各 serve 略异:opencode 原生放 part.state.{input,output,title,error,status};逐个兜底。
      const st = (part.state && typeof part.state === 'object') ? part.state : {}
      const tnm = (typeof part.tool === 'string' && part.tool) || (typeof st.tool === 'string' && st.tool) || (typeof part.name === 'string' && part.name) || ''
      const rawSid = p.sessionID ?? p.sessionId ?? part.sessionID ?? part.sessionId
      const status = st.status || st.state || part.status || ''
      const cid = String(part.callID || part.id || part.partID || tnm || '')
      const toolInput = st.input ?? part.input ?? part.args ?? part.arguments ?? part.params ?? null
      let toolOutput = null
      for (const c of [st.output, part.output, st.result, part.result, st.metadata && st.metadata.output]) { if (typeof c === 'string' && c) { toolOutput = c; break } }
      const toolTitle = (typeof st.title === 'string' && st.title) || (typeof part.title === 'string' && part.title) || ''
      const toolError = (typeof st.error === 'string' && st.error) || (st.error && typeof st.error.message === 'string' && st.error.message) || ''
      // task 子agent:从结果里刨出子会话ID,登记 子→父 映射(session事件缺失时兜底,让子agent后续事件也能路由回父卡片)
      // 委派工具两族同待:内建 task 与 oh-my-openagent 的 delegate_task(带 load_skills 必填参,子会话机制相同)
      const isDelegate = /^(task|delegate_task)$/i.test(tnm)
      if (isDelegate && rawSid) {
        const childId = extractChildSessionId(st)
        if (childId && childId !== rawSid) noteChild(childId, rawSid, toolTitle, info && info.base)
      }
      const r = route(rawSid)
      const taskChild = isDelegate ? extractChildSessionId(st) : ''   // 父会话的委派工具:关联到哪个子会话(收尾时标该子agent组完成)
      // 委派指令大小(字符数,description+prompt):128k 口径硬闸用 —— 指令过大是子 Agent 撑爆上下文/压缩卡死的第一死因。
      const taskChars = (isDelegate && toolInput && typeof toolInput === 'object')
        ? String(toolInput.description || '').length + String(toolInput.prompt || '').length : 0
      if (r.sessionId && tnm) onText({ sessionId: r.sessionId, text: tnm, role: 'assistant', partID: cid + ':tool', kind: 'tool', status: String(status || ''), toolInput, toolOutput, toolTitle, toolError, subagent: r.subagent, agentId: r.agentId, agentName: r.agentName, taskChild, taskChars, taskDesc: (toolInput && typeof toolInput === 'object' && (toolInput.description || toolInput.prompt)) ? String(toolInput.description || '').slice(0, 80) : '' })
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
  info.proc = spawnServeHook ? spawnServeHook(info.dir, port) : spawnServe(info.dir, port)
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
// 兼容:公网 opencode(1.18.x)的 /heartbeat 返回 200+HTML 页面(形状对不上)—— 形状失败时
// 回退 GET /global/health 做权威判定(它返回 {"healthy":true}),不再把活 serve 误判成"失连"。
function sendHeartbeat(base, ms = 4000) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    let done = false; const fin = (o) => { if (!done) { done = true; resolve(o) } }
    const getJson = (path, cb) => {
      let u; try { u = new URL(base + path) } catch { return cb(null) }
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: ms }, (res) => {
        let txt = ''; res.setEncoding('utf8')
        res.on('data', (c) => { txt += c })
        res.on('end', () => { let j = null; try { j = JSON.parse((txt || '').trim()) } catch {} cb({ status: res.statusCode || 0, json: j }) })
      })
      req.on('timeout', () => { try { req.destroy() } catch {} ; cb(null) })
      req.on('error', () => cb(null))
      req.end()
    }
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
        if (ok) return fin({ healthy: true, status: res.statusCode || 0, body: s.slice(0, 200), ms: Date.now() - t0 })
        // 形状对不上(公网 opencode 返回 HTML)→ 回退 /global/health 权威判定,别冤枉活 serve
        getJson('/global/health', (g) => {
          if (g && g.status >= 200 && g.status < 300 && g.json && g.json.healthy === true)
            return fin({ healthy: true, status: res.statusCode || 0, body: '(heartbeat 形状异,global/health 证活)', ms: Date.now() - t0 })
          fin({ healthy: false, status: res.statusCode || 0, body: s.slice(0, 200), ms: Date.now() - t0 })
        })
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

// 按需回收:自起且已无任何会话引用的 serve 退休(切项目重绑/关卡后调)。
// inUseBases = 当前所有活跃会话所在 serve 的 base 集合;外部 serve 永远不动
function retireIfOrphan(info, inUseBases) {
  if (!info || !info.proc || info.external) return false
  if (inUseBases && inUseBases.has(info.base)) return false
  info.dead = true   // 停它的事件循环(runEventLoop 认 info.dead)
  killProc(info.proc)
  if (pool.get(info.key) === info) pool.delete(info.key)
  if (info.base) baseToEntry.delete(info.base)
  return true
}

// 任一已注册的健康 serve(不新起):对话坞/输入框这类"非对话卡"窗口列模型用 —— 它们没有自己的卡会话,
// 但列模型只是读 /config/providers,随便借一个在跑的 serve 即可,仅为列模型白起一个引擎才是浪费。
function anyHealthyServe() {
  for (const info of new Set(baseToEntry.values())) { if (info && info.base && info.healthy !== false) return info }
  for (const info of pool.values()) { if (info && info.base) return info }
  return null
}

module.exports = { ensureServe, createSession, deleteSession, sendMessage, listModels, listAgents, checkMcp, abort, replyPermission, replyQuestion, rejectQuestion, sessionExists, listSessions, getMessages, getRawMessages, getSessionChildren, getSessionTodo, listPendingQuestions, generationStalled, pollTurnParts, getSessionUsage, getStreamState, consumeAbortFlag, killAll, retireIfOrphan, setServeBin, onKeepAlive, probeOnce, anyHealthyServe, AUTO_ALLOW,
  __test: { dispatch, waitAssistantText, extractText, pickTurnText, abortedSince, abortedSids, normalizeMessages, stripInjected, splitThink,
    normDirKey, sameDir, inflight, noteChild, noteModelBlacklist, modelBlacklist, setDropWatchMs, refreshSessionTree, runEventLoop, turnTextCache, stoppedSids, lastUserMatches, noteUsage,
    maps: { pool, baseToEntry, childToParent, childTitle, classifiedSessions, sidBase },
    setSpawnHook: (fn) => { spawnServeHook = fn } } }
