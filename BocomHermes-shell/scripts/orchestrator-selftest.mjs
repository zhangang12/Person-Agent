// 编排器自测（假 run，不连真模型）。用法： node scripts/orchestrator-selftest.mjs
import orch from '../orchestrator.js'
const { orchestrate, extractJson, sanitizePlan } = orch

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

console.log('extractJson:')
ok(extractJson('<think>想想</think>```json\n{"tasks":[],"done":true}\n```')?.done === true, '剥 <think> + 围栏')
ok(extractJson('废话 {"tasks":[{"goal":"x"}],"done":false} 尾巴')?.tasks?.length === 1, '裸 {...} 抽取')
ok(extractJson('完全不是 json') === null, '垃圾返回 null')

console.log('sanitizePlan（去重/去自依赖/去未知依赖/去环）:')
const sp = sanitizePlan([
  { id: 'a', goal: 'A' }, { id: 'a', goal: 'A2' }, { id: 'b', goal: 'B', deps: ['b'] },
  { id: 'c', goal: 'C', deps: ['zzz', 'a'] }, { id: 'd', goal: 'D', deps: ['e'] }, { id: 'e', goal: 'E' },
], ['prev'])
ok(sp[1].id === 'a_', '重复 id 自动改名')
ok(sp.find((t) => t.id === 'b').deps.length === 0, '自依赖被去掉')
ok(JSON.stringify(sp.find((t) => t.id === 'c').deps) === '["a"]', '未知依赖 zzz 去掉、保留 a')
ok(sp.find((t) => t.id === 'd').deps.length === 0, '前向依赖(d→e,e在后)去掉=不会成环')
ok(sanitizePlan([{ id: 'k', goal: 'K', deps: ['prev'] }], ['prev'])[0].deps[0] === 'prev', '依赖已完成的往轮任务予以保留')

console.log('orchestrate（并发/依赖/重规划/汇总）:')
let active = 0, maxActive = 0; const startedAt = {}
const fakeRun = async (prompt, meta) => {
  if (meta.kind === 'plan') return meta.round === 1
    ? '<think>规划</think>\n```json\n' + JSON.stringify({ tasks: [{ id: 'a', role: 'analyst', goal: 'A' }, { id: 'b', role: 'analyst', goal: 'B' }, { id: 'c', role: 'writer', goal: 'C', deps: ['a'] }], done: false }) + '\n```'
    : '{"tasks":[],"done":true}'
  if (meta.kind === 'reduce') return 'FINAL'
  startedAt[meta.id] = Date.now(); active++; maxActive = Math.max(maxActive, active); await sleep(60); active--; return '产出-' + meta.id
}
const res = await orchestrate('测试目标', { run: fakeRun, maxConcurrency: 2 })
ok(res.tasks.length === 3, '跑了 3 个子任务')
ok(maxActive <= 2, '并发不超上限(2)，峰值=' + maxActive)
ok(startedAt['c'] >= startedAt['a'], 'c 在依赖 a 之后才开始')
ok(res.done && res.rounds === 2, '第 2 轮 done 收尾')
ok(res.final === 'FINAL', 'reduce 被调用')
ok(res.tasks.every((t) => t.status === 'ok'), '每个任务有 ok 状态')

console.log('坏依赖净化（不死锁）:')
const stuckRun = async (p, m) => m.kind === 'plan' ? (m.round === 1 ? '{"tasks":[{"id":"x","goal":"X","deps":["不存在"]}],"done":false}' : '{"tasks":[],"done":true}') : (m.kind === 'reduce' ? 'DONE' : 'out')
const r2 = await orchestrate('坏依赖', { run: stuckRun, maxRounds: 2 })
ok(r2.tasks.find((t) => t.task.id === 'x')?.output === 'out', '坏依赖被净化、任务照常跑')
ok(r2.final === 'DONE', '仍走到 reduce')

console.log('每任务超时:')
const slowRun = async (p, m) => m.kind === 'plan' ? (m.round === 1 ? '{"tasks":[{"id":"slow","goal":"S"}],"done":false}' : '{"tasks":[],"done":true}') : (m.kind === 'reduce' ? 'R' : new Promise(() => {}))
const rt = await orchestrate('超时', { run: slowRun, taskTimeoutMs: 200, taskRetries: 0, maxRounds: 2 })
ok(rt.tasks.find((t) => t.task.id === 'slow')?.status === 'timeout', '卡住的任务被超时标记，不挂死')

console.log('失败重试:')
let attempts = 0
const flapRun = async (p, m) => { if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"f","goal":"F"}],"done":false}' : '{"tasks":[],"done":true}'; if (m.kind === 'reduce') return 'R'; attempts++; if (attempts === 1) throw new Error('一过性'); return 'ok-after-retry' }
const rr = await orchestrate('重试', { run: flapRun, taskRetries: 1, taskTimeoutMs: 0, maxRounds: 2 })
ok(rr.tasks.find((t) => t.task.id === 'f')?.output === 'ok-after-retry', '失败一次后重试成功')

console.log('可中止:')
const ac = new AbortController(); ac.abort()
const r3 = await orchestrate('中止', { run: async (p, m) => m.kind === 'plan' ? '{"tasks":[{"id":"x","goal":"X"}],"done":false}' : 'y', signal: ac.signal, maxRounds: 2 })
ok(r3.stopped === 'aborted' && r3.tasks.length === 0, '已中止：不规划不跑任务')

