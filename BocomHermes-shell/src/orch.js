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
      // 超时策略(为什么还要有"超时"):内网网关慢是常态,按墙钟杀会专杀正常慢任务 —— 所以【不按墙钟】。
      // 判据换成"空转":只要会话还有任何流活动(工具调用/文本增量,si.lastAt 由 session.js 打点),再慢也一直等;
      // 连续 IDLE_MS 一个事件都没有 = 黑洞(会话卡死/网关黑洞),才掐掉判超时 → 编排层照常走重试/重规划。
      // 不设的代价:一个黑洞任务会让整个 DAG 永远不结束,用户只能手动停止 —— 这就是"超时"存在的唯一理由。
      const IDLE_MS = 1200000          // 常规:20 分钟空转才判死(容得下慢网关一次 15 分钟重试风暴)
      const IDLE_MS_HOTREAD = 360000   // 高读会话:6 分钟 —— 读了一大堆文件又彻底安静,几乎必是上下文被撑爆、模型调用卡死(不是"慢"),快判快重试(可调)
      const started = Date.now()
      let watchdog = null
      const idleDeath = new Promise((_, rej) => {
        watchdog = setInterval(() => {
          const si = S.sessionInfo.get(sid)
          if (si && si.awaitPerm > 0) return   // 正在等人批准工具(session.js onPermission 记的账)——这不是空转,别把"用户去吃饭"当黑洞杀掉;用户随时可点停止
          const last = (si && si.lastAt) || started
          // 该会话各上下文单元里读得最多的一个:高读=溢出嫌疑大,缩短空转容忍。还在读/还在出文本的会一直刷新 lastAt → 不会被误杀,只杀"读一堆后彻底安静"的卡死会话
          let reads = 0
          if (si && si.readStat) for (const rs of si.readStat.values()) if (rs.parts && rs.parts.size > reads) reads = rs.parts.size
          const idleLimit = reads >= 60 ? IDLE_MS_HOTREAD : IDLE_MS
          if (Date.now() - last > idleLimit) {
            clearInterval(watchdog); watchdog = null
            try { oc.abort(serve, sid) } catch {}
            const why = reads >= 60
              ? '读了 ' + reads + ' 个文件后连续 ' + Math.round(idleLimit / 60000) + ' 分钟无响应(疑似上下文被撑爆、模型调用卡死)'
              : '连续 ' + Math.round(idleLimit / 60000) + ' 分钟无任何活动'
            log('wf 空转看门狗:会话 ' + sid + '(' + ((meta && meta.kind || 'work') + ':' + (meta && meta.id || '')) + ')' + why + ',已中止')
            rej(new Error('任务超时(' + why + ',已中止会话)'))
          }
        }, 20000)
      })
      idleDeath.catch(() => {})   // race 输掉(任务正常结束)时不产生 unhandled rejection
      // 墙钟收割保留为备用保险丝:仅当上游显式传 timeoutMs(taskTimeoutMs>0)才武装;默认 0 = 不按墙钟杀慢任务
      let reap = null
      if (meta && meta.timeoutMs > 0) reap = setTimeout(() => { try { oc.abort(serve, sid); log('wf 墙钟收割会话 ' + sid) } catch {} }, meta.timeoutMs + 2000)
      // 重试自知:让模型知道上次被超时/出错中止,这次少绕路直奔目标
      const pfx = meta && meta.attempt > 0 ? '(上一次尝试因超时/出错被中止,这是第 ' + (meta.attempt + 1) + ' 次执行:请更直接地完成目标,减少探索性步骤)\n\n' : ''
      try { return await Promise.race([oc.sendMessage(serve, sid, pfx + prompt, S.settings.model), idleDeath]) }   // 工作流子任务用全局默认模型
      finally { if (watchdog) clearInterval(watchdog); if (reap) clearTimeout(reap); S.sessionInfo.delete(sid); entry.sessions.delete(sid); S.streamBuf.delete(sid); S.dropPendingPerm && S.dropPendingPerm(sid) }   // 未答的审批记录一并清:会话都没了,那条 pendingPerm 永远等不到回复
    }

    try {
      // 工作目录锚:让规划器/子任务都知道该在哪个项目里核实(子任务会话本就跑在 dir,这里给规划层同一事实)。
      // 【动态工作流 = 纯多 Agent 拆解复杂任务】,与「任务编排」(单 Agent 顺序串业务链)是两回事,不在这里塞
      // skill_run/doc_read/mail_send 之类的"业务链积木提示" —— 那属于任务编排卡(见 window.js PIPELINE_RULES)。
      const goalFull = dir ? goal + '\n(工作目录:' + dir + ' —— 子任务应用工具在此目录内核实,不要访问其它项目)' : goal
      const res = await orch.orchestrate(goalFull, {
        // taskTimeoutMs:0 = 不按墙钟杀(内网网关慢是常态,慢≠死);超时判定改由 run() 的空转看门狗负责
        run, signal: ac.signal, maxConcurrency: 2, maxRounds: 4, maxTasks: 16, maxBatch: 5, maxRoundsCeil: 8, maxTasksCeil: 32, taskTimeoutMs: 0, review: true, onBeforeBatch,
        // maxRounds/maxTasks=规划器没自估时的默认;规划器给了 budget 就动态调整,夹在 maxRoundsCeil/maxTasksCeil(8轮/32Agent)内 —— 复杂任务放得开、简单任务早收,不再被固定 4/16 框死
        onPlan: (round, plan) => send('plan', { round, done: plan.done, note: plan.note || '', tasks: plan.tasks.map((t) => ({ id: t.id, role: t.role, goal: t.goal, deps: t.deps })) }),
        // 规划器重试完仍挂:已有成果 → 编排层收手去汇总(不再连坐丢光)。这里要让用户看见"为什么没继续拆下去",别静默少跑几轮
        onPlanError: (round, err) => { try { log('wf 规划器第 ' + round + ' 轮失败:' + String(err && err.message || err) + ' —— 已有成果,收手汇总(不丢已跑完的子任务)'); send('plan-failed', { round, error: String(err && err.message || err) }) } catch {} },
        onTaskStart: (t) => send('task', { id: t.id, status: 'running' }),
        // 产出随事件带给前端(截 2500):点 DAG 节点即可看该任务的实际产出,不用等最终汇总;ms=耗时给时间线
        onTaskDone: (t, out, st, ms) => send('task', { id: t.id, status: 'ok', chars: (out || '').length, ms: ms || 0, output: String(out || '').slice(0, 2500) }),
        onTaskError: (t, err, st, ms) => send('task', { id: t.id, status: st || 'error', ms: ms || 0, error: String(err && err.message || err) }),
        // 汇总正文超预算 → 分层成稿(保护汇总会话上下文,别让十几份厚正文灌爆它又被压回摘要);落日志让用户看见这一步
        onReduce: (info) => { try { log('wf 分层汇总:各子任务正文合计 ' + info.totalChars + ' 字 > 预算,拆 ' + info.groups + ' 册分别成稿再拼终稿(护上下文)') } catch {} },
        // 汇总后复核:独立复核员挑问题 → 据问题修订;通过则不改。落日志(意见全文进存档 res.review)
        onReview: (info) => { try { log('wf 汇总后复核:' + (info.passed ? '通过,原稿即终稿' : '发现问题,已据此修订终稿')) } catch {} },
        // 动态规模:规划器按复杂度自估这单要几轮/几个 Agent(夹在安全上限内),不再固定 4/16
        onScale: (info) => { try { log('wf 动态规模:规划器估这单约 ' + info.rounds + ' 轮 / ' + info.tasks + ' 个 Agent' + (info.complexity ? ' —— ' + info.complexity : '')) } catch {} },
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
        fs.writeFileSync(archive, `# 工作流:${goal}\n\n- id:${rid} · 轮次:${res.rounds} · 用时:${Math.round((res.elapsedMs || 0) / 1000)}s${res.stopped ? ' · 提前收尾:' + res.stopped : ''}\n\n## 子任务\n${taskLines || '(无)'}\n\n## 最终成果\n\n${res.final || '(无)'}\n${res.review ? '\n## 复核意见(据此已修订上面的成果)\n\n' + res.review + '\n' : ''}`)
      } catch (e2) { log('wf archive err: ' + e2.message) }
      Object.assign(reg, { status: res.stopped === 'aborted' ? 'aborted' : 'done', final: String(res.final || ''), archive, rounds: res.rounds, elapsedMs: res.elapsedMs })
      send('final', { final: res.final, stopped: res.stopped, done: res.done, rounds: res.rounds, elapsedMs: res.elapsedMs, unmet: res.unmet, archive })
      return { ok: true }
    } catch (err) {
      reg.status = 'error'; reg.final = String(err && err.message || err)
      send('error', { error: String(err && err.message || err) })
      return { ok: false }
    } finally {
      for (const s of entry.sessions) { S.sessionInfo.delete(s); S.streamBuf.delete(s); S.dropPendingPerm && S.dropPendingPerm(s) }   // streamBuf/pendingPerm 一并兜底:永不 settle 的会话其 run() finally 不执行
      S.workflows.delete(wc.id)
      // 注册表只留最近 50 条,防长跑内存 + 存档目录本身是全量留痕
      if (S.wfRegistry.size > 50) { const k = S.wfRegistry.keys().next().value; S.wfRegistry.delete(k) }
    }
  })
}
