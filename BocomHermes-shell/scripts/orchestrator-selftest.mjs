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

console.log('长文档分层汇总(正文超预算 → 分册成稿 + 拼终稿，护汇总上下文):')
let reduceCalls = 0, finalStitchPrompt = ''
const bigRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1
    ? '{"ledger":{"open":["X 口径待定"]},"tasks":[{"id":"a","role":"r","goal":"A"},{"id":"b","role":"r","goal":"B"},{"id":"c","role":"r","goal":"C"}],"done":false}'
    : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') { reduceCalls++; if (m.part === 'final') { finalStitchPrompt = p; return 'STITCHED' } return 'DRAFT' }
  return 'x'.repeat(50)   // 每个 worker 正文 50 字，3 个=150 > 预算 100 → 触发分层
}
const rBig = await orchestrate('大目标', { run: bigRun, maxRounds: 2, taskTimeoutMs: 0, reduceBudgetChars: 100 })
ok(reduceCalls >= 3, '超预算触发分层：分册稿 + 终稿共多次 reduce（实际=' + reduceCalls + '）')
ok(rBig.final === 'STITCHED', '返回终稿拼合结果（非某一分册）')
ok(finalStitchPrompt.includes('X 口径待定'), '账本未决项仍进入终稿（分层不丢未决项）')
const smallRun = async (p, m) => m.kind === 'plan' ? (m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}') : (m.kind === 'reduce' ? 'ONE' : 'tiny')
const rSmall = await orchestrate('小目标', { run: smallRun, maxRounds: 2, taskTimeoutMs: 0 })
ok(rSmall.final === 'ONE', '正文在预算内：仍单次成稿(行为不变)')

console.log('汇总后复核(独立复核→挑问题→修订;通过则不改;缩水兜底;默认关):')
let sawReview = false, sawRevise = false
const revRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return '这是一份足够长的汇总初稿'.repeat(3)
  if (m.kind === 'review') { sawReview = true; return '问题1：X 结论没依据；问题2：Y 段太浅' }
  if (m.kind === 'revise') { sawRevise = true; return '这是修订后的更完整成果'.repeat(3) }
  return 'out'
}
const rRev = await orchestrate('复核修订', { run: revRun, maxRounds: 2, taskTimeoutMs: 0, review: true })
ok(sawReview && sawRevise, '复核发现问题 → 触发修订')
ok(rRev.final.startsWith('这是修订后'), '最终成果=修订稿(非原汇总稿)')
ok(rRev.review.includes('没依据'), '复核意见回传(存档留痕)')

let revised2 = false
const passRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return '已达标的成果'
  if (m.kind === 'review') return '通过'
  if (m.kind === 'revise') { revised2 = true; return 'X' }
  return 'out'
}
const rPass = await orchestrate('复核通过', { run: passRun, maxRounds: 2, taskTimeoutMs: 0, review: true })
ok(!revised2 && rPass.final === '已达标的成果', '复核通过 → 不修订,原稿即终稿(不为改而改)')

let revised3 = false
const shrinkRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return '这是很长的初稿'.repeat(20)
  if (m.kind === 'review') return '问题：这份初稿太长，请精简重写'
  if (m.kind === 'revise') { revised3 = true; return '删到只剩一句' }
  return 'out'
}
const rShrink = await orchestrate('缩水兜底', { run: shrinkRun, maxRounds: 2, taskTimeoutMs: 0, review: true })
ok(revised3 && rShrink.final.startsWith('这是很长的初稿'), '修订稿异常缩水(<40%) → 退回原稿(防又压成摘要)')

const defRun = async (p, m) => m.kind === 'plan' ? (m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}') : (m.kind === 'reduce' ? 'R' : (m.kind === 'review' ? '不该被调用' : 'out'))
const rDef = await orchestrate('默认不复核', { run: defRun, maxRounds: 2, taskTimeoutMs: 0 })
ok(rDef.final === 'R' && rDef.review === '', '核心默认关复核 → final=汇总稿、无复核意见(向后兼容)')

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

console.log('动态规模(规划器按复杂度自估 budget → 突破固定默认 / 夹在安全上限 / 简单早收):')
let sawScale = null
const scaleRun = async (p, m) => {
  if (m.kind === 'plan') return m.round < 6
    ? '{"budget":{"rounds":6,"tasks":20},"tasks":[{"id":"t' + m.round + '","role":"x","goal":"G"}],"done":false}'
    : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return 'R'
  return 'out'
}
const rScale = await orchestrate('复杂多模块分析', { run: scaleRun, maxRounds: 4, maxTasks: 16, taskTimeoutMs: 0, stallBudget: 99, onScale: (i) => { sawScale = i } })
ok(rScale.rounds >= 6, '规划器自估 6 轮 → 突破默认 maxRounds=4(实际=' + rScale.rounds + ')')
ok(sawScale && sawScale.rounds === 6, 'onScale 回调收到动态规模(6 轮)')

const hugeRun = async (p, m) => m.kind === 'plan'
  ? '{"budget":{"rounds":99,"tasks":999},"tasks":[{"id":"h' + m.round + '","role":"x","goal":"G"}],"done":false}'
  : (m.kind === 'reduce' ? 'R' : 'out')
