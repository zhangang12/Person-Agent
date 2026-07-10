// BocomHermes · 动态工作流编排核心（路线 A：LLM 生成图 + 代码带护栏执行 + 按结果重规划）
// 设计要点：
//  · 纯逻辑、可单测 —— 不直接依赖 opencode，靠注入的 run(prompt, meta) 跑一个"子智能体"。
//  · 每个子任务 = 一次独立 run（生产里 = 一个 opencode 会话 / 各自 128k）。跨任务只传结果摘要。
//  · 动态：每轮 Planner 看目标 + 已完成结果，决定"下一批子任务"或收尾(done)。
//  · 产品级护栏：并发上限、轮数/任务数/耗时预算、每任务超时、失败重试、计划净化(去环/去重/去坏依赖)、
//    可中止(AbortSignal)、解析失败重试、可观测回调、每任务状态(ok/error/timeout)。
//  · 结构化输出实测不可靠 → 一律"提示只输出 JSON + 容错解析(剥 <think>) + 重试"。

// ---- 容错 JSON 解析：先剥 <think>，再试 ```json 围栏 / 整段 / 第一个 {...} ----
function extractJson(text) {
  let t = String(text || '')
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<\/?think>/gi, ' ')
  const cands = []
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) cands.push(fence[1])
  cands.push(t)
  const brace = t.match(/\{[\s\S]*\}/); if (brace) cands.push(brace[0])
  for (const c of cands) { try { return JSON.parse(c.trim()) } catch {} }
  return null
}

const clip = (s, n = 600) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s }
// 尾部截取:worker 按约定把【交接】要点写在结尾 —— 给 planner/下游传摘要时取尾部,交接段不被截丢
const tailClip = (s, n = 600) => { s = String(s == null ? '' : s); return s.length > n ? '…' + s.slice(-n) : s }
const arr = (x) => Array.isArray(x) ? x.map((v) => String(v)).filter(Boolean) : []
const summarize = (results) => {
  const arr = [...results.values()]
  if (!arr.length) return '（暂无）'
  return arr.map((r) => `- [${r.task.id}] ${r.task.goal}（${r.status}）\n  摘要：${tailClip(r.output, 280)}`).join('\n')
}
const aborted = (opts) => !!(opts.signal && opts.signal.aborted)

// 超时包装：ms<=0 不限时
function withTimeout(p, ms) {
  if (!ms || ms <= 0) return Promise.resolve(p)
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('任务超时(' + Math.round(ms / 1000) + 's)')), ms)
    Promise.resolve(p).then((v) => { clearTimeout(to); resolve(v) }, (e) => { clearTimeout(to); reject(e) })
  })
}
// 带超时 + 重试 的一次运行
async function runGuarded(run, prompt, meta, opts, retries) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    if (aborted(opts)) throw new Error('已中止')
    try { return await withTimeout(Promise.resolve(run(prompt, { ...meta, attempt: i, signal: opts.signal, timeoutMs: opts.taskTimeoutMs })), opts.taskTimeoutMs) }   // timeoutMs 下传:生产 run 据此在编排超时后掐掉底层会话(否则僵尸生成 + 重试双跑)
    catch (e) { lastErr = e; if (aborted(opts)) throw e }
  }
  throw lastErr
}

// ---- 计划净化：去重 id、去自依赖、去未知依赖、按列出顺序保证无环(只允许依赖更早的任务) ----
function sanitizePlan(tasks, knownIds) {
  const known = new Set(knownIds)
  const out = []
  const batchIds = new Set()
  for (const raw of tasks) {
    if (!raw || !raw.goal) continue
    let id = String(raw.id || ('t' + (out.length + 1)))
    while (batchIds.has(id) || known.has(id)) id += '_'
    batchIds.add(id)
    out.push({ id, role: raw.role || 'worker', goal: String(raw.goal), deps: Array.isArray(raw.deps) ? raw.deps.map(String) : [] })
  }
  const pos = new Map(out.map((t, i) => [t.id, i]))
  for (const t of out) {
    t.deps = t.deps.filter((d) => d !== t.id && (known.has(d) || (pos.has(d) && pos.get(d) < pos.get(t.id))))  // 去环：只许依赖更早的
  }
  return out
}

