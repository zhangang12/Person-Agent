// 天枢 · 动态工作流编排核心（路线 A：LLM 生成图 + 代码带护栏执行 + 按结果重规划）
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
const summarize = (results) => {
  const arr = [...results.values()]
  if (!arr.length) return '（暂无）'
  return arr.map((r) => `- [${r.task.id}] ${r.task.goal}（${r.status}）\n  摘要：${clip(r.output, 280)}`).join('\n')
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
    try { return await withTimeout(Promise.resolve(run(prompt, { ...meta, attempt: i, signal: opts.signal })), opts.taskTimeoutMs) }
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

// ---- 提示词 ----
function buildPlanPrompt(goal, doneSummary, maxBatch) {
  return [
    '你是一个任务规划器。请把大目标拆解成可并行/可依赖的子任务。',
    '总目标：' + goal,
    '已完成子任务及结果摘要：\n' + doneSummary,
    '',
    `请只输出"还需要做的下一批子任务"(<=${maxBatch} 个)。严格只输出 JSON，不要解释、不要 markdown、不要 <think>：`,
    '{"tasks":[{"id":"短id","role":"角色如 analyst/coder/writer/reviewer","goal":"具体做什么","deps":["同批依赖id，可空"]}],"done":false}',
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
  return ['总目标：' + goal, '以下是各子任务产出，请汇总成一份连贯、完整、去重的最终成果：', parts].join('\n\n')
}

// ---- 规划一轮（容错解析 + 重试 + 净化）----
async function planOnce(run, goal, doneSummary, knownIds, opts) {
  const base = buildPlanPrompt(goal, doneSummary, opts.maxBatch)
  for (let i = 0; i <= opts.parseRetries; i++) {
    const text = await runGuarded(run, i === 0 ? base : base + '\n\n（上次未输出合法 JSON，请严格只输出 JSON 对象）', { kind: 'plan', round: opts._round }, opts, 0)
    const j = extractJson(text)
    if (j && Array.isArray(j.tasks)) return { tasks: sanitizePlan(j.tasks, knownIds), done: !!j.done }
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
        const ctx = (t.deps || []).filter((d) => results.has(d)).map((d) => `【${d}】\n${clip(results.get(d).output, 800)}`).join('\n\n')
        const t0 = Date.now()
        runGuarded(run, buildWorkPrompt(t, ctx, opts.goal), { kind: 'work', role: t.role, id: t.id }, opts, opts.taskRetries)
          .then((out) => { results.set(t.id, { task: t, output: out, status: 'ok', ms: Date.now() - t0 }); opts.onTaskDone && opts.onTaskDone(t, out, 'ok') })
          .catch((e) => {
            const st = /超时|timeout/i.test(e && e.message || '') ? 'timeout' : (aborted(opts) ? 'aborted' : 'error')
            results.set(t.id, { task: t, output: '(' + st + '：' + (e && e.message || e) + ')', status: st, ms: Date.now() - t0 })
            opts.onTaskError && opts.onTaskError(t, e, st)
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
    taskTimeoutMs: 180000, taskRetries: 1, maxElapsedMs: 0, signal: null,
    onPlan: null, onTaskStart: null, onTaskDone: null, onTaskError: null, onRound: null,
    ...options, goal,
  }
  if (typeof opts.run !== 'function') throw new Error('orchestrate 需要 opts.run(prompt, meta)')
  const results = new Map()
  const t0 = Date.now()
  let round = 0, total = 0, done = false, unmet = [], stopped = null
  while (round < opts.maxRounds) {
    if (aborted(opts)) { stopped = 'aborted'; break }
    if (opts.maxElapsedMs && Date.now() - t0 > opts.maxElapsedMs) { stopped = 'time-budget'; break }
    round++; opts._round = round
    const plan = await planOnce(opts.run, goal, summarize(results), [...results.keys()], opts)
    opts.onPlan && opts.onPlan(round, plan)
    if (plan.done || plan.tasks.length === 0) { done = true; break }
    const room = Math.max(0, opts.maxTasks - total)
    if (room === 0) { stopped = 'task-budget'; break }
    let batch = plan.tasks.slice(0, room)
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
    if (total >= opts.maxTasks) { stopped = 'task-budget'; break }
  }
  let final = ''
  if (!aborted(opts)) { try { final = await runGuarded(opts.run, buildReducePrompt(goal, results), { kind: 'reduce' }, opts, 0) } catch (e) { final = '(汇总失败：' + (e && e.message || e) + ')' } }
  return { goal, rounds: round, done, stopped, tasks: [...results.values()], unmet, final, elapsedMs: Date.now() - t0 }
}

// ---- 生产适配：一次 run = 一个 opencode 会话发一条消息取回文本 ----
function openCodeRunner(oc, serve) {
  return async (prompt, meta) => {
    const sid = await oc.createSession(serve, '编排:' + (meta && meta.kind || 'task') + (meta && meta.id ? ':' + meta.id : ''))
    if (!sid) throw new Error('createSession 失败')
    return await oc.sendMessage(serve, sid, prompt)
  }
}

module.exports = { orchestrate, planOnce, runDag, extractJson, sanitizePlan, summarize, openCodeRunner }
