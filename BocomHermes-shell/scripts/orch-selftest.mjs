/**
 * 编排引擎自测:src/orch/{run,nodes,schema,ledger,render}.js
 * 跑法:node scripts/orch-selftest.mjs   (npm run orch:test)
 *
 * ★本文件照《docs/编排引擎-契约.md》写,不照实现写 ——
 *   照实现写测试就退化成一面镜子(实现错了测试跟着错),照契约写才是真检查。
 *   所以这里出现的每一条断言都能在契约里指到出处;实现与契约不一致时,红的是实现。
 *
 * 覆盖:
 *   §3.3 Run.phase 转移表逐行 / Node.state 转移表逐行(新状态 + effects 集合)
 *   §3.4 不变式:applyEvent 不原地改入参(深比较)、不读时钟(Date.now/Math.random 换抛异常桩)、返回新对象
 *   计时器守恒:任何离开 running 的转移必须伴随 clearTimer(全表遍历,不许漏)
 *   幂等:同一 EXIT_RESULT 投 3 次只产生一次 decide;终态 run 收任何事件都不再有副作用
 *   反死板:预算耗尽 → awaiting-user 而不是 done;frontier 空 → 仍发 replan 而不是 done
 *   §6 schema:extractJson 10 例 / coerce 8 例 / validate 8 例(含 done:true 的 gaps 硬校验)
 *   §4 nodes:evalExit 六类退出闸各过/不过、writeScope 两两相交被拒、超 maxNodes 截断、safeVerifyCmd 黑名单
 *   §3.5 重启续接逐行
 *   §7 渲染:renderReplan 逐项 includes(尤其「无验证证据的节点」与「这是合法答案」)
 *
 * 零依赖、无 Electron、无 serve、无网络。
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// ── 计数与断言 ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else {
    fail++
    let tail = ''
    if (extra !== undefined) { try { tail = '  → ' + JSON.stringify(extra) } catch { tail = '  → ' + String(extra) } }
    console.log('  ✗ ' + name + tail)
  }
}
// 段落级兜底:某段抛异常不该让后面的段一条都跑不了(实现半成品时尤其重要)
function section(title, fn) {
  console.log('\n' + title)
  try { fn() } catch (e) { fail++; console.log('  ✗ 本段抛异常:' + ((e && e.stack) || e)) }
}

// ── 模块装载(缺文件不崩,记一条失败继续往下)──────────────────────────────────
const MISSING = []
function tryReq(p) { try { return require(p) } catch (e) { MISSING.push(p + ' → ' + String(e && e.message).split('\n')[0]); return null } }
const RUN = tryReq('../src/orch/run.js')
const NODES = tryReq('../src/orch/nodes.js')
const SCHEMA = tryReq('../src/orch/schema.js')
const LEDGER = tryReq('../src/orch/ledger.js')
const RENDER = tryReq('../src/orch/render.js')
function need(mod, name) { if (!mod) throw new Error('模块缺失/装载失败:' + name + '(见开头 MISSING 列表)'); return mod }

// ── 通用小工具 ───────────────────────────────────────────────────────────────
const T0 = 1700000000000
let CLOCK = T0
const tick = () => (CLOCK += 1000)
let IDN = 0
const mkId = (prefix) => String(prefix || 'x') + (++IDN)   // 确定性 id:契约要求 id 由外部注入,replay 才能对齐
const CTX = { mkId }

const ty = (fx) => (fx || []).map((e) => e && e.type)
const of = (fx, t) => (fx || []).filter((e) => e && e.type === t)
const has = (fx, t) => of(fx, t).length > 0
const byId = (r, id) => (r.nodes || []).find((n) => n.id === id)
const byTitle = (r, t) => (r.nodes || []).find((n) => n.title === t)
const stOf = (r, id) => { const n = byId(r, id); return n ? n.state : '(无此节点)' }
const dbg = (out) => ({ phase: out && out.run && out.run.phase, states: (out && out.run ? out.run.nodes.map((n) => n.id + ':' + n.state) : []), fx: ty(out && out.effects) })

// 违规收集器:step() 每投一个事件就顺手查一遍,等于全表遍历式检查
const MUT = []      // 原地改了入参
const SAMEREF = []  // 返回的 run 与入参同一个对象
const TIMER = []    // 离开 running 却没 clearTimer
const INV = []      // invariants() 在健康流程中报了违反

/**
 * 统一投递口:所有事件都从这里过 ——
 * 于是「不原地改入参 / 返回新对象 / 计时器守恒 / invariants 干净」这四条
 * 自动覆盖到全表每一行,不用为它们单独写一遍场景。
 */
function step(run, ev, tag) {
  const before = JSON.stringify(run)
  const beforeStates = {}
  for (const n of run.nodes || []) beforeStates[n.id] = n.state
  const out = RUN.applyEvent(run, Object.assign({ at: tick() }, ev), CTX)
  const where = (tag || '?') + '/' + ev.type
  if (JSON.stringify(run) !== before) MUT.push(where)
  if (!out || !out.run || !Array.isArray(out.effects)) throw new Error(where + ' 的返回值不是 { run, effects }:' + JSON.stringify(out))
  if (out.run === run) SAMEREF.push(where)
  const fx = out.effects
  for (const n of out.run.nodes || []) {
    if (beforeStates[n.id] === 'running' && n.state !== 'running') {
      const keys = of(fx, 'clearTimer').map((e) => String(e.key || ''))
      for (const kind of ['silent', 'stall']) {
        const suffix = ':' + n.id + ':' + kind
        if (!keys.some((k) => k.endsWith(suffix))) TIMER.push(where + ' 节点' + n.id + '(→' + n.state + ')未 clearTimer(*' + suffix + '),实际 clearTimer:' + JSON.stringify(keys))
      }
    }
  }
  try { const v = RUN.invariants(out.run); if (Array.isArray(v) && v.length) INV.push(where + ' → ' + v.join(' / ')) } catch (e) { INV.push(where + ' invariants() 抛异常:' + e.message) }
  return out
}

// ── Run/Node 构造(严格照契约 §2 的字段表,不多不少)────────────────────────────
function mkNode(over) {
  const o = over || {}
  return Object.assign({
    id: 'n1', wave: 1, origin: 'plan', kind: 'work',
    title: '节点', goal: '目标', brief: '下发文本',
    deps: [], writeScope: [], contract: [],
    state: 'pending', attempt: 0, maxAttempts: 2, patches: 0, maxPatches: 2,
    cardId: null, wcId: null, sid: null,
    queuedAt: 0, startedAt: 0, lastTurnAt: 0, settledAt: 0,
    reason: '', droppedReason: '',
  }, o, {
    exit: Object.assign({ artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '', noEmpty: true }, o.exit || {}),
    result: Object.assign({ final: '', files: [], rounds: 0, aborted: false, exitReport: [], verdict: '', cmdExit: null, contractMiss: [], unverified: false }, o.result || {}),
  })
}
function mkRun(over) {
  const o = over || {}
  const nodes = o.nodes || []
  return Object.assign({
    id: 'R-test', goal: '哨兵总目标·把采购模块拆干净', dir: '/proj', backendDir: '/proj/backend', model: null,
    alias: 'OC-a3f9', createdAt: T0, updatedAt: T0,
    phase: 'executing', nodes,
    decisions: [], userNotes: [], concurrency: 2, pendingDecision: null,
    result: { summary: '', deliverables: [], gaps: [] }, lastError: '',
  }, o, {
    ledger: Object.assign({ facts: [], open: [], assumptions: [], gaps: [] }, o.ledger || {}),
    budget: Object.assign({ maxNodes: 24, spawned: nodes.length, maxDecides: 48, spentDecides: 0, maxWallMs: 6 * 3600e3, startedAt: T0, invalidStreak: 0, resumeCredit: 1 }, o.budget || {}),
  })
}
// DECIDED 事件必须回带在飞决策的 id/point,否则实现有权当过期报文丢掉
const decided = (r, over) => Object.assign({
  type: 'DECIDED',
  decisionId: (r.pendingDecision && r.pendingDecision.id) || 'd-none',
  point: (r.pendingDecision && r.pendingDecision.point) || 'replan',
  ok: true, data: {}, invalid: '',
}, over)

