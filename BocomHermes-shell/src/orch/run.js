'use strict'
// ══════════════════════════════════════════════════════════════════════════════
// 编排状态机(纯逻辑层)· 全案的心脏
//
// 【这一层为什么存在】
// 现状的编排控制流没有被代码持有:它被序列化成中文、用 card-inject 塞进一张 LLM 卡当成对话回合,
// 再指望模型把壳层【已经知道的账】(派了几片、齐没齐、第几轮、缺哪些签名、跑没跑测试)重记一遍。
// 59 道兜底闸里 42 道不是在纠正"模型判断错",而是在补"这件事本来就该由代码做"。
// 本层的分工铁律:
//     ★ 控制流归代码,判断归模型。代码永远不替模型做决定,模型永远不替代码记账。★
//   · 数得出来 / 查得到的(几个节点、谁完了、文件在不在、退出码多少、契约签名有没有)→ 代码,不问模型;
//   · 要权衡的(怎么拆才划算、这片失败该怎么拆更小、够不够收口、结论可不可信)→ 模型,
//     代码【不许】兜底成默认值 —— 所以本文件里找不到任何"自动补派验证棒""自动宣布收口"的分支。
//
// 【四条不变式】(applyEvent 末尾自检,invariants() 也查;违反只报 notify,不改状态、不抛)
//   1. node.state / run.phase 只在 applyEvent 里被赋值 —— 唯一写者(消掉现状 5 个竞争写者)。
//   2. 同一 (nodeId, ev.type, seq) 重复投递必须幂等 —— 【不存在"一次性标志"这种东西】。
//      现状的 orchNotified / verifyOpen / orchVerifyRetry 全部是这条被违反后长出来的补丁,
//      而"复验拿旧报文重跑机判"那个 bug 就寄生在 orchNotified 上。这里靠【状态守卫】做幂等:
//      终态节点收到重复事件直接吸收,陈旧 decisionId 直接吸收 —— 结构上不可达,不靠标志位。
//   3. run.nodes 只增不删(drop = state:'skipped' + droppedReason)—— 决策留痕不可篡改。
//   4. applyEvent 不读时钟、不碰磁盘、不碰壳层全局态;时间一律由 ev.at 传入,id 一律由 ctx.mkId 生成。
//      这是 replay 拿同一串事件重放出同一个 run 的唯一前提(scripts/orch-boundary-check.mjs 会 grep 查)。
//
// 【实测病灶,注释里点破,别再踩】
//   ★ verified → running 是【合法转移】(交棒/复活),不是需要修补的异常。现状为它长了一个一次性标志,
//     而那正是"复验用旧报文重跑机判"的寄生位置。这里它就是一行普通转移。
//   ★ 离开 running 的【每一条分支】都要发 clearTimer。漏一条,45s 落定计时器会把刚写的终态覆写回去
//     (现状 stop-all 与关卡两处都栽过这个坑:关窗写了 interrupted,计时器到点又改回 done)。
//   ★ TICK 且无 ready 无 running 无 pendingDecision 时,仍然发 decide(replan,'frontier') ——
//     代码不许替模型宣布收口。同理:预算耗尽 / invalidStreak>=3 一律去 awaiting-user,不许自动 done。
//   ★ dropNodes 只能砍【未 running】的节点 —— 在跑的砍了,工人还在烧 token,账就对不上了。
//   ★ 每个节点收官(verified / failed)都必须发一次 replan —— 这是反死板的核心,不许为省钱攒批。
//     决策在飞时不丢,进延迟槽 pendingReplan,决策一回来立刻补发。
//
// 【effects 怎么用】applyEvent 只返回意图,由 index.js 执行;执行结果作为【新事件】回灌 applyEvent。
// 本文件不做任何 IO,所以 evalExit(要读盘/跑命令)也只是一条 effect。
// effect 顺序约定:主 effect(dispatch/cancelNode/decide/evalExit/armTimer/clearTimer) → notify/archive
//                → persist → ui。没有任何状态变化时【一条 effect 都不发】(空转的 TICK 不刷盘不刷 UI)。
// ══════════════════════════════════════════════════════════════════════════════
const N = require('./nodes')
const L = require('./ledger')
const SHAPE = require('./shapes')   // 形状模板:DAG 骨架归代码(强制汇总收尾 / 拆窄了重问一次)

const PHASES = ['planning', 'awaiting-approval', 'executing', 'awaiting-user', 'suspended', 'done', 'failed', 'cancelled']
const TERMINAL_PHASES = ['done', 'failed', 'cancelled']
const NODE_STATES = ['pending', 'queued', 'running', 'settled', 'verified', 'rejected', 'failed', 'skipped', 'cancelled']
const NODE_TERMINAL = ['verified', 'failed', 'skipped', 'cancelled']
const SILENT_MS = 45 * 1000            // 轮末静默 45s 判落定(闸13 消不掉的退让:worker 层不动,"停没停"只能这么推断)。
                                       // 窗口值与探活都在执行层(index.js doArm):knobs.orchSilentSec 可放宽,到点先探活续命——纯逻辑层不管这些,它只认 TIMER 事件
const STALL_MS = 15 * 60 * 1000        // 15min 没有任何一轮 = 挂死
const MAX_DECISIONS_KEPT = 200         // 决策留痕上限(只截最老的,给用户看"它为什么这么决定")
const MAX_INVALID_STREAK = 3           // 连续拿不到合法决策 → 转人工(不是自动收口)
const MAX_PLAN_INVALID = 2             // 规划点只给两次机会:第二次仍不合法 → 三选一转人工
const MAX_IDLE_FRONTIER = 3            // 连续 N 次"无事可做且模型也没给下一步" → 转人工(反空转;出口是人,不是 done)

// ── 小工具(全部纯函数)────────────────────────────────────────────────
function str(x) { return x === null || x === undefined ? '' : String(x) }
function num(x) { const n = +x; return Number.isFinite(n) ? n : 0 }
function arr(x) { return Array.isArray(x) ? x : [] }
function posInt(x, d) { const n = Math.floor(+x); return Number.isFinite(n) && n > 0 ? n : d }
function clone(o) { return JSON.parse(JSON.stringify(o)) }   // run 恒可 JSON 序列化(它本来就要落盘);顺带保证"不原地改入参"
function findNode(r, id) { const k = str(id); return r.nodes.find((n) => n.id === k) || null }
function isTerminalPhase(p) { return TERMINAL_PHASES.indexOf(p) >= 0 }
function isTerminalNode(s) { return NODE_TERMINAL.indexOf(s) >= 0 }
function countState(r, s) { return r.nodes.filter((n) => n.state === s).length }
function firstLine(s, cap) { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > cap ? t.slice(0, cap) + '…' : t }
// id 生成:优先 ctx.mkId;缺了就用【run 内确定性计数】兜底 —— 依然可重放(不掷骰子、不读时钟)
function mk(t, prefix) {
  const f = t.cx && t.cx.mkId
  if (typeof f === 'function') return str(f(prefix)) || (prefix + (t.r.decisions.length + 1))
  return prefix + (t.r.decisions.length + 1)
}
// 计时器键恒为 runId:nodeId:kind —— 不用 wcId(钉出/重挂后 wcId 会变,旧计时器成孤儿,现状栽过)
function tkey(r, nodeId, kind) { return r.id + ':' + nodeId + ':' + kind }
// 文本清单 → 账本条目:['a'] 与 [{text,anchors}] 两种形态都收(模型两种都会给)
function toItems(x) {
  return arr(x).map((it) => (it && typeof it === 'object')
    ? { text: str(it.text || it.detail || it.title), anchors: arr(it.anchors).map(str) }
    : { text: str(it), anchors: [] }).filter((it) => it.text)
}

// ── createRun ────────────────────────────────────────────────────────
// 不产生 effects:调用方紧接着 applyEvent(RUN_START) 才起 plan 决策(创建与起跑分开,重启续接才好接)
function createRun(spec, ctx) {
  const s = spec || {}
  const cx = ctx || {}
  const at = num(cx.at)
  const b = s.budget || {}
  const maxNodes = posInt(b.maxNodes, 24)
  // ★硬约束 maxDecides >= 2*maxNodes:每个节点收官都要 replan,给少了等于把"反死板"掐死
  const maxDecides = Math.max(posInt(b.maxDecides, 48), 2 * maxNodes)
  return {
    id: str(s.id) || (typeof cx.mkId === 'function' ? str(cx.mkId('R')) : 'R-1'),
    v: 1, seq: 0,
    goal: str(s.goal), dir: str(s.dir), backendDir: str(s.backendDir),
    model: s.model || null,
    alias: str(s.alias),                       // 兼容垫片外键:pushShardProgress / orchByTag 仍按它认;【禁止参与任何判定】
    createdAt: at, updatedAt: at,
    phase: 'planning', phaseAt: at,
    panelCardId: s.panelCardId || null, panelWcId: s.panelWcId || null,
    wave: 1,
    nodes: [],
    ledger: { facts: [], open: [], assumptions: [], gaps: [] },
    decisions: [], userNotes: [],
    budget: {
      maxNodes, spawned: 0,
      maxDecides, spentDecides: 0,
      maxWallMs: posInt(b.maxWallMs, 6 * 3600e3), startedAt: at,
      invalidStreak: 0,
      resumeCredit: posInt(b.resumeCredit, 1),
      idleFrontier: 0,                         // 连续"问了 frontier 但图没变"的次数(反空转)
    },
    concurrency: posInt(s.concurrency, 4),     // 创建时快照,run 内恒定(中途改旋钮不把闸变形)
    pendingDecision: null,                     // { id, point, event, nodeId, at } —— 有在飞决策时不重复发起
    pendingReplan: null,                       // 延迟槽:决策在飞时到达的 replan 请求,决策一回来立刻补发(不是一次性标志:重复置位幂等,消费即清)
    ask: null,                                 // 模型要求问用户时的问题(askUser)
    result: { summary: '', deliverables: [], gaps: [] },
    lastError: '',
  }
}

// ── applyEvent ───────────────────────────────────────────────────────
// ★纯函数:不读时钟(时间只从 ev.at 来)、不碰磁盘、不碰壳层全局态、不掷骰子;返回新对象,不原地改 run
function applyEvent(run, ev, ctx) {
  const e = ev || {}
  const r = clone(run)
  // 终态吸收:done/failed/cancelled 的 run 收到任何事件都不变,只 persist。
  // 这是"旧报文重跑机判"在结构上不可达的一半根据(另一半是节点终态吸收)。
  if (isTerminalPhase(r.phase)) return { run: r, effects: [{ type: 'persist' }] }
  const t = { r, e, at: num(e.at), cx: ctx || {}, eff: [], changed: false }
  switch (str(e.type)) {
    case 'RUN_START': onRunStart(t); break
    case 'DECIDED': onDecided(t); break
    case 'USER_APPROVE': onUserApprove(t); break
    case 'USER_REJECT': onUserReject(t); break
    case 'USER_NOTE': onUserNote(t); break
    case 'USER_ABORT': onKill(t, '用户中止'); break
    case 'PANEL_CARD_GONE': onKill(t, '面板卡已关闭'); break
    case 'USER_RETRY': onUserRetry(t); break
    case 'USER_RESUME': onUserResume(t); break
    case 'TICK': tick(t, true); break
    case 'NODE_DISPATCHED': onNodeDispatched(t); break
    case 'WORKER_TURN_START': onTurnStart(t); break
    case 'WORKER_TURN_END': onTurnEnd(t); break
    case 'WORKER_TURN_ERROR': onTurnError(t); break
    case 'WORKER_CARD_GONE': onCardGone(t); break
    case 'TIMER': onTimer(t); break
    case 'NODE_FINDINGS': onNodeFindings(t); break
    case 'NODE_VERDICT': onNodeVerdict(t); break
    case 'EXIT_RESULT': onExitResult(t); break
    case 'BUDGET_EXCEEDED': onBudgetExceeded(t); break
    default: break                              // 不认识的事件一律吸收(老存档回放时不炸)
  }
  if (!t.changed) return { run: r, effects: t.eff }
  r.seq += 1
  r.updatedAt = t.at
  t.eff.push({ type: 'persist' }, { type: 'ui' })
  // 不变式自检:只报警不改状态、不抛 —— 状态机自己坏了要看得见,但不能因此把用户的 run 弄死。
  // ★只在【违反内容变了】时报一次。真机 2026-08-07:一个持续性的账目不一致
  //   (spawned 与节点数对不上)会在【每一个事件】上重报,几分钟刷了几十条,
  //   把面板上真正该看的通知(补了哪几片、哪道闸没过)全埋掉了 ——
  //   自检的价值在于"发生时看得见",不在于"一直喊"。喊到没人看,等于没报。
  const bad = invariants(r)
  const sig = bad.join(';')
  if (sig !== str(r.lastInvariantSig || '')) {
    r.lastInvariantSig = sig
    if (bad.length) t.eff.push({ type: 'notify', level: 'warn', text: '编排不变式违反:' + sig })
  }
  return { run: r, effects: t.eff }
}

