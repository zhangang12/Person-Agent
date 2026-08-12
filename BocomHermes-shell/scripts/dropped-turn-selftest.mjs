// 静默丢弃自测:模型收下请求却一个字节都不出 —— 必须在有限时间内报出真因,不许无限挂着。
//
// 【为什么有这个自测】真机 2026-08-08 花了一整天才查实:核实片用的 opencode/mimo-v2.5-free
// 连 39 条全部"冻住"—— 面板上看在思考,实则 25 分钟零字节。隔离实验钉死了它:
//   deepseek/deepseek-v4-flash 并发 12 → 12/12 全在 2~3s 返回;mimo 并发 1 → 17 条一条不成。
//   所以不是负载/并发/提示词,是那个模型的接入侧不出字(额度或凭据,归账户侧)。
// 而 serve 那边【1 秒内】就有铁证:assistant 消息已建,tokens 全 0、parts 空、error 空、
// time.completed 永不出现。droppedOf() 认得这个指纹,却只在 waitAssistantText 里被调用 ——
// 而那个函数在 POST 返回【之后】才跑,POST 永远不返回,于是证据一辈子没人看。
// 检测代码写对了,挂在一个够不到的地方 —— 这是那一整天里第七次同一个形态,也是最贵的一次。
//
// 跑法:node scripts/dropped-turn-selftest.mjs
import { createRequire } from 'module'
import http from 'http'
const require = createRequire(import.meta.url)
const oc = require('../opencode.js')
const T = oc.__test

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')) }
}

// ── 假 serve:精确复现真机报文 ────────────────────────────────────────────────
// mode='dropped' → POST /message 永不响应(挂住 socket);GET 返回冻住的 assistant 消息
// mode='healthy' → POST 也挂住,但 GET 的消息【带 part 且 token 非零】(慢但活着)
function fakeServe(mode) {
  const created = Date.now()
  const frozen = {
    info: { id: 'msg_1', role: 'assistant', sessionID: 'ses_1', modelID: 'mimo-v2.5-free', providerID: 'opencode',
      time: { created }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [],
  }
  const alive = {
    info: { id: 'msg_1', role: 'assistant', sessionID: 'ses_1', modelID: 'x', providerID: 'y',
      time: { created }, tokens: { input: 1200, output: 30, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ type: 'text', text: '正在写……' }],
  }
  const hung = []          // 挂住不回的 POST,收尾时统一销毁,免得进程不退出
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'POST' && /\/message$/.test(req.url)) { hung.push(res); return }   // ★永不响应
    if (req.method === 'GET' && /\/message$/.test(req.url)) return send([{ info: { id: 'm0', role: 'user' }, parts: [] }, mode === 'dropped' ? frozen : alive])
    if (req.method === 'POST' && /\/abort$/.test(req.url)) { srv.aborted = (srv.aborted || 0) + 1; return send({ ok: true }) }
    send({})
  })
  srv.hung = hung
  return srv
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)))
const close = (srv) => new Promise((r) => { for (const res of srv.hung) { try { res.destroy() } catch {} } srv.close(() => r()) })

console.log('== 静默丢弃(模型收下请求不出字)自测 ==')