// 三个 plan 节点规格:带自定 id,deps 引用它(契约 §4「deps 可解析」)
const PLAN3 = [
  { id: 'a', kind: 'work', title: '哨兵甲', goal: '做甲', deps: [], writeScope: ['src/a'], contract: [], exit: { noEmpty: true } },
  { id: 'b', kind: 'work', title: '哨兵乙', goal: '做乙', deps: [], writeScope: ['src/b'], contract: [], exit: { noEmpty: true } },
  { id: 'c', kind: 'verify', title: '哨兵丙', goal: '做丙', deps: ['a'], writeScope: ['src/c'], contract: [], exit: { noEmpty: true } },
]

console.log('== 编排引擎自测(照契约,不照实现)==')
if (MISSING.length) { for (const m of MISSING) console.log('  ! 装载失败:' + m) }

// ═══════════════════════════════════════════════════════════════════════════
// 驱动器:每组只驱动事件、不做断言 —— 断言在各 section 里消费返回的日志。
// 这样同一套驱动可以被「时钟桩」那一段整体再跑一遍(跑一遍全表必须不炸)。
// ═══════════════════════════════════════════════════════════════════════════

/** Run.phase 表:R1~R6 走真实流程(顺带覆盖 createRun) */
function drivePhaseHead() {
  const L = {}
  const run0 = RUN.createRun({ goal: '哨兵总目标·把采购模块拆干净', dir: '/proj', backendDir: '/proj/backend', model: null, alias: 'OC-a3f9', concurrency: 2, budget: { maxNodes: 8 } }, { at: T0, mkId })
  L.created = run0
  const r1 = step(run0, { type: 'RUN_START' }, 'R1'); L.R1 = r1
  // R4:plan 连撞两次不合法 → 第一次窄重问,第二次转人工(绝不静默兜底成默认拆法)
  const bad1 = step(r1.run, decided(r1.run, { point: 'plan', ok: false, invalid: 'nodes 不是数组' }), 'R4a'); L.R4a = bad1
  const bad2 = step(bad1.run, decided(bad1.run, { point: 'plan', ok: false, invalid: 'nodes 不是数组' }), 'R4b'); L.R4b = bad2
  // R3:模型判定不值得拆(独立一条流程,别污染主线)
  const solo = step(RUN.createRun({ goal: '就问一句', dir: '/proj', backendDir: '', model: null, alias: 'OC-solo', concurrency: 2 }, { at: T0, mkId }), { type: 'RUN_START' }, 'R3a')
  L.R3 = step(solo.run, decided(solo.run, { point: 'plan', ok: true, data: { needGrounding: false, nodes: [], more: 'no', open: [], why: '一句话能答' } }), 'R3')
  // R2:合法方案 → 待批
  const r2base = step(RUN.createRun({ goal: '哨兵总目标·把采购模块拆干净', dir: '/proj', backendDir: '', model: null, alias: 'OC-a3f9', concurrency: 2, budget: { maxNodes: 8 } }, { at: T0, mkId }), { type: 'RUN_START' }, 'R2a')
  const r2 = step(r2base.run, decided(r2base.run, { point: 'plan', ok: true, data: { needGrounding: false, nodes: PLAN3, more: 'no', open: [], why: '三片' } }), 'R2'); L.R2 = r2
  // R6:打回重规划
  L.R6 = step(r2.run, { type: 'USER_REJECT', note: '哨兵打回理由' }, 'R6')
  // R5:批准 → executing,且内部折进一次 TICK
  L.R5 = step(r2.run, { type: 'USER_APPROVE', edits: null }, 'R5')
  return L
}

/** Run.phase 表:R7~R16(手搭 run,状态可精确摆位) */
function drivePhaseBody() {
  const L = {}
  // R7 有 ready 有容量 → dispatch × k(k = 容量,不是 ready 数)
  L.R7 = step(mkRun({ concurrency: 2, nodes: [mkNode({ id: 'n1' }), mkNode({ id: 'n2' }), mkNode({ id: 'n3' })] }), { type: 'TICK' }, 'R7')
  // R8 EXIT_RESULT → 节点终态 → 每节点必调 replan
  L.R8 = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'settled', result: { final: '干完了' } })] }),
    { type: 'EXIT_RESULT', nodeId: 'n1', pass: true, report: [{ kind: 'noEmpty', ok: true, detail: '有终答' }], verdict: '', cmdExit: null, contractMiss: [], unverified: false }, 'R8')
  // R9 frontier:无 ready 无 running 无 pendingDecision → 仍发 replan(代码不替它宣布收口)
  L.R9 = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'verified' }), mkNode({ id: 'n2', state: 'skipped' })] }), { type: 'TICK' }, 'R9')
  // R10 replan 增删合并 → wave++
  const r10base = mkRun({ nodes: [mkNode({ id: 'n1', state: 'verified' }), mkNode({ id: 'n2', state: 'pending' })], pendingDecision: { id: 'd9', point: 'replan', at: T0 } })
  L.R10 = step(r10base, decided(r10base, {
    point: 'replan', ok: true,
    data: { needGrounding: false, addNodes: [{ id: 'z', kind: 'work', title: '哨兵新增', goal: '补一片', deps: [], writeScope: ['src/z'], contract: [] }], dropNodes: [{ id: 'n2', why: '不用做了' }], done: false, askUser: '', facts: [], open: [], more: 'unknown', why: '继续' },
  }), 'R10')
  // R11 done:true & 无 running → 收口
  const r11base = mkRun({ nodes: [mkNode({ id: 'n1', state: 'verified' }), mkNode({ id: 'n2', state: 'pending' })], pendingDecision: { id: 'd9', point: 'replan', at: T0 } })
  L.R11 = step(r11base, decided(r11base, { point: 'replan', ok: true, data: { done: true, final: { summary: '哨兵收口结论', deliverables: ['src/a'], gaps: [] }, addNodes: [], dropNodes: [], facts: [], open: [], why: '够了' } }), 'R11')
  // R12 askUser
  const r12base = mkRun({ nodes: [mkNode({ id: 'n1', state: 'verified' })], pendingDecision: { id: 'd9', point: 'replan', at: T0 } })
  L.R12 = step(r12base, decided(r12base, { point: 'replan', ok: true, data: { done: false, askUser: '两条路选哪条?', addNodes: [], dropNodes: [] } }), 'R12')
  // R13 用户插话:无在飞决策 → 立刻问;有在飞决策 → 挂起不丢
  L.R13a = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'running' })] }), { type: 'USER_NOTE', text: '哨兵插话甲' }, 'R13a')
  L.R13b = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'running' })], pendingDecision: { id: 'd9', point: 'replan', at: T0 } }), { type: 'USER_NOTE', text: '哨兵插话乙' }, 'R13b')
  // R14 预算耗尽 → 转人工(不是 done)
  L.R14 = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'running' }), mkNode({ id: 'n2', state: 'pending' })] }), { type: 'BUDGET_EXCEEDED', what: 'maxDecides' }, 'R14')
  // R14' 连撞三次不合法 → 转人工
  let s = mkRun({ nodes: [mkNode({ id: 'n1', state: 'running' })], pendingDecision: { id: 'd1', point: 'replan', at: T0 } })
  const streak = []
  for (let i = 0; i < 3; i++) {
    const out = step(s, decided(s, { point: 'replan', ok: false, invalid: '第' + (i + 1) + '次不合法' }), 'R14s' + i)
    streak.push(out); s = out.run
    // 重新挂一个在飞决策:不合法的降级动作是"不改图、继续跑",引擎【不会】自己立刻再问一次
    // (那会在一个事件里自我循环把预算烧光)。真实世界里下一次 replan 由下一个节点收官或 frontier 触发,
    // 这里手动补上,才谈得上"连续三次决策都不合法"。
    if (s.phase === 'executing') s = Object.assign({}, s, { pendingDecision: { id: 'd' + (i + 2), point: 'replan', event: 'frontier', nodeId: '', at: T0 } })
  }
  L.streak = streak
  // R15 awaiting-user 被用户答复 → 回 executing
  L.R15a = step(mkRun({ phase: 'awaiting-user', nodes: [mkNode({ id: 'n1', state: 'pending' })] }), { type: 'USER_NOTE', text: '走第二条' }, 'R15a')
  L.R15b = step(mkRun({ phase: 'awaiting-user', nodes: [mkNode({ id: 'n1', state: 'pending' })] }), { type: 'USER_APPROVE' }, 'R15b')
  // R16 中止 / 面板卡关了
  L.R16a = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'running' }), mkNode({ id: 'n2', state: 'pending' })] }), { type: 'USER_ABORT' }, 'R16a')
  L.R16b = step(mkRun({ phase: 'awaiting-approval', nodes: [mkNode({ id: 'n1', state: 'pending' })] }), { type: 'PANEL_CARD_GONE' }, 'R16b')
  // R18 终态幂等吸收
  const doneRun = mkRun({ phase: 'done', nodes: [mkNode({ id: 'n1', state: 'verified' })] })
  L.R18 = ['TICK', 'USER_NOTE', 'USER_ABORT', 'EXIT_RESULT', 'BUDGET_EXCEEDED'].map((t) => step(doneRun, { type: t, nodeId: 'n1', text: 'x', pass: false, what: 'x' }, 'R18'))
  const cancelledRun = mkRun({ phase: 'cancelled', nodes: [mkNode({ id: 'n1', state: 'cancelled' })] })
  L.R18c = step(cancelledRun, { type: 'TICK' }, 'R18c')
  return L
}