// ── 决策发起 / 延迟槽 ────────────────────────────────────────────────
function startDecision(t, point, event, nodeId) {
  const r = t.r
  if (r.pendingDecision) { deferReplan(t, point, event, nodeId); return false }   // 有在飞决策 → 不重复发起,进延迟槽
  const breach = budgetBreach(r, t.at)
  if (breach) { toAwaitingUser(t, '预算耗尽(' + breach + ')', true); return false }   // ★不许自动收口:出口是人
  const id = mk(t, 'd')
  r.pendingDecision = { id, point, event: str(event), nodeId: str(nodeId), at: t.at }
  r.budget.spentDecides += 1
  t.eff.push({ type: 'decide', decisionId: id, point, event: str(event), nodeId: str(nodeId) })
  t.changed = true
  return true
}
// 延迟槽只收 replan:plan 一个 run 只发生一次,挤不掉。后到的覆盖先到的(都是"该重新想一下"这一件事),
// 但 nodeId 保留最先那个 —— 渲染端拿它取"本次事件",丢了就看不到是哪个节点触发的
function deferReplan(t, point, event, nodeId) {
  if (point !== 'replan') return
  const r = t.r
  if (!r.pendingReplan) r.pendingReplan = { event: str(event), nodeId: str(nodeId) }
  else r.pendingReplan = { event: str(event), nodeId: r.pendingReplan.nodeId || str(nodeId) }
  t.changed = true
}
function drainReplan(t) {
  const r = t.r
  if (!r.pendingReplan || r.pendingDecision || r.phase !== 'executing') return
  const q = r.pendingReplan
  r.pendingReplan = null
  startDecision(t, 'replan', q.event || 'frontier', q.nodeId || '')
}
// 决策失败时给用户看的那句话。★必须把【真因】摆出来,而不是一句"连续 N 次不合法"。
// 真机 2026-08-08:决策器明确报了 transport + "模型没有回话 / 输出被截断 / 余额不足",
// 而面板上只有"规划决策连续 2 次不合法,请三选一" —— 用户照着这句话完全无从下手,
// 我自己也是靠翻日志 + 拉 serve 会话才查出真因的。信息在系统里,只是没有人把它端出来。
// 【为什么要区分两类】处置完全不同:
//   transport(连不上 / 没回话 / 被中止)→ 换模型、看网关、重试有意义;
//   schemaFail(答了但格式不对)     → 才是"拆法/格式"的问题,三选一那套话术才对得上。
function decideFailWhy(r, dec, what) {
  const why = arr(dec && dec.errors).filter(Boolean).join(';')
  const tail = why ? ('\n真因:' + firstLine(why, 260)) : ''
  if (str(dec && dec.invalid) === 'transport') {
    return what + '决策没能拿到回复(连了 ' + num(r.budget.invalidStreak) + ' 次)——'
      + '这不是"拆法不对",是【压根没答上来】:多半是模型没回话、被中止、或网关/额度的问题。'
      + '先在卡片标题栏换一个模型再重试;换完还是这样就把日志里 [oc] send 那一行发出来。' + tail
  }
  if (str(dec && dec.invalid) === 'timeout') {
    return what + '决策超时(连了 ' + num(r.budget.invalidStreak) + ' 次)—— 模型一直没收官。'
      + '内网慢模型可以再等一次;反复超时就换个模型。' + tail
  }
  return what + '决策连续 ' + num(r.budget.invalidStreak) + ' 次不合法(答了,但格式/内容过不了校验),'
    + '请三选一:按单工作流直接干 / 重试 / 我自己填节点' + tail
}

function budgetBreach(r, at) {
  const b = r.budget
  if (b.spentDecides >= b.maxDecides) return '决策次数 ' + b.spentDecides + '/' + b.maxDecides
  if (b.maxWallMs > 0 && b.startedAt > 0 && at - b.startedAt > b.maxWallMs) return '总时长超过 ' + Math.round(b.maxWallMs / 60000) + ' 分钟'
  return ''
}
// 转人工:预算耗尽 / 连续不合法 / 连续空转 的唯一出口。★永远不是 done —— 收口只能由模型宣布
function toAwaitingUser(t, why, cancelRunning) {
  const r = t.r
  if (cancelRunning) for (const n of r.nodes) if (n.state === 'running') cancelNode(t, n, why)
  r.phase = 'awaiting-user'; r.phaseAt = t.at; r.lastError = str(why)
  t.eff.push({ type: 'notify', level: 'warn', text: '编排转人工:' + str(why) })
  t.changed = true
}
// 关掉一个节点的卡。★离开 running 的每一条分支都要清计时器,否则 45s 后它把终态覆写回去
function cancelNode(t, n, why) {
  const wasRunning = n.state === 'running' || n.state === 'queued'
  n.state = 'cancelled'
  if (!n.settledAt) n.settledAt = t.at
  if (!n.reason) n.reason = 'aborted'
  t.eff.push({ type: 'cancelNode', nodeId: n.id, why: str(why) })
  if (wasRunning) clearNodeTimers(t, n)
  t.changed = true
}
function clearNodeTimers(t, n) {
  t.eff.push({ type: 'clearTimer', key: tkey(t.r, n.id, 'silent') }, { type: 'clearTimer', key: tkey(t.r, n.id, 'stall') })
}

// ── RUN_START ────────────────────────────────────────────────────────
function onRunStart(t) {
  const r = t.r
  if (r.phase !== 'planning' || r.pendingDecision) return   // 重复投递吸收
  startDecision(t, 'plan', 'run-start', '')
}

// ── DECIDED ──────────────────────────────────────────────────────────
function onDecided(t) {
  const r = t.r, e = t.e
  const pd = r.pendingDecision
  // ★幂等:陈旧 / 重复 decisionId 一律吸收。决策器超时后迟到的回包不许再动状态机
  if (!pd || !e.decisionId || pd.id !== str(e.decisionId)) return
  r.pendingDecision = null
  t.changed = true
  const data = (e.data && typeof e.data === 'object') ? e.data : {}
  const dec = {
    id: pd.id, at: t.at, point: pd.point, event: pd.event, nodeId: pd.nodeId,
    ok: !!e.ok, invalid: str(e.invalid), why: str(data.why), raw: '',
    // ★把决策器报的【真因】留在留痕里。原来只留 invalid('transport'/'schemaFail'),
    //   errors 直接丢掉 —— 于是面板上永远只有一句"决策连续 2 次不合法",
    //   而真因("模型没有回话"/"输出被截断"/"余额不足")一个字都看不到。
    //   真机 2026-08-08:decide 明确报了 transport + 原文,面板还是那句不合法,查了半天。
    errors: arr(e.errors).map((x) => firstLine(x, 300)).slice(0, 3),
  }
  r.decisions.push(dec)
  if (r.decisions.length > MAX_DECISIONS_KEPT) r.decisions.splice(0, r.decisions.length - MAX_DECISIONS_KEPT)
  // 用户插话消费登记:只认【本次决策发起之前】进来的那些 —— 发起之后到的没进渲染,不能算它看过(永不丢的另一半)
  for (const nt of r.userNotes) if (!nt.consumedBy && num(nt.at) <= num(pd.at)) nt.consumedBy = pd.id
  if (pd.point === 'plan') onPlanDecided(t, dec, data)
  else onReplanDecided(t, dec, data)
  drainReplan(t)   // 在飞期间被挤掉的 replan,现在补发(★每节点必调,不许丢)
}

function onPlanDecided(t, dec, data) {
  const r = t.r
  if (!dec.ok) {
    r.budget.invalidStreak += 1
    // 三选一转人工,【绝不静默兜底成默认拆法】—— 拆法是模型的判断,代码没有资格代劳
    if (r.budget.invalidStreak >= MAX_PLAN_INVALID) toAwaitingUser(t, decideFailWhy(r, dec, '规划'), false)
    else startDecision(t, 'plan', 'plan-invalid', '')
    return
  }
  r.budget.invalidStreak = 0
  r.budget.lastInvalid = []   // 这一版合法了:上次的错不能再跟着走,否则下一轮重问会拿陈年旧错误导模型
  r.ledger = L.addOpen(r.ledger, toItems(data.open), 'plan', t.at)
  let specs = arr(data.nodes)
  // ★"我得先看代码才能拆" = 一个【完整的判断】,不是半截答案 —— 代码替它开一个勘察节点。
  //   真机实测 2026-08-07:模型连着两轮只置 needGrounding:true、不写节点,直接顶到转人工。
  //   "要不要先勘察"归模型,"把这个判断写成一个 probe 节点"归代码 —— 后者是机械转换,
  //   压给模型就是让它替代码做格式化,而弱模型恰恰在格式化上最不可靠(与发现/判决同一个道理)。
  if (!specs.length && data.needGrounding === true) {
    specs = [SHAPE.makeGroundingSpec(r, arr(data.open))]
    t.eff.push({ type: 'notify', level: 'info', text: '规划器说"得先看代码才能拆" —— 已替它开一个勘察节点,跑完会再问一次怎么拆' })
  }
  if (!specs.length) {
    if (str(data.more) === 'no') {
      // ★"不值得拆"对【该拆宽的目标】也要打回问一次 —— 这条 early return 排在下面的宽度检查之前,
      //   于是模型只要说一句"不值得拆",拆宽的强制就完全够不到(真机第一轮就撞上了)。
      //   探索/排查/成文类目标上,"一个节点就够"通常是判断失误而不是任务真的小;但也可能是真的不该拆
      //   (比如目标里的东西根本不在当前工作目录 —— 实测遇到过),所以只问一次,它坚持就认。
      if (SHAPE.isWideGoal(r.goal) && !r.budget.shapeReasked) {
        r.budget.shapeReasked = 1
        t.eff.push({ type: 'notify', level: 'info', text: '模型说不值得拆,但这是个该拆宽的目标 —— 再问一次(它坚持就按它的来)' })
        startDecision(t, 'plan', 'too-narrow', '')
        return
      }
      // 模型判定"不值得拆":这是它的合法答案,直接收口(index.js 会顺手派一张普通工作流卡把活干了)
      r.phase = 'done'; r.phaseAt = t.at
      r.result = { summary: str(data.why) || '模型判定这个目标不值得拆成多个节点', deliverables: [], gaps: [] }
      t.eff.push({ type: 'notify', level: 'info', text: '模型判定不值得拆:' + (str(data.why) || '按单工作流直接干即可') }, { type: 'archive' })
      return
    }
    // nodes=0 且 more!=='no' —— 它自己也没想好。代码不替它选,转人工
    toAwaitingUser(t, '模型没有给出任何节点,也没说不值得拆 —— 需要你指一条路', false)
    return
  }
  const v = N.validateNodeSpecs(specs, r, t.cx)
  const made = arr(v && v.nodes)
  if (!made.length) {
    r.budget.invalidStreak += 1
    // ★把校验器报的错留下来,重问时带回去。原来这里起的是一次【全新决策】(新会话、无上下文),
    //   而 renderPlan 只对 too-narrow 加硬约束 —— plan-invalid 没有分支,于是第二次的提示词与第一次
    //   【逐字节相同】,模型当然原样再犯一次,两次撞完直接顶到转人工。
    //   render.js 自己写着"重问必须带硬约束,不然模型多半原样再给一遍",这条原则漏在了 plan-invalid 上。
    //   错由代码搬运、模型只负责改 —— 这正是"控制流归代码"。
    r.budget.lastInvalid = arr(v && v.errors).slice(0, 3).map((x) => str(x).slice(0, 200))
    if (r.budget.invalidStreak >= MAX_PLAN_INVALID) toAwaitingUser(t, '规划节点全部校验不过:' + arr(v && v.errors).join(';'), false)
    else startDecision(t, 'plan', 'plan-invalid', '')
    return
  }
  addNodes(t, made, 'plan', 1)
  if (v && v.truncated) t.eff.push({ type: 'notify', level: 'warn', text: '节点数超出预算,已截断到 ' + r.budget.maxNodes + ' 个' })
  if (v && arr(v.errors).length) t.eff.push({ type: 'notify', level: 'warn', text: '部分节点被校验丢弃:' + arr(v.errors).slice(0, 3).join(';') })
  // ★拆窄了就重问一次(只一次)。判据看的是【能并行的片数】而不是总片数 —— 串成一条链的 5 个节点,
  //   并发位照样空着。重问不消耗 attempt,只花一次 decide 预算;第二次还是窄就认了,不跟模型死磕。
  const narrow = SHAPE.tooNarrow(r, made)
  if (narrow && !r.budget.shapeReasked) {
    r.budget.shapeReasked = 1
    // ★作废这一批的同时把 spawned 退回去 —— addNodes 已经把它们计进预算了,
    //   只删节点不退账,预算就凭空少一批(真机 2026-08-07:8 个节点全撤,spawned 还是 8,
    //   不变式当场报"spawned(8)与节点数(0)对不上")。重问几次就能把 maxNodes 烧穿,
    //   而那时一个节点都还没派出去 —— 最坏的一种预算泄漏:花掉了却什么都没换来。
    const before = arr(r.nodes).length
    for (const n of arr(r.nodes)) if (n.origin === 'plan' && n.state === 'pending') n.state = 'dropped'   // 这批作废,重来
    r.nodes = arr(r.nodes).filter((n) => n.state !== 'dropped')
    r.budget.spawned = Math.max(0, num(r.budget.spawned) - (before - arr(r.nodes).length))
    t.eff.push({ type: 'notify', level: 'info', text: '只拆出 ' + narrow.parallel + ' 片能并行(这个目标有 ' + narrow.cap + ' 个面)—— 让规划器按视角再拆一次' })
    startDecision(t, 'plan', 'too-narrow', '')
    return
  }
  shapeWiden(t)                       // 宽度:重问过一次还是窄 → 代码按视角铺齐(必须在 shapeReduce 之前:补出来的片也要进汇总)
  shapeReduce(t)                      // 汇总收尾:模型没给就代码补
  shapeAudit(t)                       // ★验收必须【独立】挂 —— 见 shapeAudit 注释:原来只挂在"代码补了汇总"那条分支上
  r.phase = 'awaiting-approval'; r.phaseAt = t.at
}