T.setDropWatchMs(600)          // 真值 90s,自测缩到 600ms;拉取间隔跟着缩(dropPollMs)
const MODEL = { providerID: 'opencode', modelID: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' }

// ── ① 冻住 → 有限时间内抛出,并说出真因 ──────────────────────────────────────
{
  const srv = fakeServe('dropped')
  const base = await listen(srv)
  const info = { base, dir: '/proj' }
  T.modelBlacklist.clear()
  const notes = []
  const t0 = Date.now()
  let err = null
  try { await oc.sendMessage(info, 'ses_1', '随便问一句', MODEL, [], (m) => notes.push(String(m))) }
  catch (e) { err = e }
  const took = Date.now() - t0

  ok('★请求被静默丢弃 → 抛错,不再无限挂着(修前:POST 不返回就永远等,直到 30 分钟空转上限)', !!err, { took, err: err && err.message })
  ok('  在盯防阈值附近就收(不是等满上层超时)', took < 6000, { took })
  ok('★错误里说出【真因】,不是笼统一句失败', !!err && /没有被处理|0 token/.test(String(err.message)), err && err.message)
  ok('  真因里带上是哪个模型(换模型才是对的下一步)', !!err && /mimo-v2\.5-free/.test(String(err.message)), err && err.message)
  ok('★掐掉那个永不返回的回合(不 abort 就一直占着 serve 的并发与额度)', srv.aborted > 0, srv.aborted)
  ok('★记进【同一本】模型账(4xx 那条也记这里)—— 后续发送直接跳过这个模型指定',
    !!(T.modelBlacklist.get(base) && T.modelBlacklist.get(base).get('mimo-v2.5-free')),
    T.modelBlacklist.get(base) && [...T.modelBlacklist.get(base).keys()])
  ok('★记的是 kind=stall(限流是时段性的)—— 记成永久就等于把用户选的模型悄悄换掉且永不换回',
    (T.modelBlacklist.get(base).get('mimo-v2.5-free') || {}).kind === 'stall',
    T.modelBlacklist.get(base).get('mimo-v2.5-free'))
  ok('  告知上层一次,话术指向额度/凭据而不是网络', notes.some((s) => /额度|凭据/.test(s)), notes)
  await close(srv)
}

// ── ② 慢但活着 → 绝不能误杀(这一格是防止修复变成新的误杀器)──────────────────
// 真机同一台 serve 上 ling-3.0-tiny-free 收官要 36.4s、内网慢端点首字曾要 12s。
// 判据必须是"一个字节都没有",只要有 part 或非零 token 就立刻停止盯防。
{
  const srv = fakeServe('healthy')
  const base = await listen(srv)
  const info = { base, dir: '/proj' }
  T.modelBlacklist.clear()
  let err = null, out = null
  const t0 = Date.now()
  try {
    out = await Promise.race([
      oc.sendMessage(info, 'ses_1', '随便问一句', MODEL, [], () => {}),
      new Promise((r) => setTimeout(() => r('__still_waiting__'), 2500)),   // 2.5s = 阈值的 4 倍
    ])
  } catch (e) { err = e }

  ok('★有产出的慢回合:盯防不许开枪(阈值的 4 倍时间过去了也不判丢弃)',
    out === '__still_waiting__' || (out && out !== '__still_waiting__' && !err),
    { out: String(out).slice(0, 60), err: err && err.message, took: Date.now() - t0 })
  ok('  也没被误记进模型账(误记会让后续发送悄悄不带模型)',
    !(T.modelBlacklist.get(base) && T.modelBlacklist.get(base).get('mimo-v2.5-free')))
  ok('  没有白 abort 一个活着的回合', !srv.aborted, srv.aborted)
  await close(srv)
}

// ── ③ 拉黑的寿命:限流会过期,4xx 不会 ───────────────────────────────────────
// 【为什么补这一格】拉黑之后会发生什么,在真机上【从来没有发生过】—— 拼那条留痕日志时
// 引用了一个看不见的名字(num),一进这条路就 ReferenceError,整条回合断在
// 「Error invoking remote method 'card-send': Error: num is not defined」。
// 也就是说 2026-08-09 加的"拉黑后跳过模型指定"从写下那天起一次都没跑过。修了引用之后
// 这条路才【第一次】通电,而它原本的语义是【永久】的 —— 一次限流就把用户选的模型永远换成
// serve 默认,直接违背"一件事情,一个模型干"。所以必须先把寿命分开,再让它通电。
{
  const B = 'http://127.0.0.1:1/'
  T.modelBlacklist.clear()
  T.noteModelBlacklist(B, 'm-stall', 'stall')
  T.noteModelBlacklist(B, 'm-reject', 'reject')
  ok('刚记上:两种都命中', !!T.blacklistHit(B, 'm-stall') && !!T.blacklistHit(B, 'm-reject'))
  // 把记账时间往前推到超过 TTL(不真等 10 分钟)
  const past = Date.now() - T.BL_TTL.stall - 1000
  T.modelBlacklist.get(B).get('m-stall').at = past
  T.modelBlacklist.get(B).get('m-reject').at = past
  ok('★stall(限流)过期即失效 —— 下一条重新用用户选的模型', T.blacklistHit(B, 'm-stall') === null)
  ok('  过期的条目顺手删掉,不在账上留垃圾', !T.modelBlacklist.get(B).has('m-stall'))
  ok('★reject(4xx 参数校验)是结构性的 → 仍然命中,不会到期',
    !!T.blacklistHit(B, 'm-reject'), T.modelBlacklist.get(B).get('m-reject'))
  ok('  没记过的模型不命中', T.blacklistHit(B, 'm-never') === null)
  ok('  缺参数不炸', T.blacklistHit('', 'x') === null && T.blacklistHit(B, '') === null)
  T.modelBlacklist.clear()
}

// ── ④ 拉黑【之后那一条】才是崩点:必须真走一遍读账那几行 ─────────────────────
// 【为什么必须单独一格】上面 ① 只走到"把模型记进账"(写),而真机崩的是【下一条消息读账】那几行
// (拼留痕日志时引用了看不见的 num)。①②③ 全绿也照样漏掉它 —— 测试只走它自己想到的路径,
// 而这条路要"先有一次限流、再发一条"才踩得到。这一格就是把那个前置状态摆好,真发第二条。
{
  const bodies = []
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'POST' && /\/message$/.test(req.url)) {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => { try { bodies.push(JSON.parse(raw)) } catch { bodies.push(null) } send({ parts: [{ type: 'text', text: '收到' }] }) })
      return
    }
    send({})
  })
  srv.hung = []            // close() 要遍历它(这台假 serve 不挂请求,给个空的)
  const base = await listen(srv)
  const info = { base, dir: '/proj' }
  T.modelBlacklist.clear()
  T.noteModelBlacklist(base, MODEL.modelID, 'stall')     // 前置:上一条已经被限流拉黑

  const told = []
  let err = null, out = null
  try { out = await oc.sendMessage(info, 'ses_9', '第二条', MODEL, [], () => {}, { onModelFallback: (m) => told.push(String(m)) }) }
  catch (e) { err = e }

  ok('★★命中黑名单的那一条能【正常发出去】—— 修前这里抛 num is not defined,整条回合断',
    !err && out === '收到', { err: err && err.message, out })
  ok('  而且是真的不带模型指定(黑名单的全部作用就是这个)',
    bodies.length === 1 && !bodies[0].model && !bodies[0].modelID, bodies[0])
  ok('★告知里说清【多久之后自动改回你选的模型】—— 不说清,用户看到的就是"我选的模型莫名不生效了"',
    told.some((s) => /分钟后自动改回/.test(s)), told)
  ok('  只告知一次,不每条都刷', (await (async () => {
    await oc.sendMessage(info, 'ses_9', '第三条', MODEL, [], () => {}, { onModelFallback: (m) => told.push(String(m)) })
    return told.length === 1
  })()), told)
  ok('  到期之后同一个模型又能被带上了(时段性拉黑不许变成永久)', (await (async () => {
    T.modelBlacklist.get(base).get(MODEL.modelID).at = Date.now() - T.BL_TTL.stall - 1000
    await oc.sendMessage(info, 'ses_9', '第四条', MODEL, [], () => {})
    const last = bodies[bodies.length - 1]
    return !!(last && last.model && last.model.modelID === MODEL.modelID)
  })()), bodies[bodies.length - 1])
  T.modelBlacklist.clear()
  await close(srv)
}

