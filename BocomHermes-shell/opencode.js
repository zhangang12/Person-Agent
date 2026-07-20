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
const seenEvTypes = new Set()     // 每种事件类型打印一次（诊断子agent映射来源等）
const loggedChildren = new Set()  // 每个子会话映射只打一次日志
const partKind = new Map()        // partID -> 'reasoning'|'text'：从 message.part.updated 学到，供 message.part.delta 路由
const childToParent = new Map()   // 子会话ID -> 父会话ID：task 子agent 会创建带 parentID 的子会话,据此把子agent事件路由回父卡片
const childTitle = new Map()      // 子会话ID -> 标题(如 "Explore codebase (@explore subagent)"),给卡片显示子agent名
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
// 保证子agent路由不依赖 session 事件是否早发(节流 1.5s,只在出现新会话时触发)。
const classifiedSessions = new Set()   // 已分类(已知是根 or 已建映射)的会话,避免重复刷
let _lastTreeRefresh = 0, _treeRefreshing = false
async function refreshSessionTree(base) {
  if (_treeRefreshing || Date.now() - _lastTreeRefresh < 1500) return
  _treeRefreshing = true
  try {
    const list = await api(base, 'GET', '/session')
    const arr = Array.isArray(list) ? list : (list && list.data) || []
    for (const s of arr) {
      const info = (s && s.info) ? s.info : s
      if (!info || !info.id) continue
      classifiedSessions.add(info.id)
      if (info.parentID && info.id !== info.parentID) {
        childToParent.set(info.id, info.parentID)
        if (typeof info.title === 'string' && info.title) childTitle.set(info.id, info.title)
      }
    }
    _lastTreeRefresh = Date.now()
  } catch {} finally { _treeRefreshing = false }
}

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
  // requireDirMatch(默认开):serve 的 cwd 必须与请求目录一致才复用 —— 本版 serve 忽略会话级
  // ?directory=,跨目录共享会让"切换项目"的新会话实际仍在旧 cwd 跑(工具/bash 全在错的仓库)。
  const { tryShare = true, requireDirMatch = true, scanStart = 4096, scanEnd = 4110 } = opts
  const key = dir || '__home__'
  startKeepAlive(log)   // 保活:周期 GET /global/health 只刷本会话在用的 serve(纯保活,不判死不重启)
  let existing = pool.get(key)
  // 清跨目录共享的旧账:pool[key] 可能被早年映射到别的 cwd 的 entry
  if (existing && requireDirMatch && (existing.dir || '') !== (dir || '') && existing.supportsDirectory !== true) {
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
      // 同 base 已注册 → 仅当 cwd 相同(或该 serve 已探明支持会话级目录)才共享;
      // 否则落到下方自起分支 —— cwd 正确性优先于省一个进程
      const shared = baseToEntry.get(ext.base)
      if (shared) {
        if (!requireDirMatch || (shared.dir || '') === (dir || '') || shared.supportsDirectory === true) {
          pool.set(key, shared)
          log(`pool[${dir || '(home)'}] → 共享已注册 serve ${ext.base}`)
          return shared
        }
        log(`serve ${ext.base} cwd=[${shared.dir || '(home)'}] ≠ [${dir || '(home)'}],不共享 → 自起独立 serve`)
      } else {
        // 第一次发现这个 base → 注册 + 启事件流(无 proc,我们不管它生死)。
        // dir 记为本次请求目录(外部 serve 的真实 cwd 探不到,按"用户在项目目录里手动起 serve"的主场景假设)
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
  // sig=活动指纹(助手消息数:总part数:文本长:思考长:工具忙),它变了 = 回合还在推进。思考长度必须计入 ——
  // 长思考期间 text 不动,只看 text 会把"正在想"误判成"答完了"。toolRunning=有工具 part 还没到终态:
  // 这是"文本稳定但没答完"唯一可靠的机器信号(答案截半截的根子就是文本稳定 + 工具在跑的间隙)。
  let nParts = 0, rLen = 0, toolRunning = false, tLen = 0
  for (const m of asst) {
    const parts = (m?.parts ?? m?.data?.parts ?? m?.info?.parts) || []
    nParts += parts.length || 0
    for (const p of parts) {
      if (!p) continue
      if (p.type === 'reasoning' || p.type === 'thinking') rLen += String(p.text || p.reasoning || p.content || '').length
      else if (p.type === 'tool') {
        const st = String((p.state && p.state.status) || p.status || '')
        if (st && !/complet|success|done|error|fail|cancel|abort/i.test(st)) toolRunning = true
        // 工具细节也计入指纹:task 子agent 长跑期间父消息的 文本/思考 都不动,唯一会动的是工具 part 的
        // 状态/入参/结果(如子agent进度回写)。不计入的话 fan-out 长波会被空转窗口误判"没进展"提前收走。
        tLen += st.length + String((p.state && (p.state.title || '')) || p.title || '').length
          + String((p.state && (p.state.output != null ? p.state.output : '')) || p.output || '').length
      }
    }
  }
  return { done: laDone && !!laText, text, laDone, laText, toolRunning,
    sig: asst.length + ':' + nParts + ':' + text.length + ':' + rLen + ':' + (toolRunning ? 1 : 0) + ':' + tLen }   // 收尾 = 最后一条 assistant 已完成【且带文本】
}
// maxMs=绝对上限(防永久 hang);idleMs=空转上限(sig 一直不动才算空转)。
// 超时【抛错,不再返回空串】:返回 '' 会让上层无法区分"黑洞会话"和"跑完了没话说" —— 编排层照单全收记成
// status:'ok' 的空产出:不重试、不报错,空白直接流进下游上下文与最终汇总(这正是"任务全绿、成果很薄"的一条根)。
// 已经吐了半截文本的,返回半截(有总比无强);一个字都没有的,抛错让上层重试/报错。
async function waitAssistantText(info, sessionId, maxMs = 1800000, idleMs = 600000) {
  const t0 = Date.now()
  let prev = '', stable = 0, doneNoTextTicks = 0, sig = '', lastMove = Date.now(), lastErr = null, toolBusy = false
  // 工具在跑(如 task 子agent的 fan-out 长波)时空转容忍放宽到 25 分钟:父消息可能整波都不动,10 分钟就收会截走半截;
  // 真黑洞仍有 maxMs 绝对上限兜底。工具不跑时维持原 idleMs。
  while (Date.now() - t0 < maxMs && Date.now() - lastMove < (toolBusy ? Math.max(idleMs, 1500000) : idleMs)) {
    // 自适应轮询:前 6 秒密探(450ms)——简单问题一完成就尽快收,少等半拍;之后疏探(750ms)——
    // 长任务不必频繁打 GET /message。实测这台 serve 首字要 12s(模型 TTFT),客户端能省的就这半秒量级。
    await sleep(Date.now() - t0 < 6000 ? 450 : 750)
    // 本次等待期间会话被 abort(用户点「停止」/看门狗收割)→ 别再傻等 serve 自然收尾(它可能永远不标 completed,
    // 一等就是 idleMs=10 分钟,用户点了停止卡片却一直转圈)。宽限 ~3s 让 abort 后的收尾文本落进消息,然后有啥收啥。
    if (abortedSince(sessionId, t0) && Date.now() - abortedSids.get(sessionId) > 2800) return prev
    let raw; try { raw = await api(info.base, 'GET', `/session/${sessionId}/message`); lastErr = null } catch (e) { lastErr = e; continue }   // 留住最后一个错:serve 挂掉时上层才有的可查(否则=10 分钟静默 + 空结果)
    const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
    const r = pickTurnText(list)
    prev = r.text || prev
    toolBusy = !!r.toolRunning
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
async function sendMessage(info, sessionId, text, model, files, onNote) {
  const tSend = Date.now()   // 本次发送起点:降级/快收的"被中止"判断都只认【这之后】的 abort,不吃历史账
  const parts = []
  if (text != null && text !== '') parts.push({ type: 'text', text })
  for (const f of (files || [])) {                          // 图片/文档 = file part(mime + data URL,实测格式)
    if (f && f.mime && f.url) parts.push({ type: 'file', mime: f.mime, url: f.url, ...(f.filename ? { filename: f.filename } : {}) })
  }
  if (!parts.length) parts.push({ type: 'text', text: text || '' })
  const body = { parts }
  const withModel = !!(model && model.providerID && model.modelID)
  if (withModel) {                                          // 按请求指定模型(各版本字段名兼容,多塞几个,认哪个用哪个)
    body.model = { providerID: model.providerID, modelID: model.modelID }
    body.providerID = model.providerID; body.modelID = model.modelID
  }
  try {
    const direct = extractText(await api(info.base, 'POST', `/session/${sessionId}/message`, body))
    return direct || await waitAssistantText(info, sessionId)   // 空 body（流式版 serve）→ 轮询等完成
  } catch (e) {
    // serve 的 zod 校验不认我们的模型字段形状(4xx)→ 去掉模型重发一次并让用户看见,
    // 而不是整条消息发不出去;其它错误原样上抛
    // "已中止不重发"只认【本次发送之后】的 abort:以前用 has(sid) 判,而 sid 从不按会话删 ——
    // 用户点过一次停止,该会话此后【永久】失去 4xx 降级重发,下一条消息直接把裸 4xx 甩给渲染端。
    if (withModel && /->\s*4\d\d/.test(String(e && e.message || '')) && !abortedSince(sessionId, tSend)) {
      if (onNote) { try { onNote('serve 拒绝了模型指定(' + (model.name || model.modelID) + '),本条已用默认模型发送') } catch {} }
      const d2 = extractText(await api(info.base, 'POST', `/session/${sessionId}/message`, { parts: body.parts }))
      return d2 || await waitAssistantText(info, sessionId)
    }
    throw e
  }
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
        // ctx=模型上下文上限(tokens,来自 serve 的模型元数据 limit.context) —— 上下文用量指示按真实值算,serve 没报才由 UI 回退默认
        const lim = m.limit || m.limits || {}
        out.push({ providerID: p.id, modelID: mid, name: m.name || mid, provider: p.name || p.id, image: !!inp.image, ctx: +lim.context > 0 ? +lim.context : null })
      }
    }
    return out
  } catch { return [] }
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

// 重连用：会话是否还在（直接 GET 取不到就扫列表；未知路由会回 SPA HTML→JSON.parse 抛错→走兜底）
async function sessionExists(info, sid) {
  try { const s = await api(info.base, 'GET', `/session/${sid}`); if (sidOf(s) === sid) return true } catch {}
  try { const list = await api(info.base, 'GET', '/session'); const arr = Array.isArray(list) ? list : (list && list.data) || []; return arr.some((s) => sidOf(s) === sid) } catch { return false }
}
// 重连用：取会话历史消息，归一成 [{role,text}]；端点形态不定，逐个尝试，失败返回 []
// 注入前缀剥离(仅展示层):首条用户消息在发送时被静默拼上 <个人记忆>/<项目背景>/<作答技能> 背景块,
// serve 的历史里存的是全文 —— 续接回放时不剥掉,这坨提示词会原样出现在用户自己的气泡里。只影响显示,不碰 serve 数据。
function stripInjected(t) {
  return String(t == null ? '' : t)
    .replace(/<个人记忆>[\s\S]*?<\/个人记忆>\s*/g, '')
    .replace(/<项目背景>[\s\S]*?<\/项目背景>\s*/g, '')
    .replace(/<作答技能:[^>\n]{0,120}>[\s\S]*?<\/作答技能>\s*/g, '')
    .replace(/<上轮对话接力摘要>[\s\S]*?<\/上轮对话接力摘要>\s*/g, '')   // 压缩续聊注入的摘要,同样不进用户气泡
    .replace(/<动态工作流规程>[\s\S]*?<\/动态工作流规程>\s*/g, '')          // 动态工作流(Claude Code 式)注入的主 Agent 规程
    .replace(/<任务编排执行规程>[\s\S]*?<\/任务编排执行规程>\s*/g, '')      // 任务编排注入的单 Agent 规程
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
function normalizeMessages(r) {
  const list = Array.isArray(r) ? r : (Array.isArray(r && r.messages) ? r.messages : (Array.isArray(r && r.data) ? r.data : null))
  if (!list) return null
  const out = []
  for (const m of list) {
    const role = (m && m.info && m.info.role) || (m && m.role) || (m && m.data && m.data.info && m.data.info.role)
    if (role !== 'user' && role !== 'assistant') continue
    if (role === 'user') {
      const text = stripInjected(extractText(m))
      if (text) out.push({ role, text })
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
    if (st.rest || reasoning) out.push({ role, text: st.rest, reasoning })
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
async function pollTurnParts(info, sid) {
  let raw
  try { raw = await api(info.base, 'GET', `/session/${sid}/message`) } catch { return null }
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
        out.push({ partID: cid + ':tool', kind: 'tool', text: p.tool || 'tool', status: st.status || '', input: st.input, output: st.output, title: st.title, error: st.error })
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

// 事件循环每次重连都读 info.base —— 心跳重启把 serve 换到新端口后,本循环会自动接上新 base,无需重启循环。
// info.dead = true(外部 serve 被清出 pool)时退出。
async function runEventLoop(info, handlers, log) {
  const { onPermission, onText, onQuestion } = handlers || {}
  for (;;) {
    if (info.dead) { log('event loop stopped (' + (info.dir || '(home)') + ')'); return }
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
      log('event stream connected (' + base + ')')
      try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break
        lastByteAt = Date.now()
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
          if (!data) continue
          let ev; try { ev = JSON.parse(data) } catch { continue }
          if (!sampleLogged && /part|message/.test(ev && ev.type || '')) { sampleLogged = true; log('SAMPLE event: ' + JSON.stringify(ev).slice(0, 700)) }
          if ((ev && ev.type || '').includes('part')) { const pt = ev.properties && ev.properties.part && ev.properties.part.type; if (pt && !seenPartTypes.has(pt)) { seenPartTypes.add(pt); log('part type: ' + pt) } }
          // 诊断:每种事件类型首次出现打一次;带 parentID 的会话事件(子agent映射来源)特别标注,便于确认子agent路由是否可行
          { const et = (ev && ev.type) || ''; if (et && !seenEvTypes.has(et)) { seenEvTypes.add(et); log('event type: ' + et) }
            const si2 = ev && ev.properties && ev.properties.info
            if (si2 && si2.parentID && si2.id && String(si2.id).startsWith('ses_') && String(si2.parentID).startsWith('ses_') && !loggedChildren.has(si2.id)) { loggedChildren.add(si2.id); log('子会话映射 ' + si2.id + ' → parent ' + si2.parentID + ' (' + (si2.title || '') + ')') } }
          // 见到没分类过的会话 → 懒加载会话树建 子→父 映射(保证子agent事件能路由回父卡片)
          { const evp = ev && ev.properties; const evSid = evp && (evp.sessionID || evp.sessionId || (evp.info && (evp.info.sessionID || evp.info.id)))
            if (evSid && !classifiedSessions.has(evSid) && !childToParent.has(evSid)) refreshSessionTree(info.base) }
          dispatch(ev, onPermission, onText, info, onQuestion)
        }
      }
      } finally { clearInterval(wd) }   // 内层读循环结束(正常断/看门狗掐)都摘定时器,不漏
    } catch (e) { if (info.dead) return; log('event stream dropped, reconnect 2s: ' + e.message); await sleep(2000) }
  }
}
function dispatch(ev, onPermission, onText, info, onQuestion) {
  const type = ev?.type ?? ''
  const p = ev.properties ?? ev.data ?? ev
  // 学习 子会话→父会话 映射:带 parentID 的【会话】事件(task 子agent 创建的子会话)。据此把子agent事件路由回父卡片。
  // 只认 ses_ 开头的会话ID —— message.updated 的 info.parentID 是"父消息"(msg_),别当成会话映射(否则污染 childToParent)。
  const sinfo = (p.info && typeof p.info === 'object') ? p.info : null
  if (sinfo && sinfo.parentID && sinfo.id && sinfo.id !== sinfo.parentID
      && String(sinfo.id).startsWith('ses_') && String(sinfo.parentID).startsWith('ses_')) {
    childToParent.set(sinfo.id, sinfo.parentID)
    if (typeof sinfo.title === 'string' && sinfo.title) childTitle.set(sinfo.id, sinfo.title)
  }
  // 原始 sessionId → 根(卡片)会话 + 是否子agent + 子agent名。子会话事件据此重定向到父卡片。
  const route = (sid) => {
    const root = rootSession(sid)
    return (root && root !== sid) ? { sessionId: root, subagent: true, agentId: sid, agentName: childTitle.get(sid) || '子agent' }
                                  : { sessionId: sid, subagent: false, agentId: '', agentName: '' }
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
    if (requestId && onPermission) onPermission({ sessionId, requestId, tool, detail: String(detail).slice(0, 200) })
    return
  }
  // 交互提问工具(question):路由给卡片弹【交互提问卡】让用户点选回答(经 onQuestion,应答走 replyQuestion);
  // 没有应答通道时(会话无主/通道未接)才自动 reject 兜底 —— 不拒就是挂死(实测卡 88s 等用户 Esc)。
  // v2 事件(question.v2.asked)走 /api/ 前缀端点;旧 serve 无此端点会 404,rejectQuestion 里 catch 打日志即可。
  if (type === 'question.asked' || type === 'question.v2.asked') {
    const requestId = p.id ?? p.requestID ?? p.questionID
    const r = route(p.sessionID ?? p.sessionId)
    const v2 = type.includes('v2')
    if (requestId && onQuestion) onQuestion({ sessionId: r.sessionId, requestId, questions: Array.isArray(p.questions) ? p.questions : [], v2, serve: info })
    else if (info && requestId) rejectQuestion(info, p.sessionID ?? p.sessionId, requestId, v2)
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
      if (tnm === 'task' && rawSid) {
        const childId = extractChildSessionId(st)
        if (childId && childId !== rawSid) { childToParent.set(childId, rawSid); if (toolTitle) childTitle.set(childId, toolTitle) }
      }
      const r = route(rawSid)
      const taskChild = (tnm === 'task') ? extractChildSessionId(st) : ''   // 父会话的 task 工具:关联到哪个子会话(收尾时标该子agent组完成)
      if (r.sessionId && tnm) onText({ sessionId: r.sessionId, text: tnm, role: 'assistant', partID: cid + ':tool', kind: 'tool', status: String(status || ''), toolInput, toolOutput, toolTitle, toolError, subagent: r.subagent, agentId: r.agentId, agentName: r.agentName, taskChild, taskDesc: (toolInput && typeof toolInput === 'object' && (toolInput.description || toolInput.prompt)) ? String(toolInput.description || '').slice(0, 80) : '' })
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

module.exports = { ensureServe, createSession, sendMessage, listModels, checkMcp, abort, replyPermission, replyQuestion, rejectQuestion, sessionExists, getMessages, pollTurnParts, getSessionUsage, killAll, retireIfOrphan, setServeBin, onKeepAlive, probeOnce, AUTO_ALLOW,
  __test: { dispatch, waitAssistantText, extractText, pickTurnText, abortedSince, abortedSids, normalizeMessages, stripInjected, splitThink } }
