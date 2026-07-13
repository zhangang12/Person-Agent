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
  return arr.map((r) => `- [${r.task.id}] ${r.task.goal}（${r.status}）\n  摘要：${tailClip(r.output, 600)}`).join('\n')   // 尾部 600:容得下完整【交接】段(3-5 行),规划器据此拆下一批 —— 太短(如 280)会截掉交接、让规划变笨
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
    '1. 【先估规模,按复杂度伸缩】先判断整个总目标的复杂度,估算大概需要几轮、总共几个子任务(Agent),写进 budget 字段——规模由你按目标定,不是固定的:简单目标 1 个 Agent、1 轮甚至直接 done;复杂的多模块分析才多轮多 Agent。后续轮若发现比预想更复杂/更简单,可在 budget 里上调或下调(系统会夹在安全上限内)。',
    '2. 【模块化 MECE】每个子任务对应一个边界清晰、彼此不重叠的模块 / 职责,这一批合起来对总目标做到"不遗漏、不重复"。拆解要"划算":要么换真并行(彼此独立能同时跑),要么换独立视角(实现方 vs 挑刺评审);否则合并,别为拆而拆。',
    '3. 【连贯推进】用账本(ledger)把已确认事实 / 未决问题串起来,每一轮都基于上一轮的真实结果往前走——不另起炉灶、不重复已做过的、不丢上一轮的线索;够了就 done:true。',
    '4. role 为这个子任务"现编"一句话人设(贴着任务本身,不要套通用头衔)。',
    '5. 子任务都能用工具读代码/查库——让它们去核实,别靠猜。',
    '6. 上轮有 error/timeout 的任务:判断是换方案重派、拆小一点、还是绕开;不要原样重复失败任务。',
    '7. 目标要能落地:涉及代码/配置的子任务,goal 里点到文件或模块级(下游拿到就能动手)。',
    '8. 高风险产出(代码改动/关键结论):后续轮安排【独立验证/评审】任务交叉校验,不要让产出方自证。',
    '9. 【控上下文】你(规划器)自己别深读:轻量勘察结构就够(glob/grep、至多读几个入口/关键文件了解全貌),深读与核实一律交给子任务在各自独立上下文里做,绝不派探索子agent通读整个目录/几百个文件把你自己撑爆;同时给每个子任务的范围也要收敛(看哪个模块、产出什么),别派范围过宽的任务让它自己读爆。',
    '',
    `只输出 JSON(本轮新增 <=${maxBatch} 个任务;budget 是你对【整个目标】的规模估计,不是本轮),不要解释 / markdown / <think>：`,
    '{"budget":{"rounds":预计总轮次,"tasks":预计总子任务数},"ledger":{"facts":["据已完成结果更新的已确认事实"],"open":["仍未决的问题"],"assumptions":["未证实的假设"]},"note":"一句话说人话:本轮为什么这么拆、规模为什么这么估(或为什么收尾)","tasks":[{"id":"短id","role":"现编的一句话人设","goal":"具体做什么","deps":["同批依赖id,可空"]}],"done":false}',
    '若目标已可收尾、无需更多子任务,输出:{"budget":{...},"ledger":{...},"note":"收尾理由","tasks":[],"done":true}',
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
    '请交付一份【完整、可直接使用】的成果，不是提要。要求：',
    '· 用你的工具读代码 / 查库去核实，不要凭空猜测；结论要贴出证据(文件路径、函数/表名、代码片段、命令、数据)。',
    '· 读文件要克制：先 grep/glob 定位，再只读相关文件与相关段落；别为"求全"通读整目录 / 几百个文件 —— 读越多你的上下文越会被撑爆，产出反而变薄变乱。确需大范围勘察，就派一个【边界清晰的聚焦子任务/子agent】(只看什么、只产出什么)在独立上下文里做，别把几百个文件糊进自己的上下文。',
    '· 该给代码就给可运行的代码/改动，该给设计就给带取舍的完整方案，该给分析就给有依据的结构化结论 —— 把事情写透，别只写一句"结论是 X"。',
    '· 篇幅服务于说清楚：宁可详实、可落地，也不要为了简短丢细节。这份【正文】会被最终汇总完整读取，是你真正的产出。',
    '结尾另起一节「【交接】」：3-5 行要点，只作【规划器 / 后续任务】的快速索引 —— 关键结论 / 产出位置(文件路径、命令、数据) / 给下游的提醒。交接是索引，不能替代上面的正文。',
  ].filter(Boolean).join('\n')
}
function buildReducePrompt(goal, results, ledger) {
  const parts = [...results.values()].map((r) => `## [${r.task.id}] ${r.task.goal}\n${r.output}`).join('\n\n')
  const open = ledger && arr(ledger.open).length ? '\n\n仍未决 / 待澄清(请在结尾单列，不要藏掉)：\n- ' + arr(ledger.open).join('\n- ') : ''
  return [
    '总目标：' + goal,
    '下面是各子任务的完整产出。请据此【撰写最终成果】—— 这是用户直接阅读、并据以行动的成品，不是给别人看的会议纪要。要求：',
    '· 这是"写成品"不是"做摘要"：把各子任务的实质内容整合成一份连贯、完整、可直接落地的交付物，正文展开写透，不要压成要点提要。',
    '· 保留全部可执行细节：文件路径、函数/表名、代码片段、命令、配置、数据、数字，一个都不能因"精简"而丢；该带的代码/方案原样带上。',
    '· 整合而非拼接：消除重复、合并同类；子任务之间有冲突或分歧要明确点出并给判断，不要藏。',
    '· 结构清晰：先给结论 / TL;DR，再按主题用小标题展开完整内容；需要时用列表、表格、代码块。',
    '· 若发现关键结论未核实、或产出之间有明显空白，可用工具读代码 / 查库补齐后再下笔 —— 但要克制：只按需读关键文件，别为补空白又通读一堆文件把自己的上下文也撑爆；你的职责是产出成品，不是重新探索。',
    '',
    '各子任务产出：',
    parts + open,
  ].join('\n')
}
// ---- 汇总(长度感知,保护汇总会话自己的上下文)----
// 正文总量在预算内 → 单次成稿(与原行为一致)。超预算 → 分层:按预算分组,每组各自只看【本组全文】合成一份"分册稿"(不丢细节),
// 再把各分册稿拼成终稿。避免十几份厚正文一次性灌爆汇总会话 → 又被压回摘要(那正是"探索很细、产出很薄"的一个根)。每层都走 buildReducePrompt(写成品,不做摘要)。
async function synthesize(run, goal, results, ledger, opts) {
  const entries = [...results.values()]
  const total = entries.reduce((n, r) => n + ((r.output && r.output.length) || 0), 0)
  const budget = opts.reduceBudgetChars > 0 ? opts.reduceBudgetChars : 60000
  const retries = opts.reduceRetries >= 0 ? opts.reduceRetries : 1
  if (entries.length <= 1 || total <= budget) return await runGuarded(run, buildReducePrompt(goal, results, ledger), { kind: 'reduce' }, opts, retries)
  const groups = []; let cur = [], curN = 0
  for (const r of entries) {
    const c = (r.output && r.output.length) || 0
    if (cur.length && curN + c > budget) { groups.push(cur); cur = []; curN = 0 }   // 贪心装箱:每箱正文量不超预算
    cur.push(r); curN += c
  }
  if (cur.length) groups.push(cur)
  opts.onReduce && opts.onReduce({ tier: 'split', groups: groups.length, totalChars: total })
  const drafts = []
  for (let i = 0; i < groups.length; i++) {
    const gMap = new Map(groups[i].map((r) => [r.task.id, r]))
    const d = await runGuarded(run, buildReducePrompt(goal, gMap, null), { kind: 'reduce', part: i + 1 }, opts, retries)   // 分册稿:未决项(ledger.open)留到终稿单列,不每册重复
    drafts.push({ task: { id: 'seg' + (i + 1), goal: '分册合成稿 ' + (i + 1) + '/' + groups.length }, output: String(d || ''), status: 'ok' })
  }
  return await runGuarded(run, buildReducePrompt(goal, new Map(drafts.map((d) => [d.task.id, d])), ledger), { kind: 'reduce', part: 'final' }, opts, retries)
}