// ---- 角色引导语：仅作兜底种子；规划器会为每个子任务"现编"一句话人设，未命中下表时直接用现编的 ----
const ROLE_PROMPTS = {
  analyst:   '你是一名需求分析师。职责：梳理业务逻辑、识别边界条件与潜在歧义、澄清需求意图。',
  architect: '你是一名软件架构师。职责：设计模块边界与交互方式、选择技术方案、确保可扩展性与可维护性。',
  coder:     '你是一名高级开发工程师。职责：编写高质量、可读、可测的代码，实现具体功能，注重边界处理与异常路径。',
  tester:    '你是一名测试工程师。职责：设计测试用例（含正常路径与边界场景）、识别潜在缺陷、给出测试代码或测试清单。',
  reviewer:  '你是一名代码评审专家。职责：审查代码质量与逻辑正确性，给出分级建议（必改/建议/可忽略）并附修改方案。',
  writer:    '你是一名技术文档工程师。职责：撰写清晰准确的技术文档、注释或说明，读者是有一定技术基础的工程师。',
  worker:    '你是一个通用任务执行者。',
}

// ---- 提示词 ----
function ledgerText(ledger) {
  if (!ledger || !(arr(ledger.facts).length || arr(ledger.open).length || arr(ledger.assumptions).length)) return '任务账本(Task Ledger)：（空，这是第一轮）'
  return [
    '任务账本(Task Ledger，按真实发现累积，规划时据此判断)：',
    '· 已确认事实：' + (arr(ledger.facts).join('；') || '（暂无）'),
    '· 待查 / 未决：' + (arr(ledger.open).join('；') || '（暂无）'),
    '· 假设(未证实)：' + (arr(ledger.assumptions).join('；') || '（暂无）'),
  ].join('\n')
}
function buildPlanPrompt(goal, doneSummary, ledger, maxBatch) {
  return [
    '你是一个动态工作流规划器。把"还需要做的下一批子任务"拆出来——但只拆该拆的。',
    '总目标：' + goal,
    ledgerText(ledger),
    '已完成子任务及结果摘要：\n' + doneSummary,
    '',
    '规划原则(务必遵守)：',
    '1. 按复杂度伸缩：简单目标不要拆，给 1 个任务、甚至直接 done；只有复杂且可分解的才多拆。',
    '2. 拆解必须"划算"——每个子任务要么换来真并行(彼此独立、能同时跑)，要么换来独立视角(如实现方 vs 挑刺评审)；否则合并成一个，别为拆而拆。',
    '3. role 为这个子任务"现编"一句话人设(贴着任务本身，不要套通用头衔)。',
    '4. 看账本与上轮结果、按真实发现规划下一批，不要一次排满；够了就 done:true。',
    '5. 子任务都能用工具读代码/查库——让它们去核实，别靠猜。',
    '6. 上轮有 error/timeout 的任务：判断是换方案重派、拆小一点、还是绕开；不要原样重复失败任务。',
    '7. 目标要能落地：涉及代码/配置的子任务，goal 里点到文件或模块级（下游拿到就能动手）。',
    '8. 高风险产出(代码改动/关键结论)：后续轮安排【独立验证/评审】任务交叉校验，不要让产出方自证。',
    '',
    `只输出 JSON(下一批 <=${maxBatch} 个任务)，不要解释 / markdown / <think>：`,
    '{"ledger":{"facts":["据已完成结果更新的已确认事实"],"open":["仍未决的问题"],"assumptions":["未证实的假设"]},"note":"一句话说人话：本轮为什么这么拆(或为什么收尾)","tasks":[{"id":"短id","role":"现编的一句话人设","goal":"具体做什么","deps":["同批依赖id，可空"]}],"done":false}',
    '若目标已可收尾、无需更多子任务，输出：{"ledger":{...},"note":"收尾理由","tasks":[],"done":true}',
  ].join('\n')
}
function buildWorkPrompt(task, ctx, goal) {
  const known = ROLE_PROMPTS[task.role]
  const roleHint = known || ('你现在的角色：' + task.role + '。请完全代入这个角色的视角与职责。')
  return [
    roleHint,
    '总目标：' + goal,
    '你的子任务：' + task.goal,
    ctx ? '可参考的上游结果：\n' + ctx : '',
    '请完成这个子任务并直接给出结果。务必用你的工具读代码 / 查库去核实，不要凭空猜测。',
    '结尾必须有一节「【交接】」：用 3-5 行要点写清 关键结论 / 产出位置(文件路径、命令、数据) / 给下游的提醒 —— 下游任务与规划器主要看这一节。',
  ].filter(Boolean).join('\n')
}
function buildReducePrompt(goal, results, ledger) {
  const parts = [...results.values()].map((r) => `## [${r.task.id}] ${r.task.goal}\n${r.output}`).join('\n\n')
  const open = ledger && arr(ledger.open).length ? '\n\n仍未决 / 待澄清(请在结尾单列，不要藏掉)：\n- ' + arr(ledger.open).join('\n- ') : ''
  return ['总目标：' + goal, '以下是各子任务产出，请汇总成一份连贯、完整、去重的最终成果(有冲突要点明，不要简单拼接)。保留各任务给出的文件路径/命令/数据等可执行细节，结论先行：', parts + open].join('\n\n')
}

