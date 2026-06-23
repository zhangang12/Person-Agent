'use strict'
const USE_ACRYLIC = false
const { clipboard, session } = require('electron')
const email = require('./email')
const attachments = require('./attachments')

module.exports = function initWindow(S, { ipcMain, app, BrowserWindow, WebContentsView, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }) {
  // 额外窗口引用
  S.todosWin = null
  S.orbInputWin = null
  S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
  // ── 设置 ────────────────────────────────────────────────────────────────────
  function loadSettings() { try { return { ...S.settings, ...JSON.parse(fs.readFileSync(S.settingsFile, 'utf8')) } } catch { return { ...S.settings } } }
  function saveSettings() { try { fs.writeFileSync(S.settingsFile, JSON.stringify(S.settings)) } catch {} }
  // 解析"有效的" SMTP 配置:sameAsImap=true 时用户名/密码从 IMAP 取(host/port/secure 仍从 SMTP 取)
  function effectiveSmtp(S) {
    const sm = S.settings.smtp || {}
    if (!sm.host) return null
    const out = { host: sm.host, port: sm.port || 587, secure: !!sm.secure, allowSelfSigned: !!sm.allowSelfSigned, from: sm.from || '' }
    const im = S.settings.imap || {}
    if (sm.sameAsImap !== false && !sm.user) { out.user = im.user; out.passEncrypted = im.passEncrypted }
    else { out.user = sm.user; out.passEncrypted = sm.passEncrypted }
    if (!out.user || !out.passEncrypted) return null
    if (!out.from) out.from = out.user
    return out
  }
  S.effectiveSmtp = () => effectiveSmtp(S)   // 供其它模块/MCP 用

  // 本地 HTTP 中继:MCP 子进程没法用 electron safeStorage 解密 IMAP/SMTP 密码 → 主进程开个
  // 127.0.0.1 localhost http server,MCP 通过 HTTP 调,主进程用已解密的 cfg 跑 IMAP/SMTP。
  // token 防本机其它进程蹭用(写在 userData/mail-relay.json,只有 Agent + 自家 MCP 看得到)
  const http = require('http')
  function startMailRelay() {
    const token = require('crypto').randomBytes(16).toString('hex')
    const srv = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.headers['x-bocom-tok'] !== token) { res.writeHead(401).end(); return }
      let body = ''
      req.on('data', (c) => body += c)
      req.on('end', async () => {
        let a = {}; try { a = body ? JSON.parse(body) : {} } catch {}
        const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
        try {
          if (req.url === '/mail/list') {
            const imap = S.settings.imap
            if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return reply({ error: 'IMAP 未配置' })
            // 透传 agent 的筛选/分页参数:from / subject / days / onlyUnseen / limit / cursor
            const r = await email.fetchUnread(imap, a || {})
            // 附件落盘 + 文本化(strip _rawAttachments bytes,attachments[] 改为带 hasText 的 meta)
            try { await attachments.saveAttachments(r.emails, app.getPath('userData'), log) } catch (e) { log('saveAttachments err: ' + e.message) }
            // 缓存最近一次结果,给 todo 回填邮件元信息用(mail-cache 持久化在 A4-b)
            S.mailLastBatch = { ts: Date.now(), emails: r.emails }
            return reply({ ok: true, emails: r.emails, nextCursor: r.nextCursor, totalMatched: r.totalMatched })
          }
          if (req.url === '/mail/send') {
            const cfg = S.effectiveSmtp(); if (!cfg) return reply({ error: 'SMTP 未配置' })
            await email.sendMail(cfg, { to: a.to, cc: a.cc, subject: a.subject, text: a.text })
            return reply({ ok: true })
          }
          if (req.url === '/mail/get') {
            // 取某封邮件全文(分段)。先查 mailLastBatch 缓存,没命中再走 IMAP HEADER 搜
            const imap = S.settings.imap
            if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return reply({ error: 'IMAP 未配置' })
            const msgId = String(a.messageId || '').replace(/^<|>$/g, '')
            if (!msgId) return reply({ error: 'messageId 必填' })
            let mail = null
            const batch = S.mailLastBatch && Array.isArray(S.mailLastBatch.emails) ? S.mailLastBatch.emails : []
            mail = batch.find((e) => e.messageId === msgId) || null
            if (!mail) {
              try {
                mail = await email.fetchByMessageId(imap, msgId)
                if (mail) { try { await attachments.saveAttachments([mail], app.getPath('userData'), log) } catch (e) { log('saveAtts err: ' + e.message) } }
              } catch (e) { return reply({ error: 'IMAP 兜底搜失败: ' + e.message }) }
            }
            if (!mail) return reply({ error: '找不到 msgId=' + msgId + '(可能已归档或不在 INBOX)' })
            const part = a.part === 'html' ? (mail.html || '') : (mail.text || '')
            const offset = Math.max(0, +a.offset || 0)
            const limit  = Math.max(1, Math.min(+a.limit || 8000, 50000))
            const content = part.slice(offset, offset + limit)
            return reply({
              ok: true, content,
              totalLen: part.length, hasMore: offset + limit < part.length,
              nextOffset: offset + limit < part.length ? offset + limit : null,
              from: mail.from, subject: mail.subject, date: mail.date,
              hasHtml: !!(mail.html && mail.html.length), hasText: !!(mail.text && mail.text.length),
              attachments: mail.attachments || [],
            })
          }
          if (req.url === '/mail/attachment') {
            try {
              const r = attachments.readAttachmentText(app.getPath('userData'), a.messageId, a.filename, a.offset, a.limit)
              return reply({ ok: true, ...r })
            } catch (e) { return reply({ error: e.message, code: e.code || null }) }
          }
          return reply({ error: 'unknown ' + req.url })
        } catch (e) { reply({ error: e.message }) }
      })
    })
    srv.on('error', (e) => log('mail relay error: ' + e.message))
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      const fp = path.join(app.getPath('userData'), 'mail-relay.json')
      try { fs.writeFileSync(fp, JSON.stringify({ port, token })) ; log('mail relay on :' + port) } catch (e) { log('mail-relay.json save err: ' + e.message) }
    })
  }
  startMailRelay()
  // 启动时清理 30 天前的附件目录(异步执行不阻塞主流程)
  try { attachments.cleanupOld(app.getPath('userData'), log) } catch (e) { log('att cleanup err: ' + e.message) }
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

  function spawnCard(title, sid, msg, disp) {
    const id = ++S.cardSeq
    const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
    const wx = 160 + col * 56, wy = 90 + row * 50 + col * 18
    const win = new BrowserWindow(baseOpts({
      width: 480, height: 600, minWidth: 360, minHeight: 320, resizable: true,
      alwaysOnTop: false, skipTaskbar: false, x: wx, y: wy,
    }))
    const wcId = win.webContents.id
    const query = { title: title || '未命名任务', id: String(id), ...orbAnchorFor(wx, wy, 480, 600) }
    if (sid) query.sid = sid
    if (msg) query.msg = msg
    if (disp) query.disp = disp
    win.loadFile(path.join(__dirname, '..', 'ui', 'card.html'), { query })
    win.on('closed', () => {
      const s = S.sessionByWc.get(wcId)
      if (s) { const si = S.sessionInfo.get(s); if (si) oc.abort(si.serve, s); S.sessionInfo.delete(s); S.streamBuf.delete(s); S.sentPrompt.delete(s); S.firstMsgCtx.delete(s) }
      S.sessionByWc.delete(wcId)
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
    const win = new BrowserWindow(baseOpts({
      width: 560, height: 680, minWidth: 420, minHeight: 380, resizable: true,
      alwaysOnTop: false, skipTaskbar: false,
      x: 180 + col * 56, y: 80 + row * 50 + col * 18,
    }))
    const wcId = win.webContents.id
    win.loadFile(path.join(__dirname, '..', 'ui', 'workflow.html'), { query: { goal: goal || '未命名工作流', id: String(id) } })
    win.on('closed', () => {
      const w = S.workflows.get(wcId)
      if (w) { try { w.ac.abort() } catch {}; for (const s of w.sessions) { try { oc.abort(w.serve, s) } catch {}; S.sessionInfo.delete(s) }; S.workflows.delete(wcId) }
    })
    return id
  }

  // ── 邮件摘要卡 ─────────────────────────────────────────────────────────────
  async function spawnEmailCard() {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    log('email: fetching unread emails…')
    const r = await email.fetchUnread(imap, { limit: 10 })
    const emails = r.emails || []
    if (!emails.length) { log('email: no unread emails'); return 0 }
    try { await attachments.saveAttachments(emails, app.getPath('userData'), log) } catch (e) { log('saveAttachments err: ' + e.message) }
    log('email: fetched ' + emails.length + ' / ' + r.totalMatched + ' emails (nextCursor=' + r.nextCursor + ')')
    // 把这次抓的邮件存到内存,供"加待办时回填邮件元信息" / agent 通过 mail-cache 读
    S.mailLastBatch = { ts: Date.now(), emails }
    const prompt = email.formatEmailPrompt(emails)
    // 把"加待办"操作引导写进 prompt:让 agent 直接调 IPC todo-add 时把 mailSubject/mailBody/mailDate 一并带
    const prompt2 = prompt + '\n\n注意:你提取的 TODO 行,如果对应某封具体邮件,请同时在那条 TODO 行后面追加 `[mailIdx:N]`(N 是上面邮件的序号),系统会自动回填邮件主题/日期/正文摘要进待办,方便日后回看。'
    spawnCard('📧 邮件摘要 · ' + new Date().toLocaleDateString('zh-CN'), null, prompt2)
    return emails.length
  }

  function openTodos() {
    if (S.todosWin && !S.todosWin.isDestroyed()) { S.todosWin.show(); S.todosWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const tx = Math.round(width / 2 - 200), ty = 120
    S.todosWin = new BrowserWindow(baseOpts({ width: 400, height: 560, x: tx, y: ty, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 320, minHeight: 300 }))
    S.todosWin.loadFile(path.join(__dirname, '..', 'ui', 'todos.html'), { query: orbAnchorFor(tx, ty, 400, 560) })
    S.todosWin.on('closed', () => { S.todosWin = null })
  }

  function toggleInput() { toggleOrbInput() }

  function toggleTheme() {
    S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; saveSettings()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme-changed', S.settings.theme)
  }

  // ── 面板 / 托盘 ─────────────────────────────────────────────────────────────
  function openSettings() {
    if (S.settingsWin && !S.settingsWin.isDestroyed()) { S.settingsWin.show(); S.settingsWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const sx = Math.round(width / 2 - 230), sy = 140
    S.settingsWin = new BrowserWindow(baseOpts({ width: 460, height: 500, x: sx, y: sy, skipTaskbar: false, alwaysOnTop: true, resizable: false }))
    S.settingsWin.loadFile(path.join(__dirname, '..', 'ui', 'settings.html'), { query: orbAnchorFor(sx, sy, 460, 500) })
    S.settingsWin.on('closed', () => { S.settingsWin = null })
  }

  function openDock() {
    if (S.dockWin && !S.dockWin.isDestroyed()) { S.dockWin.show(); S.dockWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const dx = Math.round(width / 2 - 220), dy = 130
    S.dockWin = new BrowserWindow(baseOpts({ width: 440, height: 540, x: dx, y: dy, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 340, minHeight: 300 }))
    S.dockWin.loadFile(path.join(__dirname, '..', 'ui', 'dock.html'), { query: orbAnchorFor(dx, dy, 440, 540) })
    S.dockWin.on('closed', () => { S.dockWin = null })
  }

  // ── 内嵌浏览器（多标签 + 设备模拟 + 控制台 + AI 分析）──────────────────────
  const BR_TOP_H = 82   // 标签栏 38 + 工具栏 44
  const SPLIT_GUTTER = 6   // 工作台模式左右分隔条宽度
  const BR_DEVICES = {
    desktop: { label: '桌面',      w: 0,   h: 0,    dpr: 0, touch: false },
    mobile:  { label: '手机 390',  w: 390, h: 844,  dpr: 3, touch: true  },
    tablet:  { label: '平板 834',  w: 834, h: 1112, dpr: 2, touch: true  },
  }

  function normalizeUrl(url) {
    url = String(url || '').trim()
    if (!url) return ''
    if (url === 'about:blank' || url.startsWith('file://') || url.startsWith('about:')) return url
    if (/^https?:\/\//i.test(url)) return url
    if (/^localhost(:\d+)?(\/|$)/i.test(url) || /^127\.|^192\.168\.|^10\.\d|^172\.(1[6-9]|2\d|3[01])\./.test(url)) return 'http://' + url
    // 含空格或无点号 → 当作搜索（内网无搜索引擎时仍按 URL 处理）
    if (/\s/.test(url) || !/\./.test(url)) return 'http://' + url
    return 'http://' + url
  }

  const brActive = () => S.browser.tabs.find(t => t.id === S.browser.activeId) || null

  function brLayout() {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    const [cw, ch] = b.win.getContentSize()
    const leftW = b.leftW || 0                 // 工作台模式：左侧 Agent 会话占的宽度
    const G = leftW ? SPLIT_GUTTER : 0
    if (b.cardView && !b._dragging) { try { b.cardView.setBounds({ x: 0, y: 0, width: Math.max(0, leftW), height: ch }) } catch {} }
    const tab = brActive(); if (!tab) return
    if (b._dragging) return                     // 拖动分隔条时内容视图临时分离，跳过布局
    const rx = leftW + G                         // 右侧浏览器内容区左边界
    const rw = Math.max(0, cw - rx)
    const areaH = Math.max(0, ch - BR_TOP_H - b.consoleH)
    const d = tab.device
    if (d && d.w) {
      const dw = Math.min(d.w, rw)
      const dh = d.h ? Math.min(d.h, areaH) : areaH
      tab.view.setBounds({ x: rx + Math.round((rw - dw) / 2), y: BR_TOP_H, width: dw, height: dh })
    } else {
      tab.view.setBounds({ x: rx, y: BR_TOP_H, width: rw, height: areaH })
    }
  }

  function brSendTabs() {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    b.win.webContents.send('browser-tabs', {
      tabs: b.tabs.map(t => ({ id: t.id, title: t.title, loading: t.loading, favicon: t.favicon || '' })),
      activeId: b.activeId,
    })
  }

  function brSendNav(tab) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed() || tab.id !== b.activeId) return
    const dkey = Object.keys(BR_DEVICES).find(k => BR_DEVICES[k] === tab.device) || 'desktop'
    b.win.webContents.send('browser-nav', {
      url: tab.view.webContents.getURL(),
      canBack: tab.view.webContents.canGoBack(),
      canForward: tab.view.webContents.canGoForward(),
      loading: tab.loading,
      zoom: Math.round((tab.zoom || 1) * 100),
      device: dkey,
      errN: tab.errN, warnN: tab.warnN,
    })
  }

  // 把 Electron 的 level（数字或字符串）归一化为 0=log 1=info 2=warn 3=error
  function brNormLevel(lvl) {
    if (typeof lvl === 'number') return lvl
    const m = { verbose: 0, debug: 0, log: 0, info: 1, warning: 2, warn: 2, error: 3 }
    return m[String(lvl).toLowerCase()] ?? 1
  }

  // 页面级捕获:解决 CDP getResponseBody 拿不到响应体(已 GC / 流式 / 跨进程)+ 弹窗/错误模态没采集
  // 思路:在每次页面 dom-ready 时注入一段 wrapper,接管 fetch/XHR + alert/confirm/prompt,
  // 数据存 window.__BR_CAP_* 数组;compactRepro 用 executeJavaScript 拉。
  // 不依赖 CDP,内网常见 banking 框架(antd/iView/自家 modal)弹窗/接口异常都覆盖。
  const CAPTURE_JS = `;(function(){
    if (window.__bocom_cap_init) return; window.__bocom_cap_init = true;
    window.__BR_CAP_NET = []; window.__BR_CAP_DIALOG = []; window.__BR_CAP_ERRMODAL = [];
    var clip = function(s, n){ s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; };
    var nowT = function(){ return Date.now(); };
    // ── fetch 包装 ──
    if (window.fetch) {
      var _fetch = window.fetch;
      window.fetch = function(input, init){
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = (init && init.method) || (input && input.method) || 'GET';
        var reqBody = '';
        try { if (init && init.body) reqBody = typeof init.body === 'string' ? init.body : (init.body && init.body.toString ? init.body.toString() : ''); } catch(_){}
        var t0 = nowT();
        return _fetch.apply(this, arguments).then(function(resp){
          try {
            var clone = resp.clone();
            clone.text().then(function(body){
              window.__BR_CAP_NET.push({ src:'fetch', method:method.toUpperCase(), url:String(url), status:resp.status, reqBody:clip(reqBody,4000), respBody:clip(body,4000), t:t0, ms:nowT()-t0 });
              if (window.__BR_CAP_NET.length > 200) window.__BR_CAP_NET.shift();
            }).catch(function(){});
          } catch(_){}
          return resp;
        }).catch(function(e){
          window.__BR_CAP_NET.push({ src:'fetch', method:method.toUpperCase(), url:String(url), status:0, reqBody:clip(reqBody,4000), respBody:'(fetch error: '+(e && e.message || e)+')', t:t0, ms:nowT()-t0, error:true });
          throw e;
        });
      };
    }
    // ── XMLHttpRequest 包装 ──
    if (window.XMLHttpRequest) {
      var XO = window.XMLHttpRequest.prototype.open;
      var XS = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.open = function(m, u){ this.__br_m = String(m||'GET').toUpperCase(); this.__br_u = String(u||''); return XO.apply(this, arguments); };
      window.XMLHttpRequest.prototype.send = function(body){
        var xhr = this; var t0 = nowT();
        var reqBody = ''; try { reqBody = typeof body === 'string' ? body : (body && body.toString ? body.toString() : ''); } catch(_){}
        var onDone = function(){
          var respBody = ''; try { respBody = (xhr.responseType === '' || xhr.responseType === 'text') ? String(xhr.responseText || '') : '(' + (xhr.responseType||'binary') + ')'; } catch(_){}
          window.__BR_CAP_NET.push({ src:'xhr', method:xhr.__br_m||'GET', url:xhr.__br_u||'', status:xhr.status||0, reqBody:clip(reqBody,4000), respBody:clip(respBody,4000), t:t0, ms:nowT()-t0 });
          if (window.__BR_CAP_NET.length > 200) window.__BR_CAP_NET.shift();
        };
        xhr.addEventListener('loadend', onDone);
        return XS.apply(this, arguments);
      };
    }
    // ── alert/confirm/prompt 包装 ──
    ['alert','confirm','prompt'].forEach(function(k){
      var _orig = window[k]; if (typeof _orig !== 'function') return;
      window[k] = function(msg){
        try { window.__BR_CAP_DIALOG.push({ kind:k, text:clip(msg, 500), t:nowT() }); if (window.__BR_CAP_DIALOG.length > 60) window.__BR_CAP_DIALOG.shift(); } catch(_){}
        return _orig.apply(this, arguments);
      };
    });
    // ── 错误模态/Toast 自动探测 ── MutationObserver 找新增的"错误样态"节点
    var ERR_RE = /(error|fail|err|danger|warning|toast)/i;
    var TXT_RE = /(错误|失败|异常|警告|流水号|交易号|tradeNo|transactionId|requestId|serial)/i;
    try {
      var seen = 0;
      var mo = new MutationObserver(function(muts){
        for (var i=0;i<muts.length;i++) {
          for (var j=0;j<muts[i].addedNodes.length;j++) {
            var n = muts[i].addedNodes[j]; if (!n || n.nodeType !== 1) continue;
            var cls = (n.className && typeof n.className === 'string') ? n.className : '';
            var txt = (n.innerText || n.textContent || '').trim();
            if ((cls && ERR_RE.test(cls)) || (txt && TXT_RE.test(txt) && txt.length < 500)) {
              if (seen > 100) return;
              seen++;
              window.__BR_CAP_ERRMODAL.push({ cls:clip(cls, 120), text:clip(txt, 400), t:nowT() });
            }
          }
        }
      });
      var startMO = function(){ if (document.body) mo.observe(document.body, { childList:true, subtree:true }); };
      if (document.body) startMO(); else document.addEventListener('DOMContentLoaded', startMO);
    } catch(_){}
  })();`

  function brWireTab(tab) {
    const wc = tab.view.webContents
    const b = S.browser
    // 每次 dom-ready 都重注入(防 SPA 内导航后丢失);__bocom_cap_init 防重
    wc.on('dom-ready', () => { wc.executeJavaScript(CAPTURE_JS, true).catch(() => {}) })
    const onNav = () => {
      tab.title = wc.getTitle() || tab.title
      tab.url = wc.getURL()
      // 记 URL 历史(URL 栏 datalist 用):去重,最新在前,内存上限 200
      if (tab.url && /^https?:/i.test(tab.url)) {
        const h = S.browser.history = S.browser.history || []
        const i = h.indexOf(tab.url); if (i >= 0) h.splice(i, 1)
        h.unshift(tab.url); if (h.length > 200) h.length = 200
      }
      brSendTabs(); brSendNav(tab)
    }
    wc.on('did-navigate', onNav)
    wc.on('did-navigate-in-page', onNav)
    wc.on('page-title-updated', () => { tab.title = wc.getTitle(); brSendTabs(); brSendNav(tab) })
    wc.on('did-start-loading', () => { tab.loading = true; brSendTabs(); brSendNav(tab) })
    wc.on('did-stop-loading', () => { tab.loading = false; brSendTabs(); brSendNav(tab) })
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons && icons[0] || ''; brSendTabs() })
    wc.on('found-in-page', (_e, r) => {
      if (tab.id === b.activeId && b.win && !b.win.isDestroyed())
        b.win.webContents.send('browser-find-result', { active: r.activeMatchOrdinal, matches: r.matches })
    })
    wc.setWindowOpenHandler(({ url }) => { newTab(url); return { action: 'deny' } })

    // 主框架导航开始 → 清空网络记录（除非用户开了「保留日志」），对齐 DevTools 默认行为
    wc.on('did-start-navigation', (_e, navUrl, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && S.browser.noCache) {   // 禁用缓存 toggle 开 → 每次导航前清一次
        try { session.defaultSession.clearCache() } catch {}
      }
      if (isMainFrame && !isInPlace && !tab.preserveNet) {   // 对齐 DevTools：导航即清空网络 + 控制台（除非「保留日志」）
        tab.net = []; tab.netById = new Map()
        tab.console = []; tab.errN = 0; tab.warnN = 0
        if (tab.id === b.activeId && b.win && !b.win.isDestroyed()) {
          sendNetSnapshot(tab)
          b.win.webContents.send('browser-console-snapshot', { entries: [], errN: 0, warnN: 0 })
          b.win.webContents.send('browser-badge', { errN: 0, warnN: 0 })
        }
      }
    })

    // 控制台降级路径：附上 CDP 调试器后由 Runtime.consoleAPICalled 接管（更丰富），这里仅在无调试器时兜底
    wc.on('console-message', (...args) => {
      if (tab.dbg) return
      let level, message, line, source
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const d = args[0]; level = brNormLevel(d.level); message = d.message; line = d.lineNumber; source = d.sourceId
      } else {
        level = brNormLevel(args[1]); message = args[2]; line = args[3]; source = args[4]
      }
      pushConsole(tab, { level, message, line, source })
    })

    // 页面焦点下的浏览器级快捷键
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      const mod = input.control || input.meta
      if (!mod) return
      const k = (input.key || '').toLowerCase()
      const handle = (fn) => { e.preventDefault(); fn() }
      if (k === 't') handle(() => newTab(''))
      else if (k === 'w') handle(() => closeTab(b.activeId))
      else if (k === 'r') handle(() => wc.reload())
      else if (k === 'l') handle(() => b.win.webContents.send('browser-focus-url'))
      else if (k === 'f') handle(() => b.win.webContents.send('browser-open-find'))
      else if (k === '=' || k === '+') handle(() => brZoom('in'))
      else if (k === '-') handle(() => brZoom('out'))
      else if (k === '0') handle(() => brZoom('reset'))
    })
  }

  // ── 网络面板（CDP Network 域：逐 tab 抓请求/响应/时序）──────────────────────
  const MAX_NET = 600
  const slimRec = (r) => ({ id: r.id, url: r.url, method: r.method, type: r.type, status: r.status, statusText: r.statusText, mime: r.mime, size: r.size, ms: Math.round(r.ms), state: r.state, fromCache: r.fromCache, remoteIP: r.remoteIP || '', failText: r.failText || '' })
  function netSend(tab, kind, rec) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed() || tab.id !== b.activeId) return
    b.win.webContents.send('browser-net-add', { kind, rec: slimRec(rec) })
  }
  function sendNetSnapshot(tab) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    b.win.webContents.send('browser-net-snapshot', { items: tab.net.map(slimRec) })
  }
  // ── 富控制台：把 CDP RemoteObject 格式化成可读文本（对象/数组预览 + 异常堆栈）──
  function cdpConsoleLevel(t) { return (t === 'error' || t === 'assert') ? 3 : t === 'warning' ? 2 : (t === 'debug' || t === 'trace') ? 0 : 1 }
  function fmtPreviewProp(p) {
    if (p.type === 'string') return JSON.stringify(p.value)
    if (p.type === 'object') return p.subtype === 'array' ? (p.value || 'Array') : (p.value || '{…}')
    return p.value
  }
  function fmtPreview(pv) {
    if (!pv) return ''
    if (pv.subtype === 'array') return '[' + (pv.properties || []).map(fmtPreviewProp).join(', ') + (pv.overflow ? ', …' : '') + ']'
    const cls = pv.description && pv.description !== 'Object' ? pv.description + ' ' : ''
    return cls + '{' + (pv.properties || []).map((p) => p.name + ': ' + fmtPreviewProp(p)).join(', ') + (pv.overflow ? ', …' : '') + '}'
  }
  function fmtRO(ro) {
    if (!ro) return ''
    switch (ro.type) {
      case 'string': return ro.value
      case 'number': case 'boolean': return String(ro.value)
      case 'undefined': return 'undefined'
      case 'bigint': return (ro.description || ro.unserializableValue || '') + ''
      case 'symbol': return ro.description || 'Symbol()'
      case 'function': return ro.description ? String(ro.description).split('{')[0].trim() + ' {…}' : 'ƒ'
      case 'object':
        if (ro.subtype === 'null') return 'null'
        if (ro.preview) return fmtPreview(ro.preview)
        return ro.description || (ro.subtype === 'array' ? 'Array' : 'Object')
      default: return ro.description || String(ro.value == null ? '' : ro.value)
    }
  }
  function fmtException(d) {
    if (!d) return 'Uncaught'
    if (d.exception && d.exception.description) return d.exception.description     // 通常已含完整堆栈
    let s = d.text || 'Uncaught'
    if (d.exception && d.exception.value !== undefined) s += ' ' + JSON.stringify(d.exception.value)
    if (d.url) s += '  (' + d.url + ':' + ((d.lineNumber || 0) + 1) + ')'
    return s
  }
  // 统一的控制台落库 + 推送（console-message 降级路径与 CDP 富路径共用）
  function pushConsole(tab, entry) {
    // __BR__ 标记 = 录制注入脚本发来的事件,截留入 recording 队列,不进用户控制台
    const m = String(entry.message || '')
    if (m.startsWith('__BR__')) {
      try {
        const ev = JSON.parse(m.slice(6))
        if (S.browser.rec && S.browser.rec.active && S.browser.rec.tabId === tab.id) {
          // 用主进程时间戳代替页面时钟,避免页面 Date.now 被 mock 时漂移
          ev.t = Date.now() - S.browser.rec.startedAt
          S.browser.rec.events.push(ev)
        }
      } catch {}
      return
    }
    entry.ts = Date.now()
    entry.message = String(entry.message == null ? '' : entry.message).slice(0, 8000)
    entry.line = entry.line || 0; entry.source = entry.source || ''
    tab.console.push(entry)
    if (tab.console.length > 600) tab.console.shift()
    if (entry.level === 3) tab.errN++; else if (entry.level === 2) tab.warnN++
    const b = S.browser
    if (tab.id === b.activeId && b.win && !b.win.isDestroyed()) {
      b.win.webContents.send('browser-console-add', entry)
      b.win.webContents.send('browser-badge', { errN: tab.errN, warnN: tab.warnN })
    }
  }

  function onCdp(tab, method, p) {
    if (method === 'Network.requestWillBeSent') {
      const url = (p.request && p.request.url) || ''
      if (!url || url.startsWith('data:')) return
      let rec = tab.netById.get(p.requestId)
      if (rec) { rec.url = url; rec.method = p.request.method; rec.t0 = p.timestamp; rec.state = 'pending' }   // 重定向沿用同一 requestId
      else {
        rec = { id: p.requestId, url, method: (p.request && p.request.method) || 'GET', type: p.type || 'Other',
          status: 0, statusText: '', mime: '', size: 0, t0: p.timestamp, ms: 0, state: 'pending',
          fromCache: false, remoteIP: '', failText: '', reqHeaders: (p.request && p.request.headers) || {}, postData: (p.request && p.request.postData) || '' }
        tab.netById.set(rec.id, rec); tab.net.push(rec)
        if (tab.net.length > MAX_NET) { const old = tab.net.shift(); tab.netById.delete(old.id) }
      }
      netSend(tab, 'add', rec)
    } else if (method === 'Network.responseReceived') {
      const rec = tab.netById.get(p.requestId); if (!rec) return
      const r = p.response || {}
      rec.status = r.status || 0; rec.statusText = r.statusText || ''; rec.mime = r.mimeType || ''
      rec.fromCache = !!r.fromDiskCache; rec.remoteIP = r.remoteIPAddress || ''
      rec.respHeaders = r.headers || {}; rec.type = p.type || rec.type
      netSend(tab, 'upd', rec)
    } else if (method === 'Network.loadingFinished') {
      const rec = tab.netById.get(p.requestId); if (!rec) return
      if (p.encodedDataLength) rec.size = p.encodedDataLength
      rec.ms = Math.max(0, (p.timestamp - rec.t0) * 1000); rec.state = 'done'
      netSend(tab, 'upd', rec)
    } else if (method === 'Network.loadingFailed') {
      const rec = tab.netById.get(p.requestId); if (!rec) return
      rec.state = p.canceled ? 'canceled' : 'failed'; rec.failText = p.errorText || ''
      rec.ms = Math.max(0, (p.timestamp - rec.t0) * 1000)
      netSend(tab, 'upd', rec)
    } else if (method === 'Runtime.consoleAPICalled') {
      const frames = ((p.stackTrace && p.stackTrace.callFrames) || []).map((c) => ({ url: c.url, line: c.lineNumber, col: c.columnNumber, fn: c.functionName }))
      const f = frames[0]
      pushConsole(tab, { level: cdpConsoleLevel(p.type), message: (p.args || []).map(fmtRO).join(' '), source: f ? f.url : '', line: f ? (f.line + 1) : 0, frames })
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {}
      const frames = ((d.stackTrace && d.stackTrace.callFrames) || []).map((c) => ({ url: c.url, line: c.lineNumber, col: c.columnNumber, fn: c.functionName }))
      const f = frames[0]
      pushConsole(tab, { level: 3, message: fmtException(d), source: f ? f.url : (d.url || ''), line: f ? (f.line + 1) : ((d.lineNumber || 0) + 1), frames })
    }
  }
  function attachDbg(tab) {
    const wc = tab.view.webContents
    const dbg = wc.debugger
    if (!tab._dbgWired) { dbg.on('message', (_e, method, params) => { try { onCdp(tab, method, params) } catch {} }); tab._dbgWired = true }
    try { dbg.attach('1.3'); tab.dbg = true }
    catch (e) { tab.dbg = false; log('debugger attach failed: ' + e.message); tab._dbgReady = Promise.resolve(); return }
    tab._dbgReady = Promise.all([
      dbg.sendCommand('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 }).catch(() => {}),
      dbg.sendCommand('Page.enable').catch(() => {}),
      dbg.sendCommand('Runtime.enable').catch(() => {}),   // 富控制台 + 未捕获异常堆栈 + REPL 求值
    ])
  }
  function detachDbg(tab) { try { tab.view.webContents.debugger.detach() } catch {} tab.dbg = false }

  // 控制台 REPL：在活动标签的页面上下文求值（含 CLI API：$ $$ $x copy keys values；$el=已拾取元素）
  async function brEval(expr) {
    const tab = brActive(); if (!tab) return { error: '无活动标签页', isErr: true }
    if (tab.dbg) {
      try {
        const r = await tab.view.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: expr, includeCommandLineAPI: true, replMode: true, objectGroup: 'console',
          awaitPromise: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true, generatePreview: true, returnByValue: false,
        })
        if (r.exceptionDetails) return { error: fmtException(r.exceptionDetails), isErr: true }
        return { result: fmtRO(r.result) }
      } catch (e) { return { error: String(e.message || e), isErr: true } }
    }
    try { const v = await tab.view.webContents.executeJavaScript(expr, true); return { result: typeof v === 'string' ? v : JSON.stringify(v) } }
    catch (e) { return { error: String(e.message || e), isErr: true } }
  }

  // ── Source map：把打包文件的堆栈帧还原成源码 文件:行（零依赖 VLQ 解码）──────────
  const SM_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  function vlqDecode(str) {
    const out = []; let shift = 0, value = 0
    for (let i = 0; i < str.length; i++) {
      const d = SM_B64.indexOf(str[i]); if (d < 0) continue
      value += (d & 31) << shift
      if (d & 32) shift += 5
      else { out.push((value & 1) ? -(value >> 1) : (value >> 1)); value = 0; shift = 0 }
    }
    return out
  }
  function buildSourceMap(map) {
    const lines = []; let srcIdx = 0, srcLine = 0, srcCol = 0
    for (const rowStr of (map.mappings || '').split(';')) {
      let genCol = 0; const arr = []
      for (const seg of rowStr.split(',')) {
        if (!seg) continue
        const f = vlqDecode(seg); genCol += f[0] || 0
        if (f.length >= 4) { srcIdx += f[1]; srcLine += f[2]; srcCol += f[3]; arr.push({ genCol, srcIdx, srcLine, srcCol }) }
        else arr.push({ genCol })
      }
      lines.push(arr)
    }
    return { sources: map.sources || [], sourceRoot: map.sourceRoot || '', lines }
  }
  function smLookup(sm, genLine, genCol) {
    const row = sm.lines[genLine]; if (!row || !row.length) return null
    let best = null
    for (const s of row) { if (s.srcIdx === undefined) continue; if (s.genCol <= genCol) best = s; else if (best) break }
    if (!best) for (const s of row) if (s.srcIdx !== undefined) { best = s; break }
    if (!best) return null
    let src = sm.sources[best.srcIdx] || ''
    if (sm.sourceRoot && !/^https?:|^\//.test(src)) src = sm.sourceRoot.replace(/\/$/, '') + '/' + src
    return { source: src, line: best.srcLine + 1 }
  }
  const smCache = new Map()   // jsUrl -> sm | null
  async function smFetch(url, headers) { try { const r = await fetch(url, headers ? { headers } : undefined); if (!r.ok && r.status !== 206) return null; return await r.text() } catch { return null } }
  async function getSourceMap(jsUrl) {
    if (smCache.has(jsUrl)) return smCache.get(jsUrl)
    let sm = null
    try {
      const js = (await smFetch(jsUrl, { Range: 'bytes=-4096' })) || (await smFetch(jsUrl))   // 先取尾部 4KB 找注释，失败再整取
      if (js) {
        const all = [...js.matchAll(/sourceMappingURL=([^\s'"]+)/g)]
        const smu = all.length ? all[all.length - 1][1] : null
        let mapJson = null
        if (smu && smu.startsWith('data:')) {
          const body = smu.slice(smu.indexOf(',') + 1)
          mapJson = JSON.parse(smu.includes(';base64,') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body))
        } else {
          const mapUrl = smu ? new URL(smu, jsUrl).href : jsUrl + '.map'
          const t = await smFetch(mapUrl); if (t) mapJson = JSON.parse(t)
        }
        if (mapJson && mapJson.mappings) sm = buildSourceMap(mapJson)
      }
    } catch {}
    if (smCache.size > 60) smCache.clear()
    smCache.set(jsUrl, sm)
    return sm
  }
  async function resolveFrame(url, line, col) {   // line/col 为 CDP 的 0 基
    if (!url || !/^https?:/.test(url)) return null
    const sm = await getSourceMap(url); if (!sm) return null
    const o = smLookup(sm, line, col || 0); if (!o) return null
    const src = o.source.replace(/^webpack:\/\/\/?/, '').replace(/^(\.\/|\/@fs\/|\/@id\/)/, '')
    return src + ':' + o.line
  }

  function newTab(url) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    const id = ++b.seq
    const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: true, sandbox: true } })
    const tab = { id, view, title: '新标签页', url: '', loading: false, favicon: '', console: [], errN: 0, warnN: 0, zoom: 1, device: null, net: [], netById: new Map(), preserveNet: false, dbg: false }
    b.tabs.push(tab)
    brWireTab(tab)
    attachDbg(tab)
    activateTab(id)
    const u = normalizeUrl(url)
    const doLoad = () => { if (view.webContents.isDestroyed()) return; if (u) view.webContents.loadURL(u); else view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'newtab.html')) }
    // 等 Network/Page 域就绪再加载，确保首个文档请求也进网络面板
    if (tab._dbgReady) tab._dbgReady.then(doLoad, doLoad); else doLoad()
    return tab
  }

  function activateTab(id) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    const tab = b.tabs.find(t => t.id === id); if (!tab) return
    const prev = brActive()
    if (prev && prev.id !== id) { try { b.win.contentView.removeChildView(prev.view) } catch {} }
    b.activeId = id
    try { b.win.contentView.addChildView(tab.view) } catch {}
    brLayout()
    brSendTabs()
    brSendNav(tab)
    // 切换标签 → 重发该标签的控制台 + 网络快照
    b.win.webContents.send('browser-console-snapshot', { entries: tab.console, errN: tab.errN, warnN: tab.warnN })
    sendNetSnapshot(tab)
  }

  function closeTab(id) {
    const b = S.browser
    const idx = b.tabs.findIndex(t => t.id === id); if (idx === -1) return
    const tab = b.tabs[idx]
    const wasActive = b.activeId === id
    try { b.win.contentView.removeChildView(tab.view) } catch {}
    try { tab.view.webContents.debugger.detach() } catch {}
    try { tab.view.webContents.destroy() } catch {}
    b.tabs.splice(idx, 1)
    if (b.tabs.length === 0) { if (b.mode === 'workspace') { newTab(''); return } b.win.close(); return }
    if (wasActive) activateTab(b.tabs[Math.min(idx, b.tabs.length - 1)].id)
    else brSendTabs()
  }

  function brZoom(dir) {
    const tab = brActive(); if (!tab) return
    let z = tab.zoom || 1
    if (dir === 'in') z = Math.min(3, +(z + 0.1).toFixed(2))
    else if (dir === 'out') z = Math.max(0.3, +(z - 0.1).toFixed(2))
    else z = 1
    tab.zoom = z
    tab.view.webContents.setZoomFactor(z)
    brSendNav(tab)
  }

  function brSetDevice(key) {
    const tab = brActive(); if (!tab) return
    const dev = BR_DEVICES[key] || BR_DEVICES.desktop
    tab.device = key === 'desktop' ? null : dev
    const wc = tab.view.webContents
    try {
      if (tab.device && tab.device.w) {
        wc.enableDeviceEmulation({
          screenPosition: 'mobile',
          screenSize: { width: tab.device.w, height: tab.device.h },
          viewSize: { width: tab.device.w, height: tab.device.h },
          deviceScaleFactor: tab.device.dpr || 0,
          viewPosition: { x: 0, y: 0 }, scale: 1,
        })
      } else {
        wc.disableDeviceEmulation()
      }
    } catch {}
    brLayout()
    brSendNav(tab)
  }

  function brRotateDevice() {
    const tab = brActive(); if (!tab || !tab.device || !tab.device.w) return
    tab.device = { ...tab.device, w: tab.device.h, h: tab.device.w }
    brLayout()
  }

  function saveShot(buf) {
    const fp = path.join(app.getPath('downloads'), 'BocomHermes-' + Date.now() + '.png')
    fs.writeFileSync(fp, buf)
    return fp
  }
  async function brShotVisible(tab) { return saveShot((await tab.view.webContents.capturePage()).toPNG()) }
  // full=true 走 CDP 整页截图（captureBeyondViewport，含视口外内容）；失败/无调试器则回退可视区
  async function brScreenshot(full) {
    const tab = brActive(); if (!tab) return null
    try {
      if (full && tab.dbg) {
        const dbg = tab.view.webContents.debugger
        const m = await dbg.sendCommand('Page.getLayoutMetrics')
        const cs = m.cssContentSize || m.contentSize || { width: 1280, height: 800 }
        const w = Math.max(1, Math.ceil(cs.width)), h = Math.max(1, Math.min(Math.ceil(cs.height), 30000))   // 30000px 上限防超大页爆内存
        const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })
        return saveShot(Buffer.from(shot.data, 'base64'))
      }
      return await brShotVisible(tab)
    } catch (e) {
      log('browser screenshot err: ' + e.message)
      try { return await brShotVisible(tab) } catch { return null }
    }
  }

  // 元素拾取：往页面注入一个高亮覆盖层，鼠标悬停描边、点击返回选择器+盒模型，Esc 取消
  const PICKER_JS = `new Promise((resolve) => {
    const D = document, root = D.documentElement, prevCur = root.style.cursor;
    const ov = D.createElement('div'); ov.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;background:rgba(74,168,255,.22);border:1px solid #4aa8ff;border-radius:2px;display:none';
    const tip = D.createElement('div'); tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#10131f;color:#cfe3ff;font:11px/1.4 ui-monospace,Menlo,monospace;padding:3px 7px;border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,.55);white-space:nowrap;display:none';
    D.body.appendChild(ov); D.body.appendChild(tip); root.style.cursor = 'crosshair';
    let cur = null;
    const escc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    function selOf(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + escc(el.id);
      const path = []; let n = el, depth = 0;
      while (n && n.nodeType === 1 && n !== D.body && n !== root && depth < 5) {
        let s = n.tagName.toLowerCase();
        if (n.id) { path.unshift('#' + escc(n.id)); break; }
        const cls = (typeof n.className === 'string' ? n.className.trim().split(/\\s+/).filter(Boolean) : []).slice(0, 2);
        if (cls.length) s += '.' + cls.map(escc).join('.');
        let i = 1, sib = n; while (sib = sib.previousElementSibling) { if (sib.tagName === n.tagName) i++; }
        if (i > 1) s += ':nth-of-type(' + i + ')';
        path.unshift(s); n = n.parentElement; depth++;
      }
      return path.join(' > ');
    }
    function info(el) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el), px = (v) => Math.round(parseFloat(v)) || 0;
      return { selector: selOf(el), tag: el.tagName.toLowerCase(), id: el.id || '', classes: (typeof el.className === 'string' ? el.className : ''),
        w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top),
        margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
        border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
        padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
        color: cs.color, bg: cs.backgroundColor, font: cs.fontSize + ' ' + (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '') };
    }
    function move(e) {
      const el = D.elementFromPoint(e.clientX, e.clientY); if (!el || el === ov || el === tip) return; cur = el;
      const r = el.getBoundingClientRect();
      ov.style.display = 'block'; ov.style.left = r.left + 'px'; ov.style.top = r.top + 'px'; ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px';
      tip.style.display = 'block'; tip.textContent = selOf(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
      let ty = r.top - 23; if (ty < 2) ty = r.bottom + 4; tip.style.left = Math.max(2, r.left) + 'px'; tip.style.top = ty + 'px';
    }
    function cleanup() { try { ov.remove(); tip.remove(); } catch (e) {} root.style.cursor = prevCur;
      D.removeEventListener('mousemove', move, true); D.removeEventListener('click', click, true); D.removeEventListener('keydown', key, true); window.removeEventListener('beforeunload', bye); }
    function click(e) { e.preventDefault(); e.stopPropagation(); const el = cur || D.elementFromPoint(e.clientX, e.clientY); try { window.$el = el } catch (_e) {} const out = el ? info(el) : null; cleanup(); resolve(out); }
    function key(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); } }
    function bye() { cleanup(); resolve(null); }
    D.addEventListener('mousemove', move, true); D.addEventListener('click', click, true); D.addEventListener('keydown', key, true); window.addEventListener('beforeunload', bye);
  })`
  async function brPickElement() {
    const tab = brActive(); if (!tab) return null
    try { return await tab.view.webContents.executeJavaScript(PICKER_JS, true) }
    catch (e) { log('pick element err: ' + e.message); return null }
  }
  async function brNetBody(id) {
    const tab = brActive(); if (!tab) return null
    const rec = tab.netById.get(id); if (!rec) return null
    let body = null, base64 = false
    if (tab.dbg && (rec.state === 'done' || rec.status)) {
      try { const r = await tab.view.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: id }); body = r.body; base64 = !!r.base64Encoded }
      catch (e) { body = '（无法获取响应体：' + e.message + '）' }
    }
    if (body && !base64 && body.length > 400000) body = body.slice(0, 400000) + '\n…（响应体过大，已截断）'
    return { id, url: rec.url, method: rec.method, status: rec.status, statusText: rec.statusText, mime: rec.mime, type: rec.type, size: rec.size, ms: Math.round(rec.ms), state: rec.state, remoteIP: rec.remoteIP || '', reqHeaders: rec.reqHeaders || {}, respHeaders: rec.respHeaders || {}, postData: rec.postData || '', body, base64 }
  }

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
  async function dbgTriage(serve, summary, heur) {
    const p = `你是调试分诊器。根据复现信号，判断是否值得启动"多 agent 对抗分析"（多个 agent 各持一个假设并行查证，再交叉反驳）。\n` +
      `启发式先验：难度 ${heur.difficulty}/5，疑似层面 [${heur.layers.join(', ') || '未知'}]。\n\n复现信号摘要：\n${summary}\n\n` +
      `判断规则：跨前后端 / 根因不明确 / 多条相互矛盾线索 → multi；单一明确报错或单层小问题 → single（更快）。\n` +
      `只输出 JSON、不要调用任何工具、不要解释：{"difficulty":1-5,"layers":["frontend"|"backend"|"contract"...],"strategy":"single"|"multi","reason":"一句中文理由"}`
    try {
      const sid = await oc.createSession(serve, '分诊')
      const txt = await Promise.race([oc.sendMessage(serve, sid, p), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 45000))])
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
    try {
      dbgNote(cardWc, disp, 'user')
      // 信号简单 → 直接单 agent，省掉一次分诊调用
      if (heur.strategy === 'single' && heur.difficulty <= 2) {
        dbgNote(cardWc, `🧭 分诊：难度 ${heur.difficulty}/5 · 单 agent 直接定位`, 'info')
        inj(bundlePrompt); return
      }
      dbgNote(cardWc, '🧭 正在评估是否需要多 agent 对抗分析…', 'info')
      const v = await dbgTriage(serve, summary, heur)
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
            `**只输出假设清单,不要读代码、不要修改文件。**\n\n## 复现上下文\n` + bundlePrompt)
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
          const out = await oc.sendMessage(useServe, sid, DBG_LENS[k] + `\n（你正在【${repo}】里，只能读到这个仓库的源码）\n\n## 复现上下文\n` + bundlePrompt + notesHint + '\n\n只聚焦你这个假设，简洁给出证据（文件:行）与判断，不要修改任何文件。')
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
            `你在【后端仓库】里。下面是一个从前端复现的问题 + 多路调查结论。如果根因/修复在后端，请直接用编辑工具修改后端源码完成修复（我会逐次确认写入），改完用一两句话说明改了哪些文件、为什么；如果与后端无关，只回复"后端无需改动"。\n\n## 复现上下文\n${bundlePrompt}\n\n## 各路调查结论\n${merged}`)
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
        if (!r.t0) return false
        const tMs = r.t0 * 1000   // CDP timestamp 是秒
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
      const hitSummary = replay.hitInfo && replay.hitInfo.length ? `;改动 ${replay.hitInfo.length} 文件,${replay.hitInfo.filter((h) => h.executed > 0).length} 个被执行` : ''
      const statusKind = rep.pass ? 'pass' : (/SUSPICIOUS/.test(rep.verdict) ? 'suspicious' : 'fail')
      const disp = `🔁 验证完成 · ${rep.pass ? '✅ PASS' : (statusKind === 'suspicious' ? '⚠ SUSPICIOUS' : '❌ FAIL')}\n(回放 ${replay.stepReport.length}/${rec.events.length} 步;修复前 ${rec.snapshot.errs.length}/${rec.snapshot.bad.length} → 修复后 ${replay.after.errs.length}/${replay.after.bad.length}${hitSummary})`
      // 同步推一份卡片到浏览器壳 UI,用户在右下角一眼看到结论而不用翻 agent 对话流
      if (b.win && !b.win.isDestroyed()) {
        b.win.webContents.send('wf-verify-result', {
          kind: statusKind, verdict: rep.verdict, fullText: rep.text,
          summary: `回放 ${replay.stepReport.length}/${rec.events.length} 步 · 修复前 ${rec.snapshot.errs.length}报错/${rec.snapshot.bad.length}异常 → 修复后 ${replay.after.errs.length}/${replay.after.bad.length}${hitSummary}`,
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

  function createBrowser(initialUrl) {
    const b = S.browser
    if (b.win && !b.win.isDestroyed()) {
      b.win.focus()
      if (initialUrl) newTab(initialUrl)
      return
    }
    const win = new BrowserWindow({
      width: 1320, height: 880, minWidth: 920, minHeight: 600,
      title: 'BocomHermes · 浏览器',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 13, y: 12 },
      // Windows: 用 overlay 把系统三键(最小化/最大化/关闭)染成深色，融进自绘标签栏(高 38px)
      titleBarOverlay: process.platform === 'win32' ? { color: '#0b0c16', symbolColor: '#cfd3e3', height: 38 } : undefined,
      autoHideMenuBar: true,
      backgroundColor: '#0b0c16',
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    })
    b.win = win; b.tabs = []; b.activeId = null; b.consoleH = 0
    win.loadFile(path.join(__dirname, '..', 'ui', 'browser.html'))
    win.on('resize', brLayout)
    win.on('closed', () => {
      // ⚠ 不要手动 destroy 子 WebContentsView 的 webContents —— Electron 自己会清,
      // 双重 destroy 在 Windows 触发 native 段错误(crashpad: not connected),整个 agent 进程会崩。
      S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
      ensureOrbAlive()   // 关浏览器 ≠ 退出 agent —— 球带回前台
    })
    // chrome 加载完后再建首个标签（保证 IPC 能收到）
    win.webContents.once('did-finish-load', () => newTab(initialUrl || ''))
  }

  // ── 调试工作台：左 Agent 会话 + 右 内嵌浏览器（并排单窗口）────────────────────
  // 复用上面整套标签机制（newTab/activateTab/brLayout…），区别仅在于 b.leftW>0 + 一个左侧 cardView。
  function createWorkspace(initialUrl) {
    const b = S.browser
    if (b.win && !b.win.isDestroyed()) { b.win.focus(); if (initialUrl) newTab(initialUrl); return }
    const win = new BrowserWindow({
      width: 1500, height: 940, minWidth: 1040, minHeight: 620,
      title: 'BocomHermes · 调试工作台',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 13, y: 12 },
      titleBarOverlay: process.platform === 'win32' ? { color: '#0b0c16', symbolColor: '#cfd3e3', height: 38 } : undefined,
      autoHideMenuBar: true,
      backgroundColor: '#0b0c16',
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    })
    b.win = win; b.tabs = []; b.activeId = null; b.consoleH = 0; b.seq = 0
    b.mode = 'workspace'; b.leftW = 460; b._dragging = false

    // 左侧 Agent 会话 = 一个加载 card.html 的 WebContentsView（embedded 模式：隐藏自带窗口控件）
    const cardView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } })
    b.cardView = cardView; b.cardWcId = cardView.webContents.id
    win.contentView.addChildView(cardView)
    cardView.webContents.loadFile(path.join(__dirname, '..', 'ui', 'card.html'), { query: { embedded: '1', title: '调试助手' } })

    win.loadFile(path.join(__dirname, '..', 'ui', 'browser.html'), { query: { workspace: '1' } })   // 复用浏览器壳，workspace 模式右移 chrome + 加分隔条
    win.on('resize', () => {
      const [cw] = win.getContentSize()
      b.leftW = Math.max(320, Math.min(cw - 440, b.leftW))
      brLayout()
      if (!win.isDestroyed()) win.webContents.send('browser-split-set', b.leftW)
    })
    win.on('closed', () => {
      // ⚠ 不要手动 destroy 子 WebContentsView 的 webContents —— Electron 自己会清,
      // 双重 destroy 在 Windows 触发 native 段错误(crashpad: not connected),整个 agent 进程会崩。
      const s = S.sessionByWc.get(b.cardWcId)
      if (s) { const si = S.sessionInfo.get(s); if (si) oc.abort(si.serve, s); S.sessionInfo.delete(s); S.streamBuf.delete(s); S.sentPrompt.delete(s); S.firstMsgCtx.delete(s) }
      S.sessionByWc.delete(b.cardWcId)
      S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
      ensureOrbAlive()
    })
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('browser-split-set', b.leftW)
      brLayout()
      newTab(initialUrl || '')
    })
  }

  function buildTray() {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
    S.tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    S.tray.setToolTip('BocomHermes')
    S.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '唤起输入框', accelerator: 'Ctrl+Shift+Space', click: toggleInput },
      { label: '🌐 调试工作台（Agent + 浏览器）', accelerator: 'Ctrl+Shift+B', click: () => createWorkspace() },
      { label: '📧 邮件摘要', click: () => spawnEmailCard().catch((e) => log('email card err: ' + e.message)) },
      { label: '📋 待办事项', click: openTodos },
      { label: '卡坞 · 历史对话', click: openDock },
      { label: '切换深 / 浅主题', click: toggleTheme },
      { label: '设置…', click: openSettings },
      { label: '打开日志', click: () => { if (S.logFile) shell.openPath(S.logFile).catch(() => {}) } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
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
  ipcMain.on('set-theme', (_e, t) => {
    S.settings.theme = t === 'dark' ? 'dark' : 'light'; saveSettings()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme-changed', S.settings.theme)
  })

  ipcMain.on('get-project', (e) => { e.returnValue = projName() })
  ipcMain.handle('pick-project', async () => {
    const r = await dialog.showOpenDialog({ title: '选择代码仓库（新卡将对它说话）', properties: ['openDirectory'] })
    if (!r.canceled && r.filePaths[0]) applyProject(r.filePaths[0])
    return projName()
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
    e.returnValue = {
      theme: S.settings.theme, editorCmd: S.settings.editorCmd || '', serveBin: S.settings.serveBin || '',
      serveBinEffective: process.env.BOCOMHERMES_SERVE_BIN || S.settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode'),
      serveBinLocked: !!process.env.BOCOMHERMES_SERVE_BIN,
      proxy: S.settings.proxy || '',
      project: projName(), projectDir: S.settings.projectDir || '', recentDirs: S.settings.recentDirs || [],
      backendDir: S.settings.backendDir || '',
      planMode: S.settings.planMode !== false,
      imap: { host: im.host || '', port: im.port || 993, secure: im.secure !== false, allowSelf: !!im.allowSelfSigned, user: im.user || '', hasPass: !!im.passEncrypted, scheduleHour: im.scheduleHour ?? 9 },
      smtp: { host: sm.host || '', port: sm.port || 587, secure: !!sm.secure, allowSelf: !!sm.allowSelfSigned, sameAsImap: sm.sameAsImap !== false, user: sm.user || '', hasPass: !!sm.passEncrypted, from: sm.from || '' },
    }
  })
  ipcMain.handle('spawn-card', (_e, title) => spawnCard(title))
  ipcMain.handle('spawn-fanout', (_e, goal, roles) => spawnFanout(goal, roles))
  ipcMain.handle('spawn-fanout-roles', (_e, { goal, roles }) => spawnFanout(goal, roles))
  ipcMain.handle('get-fanout-roles', () => Object.entries(ROLES).map(([k, [label]]) => ({ key: k, label })))
  ipcMain.handle('spawn-workflow', (_e, goal) => spawnWorkflow(goal))

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

  ipcMain.on('close-self', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('hide-self', (e) => BrowserWindow.fromWebContents(e.sender)?.hide())
  ipcMain.on('minimize-self', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
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
    try { return await spawnEmailCard() } catch (e) { throw new Error(e.message) }
  })
  ipcMain.handle('email-test', async () => {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    const r = await email.fetchUnread(imap, { limit: 5 })
    return { count: r.totalMatched, sample: r.emails.slice(0, 2).map(e => ({ from: e.from, subject: e.subject })) }
  })

  // ── Settings: IMAP 字段读写 ───────────────────────────────────────────────
  ipcMain.handle('set-settings', (_e, patch) => {
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
    if (patch && typeof patch.planMode === 'boolean') S.settings.planMode = patch.planMode
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
    saveSettings(); return true
  })

  // SMTP 测试:给自己发一封空邮件,失败把错误返回前端展示
  ipcMain.handle('smtp-test', async () => {
    const cfg = effectiveSmtp(S)
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

  // ── Todos 广播（卡片保存待办后通知 todos 面板刷新）────────────────────────
  ipcMain.on('todos-updated', () => {
    if (S.todosWin && !S.todosWin.isDestroyed()) S.todosWin.webContents.send('todos-updated')
  })

  ipcMain.handle('open-todos', () => openTodos())

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
  // 注入到页面里的录制监听:click/input/key/scroll/submit/navigate 全打到 console("__BR__"+JSON),
  // 主进程的 pushConsole 截留这条 message 入 rec.events,不进用户控制台。
  // 选择器优先 id > data-test/testid > name/aria-label > 短 nth-of-type 路径,尽量稳定。
  const RECORDER_JS = `
;(function(){
  if (window.__bocom_rec_init) return; window.__bocom_rec_init = true;
  var emit = function(e){ try { console.log('__BR__' + JSON.stringify(e)); } catch(_){} };
  // 记多个选择器候选:回放时按优先级 fallback,DOM 结构小幅变动也能命中
  var selBuild = function(el){
    if (!el || el === document || el === document.body) return ['body'];
    var cands = [];
    if (el.id) cands.push('#' + CSS.escape(el.id));
    var attrs = ['data-test','data-testid','data-cy','data-qa','name','aria-label'];
    for (var i=0;i<attrs.length;i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v) cands.push(el.tagName.toLowerCase() + '[' + attrs[i] + '="' + v.replace(/"/g,'\\\\"') + '"]');
    }
    // role + accessible name
    var role = el.getAttribute && el.getAttribute('role');
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (role && aria) cands.push('[role="'+role+'"][aria-label="'+aria.replace(/"/g,'\\\\"')+'"]');
    // 文本选择器(短可见文本):标签 + 内含文本
    var txt = (el.innerText || el.value || '').trim();
    if (txt && txt.length <= 30 && !txt.includes('\\n')) {
      cands.push('__text__:' + el.tagName.toLowerCase() + '|' + txt.replace(/"/g,'').slice(0,30));
    }
    // nth-of-type 路径作最后兜底
    var parts = []; var n = el;
    for (var d=0; d<5 && n && n.tagName && n !== document.body; d++) {
      var s = n.tagName.toLowerCase();
      if (typeof n.className === 'string' && n.className.trim()) {
        var cls = n.className.trim().split(/\\s+/).slice(0,2).filter(Boolean).map(function(c){return '.'+CSS.escape(c)}).join('');
        if (cls) s += cls;
      }
      var par = n.parentNode;
      if (par && par.children) {
        var same = Array.prototype.filter.call(par.children, function(x){ return x.tagName === n.tagName; });
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n)+1) + ')';
      }
      parts.unshift(s); n = n.parentNode;
    }
    cands.push(parts.join(' > '));
    return cands;
  };
  window.bocomSel = function(el){ return selBuild(el)[0]; };
  document.addEventListener('click', function(e){
    if (!window.__bocom_rec_on) return;
    var el = e.target; var c = selBuild(el);
    emit({ act:'click', sel:c[0], selAlt:c.slice(1), text:(el.innerText||el.value||'').toString().slice(0,40) });
  }, true);
  var inputTmr = null;
  document.addEventListener('input', function(e){
    if (!window.__bocom_rec_on) return;
    var el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) return;
    clearTimeout(inputTmr);
    inputTmr = setTimeout(function(){
      var v = el.isContentEditable ? (el.innerText||'') : (el.value||'');
      var c = selBuild(el);
      emit({ act:'input', sel:c[0], selAlt:c.slice(1), value:String(v).slice(0,200) });
    }, 250);   // 防抖,合并连续敲字
  }, true);
  document.addEventListener('keydown', function(e){
    if (!window.__bocom_rec_on) return;
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
      var c = selBuild(e.target); emit({ act:'key', sel:c[0], selAlt:c.slice(1), key:e.key });
    }
  }, true);
  document.addEventListener('submit', function(e){
    if (!window.__bocom_rec_on) return;
    var c = selBuild(e.target); emit({ act:'submit', sel:c[0], selAlt:c.slice(1) });
  }, true);
  // SPA 路由变化:hook history.pushState/replaceState + popstate(Vue/React 用 history mode 必走这条)
  function urlNow(){ return location.pathname + location.search + location.hash; }
  var lastUrl = urlNow();
  var emitNavIfChanged = function(){
    var u = urlNow();
    if (u !== lastUrl) { lastUrl = u; emit({ act:'navigate', url: location.href, spa: true }); }
  };
  var _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function(){ var r = _ps.apply(this, arguments); try { window.__bocom_rec_on && emitNavIfChanged(); } catch(_){} return r; };
  history.replaceState = function(){ var r = _rs.apply(this, arguments); try { window.__bocom_rec_on && emitNavIfChanged(); } catch(_){} return r; };
  window.addEventListener('popstate', function(){ if (window.__bocom_rec_on) emitNavIfChanged(); });
  window.addEventListener('hashchange', function(){ if (window.__bocom_rec_on) emitNavIfChanged(); });
  var scrollTmr = null;
  document.addEventListener('scroll', function(){
    if (!window.__bocom_rec_on) return;
    clearTimeout(scrollTmr);
    scrollTmr = setTimeout(function(){
      emit({ act:'scroll', x:Math.round(window.scrollX), y:Math.round(window.scrollY) });
    }, 250);
  }, { capture:true, passive:true });
})();`

  async function injectRecorder(wc) {
    try { await wc.executeJavaScript(RECORDER_JS + '\n;window.__bocom_rec_on=true;', true) }
    catch (e) { log('injectRecorder err: ' + e.message) }
  }

  ipcMain.handle('browser-rec-start', async () => {
    const tab = brActive()
    if (!tab) return { ok: false, error: '没有活跃标签' }
    const wc = tab.view.webContents
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
    S.browser.rec = { active: true, tabId: tab.id, startedAt: Date.now(), startUrl: wc.getURL(), preState, events: [] }
    S.browser.rec.events.push({ t: 0, act: 'navigate', url: wc.getURL() })
    await injectRecorder(wc)
    // 录制中导航 → 新页面要再注入(__bocom_rec_init 防重,__bocom_rec_on 重置)
    const handler = () => { if (S.browser.rec && S.browser.rec.active) injectRecorder(wc).then(() => {
      const u = wc.getURL()
      const last = S.browser.rec.events[S.browser.rec.events.length - 1]
      if (!last || last.url !== u) S.browser.rec.events.push({ t: Date.now() - S.browser.rec.startedAt, act: 'navigate', url: u })
    }) }
    wc.on('did-finish-load', handler)
    S.browser.rec.cleanup = () => { try { wc.off('did-finish-load', handler) } catch {} }
    log('rec start: tab ' + tab.id + ' @ ' + S.browser.rec.startUrl)
    return { ok: true }
  })

  ipcMain.handle('browser-rec-stop', async () => {
    const r = S.browser.rec
    if (!r || !r.active) return { ok: false, error: '没有进行中的录制' }
    r.active = false
    if (r.cleanup) r.cleanup()
    // 把页面里的 flag 关掉(监听仍在,只是不再 emit)
    const tab = (S.browser.tabs || []).find((t) => t.id === r.tabId)
    if (tab) { try { await tab.view.webContents.executeJavaScript(';window.__bocom_rec_on=false;', true) } catch {} }
    // 录制结束 = 复现成功瞬间 → 抓快照(报错 + 网络异常【含 200 业务异常】),供 Phase C 验证时 diff
    const snapshot = tab ? {
      errs: tab.console.filter((c) => c.level >= 2).map((c) => ({ level: c.level, msg: (c.message || '').split('\n')[0].slice(0, 200) })),
      bad: await snapshotBad(tab),
      url: tab.url || '',
    } : { errs: [], bad: [], url: '' }
    const id = 'rec_' + Date.now().toString(36)
    const dir = path.join(app.getPath('userData'), 'recordings')
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    const rec = { id, tabId: r.tabId, startedAt: r.startedAt, startUrl: r.startUrl, durationMs: Date.now() - r.startedAt, events: r.events, snapshot, preState: r.preState || null }
    try { fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(rec, null, 2)) } catch (e) { log('rec save err: ' + e.message) }
    S.browser.lastRec = rec
    log('rec stop: ' + id + ' · ' + r.events.length + ' events · pre-fix snapshot: ' + snapshot.errs.length + ' errs / ' + snapshot.bad.length + ' bad')
    return { ok: true, ...rec }
  })

  // ── 回放 ─────────────────────────────────────────────────────────────────
  // 按录制时间线在当前 tab 自动播放;每步执行后等"网络静默"(<=900ms 无新请求),
  // 步间最长 sleep 2s。播完抓"修复后状态"快照,跟录制时的"修复前状态"diff。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 把"普通 CSS 选择器"或"__text__:tag|text"伪选择器转成页面里能跑的"找元素"表达式
  function selExpr(sel) {
    const s = String(sel || '')
    if (s.startsWith('__text__:')) {
      const idx = s.indexOf('|'); const tag = s.slice(9, idx).toLowerCase()
      const txt = s.slice(idx + 1)
      return `(function(){var els=document.querySelectorAll(${JSON.stringify(tag)});for(var i=0;i<els.length;i++){var t=(els[i].innerText||els[i].value||'').trim();if(t===${JSON.stringify(txt)}||t.indexOf(${JSON.stringify(txt)})===0)return els[i]}return null})()`
    }
    return `document.querySelector(${JSON.stringify(s)})`
  }
  // 把 sel + selAlt 串成"按优先级 fallback,谁先找到用谁"的表达式;变量名 __el 给后续操作用
  function findElExpr(sel, alt) {
    const cands = [sel, ...(alt || [])].filter(Boolean)
    const tryList = cands.map((c) => `(__el=${selExpr(c)})`).join(' || ')
    return tryList || 'null'
  }
  // 等"网络静默":300ms 内无新请求 = 静默,最长等 maxMs
  async function waitNetIdle(tab, idleMs = 300, maxMs = 3000) {
    const t0 = Date.now()
    let lastChange = tab.net.length
    let lastSeenAt = Date.now()
    while (Date.now() - t0 < maxMs) {
      await sleep(80)
      if (tab.net.length !== lastChange) { lastChange = tab.net.length; lastSeenAt = Date.now() }
      else if (Date.now() - lastSeenAt >= idleMs) return
    }
  }
  // 回放可视化:每个 click/input/submit 前在页面里给目标元素打个红框 + 浮标"步 N",看得见在跑什么
  async function highlightTarget(wc, ev, idx) {
    if (!ev.sel || ev.act === 'navigate' || ev.act === 'scroll') return
    const elExpr = findElExpr(ev.sel, ev.selAlt)
    const label = JSON.stringify(`步 ${idx} · ${ev.act}`)
    try {
      await wc.executeJavaScript(`(()=>{
        var __el=null; if(!(${elExpr})) return;
        var rect=__el.getBoundingClientRect();
        var box=document.createElement('div'); box.id='__bocom_hi__';
        box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #ff3b30;border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,.85),0 0 14px rgba(255,59,48,.55);transition:opacity .3s';
        box.style.left=(rect.left-3)+'px'; box.style.top=(rect.top-3)+'px';
        box.style.width=(rect.width+6)+'px'; box.style.height=(rect.height+6)+'px';
        var tag=document.createElement('div'); tag.textContent=${label};
        tag.style.cssText='position:absolute;left:0;top:-22px;background:#ff3b30;color:#fff;font:600 11px system-ui;padding:2px 8px;border-radius:4px;white-space:nowrap';
        box.appendChild(tag);
        var prev=document.getElementById('__bocom_hi__'); if(prev)prev.remove();
        (document.body||document.documentElement).appendChild(box);
        setTimeout(function(){var b=document.getElementById('__bocom_hi__');if(b){b.style.opacity='0';setTimeout(function(){b&&b.remove&&b.remove()},300)}}, 700);
      })()`, true)
    } catch {}
  }
  async function execStep(wc, ev, tab) {
    if (ev.act === 'navigate') {
      const cur = wc.getURL()
      if (cur === ev.url && !ev._needRestore && !ev._restorePreState) return { ok: true }
      // SPA 路由变化:用 history.pushState + popstate,避免整页 reload 清空 SPA 状态
      if (ev.spa && !ev._restorePreState) {
        try {
          await wc.executeJavaScript(`(()=>{try{history.pushState({},'',${JSON.stringify(ev.url)});window.dispatchEvent(new PopStateEvent('popstate'))}catch(e){}})()`, true)
          return { ok: true }
        } catch (e) { return { ok: false, err: e.message } }
      }
      try { wc.loadURL(ev.url) } catch (e) { return { ok: false, err: e.message } }
      await new Promise((res) => { const t = setTimeout(res, 12000); wc.once('did-stop-loading', () => { clearTimeout(t); res() }) })
      // 首次 navigate 后,把 localStorage/sessionStorage 恢复 + reload(让页面在正确状态下重新初始化)
      if (ev._restorePreState) {
        try {
          const ls = ev._restorePreState.local || '{}'
          const ss = ev._restorePreState.session || '{}'
          await wc.executeJavaScript(`(()=>{try{var l=JSON.parse(${JSON.stringify(ls)});Object.keys(l).forEach(k=>localStorage.setItem(k,l[k]));var s=JSON.parse(${JSON.stringify(ss)});Object.keys(s).forEach(k=>sessionStorage.setItem(k,s[k]));}catch(e){}})()`, true)
          // reload 让 SPA 在恢复后的 storage 状态下重新跑入口逻辑
          try { wc.reload() } catch {}
          await new Promise((res) => { const t = setTimeout(res, 12000); wc.once('did-stop-loading', () => { clearTimeout(t); res() }) })
        } catch (e) { log('storage restore err: ' + e.message) }
      }
      return { ok: true }
    }
    const elExpr = findElExpr(ev.sel, ev.selAlt)
    if (ev.act === 'click') {
      try {
        const r = await wc.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';__el.scrollIntoView({block:'center'});__el.click();return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'input') {
      try {
        const r = await wc.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';
          var v=${JSON.stringify(String(ev.value == null ? '' : ev.value))};
          if (__el.isContentEditable){__el.focus();__el.innerText=v}
          else{var p=Object.getOwnPropertyDescriptor(__el.__proto__,'value');p&&p.set?p.set.call(__el,v):(__el.value=v);}
          __el.dispatchEvent(new Event('input',{bubbles:true}));__el.dispatchEvent(new Event('change',{bubbles:true}));return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'key') {
      try {
        await wc.executeJavaScript(`(()=>{var __el=null;if(${elExpr})__el.focus();})()`, true)
        wc.sendInputEvent({ type: 'keyDown', keyCode: ev.key })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ev.key })
        if (ev.key === 'Enter') {
          try { await wc.executeJavaScript(`(()=>{var __el=null;if((${elExpr})&&__el.form){__el.form.requestSubmit?__el.form.requestSubmit():__el.form.submit()}})()`, true) } catch {}
        }
        return { ok: true }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'submit') {
      try {
        const r = await wc.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';if(__el.tagName==='FORM'){__el.requestSubmit?__el.requestSubmit():__el.submit()}else{__el.click()}return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'scroll') {
      try { await wc.executeJavaScript(`window.scrollTo(${ev.x || 0}, ${ev.y || 0})`, true); return { ok: true } } catch (e) { return { ok: false, err: e.message } }
    }
    return { ok: true }
  }

  // ── 命中证据 ─────────────────────────────────────────────────────────────
  // 用 V8 PreciseCoverage 看 "agent 改过的文件里有多少函数在回放期间真被执行了"。
  // 若改的函数没被命中,大概率是改错地方(或该复现路径不覆盖此改动)→ 验证报告里报警。
  const { execSync } = require('child_process')
  function gitChangedFiles(dir) {
    if (!dir) return []
    const out = new Set()
    for (const cmd of ['git diff --name-only HEAD', 'git diff --cached --name-only HEAD', 'git ls-files --others --exclude-standard']) {
      try { execSync(cmd, { cwd: dir, encoding: 'utf8', timeout: 3000 }).split('\n').forEach((l) => { l = l.trim(); if (l) out.add(l) }) } catch {}
    }
    return [...out]
  }
  async function startCoverage(tab) {
    if (!tab.dbg) return false
    try {
      await tab.view.webContents.debugger.sendCommand('Profiler.enable')
      await tab.view.webContents.debugger.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
      return true
    } catch (e) { log('coverage start fail: ' + e.message); return false }
  }
  async function stopCoverage(tab) {
    try {
      const r = await tab.view.webContents.debugger.sendCommand('Profiler.takePreciseCoverage')
      try { await tab.view.webContents.debugger.sendCommand('Profiler.stopPreciseCoverage') } catch {}
      return r.result || []
    } catch (e) { log('coverage take fail: ' + e.message); return null }
  }
  // 按文件 basename 匹配 coverage URL,统计每个 changed file 的执行函数数
  function coverageHits(cov, changedFiles) {
    const baseToFile = new Map()
    for (const f of changedFiles) {
      const b = f.split(/[\\/]/).pop()
      if (b) baseToFile.set(b, f)
    }
    const hits = new Map()
    for (const entry of cov || []) {
      const url = entry.url || ''
      const ub = url.split('?')[0].split('#')[0].split('/').pop()
      const cf = baseToFile.get(ub); if (!cf) continue
      let executed = 0
      for (const fn of entry.functions || []) {
        if (fn.ranges && fn.ranges[0] && fn.ranges[0].count > 0) executed++
      }
      hits.set(cf, (hits.get(cf) || 0) + executed)
    }
    return changedFiles.map((f) => ({ file: f, executed: hits.get(f) || 0 }))
  }
  // 只对前端常见可执行扩展报警(后端 java/py/sql 不会在浏览器里跑,缺命中是正常的)
  const JS_LIKE = /\.(?:js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i

  // ── 断言驱动验证 ─────────────────────────────────────────────────────────
  // Agent 改完代码用 mcp 'repro_assert' 写断言到 userData/assertions/<bundleId>.json
  // 验证回放后,这里读出来逐条对照"修复后"状态打 ✓/✗
  function loadAssertions(bundleId) {
    if (!bundleId) return []
    const fp = path.join(app.getPath('userData'), 'assertions', bundleId + '.json')
    try { const a = JSON.parse(fs.readFileSync(fp, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] }
  }
  // 读 agent 通过 scan_impact 工具登记的影响半径扫描 → 算出"已扫文件集合"
  function loadScans(bundleId) {
    if (!bundleId) return { scans: [], scannedFiles: new Set() }
    const fp = path.join(app.getPath('userData'), 'scans', bundleId + '.json')
    let arr = []
    try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')); if (!Array.isArray(arr)) arr = [] } catch {}
    const files = new Set()
    for (const s of arr) for (const f of (s.files || [])) files.add(f)
    return { scans: arr, scannedFiles: files }
  }
  // 读 agent 通过 repro_self_review 工具登记的自审
  function loadReview(bundleId) {
    if (!bundleId) return null
    const fp = path.join(app.getPath('userData'), 'reviews', bundleId + '.json')
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return null }
  }
  async function checkAssertions(tab, assertions) {
    if (!assertions.length) return []
    const wc = tab.view.webContents
    const out = []
    for (const a of assertions) {
      let pass = false, detail = ''
      try {
        if (a.kind === 'no_console') {
          const v = String(a.value)
          const hit = tab.console.find((c) => c.level >= 2 && (c.message || '').includes(v))
          pass = !hit; detail = hit ? '仍出现: ' + hit.message.split('\n')[0].slice(0, 120) : '✓ 未再出现'
        } else if (a.kind === 'no_element') {
          const r = await wc.executeJavaScript(`!document.querySelector(${JSON.stringify(a.value)})`, true)
          pass = !!r; detail = pass ? '✓ 已消失' : '元素仍存在'
        } else if (a.kind === 'has_element') {
          const r = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(a.value)})`, true)
          pass = !!r; detail = pass ? '✓ 已出现' : '元素仍不存在'
        } else if (a.kind === 'no_net') {
          const v = String(a.value)
          // 既看真 4xx/5xx/failed,也看 200 业务异常
          const hit = tab.net.find((n) => (n.url || '').includes(v) && (n.state === 'failed' || (n.status >= 400) || (n.status === 200 && n._biz && n._biz.hit)))
          pass = !hit; detail = hit ? '仍异常: ' + (hit._biz ? '200·业务异常 ' + hit._biz.hint : (hit.status || hit.state)) + ' ' + hit.url : '✓ 该接口未再异常'
        }
      } catch (e) { detail = '检查时出错: ' + e.message }
      out.push({ ...a, pass, detail })
    }
    return out
  }

  // ── 错误聚类: 按 stack 签名分组,降噪 ─────────────────────────────────────
  function clusterErrs(errs) {
    const groups = new Map()   // signature -> { count, sample, firstAt }
    errs.forEach((c, idx) => {
      const head = (c.message || '').split('\n')[0].slice(0, 140)
      const f0 = c.frames && c.frames[0]
      const sig = head + '|' + (f0 ? (f0.url || '') + ':' + f0.line : '')
      const g = groups.get(sig)
      if (g) { g.count++ } else groups.set(sig, { count: 1, sample: c, firstAt: idx + 1 })
    })
    return [...groups.values()]
  }

  async function replayRec(rec) {
    const tab = brActive()
    if (!tab) return { ok: false, error: '没有活跃标签' }
    const wc = tab.view.webContents
    // 前置状态 restore:cookies 在 navigate 前装(请求时随发),localStorage/sessionStorage 在 load 后装 + 必要时 reload
    if (rec.preState) {
      try {
        for (const c of (rec.preState.cookies || [])) {
          const url = rec.startUrl
          try { await session.defaultSession.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite }) } catch {}
        }
        log('replay restored ' + (rec.preState.cookies || []).length + ' cookies')
      } catch (e) { log('cookies restore err: ' + e.message) }
    }
    // 抓"修复后"状态:清空之前的报错/网络,重头开始
    tab.console = []; tab.errN = 0; tab.warnN = 0
    tab.net = []; tab.netById = new Map()
    // 启动覆盖率收集(若 CDP 调试器已挂),并收集 agent 改过的文件清单
    const changedFiles = [...new Set([...gitChangedFiles(S.settings.projectDir), ...gitChangedFiles(S.settings.backendDir)])]
    const covOn = await startCoverage(tab)
    const stepReport = []
    let lastT = 0
    let storageRestored = false
    let consecutiveFails = 0; let cascadeFrom = -1
    for (let i = 0; i < rec.events.length; i++) {
      const ev = rec.events[i]
      if (!storageRestored && ev.act === 'navigate' && rec.preState && (rec.preState.local !== '{}' || rec.preState.session !== '{}')) {
        ev._restorePreState = rec.preState; storageRestored = true
      }
      const gap = Math.min(Math.max(0, (ev.t || 0) - lastT), 2000)   // 步间最长 sleep 2s
      if (gap > 50) await sleep(gap)
      lastT = ev.t || 0
      await highlightTarget(wc, ev, i + 1)   // 先标红框让用户看到下一步要点哪
      await sleep(180)
      const r = await execStep(wc, ev, tab)
      stepReport.push({ i: i + 1, act: ev.act, sel: ev.sel || ev.url || '', ok: r.ok, err: r.err || '' })
      if (!r.ok && ev.act === 'navigate') break
      // 级联失败检测:连续 3 个非 navigate 步失败 → 后续大概率都依赖前面失败步,提前 break 不无谓继续
      if (!r.ok && ev.act !== 'navigate') {
        consecutiveFails++
        if (consecutiveFails >= 3) {
          if (cascadeFrom < 0) cascadeFrom = i + 1 - (consecutiveFails - 1)   // 第一个连续 fail 步号
          log('replay early-abort: ' + consecutiveFails + ' consecutive fails from step ' + cascadeFrom)
          break
        }
      } else if (r.ok) consecutiveFails = 0
      // 等网络静默(取代固定 150ms);click/submit 后常触发 XHR,需要等它打完
      if (ev.act === 'click' || ev.act === 'submit' || ev.act === 'key') await waitNetIdle(tab, 300, 3000)
      else await sleep(120)
    }
    await sleep(1800)    // 播完再等异步报错/请求浮现
    const after = {
      errs: tab.console.filter((c) => c.level >= 2).map((c) => ({ level: c.level, msg: (c.message || '').split('\n')[0].slice(0, 200) })),
      bad: await snapshotBad(tab),   // 含 200 业务异常
      url: tab.url || '',
    }
    const cov = covOn ? await stopCoverage(tab) : null
    const hitInfo = cov ? coverageHits(cov, changedFiles) : []
    return { ok: true, stepReport, after, changedFiles, hitInfo, covOn, cascadeFrom, totalSteps: rec.events.length }
  }

  // 报告:把 before/after diff 翻译成 PASS/FAIL 文字结论(无视觉依赖)
  function diffReport(rec, replay) {
    const before = rec.snapshot || { errs: [], bad: [] }
    const after = replay.after
    const lines = []
    lines.push(`回放 ${replay.stepReport.length}/${rec.events.length} 步,起始 URL: ${rec.startUrl}`)
    const fails = replay.stepReport.filter((s) => !s.ok)
    if (fails.length) {
      lines.push(`\n步骤失败 ${fails.length} 处(可能是修复后页面结构变了,部分元素找不到):`)
      for (const f of fails.slice(0, 10)) lines.push(`  · 步 ${f.i} ${f.act} "${String(f.sel).slice(0, 60)}" — ${f.err}`)
      if (replay.cascadeFrom >= 0) {
        const skipped = replay.totalSteps - replay.stepReport.length
        lines.push(`  ⚠ 步 ${replay.cascadeFrom} 起连续 3 次失败 → 早停(后续 ${skipped} 步未执行),通常是早期失败破坏了页面流程,排查那个首失败点即可,后面级联多半假阳性`)
      }
    } else lines.push('所有步骤执行成功 ✓')
    lines.push(`\n报错前后对比: 修复前 ${before.errs.length} → 修复后 ${after.errs.length}`)
    if (after.errs.length) {
      const grp = new Map()   // msg head → count
      for (const e of after.errs) { const k = (e.msg || '').slice(0, 140); grp.set(k, (grp.get(k) || 0) + 1) }
      lines.push('  修复后仍有(同消息已聚合):')
      const sorted = [...grp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      for (const [msg, n] of sorted) lines.push(`    ✗ ${msg}${n > 1 ? '  ×' + n : ''}`)
    }
    lines.push(`网络/业务异常前后对比: 修复前 ${before.bad.length} → 修复后 ${after.bad.length}`)
    if (after.bad.length) {
      lines.push('  修复后仍有:')
      for (const b of after.bad.slice(0, 8)) lines.push(`    ${b.biz ? '200·业务异常 ' + b.biz : (b.status || b.state)}  ${b.url}`)
    }
    // 断言:agent 明确声明"应让什么消失/出现",这是 PASS 的硬证据(优先于数量对比)
    let assertFail = 0
    if (replay.assertions && replay.assertions.length) {
      lines.push('\nAgent 声明的修复断言(逐条核对当前状态):')
      for (const a of replay.assertions) {
        const mark = a.pass ? '✓' : '✗'
        if (!a.pass) assertFail++
        lines.push(`  ${mark} [${a.kind}] "${a.value}"  — ${a.detail}${a.why ? '   · ' + a.why : ''}`)
      }
    }
    // 命中证据:agent 改过的前端文件,回放期间有多少函数真被执行了
    let unhitJsCount = 0
    if (replay.changedFiles && replay.changedFiles.length) {
      const jsLike = replay.hitInfo.filter((h) => JS_LIKE.test(h.file))
      const others = replay.hitInfo.filter((h) => !JS_LIKE.test(h.file))
      lines.push(`\nAgent 改动文件(本次 session 共 ${replay.changedFiles.length} 个),回放期间执行命中:`)
      if (!replay.covOn) lines.push('  ⚠ 当前标签未挂 CDP 调试器,无法收集 V8 coverage(打开 DevTools 触发一次即可启用)')
      else {
        for (const h of jsLike) {
          const mark = h.executed > 0 ? '✓' : '✗'
          if (h.executed === 0) unhitJsCount++
          lines.push(`  ${mark} ${h.file}  (${h.executed} 个函数被执行)`)
        }
        if (others.length) lines.push(`  · 其它非 JS 改动 ${others.length} 个(java/py/sql 等不在浏览器跑,不参与命中评估):${others.map((o) => o.file).join(', ')}`)
        if (unhitJsCount > 0) lines.push(`  ⚠ ${unhitJsCount} 个 JS/TS 改动在回放中未被执行 — 大概率改错地方,或这条复现路径不覆盖此改动`)
      }
    }
    // 判定:报错与网络异常都不多于(且无新增) + 步骤全过 + 改动都被命中(若有 JS 改动) → PASS
    const beforeErrMsgs = new Set(before.errs.map((e) => e.msg))
    const beforeBadUrls = new Set(before.bad.map((b) => b.url + '|' + (b.status || '') + '|' + (b.biz || '')))
    const newErrs = after.errs.filter((e) => !beforeErrMsgs.has(e.msg))
    const newBads = after.bad.filter((b) => !beforeBadUrls.has(b.url + '|' + (b.status || '') + '|' + (b.biz || '')))
    const errsImproved = after.errs.length <= before.errs.length
    const badsImproved = after.bad.length <= before.bad.length
    // 影响半径检查:agent 改了文件却没事先 scan_impact 扫过 = 盲改 → SUSPICIOUS
    let blindEdits = []
    if (replay.changedFiles && replay.changedFiles.length && replay.scans) {
      const scannedSet = replay.scans.scannedFiles
      // 改的文件 basename 在 scan 历史中出现过任一,就算扫过
      const scannedBase = new Set()
      for (const f of scannedSet) { const b = f.split(/[\\/]/).pop(); if (b) scannedBase.add(b) }
      blindEdits = replay.changedFiles.filter((f) => {
        const b = f.split(/[\\/]/).pop()
        return !scannedSet.has(f) && !scannedBase.has(b)
      })
      lines.push('\nAgent 改前影响半径扫描:')
      if (replay.scans.scans.length === 0) {
        lines.push('  ⚠ 一次都没调 scan_impact — agent 没查改动影响范围,盲改')
      } else {
        lines.push(`  · 共扫了 ${replay.scans.scans.length} 个符号,覆盖 ${scannedSet.size} 个文件`)
        for (const s of replay.scans.scans.slice(0, 5)) lines.push(`    ✓ scan_impact("${s.symbol}") → ${s.files.length} 文件`)
      }
      if (blindEdits.length) lines.push(`  ⚠ 改了 ${blindEdits.length} 个未扫过的文件(盲改):\n` + blindEdits.slice(0, 5).map((f) => '    · ' + f).join('\n'))
    }
    // Self-review 显示
    if (replay.review) {
      lines.push('\nAgent 自评 (repro_self_review):')
      lines.push(`  · 信心 ${replay.review.risk}/5 — ${replay.review.summary}`)
      if (replay.review.edge_cases) lines.push(`  · 未覆盖的边界: ${replay.review.edge_cases}`)
    } else if (replay.changedFiles && replay.changedFiles.length) {
      lines.push('\n⚠ Agent 没调 repro_self_review — 跳过了自审环节')
    }

    const hitsOk = unhitJsCount === 0   // 若全是后端改动或无 JS 改动,自动 true
    const assertOk = assertFail === 0
    const radiusOk = blindEdits.length === 0
    const reviewOk = !replay.changedFiles || !replay.changedFiles.length || (replay.review && replay.review.risk >= 3)
    const pass = errsImproved && badsImproved && newErrs.length === 0 && newBads.length === 0 && fails.length === 0 && hitsOk && assertOk && radiusOk && reviewOk
    let verdict
    if (!assertOk) verdict = `❌ FAIL — Agent 自己声明的 ${assertFail} 条断言未通过(见上面 ✗ 标的几条) → 修复未达成 agent 自己的预期`
    else if (newErrs.length || newBads.length) verdict = `❌ FAIL — 出现了修复前没有的新问题:${newErrs.length} 条新报错 / ${newBads.length} 条新网络异常 → 回归了`
    else if (!radiusOk) verdict = `⚠ SUSPICIOUS — 改了 ${blindEdits.length} 个未扫过的文件(盲改),没确认这些改动的影响半径 → 可能改坏其他功能`
    else if (!hitsOk) verdict = `⚠ SUSPICIOUS — 报错和网络看着好了,但 ${unhitJsCount} 个 JS 改动在回放期间根本没被执行 → 可能改错地方,问题"看似消失"可能是别的因素`
    else if (!reviewOk) verdict = replay.review ? `⚠ SUSPICIOUS — Agent 自评信心 ${replay.review.risk}/5 偏低 → 修复可能不彻底,建议看 review 里的边界后再确认` : '⚠ SUSPICIOUS — Agent 跳过了 self-review,缺少自审证据'
    else if (fails.length) verdict = '⚠ PARTIAL — 步骤执行有失败(可能页面结构变了),无法可靠判断;建议人工再看一眼'
    else if (!errsImproved || !badsImproved) verdict = '❌ FAIL — 数量变多了 → 没修好或引入了新问题'
    else if (pass && replay.assertions && replay.assertions.length) verdict = `✅ PASS — Agent ${replay.assertions.length} 条断言全部满足 + 影响半径已扫 + self-review 信心 ${replay.review ? replay.review.risk : '-'}/5 + JS 改动均被执行 → 修复有硬证据`
    else if (pass) verdict = '✅ PASS — 复现路径全部走通,报错/网络异常未增加,JS 改动均被执行,影响半径与 self-review 完整'
    else verdict = '✅ PASS'
    return { pass, verdict, text: verdict + '\n\n' + lines.join('\n') }
  }
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
    return { ok: true, dryRun, result }
  })
  // 录制管理面板:list / star / rename / delete / replay-stored
  ipcMain.handle('browser-rec-list', () => {
    const dir = path.join(app.getPath('userData'), 'recordings')
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
          startUrl: j.startUrl || '',
          expectation: j.expectation || '',
          eventCount: (j.events || []).length,
          durationMs: j.durationMs || 0,
          mtime: fs.statSync(path.join(dir, f)).mtimeMs,
        })
      } catch {}
    }
    return items.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.mtime - a.mtime)
  })
  ipcMain.handle('browser-rec-update', (_e, { id, patch }) => {
    if (!id || !patch || typeof patch !== 'object') return false
    const fp = path.join(app.getPath('userData'), 'recordings', id + '.json')
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const allowed = ['title', 'starred', 'expectation']
      for (const k of allowed) if (k in patch) j[k] = patch[k]
      fs.writeFileSync(fp, JSON.stringify(j, null, 2))
      return true
    } catch (e) { log('rec update err: ' + e.message); return false }
  })
  ipcMain.handle('browser-rec-delete', (_e, id) => {
    const fp = path.join(app.getPath('userData'), 'recordings', id + '.json')
    try { fs.unlinkSync(fp); log('rec deleted: ' + id); return true } catch (e) { log('rec del err: ' + e.message); return false }
  })
  ipcMain.handle('browser-rec-replay-stored', async (_e, id) => {
    const fp = path.join(app.getPath('userData'), 'recordings', id + '.json')
    let rec; try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch (e) { return { ok: false, error: '读取失败: ' + e.message } }
    S.browser.lastRec = rec   // 让 verify 用这条
    const replay = await replayRec(rec)
    return replay
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

  return { createOrb, createBrowser, createWorkspace, spawnCard, spawnFanout, spawnWorkflow, spawnEmailCard, toggleInput, toggleOrbInput, buildTray, openDock, openTodos, openSettings, applyProject, projName, recordHistory, touchHistory }
}