function onReplanDecided(t, dec, data) {
  const r = t.r
  if (!dec.ok) {
    r.budget.invalidStreak += 1
    if (r.budget.invalidStreak >= MAX_INVALID_STREAK) { toAwaitingUser(t, decideFailWhy(r, dec, '重规划'), true); return }
    tick(t, false)   // 降级梯第 3 级:确定性兜底 = 不改图、继续跑。不凭空造节点,也不卡住
    return
  }
  r.budget.invalidStreak = 0
  const src = dec.nodeId || 'plan'
  r.ledger = L.addFacts(r.ledger, toItems(data.facts), src, t.at)
  r.ledger = L.addOpen(r.ledger, toItems(data.open), src, t.at)
  if (arr(data.resolvedOpen).length) r.ledger = L.resolveOpen(r.ledger, arr(data.resolvedOpen).map(str))   // 模型明说某条已解决(可选字段)
  // USER_REJECT 之后的重规划:方案改了要重新过人审闸,不许直接开跑
  if (r.phase === 'planning') {
    const mg = mergeGraph(t, data)
    // ★★【别把残骸当方案端给人批准】(真机 2026-08-08,用户当场看出来:"这个拆的有问题")
    // 原判据是 `added || 还有非终结节点` —— 问的是"有没有加进来东西",不是"盘上还是不是一版方案"。
    // 现场:模型提了 14 片,校验丢掉 13 片、只剩唯一没有依赖的那片勘察 → added=true → 直接
    // awaiting-approval,面板写着「方案已出(11 个节点)—— 看一眼,没问题就开跑」,其实是 10 跳过 + 1 待办。
    // 这是本轮第六次撞见同一个形态:检查在、注释也对,但判据太松,永远不会响。
    // 丢过半就带着【校验器的原话】重问一次(render 的 addnodes-lost 分支会把错摆给它),
    // 重问也不行才转人工 —— 出口始终是人,代码不替它编一版方案。
    const lost = num(mg.proposed) - num(mg.kept)
    if (num(mg.proposed) >= 2 && lost * 2 >= num(mg.proposed)) {
      r.budget.lastInvalid = arr(mg.errors).slice(0, 3).map((x) => str(x).slice(0, 200))
      // ★必须用【自己的】计数器,不能借 invalidStreak:本函数开头刚把它清零了(这一版格式是合法的,
      //   只是拆出来的图不可用)—— 借用的后果是计数永远从 0 起,重问无限循环。自测当场抓到。
      r.budget.lostStreak = num(r.budget.lostStreak) + 1
      const say = '重建的 ' + mg.proposed + ' 片里有 ' + lost + ' 片没通过校验,剩下的不成一版方案'
      if (r.budget.lostStreak >= MAX_PLAN_INVALID) { toAwaitingUser(t, say + ' —— 需要你指一条路:' + arr(mg.errors).slice(0, 2).join(';'), false); return }
      t.eff.push({ type: 'notify', level: 'warn', text: say + ' —— 已带着校验器的原话重问一次' })
      startDecision(t, 'replan', 'addnodes-lost', '')
      return
    }
    r.budget.lostStreak = 0   // 这一版拿得出手:清零,否则陈年旧账会让下一次重建一进门就转人工
    if (mg.changed || r.nodes.some((n) => !isTerminalNode(n.state))) { r.phase = 'awaiting-approval'; r.phaseAt = t.at }
    else toAwaitingUser(t, '重规划没有给出任何可执行节点 —— 需要你指一条路', false)
    return
  }
  if (data.askUser) {
    const q = (typeof data.askUser === 'object') ? data.askUser : { question: str(data.askUser) }
    r.ask = { question: str(q.question), options: arr(q.options).map(str), at: t.at }
    r.phase = 'awaiting-user'; r.phaseAt = t.at
    t.eff.push({ type: 'notify', level: 'info', text: '编排在等你回答:' + firstLine(r.ask.question, 60) })
    return
  }
  if (data.done === true) {
    const running = countState(r, 'running') + countState(r, 'settled')
    if (running > 0) {
      // 契约要求"无 running 才收口"。还有在跑的就不收 —— 也不替它记账:等那些节点收官时自然会再问一次
      dec.why = (dec.why ? dec.why + ' ' : '') + '(还有 ' + running + ' 个节点未落定,收口意见暂不生效)'
      t.eff.push({ type: 'notify', level: 'info', text: '模型想收口,但还有节点在跑 —— 等它们落定后会再问一次' })
      tick(t, false)
      return
    }
    // ★收口闸:模型说"够了"不等于真的够了。这里只查【代码查得出来】的三件事,
    //   查出来就当场补活并驳回这次收口 —— 不是跟模型辩论,是把它没看见的活摆出来。
    const dry = dryGate(t)
    if (dry) {
      dec.why = (dec.why ? dec.why + ' ' : '') + '(壳层驳回收口:' + dry + ')'
      r.budget.doneBlocked = num(r.budget.doneBlocked) + 1
      t.eff.push({ type: 'notify', level: 'info', text: '模型想收口,但' + dry + ' —— 已补上,跑完会再问一次' })
      tick(t, false)
      return
    }
    const fin = (data.final && typeof data.final === 'object') ? data.final : {}
    r.result = {
      summary: str(fin.summary) || str(data.why),
      deliverables: arr(fin.deliverables).map(str),
      gaps: arr(fin.gaps).map((g) => (g && typeof g === 'object') ? str(g.text || g.detail) : str(g)).filter(Boolean),
    }
    for (const n of r.nodes) if (!isTerminalNode(n.state)) cancelNode(t, n, '编排已收口')
    r.phase = 'done'; r.phaseAt = t.at
    t.eff.push({ type: 'notify', level: 'info', text: '编排收口:' + firstLine(r.result.summary, 60) }, { type: 'archive' })
    return
  }
  const changedGraph = mergeGraph(t, data).changed
  // ★宽度在 replan 也要判。原来两个调用点都在 onPlanDecided —— 第一波之后就再没人管过宽度,
  //   而 probe 跑完那次 replan 恰恰是最该拆宽的时刻(现在才真正知道里面长什么样),实测常常缩回 1~2 片。
  const widened = shapeWiden(t)
  const reduced = shapeReduce(t)      // 顺序:先补宽再挂汇总,汇总的 deps 才吃得到补出来的片
  const audited = shapeAudit(t)       // ★再挂验收(要先有汇总才挂得上)
  const linked = extendReduceDeps(t)  // 汇总早就挂上了、后来又多出产出片 → 把新的接进它的 deps
  // ★反空转:frontier 问了一圈图还是没动 —— 计数,连着 N 次就转人工(出口是人,不是代码宣布 done)
  //   代码补宽/挂汇总也算"图动了":这一轮确实多出了活,不该记进空转账
  const moved = changedGraph || widened || reduced || audited || linked
  if (dec.event === 'frontier' && !moved) r.budget.idleFrontier += 1
  else if (moved) r.budget.idleFrontier = 0
  tick(t, false)   // 内部 tick 只派发,不发起 frontier 决策 —— 否则"空 replan → 立刻再问"会自我循环烧预算
}

// 合并 addNodes / dropNodes;返回图有没有真的变
function mergeGraph(t, data) {
  const r = t.r
  let changedGraph = false
  const drops = arr(data.dropNodes)
  for (const d of drops) {
    const id = (d && typeof d === 'object') ? str(d.id) : str(d)
    const n = findNode(r, id)
    // ★只有未 running 的能被砍:在跑的砍了,工人还在烧 token,账就对不上
    if (!n || (n.state !== 'pending' && n.state !== 'queued')) continue
    n.state = 'skipped'
    n.droppedReason = ((d && typeof d === 'object') ? str(d.why) : '') || '被重规划撤掉'
    // ★撤掉一个【从没派出去】的片,不该继续占着预算额度 —— 见 budgetRoom:退款走
    //   "还放得下几片"那个算式(N.freedNodes),不动 spawned。
    //   spawned 的语义是【造过多少个节点对象】(不变式 spawned === nodes.length 就是这么写的),
    //   直接减它会当场把不变式打翻 —— 我第一版就是这么写的,自测立刻报"spawned(1)与节点数(5)对不上"。
    changedGraph = true; t.changed = true
  }
  const specs = arr(data.addNodes)
  let proposed = 0, kept = 0, lostErrs = []
  if (specs.length) {
    const v = N.validateNodeSpecs(specs, r, t.cx)
    const made = arr(v && v.nodes)
    proposed = num(v && v.proposed, specs.length); kept = made.length; lostErrs = arr(v && v.errors)
    if (made.length) {
      // 波次:图长了一轮(反死板的可观测指标)。posInt 兜底不是洁癖 —— 老版本落盘的 run.json 没有 wave 字段,
      // 直接 `+= 1` 会得到 NaN,序列化成 null,面板上"第几波"整列变空,而这正是验收小批 replan 的那个数
      r.wave = posInt(r.wave, 1) + 1
      addNodes(t, made, 'replan', r.wave)
      changedGraph = true
      // ★汇总兜底原来挂在这里,现在挪到 onReplanDecided 里 mergeGraph 之【后】——
      //   补宽(shapeWiden)必须先跑完,汇总才能把补出来的视角片一并纳入 deps;
      //   顺序反了的话汇总的 deps 里没有它们,那几片写的文档就【没人读】,等于白跑。
    }
    if (v && v.truncated) t.eff.push({ type: 'notify', level: 'warn', text: '新增节点超出预算,已截断(' + specs.length + ' 片 → 只放得下 ' + budgetRoom(r) + ' 片)' })
    if (v && arr(v.errors).length) t.eff.push({ type: 'notify', level: 'warn', text: '部分新增节点被校验丢弃(' + proposed + ' 片里留下 ' + kept + ' 片):' + arr(v.errors).slice(0, 3).join(';') })
    // 代码替模型改了图,就必须说出来 —— 静默改接和静默丢弃一样,都会让面板上的方案与模型的意图不符
    if (v && arr(v.remapped).length) t.eff.push({ type: 'notify', level: 'info', text: '整版重建:' + arr(v.remapped).length + ' 条依赖原本指着已撤掉的旧片,已改接到本批重建的同名片' })
  }
  return { changed: changedGraph, proposed, kept, errors: lostErrs }
}