console.log('人审检查点:')
const apRun = async (p, m) => m.kind === 'plan' ? (m.round === 1 ? '{"tasks":[{"id":"p1","goal":"P"}],"done":false}' : '{"tasks":[],"done":true}') : (m.kind === 'reduce' ? 'R' : 'out')
let asked = 0
const rApprove = await orchestrate('审批通过', { run: apRun, maxRounds: 2, onBeforeBatch: async (round, tasks) => { asked++; return { tasks } } })
ok(asked >= 1 && rApprove.tasks.find((t) => t.task.id === 'p1')?.output === 'out', '批准后任务执行')
const rReject = await orchestrate('审批拒绝', { run: apRun, maxRounds: 2, onBeforeBatch: async () => ({ abort: true }) })
ok(rReject.stopped === 'aborted' && rReject.tasks.length === 0, '拒绝则中止、不执行')

console.log('动态人设(现编 role 进 work 提示 + grounding):')
let workPrompt = ''
const personaRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1
    ? '{"tasks":[{"id":"x","role":"专盯账务一致性的挑刺审计员","goal":"查账"}],"done":false}'
    : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return 'R'
  workPrompt = p; return 'out'
}
await orchestrate('人设', { run: personaRun, maxRounds: 2 })
ok(workPrompt.includes('专盯账务一致性的挑刺审计员'), '现编人设进入子任务提示词(非固定角色)')
ok(/读代码|查库|核实/.test(workPrompt), '子任务被要求用工具核实(grounding，不靠猜)')

console.log('任务账本跨轮累积:')
let plan2Prompt = ''
const ledgerRun = async (p, m) => {
  if (m.kind === 'plan') {
    if (m.round === 1) return '{"ledger":{"facts":["loan_limit.status 是枚举"],"open":["宽限期口径未定"]},"tasks":[{"id":"a","role":"勘察","goal":"A"}],"done":false}'
    plan2Prompt = p; return '{"tasks":[],"done":true}'
  }
  if (m.kind === 'reduce') return 'R'
  return 'out'
}
await orchestrate('账本', { run: ledgerRun, maxRounds: 3 })
ok(plan2Prompt.includes('loan_limit.status 是枚举'), '第2轮规划看到上轮账本的已确认事实')
ok(plan2Prompt.includes('宽限期口径未定'), '第2轮规划看到上轮账本的未决项')

console.log('账本未决项进入汇总:')
let reducePrompt = ''
const redRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"ledger":{"open":["谁来定计息口径"]},"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') { reducePrompt = p; return 'R' }
  return 'out'
}
await orchestrate('汇总未决', { run: redRun, maxRounds: 2 })
ok(reducePrompt.includes('谁来定计息口径'), '账本未决项被带进 reduce(不藏掉)')

console.log('停滞计数(连续无进展即收手，不空转):')
const stallRun = async (p, m) => {
  if (m.kind === 'plan') return '{"tasks":[{"id":"z","role":"r","goal":"Z"}],"done":false}'   // 永远还想拆
  if (m.kind === 'reduce') return 'R'
  throw new Error('永远失败')                                                                  // 任务永远错
}
const rs = await orchestrate('停滞', { run: stallRun, maxRounds: 6, taskRetries: 0, taskTimeoutMs: 0, stallBudget: 2 })
ok(rs.stopped === 'stalled', '连续 2 轮无进展 → 停滞收手')
ok(rs.rounds === 2, '停滞在第 2 轮收手(不耗满 maxRounds=6)')

console.log('简单目标直接收尾(scale-to-complexity):')
const trivialRun = async (p, m) => m.kind === 'plan' ? '{"tasks":[],"done":true}' : (m.kind === 'reduce' ? 'ANSWER' : 'x')
const rtv = await orchestrate('几点了', { run: trivialRun })
ok(rtv.done && rtv.tasks.length === 0 && rtv.rounds === 1, '简单目标第1轮即 done、不拆任务')

console.log('超时元数据下传 + 耗时回调 + 规划旁白:')
let seenTimeoutMs = null, seenDoneMs = null, seenNote = ''
const metaRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"note":"先勘察再动手","tasks":[{"id":"m1","role":"r","goal":"M"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return 'R'
  seenTimeoutMs = m.timeoutMs; return 'out'
}
const rMeta = await orchestrate('元数据', { run: metaRun, taskTimeoutMs: 12345, maxRounds: 2,
  onPlan: (round, plan) => { if (round === 1) seenNote = plan.note },
  onTaskDone: (t, out, st, ms) => { seenDoneMs = ms } })
ok(seenTimeoutMs === 12345, 'run 收到 meta.timeoutMs=taskTimeoutMs(生产端据此收割超时僵尸会话)')
ok(typeof seenDoneMs === 'number' && seenDoneMs >= 0, 'onTaskDone 第 4 参带 ms 耗时(UI 时间线用)')
ok(seenNote === '先勘察再动手', '规划器 note 旁白透出(UI 叙事行用)')
ok(rMeta.done, '流程正常收尾')

console.log(`\n小结：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