/** Node.state 表 N1~N14 */
function driveNodeRows() {
  const L = {}
  // N1 派发:pending → (queued) → running,两根计时器都挂上
  const n1a = step(mkRun({ concurrency: 2, nodes: [mkNode({ id: 'n1' })] }), { type: 'TICK' }, 'N1a')
  const n1b = step(n1a.run, { type: 'NODE_DISPATCHED', nodeId: 'n1', cardId: 'card-1', wcId: 77, sid: 'ses-1' }, 'N1b')
  L.N1 = { a: n1a, b: n1b, fx: [].concat(n1a.effects, n1b.effects) }
  // N2 无容量:停在 run 内的 queued,不进全局队列
  L.N2 = step(mkRun({ concurrency: 1, nodes: [mkNode({ id: 'n0', state: 'running' }), mkNode({ id: 'n1' })] }), { type: 'TICK' }, 'N2')
  // N3 上游失败 → skipped
  L.N3 = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'failed' }), mkNode({ id: 'n2', deps: ['n1'] })] }), { type: 'TICK' }, 'N3')
  const running = () => mkRun({ nodes: [mkNode({ id: 'n1', state: 'running', cardId: 'card-1', wcId: 77 })] })
  // N4 轮开始 → 只清 silent
  L.N4 = step(running(), { type: 'WORKER_TURN_START', nodeId: 'n1' }, 'N4')
  // N5 轮结束 ≠ 完成(不看 todos)
  L.N5 = step(running(), { type: 'WORKER_TURN_END', nodeId: 'n1', final: '我全做完了(诱饵)', files: ['src/a/x.js'], rounds: 3, aborted: false }, 'N5')
  // N6 错误轮 ≠ 结束
  L.N6 = step(running(), { type: 'WORKER_TURN_ERROR', nodeId: 'n1' }, 'N6')
  // N7 静默到点 → settled + evalExit
  L.N7 = step(running(), { type: 'TIMER', nodeId: 'n1', key: 'silent', kind: 'silent' }, 'N7')
  // N8 卡死 / 卡没了
  L.N8a = step(running(), { type: 'TIMER', nodeId: 'n1', key: 'stall', kind: 'stall' }, 'N8a')
  L.N8b = step(running(), { type: 'WORKER_CARD_GONE', nodeId: 'n1' }, 'N8b')
  const settled = (over) => mkRun({ nodes: [mkNode(Object.assign({ id: 'n1', state: 'settled', result: { final: '交付了' } }, over))] })
  // N9 过闸 → verified
  L.N9 = step(settled(), { type: 'EXIT_RESULT', nodeId: 'n1', pass: true, report: [{ kind: 'noEmpty', ok: true, detail: '有终答' }], verdict: 'PASS', cmdExit: 0, contractMiss: [], unverified: false }, 'N9')
  // N10 不过闸但还有次数 → 回 pending 重来,brief 追加拒因
  L.N10before = settled({ attempt: 0, maxAttempts: 2, brief: '原始下发文本' })
  L.N10 = step(L.N10before, { type: 'EXIT_RESULT', nodeId: 'n1', pass: false, report: [{ kind: 'contract', ok: false, detail: '哨兵拒因·缺签名 createOrder' }], verdict: '', cmdExit: null, contractMiss: ['createOrder'], unverified: false }, 'N10')
  // N11 次数用尽 → failed + 缺口入账
  L.N11 = step(settled({ attempt: 2, maxAttempts: 2 }), { type: 'EXIT_RESULT', nodeId: 'n1', pass: false, report: [{ kind: 'verifyCmd', ok: false, detail: '哨兵缺口·测试没过' }], verdict: '', cmdExit: 1, contractMiss: [], unverified: true }, 'N11')
  // N12 verified 上又来了一轮 = 交棒/复活,合法
  L.N12 = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'verified' })] }), { type: 'WORKER_TURN_START', nodeId: 'n1' }, 'N12')
  // N13 手动重试
  L.N13 = step(mkRun({ nodes: [mkNode({ id: 'n1', state: 'failed', attempt: 2, maxAttempts: 2 })] }), { type: 'USER_RETRY', nodeId: 'n1' }, 'N13')
  // N14 只有未 running 的能被砍
  const n14base = mkRun({ nodes: [mkNode({ id: 'n1', state: 'pending' }), mkNode({ id: 'n2', state: 'queued' }), mkNode({ id: 'n3', state: 'running' })], pendingDecision: { id: 'd9', point: 'replan', at: T0 } })
  L.N14 = step(n14base, decided(n14base, { point: 'replan', ok: true, data: { done: false, addNodes: [], dropNodes: [{ id: 'n1', why: '多余' }, { id: 'n2', why: '多余' }, { id: 'n3', why: '正在跑也想砍' }] } }), 'N14')
  return L
}

/** §3.5 重启续接 */
function driveRestart() {
  const L = {}
  const run = mkRun({
    phase: 'suspended',
    nodes: [
      mkNode({ id: 'v1', state: 'verified', attempt: 1 }),
      mkNode({ id: 'v2', state: 'verified', attempt: 1 }),
      mkNode({ id: 's1', state: 'settled', attempt: 0 }),
      mkNode({ id: 'r1', state: 'running', attempt: 1, cardId: 'card-r1' }),
      mkNode({ id: 'q1', state: 'queued', attempt: 1 }),
      mkNode({ id: 'f1', state: 'failed', attempt: 2 }),
      mkNode({ id: 'k1', state: 'skipped' }),
      mkNode({ id: 'p1', state: 'pending' }),
    ],
  })
  L.resume = step(run, { type: 'USER_RESUME' }, 'RS')
  const ex = (r, id, pass) => step(r, { type: 'EXIT_RESULT', nodeId: id, pass, report: [{ kind: 'noEmpty', ok: pass, detail: 'x' }], verdict: '', cmdExit: pass ? 0 : 1, contractMiss: [], unverified: false }, 'RS.' + id)
  let cur = L.resume.run
  L.v1 = ex(cur, 'v1', true); cur = L.v1.run       // verified 复核过 → 保持
  L.v2 = ex(cur, 'v2', false); cur = L.v2.run      // verified 复核不过 → pending,attempt 不增
  L.r1 = ex(cur, 'r1', true); cur = L.r1.run       // running 全过 → 直接 verified(磁盘产出说话)
  L.q1 = ex(cur, 'q1', false); cur = L.q1.run      // queued 不过 → pending + lost-on-restart,attempt 不增
  L.final = cur
  return L
}