// 节点入图:nodes.js 已经校验过字段,这里只补状态机自己的那几格(不覆盖它已给的值)
// ── 形状兜底:汇总收尾 ────────────────────────────────────────────────────
// 探索/调研/成文类目标,只要有 ≥2 片各自产文件而全图没有 reduce,就由代码补一个 ——
// 否则交付是 N 篇互不知道对方存在的散装文档(实测症状)。模型自己给了 reduce 就不补。
// 造出来的是 spec,照样走 N.validateNodeSpecs 同一条校验,不绕过不变量。
// 还能开几个节点。★必须与 nodes.js validateNodeSpecs 用【同一本账】——
// 那边是 maxNodes - budget.spawned,而形状兜底原来各自写成 maxNodes - nodes.length。
// 两本账的后果(真机 2026-08-07 抓到):shapeVerifyFindings 按自己那本算出 room=10、
// 打算给 4 条发现各派核实员,validateNodeSpecs 按真账 room=2 静默截断到 2 个,
// 而通知照旧说「报了 4 条发现 → 已【逐条】派新眼睛去核」—— 3 条发现一个人都没派,没有任何提示。
// (spawned 与 nodes.length 会分叉:打回重问撤掉的那批、被丢弃的规格,都只减节点不减 spawned。)
// ★算式本体搬到 nodes.js 的 roomFor —— 这里只转发。
//   原来这一行是"maxNodes - spawned"的第二份拷贝,而 2026-08-08 要给"撤掉但从没派出去的片"退额度,
//   两份拷贝就意味着要改两处、漏一处就又是一次分叉(f2379a7 那次的代价:发现 4 条只核了 1 条)。
function budgetRoom(r) { return N.roomFor(r) }

// ── 收口闸:说"够了"之前,代码先查三件它可能没看见的事 ──────────────────────
// 【为什么需要】CC 那种彻底靠的是 loop-until-dry:连续几轮没有新东西才停。这套原来没有 ——
// 模型一句 done:true 就收口,而弱模型在"还要不要继续"上和"要不要多拆"一样,永远倾向于早收。
// 但纯粹"再问一次"没有信息量(它上一轮就是这么想的),所以这里只查【代码查得出来】的缺口,
// 查出来就【当场补活】再驳回 —— 摆出没干完的活,比跟它辩论有用。
// 三件事都是可判定的,不掺"你觉得够不够":
//   ① 上报了发现却没人核 —— 那些结论一条都没被验证过就进交付,是这套编排最不该出的错;
//   ② 视角没铺满且预算还有 —— 说明覆盖面本来就没到位(shapeWiden 会真的补上);
//   ③ 有产出片没进汇总 deps —— 汇总读不到它们,那几片白跑(extendReduceDeps 会接上)。
// 【一定要能收口】连着驳回 MAX_DONE_BLOCK 次就不再拦:出口必须存在,否则就成了新的死锁 ——
// 这套编排里每一道强制都配了这样一个让步,原因见 too-narrow 那条(硬事实不该被代码硬掰)。
const MAX_DONE_BLOCK = 2

function dryGate(t) {
  const r = t.r
  if (num(r.budget.doneBlocked) >= MAX_DONE_BLOCK) return ''      // 让步:拦够两次就放行
  // ① 上报了但没人核的发现。
  // ★按【条】判,不是按【片】判(真机 2026-08-07):findingsVerified 只问"这一片有没有派过核实员",
  //   而 n14 报了 4 条、只核了 1 条(预算被截断),它挂着 n38/n39 → 判成"已覆盖" → 放行收口,
  //   final.gaps 报 0 条缺口。又是"覆盖 vs 存在"的混淆 —— 与那条撒谎的通知是同一个思维错误。
  const covered = new Set(arr(r.nodes).map((n) => str(n && n.findingKey)).filter(Boolean))
  const naked = []
  for (const n of arr(r.nodes)) {
    if (!n || str(n.kind) === 'verify') continue
    const fs3 = arr(n.result && n.result.findings)
    if (!fs3.length) continue
    if (fs3.every((f) => covered.has(SHAPE.findingKey(f)))) continue   // 每一条都有人核了才算过
    naked.push(n)
  }
  for (const n of naked) if (shapeVerifyFindings(t, n)) return '有发现还没人核实过(按条查,不是按片查)'
  // ② 视角没铺满(shapeWiden 自己判预算与去重,补不动就返回 false)
  if (shapeWiden(t)) return '覆盖面还没铺满(这类目标该看的面还有没看的)'
  // ③ 有产出片没进汇总
  if (shapeReduce(t) || extendReduceDeps(t)) return '还有产出没进汇总(汇总读不到它们,那几片等于白跑)'
  // ③b 汇总没人复核:这道闸原来【压根不在收口闸里】,而"写汇总的自己评自己"是最不该放过去的一种
  if (shapeAudit(t)) return '汇总还没人复核(让写它的自己评自己等于没评)'
  // ④ 桌面还没收拾:一堆中间文件散在项目里,没人归档
  if (shapeArchive(t)) return '还有一堆中间文件散在项目里(先收进归档目录,只留最终交付)'
  return ''
}

// ── 形状兜底:收尾归档 ──────────────────────────────────────────────────────
// 真机 2026-08-07:一次编排在项目 docs/ 下留了 44 个文件、653KB,其中 36 个是工人的草稿,
// 最终文档只占 8%。用户第一句话是"40个文件,就没有一个 agent 进行整理归档的吗?"——
// 问得对:整个编排【没有收尾这一层】。CC 那种"跑完桌面是干净的"不是模型自觉,是脚本里有这一步。
function shapeArchive(t) {
  const r = t.r
  const info = SHAPE.needsArchive(r)
  if (!info) return false
  if (budgetRoom(r) <= 0) {
    t.eff.push({ type: 'notify', level: 'warn', text: '项目里散着 ' + info.scratch.length + ' 个中间文件没人收,但节点预算已满 —— 收口后请自己清理' })
    return false
  }
  const v = N.validateNodeSpecs([SHAPE.makeArchiveSpec(r, info)], r, t.cx)
  const made = arr(v && v.nodes)
  if (!made.length) {
    t.eff.push({ type: 'notify', level: 'warn', text: '想补一个收尾归档片,但没通过校验:' + arr(v && v.errors).slice(0, 2).join(';') })
    return false
  }
  r.wave = posInt(r.wave, 1) + 1
  addNodes(t, made, 'shape', r.wave)
  t.eff.push({ type: 'notify', level: 'info', text: '已自动补一个收尾归档片:把 ' + info.scratch.length + ' 个中间文件收进归档目录,顶层只留最终交付' })
  return true
}

// ── 形状兜底:按视角补宽 ────────────────────────────────────────────────────
// 【为什么这一条必须由代码造节点,而不是再劝模型一次】
// 全仓的形状兜底里,汇总节点代码自己造、验收节点自己造、按发现扇出也是代码自己造 ——
// 唯独【宽度】原来只会"再问模型一次",问完还是窄就认了。而 CC 的宽度恰恰是脚本里写死的数组:
// 模型【没有"要不要拆"的投票权】,只负责填每片内容。弱模型在"要不要多拆"上永远倾向少拆
// (少拆看起来更稳),靠提示词劝不动 —— 真机实测重问一次照旧只给两片。
//
// 分工:tooNarrow 先给模型一次机会(它更懂这个项目,自己拆的视角通常更贴切);
//       本函数是问完仍不够时的兜底 —— 代码直接铺,不再商量。
// 自终止:needsWiden 按 lensKey 去重,视角铺完就返回 null,不会越补越多。
function shapeWiden(t) {
  const r = t.r
  // 给汇总 + 验收留 2 个位:补宽把预算占满,收尾就没位置了 —— 那等于用宽度换掉了交付
  const room = budgetRoom(r) - 2   // 留 2 个位给汇总 + 验收:补宽把预算占满,收尾就没位置了
  const w = SHAPE.needsWiden(r, room)
  if (!w) return false
  const specs = arr(w.lenses).map((l) => SHAPE.makeLensSpec(r, l, w.shape))
  const v = N.validateNodeSpecs(specs, r, t.cx)
  const made = arr(v && v.nodes)
  if (!made.length) {
    // 多半是写归属跟已有节点撞了(比如模型某片声明了整个 docs/)。这条路走不通要出声 ——
    // 静默返回等于"宽度强制存在但从没生效",正是这次要修的那类病
    t.eff.push({ type: 'notify', level: 'warn', text: '想补 ' + w.lenses.length + ' 个视角片补宽,但都没通过校验:' + arr(v && v.errors).slice(0, 2).join(';') })
    return false
  }
  addNodes(t, made, 'shape', posInt(r.wave, 1))
  t.eff.push({ type: 'notify', level: 'info', text: '只有 ' + w.have + ' 片能并行(这个目标有 ' + w.want + ' 个面)—— 代码已按视角补上 ' + made.length + ' 片:' + w.lenses.map((l) => l.name).join('、') })
  return true
}

// ── 形状兜底:把后来多出的产出片接进汇总 ────────────────────────────────────
// needsReduce 见到图里已有 reduce 就返回 null,于是【汇总一旦挂上,deps 就冻住了】。
// 而扇出是分波的:勘察→铺宽→按发现核实,后面几波产出的文档全都不在汇总的 deps 里 ——
// 汇总看不见它们(composeNodeBrief 的【上游已查明】是按 deps 列的),那几片等于白跑。
// 交付质量差的一条隐形成因。只对【还没开跑】的汇总接线:已经在跑的改 deps 没有意义。
function extendReduceDeps(t) {
  const r = t.r
  const red = arr(r.nodes).find((n) => n && str(n.kind) === 'reduce' && (n.state === 'pending' || n.state === 'queued'))
  if (!red) return false
  const have = new Set(arr(red.deps).map(str))
  const add = SHAPE.producers(r.nodes).filter((n) => str(n.id) !== str(red.id) && !have.has(str(n.id)))
  if (!add.length) return false
  red.deps = arr(red.deps).map(str).concat(add.map((n) => str(n.id)))
  // goal 正文里列着"要汇总哪几片",不一起更新的话工人只会去读老的那几份 —— deps 与正文是同一件事的两面
  const spec = SHAPE.makeReduceSpec(r, SHAPE.producers(r.nodes).filter((n) => str(n.id) !== str(red.id)))
  if (spec && spec.goal) red.goal = str(spec.goal)
  t.changed = true
  t.eff.push({ type: 'notify', level: 'info', text: '汇总节点已接上后来新增的 ' + add.length + ' 份产出(否则它读不到这几片)' })
  return true
}