// ---- 汇总后复核:独立复核员对照总目标与子任务原始产出审终稿,挑真问题;有问题则据此修订,通过则原样留(不为改而改)。----
// 保护:复核/修订任一步失败或空产出、或修订稿异常缩水(疑似又压成摘要) → 一律退回已成稿,绝不把成果搞没或搞薄。
function buildReviewPrompt(goal, results, draft) {
  const refs = [...results.values()].map((r) => `- [${r.task.id}] ${r.task.goal}（${r.status}）\n  要点：${tailClip(r.output, 600)}`).join('\n')
  return [
    '你是最终成果的【复核员】。对照总目标与各子任务要点，审下面这份【待复核成果】，只挑真问题。',
    '总目标：' + goal,
    '逐条查(有就写 问题 + 具体位置 + 怎么补;整体达标就只回一行"通过")：',
    '· 遗漏：子任务里有、但成果漏掉的关键结论 / 文件路径 / 命令 / 数据 / 代码。',
    '· 没依据：成果里的结论在子任务里找不到支撑(疑似编造)——可用工具抽查关键点是否属实，但别通读一堆文件把自己上下文撑爆。',
    '· 矛盾：子任务的分歧被含糊带过、未消解。',
    '· 太浅：该展开的地方只有一句话、缺可落地细节。',
    '',
    '各子任务要点(依据)：\n' + refs,
    '',
    '待复核成果：\n' + draft,
  ].join('\n')
}
function buildRevisePrompt(goal, draft, review) {
  return [
    '总目标：' + goal,
    '下面是一份【最终成果】和复核员挑出的【问题清单】。请据清单把成果修订好，输出【修订后的完整最终成果】。',
    '要求：逐条落实问题(补齐遗漏、删掉没依据的、消解矛盾、写深太浅处)；其余正确内容【原样保留，不得删减或压缩】；仍是可直接用的成品，结论先行、结构清晰、保留全部可执行细节。',
    '',
    '【问题清单】：\n' + review,
    '',
    '【最终成果(待修订)】：\n' + draft,
  ].join('\n')
}
async function reviewAndRevise(run, goal, results, draft, opts) {
  const retries = opts.reduceRetries >= 0 ? opts.reduceRetries : 1
  const review = String(await runGuarded(run, buildReviewPrompt(goal, results, draft), { kind: 'review' }, opts, retries) || '')
  const passed = /^\s*(通过|pass\b)/i.test(review.trim()) || review.trim().length < 8   // 复核员开头判"通过"(或空产出)→ 视为达标,不修订
  opts.onReview && opts.onReview({ passed, review })
  if (passed) return { final: draft, review, passed: true }
  const revised = String(await runGuarded(run, buildRevisePrompt(goal, draft, review), { kind: 'revise' }, opts, retries) || '').trim()
  if (!revised || revised.length < draft.length * 0.4) return { final: draft, review, passed: false }   // 空产出 / 异常缩水 → 退回原稿,别把成品搞没或压回摘要
  return { final: revised, review, passed: false }
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
      const budget = (j.budget && typeof j.budget === 'object')   // 规划器按复杂度自估的【整目标】规模:轮次/Agent 数;编排层据此动态设上限(夹在安全区间内)
        ? { rounds: Math.round(+j.budget.rounds) || 0, tasks: Math.round(+j.budget.tasks) || 0 } : null
      return { tasks: sanitizePlan(j.tasks, knownIds), done: !!j.done, ledger: nextLedger, note: typeof j.note === 'string' ? j.note.slice(0, 200) : '', budget }   // note=规划器叙事(一句话思路),UI 当旁白展示
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
    maxRoundsCeil: 8, maxTasksCeil: 32,   // 动态规模的【安全上限】:规划器按复杂度自估 budget,编排层夹在 [1, ceil] 内 —— 复杂任务能放大到这里,但不失控
    taskTimeoutMs: 180000, taskRetries: 1, maxElapsedMs: 0, stallBudget: 2, signal: null,
    reduceBudgetChars: 60000, reduceRetries: 1,   // 汇总:正文总量超预算走分层;终稿给 1 次重试(汇总失败=整单没成果,别一抖就废)
    review: false,   // 汇总后复核:核心默认关(导出 API/脚本向后兼容);产品端 src/orch.js 打开
    onPlan: null, onTaskStart: null, onTaskDone: null, onTaskError: null, onRound: null, onReduce: null, onReview: null, onScale: null,
    ...options, goal,
  }
  if (typeof opts.run !== 'function') throw new Error('orchestrate 需要 opts.run(prompt, meta)')
  const results = new Map()
  const t0 = Date.now()
  let round = 0, total = 0, done = false, unmet = [], stopped = null, stall = 0
  let ledger = { facts: [], open: [], assumptions: [] }       // 任务账本：跨轮累积，replan 据此(Magentic-One 思路)
  let effRounds = opts.maxRounds, effTasks = opts.maxTasks     // 动态规模:初值=默认;规划器给了 budget 就据此调整(夹在 [1, maxRoundsCeil/maxTasksCeil]),不再被固定数框死
  while (round < effRounds) {
    if (aborted(opts)) { stopped = 'aborted'; break }
    if (opts.maxElapsedMs && Date.now() - t0 > opts.maxElapsedMs) { stopped = 'time-budget'; break }
    round++; opts._round = round
    const plan = await planOnce(opts.run, goal, summarize(results), ledger, [...results.keys()], opts)
    ledger = plan.ledger || ledger
    if (plan.budget) {   // 规划器按复杂度自估规模 → 动态调本次运行的轮次/Agent 上限(夹在安全区间[1,ceil]);后续轮可上调/下调
      if (plan.budget.rounds > 0) effRounds = Math.min(opts.maxRoundsCeil, Math.max(1, plan.budget.rounds))
      if (plan.budget.tasks > 0) effTasks = Math.min(opts.maxTasksCeil, Math.max(1, plan.budget.tasks))
      opts.onScale && opts.onScale({ round, rounds: effRounds, tasks: effTasks, complexity: plan.note || '' })
    }
    if (plan.done || plan.tasks.length === 0) { opts.onPlan && opts.onPlan(round, { ...plan, tasks: [] }); done = true; break }   // 收尾轮:不播任务(done+非空 tasks 时那些任务不会执行,播出去=UI 幽灵节点)
    const room = Math.max(0, effTasks - total)
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
    if (total >= effTasks) { stopped = 'task-budget'; break }
  }
  let final = '', reviewNote = ''
  if (!aborted(opts)) {
    let draft = ''
    try { draft = await synthesize(opts.run, goal, results, ledger, opts) } catch (e) { draft = '(汇总失败：' + (e && e.message || e) + ')' }
    final = draft
    // 汇总后复核:独立复核员挑问题 → 据问题修订(通过则不改)。复核/修订失败绝不丢掉已成稿(退回 draft)。
    if (opts.review && draft && !/^\(汇总失败/.test(draft) && !aborted(opts)) {
      try { const rr = await reviewAndRevise(opts.run, goal, results, draft, opts); final = rr.final; reviewNote = rr.review } catch (e) { final = draft }
    }
  }
  return { goal, rounds: round, done, stopped, tasks: [...results.values()], unmet, ledger, final, review: reviewNote, elapsedMs: Date.now() - t0 }
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
