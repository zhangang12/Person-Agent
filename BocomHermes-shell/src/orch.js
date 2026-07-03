'use strict'

module.exports = function initOrch(S, { ipcMain, oc, orch, log }) {
  ipcMain.on('abort-workflow', (e) => {
    const w = S.workflows.get(e.sender.id); if (w) { try { w.ac.abort() } catch {} }
  })

  ipcMain.on('wf-approve', (e, { reqId, decision, auto }) => {
    const w = S.workflows.get(e.sender.id); if (!w) return
    if (auto) w.auto = true
    const r = w.approvals.get(reqId); if (r) { w.approvals.delete(reqId); r(decision) }
  })

  ipcMain.handle('run-workflow', async (e, goal) => {
    const wc = e.sender
    const dir = S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)
    const ac = new AbortController()
    const entry = { ac, serve, sessions: new Set(), approvals: new Map(), auto: false }
    S.workflows.set(wc.id, entry)
    const send = (type, payload) => { if (!wc.isDestroyed()) wc.send('wf-event', { type, ...payload }) }

    // 人审检查点：每批计划先发给卡片等批准（卡片可一键切"自动"）
    const onBeforeBatch = (round, tasks) => new Promise((resolve) => {
      if (entry.auto) return resolve({ tasks })
      const reqId = 'ap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
      entry.approvals.set(reqId, (decision) => resolve(decision === 'abort' ? { abort: true } : { tasks }))
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
      const res = await orch.orchestrate(goal, {
        run, signal: ac.signal, maxConcurrency: 2, maxRounds: 4, maxTasks: 16, maxBatch: 5, taskTimeoutMs: 240000, onBeforeBatch,
        onPlan: (round, plan) => send('plan', { round, done: plan.done, tasks: plan.tasks.map((t) => ({ id: t.id, role: t.role, goal: t.goal, deps: t.deps })) }),
        onTaskStart: (t) => send('task', { id: t.id, status: 'running' }),
        onTaskDone: (t, out) => send('task', { id: t.id, status: 'ok', chars: (out || '').length }),
        onTaskError: (t, err, st) => send('task', { id: t.id, status: st || 'error', error: String(err && err.message || err) }),
      })
      send('final', { final: res.final, stopped: res.stopped, done: res.done, rounds: res.rounds, elapsedMs: res.elapsedMs, unmet: res.unmet })
      return { ok: true }
    } catch (err) {
      send('error', { error: String(err && err.message || err) })
      return { ok: false }
    } finally {
      for (const s of entry.sessions) S.sessionInfo.delete(s)
      S.workflows.delete(wc.id)
    }
  })
}