function shapeReduce(t) {
  const r = t.r
  const targets = SHAPE.needsReduce(r)
  if (!targets) return false
  const v = N.validateNodeSpecs([SHAPE.makeReduceSpec(r, targets)], r, t.cx)
  const made = arr(v && v.nodes)
  if (!made.length) return false
  addNodes(t, made, 'shape', posInt(r.wave, 1))
  t.eff.push({ type: 'notify', level: 'info', text: '已自动补一个汇总节点收尾(' + targets.length + ' 片产出合成一份文档)—— 规划里没有它,散着交等于没交' })
  // ★验收【不】在这里挂 —— 挂在这里就等于"只有代码补了汇总才有人复核"(见 shapeAudit 注释)。
  //   现在由三个调用点各自独立调 shapeAudit;needsAudit 本身幂等,重复调不会多挂。
  return true
}

// ── 形状兜底:按发现扇出 ──────────────────────────────────────────────────
// 工人在终答里给了 <发现> 块 → 每条派一个廉价的 verify 节点去核。
// 为什么由代码扇出而不是交给 replan:replan 每次只看得到一段摘要,漏一条不会有人发现;
// 代码按条扇出,"每条发现都被独立核过"才成为一个可验证的性质,而不是一句承诺。
// 只在节点【通过退出检查】时扇出:没通过的那片本身还要重做,它报的发现先不算数。
// ── 结构化发现上报 ────────────────────────────────────────────────────────
// 工人调 MCP 工具 report_findings → relay → index.js → 本事件。存到节点上,收官时按条扇出。
// 【为什么不直接在收官时读正文】正文里的 <发现> 块是个【格式约定】,弱模型漏格式是常态,
// 而漏了之后壳层看到的是"这片没查出问题",与"这片真的没问题"长得一模一样 —— 静默失败。
// 工具调用则参数不合规当场能退回重填。正文那条保留为降级路径(见 shapeVerifyFindings)。
function onNodeFindings(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n) return
  const fs2 = SHAPE.normFindings(arr(t.e.findings))
  if (!fs2.length) return
  // 同一节点多次上报要【累加】而不是覆盖:工人可能查一段报一段(而且重跑时也会再报一遍)。
  // 累加后按去重键收敛,免得同一条被自己重复上报撑爆条数上限。
  const merged = arr(n.result.findings).concat(fs2)
  const seen = new Set()
  n.result.findings = merged.filter((f) => {
    const k = SHAPE.findingKey(f)
    if (!k || seen.has(k)) return false
    seen.add(k); return true
  }).slice(0, SHAPE.MAX_FINDINGS)
  t.changed = true
}

// 核实员调 MCP 工具 report_verdict 上报判决 → relay → 这里。
// 判决必须【在收官之前】就落到节点上:evalExit 读的是 n.result,不是当时的消息流。
function onNodeVerdict(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n) return
  const v = str(t.e.verdict).toUpperCase()
  if (['PASS', 'FAIL', 'PARTIAL'].indexOf(v) < 0) return
  n.result.verdict = v
  n.result.verdictSrc = 'tool'
  t.changed = true
}

function shapeVerifyFindings(t, n) {
  const r = t.r
  if (str(n.kind) === 'verify') return false                 // 核实员自己报的发现不再往下派(不然会无限套娃)
  // ★这里原来有一句 `if (findingsVerified(r, n.id)) return false`(按【片】去重:这片派过就不再派)。
  //   它把"补派没核到的那几条"也一起挡死了 —— 真机 2026-08-07:n14 报 4 条、只核了 1 条(预算截断),
  //   而这片"派过了",于是剩下 3 条永远补不上,收口闸查出来也补不动。
  //   真正的去重是【按条】的(dedupeFindings 按 findingKey),它天然满足"重跑不重复派",
  //   而且比按片精确。两套去重并存时,粗的那套会把细的那套架空。
  // ★结构化优先:工具报过就【只认工具那份】—— 两条都认等于同一件事两份账本,还会互相重复
  const structured = arr(n.result && n.result.findings)
  const raw = structured.length ? structured : SHAPE.parseFindings(str(n.result && n.result.final))
  if (!raw.length) return false
  // 跨片去重:两片查到同一处、说法几乎一样 → 只核一次(原来各报各的,同一件事派两个校验)
  const fs2 = SHAPE.dedupeFindings(r, raw, n.id)   // 排除源节点自己:要扇出的正是它报的那批
  if (!fs2.length) {
    t.eff.push({ type: 'notify', level: 'info', text: '「' + str(n.title || n.id) + '」报的 ' + raw.length + ' 条发现别的片已经在核了,不重复派' })
    return false
  }
  const room = budgetRoom(r)   // 预算不够就少派几条,不硬挤(口径与 validateNodeSpecs 同源)
  if (room <= 0) { t.eff.push({ type: 'notify', level: 'warn', text: '「' + str(n.title || n.id) + '」报了 ' + fs2.length + ' 条发现,但节点预算已满 —— 这些结论没人复核,收口时请自己看' }); return false }
  const use = fs2.slice(0, Math.min(fs2.length, room))
  // 高严重度的一条派两个核实员,各走【互不重叠】的路子(证伪 / 可复现)——
  // 同一个人问两遍等于问一遍;两条路才是两票。room 不够时自动降回一票,不硬挤。
  const specs = []
  for (let i = 0; i < use.length; i++) {
    const left = room - specs.length
    if (left <= 0) break
    for (const lens of SHAPE.verifyLensesFor(use[i], left)) specs.push(SHAPE.makeFindingVerifySpec(r, n, use[i], i, lens))
  }
  const v = N.validateNodeSpecs(specs, r, t.cx)
  const made = arr(v && v.nodes)
  if (!made.length) return false
  r.wave = posInt(r.wave, 1) + 1
  addNodes(t, made, 'shape', r.wave)
  // ★按【真的入图了几个】说话,不按【打算派几个】。made 可能比 specs 少:
  //   validateNodeSpecs 会按真预算截断(truncated),也会丢掉校验不过的规格。
  //   原来这里报的是 use.length(意图),于是"3 条发现一个人都没派"被说成"已逐条派新眼睛去核"。
  const covered = new Set(made.map((x) => str(x.findingKey)).filter(Boolean)).size
  const missed = use.length - covered
  if (missed > 0 || use.length < fs2.length) {
    t.eff.push({ type: 'notify', level: 'warn',
      text: '「' + str(n.title || n.id) + '」报了 ' + fs2.length + ' 条发现,只核得动 ' + covered + ' 条'
        + '(预算 ' + num(r.budget.spawned) + '/' + num(r.budget.maxNodes) + ' 已满)—— 其余 ' + (fs2.length - covered)
        + ' 条【没有人复核过】,收口时请自己看,或者在面板上加预算。' })
  }
  if (covered > 0) t.eff.push({ type: 'notify', level: 'info', text: '「' + str(n.title || n.id) + '」' + covered + ' 条发现 → 已逐条派新眼睛去核' })
  return true
}

// ── 形状兜底:验收(新眼睛复核汇总)──────────────────────────────────────
// 汇总节点自己的闸只能查"文件在不在、有没有真引用上游"这类机械项;
// "这份文档够不够格""对照总目标还漏了什么"只有另一双眼睛读完才知道 —— 而让写汇总的自己评自己
// 等于自己给自己打分(验证棒那边早有定论)。所以由代码强制挂一个只读的验收节点,requireVerdict 机判。
//
// ★★【2026-08-08 真机:它原来只挂在"代码补了汇总"那条分支上】
// 现场:模型自己给了 n10(reduce) → needsReduce 返回 null → shapeReduce 第一行就早退 →
// 嵌在它成功分支里的 shapeAudit 永远走不到 → 8 片方案里【一个 verify 都没有】,
// 汇总写完没有任何人复核。而 needsAudit 写的是独立判据("有 reduce 且没人 verify 它"),
// 本意显然是不管汇总谁给的都要挂 —— 判据对、注释对,就是被挂在了一个够不到的地方。
// 收口闸 dryGate 里也漏了这一道(它只查了铺宽/汇总/归档),于是两处该拦的都拦不住。
// 这是同一形态的第七次:检查在、注释也对,但它的前置条件在真机上不成立。
function shapeAudit(t) {
  const r = t.r
  const red = SHAPE.needsAudit(r)
  if (!red) return false
  const v = N.validateNodeSpecs([SHAPE.makeAuditSpec(r, red)], r, t.cx)
  const made = arr(v && v.nodes)
  if (!made.length) return false
  addNodes(t, made, 'shape', posInt(r.wave, 1))
  t.eff.push({ type: 'notify', level: 'info', text: '已自动补一个验收节点(新眼睛复核汇总:证据抽核 + 对照总目标找缺口)' })
  return true
}

function addNodes(t, made, origin, wave) {
  const r = t.r
  for (const raw of made) {
    const n = raw
    if (!n || !n.id || findNode(r, n.id)) continue      // 撞 id 直接丢(只增不删的前提是 id 唯一)
    n.runId = r.id
    // wave / origin 是状态机的记账,不是规格的一部分:必须【强制覆盖】。
    // nodes.js 的 makeNode 给了默认值(wave:1, origin:'plan'),原来这里用 `||` 兜,默认值永远赢 ——
    // replan 加进来的节点会被记成第 1 波、origin='plan',而 wave 正是"小批 replan 到底有没有真的发生"的
    // 可观测指标(面板要显示、验收要看),记错了等于把反死板的证据抹掉。
    n.wave = wave
    n.origin = origin                                   // 没有 'auto' —— 代码不造节点
    n.state = 'pending'
    n.attempt = num(n.attempt)
    n.maxAttempts = posInt(n.maxAttempts, 2)            // ★=2 不是 1:45s 落定消不掉,半成品会白烧一次 attempt
    n.deps = arr(n.deps).map(str)
    n.writeScope = arr(n.writeScope).map(str)
    n.contract = arr(n.contract).map(str)
    n.exit = Object.assign({ artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '', noEmpty: true }, n.exit || {})
    n.brief = str(n.brief)
    n.cardId = n.cardId || null; n.wcId = n.wcId || null; n.sid = n.sid || null
    n.queuedAt = num(n.queuedAt); n.startedAt = num(n.startedAt); n.lastTurnAt = num(n.lastTurnAt); n.settledAt = num(n.settledAt)
    n.result = Object.assign({ final: '', files: [], rounds: 0, aborted: false, exitReport: [], verdict: '', cmdExit: null, contractMiss: [], unverified: false, findings: [], verdictSrc: '' }, n.result || {})
    n.reason = str(n.reason); n.droppedReason = str(n.droppedReason)
    r.nodes.push(n)
    r.budget.spawned += 1
    t.changed = true
  }
}