// ── ⑤ 多步回合:每一步新建一条 assistant 消息,最新那条永远是刚建的空壳 ────────
// 【这一格是用户逼出来的,原话:"怎么就自动结束了"】
// serve 在多步回合里每走一步就新建一条 assistant 消息。到阈值那一刻,最新那条往往刚建出来:
// 0 token、0 part、没 completed —— 与"冻住"的指纹逐字相同。老判据只看最新那一条,于是
// 把一个【正在正常干活】的回合掐了。serve 日志实证:13:22:36 step=12 → 13:23:02 step=16
// 五步都在跑,13:23:03 收到我的 cancel。
// ①②③ 全绿也没拦住它 —— 那三格造的都是【单条消息】的场景,从没模拟过多步。
// 判据要看【这一轮在不在动】,不是【最新那条空不空】。
{
  let step = 0
  const hung = []
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'POST' && /\/message$/.test(req.url)) { hung.push(res); return }
    if (req.method === 'GET' && /\/message$/.test(req.url)) {
      step++          // 每次拉取都"又走了一步":前面几条有产出,最新一条是刚建的空壳
      const msgs = [{ info: { id: 'm0', role: 'user' }, parts: [] }]
      for (let i = 1; i <= step; i++) {
        msgs.push({ info: { id: 'msg' + i, role: 'assistant', modelID: 'deepseek-v4-flash',
          time: { created: Date.now(), completed: Date.now() },
          tokens: { input: 900, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ type: 'text', text: '第 ' + i + ' 步' }] })
      }
      // ★最新一条:刚建、全 0、无 part、没 completed —— 与冻住指纹一模一样
      msgs.push({ info: { id: 'msg' + (step + 1), role: 'assistant', modelID: 'deepseek-v4-flash',
        time: { created: Date.now() }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] })
      return send(msgs)
    }
    if (req.method === 'POST' && /\/abort$/.test(req.url)) { srv.aborted = (srv.aborted || 0) + 1; return send({ ok: true }) }
    send({})
  })
  srv.hung = hung
  const base = await listen(srv)
  T.modelBlacklist.clear()
  let err = null, out = null
  out = await Promise.race([
    oc.sendMessage({ base, dir: '/proj' }, 'ses_1', '干活', MODEL, [], () => {}).catch((e) => { err = e; return null }),
    new Promise((r) => setTimeout(() => r('__still_waiting__'), 3000)),   // 阈值 600ms 的 5 倍
  ])
  ok('★★多步回合里"最新一条是刚建的空壳" → 绝不许开枪(真机就是这样被掐掉的)',
    out === '__still_waiting__' && !err, { out: String(out).slice(0, 80), err: err && err.message })
  ok('  也没有白 abort 一个活着的回合', !srv.aborted, srv.aborted)
  ok('  更没被误记进模型账(记了的话后续每条都会悄悄不带模型)',
    !(T.modelBlacklist.get(base) && T.modelBlacklist.get(base).get('mimo-v2.5-free')), [...(T.modelBlacklist.get(base) || new Map()).keys()])
  T.modelBlacklist.clear()
  await close(srv)
}