const rHuge = await orchestrate('狮子大开口', { run: hugeRun, maxRoundsCeil: 8, maxTasksCeil: 20, taskTimeoutMs: 0, stallBudget: 99 })
ok(rHuge.rounds <= 8, '规划器估 99 轮被安全上限 8 夹住(实际=' + rHuge.rounds + ')')

const simpleBudgetRun = async (p, m) => m.kind === 'plan'
  ? (m.round === 1 ? '{"budget":{"rounds":1,"tasks":1},"tasks":[{"id":"s","role":"x","goal":"G"}],"done":false}' : '{"tasks":[],"done":true}')
  : (m.kind === 'reduce' ? 'R' : 'out')
const rSimple = await orchestrate('简单', { run: simpleBudgetRun, maxRounds: 4, taskTimeoutMs: 0 })
ok(rSimple.rounds <= 2, '规划器自估 1 轮 → 早收(不硬跑满默认 4 轮,实际=' + rSimple.rounds + ')')

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

console.log('规划器中途挂掉不连坐(已有成果 → 收手汇总,不是整单丢光):')
let planErrRound = 0, reducedWith = ''
const planDieRun = async (p, m) => {
  if (m.kind === 'plan') {
    if (m.round === 1) return '{"tasks":[{"id":"a","role":"r","goal":"A"},{"id":"b","role":"r","goal":"B"}],"done":false}'
    throw new Error('任务超时(连续 20 分钟无任何活动,已中止会话)')   // 第2轮起规划器进网关黑洞,重试也救不回
  }
  if (m.kind === 'reduce') { reducedWith = p; return 'FINAL' }
  return '厚正文-' + m.id
}
const rPlanDie = await orchestrate('目标', { run: planDieRun, maxRounds: 4, taskTimeoutMs: 0, parseRetries: 1, onPlanError: (round) => { planErrRound = round } })
ok(rPlanDie.final === 'FINAL', '规划器挂了仍走到汇总(以前:orchestrate 整个抛,成果全丢)')
ok(rPlanDie.tasks.length === 2 && rPlanDie.tasks.every((t) => t.status === 'ok'), '第1轮的 2 份成果完整保住')
ok(reducedWith.includes('厚正文-a') && reducedWith.includes('厚正文-b'), '两份正文都进了汇总输入')
ok(rPlanDie.stopped === 'plan-failed', 'stopped=plan-failed(存档/UI 能说清为什么没往下拆)')
ok(rPlanDie.rounds === 1, '没排出任务的那轮不计入轮次(实际=' + rPlanDie.rounds + ')')
ok(planErrRound === 2, 'onPlanError 报出失败轮次(UI 据此提示)')
let planCalls = 0
const planFlapRun = async (p, m) => {
  if (m.kind === 'plan') { planCalls++; if (planCalls === 1) throw new Error('网关抖了一下'); return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}' }
  return m.kind === 'reduce' ? 'R' : 'out'
}
const rFlap = await orchestrate('抖', { run: planFlapRun, maxRounds: 2, taskTimeoutMs: 0, parseRetries: 2 })
ok(rFlap.tasks.length === 1, '规划器 run 抛错也会重试(不只重试"JSON 不合法"),抖一下不整单报废')
let firstRoundThrew = null
try { await orchestrate('首轮就挂', { run: async (p, m) => { if (m.kind === 'plan') throw new Error('网关全挂'); return 'x' }, maxRounds: 2, taskTimeoutMs: 0, parseRetries: 0 }) }
catch (e) { firstRoundThrew = e.message }
ok(/网关全挂/.test(firstRoundThrew || ''), '第一轮就挂(一点成果都没有)→ 照旧抛错给上层,不假装成功')

console.log('空产出不冒充成功(黑洞会话静默返回空串):')
let emptyTries = 0
const emptyRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"e","role":"r","goal":"E"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return 'R'
  emptyTries++; return '   '   // 底层轮询在黑洞会话上静默返回空白
}
const rEmpty = await orchestrate('空产出', { run: emptyRun, maxRounds: 2, taskTimeoutMs: 0, taskRetries: 1 })
const eTask = rEmpty.tasks.find((t) => t.task.id === 'e')
ok(eTask.status === 'error', '空产出判 error(以前:status=ok 的空壳,不重试不报错)')
ok(emptyTries === 2, '空产出会重试(实际重试次数=' + (emptyTries - 1) + ')')
ok(/空产出/.test(eTask.output), '错误信息说清是空产出,不是含糊的失败')
let recovered = 0
const emptyThenOkRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"e","role":"r","goal":"E"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return 'R'
  return ++recovered === 1 ? '' : '重试后拿到的真产出'
}
const rRec = await orchestrate('空后恢复', { run: emptyThenOkRun, maxRounds: 2, taskTimeoutMs: 0, taskRetries: 1 })
ok(rRec.tasks[0].output === '重试后拿到的真产出', '首次空、重试拿到真产出 → 记 ok')