// ---- 规划一轮（容错解析 + 重试 + 净化）----
async function planOnce(run, goal, doneSummary, ledger, knownIds, opts) {
  const base = buildPlanPrompt(goal, doneSummary, ledger, opts.maxBatch)
  for (let i = 0; i <= opts.parseRetries; i++) {
    const text = await runGuarded(run, i === 0 ? base : base + '\n\n（上次未输出合法 JSON，请严格只输出 JSON 对象）', { kind: 'plan', round: opts._round }, opts, 0)
    const j = extractJson(text)
    if (j && Array.isArray(j.tasks)) {
      const nextLedger = (j.ledger && typeof j.ledger === 'object')
        ? { facts: arr(j.ledger.facts), open: arr(j.ledger.open), assumptions: arr(j.ledger.assumptions) }
        : ledger
      return { tasks: sanitizePlan(j.tasks, knownIds), done: !!j.done, ledger: nextLedger, note: typeof j.note === 'string' ? j.note.slice(0, 200) : '' }   // note=规划器叙事(一句话思路),UI 当旁白展示
    }
  }
  throw new Error('Planner 未产出合法任务图(JSON)')
}

// ---- 执行一批：拓扑就绪 + 并发上限 + 中止 + 死锁不挂死 ----
function runDag(run, batch, results, opts) {
  const byId = new Map(batch.map((t) => [t.id, t]))
  const pending = new Set(batch.map((t) => t.id))
  let active = 0, settled = false
  return new Promise((resolve) => {
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const tick = () => {
      if (settled) return
      if (aborted(opts) && active === 0) return done({ unmet: [...pending], aborted: true })
      if (pending.size === 0 && active === 0) return done({ unmet: [] })
      if (!aborted(opts)) for (const id of [...pending]) {
        if (active >= opts.maxConcurrency) break
        const t = byId.get(id)
        if (!(t.deps || []).every((d) => results.has(d))) continue
        pending.delete(id); active++
        opts.onTaskStart && opts.onTaskStart(t)
        const ctx = (t.deps || []).filter((d) => results.has(d)).map((d) => `【${d}】\n${tailClip(results.get(d).output, 800)}`).join('\n\n')   // 尾部截取:上游【交接】段在结尾,不被截丢
        const t0 = Date.now()
        runGuarded(run, buildWorkPrompt(t, ctx, opts.goal), { kind: 'work', role: t.role, id: t.id }, opts, opts.taskRetries)
          .then((out) => { const ms = Date.now() - t0; results.set(t.id, { task: t, output: out, status: 'ok', ms }); opts.onTaskDone && opts.onTaskDone(t, out, 'ok', ms) })
          .catch((e) => {
            const ms = Date.now() - t0
            const st = /超时|timeout/i.test(e && e.message || '') ? 'timeout' : (aborted(opts) ? 'aborted' : 'error')
            results.set(t.id, { task: t, output: '(' + st + '：' + (e && e.message || e) + ')', status: st, ms })
            opts.onTaskError && opts.onTaskError(t, e, st, ms)
          })
          .finally(() => { active--; tick() })
      }
      if (!settled && pending.size > 0 && active === 0) done({ unmet: [...pending] })  // 依赖死锁兜底
    }
    tick()
  })
}