// ── ⑥ 长工具调用:工具在飞的时候一切都不动,但它没卡 ──────────────────────
// 【用户 2026-08-12:"经常触发模型回合卡死"】上一版的进度指纹是我手搓的,只数
// 消息数/parts/token/文本长 —— 【不看工具状态】。于是一次长工具调用(npm install、跑测试、
// 大页面整页截图……)在它眼里和"冻住"一模一样:parts 不增、token 不动、文本不动,
// 而模型其实正老老实实等我们的工具返回。这就是"经常"的来源 —— 越是干实事的回合越容易中。
// 判据要认【工具在飞】:toolRunning=true 时一律算活着。
{
  const hung = []
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'POST' && /\/message$/.test(req.url)) { hung.push(res); return }
    if (req.method === 'GET' && /\/message$/.test(req.url)) {
      // 一条 assistant:文本/token 全程一个字不动,只挂着一个【还在跑】的工具
      return send([{ info: { id: 'm0', role: 'user' }, parts: [] }, {
        info: { id: 'msg_1', role: 'assistant', modelID: 'deepseek-v4-flash',
          time: { created: Date.now() }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ type: 'tool', callID: 'c1', state: { status: 'running', title: 'npm install' } }],
      }])
    }
    if (req.method === 'POST' && /\/abort$/.test(req.url)) { srv.aborted = (srv.aborted || 0) + 1; return send({ ok: true }) }
    send({})
  })
  srv.hung = hung
  const base = await listen(srv)
  T.modelBlacklist.clear()
  let err = null
  const out = await Promise.race([
    oc.sendMessage({ base, dir: '/proj' }, 'ses_1', '装个依赖', MODEL, [], () => {}).catch((e) => { err = e; return null }),
    new Promise((r) => setTimeout(() => r('__still_waiting__'), 3000)),   // 阈值 600ms 的 5 倍
  ])
  // 注:这一格红验【没红】—— droppedOf 本来就要求 parts 为空,有工具 part 时永远不会判丢弃。
  // 保留它是当防线(将来 droppedOf 的判据若放宽,这条能挡住),但它不是"经常卡死"的主因。
  // 主因是下面 ⑦ 那个:停滞确认窗只有阈值的 1/3。
  ok('工具还在跑(文本/token 全程不动)→ 不许判卡死【防线格,非主因】',
    out === '__still_waiting__' && !err, { out: String(out).slice(0, 90), err: err && err.message })
  ok('  也没白 abort 一个正在干活的回合', !srv.aborted, srv.aborted)
  T.modelBlacklist.clear()
  await close(srv)
}

