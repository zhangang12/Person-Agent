'use strict'
const USE_ACRYLIC = false
const { clipboard, session, Notification, desktopCapturer } = require('electron')
const email = require('./email')
const attachments = require('./attachments')
const mailCache = require('./mail-cache')
const emailSummarySeen = require('./email-summary-seen')
const initOutbox = require('./outbox')
const db = require('./db')
const { extractMeeting } = require('./meeting-extract')
const { RECORDER_JS, selExpr, findElExpr, frameFor, safeOrigin, applyParams, applyBaseUrl, JS_LIKE, diffReport, coverageHits, clusterErrs, compactEvents, markHumanGates, upgradeToSkill, skillMd } = require('./recorder-core')
const initRecorder = require('./recorder')
const { cdpConsoleLevel, fmtRO, fmtException, resolveFrame } = require('./cdp-format')
const initMail = require('./mail')
const initMcpConfig = require('./mcp-config')
const initBrowser = require('./browser')

module.exports = function initWindow(S, { ipcMain, app, BrowserWindow, WebContentsView, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }) {
  // 纯文件 IO 函数搬进 recorder-core 的 initStore 工厂,这里注入依赖后解构使用
  const { recDir, readRec, writeLastRun, skillList, loadAssertions, loadScans, loadReview, gitChangedFiles } = require('./recorder-core').initStore({ app, fs, path, execSync: require('child_process').execSync })
  // 额外窗口引用
  S.orbInputWin = null
  S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
  // ── 设置 ────────────────────────────────────────────────────────────────────
  function loadSettings() { try { return { ...S.settings, ...JSON.parse(fs.readFileSync(S.settingsFile, 'utf8')) } } catch { return { ...S.settings } } }
  function saveSettings() { try { fs.writeFileSync(S.settingsFile, JSON.stringify(S.settings)) } catch {} }
  // ── 邮件子系统 ──────────────────────────────────────────────────────────────
  // 收发/发件箱安全闸门/IMAP IDLE/本地中继/mail-cache/待办-邮件闭环/DB 只读中继,整块搬进 ./mail 的
  // initMail(ctx) 工厂。ctx 注入外部模块 + 后定义但已提升的 function;回传 3 个外部调用点用到的函数。
  const mail = initMail({ S, app, path, fs, shell, ipcMain, log, oc, Notification, email, attachments, mailCache, emailSummarySeen, db, initOutbox, openOutbox, sendOrbState, createMailCenter, openMailView, spawnCard, spawnWorkflow, maybeSuggestMeeting, skillList, skillRun })

  const projName = () => S.settings.projectDir ? path.basename(S.settings.projectDir) : '未选目录'

  function applyProject(dir) {
    S.settings.projectDir = dir
    S.settings.recentDirs = [dir, ...(S.settings.recentDirs || []).filter((d) => d !== dir)].slice(0, 6)
    saveSettings()
    oc.ensureServe(dir, S.handlers, log).catch((e) => log('prewarm failed: ' + e.message))
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('project-changed', projName())
  }

  // ── 历史 ────────────────────────────────────────────────────────────────────
  function saveHistory() { try { fs.writeFileSync(S.historyFile, JSON.stringify(S.history.slice(0, 50))) } catch {} }
  function loadHistory() { try { const a = JSON.parse(fs.readFileSync(S.historyFile, 'utf8')); if (Array.isArray(a)) S.history = a } catch {} }
  function recordHistory(id, title, dir) {
    const t = (title || '对话').replace(/\s+/g, ' ').trim().slice(0, 80)
    S.history = [{ id, title: t, dir: dir || '', project: dir ? path.basename(dir) : '未选目录', ts: Date.now(), created: Date.now() }, ...S.history.filter((h) => h.id !== id)].slice(0, 50)
    saveHistory()
  }
  function touchHistory(id) { const h = S.history.find((x) => x.id === id); if (h) { h.ts = Date.now(); saveHistory() } }

  S.settings = loadSettings()
  loadHistory()

  // ── 窗口工厂 ────────────────────────────────────────────────────────────────
  function baseOpts(extra) {
    const opts = {
      frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, roundedCorners: true,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
      ...extra,
    }
    if (USE_ACRYLIC) { opts.transparent = false; opts.backgroundColor = '#00000000'; opts.backgroundMaterial = 'acrylic' }
    else { opts.transparent = true }
    return opts
  }

  function createOrb() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    const W = 280
    S.inputWin = new BrowserWindow(baseOpts({
      width: W, height: W,
      x: width - W - 20, y: height - W - 20,
      skipTaskbar: true, hasShadow: false,
    }))
    S.inputWin.setIgnoreMouseEvents(true, { forward: true })
    S.inputWin.loadFile(path.join(__dirname, '..', 'ui', 'orb.html'))
    S.inputWin.on('closed', () => { S.inputWin = null })
    // "不用应用时隐藏桌面悬浮球":窗口照建(给 orb-input 做锚点定位用),但不显示
    if (S.settings.orbHidden) { try { S.inputWin.hide() } catch {} }
  }

  // 隐藏/显示桌面悬浮球。隐藏只是 hide()——窗口仍在(留作 orb-input 锚点),全局快捷键/托盘照常唤起;
  // 全部功能窗口都关掉时 window-all-closed 也不会误判"无窗口"而重建球。
  function setOrbHidden(hidden) {
    S.settings.orbHidden = !!hidden
    saveSettings()
    if (hidden) {
      if (S.inputWin && !S.inputWin.isDestroyed()) S.inputWin.hide()
    } else {
      if (!S.inputWin || S.inputWin.isDestroyed()) createOrb()
      else { S.inputWin.show(); ensureOrbAlive() }
    }
    refreshTrayMenu()
  }

  // 自由拖动：可在桌面任意位置；只做轻量夹取，避免球被拖出屏幕外抓不回来
  function clampOrbPos(x, y) {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    const C = 140, M = 24   // 球心位于 280 窗口中心，保证球心离屏幕边 ≥M
    return [Math.max(M - C, Math.min(sw - C - M, x)), Math.max(M - C, Math.min(sh - C - M, y))]
  }
  function snapOrbToCorner() {   // 名字保留；拖动结束后只把球夹回可见区，不再吸附边/角
    if (!S.inputWin || S.inputWin.isDestroyed()) return
    const [x, y] = S.inputWin.getPosition()
    const [nx, ny] = clampOrbPos(x, y)
    S.inputWin.setPosition(nx, ny)
  }

  // 关掉浏览器/工作台后让球闪一下,提醒"agent 还在"——避免用户误以为退出
  // 关键: 球已销毁就重建; 任何窗口 API 都推到下一 tick,避免与 close 回调里的清理路径竞态
  function ensureOrbAlive() {
    if (!S.inputWin || S.inputWin.isDestroyed()) { try { createOrb() } catch (e) { log('createOrb err: ' + e.message) } ; return }
    setImmediate(() => {
      if (!S.inputWin || S.inputWin.isDestroyed()) return
      try { S.inputWin.webContents.send('orb-wake') } catch (e) { log('orb-wake send err: ' + e.message) }
    })
  }

  // 功能窗口「从智能体长出来」：算出球心相对该窗口的 transform-origin + 朝球方向的初始位移，
  // 作为 query 传给窗口（glass.css 的 orbGrow 据此从球的方向放大长出）
  function orbAnchorFor(winX, winY, winW, winH) {
    if (!S.inputWin || S.inputWin.isDestroyed()) return {}
    const [ox, oy] = S.inputWin.getPosition()
    const cx = ox + 140, cy = oy + 140                                   // 球心屏幕坐标
    const gox = Math.max(0, Math.min(winW, Math.round(cx - winX)))
    const goy = Math.max(0, Math.min(winH, Math.round(cy - winY)))
    const gfx = cx < winX ? -16 : cx > winX + winW ? 16 : 0
    const gfy = cy < winY ? -16 : cy > winY + winH ? 16 : 0
    return { gox: gox + 'px', goy: goy + 'px', gfx: gfx + 'px', gfy: gfy + 'px' }
  }

  function createOrbInput(mode) {
    if (S.orbInputWin && !S.orbInputWin.isDestroyed()) {
      S.orbInputWin.close(); S.orbInputWin = null; return
    }
    const pw = 520, ph = 56, M = 12
    const [ox, oy] = S.inputWin ? S.inputWin.getPosition() : [100, 100]
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    let px = ox + (280 - pw) / 2
    if (px < 10) px = 10
    if (px + pw > sw - 10) px = sw - pw - 10
    const py = (oy - ph - M) < 10 ? oy + 280 + M : oy - ph - M
    const above = py < oy                                                          // 输入框在球上方 → 从底边长出，否则从顶边
    const anchorX = Math.max(20, Math.min(pw - 20, Math.round(ox + 140 - px)))     // 球心相对输入框左边的 x
    const query = { dir: above ? 'up' : 'down', ax: String(anchorX) }
    if (mode) query.mode = mode
    S.orbInputWin = new BrowserWindow(baseOpts({
      width: pw, height: ph, x: Math.round(px), y: Math.round(py), skipTaskbar: true,
    }))
    S.orbInputWin.loadFile(path.join(__dirname, '..', 'ui', 'orb-input.html'), { query })
    S.orbInputWin.on('closed', () => { S.orbInputWin = null })
  }

  function toggleOrbInput(mode) { createOrbInput(mode) }

  function spawnCard(title, sid, msg, disp, opts) {
    const id = ++S.cardSeq
    const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
    const wx = 160 + col * 56, wy = 90 + row * 50 + col * 18
    const win = new BrowserWindow(baseOpts({
      width: 680, height: 860, minWidth: 480, minHeight: 460, resizable: true,
      alwaysOnTop: false, skipTaskbar: false, x: wx, y: wy,
    }))
    const wcId = win.webContents.id
    const query = { title: title || '未命名任务', id: String(id), ...orbAnchorFor(wx, wy, 680, 860) }
    if (sid) query.sid = sid
    if (msg) query.msg = msg
    if (disp) query.disp = disp
    win.loadFile(path.join(__dirname, '..', 'ui', 'card.html'), { query })
    // opts.flash:加载完后闪一下任务栏 + 短暂置顶 + 抢焦点 → 用户一眼能找到新弹的卡
    if (opts && opts.flash) {
      win.webContents.once('did-finish-load', () => {
        try {
          win.show(); win.focus(); win.moveTop()
          win.setAlwaysOnTop(true)
          win.flashFrame(true)
          setTimeout(() => { try { if (!win.isDestroyed()) { win.setAlwaysOnTop(false); win.flashFrame(false) } } catch {} }, 1500)
        } catch {}
      })
    }
    win.on('closed', () => {
      const s = S.sessionByWc.get(wcId)
      let oldServe = null
      if (s) { const si = S.sessionInfo.get(s); if (si) { oldServe = si.serve; oc.abort(si.serve, s) } S.sessionInfo.delete(s); S.streamBuf.delete(s); S.sentPrompt.delete(s); S.firstMsgCtx.delete(s) }
      S.sessionByWc.delete(wcId)
      if (S.cardDir) S.cardDir.delete(wcId)       // per-card 目录/模型状态随卡销毁
      if (S.modelByWc) S.modelByWc.delete(wcId)
      // 本卡独占的自起 serve(切过项目的卡)没别的会话引用就退休,不留孤儿进程
      if (oldServe) {
        const inUseBases = new Set([...S.sessionInfo.values()].map((si) => si.serve && si.serve.base).filter(Boolean))
        try { if (oc.retireIfOrphan(oldServe, inUseBases)) log('card closed: serve ' + oldServe.base + ' 已退休(无会话引用)') } catch {}
      }
      forgetBusy(wcId)   // 关卡即清"忙"，避免球卡在思考态
    })
    return id
  }

  // 预设角色库（label、提示词前缀）
  const ROLES = {
    security:  ['安全·风险',   '请从安全漏洞、边界处理、异常情况、权限校验等角度深度审视以下内容，逐条列出问题（必改/建议/可忽略）并给出修法：\n\n'],
    perf:      ['性能·质量',   '请从性能瓶颈、代码质量、可读性、可维护性等角度深度审视以下内容，逐条列出改进点（必改/建议/可忽略）：\n\n'],
    biz:       ['业务·逻辑',   '请从业务逻辑正确性、需求覆盖度、边界场景、数据一致性等角度深度审视以下内容，逐条列出问题（必改/建议/可忽略）：\n\n'],
    arch:      ['架构·设计',   '请从系统架构、模块划分、接口设计、扩展性等角度深度评审以下内容，给出架构层面的建议与风险：\n\n'],
    test:      ['测试·覆盖',   '请为以下内容设计完整的测试方案，包含单元/集成/边界用例，并指出当前可能缺失的测试场景：\n\n'],
    doc:       ['文档·注释',   '请为以下内容生成完整的中文技术文档（包含功能说明、参数、返回值、使用示例、注意事项）：\n\n'],
    refactor:  ['重构·简化',   '请审视以下代码，找出可以简化、消除重复、提升可读性的点，给出重构建议并写出重构后的代码：\n\n'],
  }

  function spawnFanout(goal, roleKeys) {
    const keys = (roleKeys && roleKeys.length) ? roleKeys : ['security', 'perf', 'biz']
    const shortGoal = goal.length > 28 ? goal.slice(0, 27) + '…' : goal
    keys.forEach((k) => {
      const [label, prefix] = ROLES[k] || [k, '']
      spawnCard(label + ' · ' + shortGoal, null, prefix + goal)
    })
    return keys.length
  }

  function spawnWorkflow(goal) {
    const id = ++S.cardSeq
    const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
    const wx = 180 + col * 56, wy = 80 + row * 50 + col * 18
    const win = new BrowserWindow(baseOpts({
      width: 680, height: 820, minWidth: 460, minHeight: 420, resizable: true,
      alwaysOnTop: false, skipTaskbar: false, x: wx, y: wy,
    }))
    const wcId = win.webContents.id
    win.loadFile(path.join(__dirname, '..', 'ui', 'workflow.html'), { query: { goal: goal || '未命名工作流', id: String(id), ...orbAnchorFor(wx, wy, 680, 820) } })
    win.on('closed', () => {
      const w = S.workflows.get(wcId)
      if (w) { try { w.ac.abort() } catch {}; for (const s of w.sessions) { try { oc.abort(w.serve, s) } catch {}; S.sessionInfo.delete(s) }; S.workflows.delete(wcId) }
    })
    return id
  }

  // ── 需求分析（多Agent 对抗 → 三类清单）────────────────────────────────────────
  function spawnReqAnalysis(docPath) {
    const id = ++S.cardSeq
    const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
    const wx = 200 + col * 56, wy = 70 + row * 50 + col * 18
    const win = new BrowserWindow(baseOpts({
      width: 700, height: 840, minWidth: 480, minHeight: 460, resizable: true,
      alwaysOnTop: false, skipTaskbar: false, x: wx, y: wy,
    }))
    const wcId = win.webContents.id
    win.loadFile(path.join(__dirname, '..', 'ui', 'reqflow.html'), { query: { docPath: docPath || '', id: String(id), ...orbAnchorFor(wx, wy, 700, 840) } })
    win.on('closed', () => {
      const r = S.reqRuns && S.reqRuns.get(wcId)
      if (r) { try { r.ac.abort() } catch {}; for (const s of r.sessions) { try { oc.abort(r.serve, s) } catch {}; S.sessionInfo.delete(s) }; S.reqRuns.delete(wcId) }
    })
    return id
  }
  function spawnReqConfirm(reportId) {
    const id = ++S.cardSeq
    const win = new BrowserWindow(baseOpts({
      width: 720, height: 840, minWidth: 480, minHeight: 460, resizable: true,
      alwaysOnTop: false, skipTaskbar: false, x: 270, y: 96,
    }))
    win.loadFile(path.join(__dirname, '..', 'ui', 'reqconfirm.html'), { query: { reportId: reportId || '', ...orbAnchorFor(270, 96, 720, 840) } })
    return win.webContents.id
  }
  function spawnReqPlan(reportId) {
    const win = new BrowserWindow(baseOpts({
      width: 740, height: 860, minWidth: 480, minHeight: 460, resizable: true,
      alwaysOnTop: false, skipTaskbar: false, x: 320, y: 80,
    }))
    win.loadFile(path.join(__dirname, '..', 'ui', 'reqplan.html'), { query: { reportId: reportId || '', ...orbAnchorFor(320, 80, 740, 860) } })
    return win.webContents.id
  }
  // 卡内"选择文件"用：只返回路径，不另开卡（在当前需求分析卡里就地开跑）
  async function pickReqDocPath() {
    const r = await dialog.showOpenDialog({
      title: '选择需求文档（Word .docx）', properties: ['openFile'],
      filters: [{ name: 'Word 文档', extensions: ['docx'] }, { name: '全部文件', extensions: ['*'] }],
    })
    return (!r.canceled && r.filePaths[0]) ? r.filePaths[0] : null
  }

  // 规则法识别邮件里的会议 → 产出"建议待办"(pending 态,人工确认后才进正式待办);
  // 抽取器保守(解析不出可信时间只给建议不给提醒),误报靠确认区兜底。产出即广播 UI 刷新
  function maybeSuggestMeeting(em) {
    try {
      if (!em || !em.messageId || !S.todosApi) return
      const mt = extractMeeting(em)
      if (!mt) return
      const sug = S.todosApi.addSuggestion({
        msgId: em.messageId, from: em.from || '', subject: em.subject || '', date: em.date || '',
        text: (em.subject || '会议').slice(0, 80) + (mt.snippet ? ' · ' + mt.snippet : ''),
        meetingAt: mt.meetingAt, link: mt.link,
      })
      if (sug) { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('todo-suggest-updated') } catch {} } }
    } catch (e) { log('suggest meeting err: ' + e.message) }
  }

  // ── 邮件整理卡 ─────────────────────────────────────────────────────────────
  // 行为:拉今天+昨天的邮件(不限未读)→ 过滤掉之前 📧 按钮已整理过的 → 喂 agent 摘要
  //       已整理过的 messageId 持久化在 userData/email-summary-seen.json
  async function spawnEmailCard() {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    // 整个流程期间球进 thinking 态(球在转 + 眼眯成线)→ 用户立刻知道"在拉"
    sendOrbState('thinking')
    try {
      log('email: fetching today+yesterday emails (limit 30, onlyUnseen=false)…')
      const r = await email.fetchUnread(imap, { onlyUnseen: false, days: 2, limit: 30 })
      const all = r.emails || []
      if (!all.length) { log('email: no emails in last 2 days'); throw new Error('近 2 天没有邮件') }
      // 过滤已整理过的
      const seen = emailSummarySeen.isSeenSet(app.getPath('userData'))
      const fresh = all.filter((e) => !e.messageId || !seen.has(e.messageId))
      if (!fresh.length) {
        log('email: all ' + all.length + ' emails already summarized — skipping')
        throw new Error('近 2 天的 ' + all.length + ' 封邮件都已整理过,无新邮件需要总结')
      }
      // 仅对要展示的新邮件落附件 + 缓存
      try { await attachments.saveAttachments(fresh, app.getPath('userData'), log) } catch (e) { log('saveAttachments err: ' + e.message) }
      for (const em of fresh) {
        if (!em.messageId) continue
        mailCache.put(app.getPath('userData'), em)
        S.mailCache.set(em.messageId, { messageId: em.messageId, uid: em.uid, folder: em.folder || 'INBOX', from: em.from, subject: em.subject, date: em.date, attCount: (em.attachments || []).length, savedAt: Date.now() })
        maybeSuggestMeeting(em)   // 规则法识别会议 → 建议待办(人工确认后才进正式待办)
      }
      // 内存缓存这次结果,UI 加待办时能回填邮件正文
      S.mailLastBatch = { ts: Date.now(), emails: fresh }
      const prompt = email.formatEmailPrompt(fresh)
      const prompt2 = prompt + '\n\n注意:你提取的 TODO 行,如果对应某封具体邮件,请在 TODO 行后面追加 `[msgId:xxx]`(xxx 是上面邮件的 Message-ID,见输出),系统会自动回填邮件主题/日期/正文摘要进待办,跨会话也能反查到。'
      const skipped = all.length - fresh.length
      const title = '📧 邮件整理 · ' + new Date().toLocaleDateString('zh-CN') + ' · 新 ' + fresh.length + (skipped ? '/已跳 ' + skipped : '')
      // flash:卡片加载完后任务栏闪 + 抢焦点 + 短暂置顶 1.5s → 用户一眼能找到新弹的卡
      spawnCard(title, null, prompt2, null, { flash: true })
      // 标记 seen 放在卡片建好之后:摘要卡若没弹出来,这些邮件不会被误标"已整理"而永久漏掉
      emailSummarySeen.markSeen(app.getPath('userData'), fresh.map((e) => e.messageId).filter(Boolean))
      log('email: summarized ' + fresh.length + ' new of ' + all.length + ' total (skipped ' + skipped + ' already-seen)')
      sendOrbState('done')   // 球绿色脉冲,2.2s 后自动回 idle
      return fresh.length
    } catch (e) {
      sendOrbState('idle')   // 失败立即回 idle,renderer 自己再红/绿闪
      throw e
    }
  }

  function openOutbox() {
    if (S.outboxWin && !S.outboxWin.isDestroyed()) { S.outboxWin.show(); S.outboxWin.focus(); S.outboxWin.webContents.send('outbox-updated'); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const ox = Math.round(width / 2 - 270), oy = 120
    S.outboxWin = new BrowserWindow(baseOpts({ width: 540, height: 640, x: ox, y: oy, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 420, minHeight: 360 }))
    S.outboxWin.loadFile(path.join(__dirname, '..', 'ui', 'outbox.html'), { query: orbAnchorFor(ox, oy, 540, 640) })
    S.outboxWin.on('closed', () => { S.outboxWin = null })
  }

  function openAudit() {
    if (S.auditWin && !S.auditWin.isDestroyed()) { S.auditWin.show(); S.auditWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const ax = Math.round(width / 2 - 320), ay = 100
    S.auditWin = new BrowserWindow(baseOpts({ width: 640, height: 720, x: ax, y: ay, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 460, minHeight: 400 }))
    S.auditWin.loadFile(path.join(__dirname, '..', 'ui', 'audit.html'), { query: orbAnchorFor(ax, ay, 640, 720) })
    S.auditWin.on('closed', () => { S.auditWin = null })
  }

  // ── 截图即问:全屏抓图 → 透明遮罩框选 → 裁剪 → 开一张带图的对话卡 ──────────────
  // 抓图必须先于遮罩窗出现(否则遮罩自己也进图);遮罩是透明窗,真实桌面透过它可见,只画选框。
  let snipBusy = false
  async function snapAsk() {
    if (snipBusy) return
    if (S.snipWin && !S.snipWin.isDestroyed()) { try { S.snipWin.close() } catch {} return }
    snipBusy = true
    try {
      const disp = screen.getPrimaryDisplay()
      const { width, height } = disp.size
      const sf = disp.scaleFactor || 1
      // 抓主屏全图(按物理像素,拿到高清)
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) } })
      const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0]
      if (!src || src.thumbnail.isEmpty()) { snipBusy = false; return }
      S._snipShot = src.thumbnail        // NativeImage(物理像素),裁剪时用
      S._snipSf = sf
      const win = new BrowserWindow({
        x: disp.bounds.x, y: disp.bounds.y, width, height,
        frame: false, transparent: true, fullscreen: process.platform !== 'darwin', alwaysOnTop: true,
        skipTaskbar: true, resizable: false, movable: false, hasShadow: false, enableLargerThanScreen: true,
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
      })
      S.snipWin = win
      win.setAlwaysOnTop(true, 'screen-saver')
      win.loadFile(path.join(__dirname, '..', 'ui', 'snip.html'))
      win.on('closed', () => { S.snipWin = null; snipBusy = false })
    } catch (e) { log('snapAsk err: ' + e.message); snipBusy = false }
  }
  // 遮罩窗回传 CSS 像素选区 → 按 scaleFactor 换物理像素裁剪 → data URL → 开卡
  ipcMain.handle('snip-crop', (_e, rect) => {
    try {
      const shot = S._snipShot, sf = S._snipSf || 1
      if (S.snipWin && !S.snipWin.isDestroyed()) S.snipWin.close()
      if (!shot || !rect || rect.w < 4 || rect.h < 4) { S._snipShot = null; return { ok: false } }
      const px = { x: Math.round(rect.x * sf), y: Math.round(rect.y * sf), width: Math.round(rect.w * sf), height: Math.round(rect.h * sf) }
      const cropped = shot.crop(px)
      S._snipShot = null
      const url = 'data:image/png;base64,' + cropped.toPNG().toString('base64')
      // 默认问法自动发送(附截图);用户可在卡里继续追问
      const id = spawnCard('截图提问', null, '这是我截的一张屏,请先看图说说你看到了什么/有什么问题,我接着追问。', null, { flash: true })
      S.cardFiles = S.cardFiles || new Map()
      S.cardFiles.set(String(id), [{ mime: 'image/png', url, filename: '截图.png' }])
      return { ok: true }
    } catch (e) { log('snip-crop err: ' + e.message); S._snipShot = null; return { ok: false, error: e.message } }
  })
  ipcMain.on('snip-cancel', () => { S._snipShot = null; if (S.snipWin && !S.snipWin.isDestroyed()) S.snipWin.close() })

  // ── HTTP 抓包 GUI(仅本地 127.0.0.1 转发,不做 HTTPS MITM):抓外部程序(柜面客户端等)的 HTTP 流量 ──
  const httpcap = require('./httpcap')({ log })
  httpcap.setOnAdd((rec) => { try { if (S.httpcapWin && !S.httpcapWin.isDestroyed()) S.httpcapWin.webContents.send('httpcap-add', rec) } catch {} })
  ipcMain.handle('httpcap-start', async (_e, port) => {
    const p = await httpcap.start(port || 0)
    try { S.audit && S.audit('httpcap', '启动抓包代理 127.0.0.1:' + p) } catch {}
    return { ok: true, port: p, addr: '127.0.0.1:' + p }
  })
  ipcMain.handle('httpcap-stop', () => { httpcap.stop(); return { ok: true } })
  ipcMain.handle('httpcap-status', () => httpcap.status())
  ipcMain.handle('httpcap-list', (_e, opts) => httpcap.list(opts || {}))
  ipcMain.handle('httpcap-get', (_e, id) => httpcap.get(id))
  ipcMain.handle('httpcap-clear', () => { httpcap.clear(); return true })
  function openHttpcap() {
    if (S.httpcapWin && !S.httpcapWin.isDestroyed()) { S.httpcapWin.show(); S.httpcapWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const hx = Math.round(width / 2 - 380), hy = 90
    S.httpcapWin = new BrowserWindow(baseOpts({ width: 760, height: 760, x: hx, y: hy, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 540, minHeight: 420 }))
    S.httpcapWin.loadFile(path.join(__dirname, '..', 'ui', 'httpcap.html'), { query: orbAnchorFor(hx, hy, 760, 760) })
    S.httpcapWin.on('closed', () => { S.httpcapWin = null })
  }

  function openMailView(msgId) {
    const id = String(msgId || '').replace(/^<|>$/g, ''); if (!id) return
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const mx = Math.round(width / 2 - 380), my = 80
    if (!(S.mailViewWin && !S.mailViewWin.isDestroyed())) {
      S.mailViewWin = new BrowserWindow(baseOpts({ width: 760, height: 800, x: mx, y: my, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 480, minHeight: 400 }))
      S.mailViewWin.on('closed', () => { S.mailViewWin = null })
      // 兜底:邮件窗口内任何弹窗/跳转一律转系统浏览器(防未来 sandbox 配置回归)
      const wc = S.mailViewWin.webContents
      wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' } })
      wc.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}) } })
    } else { S.mailViewWin.show(); S.mailViewWin.focus() }
    S.mailViewWin.loadFile(path.join(__dirname, '..', 'ui', 'mailview.html'), { query: { msgId: id, ...orbAnchorFor(mx, my, 760, 800) } })
  }

  // 邮件中心：收件箱 + 设置一体（邮件模块的设置归口在此）
  function createMailCenter(tab) {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    const W = Math.min(1280, sw - 60), Hh = Math.min(900, sh - 60)
    const mx = Math.round((sw - W) / 2), my = Math.round((sh - Hh) / 2)
    if (!(S.mailCenterWin && !S.mailCenterWin.isDestroyed())) {
      S.mailCenterWin = new BrowserWindow(baseOpts({ width: W, height: Hh, x: mx, y: my, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 720, minHeight: 520 }))
      S.mailCenterWin.on('closed', () => { S.mailCenterWin = null })
      // 兜底:邮件中心内任何弹窗/跳转一律转系统浏览器(防未来 sandbox 配置回归)
      const wc = S.mailCenterWin.webContents
      wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' } })
      wc.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}) } })
    } else { S.mailCenterWin.show(); S.mailCenterWin.focus() }
    const query = { ...orbAnchorFor(mx, my, W, Hh) }
    if (tab) query.tab = tab
    S.mailCenterWin.loadFile(path.join(__dirname, '..', 'ui', 'mailcenter.html'), { query })
  }

  function toggleInput() { toggleOrbInput() }

  function toggleTheme() {
    // 托盘快捷循环:浅磨砂 → 墨玻璃 → 曜黑 → 纸白 → …(设置页可直选)
    const order = ['light', 'dark', 'onyx', 'paper']
    const i = order.indexOf(S.settings.theme)
    S.settings.theme = order[(i + 1) % order.length] || 'light'; saveSettings()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme-changed', S.settings.theme)
  }

  // ── 面板 / 托盘 ─────────────────────────────────────────────────────────────
  function openSettings() {
    if (S.settingsWin && !S.settingsWin.isDestroyed()) { S.settingsWin.show(); S.settingsWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const sx = Math.round(width / 2 - 280), sy = 120
    S.settingsWin = new BrowserWindow(baseOpts({ width: 560, height: 640, x: sx, y: sy, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 460, minHeight: 460 }))
    S.settingsWin.loadFile(path.join(__dirname, '..', 'ui', 'settings.html'), { query: orbAnchorFor(sx, sy, 560, 640) })
    S.settingsWin.on('closed', () => { S.settingsWin = null })
  }

  function openDock() {
    if (S.dockWin && !S.dockWin.isDestroyed()) { S.dockWin.show(); S.dockWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const W = 700, Hh = 880
    const dx = Math.round(width / 2 - W / 2), dy = 70
    S.dockWin = new BrowserWindow(baseOpts({ width: W, height: Hh, x: dx, y: dy, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 480, minHeight: 520 }))
    S.dockWin.loadFile(path.join(__dirname, '..', 'ui', 'dock.html'), { query: orbAnchorFor(dx, dy, W, Hh) })
    S.dockWin.on('closed', () => { S.dockWin = null })
  }

  // 【内嵌浏览器核心】整块搬进 ./browser 的 initBrowser(ctx) 工厂(见该文件抬头)。
  // 必须在 initRecorder 之前构造:后者构造时即读取返回的 brActive(const,非提升)。
  // 录制钩子 wireRecToTab/brSendRecCount 与 ensureOrbAlive 是后定义但已提升的 function,按引用注入。
  // 浏览器 IPC / brWC / 调试分诊层仍留在本文件,消费下面解构出的函数。
  const { brActive, newTab, closeTab, activateTab, brSetDevice, brRotateDevice, brZoom, brLayout, brSendTabs, sendNetSnapshot, attachDbg, detachDbg, normalizeUrl, brScreenshot, brNetBody, brPickElement, brEval, createBrowser, createWorkspace } = initBrowser({ S, session, log, path, fs, app, BrowserWindow, WebContentsView, oc, ensureOrbAlive, forgetBusy, wireRecToTab, brSendRecCount, cdpConsoleLevel, fmtRO, fmtException })

  // 【录制回放引擎】9 个函数搬进 ./recorder 的 initRecorder 工厂,这里注入闭包依赖后解构使用。
  // 必须放在 brActive(const,非提升)之后:initRecorder(ctx) 构造 ctx 时会即时读取 brActive。
  // 时序安全:此行在 initWindow 函数体靠前执行,而所有调用点(wireRecToTab/IPC handler/verifyFix/skillRun)均运行期才触发。
  const { injectRecorder, waitNetIdle, waitForEl, highlightTarget, execStep, startCoverage, stopCoverage, checkAssertions, replayRec } = initRecorder({ S, brActive, session, log, snapshotBad, RECORDER_JS, frameFor, findElExpr, coverageHits, gitChangedFiles })

  // ── 调试分诊 + 多 agent 对抗分析（工作台「发给 Agent」的大脑）──────────────────
  const tinyJson = (t) => { try { const m = String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, ' ').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null } catch { return null } }
  function dbgNote(cardWc, text, tone) { if (cardWc && !cardWc.isDestroyed()) cardWc.send('card-note', { text, tone: tone || 'info' }) }

  const DBG_LENS = {
    frontend: '作为资深前端工程师，假设根因在【前端】（状态管理 / 异步时序 / 事件绑定 / 渲染 / CSS / 打包构建）。请用工具读当前项目源码来求证或证伪这个假设，给出证据（文件:行）与判断（成立 / 不成立 / 部分成立）。',
    backend:  '作为资深后端工程师，假设根因在【后端】（接口实现 / 异常处理 / 数据 / 权限 / SQL / 配置）。请结合失败请求的状态码与响应体，用工具读源码求证或证伪，给出证据（文件:行）与判断。',
    contract: '作为接口联调专家，假设根因在【前后端契约】（参数格式 / 字段缺失 / 类型不符 / CORS / 鉴权头 / 接口版本）。请对比前端实际发出的请求与后端期望，求证或证伪，给出证据与判断。',
  }
  const DBG_TAG = { frontend: '前端', backend: '后端', contract: '接口契约' }

  // 分诊：先验来自启发式，这里让模型确认是否真的值得上多 agent（超时/失败回退启发式）
  async function dbgTriage(serve, summary, heur, model) {
    const p = `你是调试分诊器。根据复现信号，判断是否值得启动"多 agent 对抗分析"（多个 agent 各持一个假设并行查证，再交叉反驳）。\n` +
      `启发式先验：难度 ${heur.difficulty}/5，疑似层面 [${heur.layers.join(', ') || '未知'}]。\n\n复现信号摘要：\n${summary}\n\n` +
      `判断规则：跨前后端 / 根因不明确 / 多条相互矛盾线索 → multi；单一明确报错或单层小问题 → single（更快）。\n` +
      `只输出 JSON、不要调用任何工具、不要解释：{"difficulty":1-5,"layers":["frontend"|"backend"|"contract"...],"strategy":"single"|"multi","reason":"一句中文理由"}`
    try {
      const sid = await oc.createSession(serve, '分诊')
      const txt = await Promise.race([oc.sendMessage(serve, sid, p, model || null), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 45000))])
      const j = tinyJson(txt)
      if (j && (j.strategy === 'single' || j.strategy === 'multi')) {
        return { difficulty: +j.difficulty || heur.difficulty, layers: (Array.isArray(j.layers) && j.layers.length) ? j.layers : heur.layers, strategy: j.strategy, reason: j.reason || '' }
      }
    } catch (e) { log('triage fallback: ' + e.message) }
    return { ...heur, reason: '（模型分诊不可用，按启发式判断）' }
  }

  // 整个流程是后台异步（不阻塞「发给 Agent」按钮）：分诊 → 单 agent 直注 / 多 agent 并行调查 + 汇总回灌会话
  async function runDebugFlow({ cardWc, serve, bundlePrompt, disp, heur, summary }) {
    const inj = (text) => { if (cardWc && !cardWc.isDestroyed()) cardWc.send('card-inject', { text, disp: '' }) }
    // 子会话(分诊/lens/后端修复)跟随宿主调试卡当前所选模型;卡没选就用全局默认
    const hostSid = S.sessionByWc.get(cardWc && cardWc.id)
    const hostSi = hostSid && S.sessionInfo.get(hostSid)
    const hostModel = (hostSi && hostSi.model) || (S.modelByWc && cardWc && S.modelByWc.get(cardWc.id)) || S.settings.model || null
    try {
      dbgNote(cardWc, disp, 'user')
      // 信号简单 → 直接单 agent，省掉一次分诊调用
      if (heur.strategy === 'single' && heur.difficulty <= 2) {
        dbgNote(cardWc, `🧭 分诊：难度 ${heur.difficulty}/5 · 单 agent 直接定位`, 'info')
        inj(bundlePrompt); return
      }
      dbgNote(cardWc, '🧭 正在评估是否需要多 agent 对抗分析…', 'info')
      const v = await dbgTriage(serve, summary, heur, hostModel)
      dbgNote(cardWc, `🧭 分诊：难度 ${v.difficulty}/5 · 层面 [${(v.layers || []).map(k => DBG_TAG[k] || k).join('、') || '未定'}] · ${v.strategy === 'multi' ? '启动多 agent 对抗分析' : '单 agent 直接定位'}${v.reason ? '\n' + v.reason : ''}`, 'info')
      if (v.strategy !== 'multi') { inj(bundlePrompt); return }
      // 选 2~3 个假设角度（不足两个时补 frontend/contract 形成对抗）
      // 后端仓库：opencode 一 serve 一目录，跨前后端必须分 serve。配了就让后端调查/修复在它自己的 serve 上跑
      const backendDir = S.settings.backendDir || ''
      let backendServe = null
      // 后端仓库必须独立 serve(不能复用前端 / 用户手动起的 serve,cwd 不匹配会改错文件)
      if (backendDir) { try { backendServe = await oc.ensureServe(backendDir, S.handlers, log, { tryShare: false }) } catch (e) { dbgNote(cardWc, `后端仓库 serve 启动失败：${e.message}`, 'muted') } }
      let lenses = (v.layers || []).filter(k => DBG_LENS[k])
      for (const k of ['frontend', 'contract', 'backend']) { if (lenses.length >= 2) break; if (!lenses.includes(k)) lenses.push(k) }
      lenses = lenses.slice(0, 3)
      if (backendServe && !lenses.includes('backend')) lenses = [...lenses.slice(0, 2), 'backend']   // 配了后端仓库必查后端
      lenses.forEach(k => dbgNote(cardWc, `🤖 假设·${DBG_TAG[k]} 调查中…${k === 'backend' && backendServe ? '（后端仓库）' : ''}`, 'muted'))
      // #7 假设生成式分诊:并行起一个"开放式假设 lens",不局限于 frontend/backend/contract 三分类,
      // 让 agent 自己列 3 个最可能根因(可能是状态机/缓存/竞态/CSS 等启发式抓不到的)
      const dynamicLens = (async () => {
        let sid; try {
          sid = await oc.createSession(serve, '假设生成')
          S.sessionInfo.set(sid, { wc: cardWc, serve })
          const out = await oc.sendMessage(serve, sid, `根据下面这个复现包,**枚举 3 个最可能的根因假设**(每条 1 句话,按可能性排序),并对每条简述一句怎么验证。\n\n` +
            `不限于前端/后端/接口契约这 3 类,可以是状态机/并发竞态/缓存/CSS 布局/权限/边界条件/数据格式等任何角度。\n` +
            `**只输出假设清单,不要读代码、不要修改文件。**\n\n## 复现上下文\n` + bundlePrompt, hostModel)
          return { k: 'open_hypotheses', out, repo: '前端仓库(开放式)' }
        } catch (e) { return { k: 'open_hypotheses', out: '(假设生成失败:' + e.message + ')', repo: '前端仓库' } }
        finally { if (sid) { S.sessionInfo.delete(sid); S.streamBuf.delete(sid) } }
      })()
      dbgNote(cardWc, '🧭 同时启动开放式假设生成 lens(不局限于固定 3 分类)…', 'muted')
      const heurFindings = await Promise.all(lenses.map(async (k) => {
        const useServe = (k === 'backend' && backendServe) ? backendServe : serve
        const repo = useServe === backendServe ? '后端仓库' : '前端仓库'
        let sid
        try {
          sid = await oc.createSession(useServe, '调查:' + k)
          S.sessionInfo.set(sid, { wc: cardWc, serve: useServe })   // 只读工具自动放行；权限回本卡
          // 注入"共享便签":其它 lens 已经 confirmed/excluded 的假设,本 lens 不要重复查
          const notesHint = `\n\n# 团队共享便签(其它 agent/lens 已登记的假设状态)\n` +
            `请用 mcp 'BocomHermes-repro' 的 **read_notes{bundleId:"${bundleId || S.browser.lastBundleId || ''}"}** 工具先读现有便签 — excluded 的假设跳过,confirmed 的当前提条件用,maybe 的可作辅证。\n` +
            `你**调查结束时**(无论假设成立与否),都要用 **bundle_note{bundleId, key:"${k}_${Date.now().toString(36).slice(-4)}", status, evidence}** 把你的结论登记进去,让后续 lens 节省 token、避免重复劳动。`
          const out = await oc.sendMessage(useServe, sid, DBG_LENS[k] + `\n（你正在【${repo}】里，只能读到这个仓库的源码）\n\n## 复现上下文\n` + bundlePrompt + notesHint + '\n\n只聚焦你这个假设，简洁给出证据（文件:行）与判断，不要修改任何文件。', hostModel)
          dbgNote(cardWc, `✓ 假设·${DBG_TAG[k]} 完成`, 'muted')
          return { k, out, repo }
        } catch (e) { dbgNote(cardWc, `✗ 假设·${DBG_TAG[k]} 失败：${e.message}`, 'muted'); return { k, out: '(调查失败：' + e.message + ')', repo } }
        finally { if (sid) { S.sessionInfo.delete(sid); S.streamBuf.delete(sid) } }
      }))
      // 等启发式 + 开放式两路都跑完,合并
      const dyn = await dynamicLens
      const findings = [...heurFindings, dyn]
      dbgNote(cardWc, `✓ 开放式假设 lens 完成`, 'muted')
      const merged = findings.map(f => `### ${f.k === 'open_hypotheses' ? '开放式假设清单' : '假设·' + (DBG_TAG[f.k] || f.k)}（${f.repo}）\n${f.out}`).join('\n\n')

      // 后端修复：卡片会话在前端仓库改不到后端，所以由后端仓库 serve 上的 agent 判断并直接改后端源码（权限回本卡）
      if (backendServe) {
        dbgNote(cardWc, '🔧 后端 agent 正在判断是否需要改后端…', 'muted')
        let bsid
        try {
          bsid = await oc.createSession(backendServe, '后端修复')
          S.sessionInfo.set(bsid, { wc: cardWc, serve: backendServe })
          const bout = await oc.sendMessage(backendServe, bsid,
            `你在【后端仓库】里。下面是一个从前端复现的问题 + 多路调查结论。如果根因/修复在后端，请直接用编辑工具修改后端源码完成修复（我会逐次确认写入），改完用一两句话说明改了哪些文件、为什么；如果与后端无关，只回复"后端无需改动"。\n\n## 复现上下文\n${bundlePrompt}\n\n## 各路调查结论\n${merged}`, hostModel)
          dbgNote(cardWc, '🔧 后端 agent：' + String(bout || '').replace(/\s+/g, ' ').slice(0, 500), 'muted')
          findings.push({ k: 'backend-fix', out: bout, repo: '后端仓库' })
        } catch (e) { dbgNote(cardWc, `后端修复失败：${e.message}`, 'muted') }
        finally { if (bsid) { S.sessionInfo.delete(bsid); S.streamBuf.delete(bsid) } }
      }

      const mergedAll = findings.map(f => `### ${f.k === 'backend-fix' ? '后端修复结果' : '假设·' + (DBG_TAG[f.k] || f.k)}（${f.repo}）\n${f.out}`).join('\n\n')
      inj(`下面是对同一问题的多路并行调查${backendServe ? '（跨前后端两个仓库）+ 后端 agent 的修复结果' : ''}。请交叉验证、定出最可能的【唯一根因】。**前端改动你直接用编辑工具修改（你在前端仓库）**；${backendServe ? '后端已由后端 agent 在后端仓库处理，你据其结果说明后端结论即可，不要试图改后端文件；' : ''}改完总结根因与各端改动。\n\n## 原始复现上下文\n${bundlePrompt}\n\n## 各路调查结论\n${mergedAll}`)
    } catch (e) {
      log('runDebugFlow err: ' + e.message)
      dbgNote(cardWc, '⚠ 分析流程出错：' + e.message + '（回退为单 agent）', 'info')
      inj(bundlePrompt)
    }
  }

  // ── 证据库 ─────────────────────────────────────────────────────────────
  // 大 payload(完整 DOM / 长 req body / 完整事件帧)落盘 evidence/<bundleId>/<ref>.txt,
  // 主上下文里只放短摘要 + ref 引用,Agent 用 mcp/repro-mcp 的 get_evidence 工具按需拉。
  // 128K 上下文友好;5KB 摘要不再被 9KB DOM 撑爆。
  function evidenceDir(bundleId) {
    const d = path.join(app.getPath('userData'), 'evidence', bundleId)
    try { fs.mkdirSync(d, { recursive: true }) } catch {}
    return d
  }
  function evdSave(bundleId, name, content) {
    try { fs.writeFileSync(path.join(evidenceDir(bundleId), name + '.txt'), String(content == null ? '' : content)) } catch (e) { log('evdSave err: ' + e.message) }
    return `ref#${bundleId}/${name}`
  }

  // 按动作生成紧凑时间线文本(<200 字/条),录制的 JSON 转人读
  function formatTimeline(events) {
    if (!events || !events.length) return '(本次未录制操作)'
    const lines = []
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      const t = ((e.t || 0) / 1000).toFixed(1).padStart(5)
      if (e.act === 'navigate') lines.push(`  t=${t}s  navigate    ${e.url}`)
      else if (e.act === 'click') lines.push(`  t=${t}s  click       ${e.sel}${e.text ? '  ("' + e.text.slice(0, 30) + '")' : ''}`)
      else if (e.act === 'input') lines.push(`  t=${t}s  input       ${e.sel} = "${(e.value || '').slice(0, 60)}"`)
      else if (e.act === 'key')   lines.push(`  t=${t}s  key         ${e.key} @ ${e.sel}`)
      else if (e.act === 'submit')lines.push(`  t=${t}s  submit      ${e.sel}`)
      else if (e.act === 'scroll')lines.push(`  t=${t}s  scroll      (${e.x}, ${e.y})`)
    }
    return lines.join('\n')
  }

  // 统一"异常网络快照":4xx/5xx/failed + 200 业务异常,async 因为要 fetch body
  async function snapshotBad(tab) {
    const failed = tab.net.filter((r) => r.state === 'failed' || (r.status && r.status >= 400))
    const xhr200 = tab.net.filter((r) => r.status === 200 && /xhr|fetch|XHR|Fetch/.test(r.type || ''))
    const biz = []
    for (const r of xhr200.slice(-30)) {
      if (r._biz) { biz.push(r); continue }   // 已检测过(compactRepro 跑过)
      if (r._bizChecked) continue
      r._bizChecked = true
      try { const d = await brNetBody(r.id); if (d && d.body && !d.base64) { const det = detectBizError(d.body, d.mime); if (det && det.hit) { r._biz = det; biz.push(r) } } } catch {}
    }
    return [...failed, ...biz].map((r) => ({ url: r.url, status: r.status || 0, state: r.state || '', biz: r._biz ? r._biz.hint : '' }))
  }

  // 200 业务异常检测:信贷/银行类后端常用"HTTP 200 + body 里 code != 0 / success: false"模式。
  // 不做这层探测,bundle 看不见这些"看似成功实则失败"的请求。返回 {hit, hint} 或 null。
  function detectBizError(body, mime) {
    if (!body) return null
    const s = String(body).slice(0, 4000).trim()
    // 优先 JSON 路径
    let j = null
    if (/^[{\[]/.test(s) && (!mime || /json/i.test(mime))) {
      try { j = JSON.parse(s) } catch {}
    }
    if (j && typeof j === 'object') {
      // 各家常见字段:code/respCode/retCode/errCode/status/ret
      const codeFields = ['code', 'respCode', 'retCode', 'errCode', 'errcode', 'ret', 'retcode', 'rspCode']
      for (const k of codeFields) {
        if (k in j) {
          const v = j[k]
          // 0 / '0' / '00' / '00000' / 'success' / 'SUCCESS' = 成功;其它视为异常
          const ok = v === 0 || v === '0' || /^0+$/.test(String(v)) || /^(success|ok|true)$/i.test(String(v))
          if (!ok) { return { hit: true, hint: `${k}=${JSON.stringify(v)}` + (j.message || j.msg || j.errMsg || j.errorMsg ? ' · ' + String(j.message || j.msg || j.errMsg || j.errorMsg).slice(0, 100) : '') } }
        }
      }
      // success/status: false / 'fail' / 'error'
      if (j.success === false) return { hit: true, hint: 'success=false' + (j.error || j.message || j.msg ? ' · ' + String(j.error || j.message || j.msg).slice(0, 100) : '') }
      if (typeof j.status === 'string' && /^(error|fail(ed)?|exception)$/i.test(j.status)) return { hit: true, hint: 'status=' + j.status + (j.message || j.msg ? ' · ' + String(j.message || j.msg).slice(0, 100) : '') }
      // 只有 error/exception 字段且非空
      if ((j.error && typeof j.error === 'string' && j.error) || (j.exception && j.exception)) return { hit: true, hint: 'error=' + String(j.error || j.exception).slice(0, 120) }
    }
    // 退化:body 里出现 "异常"/"错误"/"Exception"/"errMsg" 等关键字(只针对 xhr/fetch 类)
    if (/("|^)(errMsg|errorMessage|exception)("|$)/i.test(s) || /(系统异常|业务异常|失败|错误信息)/.test(s)) {
      return { hit: true, hint: '响应体含错误关键字' }
    }
    return null
  }

  // 因果链:把录制时间线的 click/submit/key 与"事后 2s 内"的网络/业务异常 + 控制台报错配对,
  // 让 agent 直接看出"哪个操作 → 触发了哪个接口出错 → 引发了哪个报错"。Agent 自己拼时间线很容易猜歪。
  function causalChains(events, recStartTs, tab) {
    if (!events || !recStartTs) return []
    const userActs = events.filter((e) => e.act === 'click' || e.act === 'submit' || e.act === 'key')
    if (!userActs.length) return []
    const chains = []
    for (const e of userActs.slice(-6)) {
      const absT = recStartTs + (e.t || 0)   // 该 user action 的墙钟时间
      // 找此后 2s 内的第一个 4xx/5xx/failed 或 200 业务异常
      const net = tab.net.find((r) => {
        if (!r.tWall) return false
        const tMs = r.tWall   // #2 墙钟(epoch ms),与 absT 同一时基;t0 是 CDP 单调时钟(秒),与墙钟不同源不能直接比
        if (tMs < absT || tMs > absT + 2000) return false
        return r.state === 'failed' || (r.status && r.status >= 400) || (r.status === 200 && r._biz && r._biz.hit)
      })
      // 找此后 4s 内的第一个 console.error(level=3)
      const err = tab.console.find((c) => {
        if (!c.ts) return false
        if (c.ts < absT || c.ts > absT + 4000) return false
        return c.level === 3
      })
      if (net || err) {
        const a = `t=${((e.t || 0) / 1000).toFixed(1)}s ${e.act} ${(e.sel || '').slice(0, 40)}${e.text ? ' "' + e.text.slice(0, 20) + '"' : ''}`
        const n = net ? ` → ${net._biz ? '200·业务异常 ' + net._biz.hint : (net.status || net.state) + ' ' + (net.method || '') + ' ' + (net.url || '')}` : ''
        const r = err ? ` → ✗ ${(err.message || '').split('\n')[0].slice(0, 100)}` : ''
        chains.push('  · ' + a + n + r)
      }
    }
    return chains
  }

  // 把"现在的现场"压成一份 <5KB 摘要 + 引用大块的 refs
  async function compactRepro(tab) {
    const bundleId = 'b_' + Date.now().toString(36)
    const wc = tab.view.webContents
    // DOM:只取摘要(title/url/前 800 字符可见文本 + body 的 outerHTML 截 1.5KB);完整 outerHTML 落盘
    let dom = { title: '', desc: '', visText: '', shortHtml: '' }, fullHtml = ''
    try {
      const r = await wc.executeJavaScript(`(()=>{
        const h=document.documentElement.outerHTML;
        const vt=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();
        const dd=document.querySelector('meta[name="description"]');
        return { title:document.title, desc: dd?dd.content:'', vis: vt.slice(0,800), shortHtml: (document.body?document.body.outerHTML:'').slice(0,1500), full: h };
      })()`, true)
      dom = { title: r.title || '', desc: r.desc || '', visText: r.vis || '', shortHtml: r.shortHtml || '' }
      fullHtml = r.full || ''
    } catch {}
    const domRef = fullHtml ? evdSave(bundleId, 'dom', fullHtml) : ''

    // 控制台:只列 warn/error,聚类后(同 stack 签名只列一次 + 计数)主文按 source-map 给"文件:行"
    const errs = tab.console.filter((c) => c.level >= 2)
    const groups = clusterErrs(errs).sort((a, b) => b.count - a.count).slice(0, 15)
    const errLines = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]; const c = g.sample; const tag = c.level === 3 ? '[E' : '[W'
      let loc = c.source ? String(c.source).split('/').pop() + (c.line ? ':' + c.line : '') : ''
      if (c.frames && c.frames.length) {
        for (const fr of c.frames.slice(0, 4)) { const r2 = await resolveFrame(fr.url, fr.line, fr.col); if (r2) { loc = r2 + (fr.fn ? ' (' + fr.fn + ')' : ''); break } }
      }
      const repeat = g.count > 1 ? `  ×${g.count}` : ''
      let line = `  ${tag}${i + 1}] ${c.message.split('\n')[0].slice(0, 220)}${repeat}  @ ${loc || '?'}`
      if (c.frames && c.frames.length > 1) {
        const stackRef = evdSave(bundleId, 'err' + (i + 1) + '-stack', JSON.stringify(c.frames, null, 2))
        line += `  · 完整堆栈 ${stackRef}`
      }
      errLines.push(line)
    }

    // 网络异常:4xx/5xx/failed + **200 但 body 里业务异常**(信贷/银行后端常用)
    const isXhrLike = (r) => /xhr|fetch|XHR|Fetch/.test(r.type || '')
    const networkBad = tab.net.filter((r) => r.state === 'failed' || (r.status && r.status >= 400))
    // 200 业务异常候选:只看 xhr/fetch,避免拉静态资源 body
    const biz200Cand = tab.net.filter((r) => r.status === 200 && isXhrLike(r))
    const biz200 = []
    for (const r of biz200Cand.slice(-20)) {
      try { const d = await brNetBody(r.id); if (d && d.body && !d.base64) { const det = detectBizError(d.body, d.mime); if (det && det.hit) { r._biz = det; r._body = d.body; biz200.push(r) } } } catch {}
    }
    // 合并 + 截 -8(最新优先)
    const bad = [...networkBad.slice(-8), ...biz200.slice(-8)].slice(-12)
    const netLines = []
    for (let i = 0; i < bad.length; i++) {
      const r = bad[i]; let body = r._body || '', isBin = false
      if (!body) { try { const d = await brNetBody(r.id); if (d) { body = String(d.body || ''); isBin = !!d.base64 } } catch {} }
      const st = r._biz ? ('200·业务异常 ' + r._biz.hint) : (r.state === 'failed' ? ('失败 ' + (r.failText || '')) : (r.status + ' ' + (r.statusText || '')))
      let line = `  [N${i + 1}] ${r.method} ${st}  ${r.url}`
      if (r.postData) {
        const pd = String(r.postData)
        if (pd.length > 200) { const ref = evdSave(bundleId, 'req' + (i + 1) + '-body', pd); line += `\n      请求体: (${pd.length}B) ref#${ref.split('/').pop()} · 摘要: ${pd.slice(0, 120)}…` }
        else { line += `\n      请求体: ${pd.slice(0, 200)}` }
      }
      if (body && !isBin) {
        if (body.length > 200) { const ref = evdSave(bundleId, 'resp' + (i + 1) + '-body', body); line += `\n      响应体: (${body.length}B) ref#${ref.split('/').pop()} · 摘要: ${body.slice(0, 120)}…` }
        else { line += `\n      响应体: ${body.slice(0, 200)}` }
      } else if (isBin) { line += `\n      响应体: (binary, 略)` }
      netLines.push(line)
    }

    // 录制时间线(当前标签最近一次)
    const rec = (S.browser.lastRec && S.browser.lastRec.tabId === tab.id) ? S.browser.lastRec
      : (S.browser.lastRec || null)   // tabId 未必存(早期 rec 没记) → 拿就用
    const tl = rec ? formatTimeline(rec.events) : '(本次未录制操作 — 想让 Agent 自动验证修复,先按"录制"复现一次)'
    const recRef = rec ? evdSave(bundleId, 'recording', JSON.stringify(rec, null, 2)) : ''

    // 页面级捕获:fetch/XHR 全量(解决 CDP 拿不到响应体)+ alert/confirm/prompt + 错误模态/Toast
    let pageCap = { net: [], dialogs: [], errModals: [] }
    try { const raw = await wc.executeJavaScript(`JSON.stringify({n:window.__BR_CAP_NET||[],d:window.__BR_CAP_DIALOG||[],e:window.__BR_CAP_ERRMODAL||[]})`, true); const o = JSON.parse(raw || '{}'); pageCap = { net: o.n || [], dialogs: o.d || [], errModals: o.e || [] } } catch {}

    // 给 netLines 补"页面级 body fallback":CDP 拿不到 body 的请求(body 空 / "无法获取"),
    // 找页面 CAP 里同 URL 的最近一条用它的 respBody 作补
    if (pageCap.net.length) {
      const findCap = (url) => {
        for (let i = pageCap.net.length - 1; i >= 0; i--) { if (pageCap.net[i].url === url || (pageCap.net[i].url && pageCap.net[i].url.endsWith(url.split('?')[0].split('/').pop() || ''))) return pageCap.net[i] }
        return null
      }
      for (let i = 0; i < bad.length; i++) {
        const r = bad[i]
        // 如果这条 netLine 没有响应体或显示"无法获取",用 pageCap 的 respBody 顶
        const hasBody = / 响应体: /.test(netLines[i] || '')
        if (!hasBody) {
          const cap = findCap(r.url)
          if (cap && cap.respBody) {
            const bodyTxt = String(cap.respBody)
            if (bodyTxt.length > 200) { const ref = evdSave(bundleId, 'resp' + (i + 1) + '-page', bodyTxt); netLines[i] += `\n      响应体(页面捕获,CDP 拿不到时兜底): (${bodyTxt.length}B) ref#${ref.split('/').pop()} · 摘要: ${bodyTxt.slice(0, 120)}…` }
            else netLines[i] += `\n      响应体(页面捕获): ${bodyTxt.slice(0, 200)}`
          }
        }
      }
    }
    // 弹窗 + 错误模态 单独一节(信贷常用)
    const dialogLines = pageCap.dialogs.slice(-10).map((d, i) => `  [D${i + 1}] ${d.kind}: ${d.text}`).join('\n')
    const modalLines = (() => {
      // 同文本去重 + 取最近 8
      const seen = new Set(); const out = []
      for (let i = pageCap.errModals.length - 1; i >= 0 && out.length < 8; i--) {
        const e = pageCap.errModals[i]; const k = (e.text || '').slice(0, 80)
        if (seen.has(k)) continue; seen.add(k)
        out.unshift(`  [M${out.length + 1}] ${e.cls ? '.' + e.cls.split(/\s+/).slice(0, 2).join('.') + ' ' : ''}${e.text}`)
      }
      return out.join('\n')
    })()

    const exp = rec && rec.expectation ? rec.expectation : ''
    const text = `=== 复现包 ${bundleId} ===
URL: ${tab.url || '(空白页)'}
标题: ${dom.title || tab.title}
${exp ? '\n📝 用户期望(请优先围绕这个目标修): ' + exp + '\n' : '\n⚠ 用户未声明期望 — 你只能凭报错/异常推测,推测前请向用户确认目标\n'}${dom.desc ? '页面描述: ' + dom.desc + '\n' : ''}DOM 摘要(可见文本前 800 字): ${dom.visText || '(空)'}${domRef ? '\n完整 DOM: ' + domRef : ''}

时间线 (${rec ? rec.events.length : 0} 步):
${tl}${recRef ? '\n录制完整 JSON: ' + recRef : ''}${rec && rec.startedAt ? (() => {
  const chains = causalChains(rec.events, rec.startedAt, tab)
  return chains.length ? '\n\n因果链(操作→网络/业务异常→报错,2-4s 时窗自动配对,**优先看这段**):\n' + chains.join('\n') : ''
})() : ''}

控制台 warn/error (${errs.length} 条):
${errLines.length ? errLines.join('\n') : '  (无)'}

网络/业务异常 (${bad.length} 条;含 4xx/5xx/failed + **HTTP 200 但 body 业务异常**,后者内网信贷常见):
${netLines.length ? netLines.join('\n') : '  (无)'}

弹窗 / 错误模态 / Toast (页面级捕获 ${pageCap.dialogs.length + pageCap.errModals.length} 条 — 内网信贷常用模态报错+流水号):
${dialogLines || '  (无 alert/confirm/prompt)'}
${modalLines || '  (无错误样态 DOM 节点)'}

(大 payload 已落盘 userData/evidence/${bundleId}/;agent 可用 mcp 'tianshu-repro' 的 get_evidence 工具按需拉:传入 'ref#${bundleId}/<name>')`
    return { bundleId, text, errs, bad }
  }

  async function brAnalyze() {
    const tab = brActive(); if (!tab) return
    const { bundleId, text: bundle, errs, bad } = await compactRepro(tab)
    const planMode = S.settings.planMode !== false   // 默认 ON
    const planStep = planMode
      ? `【方案模式 — 你这次必须先出方案,等用户点"批准方案"才动手】\n` +
        `4. **不要立刻 edit**!先用编辑工具读相关源码,搞清根因;然后输出一份完整方案:\n` +
        `   - 一句话根因\n` +
        `   - 影响半径(用 scan_impact{bundleId:"${bundleId}", symbol, cwd} 扫每个要改的符号)\n` +
        `   - 计划改动清单:每条 "文件:行 — 改什么 — 为什么"\n` +
        `   - 风险提示 + 自评 risk 1~5\n` +
        `5. 等待用户回复"批准方案"(我会真发一条这样的消息)。批准前**严禁**调用任何 edit 类工具。\n` +
        `6. 批准后再 edit + 调 repro_assert / repro_self_review;改完用 mcp 'BocomHermes-repro' 的工具登记并简要总结(系统会自动展示 git diff)。\n`
      : `4. **改文件前先查影响半径(必做)**:对每个将要修改的导出符号,调 scan_impact{bundleId:"${bundleId}", symbol, cwd}\n` +
        `5. **直接用编辑工具改源码**(我会逐次确认每处写入),改完一两句话说明改了什么\n` +
        `6. **改完后必做两件**(repro-mcp 工具):① repro_assert 声明 1~4 条断言 ② repro_self_review 自评 risk + summary + edge_cases\n`
    const prompt =
      `我正在用内嵌浏览器复现一个问题，请你作为资深全栈工程师帮我定位根因并给出修复方案。\n\n` +
      bundle + '\n\n' +
      `请按以下步骤帮我修复：\n` +
      `1. 看时间线还原"用户做了什么导致问题",再结合控制台/网络/业务异常/弹窗模态定位根因(优先看 source-map 还原的"文件:行")\n` +
      `   ⚠ 内网信贷接口常**返回 200 但 body 里 code != 0** — bundle 里"200·业务异常"标的就是这类,务必当成失败处理\n` +
      `   ⚠ 流水号 / transactionId 通常在弹窗或错误模态里 — bundle 已抓"弹窗/错误模态"段,优先扫这里\n` +
      `2. 大块证据(完整 DOM / 长 req body)按需用 mcp 'BocomHermes-repro' 的 get_evidence/get_dom_subtree/get_event_window 工具拉详情;别一次性塞回回复\n` +
      `3. 用编辑工具读相关源码,确认根因所在的具体文件与行\n` +
      planStep +
      `7. 改完点"验证" — 系统:① 回放时间线 ② 检查改过 JS 是否被执行 ③ 核对断言 ④ 检查盲改 ⑤ 显示 self-review\n` +
      `   → 多维度判定 PASS / FAIL / SUSPICIOUS。FAIL 看报告调整,不要乱猜。\n` +
      `8. FAIL 且方向错了,**先用 repro_rollback{cwd, dryRun:true}** 列出会回滚的文件,确认后 dryRun:false 清掉本轮改动,从头分析。`
    S.browser.lastBundleId = bundleId   // verify 用它读 mcp 'repro_assert' 写入的断言
    log('brAnalyze: bundle ' + bundleId + ' size=' + Buffer.byteLength(bundle) + 'B')
    const disp = `🔍 已复现并发送：${tab.url || '(空白页)'}\n（${errs.length} 条控制台报错 + ${bad.length} 条网络异常 + 页面 DOM 上下文）`
    const b = S.browser
    if (b.mode === 'workspace' && b.cardView && !b.cardView.webContents.isDestroyed()) {
      const cardSid = S.sessionByWc.get(b.cardWcId)
      const cardSi = cardSid && S.sessionInfo.get(cardSid)
      if (cardSi && cardSi.serve) {
        // 启发式分诊先验：从捕获信号判断疑似层面 + 难度 + 是否需要多 agent
        const hasJsErr = errs.some(c => c.level === 3)
        const fe = hasJsErr || tab.net.some(r => r.status === 404 && /script|stylesheet|image|font|document/i.test(r.type || ''))
        const be = tab.net.some(r => r.state === 'failed' || (r.status >= 500))
        const ct = tab.net.some(r => [400, 401, 403, 422].includes(r.status) && /xhr|fetch/i.test(r.type || '')) || errs.some(c => /CORS|cross-origin/i.test(c.message))
        const layers = ['frontend', 'backend', 'contract'].filter((_, i) => [fe, be, ct][i])
        let difficulty = (errs.length || bad.length) ? 2 : 1
        if (bad.length) difficulty = 3
        if (layers.length >= 2) difficulty = 4
        if (fe && be) difficulty = 5
        const backendDir = S.settings.backendDir || ''
        // 配了后端仓库且有后端/契约信号 → 强制多 agent（这样后端调查/修复会在后端仓库 serve 上跑）
        const strategy = (layers.length >= 2 || difficulty >= 4 || (backendDir && (be || ct))) ? 'multi' : 'single'
        const summary = `URL：${tab.url || '(空白页)'}\n控制台错误/警告：${errs.length} 条${hasJsErr ? '（含 JS 错误）' : ''}\n网络异常：${bad.length} 条${be ? '（含 5xx/失败）' : ''}${ct ? '（含 4xx/CORS）' : ''}\n疑似层面：${layers.join('、') || '未定'}${backendDir ? '\n已配置后端仓库：可跨前后端调查/修复' : ''}`
        runDebugFlow({ cardWc: b.cardView.webContents, serve: cardSi.serve, bundlePrompt: prompt, disp, heur: { layers, difficulty, strategy }, summary })   // 后台异步，不阻塞按钮
      } else {
        b.cardView.webContents.send('card-inject', { text: prompt, disp })   // 会话还没就绪 → 退化为直接注入
      }
    } else {
      spawnCard('前端调试分析', null, prompt, disp)                          // 独立浏览器：另开一张分析卡
    }
  }

  // 闭环验证：重载复现页 → 重新采集 console/网络 → 把"修复后状态"回灌左侧 Agent 让它确认或继续修
  async function verifyFix() {
    const b = S.browser
    if (b.mode !== 'workspace' || !b.cardView || b.cardView.webContents.isDestroyed()) return
    const tab = brActive(); if (!tab) return
    const cardWc = b.cardView.webContents
    const wc = tab.view.webContents
    const rec = b.lastRec

    // 路径 A: 有录制 → 自动回放 + diff 报告(真正闭环)
    if (rec && rec.events && rec.events.length) {
      dbgNote(cardWc, '🔁 验证修复:回放录制(' + rec.events.length + ' 步)…', 'info')
      const replay = await replayRec(rec)
      if (!replay.ok) { dbgNote(cardWc, '⚠ 回放失败:' + (replay.error || ''), 'info'); return }
      // 读 agent 写入的断言 / 影响半径扫描 / self-review
      const bid = rec.bundleId || S.browser.lastBundleId
      const assertions = await checkAssertions(tab, loadAssertions(bid))
      replay.assertions = assertions
      replay.scans = loadScans(bid)   // {scans:[], scannedFiles:Set}
      replay.review = loadReview(bid)  // 或 null
      const rep = diffReport(rec, replay)
      const snap = rec.snapshot || { errs: [], bad: [] }   // 导入的技能没有 snapshot
      const hitSummary = replay.hitInfo && replay.hitInfo.length ? `;改动 ${replay.hitInfo.length} 文件,${replay.hitInfo.filter((h) => h.executed > 0).length} 个被执行` : ''
      const statusKind = rep.pass ? 'pass' : (/SUSPICIOUS/.test(rep.verdict) ? 'suspicious' : 'fail')
      const disp = `🔁 验证完成 · ${rep.pass ? '✅ PASS' : (statusKind === 'suspicious' ? '⚠ SUSPICIOUS' : '❌ FAIL')}\n(回放 ${replay.stepReport.length}/${rec.events.length} 步;修复前 ${snap.errs.length}/${snap.bad.length} → 修复后 ${replay.after.errs.length}/${replay.after.bad.length}${hitSummary})`
      // 同步推一份卡片到浏览器壳 UI,用户在右下角一眼看到结论而不用翻 agent 对话流
      if (b.win && !b.win.isDestroyed()) {
        b.win.webContents.send('wf-verify-result', {
          kind: statusKind, verdict: rep.verdict, fullText: rep.text,
          summary: `回放 ${replay.stepReport.length}/${rec.events.length} 步 · 修复前 ${snap.errs.length}报错/${snap.bad.length}异常 → 修复后 ${replay.after.errs.length}/${replay.after.bad.length}${hitSummary}`,
        })
      }
      const prompt =
        `我刚才录制了复现路径,你改完代码后我点了验证 → 系统自动回放并对比"修复前/后"的报错和网络异常。\n\n` +
        '## 回放验证报告\n' + rep.text + '\n\n' +
        (rep.pass
          ? '看起来修好了。请简要总结你这次的根因诊断 + 关键改动,并指出是否还有相关边界需要补测试用例。'
          : '回放显示问题没修好(或引入了新问题)。请认真看上面的对比,判断是修复没生效、改错了文件、还是另有根因,然后继续用编辑工具调整。')
      cardWc.send('card-inject', { text: prompt, disp })
      return
    }

    // 路径 B: 没录制 → 退回旧的"重载看现状"模式
    const url = tab.url || '(当前页)'
    dbgNote(cardWc, '🔁 验证修复:本次未录制 → 退回重载模式(下次点"录制"复现可启用自动回放)', 'info')
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; try { wc.off('did-stop-loading', onStop) } catch {} resolve() }
      const onStop = () => setTimeout(finish, 2500)
      wc.once('did-stop-loading', onStop)
      setTimeout(finish, 12000)
      try { wc.reload() } catch { finish() }
    })
    const errs = tab.console.filter((c) => c.level >= 2)
    const bad = tab.net.filter((r) => r.state === 'failed' || (r.status && r.status >= 400))
    const errText = errs.length ? errs.slice(-20).map((c) => (c.level === 3 ? '✗ ' : '⚠ ') + c.message).join('\n') : '(无 warning / error)'
    const clean = !errs.length && !bad.length
    const disp = `🔁 已重载验证: ${url}\n(${errs.length} 报错 + ${bad.length} 网络异常)`
    const prompt =
      `我已重载页面验证你刚才的修复(注:这次没用录制,只是简单重载)。重载后的当前状态:\n\n## 控制台报错(${errs.length})\n${errText}\n\n` +
      (clean
        ? '控制台与网络都干净了。下次想要更可靠的验证,我会先点"录制"把复现路径录下来,再点验证就能自动回放出 PASS/FAIL 报告。'
        : '仍有报错。判断是修复没生效、引入了新问题、还是另有根因,然后继续修。')
    cardWc.send('card-inject', { text: prompt, disp })
  }

  function trayMenuTemplate() {
    return [
      { label: '唤起输入框', accelerator: 'Ctrl+Shift+Space', click: toggleInput },
      { label: S.settings.orbHidden ? '显示桌面悬浮球' : '隐藏桌面悬浮球', click: () => setOrbHidden(!S.settings.orbHidden) },
      { type: 'separator' },
      { label: '🌐 调试工作台（Agent + 浏览器）', accelerator: 'Ctrl+Shift+B', click: () => createWorkspace() },
      { label: '📧 邮件（收件箱 · 摘要 · 设置）', accelerator: 'Ctrl+Shift+M', click: () => createMailCenter() },
      { label: '📄 需求分析（Word）', click: () => spawnReqAnalysis('') },
      { label: '📤 发件箱', click: openOutbox },
      { label: '📋 待办事项', click: () => createMailCenter('todos') },
      { label: '📸 截图提问', accelerator: 'Ctrl+Shift+S', click: () => snapAsk() },
      { label: '🛡 审计流水', click: openAudit },
      { label: '🕸 HTTP 抓包(外部程序)', click: openHttpcap },
      { label: '卡坞 · 历史对话', click: openDock },
      { label: '切换深 / 浅主题', click: toggleTheme },
      { label: '设置…', click: openSettings },
      { label: '打开日志', click: () => { if (S.logFile) shell.openPath(S.logFile).catch(() => {}) } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]
  }
  function refreshTrayMenu() {
    if (S.tray && !S.tray.isDestroyed()) S.tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()))
  }
  function buildTray() {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
    S.tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    S.tray.setToolTip('BocomHermes')
    refreshTrayMenu()
    S.tray.on('click', toggleOrbInput)
  }

  function attachContextMenu(wc) {
    wc.on('context-menu', (_e, p) => {
      const items = []
      // 浏览器标签页内:链接 / 图片 / 通用页面动作
      const isBrowserTab = (S.browser.tabs || []).some((t) => t.view && t.view.webContents === wc)
      if (p.linkURL) {
        if (isBrowserTab) items.push({ label: '在新标签打开链接', click: () => newTab(p.linkURL) })
        items.push({ label: '复制链接地址', click: () => clipboard.writeText(p.linkURL) })
      }
      if (p.srcURL && p.mediaType === 'image') {
        items.push({ label: '复制图片地址', click: () => clipboard.writeText(p.srcURL) })
        if (isBrowserTab) items.push({ label: '在新标签打开图片', click: () => newTab(p.srcURL) })
      }
      if (p.isEditable) {
        if (items.length) items.push({ type: 'separator' })
        items.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { type: 'separator' }, { role: 'selectAll', label: '全选' })
      } else if (p.selectionText && p.selectionText.trim()) {
        if (items.length) items.push({ type: 'separator' })
        items.push({ role: 'copy', label: '复制' }, { type: 'separator' }, { role: 'selectAll', label: '全选' })
      }
      if (isBrowserTab) {
        if (items.length) items.push({ type: 'separator' })
        items.push(
          { label: '查看源代码', click: () => { try { wc.loadURL('view-source:' + wc.getURL()) } catch (e) { log('view-source err: ' + e.message) } } },
          { label: '检查元素', click: () => { try { wc.inspectElement(p.x, p.y) } catch (e) { log('inspect err: ' + e.message) } } },
        )
      }
      if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) })
    })
  }
  app.on('web-contents-created', (_e, wc) => attachContextMenu(wc))

  // ── IPC ─────────────────────────────────────────────────────────────────────
  ipcMain.on('get-theme', (e) => { e.returnValue = S.settings.theme })
  const THEMES = ['light', 'dark', 'onyx', 'paper']   // 浅磨砂 / 墨玻璃 / 曜黑(实底) / 纸白(实底)
  ipcMain.on('set-theme', (_e, t) => {
    S.settings.theme = THEMES.includes(t) ? t : 'light'; saveSettings()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme-changed', S.settings.theme)
  })

  ipcMain.on('get-project', (e) => { e.returnValue = projName() })
  ipcMain.handle('pick-project', async () => {
    const r = await dialog.showOpenDialog({ title: '选择代码仓库（新卡将对它说话）', properties: ['openDirectory'] })
    if (!r.canceled && r.filePaths[0]) applyProject(r.filePaths[0])
    return projName()
  })
  // 本卡专用选目录:只改这张卡的绑定目录(S.cardDir),不动全局 projectDir、不广播 —— 每卡可对不同仓库说话
  ipcMain.handle('card-pick-project', async (e) => {
    if (!S.cardDir) S.cardDir = new Map()
    const cur = S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const r = await dialog.showOpenDialog({ title: '选择本卡对话的代码仓库(仅影响本卡)', defaultPath: cur || undefined, properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return { changed: false, dir: cur, project: cur ? path.basename(cur) : '未选目录' }
    const dir = r.filePaths[0]
    if (dir === cur) return { changed: false, dir, project: path.basename(dir) }
    S.cardDir.set(e.sender.id, dir)
    S.settings.recentDirs = [dir, ...(S.settings.recentDirs || []).filter((d) => d !== dir)].slice(0, 6); saveSettings()   // 只记最近,不动全局
    return { changed: true, dir, project: path.basename(dir) }
  })
  // 拖拽上传文档:把本地文档抽成文本(图片不走这,走 file part 给多模态)
  ipcMain.handle('parse-doc', async (_e, filePath) => {
    try { return await attachments.extractLocalFile(String(filePath || '')) } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('set-project-dir', (_e, dir) => {
    if (dir && fs.existsSync(dir)) applyProject(dir)
    else { S.settings.recentDirs = (S.settings.recentDirs || []).filter((d) => d !== dir); saveSettings() }
    return projName()
  })
  // 后端仓库（跨前后端调查/修复时，后端 agent 在它自己的 serve 上读/改后端源码）
  ipcMain.handle('pick-backend', async () => {
    const r = await dialog.showOpenDialog({ title: '选择后端代码仓库（Agent 跨前后端调查/修复时读它）', properties: ['openDirectory'] })
    if (!r.canceled && r.filePaths[0]) { S.settings.backendDir = r.filePaths[0]; saveSettings(); oc.ensureServe(r.filePaths[0], S.handlers, log, { tryShare: false }).catch((e) => log('backend prewarm failed: ' + e.message)) }
    return S.settings.backendDir || ''
  })
  ipcMain.handle('clear-backend', () => { S.settings.backendDir = ''; saveSettings(); return '' })

  ipcMain.handle('open-settings', () => openSettings())
  ipcMain.on('get-settings', (e) => {
    const im = S.settings.imap || {}
    const sm = S.settings.smtp || {}
    const ob = S.settings.ob || {}
    e.returnValue = {
      ob: { host: ob.host || '', port: ob.port || 3306, user: ob.user || '', hasPass: !!ob.passEncrypted, database: ob.database || '' },
      theme: S.settings.theme, editorCmd: S.settings.editorCmd || '', serveBin: S.settings.serveBin || '',
      serveBinEffective: process.env.BOCOMHERMES_SERVE_BIN || S.settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode'),
      serveBinLocked: !!process.env.BOCOMHERMES_SERVE_BIN,
      proxy: S.settings.proxy || '',
      browserArgs: S.settings.browserArgs || '',
      project: projName(), projectDir: S.settings.projectDir || '', recentDirs: S.settings.recentDirs || [],
      backendDir: S.settings.backendDir || '',
      reqRepos: (S.settings.reqProfile && S.settings.reqProfile.repos) || [],
      planMode: S.settings.planMode !== false,
      model: S.settings.model || null,   // 全局默认模型(对话坞设)
      encryptionAvailable: email.encryptionAvailable(),   // false → 密码只能明文落盘,设置面板要红字告警
      outboxHoldSeconds: S.settings.outboxHoldSeconds == null ? 15 : S.settings.outboxHoldSeconds,   // 发信延迟窗(软撤回),0=立即发
      imapIdleEnabled: S.settings.imapIdleEnabled !== false,   // IMAP IDLE 实时新邮件提醒,默认开
      imap: { host: im.host || '', port: im.port || 993, secure: im.secure !== false, allowSelf: !!im.allowSelfSigned, user: im.user || '', hasPass: !!im.passEncrypted, scheduleHour: im.scheduleHour ?? 9, sentFolder: im.sentFolder || 'Sent', archiveFolder: im.archiveFolder || 'Archive' },
      smtp: { host: sm.host || '', port: sm.port || 587, secure: !!sm.secure, allowSelf: !!sm.allowSelfSigned, sameAsImap: sm.sameAsImap !== false, user: sm.user || '', hasPass: !!sm.passEncrypted, from: sm.from || '' },
    }
  })
  ipcMain.handle('spawn-card', (_e, title) => spawnCard(title))
  // 对话坞带附件开会话:文档文本内联进 msg,图片(大 data URL)暂存,新卡 init 时取回随首条消息发
  ipcMain.handle('start-conversation', (_e, payload) => {
    const { title, msg, disp, files, mode } = payload || {}
    if (mode === 'wf') return { id: spawnWorkflow(msg || title || '') }   // 工作流走文本(含已内联文档);图片暂不支持
    const id = spawnCard(title || (msg || '').slice(0, 24) || '新对话', null, msg, disp, { flash: true })
    if (Array.isArray(files) && files.length) { S.cardFiles = S.cardFiles || new Map(); S.cardFiles.set(String(id), files) }
    return { id }
  })
  ipcMain.handle('get-card-files', (_e, id) => {
    const m = S.cardFiles; if (!m) return []
    const f = m.get(String(id)); if (f) m.delete(String(id)); return f || []
  })
  ipcMain.handle('spawn-fanout', (_e, goal, roles) => spawnFanout(goal, roles))
  ipcMain.handle('spawn-fanout-roles', (_e, { goal, roles }) => spawnFanout(goal, roles))
  ipcMain.handle('get-fanout-roles', () => Object.entries(ROLES).map(([k, [label]]) => ({ key: k, label })))
  ipcMain.handle('spawn-workflow', (_e, goal) => spawnWorkflow(goal))
  ipcMain.handle('open-req-analysis', () => spawnReqAnalysis(''))
  ipcMain.handle('pick-req-doc-path', () => pickReqDocPath())

  // ── 任务完成通知 ────────────────────────────────────────────────────────────
  const busyCards = new Set()   // 正在运行任务的 webContents id
  function sendOrbState(state) {
    if (S.inputWin && !S.inputWin.isDestroyed()) S.inputWin.webContents.send('orb-state', state)
  }
  function updateTrayBusy() {
    if (!S.tray) return
    const n = busyCards.size
    S.tray.setToolTip(n > 0 ? `BocomHermes · ${n} 个任务运行中` : 'BocomHermes')
    sendOrbState(n > 0 ? 'thinking' : 'idle')
  }
  ipcMain.on('card-busy', (e, busy) => {
    const wcId = e.sender.id
    const wasBusy = busyCards.has(wcId)
    if (busy) {
      busyCards.add(wcId)
    } else {
      busyCards.delete(wcId)
      if (wasBusy) {
        const win = BrowserWindow.fromWebContents(e.sender)
        if (win && !win.isDestroyed() && !win.isFocused()) {
          win.flashFrame(true)
          win.once('focus', () => win.flashFrame(false))
        }
        // 所有任务完成时闪绿眼
        if (busyCards.size === 0) {
          sendOrbState('done')
          setTimeout(() => { if (busyCards.size === 0) sendOrbState('idle') }, 2200)
        }
      }
    }
    if (busyCards.size > 0) updateTrayBusy()
    else if (S.tray) S.tray.setToolTip('BocomHermes')
  })
  // 卡片关闭时清掉它的"忙"记录 —— 否则正在生成的卡被关，wcId 永留 busyCards，球会一直思考态
  function forgetBusy(wcId) {
    if (!busyCards.delete(wcId)) return
    if (busyCards.size === 0) {
      sendOrbState('idle')
      if (S.tray && !S.tray.isDestroyed()) S.tray.setToolTip('BocomHermes')
    } else updateTrayBusy()
  }

  ipcMain.on('close-self', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('hide-self', (e) => BrowserWindow.fromWebContents(e.sender)?.hide())
  ipcMain.on('minimize-self', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  // JS 拖动支撑：抓取时读一次窗口 bounds，移动时写回「锁定尺寸 + 新坐标」——尺寸恒定，绝不缩放
  ipcMain.on('get-self-bounds', (e) => { const w = BrowserWindow.fromWebContents(e.sender); e.returnValue = (w && !w.isDestroyed()) ? w.getBounds() : null })
  ipcMain.on('set-self-bounds', (e, b) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed() && b) w.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })
  })
  ipcMain.handle('toggle-pin', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    const v = !w.isAlwaysOnTop(); w.setAlwaysOnTop(v); return v
  })
  ipcMain.handle('toggle-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    if (w._restoreBounds || w.isMaximized()) {
      const b = w._restoreBounds; w._restoreBounds = null
      if (w.isMaximized()) w.unmaximize()
      if (b) w.setBounds(b)
      return false
    }
    w._restoreBounds = w.getBounds()
    const wa = screen.getDisplayMatching(w.getBounds()).workArea
    w.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height }); return true
  })

  ipcMain.handle('read-clipboard', () => clipboard.readText())

  // ── 邮件 IPC ─────────────────────────────────────────────────────────────
  ipcMain.handle('trigger-email-summary', async () => {
    // 不再 throw —— 否则主进程日志刷 "Error occurred in handler",前端也拿不到原因。
    // 一律返回结构化结果,让待办面板就地给反馈(未配置 → 引导去设置;无新邮件 → 提示)
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) {
      return { ok: false, reason: 'unconfigured', message: 'IMAP 未配置,请先在设置里填写收件邮箱' }
    }
    try {
      const count = await spawnEmailCard()
      return { ok: true, count }
    } catch (e) {
      const msg = (e && e.message) || '未知错误'
      const benign = /没有邮件|已整理过|未配置/.test(msg)
      return { ok: false, reason: benign ? 'empty' : 'error', message: msg }
    }
  })
  ipcMain.handle('email-test', async () => {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    const r = await email.fetchUnread(imap, { limit: 5 })
    return { count: r.totalMatched, sample: r.emails.slice(0, 2).map(e => ({ from: e.from, subject: e.subject })) }
  })
  // ── 发件箱(发信安全闸门)IPC ─────────────────────────────────────────────
  ipcMain.handle('open-outbox', () => openOutbox())
  ipcMain.handle('outbox-list', () => S.outbox.list())
  ipcMain.handle('outbox-cancel', (_e, id) => S.outbox.cancel(id))
  ipcMain.handle('outbox-send-now', (_e, id) => S.outbox.sendNow(id))

  // ── MCP 一键注册 ────────────────────────────────────────────────────────────
  // 把自带 8 个本地 MCP server 写进 opencode/bocomcode 配置,整块搬进 ./mcp-config 的 initMcpConfig(ctx)。
  initMcpConfig({ app, path, fs, ipcMain, log })

  // ── Settings: IMAP 字段读写 ───────────────────────────────────────────────
  ipcMain.handle('set-settings', (_e, patch) => {
    // 存密码前先看能不能加密:不能 → 日志告警一次(设置面板另有红字提示),让用户知道密码明文落盘
    if (patch && ((patch.imap && patch.imap.pass && patch.imap.pass.trim()) || (patch.smtp && patch.smtp.pass && patch.smtp.pass.trim())) && !email.encryptionAvailable()) {
      log('⚠️ 安全告警:当前环境 safeStorage 不可用,邮箱密码将以明文保存到 settings.json')
    }
    if (patch && typeof patch.backendDir === 'string') S.settings.backendDir = patch.backendDir.trim()
    if (patch && typeof patch.editorCmd === 'string') S.settings.editorCmd = patch.editorCmd.trim()
    if (patch && typeof patch.serveBin === 'string') {
      S.settings.serveBin = patch.serveBin.trim()
      if (!process.env.BOCOMHERMES_SERVE_BIN && S.settings.serveBin) oc.setServeBin(S.settings.serveBin)
    }
    if (patch && typeof patch.proxy === 'string') {
      S.settings.proxy = patch.proxy.trim()
      // 即刻应用,无需重启;空字符串 = 走直连(不走代理)
      const rules = S.settings.proxy || ''
      session.defaultSession.setProxy(rules ? { proxyRules: rules } : { mode: 'direct' })
        .then(() => log('proxy updated: ' + (rules || '(direct)')))
        .catch((e) => log('setProxy err: ' + e.message))
    }
    if (patch && typeof patch.browserArgs === 'string') S.settings.browserArgs = patch.browserArgs.trim()
    if (patch && typeof patch.planMode === 'boolean') S.settings.planMode = patch.planMode
    if (patch && patch.outboxHoldSeconds !== undefined) S.settings.outboxHoldSeconds = Math.max(0, Math.min(parseInt(patch.outboxHoldSeconds) || 0, 3600))
    if (patch && 'model' in patch) S.settings.model = (patch.model && patch.model.modelID) ? { providerID: patch.model.providerID, modelID: patch.model.modelID, name: patch.model.name } : null   // 全局默认模型(对话坞设;卡片可覆盖)
    if (patch && patch.imap) {
      S.settings.imap = S.settings.imap || {}
      const im = patch.imap
      if (im.host      !== undefined) S.settings.imap.host          = String(im.host).trim()
      if (im.port      !== undefined) S.settings.imap.port          = parseInt(im.port) || 993
      if (im.secure    !== undefined) S.settings.imap.secure        = !!im.secure
      if (im.allowSelf !== undefined) S.settings.imap.allowSelfSigned = !!im.allowSelf
      if (im.user      !== undefined) S.settings.imap.user          = String(im.user).trim()
      if (im.pass && im.pass.trim()) S.settings.imap.passEncrypted  = email.encryptPass(im.pass.trim())
      if (im.scheduleHour !== undefined) S.settings.imap.scheduleHour = parseInt(im.scheduleHour) || 9
      if (im.sentFolder !== undefined) S.settings.imap.sentFolder    = String(im.sentFolder).trim() || 'Sent'
      if (im.archiveFolder !== undefined) S.settings.imap.archiveFolder = String(im.archiveFolder).trim() || 'Archive'
    }
    if (patch && patch.smtp) {
      S.settings.smtp = S.settings.smtp || {}
      const sm = patch.smtp
      if (sm.host       !== undefined) S.settings.smtp.host           = String(sm.host).trim()
      if (sm.port       !== undefined) S.settings.smtp.port           = parseInt(sm.port) || 587
      if (sm.secure     !== undefined) S.settings.smtp.secure         = !!sm.secure
      if (sm.allowSelf  !== undefined) S.settings.smtp.allowSelfSigned = !!sm.allowSelf
      if (sm.sameAsImap !== undefined) S.settings.smtp.sameAsImap     = !!sm.sameAsImap
      if (sm.user       !== undefined) S.settings.smtp.user           = String(sm.user).trim()
      if (sm.pass && sm.pass.trim())   S.settings.smtp.passEncrypted  = email.encryptPass(sm.pass.trim())
      if (sm.from       !== undefined) S.settings.smtp.from           = String(sm.from).trim()
    }
    if (patch && patch.imapIdleEnabled !== undefined) S.settings.imapIdleEnabled = !!patch.imapIdleEnabled
    if (patch && patch.reqProfile && Array.isArray(patch.reqProfile.repos)) {
      S.settings.reqProfile = S.settings.reqProfile || {}
      // repo 支持 { path, system, aliases[] }（新）与纯路径字符串（旧）；按 path 去重，无系统名则退回纯字符串保持兼容
      const seen = new Set(), out = []
      for (const r of patch.reqProfile.repos) {
        const rp = String((typeof r === 'string' ? r : (r && r.path)) || '').trim()
        if (!rp || seen.has(rp)) continue
        seen.add(rp)
        const system = (r && typeof r === 'object' && r.system) ? String(r.system).trim() : ''
        const aliases = (r && typeof r === 'object' && Array.isArray(r.aliases)) ? r.aliases.map((a) => String(a).trim()).filter(Boolean) : []
        out.push((system || aliases.length) ? { path: rp, system, aliases } : rp)
      }
      S.settings.reqProfile.repos = out
    }
    if (patch && patch.ob) {
      S.settings.ob = S.settings.ob || {}
      const o = patch.ob
      if (o.host     !== undefined) S.settings.ob.host         = String(o.host).trim()
      if (o.port     !== undefined) S.settings.ob.port         = parseInt(o.port) || 3306
      if (o.user     !== undefined) S.settings.ob.user         = String(o.user).trim()   // user@租户#集群
      if (o.database !== undefined) S.settings.ob.database     = String(o.database).trim()
      if (o.pass && o.pass.trim())  S.settings.ob.passEncrypted = email.encryptPass(o.pass.trim())
      try { db.closePool() } catch {}   // 配置变了,丢弃旧连接池
    }
    saveSettings()
    // IMAP 配置/IDLE 开关变化 → 重启监听
    if (patch && (patch.imap || patch.imapIdleEnabled !== undefined)) { try { mail.startIdleWatcher() } catch (e) { log('idle restart err: ' + e.message) } }
    return true
  })

  // OceanBase 测试连接:SELECT 1 + 库名 + 表数
  ipcMain.handle('db-test', async () => {
    const cfg = mail.effectiveOb()
    if (!cfg) return { ok: false, error: 'OceanBase 未配置(填 host/端口/user@租户#集群/密码/库)' }
    try { const r = await db.ping(cfg); return { ok: true, database: r.database, tableCount: r.tableCount } }
    catch (e) { return { ok: false, error: e.message } }
  })

  // SMTP 测试:给自己发一封空邮件,失败把错误返回前端展示
  ipcMain.handle('smtp-test', async () => {
    const cfg = mail.effectiveSmtp(S)
    if (!cfg) return { ok: false, error: 'SMTP 未配置(填 host/user/密码,或勾"同 IMAP")' }
    try {
      const to = cfg.from || cfg.user
      await email.sendMail(cfg, { to, subject: 'BocomHermes SMTP 测试 - ' + new Date().toLocaleString('zh-CN'), text: '这是一封由桌面智能体发出的 SMTP 测试邮件。\n如果你收到了,说明 SMTP 配置 OK,agent 可以代发邮件了。' })
      return { ok: true, to }
    } catch (e) { return { ok: false, error: e.message } }
  })

  // 取本次 session 的 git diff(前端+后端目录),给"查看本次改动"用,改完直接展示给用户看
  ipcMain.handle('current-diff', () => {
    const dirs = [S.settings.projectDir, S.settings.backendDir].filter(Boolean)
    if (!dirs.length) return '(未配置项目目录)'
    const out = []
    for (const cwd of dirs) {
      let d = ''
      try { d = require('child_process').execSync('git --no-pager diff HEAD', { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }) }
      catch (e) { d = '(git diff 失败: ' + e.message + ')' }
      let u = ''
      try {
        const ls = require('child_process').execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf8', timeout: 3000 }).split('\n').map((s) => s.trim()).filter(Boolean)
        if (ls.length) u = '\n\n(未跟踪新文件 ' + ls.length + '):\n  ' + ls.join('\n  ')
      } catch {}
      if ((d && d.trim()) || u) out.push('## ' + cwd + '\n' + (d || '(无 staged/unstaged 改动)') + u)
    }
    return out.length ? out.join('\n\n---\n\n') : '(本轮 session 无 git 改动)'
  })

  // ── Todos 广播（增删待办后通知邮件中心待办 tab 刷新）────────────────────────
  ipcMain.on('todos-updated', () => {
    for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('todos-updated') } catch {} }
  })

  // ── Orb 窗口控制 ─────────────────────────────────────────────────────────
  ipcMain.on('orb-passthrough', (_e, pass) => {
    if (S.inputWin && !S.inputWin.isDestroyed()) S.inputWin.setIgnoreMouseEvents(pass, { forward: true })
  })
  // 拖拽：在桌面内自由移动（仅夹取在可见区）
  ipcMain.on('orb-drag', (_e, { dx, dy }) => {
    if (!S.inputWin || S.inputWin.isDestroyed()) return
    const [x, y] = S.inputWin.getPosition()
    const [nx, ny] = clampOrbPos(x + dx, y + dy)
    S.inputWin.setPosition(nx, ny)
    if (S.orbInputWin && !S.orbInputWin.isDestroyed()) {
      const [px, py] = S.orbInputWin.getPosition()
      S.orbInputWin.setPosition(px + (nx - x), py + (ny - y))
    }
  })
  ipcMain.on('orb-snap', () => snapOrbToCorner())
  ipcMain.handle('toggle-orb-input', (_e, mode) => toggleOrbInput(mode))
  ipcMain.handle('close-orb-input', () => {
    if (S.orbInputWin && !S.orbInputWin.isDestroyed()) { S.orbInputWin.close(); S.orbInputWin = null }
  })

  // ── 浏览器 IPC ───────────────────────────────────────────────────────────
  const brWC = () => { const t = brActive(); return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null }
  ipcMain.handle('open-browser', (_e, url) => createWorkspace(url))
  // 分隔条拖动：start=临时分离内容视图让 chrome 独占鼠标事件；end=落定宽度并复位视图
  ipcMain.on('browser-split', (_e, arg) => {
    const b = S.browser
    if (!b.win || b.win.isDestroyed() || b.mode !== 'workspace') return
    const phase = arg && arg.phase
    if (phase === 'start') {
      b._dragging = true
      try { if (b.cardView) b.win.contentView.removeChildView(b.cardView) } catch {}
      const t = brActive(); if (t) { try { b.win.contentView.removeChildView(t.view) } catch {} }
    } else {
      const [cw] = b.win.getContentSize()
      b.leftW = Math.max(320, Math.min(cw - 440, (arg && arg.leftW) | 0))
      b._dragging = false
      if (b.cardView) { try { b.win.contentView.addChildView(b.cardView) } catch {} }
      const t = brActive(); if (t) { try { b.win.contentView.addChildView(t.view) } catch {} }
      brLayout()
      if (!b.win.isDestroyed()) b.win.webContents.send('browser-split-set', b.leftW)
    }
  })
  ipcMain.handle('browser-navigate', (_e, url) => { const wc = brWC(); const u = normalizeUrl(url); if (wc && u) wc.loadURL(u) })
  // ⋯ 更多菜单开/合 → 网页层从右让出/收回一条(否则原生层盖住 HTML 菜单)
  ipcMain.on('browser-menu-overlay', (_e, on) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.menuOpen = !!on; brLayout() })
  ipcMain.on('browser-settings-overlay', (_e, on) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.settingsOpen = !!on; brLayout() })
  // 通用 chrome 浮层让位:HTML 浮层(技能库 480px / 验证卡等)打开时,页面视图从右让出 w 像素
  ipcMain.on('browser-chrome-overlay', (_e, w) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.chromeOverlayW = Math.max(0, w | 0); brLayout() })
  // 模态浮层让位:模态卡(保存技能/填参数)打开时,页面视图高度压 0,关闭恢复
  ipcMain.on('browser-modal-overlay', (_e, on) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.modalOpen = !!on; brLayout() })
  ipcMain.on('browser-back',    () => { const wc = brWC(); if (wc && wc.canGoBack()) wc.goBack() })
  ipcMain.on('browser-forward', () => { const wc = brWC(); if (wc && wc.canGoForward()) wc.goForward() })
  ipcMain.on('browser-reload',  () => { const wc = brWC(); if (wc) wc.isLoading() ? wc.stop() : wc.reload() })
  // 禁用缓存:置一个全局 flag,每个 tab 的 did-start-navigation 钩子里读它,真要清就 session.clearCache()
  ipcMain.handle('browser-no-cache', async (_e, on) => {
    S.browser.noCache = !!on
    if (on) { try { await session.defaultSession.clearCache() } catch {} }   // 当下立刻清一次
    return S.browser.noCache
  })

  // ── 录制 ─────────────────────────────────────────────────────────────────


  // 「● 已录 N 步」实时徽标:每入队一个事件就推一次计数到 chrome
  function brSendRecCount() {
    const b = S.browser
    if (!b.rec || !b.win || b.win.isDestroyed()) return
    b.win.webContents.send('browser-rec-count', { n: b.rec.events.length })
  }

  // 把某个 tab 接入当前录制(原始 tab 与录制期间新开的 tab 共用):幂等挂钩 did-frame-finish-load,
  // 页面加载完重注入录制脚本 + URL 变化补 navigate 事件。opts.crossTab=新开标签,第一条 navigate 打 newTab 标记。
  // 事件通道 __bocom_rec_emit 已由 attachDbg 逐 tab 装好,这里只补脚本注入 + 放行(pushConsole 认 tabIds)。
  function wireRecToTab(tab, opts) {
    const rec = S.browser.rec
    if (!rec || !tab || tab._recWired) return
    rec.tabIds.add(tab.id)
    tab._recWired = true
    const wc = tab.view.webContents
    let firstNav = !!(opts && opts.crossTab)
    const handler = () => {
      const r = S.browser.rec
      if (!r || !r.active) return
      injectRecorder(wc).then(() => {
        const r2 = S.browser.rec
        if (!r2 || !r2.active) return
        const u = wc.getURL()
        if (!/^https?:\/\//i.test(u)) return   // 空白新标签(newtab.html=file://)不补 navigate,回放只认 http(s)
        // #5 去重比"最后一个 navigate 的 url",不是最后一个事件的 .url:非导航事件(click/input)没有 .url,
        //    否则 iframe 子框架 did-frame-finish-load(顶层 url 未变)会在每个非导航事件后补出幻影 navigate 刷屏。
        let lastNavUrl = null
        for (let i = r2.events.length - 1; i >= 0; i--) { if (r2.events[i].act === 'navigate') { lastNavUrl = r2.events[i].url; break } }
        if (lastNavUrl !== u) {
          const nav = { t: Date.now() - r2.startedAt, act: 'navigate', url: u }
          if (firstNav) { nav.newTab = true; firstNav = false }   // 供回放/报告降级标注
          r2.events.push(nav); brSendRecCount()
        }
      })
    }
    wc.on('did-frame-finish-load', handler)
    rec.cleanups.push(() => { try { wc.off('did-frame-finish-load', handler) } catch {} ; tab._recWired = false })   // 复位 _recWired:否则下次录制同一 tab 被幂等拦住不再挂钩
  }

  ipcMain.handle('browser-rec-start', async () => {
    const tab = brActive()
    if (!tab) return { ok: false, error: '没有活跃标签' }
    if (S.browser.rec && S.browser.rec.active) return { ok: true, already: true }   // #10 已在录制中:拒绝并发重入(双击录制会泄漏 did-frame-finish-load 监听器 + 卡死 _recWired)
    const wc = tab.view.webContents
    // #10 同步占位 rec(必须在任何 await 之前):否则 preState 快照的 await 窗口里第二次 rec-start 会重入,leaving _recWired 永久 true。
    //   tabId=起始/归属 tab(存档与 lastRec 匹配依赖它);tabIds=本次录制放行的 tab 集(含录制期间新开的);cleanups=各 tab 摘钩
    S.browser.rec = { active: true, tabId: tab.id, tabIds: new Set([tab.id]), startedAt: Date.now(), startUrl: wc.getURL(), preState: { cookies: [], local: '{}', session: '{}', origin: '' }, events: [], cleanups: [] }
    // 前置状态快照:cookies + localStorage + sessionStorage,回放前恢复才能在内网保持登录态
    let preState = { cookies: [], local: '{}', session: '{}', origin: '' }
    try {
      const url = wc.getURL()
      const u = new URL(url)
      preState.origin = u.origin
      preState.cookies = await session.defaultSession.cookies.get({ url })
      const s = await wc.executeJavaScript(`(()=>{try{var l={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);l[k]=localStorage.getItem(k)}var s={};for(var j=0;j<sessionStorage.length;j++){var k2=sessionStorage.key(j);s[k2]=sessionStorage.getItem(k2)}return JSON.stringify({l:l,s:s})}catch(e){return JSON.stringify({l:{},s:{}})}})()`, true)
      const ps = JSON.parse(s || '{"l":{},"s":{}}')
      preState.local = JSON.stringify(ps.l || {})
      preState.session = JSON.stringify(ps.s || {})
      log('rec preState: ' + preState.cookies.length + ' cookies, localStorage ' + Object.keys(ps.l || {}).length + ' keys')
    } catch (e) { log('preState dump err: ' + e.message) }
    S.browser.rec.preState = preState   // #10 占位后回填真实 preState
    // #4 空白新标签(newtab.html=file://)不写入毒首步(execStep/replayRec 只认 http(s),否则回放/验证在第 0 步就中止);
    //    首个真实 http 导航由 wireRecToTab 补成 events[0]。从已加载的 app 页开录则照常写入。
    const _startUrl = wc.getURL()
    if (/^https?:\/\//i.test(_startUrl)) S.browser.rec.events.push({ t: 0, act: 'navigate', url: _startUrl })
    const injected = await injectRecorder(wc)
    // 录制中导航/新开标签 → 重注入 + 补 navigate:抽成 wireRecToTab(原始 tab 与新 tab 共用)
    wireRecToTab(tab)
    // 健康自检:①注入是否真落地 ②事件通道(binding→console 回退)是否连通 ③CDP attach 状态,失败立刻告知原因
    const health = { injected: false, channel: false, dbg: !!tab.dbg }
    health.injected = injected && await wc.executeJavaScript('!!window.__bocom_rec_init && !!window.__bocom_rec_on', true).catch(() => false)
    if (health.injected) {
      S.browser.rec._pingOk = false
      // ping 走与 emit 相同的双通道:binding 命中即 return,否则回退 console.log
      const PING_JS = "(function(){var s='__BR__'+JSON.stringify({act:'__ping__'});try{if(typeof window.__bocom_rec_emit==='function')return window.__bocom_rec_emit(s)}catch(e){}try{console.log(s)}catch(e){}})()"
      try { await wc.executeJavaScript(PING_JS, true) } catch {}
      for (let k = 0; k < 3 && !(S.browser.rec && S.browser.rec._pingOk); k++) await sleep(200)
      health.channel = !!(S.browser.rec && S.browser.rec._pingOk)
    }
    if (!health.injected || !health.channel) {
      const cs = (S.browser.rec && S.browser.rec.cleanups) || []   // 早退前按 cleanups 数组摘所有钩子
      S.browser.rec = null
      for (const fn of cs) { try { fn() } catch {} }
      const error = !health.injected
        ? '录制脚本注入失败:页面还在加载或是受限页,等加载完再试'
        : (health.dbg ? '事件通道不通:页面可能覆写了 console.log(生产静音),可稍后重试' : '事件通道不通:CDP 调试器未附加(可能被 DevTools/外部工具占用),关掉 DevTools 后重试')
      log('rec start health fail: injected=' + health.injected + ' channel=' + health.channel + ' dbg=' + health.dbg)
      return { ok: false, error }
    }
    log('rec start: tab ' + tab.id + ' @ ' + S.browser.rec.startUrl)
    brSendRecCount()   // 初始 navigate 已入队 → 徽标从 1 起跳
    return { ok: true, health }
  })

  ipcMain.handle('browser-rec-stop', async () => {
    const r = S.browser.rec
    if (!r || !r.active) return { ok: false, error: '没有进行中的录制' }
    r.active = false
    if (S.browser.win && !S.browser.win.isDestroyed()) S.browser.win.webContents.send('browser-rec-count', { n: r.events.length, done: true })   // 收徽标
    if (r.cleanups) for (const fn of r.cleanups) { try { fn() } catch {} }
    // 把页面里的 flag 关掉(监听仍在,只是不再 emit);顺手收掉防抖里还没吐出来的最后一个输入。
    // 必须走返回值通道:此刻 r.active 已 false,console 通道的 __BR__ 会被 pushConsole 丢弃且有异步竞态。
    // 停录时用户多半停在最后操作的 tab(可能是新开的)→ 用 brActive() 兜底取快照/flush
    const tab = brActive() || (S.browser.tabs || []).find((t) => t.id === r.tabId)
    if (tab) {
      try {
        const pend = await tab.view.webContents.executeJavaScript(
          `;(function(){try{var s=window.__bocom_rec_flush?window.__bocom_rec_flush(true):null;window.__bocom_rec_on=false;return s}catch(e){window.__bocom_rec_on=false;return null}})()`, true)
        if (pend) { const ev = JSON.parse(pend); ev.t = Date.now() - r.startedAt; r.events.push(ev) }
      } catch {}
    }
    // 录制结束 = 复现成功瞬间 → 抓快照(报错 + 网络异常【含 200 业务异常】),供 Phase C 验证时 diff
    const snapshot = tab ? {
      errs: tab.console.filter((c) => c.level >= 2).map((c) => ({ level: c.level, msg: (c.message || '').split('\n')[0].slice(0, 200) })),
      bad: await snapshotBad(tab),
      url: tab.url || '',
    } : { errs: [], bad: [], url: '' }
    const id = 'rec_' + Date.now().toString(36)
    const dir = path.join(app.getPath('userData'), 'recordings')
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    // 降噪:逐事件照录 → 有意义的操作序列(删滚动/合并重复输入/去焦点点击/去重复提交/去 Tab)。
    // 带兜底:compactEvents 万一抛异常也绝不阻断保存,回退原始事件。dropped 明细留档,透明可回溯。
    let events = r.events, compaction = null
    try {
      const c = compactEvents(r.events)
      events = c.events; compaction = { from: r.events.length, to: c.events.length, dropped: c.dropped }
      log('rec compact: ' + r.events.length + ' → ' + c.events.length + ' events(降噪删 ' + c.dropped.length + ' 步)')
      // 人机断点识别:验证码/动态令牌/滑块这类"必须人来"的步标 human,回放到此暂停等人现场输入(见 replayRec)
      events = markHumanGates(events)
      const gates = events.filter((e) => e.human)
      if (gates.length) log('rec human-gates: ' + gates.length + ' 处(' + gates.map((g) => g.humanHint).join('/') + ')— 回放将暂停等人工输入')
    } catch (e) { log('rec compact err(回退原始事件): ' + e.message) }
    const rec = { id, tabId: r.tabId, startedAt: r.startedAt, startUrl: r.startUrl, durationMs: Date.now() - r.startedAt, events, compaction, snapshot, preState: r.preState || null }
    refreshSkillArtifacts(rec)   // steps 语义视图(此刻尚无 params/title,保存为技能时会重建)
    try { fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(rec, null, 2)) } catch (e) { log('rec save err: ' + e.message) }
    S.browser.lastRec = rec
    log('rec stop: ' + id + ' · ' + events.length + ' events · pre-fix snapshot: ' + snapshot.errs.length + ' errs / ' + snapshot.bad.length + ' bad')
    return { ok: true, ...rec }
  })

  // ── 回放 ─────────────────────────────────────────────────────────────────
  // 按录制时间线在当前 tab 自动播放;每步执行后等"网络静默"(<=900ms 无新请求),
  // 步间最长 sleep 2s。播完抓"修复后状态"快照,跟录制时的"修复前状态"diff。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  ipcMain.on('browser-devtools', () => {
    const tab = brActive(); if (!tab || tab.view.webContents.isDestroyed()) return
    const wc = tab.view.webContents
    if (wc.isDevToolsOpened()) { wc.closeDevTools(); return }
    if (tab.dbg) detachDbg(tab)   // 原生 DevTools 与我们的 debugger 互斥 → 让出通道（网络捕获暂停）
    try { wc.openDevTools({ mode: 'detach' }) } catch (e) { log('devtools open fail: ' + e.message) }
    wc.once('devtools-closed', () => { if (!wc.isDestroyed()) { attachDbg(tab); sendNetSnapshot(tab) } })   // 关闭后恢复网络捕获
  })
  ipcMain.on('browser-new-tab', (_e, url) => newTab(url || ''))
  ipcMain.on('browser-close-tab', (_e, id) => closeTab(id))
  ipcMain.on('browser-activate-tab', (_e, id) => activateTab(id))
  ipcMain.on('browser-set-device', (_e, key) => brSetDevice(key))
  ipcMain.on('browser-rotate', () => brRotateDevice())
  ipcMain.on('browser-zoom', (_e, dir) => brZoom(dir))
  ipcMain.on('browser-console-resize', (_e, h) => { S.browser.consoleH = h || 0; brLayout() })
  ipcMain.on('browser-find', (_e, { text, findNext, forward }) => {
    const wc = brWC(); if (!wc) return
    if (!text) { wc.stopFindInPage('clearSelection'); return }
    wc.findInPage(text, { findNext: !!findNext, forward: forward !== false })
  })
  ipcMain.on('browser-find-stop', () => { const wc = brWC(); if (wc) wc.stopFindInPage('clearSelection') })
  ipcMain.handle('browser-screenshot', async (_e, full) => await brScreenshot(full !== false))   // 默认整页
  ipcMain.handle('browser-analyze', async () => { await brAnalyze() })
  // 网络面板
  ipcMain.handle('browser-net-get', async (_e, id) => await brNetBody(id))
  ipcMain.on('browser-net-clear', () => { const tab = brActive(); if (!tab) return; tab.net = []; tab.netById = new Map(); sendNetSnapshot(tab) })
  ipcMain.on('browser-net-preserve', (_e, on) => { const tab = brActive(); if (tab) tab.preserveNet = !!on })
  // 元素拾取
  ipcMain.handle('browser-pick-element', async () => await brPickElement())
  // 控制台 REPL 求值
  ipcMain.handle('browser-eval', async (_e, expr) => await brEval(String(expr || '')))
  // 闭环验证：重载复现页并把修复后状态回灌 Agent
  ipcMain.handle('browser-verify', async () => { await verifyFix() })
  // 人机断点续跑:回放暂停在验证码/滑块步时,用户点 HUD「继续」→ 解开 replayRec 里挂着的 resolver
  ipcMain.on('browser-replay-resume', () => { const f = S.browser && S.browser._replayResume; if (typeof f === 'function') { try { f() } catch {} } })
  // 复制到剪贴板（供网络面板「复制 URL / 复制 cURL」、拾取「复制选择器」）
  ipcMain.handle('browser-copy', (_e, text) => { clipboard.writeText(String(text || '')); return true })
  ipcMain.on('browser-reveal', (_e, filePath) => { try { shell.showItemInFolder(String(filePath || '')) } catch (e) { log('reveal err: ' + e.message) } })
  ipcMain.handle('browser-rec-set-expectation', (_e, { recId, text }) => {
    const t = String(text || '').slice(0, 500)
    if (!t) return false
    // 更新内存
    if (S.browser.lastRec && S.browser.lastRec.id === recId) S.browser.lastRec.expectation = t
    // 落盘到 recordings/<id>.json
    const fp = path.join(app.getPath('userData'), 'recordings', recId + '.json')
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      j.expectation = t
      fs.writeFileSync(fp, JSON.stringify(j, null, 2))
      log('rec ' + recId + ' expectation set: ' + t.slice(0, 60))
      return true
    } catch (e) { log('set expectation err: ' + e.message); return false }
  })
  // 一键回滚:直接在主进程跑(不用走 MCP), 给浏览器卡片的"回滚"按钮用
  ipcMain.handle('browser-rollback-changes', async (_e, opts) => {
    const dirs = [S.settings.projectDir, S.settings.backendDir].filter(Boolean)
    if (!dirs.length) return { ok: false, error: '未配置项目目录' }
    const dryRun = !!(opts && opts.dryRun)
    const result = []
    for (const cwd of dirs) {
      let tracked = [], untracked = []
      try {
        const t = require('child_process').execSync('git diff --name-only HEAD', { cwd, encoding: 'utf8', timeout: 5000 })
        const c = require('child_process').execSync('git diff --cached --name-only HEAD', { cwd, encoding: 'utf8', timeout: 5000 })
        tracked = [...new Set([...t.split('\n'), ...c.split('\n')].map((s) => s.trim()).filter(Boolean))]
      } catch {}
      try { untracked = require('child_process').execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf8', timeout: 5000 }).split('\n').map((s) => s.trim()).filter(Boolean) } catch {}
      result.push({ dir: cwd, tracked, untracked })
      if (dryRun) continue
      for (const f of tracked) { try { require('child_process').execSync(`git checkout HEAD -- "${f.replace(/"/g, '\\"')}"`, { cwd, timeout: 3000 }) } catch {} }
      for (const f of untracked) { try { fs.unlinkSync(path.join(cwd, f)) } catch {} }
    }
    if (!dryRun) { try { const n = result.reduce((a, r) => a + r.tracked.length + r.untracked.length, 0); S.audit && S.audit('rollback', '回滚改动 ' + n + ' 个文件', { dirs: result.map((r) => path.basename(r.dir)), files: result.flatMap((r) => [...r.tracked, ...r.untracked]).slice(0, 50) }) } catch {} }
    return { ok: true, dryRun, result }
  })
  // ── 浏览器技能(SKILL):一条录制即一个技能 ─────────────────────────────────
  // 不新建第二套子系统:录制 JSON 就地扩展 skill/description/params/skipSteps/success 字段。
  // params[].stepIndex 指向 events 里某个 input/select 步;回放前把运行时值写进【深拷贝】的
  // events[i].value,再喂给 replayRec —— 参数化在门口完成,只落输入步、拒绝替 selector(防注入)。
  // 单个录制事件的白名单净化(导入/步骤编辑共用):返回净化后的事件或 null(丢弃)。
  // 只放行已知 act,字段类型强转+截断,navigate/fu 强制 http/https —— 挡 loadURL/executeJavaScript 注入。
  const _ACTS = new Set(['navigate', 'click', 'input', 'key', 'submit', 'scroll', 'select', 'check'])
  const _KEYS = new Set(['Enter', 'Escape', 'Tab'])
  function sanitizeEvent(ev) {
    if (!ev || !_ACTS.has(ev.act)) return null
    const e2 = { act: ev.act }
    if (ev.act === 'navigate') {
      if (!safeOrigin(ev.url)) return null
      e2.url = String(ev.url).slice(0, 2000); if (ev.spa) e2.spa = true
    } else {
      if (ev.sel != null) e2.sel = String(ev.sel).slice(0, 1000)
      if (Array.isArray(ev.selAlt)) e2.selAlt = ev.selAlt.slice(0, 8).map((s) => String(s).slice(0, 1000))
      if (ev.transient) e2.transient = true   // 日历格子标记:丢了会让这类步计入级联早停(存量修复)
      // 语义字段随事件走:人机断点(human/humanHint)与字段上下文(ph/lb/ac/im),编辑保存不能洗掉
      if (ev.human) { e2.human = true; if (ev.humanHint) e2.humanHint = String(ev.humanHint).slice(0, 60) }
      for (const k of ['ph', 'lb', 'ac', 'im']) if (ev[k]) e2[k] = String(ev[k]).slice(0, 60)
      if (ev.act === 'input') { e2.value = String(ev.value == null ? '' : ev.value).slice(0, 200); if (ev.secret) { e2.secret = true; e2.value = '' } if (ev.human) e2.value = '' }
      if (ev.act === 'select') { e2.value = String(ev.value == null ? '' : ev.value).slice(0, 200); if (ev.text) e2.text = String(ev.text).slice(0, 60) }
      if (ev.act === 'check') e2.checked = !!ev.checked
      if (ev.act === 'key') { if (!_KEYS.has(ev.key)) return null; e2.key = ev.key }
      if (ev.act === 'scroll') { e2.x = Number(ev.x) || 0; e2.y = Number(ev.y) || 0 }
      if (ev.act === 'click' && ev.text) e2.text = String(ev.text).slice(0, 40)
      if (ev.fu && /^https?:\/\//i.test(String(ev.fu))) e2.fu = String(ev.fu).slice(0, 2000)
    }
    e2.t = Number(ev.t) || 0
    return e2
  }
  // SKILL 语义视图 + 技能文档(对标 Codex R&R,设计见 docs/技能系统-意图执行与Agent解析链设计.md):
  // events/params/skipSteps 任一变动就重建 steps;技能(skill:true)另落 <id>.skill.md(四段式,与 JSON 并排)。
  // 纯增强,try/catch 兜底,绝不阻断保存。
  function refreshSkillArtifacts(j) {
    try {
      const v = upgradeToSkill(j)
      j.skillRev = v.skillRev; j.steps = v.steps
      if (j.skill && j.id) fs.writeFileSync(path.join(recDir(), String(j.id).replace(/[^\w.-]/g, '') + '.skill.md'), skillMd(j))
    } catch (e) { log('skill view err: ' + e.message) }
  }
  // 运行历史:重读磁盘 read-modify-write,只改 lastRun 一个键。
  // 严禁序列化内存里的 rec/clone —— replayRec 会把 preState(cookie)塞进 events[i]._restorePreState,直接 stringify 会持久化敏感态
  // 按名字跑技能(relay /skill/run 与 agent 共用):浏览器没开就自动拉起,回完给文字结论 + 写运行历史
  async function skillRun(a) {
    const want = String((a && (a.name || a.id)) || '').trim()
    if (!want) return { error: '缺少 name(技能名)' }
    const all = skillList()
    let hit = all.find((s) => s.name === want || s.id === want)
    if (!hit) {   // 模糊匹配只在无歧义时用:「导出报表」不能悄悄跑成「导出报表-测试」
      const fuzzy = all.filter((s) => s.name.includes(want))
      if (fuzzy.length > 1) return { error: '「' + want + '」命中多条技能,请用全名: ' + fuzzy.map((s) => s.name).join('、') }
      hit = fuzzy[0]
    }
    if (!hit) return { error: '没有叫「' + want + '」的技能。现有: ' + (all.map((s) => s.name).join('、') || '(空 — 让用户在内嵌浏览器录一条并保存为技能)') }
    let rec; try { rec = readRec(hit.id) } catch (e) { return { error: '读取技能失败: ' + e.message } }
    if (a && a.baseUrl) {
      if (!safeOrigin(a.baseUrl)) return { error: 'baseUrl 必须是 http/https origin,如 https://uat.example.com' }
      rec = applyBaseUrl(rec, a.baseUrl)
    }
    if (!brActive()) {   // 窗口没开 → 自动拉起并等首个标签就绪(chrome 加载完才建 tab)
      createBrowser(rec.startUrl)
      for (let i = 0; i < 100 && !brActive(); i++) await sleep(150)
      if (!brActive() && S.browser.win && !S.browser.win.isDestroyed()) {
        newTab(rec.startUrl)   // 窗口开着但 0 tab(createBrowser 对已开窗只 focus)
        for (let i = 0; i < 40 && !brActive(); i++) await sleep(150)
      }
      if (!brActive()) return { error: '内嵌浏览器未能就绪(15s 超时)' }
      await sleep(1200)   // 让首页先加载;回放的首个 navigate 步会再校准 URL
    }
    S.browser.lastRec = rec
    const replay = await replayRec(applyParams(rec, (a && a.params) || {}), { fast: true })
    if (!replay.ok) return { error: replay.error || '回放失败' }
    writeLastRun(hit.id, replay)
    const fails = replay.stepReport.filter((s) => !s.ok && !s.transient)
    const retried = replay.stepReport.filter((s) => s.retried && s.ok).length
    const ok = fails.length === 0 && (!replay.success || replay.success.pass)
    try { S.audit && S.audit('skill', 'Agent 运行技能「' + hit.name + '」', { by: 'agent', steps: replay.stepReport.length, result: ok ? 'PASS' : (fails.length + ' 步失败'), baseUrl: (a && a.baseUrl) || '' }) } catch {}
    const lines = ['技能「' + hit.name + '」回放 ' + replay.stepReport.length + '/' + replay.totalSteps + ' 步 · ' + (fails.length === 0 ? '✅ 步骤全部成功' : '❌ ' + fails.length + ' 步失败') + (retried ? '(' + retried + ' 步重试后成功)' : '')]
    for (const f of fails.slice(0, 8)) lines.push('  · 步 ' + f.i + ' ' + f.act + ' "' + String(f.sel).slice(0, 60) + '" — ' + f.err)
    if (replay.success) lines.push('成功断言: ' + (replay.success.pass ? '✓ 达成' : '✗ 未达成') + ' [' + replay.success.kind + '] "' + replay.success.value + '"' + (replay.success.err ? '(检查出错: ' + replay.success.err + ')' : ''))
    if (replay.dialogs && replay.dialogs.length) lines.push('自动应答弹窗 ' + replay.dialogs.length + ' 个(confirm→确定): ' + replay.dialogs.slice(0, 3).map((d) => d.k + '「' + d.m + '」').join(' | '))
    if (replay.baseSwapped) lines.push('已切环境运行(未恢复录制时的登录态;需要登录的流程请先在浏览器登录目标环境,或把登录步录进技能)')
    if (replay.after.errs.length) lines.push('回放后控制台报错 ' + replay.after.errs.length + ' 条: ' + replay.after.errs.slice(0, 3).map((x) => x.msg).join(' | '))
    if (replay.after.bad.length) lines.push('网络/业务异常 ' + replay.after.bad.length + ' 条: ' + replay.after.bad.slice(0, 3).map((b) => (b.biz ? '200·' + b.biz : (b.status || b.state)) + ' ' + b.url).join(' | '))
    lines.push('结束页面: ' + (replay.after.url || '?'))
    return { ok, pass: ok, report: lines.join('\n'), stepReport: replay.stepReport }
  }
  // 录制管理面板:list / star / rename / delete / replay-stored
  ipcMain.handle('browser-rec-list', () => {
    const dir = recDir()
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return [] }
    const items = []
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        items.push({
          id: j.id || f.replace(/\.json$/, ''),
          title: j.title || '',
          starred: !!j.starred,
          skill: !!j.skill,
          description: j.description || '',
          paramCount: (j.params || []).length,
          startUrl: j.startUrl || '',
          expectation: j.expectation || '',
          eventCount: (j.events || []).length,
          durationMs: j.durationMs || 0,
          lastRun: j.lastRun || null,
          mtime: fs.statSync(path.join(dir, f)).mtimeMs,
        })
      } catch {}
    }
    return items.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.mtime - a.mtime)
  })
  // 取整条录制(技能编辑器要列 input 步做参数勾选)
  ipcMain.handle('browser-rec-get', (_e, id) => { try { return readRec(id) } catch { return null } })
  ipcMain.handle('browser-rec-update', (_e, { id, patch }) => {
    if (!id || !patch || typeof patch !== 'object') return false
    const fp = path.join(recDir(), String(id).replace(/[^\w.-]/g, '') + '.json')
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const allowed = ['title', 'starred', 'expectation', 'description', 'params', 'skill']   // events 不进白名单,保持只读
      for (const k of allowed) if (k in patch) j[k] = patch[k]
      // 形状校验后才放行的字段(坏形状直接丢弃,不落盘)
      if ('skipSteps' in patch) {
        const n = (j.events || []).length
        j.skipSteps = Array.isArray(patch.skipSteps) ? patch.skipSteps.filter((x) => Number.isInteger(x) && x >= 0 && x < n) : []
      }
      if ('success' in patch) {
        const s = patch.success
        if (s && (s.kind === 'css' || s.kind === 'text') && typeof s.value === 'string' && s.value.length > 0 && s.value.length <= 500) j.success = { kind: s.kind, value: s.value }
        else delete j.success
      }
      refreshSkillArtifacts(j)   // params/skill/success 变了 → 重建 steps;skill:true 落 .skill.md
      fs.writeFileSync(fp, JSON.stringify(j, null, 2))
      return true
    } catch (e) { log('rec update err: ' + e.message); return false }
  })
  ipcMain.handle('browser-rec-delete', (_e, id) => {
    const base = path.join(recDir(), String(id).replace(/[^\w.-]/g, ''))
    try { fs.unlinkSync(base + '.skill.md') } catch {}   // 技能文档随录制一起删
    try { fs.unlinkSync(base + '.json'); log('rec deleted: ' + id); return true } catch (e) { log('rec del err: ' + e.message); return false }
  })
  // 入参兼容两种形态:'rec_xx'(旧)或 { id, params, baseUrl }(带运行时参数/环境切换)
  ipcMain.handle('browser-rec-replay-stored', async (_e, arg) => {
    const id = arg && typeof arg === 'object' ? arg.id : arg
    const values = (arg && typeof arg === 'object' && arg.params) || null
    const baseUrl = (arg && typeof arg === 'object' && arg.baseUrl) || null
    let rec; try { rec = readRec(id) } catch (e) { return { ok: false, error: '读取失败: ' + e.message } }
    if (baseUrl) {
      if (!safeOrigin(baseUrl)) return { ok: false, error: 'baseUrl 必须是 http/https origin,如 https://uat.example.com' }
      rec = applyBaseUrl(rec, baseUrl)
    }
    S.browser.lastRec = rec   // 让 verify 用这条
    // fast 只给技能:普通复现录制保持录制节奏,时序敏感的 bug 才复现得出来
    const replay = await replayRec(values ? applyParams(rec, values) : rec, { fast: !!rec.skill })
    if (replay.ok) writeLastRun(id, replay)
    try { if (rec.skill) { const nf = replay.ok ? replay.stepReport.filter((s) => !s.ok && !s.transient).length : -1; S.audit && S.audit('skill', '运行技能「' + (rec.title || id) + '」', { steps: replay.stepReport ? replay.stepReport.length : 0, result: !replay.ok ? '回放失败' : (nf === 0 ? 'PASS' : nf + ' 步失败') }) } } catch {}
    return replay
  })
  // 技能导出:剥离 preState/snapshot(cookie/报错快照不外泄)与 _ 前缀运行时键,写到「下载」目录
  ipcMain.handle('browser-rec-export', (_e, id) => {
    try {
      const j = readRec(id)
      const out = {}
      for (const k of ['id', 'title', 'description', 'expectation', 'skill', 'params', 'skipSteps', 'success', 'startUrl', 'startedAt', 'durationMs']) if (k in j) out[k] = j[k]
      out.events = (j.events || []).map((ev) => { const e2 = {}; for (const k of Object.keys(ev)) if (!k.startsWith('_')) e2[k] = ev[k]; return e2 })
      const safeId = String(j.id || id).replace(/[^\w.-]/g, '')
      const fp = path.join(app.getPath('downloads'), 'skill-' + safeId + '.json')
      fs.writeFileSync(fp, JSON.stringify(out, null, 2))
      try { shell.showItemInFolder(fp) } catch {}
      // 提醒调用方:事件里仍带录制时的输入明文(密码步除外,录制即脱敏)
      const inputValues = out.events.filter((e2) => (e2.act === 'input' || e2.act === 'select') && e2.value).length
      return { ok: true, path: fp, inputValues }
    } catch (e) { return { ok: false, error: e.message } }
  })
  // 技能导入:白名单重建 + 类型强转,绝不整包落盘;preState 一律丢弃;navigate/startUrl 强制 http/https。
  // 事件被过滤时用 idxMap 重映射 params/skipSteps 的 stepIndex,防错位指到别的步
  ipcMain.handle('browser-rec-import', async () => {
    try {
      const r = await dialog.showOpenDialog({ title: '导入技能 JSON', filters: [{ name: 'Skill JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true }
      const fpIn = r.filePaths[0]
      if (fs.statSync(fpIn).size > 2 * 1024 * 1024) return { ok: false, error: '文件超过 2MB,拒绝导入' }
      const src = JSON.parse(fs.readFileSync(fpIn, 'utf8'))
      if (!safeOrigin(src.startUrl)) return { ok: false, error: 'startUrl 必须是 http/https,拒绝导入' }
      const evsIn = Array.isArray(src.events) ? src.events.slice(0, 5000) : []
      const events = []; const idxMap = new Map()
      evsIn.forEach((ev, oldIdx) => {
        const e2 = sanitizeEvent(ev)   // 白名单净化(与步骤编辑器共用)
        if (!e2) return
        idxMap.set(oldIdx, events.length)
        events.push(e2)
      })
      if (!events.length) return { ok: false, error: '文件里没有可用的步骤' }
      const id = 'rec_' + Date.now().toString(36)
      const rec2 = {
        id, startUrl: String(src.startUrl).slice(0, 2000), startedAt: Date.now(), durationMs: Number(src.durationMs) || 0,
        events, snapshot: { errs: [], bad: [], url: '' }, preState: null,
        title: String(src.title || '导入技能').slice(0, 120), description: String(src.description || '').slice(0, 500),
        expectation: String(src.expectation || '').slice(0, 2000), skill: true,
      }
      const params = (Array.isArray(src.params) ? src.params : [])
        .filter((p) => p && /^p\d+$/.test(String(p.key)) && Number.isInteger(p.stepIndex) && idxMap.has(p.stepIndex))
        .map((p) => ({ key: String(p.key), label: String(p.label || p.key).slice(0, 60), stepIndex: idxMap.get(p.stepIndex), default: String(p.default == null ? '' : p.default).slice(0, 200), ...(p.secret ? { secret: true } : {}) }))
        .filter((p) => { const ev = events[p.stepIndex]; return ev && (ev.act === 'input' || ev.act === 'select') })
      if (params.length) rec2.params = params
      const skips = (Array.isArray(src.skipSteps) ? src.skipSteps : []).filter((x) => Number.isInteger(x) && idxMap.has(x)).map((x) => idxMap.get(x))
      if (skips.length) rec2.skipSteps = skips
      if (src.success && (src.success.kind === 'css' || src.success.kind === 'text') && typeof src.success.value === 'string' && src.success.value.length <= 500) rec2.success = { kind: src.success.kind, value: src.success.value }
      const dir = recDir(); try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(rec2, null, 2))
      return { ok: true, id, title: rec2.title, steps: events.length }
    } catch (e) { return { ok: false, error: e.message } }
  })
  // 技能步骤编辑器:改 events(删步/重排/改 input/select 值),同步重映射 params.stepIndex 与 skipSteps。
  // keep = 新顺序的步骤列表,每项 { srcIndex(指向原 events 下标), value?(编辑后的 input/select 值) };
  // 不在 keep 里的原步骤 = 删除。events 只读约束在此处松绑,但一律走 sanitizeEvent 净化,不接受任意新事件。
  ipcMain.handle('browser-rec-edit-steps', (_e, { id, keep }) => {
    if (!id || !Array.isArray(keep)) return { ok: false, error: '参数错误' }
    const fp = path.join(recDir(), String(id).replace(/[^\w.-]/g, '') + '.json')
    let j; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch (e) { return { ok: false, error: '读取失败: ' + e.message } }
    const src = Array.isArray(j.events) ? j.events : []
    const events = []; const idxMap = new Map()   // 原下标 → 新下标
    for (const k of keep.slice(0, 5000)) {
      const si = k && Number(k.srcIndex)
      if (!Number.isInteger(si) || si < 0 || si >= src.length || idxMap.has(si)) continue   // 越界/重复引用跳过
      const base = { ...src[si] }
      if (k.value !== undefined && (base.act === 'input' || base.act === 'select') && !base.secret) base.value = String(k.value)
      const e2 = sanitizeEvent(base)   // 净化(保留 _ 前缀键之外的合法字段;secret 步 value 仍被清空)
      if (!e2) continue
      idxMap.set(si, events.length)
      events.push(e2)
    }
    if (!events.length) return { ok: false, error: '至少保留一步' }
    j.events = events
    // 重映射 params:stepIndex 落在保留步且仍是 input/select 才留;
    // 编辑过值的参数步,default 跟着走(否则回放用旧 default 覆盖,编辑白改)
    if (Array.isArray(j.params)) {
      j.params = j.params
        .filter((p) => p && idxMap.has(p.stepIndex))
        .map((p) => { const ni = idxMap.get(p.stepIndex); const ev = events[ni]; return { ...p, stepIndex: ni, ...(ev && !p.secret ? { default: String(ev.value == null ? '' : ev.value).slice(0, 200) } : {}) } })
        .filter((p) => { const ev = events[p.stepIndex]; return ev && (ev.act === 'input' || ev.act === 'select') })
    }
    // 重映射 skipSteps
    if (Array.isArray(j.skipSteps)) j.skipSteps = j.skipSteps.filter((x) => idxMap.has(x)).map((x) => idxMap.get(x))
    delete j.lastRun   // 步骤变了,上次运行结果作废
    refreshSkillArtifacts(j)   // events/params/skipSteps 都可能变了 → 重建语义视图
    try { fs.writeFileSync(fp, JSON.stringify(j, null, 2)); log('rec edit-steps: ' + id + ' → ' + events.length + ' 步') }
    catch (e) { return { ok: false, error: e.message } }
    return { ok: true, steps: events.length, params: (j.params || []).length }
  })
  ipcMain.on('browser-open-rec-dir', () => {
    const d = path.join(app.getPath('userData'), 'recordings')
    try { fs.mkdirSync(d, { recursive: true }) } catch {}
    try { shell.openPath(d) } catch (e) { log('open rec dir err: ' + e.message) }
  })
  // URL 历史(每访问 did-navigate 都补,内存上限 200,sendSync 给 renderer 做 datalist)
  ipcMain.on('get-browser-history', (e) => { e.returnValue = (S.browser.history || []).slice(0, 200) })
  // 标签重排:renderer 拖动 .tab 后告诉 main 新顺序(id 数组)
  ipcMain.on('browser-reorder-tabs', (_e, ids) => {
    if (!Array.isArray(ids) || !S.browser.tabs) return
    const map = new Map(S.browser.tabs.map((t) => [t.id, t]))
    const reordered = ids.map((id) => map.get(id)).filter(Boolean)
    if (reordered.length === S.browser.tabs.length) { S.browser.tabs = reordered; brSendTabs() }
  })

  ipcMain.handle('open-dock', () => openDock())
  ipcMain.on('get-history', (e) => { e.returnValue = S.history })
  ipcMain.handle('open-history', (_e, { sid, title }) => spawnCard(title, sid))
  ipcMain.handle('clear-history', () => { S.history = []; saveHistory(); return true })

  return { createOrb, createBrowser, createWorkspace, createMailCenter, openMailView, spawnCard, spawnFanout, spawnWorkflow, spawnReqAnalysis, spawnReqConfirm, spawnReqPlan, spawnEmailCard, snapAsk, toggleInput, toggleOrbInput, buildTray, openDock, openOutbox, openSettings, applyProject, projName, recordHistory, touchHistory }
}
