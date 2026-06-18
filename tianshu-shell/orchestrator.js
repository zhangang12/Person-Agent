// 天枢 · 动态工作流编排核心（路线 A：LLM 生成图 + 代码带护栏执行 + 按结果重规划）
// 设计要点：
//  · 纯逻辑、可单测 —— 不直接依赖 opencode，靠注入的 run(prompt, meta) 跑一个"子智能体"。
//    生产用 openCodeRunner() 包一层 opencode 会话；测试用假 run 即可。
//  · 每个子任务 = 一次独立 run（生产里 = 一个 opencode 会话 / 各自 128k 上下文）。
//    跨任务只传"结果摘要"，不传全量，避免上下文爆掉。
//  · 动态：每一轮 Planner 看到目标 + 已完成结果，决定"下一批子任务"或收尾(done)。
//  · 护栏：并发上限、轮数上限、任务总数预算、依赖死锁不挂死、解析失败重试。
//  · 结构化输出实测不可靠(json_schema 被接受但模型不产出) → 一律"提示只输出 JSON + 容错解析 + 重试"。

// ---- 容错 JSON 解析：先剥 <think> 思维块，再试 ```json 围栏 / 整段 / 第一个 {...} ----
function extractJson(text) {
  let t = String(text || '')
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<\/?think>/gi, ' ')   // bocomcode 模型会吐 <think>
  const cands = []
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) cands.push(fence[1])
  cands.push(t)
  const brace = t.match(/\{[\s\S]*\}/); if (brace) cands.push(brace[0])   // 第一个 { 到最后一个 }
  for (const c of cands) { try { return JSON.parse(c.trim()) } catch {} }
  return null
}

const clip = (s, n = 600) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s }
const summarize = (results) => {
  const arr = [...results.values()]
  if (!arr.length) return '（暂无）'
  return arr.map((r) => `- [${r.task.id}] ${r.task.goal}\n  结果摘要：${clip(r.output, 280)}`).join('\n')
}

// ---- 提示词 ----
function buildPlanPrompt(goal, doneSummary, maxBatch) {
  return [
    '你是一个任务规划器。请把大目标拆解成可并行/可依赖的子任务。',
    '总目标：' + goal,
    '已完成子任务及结果摘要：\n' + doneSummary,
    '',
    `请只输出"还需要做的下一批子任务"(<=${maxBatch} 个)。严格只输出 JSON，不要解释、不要 markdown 代码块、不要 <think>：`,
    '{"tasks":[{"id":"短横线id","role":"角色如 analyst/coder/writer/reviewer","goal":"这个子任务具体做什么","deps":["同批依赖的id，没有就空数组"]}],"done":false}',
    '若目标已可收尾、无需更多子任务，请输出：{"tasks":[],"done":true}',
  ].join('\n')
}
function buildWorkPrompt(task, ctx, goal) {
  return [
    '总目标：' + goal,
    '你的角色：' + (task.role || 'worker'),
    '你的子任务：' + task.goal,
    ctx ? '可参考的上游结果：\n' + ctx : '',
    '请完成这个子任务并直接给出结果（可用你的工具读代码/查文件）。',
  ].filter(Boolean).join('\n')
}
function buildReducePrompt(goal, results) {
  const parts = [...results.values()].map((r) => `## [${r.task.id}] ${r.task.goal}\n${r.output}`).join('\n\n')
  return [
    '总目标：' + goal,
    '以下是各子任务的产出，请汇总成一份连贯、完整、去重的最终成果：',
    parts,
  ].join('\n\n')
}

// ---- 规划一轮（带容错解析 + 重试）----
async function planOnce(run, goal, doneSummary, opts) {
  const base = buildPlanPrompt(goal, doneSummary, opts.maxBatch)
  for (let i = 0; i <= opts.parseRetries; i++) {
    const text = await run(i === 0 ? base : base + '\n\n（上次未输出合法 JSON，请严格只输出 JSON 对象）', { kind: 'plan', round: opts._round })
    const j = extractJson(text)
    if (j && Array.isArray(j.tasks)) {
      let n = 0
      const tasks = j.tasks.filter((t) => t && t.goal).map((t) => ({
        id: String(t.id || ('t' + (++n))), role: t.role || 'worker', goal: String(t.goal),
        deps: Array.isArray(t.deps) ? t.deps.map(String) : [],
      }))
      return { tasks, done: !!j.done }
    }
  }
  throw new Error('Planner 未产出合法任务图(JSON)')
}