/** 幂等:同一个 EXIT_RESULT 投 3 次 */
function driveIdempotent() {
  const ev = { type: 'EXIT_RESULT', at: T0 + 5, nodeId: 'n1', pass: true, report: [{ kind: 'noEmpty', ok: true, detail: '有终答' }], verdict: '', cmdExit: null, contractMiss: [], unverified: false }
  let cur = mkRun({ nodes: [mkNode({ id: 'n1', state: 'settled', result: { final: '交付了' } })] })
  const outs = []
  for (let i = 0; i < 3; i++) { const o = step(cur, ev, 'IDEM' + i); outs.push(o); cur = o.run }
  return outs
}

function walkAll() { drivePhaseHead(); drivePhaseBody(); driveNodeRows(); driveRestart(); driveIdempotent() }

// ═══════════════════════════════════════════════════════════════════════════
// 断言
// ═══════════════════════════════════════════════════════════════════════════

section('用例1:Run.phase 转移表 R1~R6(§3.3 上表)', () => {
  need(RUN, 'src/orch/run.js')
  const L = drivePhaseHead()
  // createRun 本身:不产生 effects,只落一个 planning 的 Run
  ok('createRun → phase=planning', L.created.phase === 'planning', L.created.phase)
  ok('createRun 快照并发度(run 内恒定)', L.created.concurrency === 2, L.created.concurrency)
  ok('createRun 不带节点', Array.isArray(L.created.nodes) && L.created.nodes.length === 0, L.created.nodes)

  // R1 planning + RUN_START → planning,decide(plan) persist ui
  ok('R1 planning+RUN_START → planning', L.R1.run.phase === 'planning', dbg(L.R1))
  ok('R1 effects 含 decide(point=plan)', of(L.R1.effects, 'decide').some((e) => e.point === 'plan'), ty(L.R1.effects))
  ok('R1 effects 含 persist', has(L.R1.effects, 'persist'), ty(L.R1.effects))
  ok('R1 effects 含 ui', has(L.R1.effects, 'ui'), ty(L.R1.effects))
  ok('R1 记下在飞决策(不重复发起)', !!L.R1.run.pendingDecision && L.R1.run.pendingDecision.point === 'plan', L.R1.run.pendingDecision)

  // R2 DECIDED(plan, ok, nodes≥1) → awaiting-approval
  ok('R2 → awaiting-approval', L.R2.run.phase === 'awaiting-approval', dbg(L.R2))
  ok('R2 建出 3 个节点', L.R2.run.nodes.length === 3, L.R2.run.nodes.map((n) => n.title))
  ok('R2 节点 wave=1', L.R2.run.nodes.every((n) => n.wave === 1), L.R2.run.nodes.map((n) => n.wave))
  ok('R2 节点 origin=plan', L.R2.run.nodes.every((n) => n.origin === 'plan'), L.R2.run.nodes.map((n) => n.origin))
  ok('R2 节点初始 state=pending', L.R2.run.nodes.every((n) => n.state === 'pending'), L.R2.run.nodes.map((n) => n.state))
  ok('R2 deps 被解析成真实 nodeId', (() => { const c = byTitle(L.R2.run, '哨兵丙'), a = byTitle(L.R2.run, '哨兵甲'); return !!c && !!a && c.deps.length === 1 && c.deps[0] === a.id })(), L.R2.run.nodes.map((n) => n.id + '<-' + JSON.stringify(n.deps)))
  ok('R2 effects 含 persist+ui', has(L.R2.effects, 'persist') && has(L.R2.effects, 'ui'), ty(L.R2.effects))
  ok('R2 待批阶段不派卡(还没批就开工=越权)', !has(L.R2.effects, 'dispatch'), ty(L.R2.effects))
  ok('R2 budget.spawned 记账 3', L.R2.run.budget.spawned === 3, L.R2.run.budget)

  // R3 nodes=0 && more='no' → done
  ok('R3 不值得拆 → done', L.R3.run.phase === 'done', dbg(L.R3))
  ok('R3 effects 含 notify', has(L.R3.effects, 'notify'), ty(L.R3.effects))
  ok('R3 effects 含 archive', has(L.R3.effects, 'archive'), ty(L.R3.effects))

  // R4 DECIDED(plan, invalid) ×2 → awaiting-user(★三选一,绝不静默兜底成默认拆法)
  ok('R4 第一次不合法 → 仍 planning(窄重问)', L.R4a.run.phase === 'planning', dbg(L.R4a))
  ok('R4 第一次不合法 → 再发一次 decide', of(L.R4a.effects, 'decide').length === 1, ty(L.R4a.effects))
  ok('R4 第一次不合法 → 不建任何节点(不兜底成默认拆法)', L.R4a.run.nodes.length === 0, L.R4a.run.nodes)
  ok('R4 第二次不合法 → awaiting-user', L.R4b.run.phase === 'awaiting-user', dbg(L.R4b))
  ok('R4 第二次不合法 → 不再发 decide(转人工三选一)', !has(L.R4b.effects, 'decide'), ty(L.R4b.effects))
  ok('R4 不合法留痕进 decisions', L.R4b.run.decisions.length >= 2 && L.R4b.run.decisions.some((d) => d.invalid), L.R4b.run.decisions)

  // R5 USER_APPROVE → executing(内部折进 TICK)
  ok('R5 USER_APPROVE → executing', L.R5.run.phase === 'executing', dbg(L.R5))
  ok('R5 批准后当场派卡(→TICK 折进本次)', has(L.R5.effects, 'dispatch'), ty(L.R5.effects))
  ok('R5 派卡数受并发闸(concurrency=2)', of(L.R5.effects, 'dispatch').length <= 2, ty(L.R5.effects))
  ok('R5 有 deps 的节点不被提前派', (() => { const c = byTitle(L.R5.run, '哨兵丙'); return !!c && of(L.R5.effects, 'dispatch').every((e) => e.nodeId !== c.id) })(), of(L.R5.effects, 'dispatch').map((e) => e.nodeId))

  // R6 USER_REJECT → planning + decide(replan,'user-reject')
  ok('R6 USER_REJECT → planning', L.R6.run.phase === 'planning', dbg(L.R6))
  ok('R6 effects 含 decide(replan/user-reject)', of(L.R6.effects, 'decide').some((e) => e.point === 'replan' && String(e.event) === 'user-reject'), of(L.R6.effects, 'decide'))
  ok('R6 打回理由留痕', JSON.stringify(L.R6.run).includes('哨兵打回理由'), L.R6.run.userNotes)
})