console.log('上游失败不当素材喂给下游:')
let bPrompt = ''
const depFailRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"抓数据"},{"id":"b","role":"r","goal":"据a写报告","deps":["a"]}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return 'R'
  if (m.id === 'a') throw new Error('网关 502')
  bPrompt = p; return 'B产出'
}
await orchestrate('上游失败', { run: depFailRun, taskRetries: 0, taskTimeoutMs: 0, maxRounds: 2 })
ok(!/【a】/.test(bPrompt), '失败的上游不进【可参考的上游结果】(以前把"(error：网关502)"当上游产出喂下去)')
ok(/上游失败告知/.test(bPrompt) && /a\(error\)/.test(bPrompt), '改为显式告知下游:上游 a 失败了')
ok(/不要臆造/.test(bPrompt), '明确要求别臆造上游本该给的内容(治"看着完整、实则编造")')
let cPrompt = ''
const mixRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"},{"id":"b","role":"r","goal":"B"},{"id":"c","role":"r","goal":"C","deps":["a","b"]}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return 'R'
  if (m.id === 'a') throw new Error('挂了')
  if (m.id === 'c') { cPrompt = p; return 'C' }
  return 'B的正文'
}
await orchestrate('混合', { run: mixRun, taskRetries: 0, taskTimeoutMs: 0, maxRounds: 2, maxConcurrency: 2 })
ok(/【b】[\s\S]*B的正文/.test(cPrompt) && !/【a】/.test(cPrompt), '一成一败:成功的照常进上下文,只有失败的被摘出去单独告知')

console.log('分层汇总兜住"单份正文就超预算"(装箱对它无能为力):')
const seen = []
const oneHugeRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"},{"id":"b","role":"r","goal":"B"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') { seen.push(p.length); return 'D' }
  return m.id === 'a' ? 'x'.repeat(1000) : '短'   // 单份 1000 > 预算 200:切片前"那一箱=它自己",照样灌爆
}
await orchestrate('单份巨型', { run: oneHugeRun, maxRounds: 2, taskTimeoutMs: 0, reduceBudgetChars: 200 })
const worst = Math.max(...seen)
ok(worst < 1000, '没有任何一次 reduce 吃进整份 1000 字巨型正文(最大一次=' + worst + ')')
const onlyHugeRun = async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') { seen2.push(p.length); return 'D' }
  return 'y'.repeat(1000)
}
let seen2 = []
await orchestrate('独苗巨型', { run: onlyHugeRun, maxRounds: 2, taskTimeoutMs: 0, reduceBudgetChars: 200 })
ok(Math.max(...seen2) < 1000, '只有一个子任务、但它自己就超预算 → 也切片(以前 entries.length<=1 直接放行灌爆)')

console.log('复核"通过"判定不被中文介词骗到:')
let revisedCalled = false
const prepRun = (review) => async (p, m) => {
  if (m.kind === 'plan') return m.round === 1 ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : '{"tasks":[],"done":true}'
  if (m.kind === 'reduce') return '初稿'
  if (m.kind === 'review') return review
  if (m.kind === 'revise') { revisedCalled = true; return '修订稿(足够长足够长足够长足够长足够长足够长足够长足够长)' }
  return 'out'
}
revisedCalled = false
const rPrep = await orchestrate('介词', { run: prepRun('通过阅读各子任务产出,我发现三处关键遗漏:\n1. 缺少表结构\n2. 没有回滚方案\n3. 结论无依据'), maxRounds: 2, taskTimeoutMs: 0, review: true })
ok(revisedCalled && rPrep.final !== '初稿', '"通过阅读…发现三处遗漏"是介词不是结论 → 必须触发修订(以前 /^通过/ 命中,挑出的问题被整个跳过)')
revisedCalled = false
const rColon = await orchestrate('冒号', { run: prepRun('复核结果：通过'), maxRounds: 2, taskTimeoutMs: 0, review: true })
ok(!revisedCalled && rColon.final === '初稿', '"复核结果：通过"仍认作达标,不做无谓修订')

console.log('人审等待可被中止(不再永久卡死):')
const acWait = new AbortController()
let finallyRan = false
const waitRun = async (p, m) => m.kind === 'plan' ? '{"tasks":[{"id":"a","role":"r","goal":"A"}],"done":false}' : (m.kind === 'reduce' ? 'R' : 'out')
const pWait = orchestrate('人审', { run: waitRun, signal: acWait.signal, maxRounds: 2, taskTimeoutMs: 0,
  onBeforeBatch: () => new Promise(() => {}) })   // 宿主的审批 promise 只由"用户点批准"解决 —— 用户点的却是「停止」
  .then((r) => { finallyRan = true; return r })
setTimeout(() => acWait.abort(), 120)
const rWait = await Promise.race([pWait, sleep(3000).then(() => 'HUNG')])
ok(rWait !== 'HUNG' && finallyRan, '审批卡挂着时点停止 → 编排立刻收手(以前永久 hang,run 的 finally 不执行、会话与注册表全泄漏)')
ok(rWait.stopped === 'aborted', '收手原因=aborted')

console.log(`\n小结：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
