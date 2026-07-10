'use strict'

module.exports = function initOrch(S, { ipcMain, oc, orch, log, app, path, fs }) {
  ipcMain.on('abort-workflow', (e) => {
    const w = S.workflows.get(e.sender.id); if (!w) return
    try { w.ac.abort() } catch {}
    // 真停:同时中止所有在飞的 opencode 会话 —— 只停编排循环的话,进行中的子任务会继续烧网关到超时(240s)
    for (const s of w.sessions) { try { oc.abort(w.serve, s) } catch {} }
  })

  ipcMain.on('wf-approve', (e, { reqId, decision, auto, keepIds }) => {
    const w = S.workflows.get(e.sender.id); if (!w) return
    if (auto) w.auto = true
    const r = w.approvals.get(reqId); if (r) { w.approvals.delete(reqId); r({ decision, keepIds: Array.isArray(keepIds) ? keepIds.map(String) : null }) }
  })

  ipcMain.handle('run-workflow', async (e, goal, wfId) => {
    const wc = e.sender
    const dir = S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)
    const ac = new AbortController()
    const entry = { ac, serve, sessions: new Set(), approvals: new Map(), auto: false }
    S.workflows.set(wc.id, entry)
    const send = (type, payload) => { if (!wc.isDestroyed()) wc.send('wf-event', { type, ...payload }) }
    // 成果注册表:工作流不再是一次性 —— 运行态/成果按 id 可查(orch-mcp workflow_result),Agent 事后能取回继续用
    const rid = String(wfId || wc.id)
    S.wfRegistry = S.wfRegistry || new Map()
    const reg = { id: rid, goal, status: 'running', round: 0, at: Date.now(), archive: null, final: '', rounds: 0, elapsedMs: 0 }
    S.wfRegistry.set(rid, reg)

    // 人审检查点:每批计划先发卡片等批准(可一键切"自动";可勾掉个别任务只跑保留的;全不勾=收尾汇总)
    const onBeforeBatch = (round, tasks) => new Promise((resolve) => {
      reg.round = round
      if (entry.auto) return resolve({ tasks })
      const reqId = 'ap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
      entry.approvals.set(reqId, (reply) => {
        if (!reply || reply.decision === 'abort') return resolve({ abort: true })
        resolve({ tasks: reply.keepIds ? tasks.filter((t) => reply.keepIds.includes(t.id)) : tasks })
      })
      send('plan-approve', { reqId, round, count: tasks.length, tasks: tasks.map((t) => ({ id: t.id, role: t.role, goal: t.goal, deps: t.deps })) })
    })

    // 每个子任务 = 一个 opencode 会话；登记到 sessionInfo 让其权限/事件路由到这张工作流卡
    const run = async (prompt, meta) => {
      const sid = await oc.createSession(serve, '编排:' + (meta && meta.kind || 'task') + (meta && meta.id ? ':' + meta.id : ''), dir)   // 工作流子任务跑在选定的项目目录
      if (!sid) throw new Error('createSession 失败')
      // tag=任务身份 → session.js 随 card-stream 下发,workflow 窗按 DAG 节点分组(worker 的 tag.id 即节点 id,与 wf-event 'task' 的 ev.id 对齐)
      S.sessionInfo.set(sid, { wc, serve, tag: { scope: 'wf', kind: (meta && meta.kind) || 'work', id: (meta && meta.id) || ((meta && meta.kind) || 'task'), role: (meta && meta.role) || '', round: (meta && meta.round) || 0 } }); entry.sessions.add(sid)
      try { return await oc.sendMessage(serve, sid, prompt, S.settings.model) }   // 工作流子任务用全局默认模型
      finally { S.sessionInfo.delete(sid); entry.sessions.delete(sid); S.streamBuf.delete(sid) }
    }

    try {
      // 工作目录锚:让规划器/子任务都知道该在哪个项目里核实(子任务会话本就跑在 dir,这里给规划层同一事实)
      const goalFull = dir ? goal + '\n(工作目录:' + dir + ' —— 子任务应用工具在此目录内核实,不要访问其它项目)' : goal
      const res = await orch.orchestrate(goalFull, {
        run, signal: ac.signal, maxConcurrency: 2, maxRounds: 4, maxTasks: 16, maxBatch: 5, taskTimeoutMs: 240000, onBeforeBatch,
        onPlan: (round, plan) => send('plan', { round, done: plan.done, tasks: plan.tasks.map((t) => ({ id: t.id, role: t.role, goal: t.goal, deps: t.deps })) }),
        onTaskStart: (t) => send('task', { id: t.id, status: 'running' }),
        // 产出随事件带给前端(截 2500):点 DAG 节点即可看该任务的实际产出,不用等最终汇总
        onTaskDone: (t, out) => send('task', { id: t.id, status: 'ok', chars: (out || '').length, output: String(out || '').slice(0, 2500) }),
        onTaskError: (t, err, st) => send('task', { id: t.id, status: st || 'error', error: String(err && err.message || err) }),
      })
      // 成果落盘存档:关窗不丢、可追溯、Agent 经 workflow_result 取回全文继续用
      let archive = null
      try {
        const dirW = path.join(app.getPath('userData'), 'workflows')
        fs.mkdirSync(dirW, { recursive: true })
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
        const slug = String(goal).slice(0, 24).replace(/[\\/:*?"<>|\s]+/g, '_') || 'wf'
        archive = path.join(dirW, stamp + '_' + rid + '_' + slug + '.md')
        const taskLines = res.tasks.map((r) => `- [${r.task.id} · ${r.task.role}] ${r.task.goal}(${r.status}${r.ms ? ' · ' + Math.round(r.ms / 1000) + 's' : ''})`).join('\n')
        fs.writeFileSync(archive, `# 工作流:${goal}\n\n- id:${rid} · 轮次:${res.rounds} · 用时:${Math.round((res.elapsedMs || 0) / 1000)}s${res.stopped ? ' · 提前收尾:' + res.stopped : ''}\n\n## 子任务\n${taskLines || '(无)'}\n\n## 最终成果\n\n${res.final || '(无)'}\n`)
      } catch (e2) { log('wf archive err: ' + e2.message) }
      Object.assign(reg, { status: res.stopped === 'aborted' ? 'aborted' : 'done', final: String(res.final || ''), archive, rounds: res.rounds, elapsedMs: res.elapsedMs })
      send('final', { final: res.final, stopped: res.stopped, done: res.done, rounds: res.rounds, elapsedMs: res.elapsedMs, unmet: res.unmet, archive })
      return { ok: true }
    } catch (err) {
      reg.status = 'error'; reg.final = String(err && err.message || err)
      send('error', { error: String(err && err.message || err) })
      return { ok: false }
    } finally {
      for (const s of entry.sessions) S.sessionInfo.delete(s)
      S.workflows.delete(wc.id)
      // 注册表只留最近 50 条,防长跑内存 + 存档目录本身是全量留痕
      if (S.wfRegistry.size > 50) { const k = S.wfRegistry.keys().next().value; S.wfRegistry.delete(k) }
    }
  })
}