// ---- 主编排 ----
async function orchestrate(goal, options) {
  const opts = {
    maxConcurrency: 3, maxRounds: 4, maxTasks: 20, maxBatch: 6, parseRetries: 2,
    taskTimeoutMs: 180000, taskRetries: 1, maxElapsedMs: 0, stallBudget: 2, signal: null,
    onPlan: null, onTaskStart: null, onTaskDone: null, onTaskError: null, onRound: null,
    ...options, goal,
  }
  if (typeof opts.run !== 'function') throw new Error('orchestrate 需要 opts.run(prompt, meta)')
  const results = new Map()
  const t0 = Date.now()
  let round = 0, total = 0, done = false, unmet = [], stopped = null, stall = 0
  let ledger = { facts: [], open: [], assumptions: [] }       // 任务账本：跨轮累积，replan 据此(Magentic-One 思路)
  while (round < opts.maxRounds) {
    if (aborted(opts)) { stopped = 'aborted'; break }
    if (opts.maxElapsedMs && Date.now() - t0 > opts.maxElapsedMs) { stopped = 'time-budget'; break }
    round++; opts._round = round
    const plan = await planOnce(opts.run, goal, summarize(results), ledger, [...results.keys()], opts)
    ledger = plan.ledger || ledger
    if (plan.done || plan.tasks.length === 0) { opts.onPlan && opts.onPlan(round, { ...plan, tasks: [] }); done = true; break }   // 收尾轮:不播任务(done+非空 tasks 时那些任务不会执行,播出去=UI 幽灵节点)
    const room = Math.max(0, opts.maxTasks - total)
    if (room === 0) { opts.onPlan && opts.onPlan(round, { ...plan, tasks: [], plannedTotal: plan.tasks.length }); stopped = 'task-budget'; break }
    let batch = plan.tasks.slice(0, room)
    // onPlan 只播【实际排程的批】:plan.tasks 可能被任务预算截断,播全量会让 UI 出现永不执行的幽灵 pending 节点
    opts.onPlan && opts.onPlan(round, { ...plan, tasks: batch, plannedTotal: plan.tasks.length })
    if (opts.onBeforeBatch) {                                  // 人审检查点：批准/编辑/中止
      const d = await opts.onBeforeBatch(round, batch)
      if (aborted(opts) || (d && d.abort)) { stopped = 'aborted'; break }
      if (d && Array.isArray(d.tasks)) batch = sanitizePlan(d.tasks, [...results.keys()])
      if (!batch.length) { done = true; break }               // 一个都不批 → 收尾
    }
    total += batch.length
    const r = await runDag(opts.run, batch, results, opts)
    unmet = r.unmet || []
    opts.onRound && opts.onRound(round, { batch, unmet, aborted: !!r.aborted })
    if (r.aborted) { stopped = 'aborted'; break }
    // 停滞计数(Magentic-One)：本轮一个都没成功 → 累计；连续卡住到预算就收手，避免空转死板
    const okThisRound = batch.filter((t) => { const x = results.get(t.id); return x && x.status === 'ok' }).length
    stall = okThisRound > 0 ? 0 : stall + 1
    if (stall >= opts.stallBudget) { stopped = 'stalled'; break }
    if (total >= opts.maxTasks) { stopped = 'task-budget'; break }
  }
  let final = ''
  if (!aborted(opts)) { try { final = await runGuarded(opts.run, buildReducePrompt(goal, results, ledger), { kind: 'reduce' }, opts, 0) } catch (e) { final = '(汇总失败：' + (e && e.message || e) + ')' } }
  return { goal, rounds: round, done, stopped, tasks: [...results.values()], unmet, ledger, final, elapsedMs: Date.now() - t0 }
}

// ---- 生产适配：一次 run = 一个 opencode 会话发一条消息取回文本 ----
// meta.timeoutMs(runGuarded 下传)在编排超时后 +2s 收割底层会话:不掐的话僵尸继续生成 + 重试双跑。
// 主产品路径(src/orch.js)有自己更完整的 run(空转看门狗);这里是导出 API/脚本用的最小正确版。
function openCodeRunner(oc, serve) {
  return async (prompt, meta) => {
    const sid = await oc.createSession(serve, '编排:' + (meta && meta.kind || 'task') + (meta && meta.id ? ':' + meta.id : ''))
    if (!sid) throw new Error('createSession 失败')
    let reap = null
    if (meta && meta.timeoutMs > 0) reap = setTimeout(() => { try { oc.abort(serve, sid) } catch {} }, meta.timeoutMs + 2000)
    try { return await oc.sendMessage(serve, sid, prompt) }
    finally { if (reap) clearTimeout(reap) }
  }
}

module.exports = { orchestrate, planOnce, runDag, extractJson, sanitizePlan, summarize, openCodeRunner }
