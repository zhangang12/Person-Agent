'use strict'

// 需求分析 IPC：把 reqanalysis.js 管线接到工作流窗 + 逐条确认面板。
//  · 读者用真 opencode 会话(每读者一个独立 session、裸上下文、互不通气)。
//  · grounding / Qwen 读图先留空(describeImage=null、ground=null)——接通探针/OB 后再注入。
//  · 报告暂存在 S.reqReports，逐条确认面板按 reportId 取；落档 append-only 写 userData/req-knowledge.jsonl。

module.exports = function initReqAnalysis(S, { ipcMain, app, path, fs, oc, log, spawnReqConfirm }) {
  const req = require('../reqanalysis')
  if (!S.reqRuns) S.reqRuns = new Map()
  if (!S.reqReports) S.reqReports = new Map()
  const klFile = () => path.join(app.getPath('userData'), 'req-knowledge.jsonl')

  ipcMain.on('req-abort', (e) => { const r = S.reqRuns.get(e.sender.id); if (r) { try { r.ac.abort() } catch {} } })

  ipcMain.handle('req-analyze', async (e, docPath) => {
    const wc = e.sender
    const send = (type, payload) => { if (!wc.isDestroyed()) wc.send('req-event', { type, ...payload }) }
    const dir = S.settings.projectDir || ''
    let serve
    try { serve = await oc.ensureServe(dir, S.handlers, log) }
    catch (err) { send('error', { error: 'serve 起不来：' + (err && err.message || err) }); return { ok: false } }

    const ac = new AbortController()
    const entry = { ac, serve, sessions: new Set() }
    S.reqRuns.set(wc.id, entry)

    // 1) 解析 Word：文字/表 + 内嵌图片(暂不识别 → describeImage=null，按"读不准"诚实标)
    let sourceText = ''
    try {
      send('parse', { phase: 'start', file: docPath ? path.basename(docPath) : '' })
      if (/\.docx$/i.test(docPath || '')) {
        const r = await req.parseDocx(docPath, { describeImage: null })
        sourceText = r.text; send('parse', { phase: 'done', images: r.images, chars: sourceText.length })
      } else {
        sourceText = fs.readFileSync(docPath, 'utf8'); send('parse', { phase: 'done', images: 0, chars: sourceText.length })
      }
    } catch (err) { send('error', { error: '解析失败：' + (err && err.message || err) }); S.reqRuns.delete(wc.id); return { ok: false } }

    if (!sourceText.trim()) { send('error', { error: '文档解析为空' }); S.reqRuns.delete(wc.id); return { ok: false } }

    // 2) 读者真 run：每读者一个独立会话(裸上下文、互不通气)
    const run = async (prompt, meta) => {
      if (ac.signal.aborted) throw new Error('已中止')
      const sid = await oc.createSession(serve, '需求分析:' + (meta && (meta.persona || meta.kind) || ''))
      if (!sid) throw new Error('createSession 失败')
      S.sessionInfo.set(sid, { wc, serve }); entry.sessions.add(sid)
      try { return await oc.sendMessage(serve, sid, prompt) }
      finally { S.sessionInfo.delete(sid); entry.sessions.delete(sid); S.streamBuf.delete(sid) }
    }

    try {
      send('readers', { phase: 'start' })
      const out = await req.analyzeRequirement(sourceText, { run, signal: ac.signal, onEvent: (ev) => send('stage', ev) })
      const reportId = 'rpt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
      S.reqReports.set(reportId, { report: out.report, file: docPath ? path.basename(docPath) : '', ts: Date.now() })
      send('done', { reportId, summary: out.report.summary, findings: out.findings.length, clusters: out.clusters.length })
      log('req-analyze done: ' + reportId + ' ' + JSON.stringify(out.report.summary))
      return { ok: true, reportId }
    } catch (err) {
      send('error', { error: String(err && err.message || err) }); return { ok: false }
    } finally {
      for (const s of entry.sessions) { try { oc.abort(serve, s) } catch {}; S.sessionInfo.delete(s) }
      S.reqRuns.delete(wc.id)
    }
  })

  ipcMain.handle('open-req-confirm', (_e, reportId) => (S.reqReports.has(reportId) ? spawnReqConfirm(reportId) : null))
  ipcMain.handle('get-req-report', (_e, reportId) => { const r = S.reqReports.get(reportId); return r ? r.report : null })

  // 逐条确认落档：只有人确认过的结论才进知识库，append-only
  ipcMain.handle('req-landfill', (_e, payload) => {
    try {
      const { reportId, decisions } = payload || {}
      const r = S.reqReports.get(reportId)
      if (!r) return { ok: false, error: '报告不存在' }
      const line = JSON.stringify({ ts: Date.now(), file: r.file, decisions: decisions || [] }) + '\n'
      fs.appendFileSync(klFile(), line)
      log('req-landfill: ' + (decisions ? decisions.length : 0) + ' 条 → ' + klFile())
      return { ok: true, count: decisions ? decisions.length : 0 }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  })
}
