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

console.log(fail ? ('\n❌ 静默丢弃自测:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ 静默丢弃自测:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