// 批准时的人工修订:面板怎么给都收(撤片 / 改片 / 加片 / 加预算)。
// 【为什么支持三种形态】用户的修订是"按片修订"的口语("第 N 片去掉 / 改成 X / 再加一片"),
// 面板端不同版本传参形状会漂;状态机宁可宽收,也不要因为字段名对不上把用户的修订静默吞掉。
function applyEdits(t, edits) {
  const r = t.r
  const ed = (edits && typeof edits === 'object') ? edits : {}
  for (const d of arr(ed.drop || ed.dropNodes)) {
    const id = (d && typeof d === 'object') ? str(d.id) : str(d)
    const n = findNode(r, id)
    if (!n || (n.state !== 'pending' && n.state !== 'queued')) continue   // ★同样只砍未 running 的
    n.state = 'skipped'
    n.droppedReason = ((d && typeof d === 'object') ? str(d.why) : '') || '用户在批准时撤掉'
    t.changed = true
  }
  const patch = (ed.patch && typeof ed.patch === 'object') ? ed.patch : null
  if (patch) for (const id of Object.keys(patch)) {
    const n = findNode(r, id)
    const p = patch[id]
    if (!n || !p || typeof p !== 'object') continue
    if (p.title !== undefined) n.title = str(p.title)
    if (p.goal !== undefined) n.goal = str(p.goal)                        // ★不截断:截了就写不下一个现编角色
    if (Array.isArray(p.deps)) n.deps = p.deps.map(str)
    if (Array.isArray(p.writeScope)) n.writeScope = p.writeScope.map(str)
    if (Array.isArray(p.contract)) n.contract = p.contract.map(str)
    if (p.exit && typeof p.exit === 'object') n.exit = Object.assign({}, n.exit, p.exit)
    t.changed = true
  }
  const add = arr(ed.add || ed.addNodes)
  if (add.length) {
    const v = N.validateNodeSpecs(add, r, t.cx)
    addNodes(t, arr(v && v.nodes), 'user', r.wave)
  }
  const b = (ed.budget && typeof ed.budget === 'object') ? ed.budget : null
  if (b) {   // 【续做】= 加预算再跑,只许加不许减(减了会让已在跑的节点立刻越界)
    if (+b.maxNodes > r.budget.maxNodes) r.budget.maxNodes = Math.floor(+b.maxNodes)
    if (+b.maxDecides > r.budget.maxDecides) r.budget.maxDecides = Math.floor(+b.maxDecides)
    if (+b.maxWallMs > r.budget.maxWallMs) r.budget.maxWallMs = Math.floor(+b.maxWallMs)
    if (r.budget.maxDecides < 2 * r.budget.maxNodes) r.budget.maxDecides = 2 * r.budget.maxNodes
    if (+b.addDecides > 0) r.budget.maxDecides += Math.floor(+b.addDecides)
    if (+b.addWallMs > 0) r.budget.maxWallMs += Math.floor(+b.addWallMs)
    t.changed = true
  }
}

// ── 用户事件 ────────────────────────────────────────────────────────
function onUserApprove(t) {
  const r = t.r
  if (r.phase === 'awaiting-approval') {
    applyEdits(t, t.e.edits)
    r.phase = 'executing'; r.phaseAt = t.at
    if (!r.budget.startedAt) r.budget.startedAt = t.at
    t.changed = true
    tick(t, false)
    return
  }
  if (r.phase === 'awaiting-user') {
    applyEdits(t, t.e.edits)        // 转人工时用户可以顺手加预算(【续做】按钮)
    r.ask = null
    r.phase = 'executing'; r.phaseAt = t.at; r.lastError = ''
    r.budget.invalidStreak = 0; r.budget.idleFrontier = 0
    t.changed = true
    startDecision(t, 'replan', 'user-answer', '')
    tick(t, false)
    return
  }
  // 其余相位吸收(重复点批准 = 一次)
}

function onUserReject(t) {
  const r = t.r
  if (r.phase !== 'awaiting-approval') return
  pushNote(t, str(t.e.note) || '(用户打回,未写理由)')
  r.phase = 'planning'; r.phaseAt = t.at
  t.changed = true
  startDecision(t, 'replan', 'user-reject', '')
}

function onUserNote(t) {
  const r = t.r
  const text = str(t.e.text)
  if (!text) return
  if (!pushNote(t, text)) return                       // 同 at 同文本 = 重复投递,吸收
  if (r.phase === 'awaiting-user') {
    r.ask = null
    r.phase = 'executing'; r.phaseAt = t.at; r.lastError = ''
    r.budget.invalidStreak = 0; r.budget.idleFrontier = 0
    startDecision(t, 'replan', 'user-answer', '')
    tick(t, false)
    return
  }
  if (r.phase === 'executing') {
    // 有在飞决策就不重复发起 —— 但插话不会丢:它留在 userNotes 未消费,renderReplan 下次必带,
    // 且延迟槽保证决策一回来立刻再问一次
    startDecision(t, 'replan', 'user-note', '')
  }
  // planning / awaiting-approval / suspended:只记账,等相位自然推进时带上
}

function pushNote(t, text) {
  const r = t.r
  if (r.userNotes.some((x) => num(x.at) === t.at && str(x.text) === text)) return false
  r.userNotes.push({ at: t.at, text, consumedBy: '' })
  t.changed = true
  return true
}

function onKill(t, why) {
  const r = t.r
  for (const n of r.nodes) if (!isTerminalNode(n.state)) cancelNode(t, n, why)
  r.phase = 'cancelled'; r.phaseAt = t.at; r.lastError = why
  r.pendingDecision = null; r.pendingReplan = null
  t.eff.push({ type: 'archive' })
  t.changed = true
}

function onUserRetry(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n || n.state !== 'failed') return               // 只有 failed 能手动重来;重复点 = 幂等吸收
  n.maxAttempts += 1
  n.state = 'pending'
  n.reason = ''; n.settledAt = 0; n.startedAt = 0
  n.cardId = null; n.wcId = null; n.sid = null
  t.changed = true
  tick(t, false)
}

// 重启续接(§3.5):磁盘产出说话,不惩罚崩溃
function onUserResume(t) {
  const r = t.r
  if (r.phase !== 'suspended') return
  const credit = r.budget.resumeCredit > 0
  let usedCredit = false
  for (const n of r.nodes) {
    if (n.state === 'verified' || n.state === 'settled') {
      t.eff.push({ type: 'evalExit', nodeId: n.id })   // 复核:过 → 保持;不过 → pending(attempt 不增,见 onExitResult)
    } else if (n.state === 'running' || n.state === 'queued') {
      clearNodeTimers(t, n)                            // ★离开 running 必清计时器(重启后的孤儿计时器最阴)
      n.state = 'settled'; n.settledAt = t.at
      if (credit) { n.reason = 'lost-on-restart'; usedCredit = true }   // reason 就是"免罚"的凭据,不另设一次性标志
      t.eff.push({ type: 'evalExit', nodeId: n.id })   // 全过 → 直接 verified(磁盘产出说话);否则 pending
    }
    // failed / skipped / cancelled / pending 原样
  }
  if (usedCredit) r.budget.resumeCredit -= 1           // 上限 1:防重启循环白烧预算
  r.phase = 'executing'; r.phaseAt = t.at; r.lastError = ''
  t.changed = true
  startDecision(t, 'replan', 'restart', '')
  tick(t, false)
}

function onBudgetExceeded(t) {
  toAwaitingUser(t, '预算耗尽(' + (str(t.e.what) || '未注明') + ')', true)   // ★不许自动收口
}

// ── 工人侧事件 ──────────────────────────────────────────────────────
function onNodeDispatched(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n) return
  const cardId = t.e.cardId === undefined ? n.cardId : t.e.cardId
  const wcId = t.e.wcId === undefined ? n.wcId : t.e.wcId
  const sid = t.e.sid === undefined ? n.sid : t.e.sid
  if (n.cardId === cardId && n.wcId === wcId && n.sid === sid) return   // 同值重投 = 吸收
  n.cardId = cardId; n.wcId = wcId; n.sid = sid
  t.changed = true
}

function onTurnStart(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n) return
  if (n.state === 'running') {
    n.lastTurnAt = t.at
    t.eff.push({ type: 'clearTimer', key: tkey(t.r, n.id, 'silent') })   // 有轮在跑就不算静默
    // ★stall 也要续弦。它的注释写的是"15min 没有任何一轮 = 挂死",但原来只在【派发】和
    //   verified→running 两处上弦,轮开始时只清 silent、不碰 stall —— 于是它量的其实是
    //   "距派发 15 分钟",跟"有没有新一轮"无关。一轮只要跑够 15 分钟,就会在【干活途中】被判挂死、
    //   kill 掉卡、stalled 属 HARD_FAIL 不给补做 → 整节点重来。
    //   而 4243cb5 已把单轮预算提到 2h(内网慢端点 prefill + 长 reasoning),两者差了 8 倍,
    //   慢端点上一轮跑二十分钟很正常 —— 这就是"timeout 报错要重跑"的来源。
    //   续弦后语义才对上:每来一轮就重新计 15 分钟,真的"一轮都没有"才判死。
    t.eff.push({ type: 'armTimer', key: tkey(t.r, n.id, 'stall'), nodeId: n.id, kind: 'stall', ms: STALL_MS })
    t.changed = true
    return
  }
  if (n.state === 'verified') {
    // ★合法转移(交棒/复活):已验证的节点又开口说话了。现状为这一格长了一个一次性标志,
    //   而"复验用旧报文重跑机判"就寄生在那上面 —— 这里它只是一行普通转移,不需要任何标志。
    n.state = 'running'; n.lastTurnAt = t.at
    t.eff.push({ type: 'clearTimer', key: tkey(t.r, n.id, 'silent') })
    t.eff.push({ type: 'armTimer', key: tkey(t.r, n.id, 'stall'), nodeId: n.id, kind: 'stall', ms: STALL_MS })
    t.r.budget.idleFrontier = 0
    t.changed = true
    return
  }
  // 其余状态吸收(settled 的工人若真活着,下一轮 verified 之后这条路照样走得通)
}

function onTurnEnd(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n || n.state !== 'running') return
  const e = t.e
  n.lastTurnAt = t.at
  n.result.final = str(e.final)
  n.result.files = arr(e.files).map(str)
  n.result.rounds = num(e.rounds)
  n.result.aborted = !!e.aborted
  if (e.aborted) n.reason = 'aborted'
  // 轮末静默 45s 才算落定。★【不看 todos】—— 现状按 todo 勾没勾判"干完了",弱模型漏勾一条就永远不完
  t.eff.push({ type: 'armTimer', key: tkey(t.r, n.id, 'silent'), nodeId: n.id, kind: 'silent', ms: SILENT_MS })
  t.changed = true
}

function onTurnError(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n || n.state !== 'running') return
  // 错误轮 ≠ 结束:重新起静默计时,让它自己再试;真挂了由 stall 计时器兜
  t.eff.push({ type: 'armTimer', key: tkey(t.r, n.id, 'silent'), nodeId: n.id, kind: 'silent', ms: SILENT_MS })
  t.changed = true
}

function onCardGone(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n || n.state !== 'running') return
  settleNode(t, n, 'card-gone', true)
}

function onTimer(t) {
  const n = findNode(t.r, t.e.nodeId)
  if (!n || n.state !== 'running') return               // ★终态/非 running 的计时器一律吸收:孤儿计时器覆写不了终态
  // ★以 kind 为准,key 只作兜底:armTimer effect 发出去的 key 是【复合定时器 id】(runId:nodeId:silent),
  // 执行层原样回灌;拿它去比 'silent' 永远不等 —— 计时器照常烧,节点却永远落不了定(接线时实测踩中,
  // 现象是"45s 到了什么都没发生")。selftest 手写事件时传的是 key:'silent',所以纯逻辑层测不出来。
  const kind = str(t.e.kind) || str(t.e.key).split(':').pop()
  if (kind === 'silent') settleNode(t, n, '', false)      // 静默落定:卡先留着(它可能还活着),过了 exit 再关
  else if (kind === 'stall') settleNode(t, n, 'stalled', true)
}

// running → settled 的唯一入口:清干净两只计时器,交给 evalExit 用【磁盘事实】判成败
function settleNode(t, n, reason, kill) {
  clearNodeTimers(t, n)                                  // ★离开 running 的每一条分支都要清 —— 漏一条就被覆写回去
  n.state = 'settled'; n.settledAt = t.at
  if (reason) n.reason = reason
  if (kill) t.eff.push({ type: 'cancelNode', nodeId: n.id, why: reason === 'stalled' ? '挂死超时' : '卡已消失' })
  t.eff.push({ type: 'evalExit', nodeId: n.id })
  t.changed = true
}

