'use strict'

// 需求分析 IPC：把 reqanalysis.js 管线接到工作流窗 + 逐条确认面板。
//  · 读者用真 opencode 会话(每读者一个独立 session、裸上下文、互不通气)。
//  · grounding / Qwen 读图先留空(describeImage=null、ground=null)——接通探针/OB 后再注入。
//  · 报告暂存在 S.reqReports，逐条确认面板按 reportId 取；落档 append-only 写 userData/req-knowledge.jsonl。

module.exports = function initReqAnalysis(S, { ipcMain, app, path, fs, oc, log, dialog, shell, spawnReqConfirm, spawnReqPlan }) {
  const req = require('../reqanalysis')
  const reqplan = require('../reqplan')
  const { execFileSync } = require('child_process')
  if (!S.reqRuns) S.reqRuns = new Map()
  if (!S.reqReports) S.reqReports = new Map()
  if (!S.reqPlans) S.reqPlans = new Map()
  const klFile = () => path.join(app.getPath('userData'), 'req-knowledge.jsonl')

  // ── 场景 Profile：需求分析要 grounding 的仓库集（块5）──
  // 场景一填 3 仓、场景二/三填 1 仓；缺省回落到项目目录 + 后端目录。
  // repo 条目支持两种形态：旧=纯路径字符串；新={ path, system, aliases[] }。统一归一化成对象。
  const normRepo = (r) => {
    if (typeof r === 'string') return { path: r.trim(), system: '', aliases: [] }
    if (r && typeof r === 'object') return {
      path: String(r.path || '').trim(),
      system: String(r.system || '').trim(),
      aliases: Array.isArray(r.aliases) ? r.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
    }
    return { path: '', system: '', aliases: [] }
  }
  const reqRepos = () => {
    const p = S.settings.reqProfile
    const raw = (p && Array.isArray(p.repos) && p.repos.length) ? p.repos : [S.settings.projectDir, S.settings.backendDir]
    const out = [], seen = new Set()
    for (const r of (raw || [])) {
      const n = normRepo(r)
      if (n.path && !seen.has(n.path)) { seen.add(n.path); out.push(n) }
    }
    return out
  }
  // 在需求文字里识别某个仓对应的系统（命中系统名或别名）
  const matchSystem = (text, repo) => {
    if (!repo.system) return false
    const hay = String(text || '')
    if (hay.includes(repo.system)) return true
    return (repo.aliases || []).some((a) => a && hay.includes(a))
  }
  // 把"系统名/别名命中本段需求文字"的仓排到前面（ground 取首个命中、locate 优先收集 → 多系统定位更准）
  const orderReposForText = (text, repos) => {
    const hit = [], rest = []
    for (const r of repos) (matchSystem(text, r) ? hit : rest).push(r)
    return hit.length ? hit.concat(rest) : repos
  }

  // ── 跨仓确定性检索原语（块2，方案B：代码不进模型上下文）──
  const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'not', 'all', 'are', 'was', 'will', 'can', 'get', 'set', 'new', 'int', 'var', 'val', 'def', 'class', 'public', 'private', 'return', 'void', 'true', 'false', 'null'])
  function extractAsciiTokens(text, max = 8) {
    const set = new Set()
    const re = /[A-Za-z_][A-Za-z0-9_]{2,}(?:\/[A-Za-z0-9_]+)*/g
    let m
    while ((m = re.exec(String(text || ''))) && set.size < max * 3) {
      const t = m[0]
      if (t.length >= 3 && !STOP.has(t.toLowerCase())) set.add(t)
    }
    return [...set].slice(0, max)
  }
  // git grep -n（仅跟踪文件、跳二进制、忽略大小写、定值匹配）→ [{path(绝对,正斜杠), line, text}]
  function gitGrep(repoDir, term, max = 6) {
    try {
      const out = execFileSync('git', ['grep', '-n', '-I', '-i', '-F', '--no-color', '-e', term], { cwd: repoDir, encoding: 'utf8', timeout: 6000, maxBuffer: 8 * 1024 * 1024 })
      const base = String(repoDir).replace(/\\/g, '/').replace(/\/$/, '')
      return out.split('\n').filter(Boolean).slice(0, max).map((ln) => {
        const mm = /^(.+?):(\d+):(.*)$/.exec(ln)
        if (!mm) return null
        return { path: base + '/' + mm[1].replace(/\\/g, '/'), line: Number(mm[2]), text: mm[3], _full: path.join(repoDir, mm[1]) }
      }).filter(Boolean)
    } catch { return [] }   // exit 1 = 无命中
  }
  function readSlice(fullPath, line, before = 3, after = 6) {
    try {
      const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)
      const s = Math.max(0, line - 1 - before), e = Math.min(lines.length, line + after)
      return lines.slice(s, e).join('\n')
    } catch { return '' }
  }

  ipcMain.on('req-abort', (e) => { const r = S.reqRuns.get(e.sender.id); if (r) { try { r.ac.abort() } catch {} } })

  // 选一个代码仓库目录（需求分析入口配置 grounding 真相源用，不改全局项目目录）
  ipcMain.handle('pick-req-repo', async () => {
    const r = await dialog.showOpenDialog({ title: '选择代码仓库目录（grounding 真相源）', properties: ['openDirectory'] })
    return (!r.canceled && r.filePaths[0]) ? r.filePaths[0] : null
  })

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

    // grounding（块6）：用读法里的英文标识符跨仓 git grep，命中即坐实 → 给该读法证据 + 置信加成。
    // 中文读法常无 ascii token → 不命中 → 退化成"无 grounding"（不破坏现有三类清单）。
    const repos = reqRepos()
    const ground = async (q) => {
      const terms = extractAsciiTokens([q.claim, q.reading, q.readingKey].join(' '))
      // 用读法的中文文字识别归属系统 → 命中系统的仓优先 grep，证据带【系统】前缀
      const ordered = orderReposForText([q.claim, q.reading].join(' '), repos)
      for (const repo of ordered) for (const t of terms) {
        const h = gitGrep(repo.path, t, 1)[0]
        if (h) return { found: true, ref: (repo.system ? '【' + repo.system + '】' : '') + h.path + ':' + h.line }
      }
      return { found: false, ref: null }
    }

    try {
      send('readers', { phase: 'start' })
      const out = await req.analyzeRequirement(sourceText, { run, ground, signal: ac.signal, onEvent: (ev) => send('stage', ev) })
      const reportId = 'rpt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
      S.reqReports.set(reportId, { report: out.report, file: docPath ? path.basename(docPath) : '', ts: Date.now(), findings: out.findings.length })
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

  // 导出报告为 Markdown 产物文档 → 弹保存框 → 存好后在文件夹高亮
  ipcMain.handle('export-req-report', async (_e, reportId) => {
    try {
      const r = S.reqReports.get(reportId)
      if (!r) return { ok: false, error: '报告不存在(可能已过期)' }
      const md = req.reportToMarkdown(r.report, { file: r.file, ts: r.ts, findings: r.findings })
      const base = (r.file || '需求文档').replace(/\.[^.]+$/, '')
      const sv = await dialog.showSaveDialog({
        title: '导出需求分析报告', defaultPath: '需求分析报告_' + base + '.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '全部文件', extensions: ['*'] }],
      })
      if (sv.canceled || !sv.filePath) return { ok: false, canceled: true }
      fs.writeFileSync(sv.filePath, md, 'utf8')
      try { shell.showItemInFolder(sv.filePath) } catch {}
      log('export-req-report → ' + sv.filePath)
      return { ok: true, path: sv.filePath }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  })

  // 逐条确认落档：只有人确认过的结论才进知识库，append-only
  ipcMain.handle('req-landfill', (_e, payload) => {
    try {
      const { reportId, decisions } = payload || {}
      const r = S.reqReports.get(reportId)
      if (!r) return { ok: false, error: '报告不存在' }
      const line = JSON.stringify({ ts: Date.now(), file: r.file, decisions: decisions || [] }) + '\n'
      fs.appendFileSync(klFile(), line)
      r.decisions = decisions || []   // 暂存到报告，供"生成实施方案"复用人确认结论
      log('req-landfill: ' + (decisions ? decisions.length : 0) + ' 条 → ' + klFile())
      return { ok: true, count: decisions ? decisions.length : 0 }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  })

  // ── 出详设（块3）：确认后的需求点 → 跨仓定位切片 → agent 起草详设卡 ──
  ipcMain.handle('req-plan', async (e, { reportId, decisions }) => {
    const wc = e.sender
    const send = (type, payload) => { if (!wc.isDestroyed()) wc.send('req-plan-event', { type, ...payload }) }
    const r = S.reqReports.get(reportId)
    if (!r) { send('error', { error: '报告不存在(可能已过期)' }); return { ok: false } }
    if (!decisions || !decisions.length) decisions = r.decisions || []   // 复用落档时暂存的人确认结论

    const dir = S.settings.projectDir || ''
    let serve
    try { serve = await oc.ensureServe(dir, S.handlers, log) }
    catch (err) { send('error', { error: 'serve 起不来：' + (err && err.message || err) }); return { ok: false } }

    const ac = new AbortController()
    const entry = { ac, serve, sessions: new Set() }
    S.reqRuns.set(wc.id, entry)

    // 每次调用一个独立会话（裸上下文），跑完即清
    const run = async (prompt, meta) => {
      if (ac.signal.aborted) throw new Error('已中止')
      const sid = await oc.createSession(serve, '出详设:' + (meta && meta.kind || ''))
      if (!sid) throw new Error('createSession 失败')
      S.sessionInfo.set(sid, { wc, serve }); entry.sessions.add(sid)
      try { return await oc.sendMessage(serve, sid, prompt) }
      finally { S.sessionInfo.delete(sid); entry.sessions.delete(sid); S.streamBuf.delete(sid) }
    }

    const repos = reqRepos()
    // locate：① 确定性 ascii token ② 模型补"中文需求 → 代码标识符"关键词 ③ 跨仓 grep + 读切片
    const locate = async (point) => {
      let terms = extractAsciiTokens([point.reqPoint, point.intent, point.quote].join(' '))
      try {
        const kw = await run('下面是一个需求点。列出最多 6 个最可能出现在代码仓库里的检索关键词'
          + '（英文标识符/类名/方法名/表名/字段/接口路径，每行一个，只输出关键词，没有就留空）：\n'
          + '需求点：' + point.reqPoint + '\n意图：' + (point.intent || '') + '\n原文：' + (point.quote || ''),
          { kind: 'plan-kw' })
        for (const t of extractAsciiTokens(kw, 8)) terms.push(t)
      } catch {}
      terms = [...new Set(terms)].slice(0, 8)
      // 命中本需求点系统的仓优先收集 → refs/slices 带 system，模型出方案时"归哪个系统"有据可依
      const ordered = orderReposForText([point.reqPoint, point.intent, point.quote].join(' '), repos)
      const refs = []
      for (const repo of ordered) {
        for (const t of terms) {
          for (const h of gitGrep(repo.path, t, 6)) { refs.push({ ...h, system: repo.system || '' }); if (refs.length >= 24) break }
          if (refs.length >= 24) break
        }
        if (refs.length >= 24) break
      }
      const slices = []
      for (const h of refs.slice(0, 8)) { const txt = readSlice(h._full, h.line); if (txt) slices.push({ path: h.path, line: h.line, text: txt, system: h.system || '' }) }
      return { refs: refs.map((h) => ({ path: h.path, line: h.line, symbol: '', system: h.system || '' })), slices }
    }
    const plan = async (point, located) => run(reqplan.buildPlanPrompt(point, located), { kind: 'plan' })

    try {
      send('start', {})
      const out = await reqplan.planRequirement(r.report, { locate, plan, decisions, signal: ac.signal, onEvent: (ev) => send('stage', ev) })
      const planId = 'pln_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
      S.reqPlans.set(planId, { plan: out, file: r.file, ts: Date.now() })
      send('done', { planId, cards: out.cards.length })
      log('req-plan done: ' + planId + ' · ' + out.cards.length + ' cards')
      return { ok: true, planId }
    } catch (err) {
      send('error', { error: String(err && err.message || err) }); return { ok: false }
    } finally {
      for (const s of entry.sessions) { try { oc.abort(serve, s) } catch {}; S.sessionInfo.delete(s) }
      S.reqRuns.delete(wc.id)
    }
  })

  ipcMain.handle('open-req-plan', (_e, reportId) => (spawnReqPlan ? spawnReqPlan(reportId) : null))
  ipcMain.handle('get-req-plan', (_e, planId) => { const p = S.reqPlans.get(planId); return p ? p.plan : null })

  // 导出实施方案为 Markdown 产物文档
  ipcMain.handle('export-req-plan', async (_e, planId) => {
    try {
      const p = S.reqPlans.get(planId)
      if (!p) return { ok: false, error: '实施方案不存在(可能已过期)' }
      const md = reqplan.planToMarkdown(p.plan, { file: p.file, ts: p.ts })
      const base = (p.file || '需求文档').replace(/\.[^.]+$/, '')
      const sv = await dialog.showSaveDialog({
        title: '导出实施方案', defaultPath: '实施方案_' + base + '.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '全部文件', extensions: ['*'] }],
      })
      if (sv.canceled || !sv.filePath) return { ok: false, canceled: true }
      fs.writeFileSync(sv.filePath, md, 'utf8')
      try { shell.showItemInFolder(sv.filePath) } catch {}
      log('export-req-plan → ' + sv.filePath)
      return { ok: true, path: sv.filePath }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  })
}