// ---- 执行一批任务：拓扑就绪 + 并发上限；依赖未满足不挂死 ----
function runDag(run, batch, results, opts) {
  const byId = new Map(batch.map((t) => [t.id, t]))
  const pending = new Set(batch.map((t) => t.id))
  let active = 0, settled = false
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (settled) return
      if (pending.size === 0 && active === 0) { settled = true; return resolve({ unmet: [] }) }
      for (const id of [...pending]) {
        if (active >= opts.maxConcurrency) break
        const t = byId.get(id)
        if (!(t.deps || []).every((d) => results.has(d))) continue   // 依赖(同批已完成 或 往轮已在 results)未就绪
        pending.delete(id); active++
        opts.onTaskStart && opts.onTaskStart(t)
        const ctx = (t.deps || []).filter((d) => results.has(d)).map((d) => `【${d}】\n${clip(results.get(d).output, 800)}`).join('\n\n')
        Promise.resolve(run(buildWorkPrompt(t, ctx, opts.goal), { kind: 'work', role: t.role, id: t.id }))
          .then((out) => { results.set(t.id, { task: t, output: out }); opts.onTaskDone && opts.onTaskDone(t, out) })
          .catch((e) => { results.set(t.id, { task: t, output: '(失败：' + (e && e.message || e) + ')', error: true }); opts.onTaskError && opts.onTaskError(t, e) })
          .finally(() => { active--; tick() })
      }
      // 还有 pending 但没人在跑、也没人能就绪 → 依赖死锁，别挂死，带 unmet 返回
      if (!settled && pending.size > 0 && active === 0) { settled = true; resolve({ unmet: [...pending] }) }
    }
    tick()
  })
}

// ---- 主编排：规划 → 执行 → 重规划 …… → 汇总 ----
async function orchestrate(goal, options) {
  const opts = {
    maxConcurrency: 3, maxRounds: 4, maxTasks: 20, maxBatch: 6, parseRetries: 2,
    onPlan: null, onTaskStart: null, onTaskDone: null, onTaskError: null, onRound: null,
    ...options, goal,
  }
  if (typeof opts.run !== 'function') throw new Error('orchestrate 需要 opts.run(prompt, meta)')
  const results = new Map()
  let round = 0, total = 0, done = false, unmet = []
  while (round < opts.maxRounds) {
    round++; opts._round = round
    const plan = await planOnce(opts.run, goal, summarize(results), opts)
    opts.onPlan && opts.onPlan(round, plan)
    if (plan.done || plan.tasks.length === 0) { done = true; break }
    const room = Math.max(0, opts.maxTasks - total)
    if (room === 0) break
    const batch = plan.tasks.slice(0, room)
    total += batch.length
    const r = await runDag(opts.run, batch, results, opts)
    unmet = r.unmet || []
    opts.onRound && opts.onRound(round, { batch, unmet })
    if (total >= opts.maxTasks) break
  }
  const final = await opts.run(buildReducePrompt(goal, results), { kind: 'reduce' })
  return { goal, rounds: round, done, tasks: [...results.values()], unmet, final }
}

// ---- 生产适配：把一次 run 映射成"一个 opencode 会话发一条消息取回文本" ----
// oc = require('./opencode'); serve = await oc.ensureServe(dir, handlers)
function openCodeRunner(oc, serve, agentByKind) {
  return async (prompt, meta) => {
    const title = '编排:' + (meta && meta.kind || 'task') + (meta && meta.id ? ':' + meta.id : '')
    const sid = await oc.createSession(serve, title)
    if (!sid) throw new Error('createSession 失败')
    return await oc.sendMessage(serve, sid, prompt)
  }
}

module.exports = { orchestrate, planOnce, runDag, extractJson, summarize, openCodeRunner }