// ── EXIT_RESULT:退出检查回灌(evalExit 要读盘/跑命令,所以在 index.js 里跑)────────
function onExitResult(t) {
  const r = t.r
  const n = findNode(r, t.e.nodeId)
  if (!n) return
  // ★只有 settled(正常落定)与 verified(重启复核)接受退出结果;其余状态一律吸收。
  //   这就是"用旧报文重跑机判"在状态机上不可达的根据:要再判一次,必须先经一次新的 running→settled。
  if (n.state !== 'settled' && n.state !== 'verified') return
  const wasVerified = n.state === 'verified'
  const e = t.e
  n.result.exitReport = arr(e.report)
  n.result.verdict = str(e.verdict)
  n.result.cmdExit = (e.cmdExit === null || e.cmdExit === undefined) ? null : num(e.cmdExit)
  n.result.contractMiss = arr(e.contractMiss).map(str)
  n.result.unverified = !!e.unverified
  // 终答回填(2026-08-04,慢模型晚收官实测):终答收集挂在回合正常收尾上,回合一旦报错/超时,
  // 流式明明吐过字、final 却是空的 → 误判零产出。evalExit 执行层判前回 serve 拉了会话原文,
  // 随本事件带回 —— 只补空缺,绝不覆盖已有 final。
  if (!str(n.result.final).trim() && str(e.final).trim()) n.result.final = str(e.final)
  t.changed = true
  if (e.pass) {
    n.state = 'verified'
    if (!n.settledAt) n.settledAt = t.at
    n.reason = ''
    t.eff.push({ type: 'cancelNode', nodeId: n.id, why: '已通过退出检查' })   // 过了才关它的卡,不再烧 token
    r.ledger = L.addFacts(r.ledger, factsOf(n), n.id, t.at)
    r.budget.idleFrontier = 0
    shapeVerifyFindings(t, n)   // 这一片报了发现 → 逐条派新眼睛去核(CC 的 Verify 那一层)
    // ★每个节点收官都问一次模型 = 反死板核心。复核通过(wasVerified)不重复问:那是重启复核,图没变
    if (!wasVerified) startDecision(t, 'replan', 'node-settled', n.id)
    tick(t, false)
    return
  }
  // 不过:重启复核不过 / lost-on-restart / 卡凭空消失 都不罚 attempt(不惩罚崩溃)
  //
  // ★card-gone 这条是真机实测补的(2026-08-07):关应用时 WORKER_CARD_GONE 先到、
  //   PANEL_CARD_GONE 0.17 秒后才到,中间这一手把三片判成了「零产出 · 重做#1」——
  //   卡是被关应用带走的,壳层却按"这张卡什么都没干"处理,还扣了一次重做额度。
  //   免罚名单里本来只有 lost-on-restart:同一条"不惩罚崩溃"的原则,漏了另一种崩法。
  //   attempt 在内网很贵(一次重做 = 新开卡从零重读),不该由环境噪音来花。
  //
  // 【为什么要留一次额度而不是永久免罚】卡反复消失(崩溃循环)时,永久免罚就没有任何东西
  //   拦得住无限重派 —— 与 resumeCredit 上限 1 是同一个道理。第一次算环境噪音,第二次起照常计费。
  //   老存档没有 goneCredit 这一格,所以 undefined 要当成 1 而不是 0:
  //   直接 num() 会得到 0,这条免罚对【重启恢复的 run】静默失效(本仓 patches/maxPatches 踩过同款)。
  const goneCredit = (n.goneCredit === undefined || n.goneCredit === null) ? 1 : num(n.goneCredit)
  const freeGone = n.reason === 'card-gone' && goneCredit > 0
  if (freeGone) n.goneCredit = goneCredit - 1
  const noPenalty = wasVerified || n.reason === 'lost-on-restart' || freeGone
  const detail = failDetail(n.result)
  // ★卡没了的时候,reason 保持 card-gone,不许被闸门结论覆写成 zero-output。
  //   卡凭空消失是【原因】,查不到产出是【症状】—— 记成症状的话,面板和下一轮提示词都会告诉
  //   模型"这片什么都没干",而真相是它可能干得好好的,只是卡被带走了。误诊会传染给下一次决策。
  // ★HARD_FAIL 类的落定原因【一律不许被闸门结论覆写】。
  //   原来只护住了 card-gone,漏了 stalled / aborted / lost-on-restart —— 而漏掉的后果很实:
  //   真机 2026-08-08:节点被挂死计时判 stalled(卡已被 cancelNode 杀掉),
  //   紧接着 reason 被 artifacts 闸覆写成 artifact-missing,而 artifact-missing 不属 HARD_FAIL,
  //   于是补做分支的 `!HARD_FAIL.has(n.reason)` 判的是那个假 reason → 放行 →
  //   往【一张刚被杀掉的卡】里注入补做指令(白烧一次补做),0.001 秒后 WORKER_CARD_GONE 到达,
  //   再走一遍 evalExit 又重派一次。整条日志里同一个节点连着两次 evalExit + 两次 EXIT_RESULT。
  //   落定原因是【怎么停下来的】,闸门结论是【停下来之后盘上有什么】—— 后者不该改写前者。
  n.reason = HARD_FAIL.has(n.reason) ? n.reason : (reasonOf(n.result) || n.reason || 'zero-output')
  // ── 先补做,补不动才重做 ────────────────────────────────────────────────
  // 退出闸不过 ≠ 这片白干了。六类闸里只有 noEmpty(零产出)意味着"这张卡根本没干活",
  // 其余五类(缺产出文件 / 缺契约签名 / 没跑构建测试 / 没出 VERDICT / 命令非零)都是【活干了但差一截】——
  // 差一截就该在【原卡原会话】里把差的那截补上:它的上下文还在,知道自己刚写了什么,补一项通常一个回合就完;
  // 而重做要新开卡、从零重读、还可能把上一轮做对的部分改出别的样子。
  // 补做不消耗 attempt(那是留给"整片重来"的预算),自己记 patches;补满了再降级成重做。
  // num/posInt 兜底同 wave:老版本落盘的 run.json 里没有 patches/maxPatches,
  // 直接比较就是 undefined < undefined = false —— 补做分支会静默失效,悄悄退回「一律重做」的老行为
  const missing = patchableMissing(n)
  const patches = num(n.patches), maxPatches = posInt(n.maxPatches, 2)
  // ★★【软闸不许升级成重做】(真机 2026-08-09,代价具体到字节)
  // 现场:汇总片交出 docs/仓库收货逻辑.md 141817 字节,substance 引用 13/13 个上游、weight 138KB
  // (下限 77KB)—— 两道"够不够格"的闸都过得很宽裕,是这套编排至今最好的一份交付。
  // 唯一不过的是 single(汇总只许一份文件):它另外散出 4 个 _补做_组X_正文.md —— 而那几个文件
  // 恰恰是【补做过程自己为绕开工具长度限制而分组写的中间件】。
  // 补做用满 2 次后升级重做,重做把 141817 字节覆盖成 29907 字节,反过来栽在 thin-summary,
  // attempt 2/2 → 永久失败 → 依赖它的验收片被撤 → 重规划拆成两片分组融合 → 又各自栽同一道闸 →
  // 额度耗尽转人工。一道"桌面要整洁"的闸,连锁毁掉了整轮交付(那份 138KB 是从 serve 快照里捞回来的)。
  // 【判据错在力度,不在有无】single 说的是"交付合格但桌面乱",而散文件本来就有专人收 ——
  // 收尾归档片(shapeArchive)就是干这个的。用重做去办归档能办的事,是拿最贵的手段解决最便宜的问题。
  // 所以:软闸可以用【补做】拦(让它把多余文件 move 走),补不动就【放行】,绝不重做、绝不判失败。
  const bad = arr(n.result && n.result.exitReport).filter((x) => x && !x.ok).map((x) => str(x.kind))
  const onlySoft = bad.length > 0 && bad.every((k) => SOFT_GATE.has(k))
  if (onlySoft && (patches >= maxPatches || !n.cardId || HARD_FAIL.has(n.reason))) {
    t.eff.push({ type: 'notify', level: 'info', text: '「' + str(n.title || n.id) + '」交付本身合格(' + bad.join('、')
      + ' 只是桌面没收干净),补做已用满 —— 放行,散出的文件交给收尾归档片收' })
    // 与 e.pass 那支同口径落定(那支是内联的,这里照抄同样几步,别少任何一步:
    // cancelNode 关卡省 token、addFacts 让下游读得到、shapeVerifyFindings 按条派核实、
    // 最后必须问一次 replan —— 少一步就是"过了但图不动/发现没人核"那类静默坑)
    n.state = 'verified'
    if (!n.settledAt) n.settledAt = t.at
    n.reason = ''
    t.eff.push({ type: 'cancelNode', nodeId: n.id, why: '交付合格(只差桌面整洁,交给归档)' })
    r.ledger = L.addFacts(r.ledger, factsOf(n), n.id, t.at)
    r.budget.idleFrontier = 0
    shapeVerifyFindings(t, n)
    startDecision(t, 'replan', 'node-settled', n.id)
    tick(t, false)
    return
  }
  if (missing.length && patches < maxPatches && n.cardId && !HARD_FAIL.has(n.reason) && n.kind !== 'verify') {
    // kind==='verify' 不补:验证节点的规程自己写着"验证恒由新分片执行(新眼睛防锚定)"——
    // 让同一根棒把自己的报告补圆,等于让它给自己打分。
    n.patches = patches + 1
    n.state = 'running'                       // 卡还在、会话还在:不重开,直接让它接着干
    n.settledAt = 0
    clearNodeTimers(t, n)
    t.eff.push({ type: 'patchNode', nodeId: n.id, missing, patch: n.patches, why: detail })
    t.eff.push({ type: 'armTimer', key: tkey(t.r, n.id, 'silent'), nodeId: n.id, kind: 'silent', ms: SILENT_MS })
    t.changed = true
    return
  }
  if (noPenalty || n.attempt < n.maxAttempts) {
    if (!noPenalty) n.attempt += 1
    // rejected → pending 在同一个事件里走完(rejected 是过渡态,不留在盘上)
    n.state = 'pending'
    n.settledAt = 0; n.startedAt = 0
    n.cardId = null; n.wcId = null; n.sid = null      // 下一次 attempt 开新卡新会话(新眼睛防锚定)
    n.brief = appendReject(n.brief, detail, noPenalty, n.result.files)
    tick(t, false)
    return
  }
  n.state = 'failed'
  if (!n.settledAt) n.settledAt = t.at
  r.ledger = L.addGaps(r.ledger, [{ text: n.id + '「' + n.title + '」失败:' + detail, anchors: arr(n.result.files).slice(0, 6) }], n.id, t.at)
  startDecision(t, 'replan', 'node-failed', n.id)     // 失败也必须问模型:怎么拆更小 / 要不要绕开 / 认不认这个缺口
  tick(t, false)
}

function factsOf(n) {
  const head = firstLine(n.result.final, 160)
  return [{ text: n.id + '「' + n.title + '」已通过退出检查' + (head ? ':' + head : ''), anchors: arr(n.result.files).slice(0, 8) }]
}
// ── 补做判据 ────────────────────────────────────────────────────────────
// 这些 reason 表示"这张卡根本没在干活",没有可续的上下文,只能重开:
const HARD_FAIL = new Set(['zero-output', 'aborted', 'stalled', 'card-gone', 'lost-on-restart'])
// ── 软闸:交付【合格】,只是桌面乱 ────────────────────────────────────────
// 这类闸可以用补做拦(让它把多余文件 move 走),但【绝不许升级成重做或失败】——
// 散文件本来就有专人收(shapeArchive 的收尾归档片)。用重做去办归档能办的事,
// 是拿最贵的手段解决最便宜的问题,而 2026-08-09 真机证明代价可以是整轮交付:
// 一份 141817 字节、引用 13/13 上游、weight 过得很宽裕的汇总,因为多散了 4 个中间件文件
// 被判 single 不过 → 补做用满 → 重做 → 29907 字节 → 反栽 thin-summary → 永久失败 → 全轮崩。
const SOFT_GATE = new Set(['single'])
// 可补的失败项 = 除 noEmpty 外的退出闸(缺产出 / 缺契约签名 / 没跑验证 / 没出 VERDICT / 命令非零)。
// noEmpty 不过 = 零产出,补无可补。
function patchableMissing(n) {
  const bad = arr(n.result && n.result.exitReport).filter((x) => x && !x.ok)
  if (!bad.length) return []
  if (bad.some((x) => str(x.kind) === 'noEmpty')) return []
  return bad.map((x) => ({ kind: str(x.kind), detail: str(x.detail) }))
}