section('用例2:Run.phase 转移表 R7~R18(§3.3 上表续)', () => {
  need(RUN, 'src/orch/run.js')
  const L = drivePhaseBody()

  // R7 有 ready 有容量 → dispatch × k
  ok('R7 → executing', L.R7.run.phase === 'executing', dbg(L.R7))
  ok('R7 3 个 ready、容量 2 → 恰好 2 次 dispatch', of(L.R7.effects, 'dispatch').length === 2, ty(L.R7.effects))
  ok('R7 effects 含 persist+ui', has(L.R7.effects, 'persist') && has(L.R7.effects, 'ui'), ty(L.R7.effects))

  // R8 ★每节点必调 replan = 反死板核心
  ok('R8 节点终态 → run 仍 executing', L.R8.run.phase === 'executing', dbg(L.R8))
  ok('R8 ★节点 settled 后必发 decide(replan,node-settled)', of(L.R8.effects, 'decide').some((e) => e.point === 'replan' && String(e.event) === 'node-settled'), of(L.R8.effects, 'decide'))
  ok('R8 decide 带上是哪个节点', of(L.R8.effects, 'decide').some((e) => e.nodeId === 'n1'), of(L.R8.effects, 'decide'))

  // R9 frontier ★代码不替它宣布收口
  ok('R9 frontier 空 → 仍 executing(不是 done)', L.R9.run.phase === 'executing', dbg(L.R9))
  ok('R9 ★frontier 空 → 发 decide(replan,frontier)', of(L.R9.effects, 'decide').some((e) => e.point === 'replan' && String(e.event) === 'frontier'), of(L.R9.effects, 'decide'))
  ok('R9 frontier 空 → 不 archive(收口权在模型)', !has(L.R9.effects, 'archive'), ty(L.R9.effects))

  // R10 增删合并
  ok('R10 → executing', L.R10.run.phase === 'executing', dbg(L.R10))
  ok('R10 新增节点进 run', !!byTitle(L.R10.run, '哨兵新增'), L.R10.run.nodes.map((n) => n.title))
  ok('R10 新增节点 wave++ = 2', (byTitle(L.R10.run, '哨兵新增') || {}).wave === 2, (byTitle(L.R10.run, '哨兵新增') || {}).wave)
  ok('R10 新增节点 origin=replan', (byTitle(L.R10.run, '哨兵新增') || {}).origin === 'replan', (byTitle(L.R10.run, '哨兵新增') || {}).origin)
  ok('R10 被砍节点 → skipped(只增不删)', stOf(L.R10.run, 'n2') === 'skipped' && L.R10.run.nodes.length === 3, L.R10.run.nodes.map((n) => n.id + ':' + n.state))
  ok('R10 合并后当场 TICK(派新节点)', has(L.R10.effects, 'dispatch'), ty(L.R10.effects))

  // R11 done
  ok('R11 done:true & 无 running → done', L.R11.run.phase === 'done', dbg(L.R11))
  ok('R11 effects 含 cancelNode(全部)', of(L.R11.effects, 'cancelNode').length >= 1, ty(L.R11.effects))
  ok('R11 effects 含 archive', has(L.R11.effects, 'archive'), ty(L.R11.effects))
  ok('R11 effects 含 notify', has(L.R11.effects, 'notify'), ty(L.R11.effects))
  ok('R11 收口结论落进 run.result', String(L.R11.run.result.summary).includes('哨兵收口结论'), L.R11.run.result)

  // R12 askUser
  ok('R12 askUser → awaiting-user', L.R12.run.phase === 'awaiting-user', dbg(L.R12))
  ok('R12 effects 含 ui', has(L.R12.effects, 'ui'), ty(L.R12.effects))
  ok('R12 askUser 不 archive', !has(L.R12.effects, 'archive'), ty(L.R12.effects))

  // R13 用户插话
  ok('R13a 无在飞决策 → executing + decide(replan,user-note)', L.R13a.run.phase === 'executing' && of(L.R13a.effects, 'decide').some((e) => e.point === 'replan' && String(e.event) === 'user-note'), dbg(L.R13a))
  ok('R13b 有在飞决策 → 不重复发起决策', !has(L.R13b.effects, 'decide'), ty(L.R13b.effects))
  ok('R13b 插话被挂起但绝不丢', L.R13b.run.userNotes.some((n) => n.text === '哨兵插话乙' && !n.consumedBy), L.R13b.run.userNotes)

  // R14 ★预算耗尽 → awaiting-user 而不是 done
  ok('R14 ★BUDGET_EXCEEDED → awaiting-user(不是 done)', L.R14.run.phase === 'awaiting-user', dbg(L.R14))
  ok('R14 预算耗尽不许自动收口(无 archive)', !has(L.R14.effects, 'archive'), ty(L.R14.effects))
  ok('R14 effects 含 cancelNode(running)', of(L.R14.effects, 'cancelNode').some((e) => e.nodeId === 'n1'), of(L.R14.effects, 'cancelNode'))
  ok('R14 effects 含 ui', has(L.R14.effects, 'ui'), ty(L.R14.effects))
  ok('R14 不发新 decide(别再烧预算)', !has(L.R14.effects, 'decide'), ty(L.R14.effects))
  const st = L.streak
  ok('R14\' 连撞 1/2 次仍 executing(窄重问)', st[0].run.phase === 'executing' && st[1].run.phase === 'executing', st.map((o) => o.run.phase))
  ok('R14\' invalidStreak 累加到 3', st[2].run.budget.invalidStreak >= 3, st.map((o) => o.run.budget.invalidStreak))
  ok('R14\' ★连撞 3 次 → awaiting-user(不是 done)', st[2].run.phase === 'awaiting-user', dbg(st[2]))

  // R15 awaiting-user 复活
  ok('R15a USER_NOTE → executing + decide(replan,user-answer)', L.R15a.run.phase === 'executing' && of(L.R15a.effects, 'decide').some((e) => e.point === 'replan' && String(e.event) === 'user-answer'), dbg(L.R15a))
  ok('R15b USER_APPROVE → executing + decide(replan,user-answer)', L.R15b.run.phase === 'executing' && of(L.R15b.effects, 'decide').some((e) => e.point === 'replan' && String(e.event) === 'user-answer'), dbg(L.R15b))

  // R16 中止
  ok('R16a USER_ABORT → cancelled', L.R16a.run.phase === 'cancelled', dbg(L.R16a))
  ok('R16a cancelNode 覆盖全部节点', of(L.R16a.effects, 'cancelNode').length >= 2, of(L.R16a.effects, 'cancelNode'))
  ok('R16a effects 含 archive+persist', has(L.R16a.effects, 'archive') && has(L.R16a.effects, 'persist'), ty(L.R16a.effects))
  ok('R16b PANEL_CARD_GONE(awaiting-approval)→ cancelled', L.R16b.run.phase === 'cancelled', dbg(L.R16b))

  // R18 终态幂等吸收
  const SIDE = ['dispatch', 'decide', 'evalExit', 'cancelNode', 'archive', 'armTimer', 'notify']
  ok('R18 done 收任何事件 phase 不变', L.R18.every((o) => o.run.phase === 'done'), L.R18.map((o) => o.run.phase))
  ok('R18 done 收任何事件都无副作用(只 persist)', L.R18.every((o) => !o.effects.some((e) => SIDE.includes(e.type))), L.R18.map((o) => ty(o.effects)))
  ok('R18 cancelled 同样幂等吸收', L.R18c.run.phase === 'cancelled' && !L.R18c.effects.some((e) => SIDE.includes(e.type)), dbg(L.R18c))
})

