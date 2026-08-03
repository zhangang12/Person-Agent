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

const PHASES = ['planning', 'awaiting-approval', 'executing', 'awaiting-user', 'suspended', 'done', 'failed', 'cancelled']
const TERMINAL_PHASES = ['done', 'failed', 'cancelled']
const NODE_STATES = ['pending', 'queued', 'running', 'settled', 'verified', 'rejected', 'failed', 'skipped', 'cancelled']
const NODE_TERMINAL = ['verified', 'failed', 'skipped', 'cancelled']
const SILENT_MS = 45 * 1000            // 轮末静默 45s 判落定(闸13 消不掉的退让:worker 层不动,"停没停"只能这么推断)
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
    case 'EXIT_RESULT': onExitResult(t); break
    case 'BUDGET_EXCEEDED': onBudgetExceeded(t); break
    default: break                              // 不认识的事件一律吸收(老存档回放时不炸)
  }
  if (!t.changed) return { run: r, effects: t.eff }
  r.seq += 1
  r.updatedAt = t.at
  t.eff.push({ type: 'persist' }, { type: 'ui' })
  // 不变式自检:只报警不改状态、不抛 —— 状态机自己坏了要看得见,但不能因此把用户的 run 弄死
  const bad = invariants(r)
  if (bad.length) t.eff.push({ type: 'notify', level: 'warn', text: '编排不变式违反:' + bad.join(';') })
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
    if (r.budget.invalidStreak >= MAX_PLAN_INVALID) toAwaitingUser(t, '规划决策连续 ' + r.budget.invalidStreak + ' 次不合法,请三选一:按单工作流直接干 / 重试 / 我自己填节点', false)
    else startDecision(t, 'plan', 'plan-invalid', '')
    return
  }
  r.budget.invalidStreak = 0
  r.ledger = L.addOpen(r.ledger, toItems(data.open), 'plan', t.at)
  const specs = arr(data.nodes)
  if (!specs.length) {
    if (str(data.more) === 'no') {
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
    if (r.budget.invalidStreak >= MAX_PLAN_INVALID) toAwaitingUser(t, '规划节点全部校验不过:' + arr(v && v.errors).join(';'), false)
    else startDecision(t, 'plan', 'plan-invalid', '')
    return
  }
  addNodes(t, made, 'plan', 1)
  if (v && v.truncated) t.eff.push({ type: 'notify', level: 'warn', text: '节点数超出预算,已截断到 ' + r.budget.maxNodes + ' 个' })
  if (v && arr(v.errors).length) t.eff.push({ type: 'notify', level: 'warn', text: '部分节点被校验丢弃:' + arr(v.errors).slice(0, 3).join(';') })
  r.phase = 'awaiting-approval'; r.phaseAt = t.at
}

function onReplanDecided(t, dec, data) {
  const r = t.r
  if (!dec.ok) {
    r.budget.invalidStreak += 1
    if (r.budget.invalidStreak >= MAX_INVALID_STREAK) { toAwaitingUser(t, '模型连续 ' + r.budget.invalidStreak + ' 次没能给出可用决策,请你指一条路', true); return }
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
    const added = mergeGraph(t, data)
    if (added || r.nodes.some((n) => !isTerminalNode(n.state))) { r.phase = 'awaiting-approval'; r.phaseAt = t.at }
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
  const changedGraph = mergeGraph(t, data)
  // ★反空转:frontier 问了一圈图还是没动 —— 计数,连着 N 次就转人工(出口是人,不是代码宣布 done)
  if (dec.event === 'frontier' && !changedGraph) r.budget.idleFrontier += 1
  else if (changedGraph) r.budget.idleFrontier = 0
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
    changedGraph = true; t.changed = true
  }
  const specs = arr(data.addNodes)
  if (specs.length) {
    const v = N.validateNodeSpecs(specs, r, t.cx)
    const made = arr(v && v.nodes)
    if (made.length) {
      // 波次:图长了一轮(反死板的可观测指标)。posInt 兜底不是洁癖 —— 老版本落盘的 run.json 没有 wave 字段,
      // 直接 `+= 1` 会得到 NaN,序列化成 null,面板上"第几波"整列变空,而这正是验收小批 replan 的那个数
      r.wave = posInt(r.wave, 1) + 1
      addNodes(t, made, 'replan', r.wave)
      changedGraph = true
    }
    if (v && v.truncated) t.eff.push({ type: 'notify', level: 'warn', text: '新增节点超出预算,已截断' })
    if (v && arr(v.errors).length) t.eff.push({ type: 'notify', level: 'warn', text: '部分新增节点被校验丢弃:' + arr(v.errors).slice(0, 3).join(';') })
  }
  return changedGraph
}

// 节点入图:nodes.js 已经校验过字段,这里只补状态机自己的那几格(不覆盖它已给的值)
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
    n.result = Object.assign({ final: '', files: [], rounds: 0, aborted: false, exitReport: [], verdict: '', cmdExit: null, contractMiss: [], unverified: false }, n.result || {})
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
  t.changed = true
  if (e.pass) {
    n.state = 'verified'
    if (!n.settledAt) n.settledAt = t.at
    n.reason = ''
    t.eff.push({ type: 'cancelNode', nodeId: n.id, why: '已通过退出检查' })   // 过了才关它的卡,不再烧 token
    r.ledger = L.addFacts(r.ledger, factsOf(n), n.id, t.at)
    r.budget.idleFrontier = 0
    // ★每个节点收官都问一次模型 = 反死板核心。复核通过(wasVerified)不重复问:那是重启复核,图没变
    if (!wasVerified) startDecision(t, 'replan', 'node-settled', n.id)
    tick(t, false)
    return
  }
  // 不过:重启复核不过 与 lost-on-restart 都不罚 attempt(不惩罚崩溃)
  const noPenalty = wasVerified || n.reason === 'lost-on-restart'
  const detail = failDetail(n.result)
  n.reason = reasonOf(n.result) || n.reason || 'zero-output'
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
  if (bad.indexOf('contract') >= 0) return 'contract-miss'
  if (bad.indexOf('evidence') >= 0) return 'no-evidence'
  if (bad.indexOf('verdict') >= 0) return 'verdict-fail'
  if (bad.indexOf('cmd') >= 0) return 'cmd-nonzero'
  if (bad.indexOf('noEmpty') >= 0 || bad.indexOf('artifacts') >= 0) return 'zero-output'
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