function failDetail(res) {
  const bad = arr(res.exitReport).filter((x) => x && !x.ok)
  if (bad.length) return bad.map((x) => str(x.kind) + (x.detail ? '(' + firstLine(x.detail, 80) + ')' : '')).join('; ')
  if (arr(res.contractMiss).length) return '契约缺:' + res.contractMiss.join(', ')
  return '退出检查未通过'
}
// 机器可读的失败原因(给渲染/面板用,不给模型当结论)
function reasonOf(res) {
  const bad = arr(res.exitReport).filter((x) => x && !x.ok).map((x) => str(x.kind))
  // ★noEmpty 必须【第一个】判 —— 它是唯一"这张卡根本没干活"的信号,其余全是"活干了但差一截"。
  //   原来它排在倒数第三,后果是【零产出这个判定基本永远到不了】:一张什么都没产出的卡,
  //   每一道闸都会不过(没产出、没 VERDICT、没契约签名…),而 reasonOf 返回的是先命中的那个。
  //   真机 2026-08-08:n21 的 rounds=0、final 空 —— 卡一个回合都没跑过,
  //   却被判成 verdict-fail(不属 HARD_FAIL)→ 走补做 → 往一张什么都没干的卡里补"你少写了 VERDICT",
  //   而它需要的是【真的跑一遍】。补做分支自己的注释早就写明白了:
  //   "六类闸里只有 noEmpty 意味着这张卡根本没干活" —— 判定顺序却和这句话相反。
  if (bad.indexOf('noEmpty') >= 0) return 'zero-output'
  if (bad.indexOf('contract') >= 0) return 'contract-miss'
  if (bad.indexOf('evidence') >= 0) return 'no-evidence'
  if (bad.indexOf('verdict') >= 0) return 'verdict-fail'
  if (bad.indexOf('cmd') >= 0) return 'cmd-nonzero'
  // ★artifacts 与 noEmpty 必须分开,不能都叫 zero-output。
  //   上面补做分支的注释把意图写得很清楚:"六类闸里只有 noEmpty 意味着这张卡根本没干活,
  //   其余五类(缺产出文件/缺契约签名/…)都是活干了但差一截" —— 而这一行把【缺产出文件】也归成
  //   zero-output,zero-output 又在 HARD_FAIL 里,于是补做分支的 !HARD_FAIL.has(n.reason) 直接把它挡在门外:
  //   patchableMissing 特意放行 artifacts 的那份代码从来没生效过,声明路径写偏一次就整节点重跑
  //   (实测表现:内网工作流"每轮都有文档产出,却总报 artifacts,要重跑 1~2 次")。
  //   拆开后 artifact-missing 不属 HARD_FAIL → 走补做:原卡原会话,上下文还在,通常一个回合就把文件挪对,
  //   也不消耗 attempt。真正"什么都没产出"才继续叫 zero-output 并判死。
  if (bad.indexOf('artifacts') >= 0) return 'artifact-missing'
  if (bad.indexOf('substance') >= 0) return 'thin-summary'   // 汇总没真读上游 —— 活干了但差一截,走补做(原卡上下文还在,读完重写一遍就行)
  // 新增的两道汇总闸同样是"活干了但差一截":
  //   single —— 正文都写出来了,只是散成了几个文件,合并一下就好;
  //   weight —— 内容不够厚,接着往同一份里补。
  // 两者都不属 HARD_FAIL,所以走【补做】:原卡原会话,上下文还在,不烧 attempt。
  // 判成重做的话要新开卡从零重读 6 份上游文档,又贵又可能把已经写对的部分改坏。
  if (bad.indexOf('single') >= 0) return 'split-output'
  if (bad.indexOf('weight') >= 0) return 'thin-summary'
  return ''
}
// 拒因追加进 brief 留痕(重派时 composeNodeBrief 也会从 exitReport 重新渲染一遍,两条路都不丢)
function appendReject(brief, detail, resumed, files) {
  const fs2 = arr(files).slice(0, 6).join(', ')
  const tail = resumed
    ? '\n【壳层续接】上次运行被中断,磁盘上已有产出:' + (fs2 || '(无)') + ' —— 接着做,别重来。'
    : '\n【上轮未通过】' + detail + (fs2 ? '(上轮产出:' + fs2 + ')' : '') + ' —— 这一轮针对这些项修好再交。'
  return str(brief) + tail
}

// ── TICK:派发 / 判空 / 触发 frontier 决策 ──────────────────────────
// allowFrontier:只有外部真 TICK 事件才允许发起 frontier 决策。内部自 tick(合并完图、节点收官后)不发起 ——
// 否则"空 replan → 立刻再问 → 又空"会在一个事件里自我循环,把预算烧光
function tick(t, allowFrontier) {
  const r = t.r
  if (r.phase !== 'executing') return
  // ① 上游失败 → 下游 skipped(解除阻塞,别让整张图卡死等一个永远不来的 verified)
  for (const n of r.nodes) {
    if (n.state !== 'pending' && n.state !== 'queued') continue
    if (!n.deps.some((d) => { const p = findNode(r, d); return p && p.state === 'failed' })) continue
    n.state = 'skipped'; n.droppedReason = '上游失败'
    t.changed = true
  }
  // ② 派发:deps 全 verified/skipped 且有容量 → queued → running(同一拍走完)
  // 容量取【run 内并发】与【全局并发余量 capHint】的小者。capHint 由装配层注入(它才知道别的卡占了多少位)。
  // 不看全局的话:tick 这里已经把节点置 running 并挂好计时,doDispatch 才撞上全局闸拿不到卡 →
  // 节点 running 却没有卡 → 45s 落定 → 零产出 → zero-output 属 HARD_FAIL 不给补做 → attempt++ → 两次判死。
  // 纯度不破:capHint 是注入的上下文,不是从全局读的。
  const hint = t.cx && t.cx.capHint
  let cap = r.concurrency - countState(r, 'running')
  if (Number.isFinite(hint)) cap = Math.min(cap, Math.max(0, hint))
  for (const n of r.nodes) {
    if (n.state !== 'pending' && n.state !== 'queued') continue
    if (!depsSatisfied(r, n)) continue
    if (cap > 0) {
      cap -= 1
      if (!n.queuedAt) n.queuedAt = t.at
      n.state = 'running'; n.startedAt = t.at; n.lastTurnAt = t.at
      t.eff.push({ type: 'dispatch', nodeId: n.id })
      t.eff.push({ type: 'armTimer', key: tkey(r, n.id, 'silent'), nodeId: n.id, kind: 'silent', ms: SILENT_MS })
      t.eff.push({ type: 'armTimer', key: tkey(r, n.id, 'stall'), nodeId: n.id, kind: 'stall', ms: STALL_MS })
      t.changed = true
    } else if (n.state === 'pending') {
      // ★队列停在 run 内(state='queued'),【不进全局 wfQueue】—— 现状那条全局队列是串台与丢片的老巢
      n.state = 'queued'; n.queuedAt = t.at
      t.changed = true
    }
  }
  if (!allowFrontier || r.pendingDecision) return
  // ③ 无 ready、无 running、无 queued:仍然去问模型。★代码不许替它宣布收口
  if (countState(r, 'running') || countState(r, 'queued') || countState(r, 'settled') || readyNodes(r).length) return
  if (r.budget.idleFrontier >= MAX_IDLE_FRONTIER) {
    toAwaitingUser(t, '连续 ' + r.budget.idleFrontier + ' 次无事可做且模型没给出下一步,请你指一条路(继续 / 收口 / 补充信息)', false)
    return
  }
  startDecision(t, 'replan', 'frontier', '')
}

function depsSatisfied(r, n) {
  return arr(n.deps).every((d) => { const p = findNode(r, d); return p && (p.state === 'verified' || p.state === 'skipped') })
}

// ── 只读查询 ────────────────────────────────────────────────────────
function readyNodes(run) {
  return run.nodes.filter((n) => n.state === 'pending' && depsSatisfied(run, n))
}

// 违反的不变式描述(空 = 健康)。★只写日志,不改状态 —— 它是体温计,不是药
function invariants(run) {
  const bad = []
  const r = run || {}
  if (PHASES.indexOf(r.phase) < 0) bad.push('未知相位 ' + r.phase)
  const seen = Object.create(null)
  for (const n of arr(r.nodes)) {
    if (NODE_STATES.indexOf(n.state) < 0) bad.push(n.id + ' 未知状态 ' + n.state)
    if (seen[n.id]) bad.push('节点 id 重复:' + n.id)
    seen[n.id] = 1
    for (const d of arr(n.deps)) if (!arr(r.nodes).some((x) => x.id === d)) bad.push(n.id + ' 依赖不存在的节点 ' + d)
    if (n.state === 'running' && !n.startedAt) bad.push(n.id + ' 在跑却没有 startedAt')
    if (n.state === 'skipped' && !n.droppedReason) bad.push(n.id + ' 被跳过却没有 droppedReason')
    if (n.state === 'rejected') bad.push(n.id + ' 停在过渡态 rejected(应当同拍落回 pending)')
    if (n.attempt > n.maxAttempts) bad.push(n.id + ' attempt 超过 maxAttempts')
  }
  const running = arr(r.nodes).filter((n) => n.state === 'running').length
  if (running > num(r.concurrency)) bad.push('在跑 ' + running + ' 个,超过并发上限 ' + r.concurrency)
  if (r.budget) {
    if (r.budget.maxDecides < 2 * r.budget.maxNodes) bad.push('maxDecides < 2*maxNodes(每节点必调 replan 会被掐死)')
    if (r.budget.spawned !== arr(r.nodes).length) bad.push('spawned(' + r.budget.spawned + ')与节点数(' + arr(r.nodes).length + ')对不上')
  }
  if (isTerminalPhase(r.phase) && arr(r.nodes).some((n) => !isTerminalNode(n.state))) bad.push('run 已终态却还有未终态节点')
  if (isTerminalPhase(r.phase) && r.pendingDecision) bad.push('run 已终态却还挂着在飞决策')
  return bad
}

// 渲染端只读投影。★render.js 里有一份同源实现 —— 边界表禁止 run/render 互 require,
//   所以各留一份;改一处必须改另一处(两处都标了这行注释)
function projectSnapshot(run) {
  const r = run || {}
  const nodes = arr(r.nodes)
  return {
    id: r.id, goal: r.goal, phase: r.phase, alias: r.alias,
    counts: {
      total: nodes.length,
      verified: nodes.filter((n) => n.state === 'verified').length,
      running: nodes.filter((n) => n.state === 'running').length,
      queued: nodes.filter((n) => n.state === 'queued').length,
      pending: nodes.filter((n) => n.state === 'pending').length,
      failed: nodes.filter((n) => n.state === 'failed').length,
      skipped: nodes.filter((n) => n.state === 'skipped').length,
    },
    wave: r.wave, budget: r.budget,
    nodes: nodes.map((n) => ({
      id: n.id, title: n.title, kind: n.kind, state: n.state, attempt: n.attempt, wave: n.wave,
      cardId: n.cardId, reason: n.reason, files: arr(n.result && n.result.files),
      // patches/deps/exitReport 是面板要显示的三样:补做了几次、卡在等谁、上一轮哪一项没过。
      // 少了它们用户只能看到"这片在跑",看不出"它为什么还没完"
      patches: num(n.patches), deps: arr(n.deps).map(str),
      droppedReason: str(n.droppedReason),
      exitReport: arr(n.result && n.result.exitReport).filter((x) => x && !x.ok).map((x) => ({ kind: str(x.kind), detail: str(x.detail) })),
    })),
    decisions: arr(r.decisions).map((d) => ({ at: d.at, point: d.point, why: d.why, invalid: d.invalid })),
    pendingDecision: r.pendingDecision, ask: r.ask || null,
    result: r.result, notes: arr(r.userNotes),
  }
}

module.exports = { createRun, applyEvent, readyNodes, invariants, projectSnapshot }