section('用例3:Node.state 转移表(§3.3 下表)', () => {
  need(RUN, 'src/orch/run.js')
  const L = driveNodeRows()

  // N1 派发 + 两根计时器
  ok('N1 TICK 发出 dispatch', of(L.N1.a.effects, 'dispatch').some((e) => e.nodeId === 'n1'), ty(L.N1.a.effects))
  ok('N1 TICK 后落在 queued/running', ['queued', 'running'].includes(stOf(L.N1.a.run, 'n1')), stOf(L.N1.a.run, 'n1'))
  ok('N1 NODE_DISPATCHED → running', stOf(L.N1.b.run, 'n1') === 'running', dbg(L.N1.b))
  ok('N1 卡身份落账(cardId/wcId/sid)', (() => { const n = byId(L.N1.b.run, 'n1'); return n.cardId === 'card-1' && n.wcId === 77 && n.sid === 'ses-1' })(), byId(L.N1.b.run, 'n1'))
  const arms = of(L.N1.fx, 'armTimer')
  ok('N1 挂 armTimer(silent,45s)', arms.some((e) => e.kind === 'silent' && e.ms === 45000), arms)
  ok('N1 挂 armTimer(stall,15min)', arms.some((e) => e.kind === 'stall' && e.ms === 900000), arms)
  ok('N1 计时器键 = runId:nodeId:kind(不用 wcId,钉出/重挂后不成孤儿)', arms.every((e) => e.key === 'R-test:n1:' + e.kind), arms.map((e) => e.key))

  // N2 无容量
  ok('N2 无容量 → queued(不进全局队列,停在 run 内)', stOf(L.N2.run, 'n1') === 'queued', dbg(L.N2))
  ok('N2 无容量不发 dispatch', !of(L.N2.effects, 'dispatch').some((e) => e.nodeId === 'n1'), ty(L.N2.effects))

  // N3 上游失败
  ok('N3 上游 failed → 下游 skipped', stOf(L.N3.run, 'n2') === 'skipped', dbg(L.N3))
  ok('N3 droppedReason=上游失败', String((byId(L.N3.run, 'n2') || {}).droppedReason).includes('上游失败'), (byId(L.N3.run, 'n2') || {}).droppedReason)
  ok('N3 被跳过的节点不发 dispatch', !of(L.N3.effects, 'dispatch').some((e) => e.nodeId === 'n2'), ty(L.N3.effects))

  // N4~N6 轮内事件都不改终态
  const clr = (fx) => of(fx, 'clearTimer').map((e) => String(e.key))
  ok('N4 WORKER_TURN_START → 仍 running', stOf(L.N4.run, 'n1') === 'running', dbg(L.N4))
  ok('N4 清 silent 计时器', clr(L.N4.effects).includes('R-test:n1:silent'), clr(L.N4.effects))
  ok('N4 不清 stall(卡死闸必须一直挂着)', !clr(L.N4.effects).includes('R-test:n1:stall'), clr(L.N4.effects))
  ok('N5 WORKER_TURN_END → ★仍 running(不看 todos,轮末不当完成)', stOf(L.N5.run, 'n1') === 'running', dbg(L.N5))
  ok('N5 记下本轮 result', (() => { const r = (byId(L.N5.run, 'n1') || {}).result || {}; return r.final === '我全做完了(诱饵)' && (r.files || []).join() === 'src/a/x.js' && r.rounds === 3 })(), (byId(L.N5.run, 'n1') || {}).result)
  ok('N5 重挂 silent(45s)', of(L.N5.effects, 'armTimer').some((e) => e.kind === 'silent' && e.ms === 45000), of(L.N5.effects, 'armTimer'))
  ok('N5 轮末不 evalExit(静默到点才收)', !has(L.N5.effects, 'evalExit'), ty(L.N5.effects))
  ok('N6 WORKER_TURN_ERROR → 仍 running(错误轮≠结束)', stOf(L.N6.run, 'n1') === 'running', dbg(L.N6))
  ok('N6 重挂 silent(45s)', of(L.N6.effects, 'armTimer').some((e) => e.kind === 'silent' && e.ms === 45000), of(L.N6.effects, 'armTimer'))

  // N7/N8 离开 running
  ok('N7 TIMER(silent) → settled', stOf(L.N7.run, 'n1') === 'settled', dbg(L.N7))
  ok('N7 发 evalExit', of(L.N7.effects, 'evalExit').some((e) => e.nodeId === 'n1'), ty(L.N7.effects))
  ok('N8a TIMER(stall) → settled + reason=stalled', stOf(L.N8a.run, 'n1') === 'settled' && (byId(L.N8a.run, 'n1') || {}).reason === 'stalled', dbg(L.N8a))
  ok('N8a 发 cancelNode + evalExit', has(L.N8a.effects, 'cancelNode') && has(L.N8a.effects, 'evalExit'), ty(L.N8a.effects))
  ok('N8b WORKER_CARD_GONE → settled + reason=card-gone', stOf(L.N8b.run, 'n1') === 'settled' && (byId(L.N8b.run, 'n1') || {}).reason === 'card-gone', dbg(L.N8b))
  ok('N8b 发 evalExit(卡没了也要按磁盘产出判)', has(L.N8b.effects, 'evalExit'), ty(L.N8b.effects))

  // N9~N11 退出闸结果回灌
  ok('N9 EXIT_RESULT(pass) → verified', stOf(L.N9.run, 'n1') === 'verified', dbg(L.N9))
  ok('N9 cancelNode(自己)', of(L.N9.effects, 'cancelNode').some((e) => e.nodeId === 'n1'), of(L.N9.effects, 'cancelNode'))
  ok('N9 facts 入账', (L.N9.run.ledger.facts || []).length > 0, L.N9.run.ledger)
  ok('N9 发 decide(replan)', of(L.N9.effects, 'decide').some((e) => e.point === 'replan'), of(L.N9.effects, 'decide'))
  // pending 是过渡态:applyEvent 内部把 tick 走完(不留"忘了 tick 就停住"的口子),所以落点是 running
  ok('N10 EXIT_RESULT(!pass) & attempt<max → 重新派出(running,不是 failed)',
    stOf(L.N10.run, 'n1') === 'running' && has(L.N10.effects, 'dispatch'), dbg(L.N10))
  ok('N10 重派换新卡新会话(新眼睛防锚定)',
    !(byId(L.N10.run, 'n1') || {}).cardId && !(byId(L.N10.run, 'n1') || {}).sid, byId(L.N10.run, 'n1'))
  ok('N10 attempt++', (byId(L.N10.run, 'n1') || {}).attempt === 1, (byId(L.N10.run, 'n1') || {}).attempt)
  ok('N10 brief 追加拒因(下一轮看得见为什么被打回)', String((byId(L.N10.run, 'n1') || {}).brief).includes('哨兵拒因'), String((byId(L.N10.run, 'n1') || {}).brief).slice(0, 200))
  ok('N11 EXIT_RESULT(!pass) & attempt>=max → failed', stOf(L.N11.run, 'n1') === 'failed', dbg(L.N11))
  ok('N11 gaps 入账', (L.N11.run.ledger.gaps || []).length > 0, L.N11.run.ledger)
  ok('N11 发 decide(replan,node-failed)', of(L.N11.effects, 'decide').some((e) => e.point === 'replan' && String(e.event) === 'node-failed'), of(L.N11.effects, 'decide'))

  // N12~N14
  ok('N12 ★verified + WORKER_TURN_START → running(交棒/复活是合法转移)', stOf(L.N12.run, 'n1') === 'running', dbg(L.N12))
  ok('N13 failed + USER_RETRY → 重新派出(同上,pending 是过渡态)',
    stOf(L.N13.run, 'n1') === 'running' && has(L.N13.effects, 'dispatch'), dbg(L.N13))
  ok('N13 maxAttempts++', (byId(L.N13.run, 'n1') || {}).maxAttempts === 3, byId(L.N13.run, 'n1'))
  ok('N14 pending 被砍 → skipped', stOf(L.N14.run, 'n1') === 'skipped', dbg(L.N14))
  ok('N14 queued 被砍 → skipped', stOf(L.N14.run, 'n2') === 'skipped', dbg(L.N14))
  ok('N14 ★running 砍不动(只有未 running 的能被砍)', stOf(L.N14.run, 'n3') === 'running', dbg(L.N14))
})