// ── ⑦ 停滞确认窗:必须停满【整整一个阈值】才判死 ─────────────────────────────
// 【用户 2026-08-12:"经常触发模型回合卡死。这个记时要改"】
// 上一版只要求停滞 1/3 阈值。回合跑过阈值之后,那实际含义就变成"静默 30 秒 = 判死",
// 而真机里最常见的合法静默恰恰是【新起一步、下一个 token 还没来】(模型排队/内网端点慢):
// 新消息让指纹动一下、计时清零,接着就是一段纯等待。30 秒对它太苛刻。
// 阈值本身(90s)是当初实测定的"压过合法慢首字"(最慢的正常收官 36.4s),停满它才对得上原意。
{
  const created = Date.now()
  const frozen = {
    info: { id: 'msg_1', role: 'assistant', sessionID: 'ses_1', modelID: 'mimo-v2.5-free',
      time: { created }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [],
  }
  const hung = []
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'POST' && /\/message$/.test(req.url)) { hung.push(res); return }
    if (req.method === 'GET' && /\/message$/.test(req.url)) return send([{ info: { id: 'm0', role: 'user' }, parts: [] }, frozen])
    if (req.method === 'POST' && /\/abort$/.test(req.url)) { srv.aborted = (srv.aborted || 0) + 1; return send({ ok: true }) }
    send({})
  })
  srv.hung = hung
  const base = await listen(srv)
  T.modelBlacklist.clear()
  // 阈值 600ms:停滞确认窗 = 整整 600ms(旧版是 200ms)。
  // 在 [起判 600ms, 起判+确认窗) 这段里【不许】开枪 —— 900ms 时还得活着。
  let err = null
  const out = await Promise.race([
    oc.sendMessage({ base, dir: '/proj' }, 'ses_1', '问一句', MODEL, [], () => {}).catch((e) => { err = e; return null }),
    new Promise((r) => setTimeout(() => r('__alive_at_1100ms__'), 1100)),
  ])
  // 检查点必须落在两种窗【之间】,否则测了等于没测:
  //   拉取网格 200ms;起判 600ms → 首次有效评估在 600ms(记指纹、计时清零)
  //   旧窗 400ms → 1000ms 那一拍开枪;新窗 600ms → 要到 1200ms。所以 1100ms 是唯一能分开两者的点。
  //   (第一版我写的是 900ms —— 两种窗在那时都还没开枪,红验自然不红。)
  ok('★★起判之后、确认窗没满之前:不许开枪(旧版 1/3 窗在 1000ms 那一拍就已经杀了)',
    out === '__alive_at_1100ms__' && !err, { out: String(out).slice(0, 60), err: err && err.message })
  // 再等一会儿:确认窗满了,真冻住的还是要抓到 —— 放宽不等于放过
  const out2 = await Promise.race([
    new Promise((r) => setTimeout(() => r('__still_alive__'), 2500)),
    new Promise((r) => { const t = setInterval(() => { if (err) { clearInterval(t); r('__fired__') } }, 50) }),
  ])
  ok('★确认窗满了,真冻住的照样抓得到(放宽不是放过)', out2 === '__fired__' || !!err, { out2, err: err && err.message })
  T.modelBlacklist.clear()
  await close(srv)
}

console.log(fail ? ('\n❌ 静默丢弃自测:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ 静默丢弃自测:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