section('用例4:readyNodes / invariants / projectSnapshot(§3、§7)', () => {
  need(RUN, 'src/orch/run.js')
  const r = mkRun({
    nodes: [
      mkNode({ id: 'n1', state: 'verified' }), mkNode({ id: 'n2', state: 'skipped', droppedReason: '被重规划撤掉' }),
      mkNode({ id: 'n3', state: 'pending', deps: ['n1', 'n2'] }),
      mkNode({ id: 'n4', state: 'pending', deps: ['n5'] }), mkNode({ id: 'n5', state: 'failed' }),
      mkNode({ id: 'n6', state: 'running', startedAt: T0 }), mkNode({ id: 'n7', state: 'pending' }), mkNode({ id: 'n8', state: 'queued' }),
    ],
  })
  const ready = RUN.readyNodes(r).map((n) => n.id).sort().join(',')
  ok('readyNodes:deps 全 verified/skipped 的 pending 才算 ready', ready === 'n3,n7', ready)
  ok('readyNodes:deps 里有 failed 的不算 ready', !ready.includes('n4'), ready)
  ok('readyNodes:running/queued 不算 ready', !ready.includes('n6') && !ready.includes('n8'), ready)

  const snapBefore = JSON.stringify(r)
  const inv = RUN.invariants(r)
  ok('invariants 返回数组', Array.isArray(inv), inv)
  ok('invariants:健康 run 无违反', Array.isArray(inv) && inv.length === 0, inv)
  ok('invariants 只写日志不改状态', JSON.stringify(r) === snapBefore)

  const snap = RUN.projectSnapshot(r)
  const keys = ['id', 'goal', 'phase', 'alias', 'counts', 'wave', 'budget', 'nodes', 'decisions', 'pendingDecision', 'result', 'notes']
  ok('projectSnapshot 字段齐(§7)', keys.every((k) => k in snap), keys.filter((k) => !(k in snap)))
  const c = snap.counts || {}
  ok('counts.total=8', c.total === 8, c)
  ok('counts.verified=1', c.verified === 1, c)
  ok('counts.running=1', c.running === 1, c)
  ok('counts.queued=1', c.queued === 1, c)
  ok('counts.pending=3', c.pending === 3, c)
  ok('counts.failed=1', c.failed === 1, c)
  ok('counts.skipped=1', c.skipped === 1, c)
  const nk = ['id', 'title', 'kind', 'state', 'attempt', 'wave', 'cardId', 'reason', 'files']
  ok('snapshot.nodes 每行字段齐', Array.isArray(snap.nodes) && snap.nodes.length === 8 && nk.every((k) => k in snap.nodes[0]), snap.nodes && snap.nodes[0])
  ok('projectSnapshot 不改 run', JSON.stringify(r) === snapBefore)
  if (RENDER) ok('render.js 也导出 projectSnapshot(§7)', typeof RENDER.projectSnapshot === 'function', typeof RENDER.projectSnapshot)
})

// ══ 用例5:退出闸不过时【先补做、补不动才重做】════════════════════════════════
// 由产品负责人评审提出:"判严了 → 好好的节点被打回重做"是设计缺陷 —— 打回补没跑的那一项就行。
// 六类退出闸里只有 noEmpty(零产出)意味着这张卡根本没干活;其余五类都是【活干了但差一截】,
// 差一截该在【原卡原会话】补(它的上下文还在),而不是新开一张卡把整片重做。
section('用例5:退出闸不过 → 先原卡补做,补不动才重做(评审修正)', () => {
  need(RUN, 'src/orch/run.js')
  const settledWithCard = (over, report) => mkRun({
    nodes: [mkNode(Object.assign({
      id: 'n1', state: 'settled', cardId: 'c9', wcId: 77, sid: 'ses_9',
      result: { final: '写完了', files: ['src/a.ts'], exitReport: report },
    }, over))],
  })
  const failEv = (report) => ({ type: 'EXIT_RESULT', nodeId: 'n1', pass: false, report, verdict: '', cmdExit: null, contractMiss: [], unverified: true })
  const EVID = [{ kind: 'evidence', ok: false, detail: '没有构建/测试执行证据' }]
  const EMPTY = [{ kind: 'noEmpty', ok: false, detail: '零产出' }]

  // P1 只差"没跑验证" → 原卡补做
  const r1 = settledWithCard({}, EVID)
  const P1 = step(r1, failEv(EVID), 'P1')
  ok('P1 ★只差一截 → 原卡补做(state 回 running,不是新开卡)', stOf(P1.run, 'n1') === 'running', dbg(P1))
  ok('P1 发 patchNode 而不是 dispatch', has(P1.effects, 'patchNode') && !has(P1.effects, 'dispatch'), ty(P1.effects))
  ok('P1 ★卡与会话都留着(上下文不丢)', (byId(P1.run, 'n1') || {}).cardId === 'c9' && (byId(P1.run, 'n1') || {}).sid === 'ses_9', byId(P1.run, 'n1'))
  ok('P1 ★不消耗 attempt(那是留给整片重来的预算)', (byId(P1.run, 'n1') || {}).attempt === 0, (byId(P1.run, 'n1') || {}).attempt)
  ok('P1 patches 计到 1', (byId(P1.run, 'n1') || {}).patches === 1, (byId(P1.run, 'n1') || {}).patches)
  ok('P1 补做请求带上缺了什么', of(P1.effects, 'patchNode').some((e) => (e.missing || []).some((m) => m.kind === 'evidence')), of(P1.effects, 'patchNode'))
  ok('P1 重新挂静默计时(它要再跑一轮)', of(P1.effects, 'armTimer').some((e) => e.kind === 'silent'), ty(P1.effects))

  // P2 零产出 → 补无可补,走重做
  const P2 = step(settledWithCard({ result: { final: '', files: [], exitReport: EMPTY } }, EMPTY), failEv(EMPTY), 'P2')
  ok('P2 ★零产出不补做(这张卡根本没干活)', !has(P2.effects, 'patchNode'), ty(P2.effects))
  ok('P2 走重做:attempt++ 且换新卡', (byId(P2.run, 'n1') || {}).attempt === 1 && !(byId(P2.run, 'n1') || {}).cardId, byId(P2.run, 'n1'))

  // P3 验证节点不补:它自己的规程写着"验证恒由新分片执行(新眼睛防锚定)"
  const P3 = step(settledWithCard({ kind: 'verify' }, EVID), failEv(EVID), 'P3')
  ok('P3 ★verify 节点不补做(不许自己给自己的报告补圆)', !has(P3.effects, 'patchNode'), ty(P3.effects))

  // P4 卡已经没了 → 没有可续的上下文,只能重做
  const P4 = step(settledWithCard({ cardId: null, wcId: null, sid: null, reason: 'card-gone' }, EVID), failEv(EVID), 'P4')
  ok('P4 ★卡没了 → 不补做,重开', !has(P4.effects, 'patchNode'), ty(P4.effects))

  // P5 补做次数到顶 → 降级成重做(不许无限补)
  const P5 = step(settledWithCard({ patches: 2, maxPatches: 2 }, EVID), failEv(EVID), 'P5')
  ok('P5 ★补满 → 降级重做(不无限补)', !has(P5.effects, 'patchNode') && has(P5.effects, 'dispatch'), ty(P5.effects))
  ok('P5 降级重做才算一次 attempt', (byId(P5.run, 'n1') || {}).attempt === 1, byId(P5.run, 'n1'))

  // P6 补做 → 再不过 → 再补 → 补满 → 重做 → 重做用尽 → failed(整条升级链)
  let cur = settledWithCard({}, EVID)
  const seen = []
  for (let i = 0; i < 6; i++) {
    const out = step(cur, failEv(EVID), 'P6-' + i)
    const n = byId(out.run, 'n1') || {}
    seen.push(n.state + '/p' + n.patches + '/a' + n.attempt)
    if (n.state === 'failed') break
    // 模拟工人又跑了一轮但仍不过:回到 settled 再判一次
    cur = Object.assign({}, out.run, { nodes: out.run.nodes.map((x) => Object.assign({}, x, { state: 'settled', cardId: x.cardId || 'c9', sid: x.sid || 'ses_9' })) })
  }
  ok('P6 ★升级链:补做 → 补满降级重做 → 重做用尽 → failed', seen[seen.length - 1].startsWith('failed'), seen)
  ok('P6 补做发生在重做之前(先便宜后贵)', seen[0].indexOf('/p1/a0') > 0, seen)

  // P7 老存档兜底:重构前落盘的 run.json 里的节点没有 patches/maxPatches 两个字段。
  //    不兜底的话 undefined < undefined = false,补做分支【静默失效】,悄悄退回"一律重做"的老行为 ——
  //    这类"字段缺失导致新功能不声不响不生效"最难查,所以钉一条。
  const legacyNode = mkNode({ id: 'n1', state: 'settled', cardId: 'c9', wcId: 77, sid: 'ses_9', result: { final: '写完了', files: ['src/a.ts'], exitReport: EVID } })
  delete legacyNode.patches; delete legacyNode.maxPatches
  const P7 = step(mkRun({ nodes: [legacyNode] }), failEv(EVID), 'P7')
  ok('P7 ★老存档节点(无 patches 字段)照样走补做', has(P7.effects, 'patchNode'), ty(P7.effects))
  ok('P7 patches 从缺失起算到 1', (byId(P7.run, 'n1') || {}).patches === 1, byId(P7.run, 'n1'))
})

// ══ 用例6:接线期暴露的静默失效(全是"纯逻辑层测不出、真跑才炸"的类型)══════════
// 来源:P6 删除面测绘顺带做的新引擎审计。每条都验证过是真 bug,不是假报。
section('用例6:全局并发余量 capHint(不给就会造出"running 却没有卡"的死节点)', () => {
  need(RUN, 'src/orch/run.js')
  const mk3 = () => mkRun({ phase: 'executing', concurrency: 4, nodes: [mkNode({ id: 'a' }), mkNode({ id: 'b' }), mkNode({ id: 'c' })] })

  // 不给 capHint:退回"只看 run 内并发"的老行为(3 个都派)
  const free = RUN.applyEvent(mk3(), { type: 'TICK', at: T0 }, CTX)
  ok('无 capHint:按 run 内并发派满(向后兼容)', free.run.nodes.filter((n) => n.state === 'running').length === 3,
    free.run.nodes.map((n) => n.id + ':' + n.state))

  // 全局只剩 1 个位:只许派 1 个,其余【停在 queued】而不是置 running
  const tight = RUN.applyEvent(mk3(), { type: 'TICK', at: T0 }, Object.assign({}, CTX, { capHint: 1 }))
  const running = tight.run.nodes.filter((n) => n.state === 'running')
  const queued = tight.run.nodes.filter((n) => n.state === 'queued')
  ok('★全局余量 1:只派 1 个', running.length === 1, tight.run.nodes.map((n) => n.id + ':' + n.state))
  ok('★其余停在 queued(不是 running)', queued.length === 2, tight.run.nodes.map((n) => n.id + ':' + n.state))
  ok('★没派出去的不许挂静默计时(挂了 45s 后就会把它判成零产出)',
    of(tight.effects, 'armTimer').every((e) => e.nodeId === running[0].id), of(tight.effects, 'armTimer').map((e) => e.nodeId))
  ok('dispatch 只发 1 条', of(tight.effects, 'dispatch').length === 1, ty(tight.effects))

  // 全局满:一个都不派,全 queued —— 老行为会把 3 个都置 running 然后全部在 45s 后判死
  const full = RUN.applyEvent(mk3(), { type: 'TICK', at: T0 }, Object.assign({}, CTX, { capHint: 0 }))
  ok('★全局满:一个都不派', !full.run.nodes.some((n) => n.state === 'running'), full.run.nodes.map((n) => n.state))
  ok('全局满:不发 dispatch', !has(full.effects, 'dispatch'), ty(full.effects))
})

section('用例6b:证据闸的原料来自 probe.actions(供不上就永远过不了闸)', () => {
  need(NODES, 'src/orch/nodes.js')
  const n = { id: 'n1', kind: 'work', writeScope: ['src/a'], contract: [],
    exit: { artifacts: [], requireEvidence: true, requireVerdict: false, verifyCmd: '', noEmpty: true },
    result: { final: '写完了', files: ['src/a.ts'], exitReport: [] } }
  // 三条路一条都不供 —— 这就是接线时的真实状态
  const none = NODES.evalExit(n, { statSync: () => ({ size: 10 }) })
  const evNone = (none.report || []).find((x) => x.kind === 'evidence')
  ok('★probe 不供 actions:证据闸不过(接线时的真实症状 —— requireEvidence 的节点永远过不了)',
    !!evNone && evNone.ok === false, none.report)
  // 供上执行流水(reg.actions 里一直有,只是没接过来)
  const withActs = NODES.evalExit(n, { statSync: () => ({ size: 10 }), actions: () => [{ kind: 'cmd', label: 'npm test' }] })
  const evOk = (withActs.report || []).find((x) => x.kind === 'evidence')
  ok('★probe.actions 供上 npm test:证据闸过', !!evOk && evOk.ok === true, withActs.report)
  const withBrowser = NODES.evalExit(n, { statSync: () => ({ size: 10 }), actions: () => [{ kind: 'browser', label: 'navigate' }] })
  ok('浏览器动作轨同样算证据(前端自验)', ((withBrowser.report || []).find((x) => x.kind === 'evidence') || {}).ok === true)
})

section('用例6c:done 的缺口覆盖硬校验(validate 不传 ctx 这条就是死代码)', () => {
  need(SCHEMA, 'src/orch/schema.js')
  // 必填字段一个不少:否则前两条"判不合法"会因为缺字段而通过 —— 那是因为错误的原因绿,
  // 等于没测到覆盖校验本身(弱断言比没断言更坏,它会让人以为守住了)
  const done = (gaps) => ({
    needGrounding: false, addNodes: [], dropNodes: [], done: true, more: 'no', why: '收口',
    facts: [], open: [],
    final: { summary: '干完了', deliverables: ['docs/a.md'], gaps },
  })
  const ctx = { gaps: ['n3 契约缺 createPayment'], unverified: ['n5'] }
  const miss = SCHEMA.validate('replan', done([]), ctx)
  ok('★账上有缺口却报空 gaps → 判不合法(代码保证信息不丢)', miss.ok === false, miss.errors)
  const partial = SCHEMA.validate('replan', done(['n3 契约缺 createPayment']), ctx)
  ok('★只认了一半(漏了无验证证据的 n5)→ 仍不合法', partial.ok === false, partial.errors)
  const full = SCHEMA.validate('replan', done(['n3 契约缺 createPayment', 'n5 没有验证证据']), ctx)
  ok('两条都认了 → 合法', full.ok === true, full.errors)
  // 回归护栏:不传 ctx 时这条校验恒空过 —— 正是接线时的状态,必须能一眼看出差别
  const noCtx = SCHEMA.validate('replan', done([]), undefined)
  ok('★不传 ctx:同一份输出被判合法(证明这条校验确实依赖 ctx,别再漏传)', noCtx.ok === true, noCtx.errors)
})

// ── 小结 + 退出码 ───────────────────────────────────────────────────────────
// 没有这一段的话本文件永远 exit 0 —— 断言全红也"通过",挂进 CI 等于没挂(草稿期踩到过)
if (MISSING.length) { console.log('\n模块装载失败:'); for (const m of MISSING) console.log('  ✗ ' + m) }
console.log('\n' + (fail ? '❌ ' : '✅ ') + '编排引擎自测:' + pass + ' passed, ' + fail + ' failed')
process.exit(fail || MISSING.length ? 1 : 0)
