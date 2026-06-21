'use strict'
const USE_ACRYLIC = false
const { clipboard } = require('electron')
const email = require('./email')

module.exports = function initWindow(S, { ipcMain, app, BrowserWindow, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }) {
  // 额外窗口引用
  S.todosWin = null
  S.orbInputWin = null
  // ── 设置 ────────────────────────────────────────────────────────────────────
  function loadSettings() { try { return { ...S.settings, ...JSON.parse(fs.readFileSync(S.settingsFile, 'utf8')) } } catch { return { ...S.settings } } }
  function saveSettings() { try { fs.writeFileSync(S.settingsFile, JSON.stringify(S.settings)) } catch {} }
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

  function snapOrbToCorner() {
    if (!S.inputWin || S.inputWin.isDestroyed()) return
    const [x, y] = S.inputWin.getPosition()
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    const W = 280, M = 20
    const nx = (x + W / 2) < sw / 2 ? M : sw - W - M
    const ny = (y + W / 2) < sh / 2 ? M : sh - W - M
    S.inputWin.setPosition(nx, ny)
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
    S.orbInputWin = new BrowserWindow(baseOpts({
      width: pw, height: ph, x: Math.round(px), y: Math.round(py), skipTaskbar: true,
    }))
    S.orbInputWin.loadFile(path.join(__dirname, '..', 'ui', 'orb-input.html'), mode ? { query: { mode } } : undefined)
    S.orbInputWin.on('closed', () => { S.orbInputWin = null })
  }

  function toggleOrbInput(mode) { createOrbInput(mode) }

  function spawnCard(title, sid, msg) {
    const id = ++S.cardSeq
    const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
    const win = new BrowserWindow(baseOpts({
      width: 480, height: 600, minWidth: 360, minHeight: 320, resizable: true,
      alwaysOnTop: false, skipTaskbar: false,
      x: 160 + col * 56, y: 90 + row * 50 + col * 18,
    }))
    const wcId = win.webContents.id
    const query = { title: title || '未命名任务', id: String(id) }
    if (sid) query.sid = sid
    if (msg) query.msg = msg
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
    const emails = await email.fetchUnread(imap)
    if (!emails.length) { log('email: no unread emails'); return 0 }
    log('email: fetched ' + emails.length + ' emails')
    const prompt = email.formatEmailPrompt(emails)
    spawnCard('📧 邮件摘要 · ' + new Date().toLocaleDateString('zh-CN'), null, prompt)
    return emails.length
  }

  function openTodos() {
    if (S.todosWin && !S.todosWin.isDestroyed()) { S.todosWin.show(); S.todosWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    S.todosWin = new BrowserWindow(baseOpts({ width: 400, height: 560, x: Math.round(width / 2 - 200), y: 120, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 320, minHeight: 300 }))
    S.todosWin.loadFile(path.join(__dirname, '..', 'ui', 'todos.html'))
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
    S.settingsWin = new BrowserWindow(baseOpts({ width: 460, height: 500, x: Math.round(width / 2 - 230), y: 140, skipTaskbar: false, alwaysOnTop: true, resizable: false }))
    S.settingsWin.loadFile(path.join(__dirname, '..', 'ui', 'settings.html'))
    S.settingsWin.on('closed', () => { S.settingsWin = null })
  }

  function openDock() {
    if (S.dockWin && !S.dockWin.isDestroyed()) { S.dockWin.show(); S.dockWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    S.dockWin = new BrowserWindow(baseOpts({ width: 440, height: 540, x: Math.round(width / 2 - 220), y: 130, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 340, minHeight: 300 }))
    S.dockWin.loadFile(path.join(__dirname, '..', 'ui', 'dock.html'))
    S.dockWin.on('closed', () => { S.dockWin = null })
  }

  function buildTray() {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
    S.tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    S.tray.setToolTip('BocomHermes')
    S.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '唤起输入框', accelerator: 'Ctrl+Shift+Space', click: toggleInput },
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
      let tmpl = null
      if (p.isEditable) tmpl = [{ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { type: 'separator' }, { role: 'selectAll', label: '全选' }]
      else if (p.selectionText && p.selectionText.trim()) tmpl = [{ role: 'copy', label: '复制' }, { type: 'separator' }, { role: 'selectAll', label: '全选' }]
      if (tmpl) Menu.buildFromTemplate(tmpl).popup({ window: BrowserWindow.fromWebContents(wc) })
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

  ipcMain.handle('open-settings', () => openSettings())
  ipcMain.on('get-settings', (e) => {
    const im = S.settings.imap || {}
    e.returnValue = {
      theme: S.settings.theme, editorCmd: S.settings.editorCmd || '', serveBin: S.settings.serveBin || '',
      serveBinEffective: process.env.BOCOMHERMES_SERVE_BIN || S.settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode'),
      serveBinLocked: !!process.env.BOCOMHERMES_SERVE_BIN,
      project: projName(), projectDir: S.settings.projectDir || '', recentDirs: S.settings.recentDirs || [],
      imap: { host: im.host || '', port: im.port || 993, secure: im.secure !== false, allowSelf: !!im.allowSelfSigned, user: im.user || '', hasPass: !!im.passEncrypted, scheduleHour: im.scheduleHour ?? 9 },
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
    const emails = await email.fetchUnread(imap)
    return { count: emails.length, sample: emails.slice(0, 2).map(e => ({ from: e.from, subject: e.subject })) }
  })

  // ── Settings: IMAP 字段读写 ───────────────────────────────────────────────
  ipcMain.handle('set-settings', (_e, patch) => {
    if (patch && typeof patch.editorCmd === 'string') S.settings.editorCmd = patch.editorCmd.trim()
    if (patch && typeof patch.serveBin === 'string') {
      S.settings.serveBin = patch.serveBin.trim()
      if (!process.env.BOCOMHERMES_SERVE_BIN && S.settings.serveBin) oc.setServeBin(S.settings.serveBin)
    }
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
    saveSettings(); return true
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
  ipcMain.on('orb-move', (_e, { dx, dy }) => {
    if (!S.inputWin || S.inputWin.isDestroyed()) return
    const [x, y] = S.inputWin.getPosition()
    S.inputWin.setPosition(x + dx, y + dy)
    if (S.orbInputWin && !S.orbInputWin.isDestroyed()) {
      const [px, py] = S.orbInputWin.getPosition()
      S.orbInputWin.setPosition(px + dx, py + dy)
    }
  })
  ipcMain.on('orb-snap', () => snapOrbToCorner())
  ipcMain.handle('toggle-orb-input', (_e, mode) => toggleOrbInput(mode))
  ipcMain.handle('close-orb-input', () => {
    if (S.orbInputWin && !S.orbInputWin.isDestroyed()) { S.orbInputWin.close(); S.orbInputWin = null }
  })

  ipcMain.handle('open-dock', () => openDock())
  ipcMain.on('get-history', (e) => { e.returnValue = S.history })
  ipcMain.handle('open-history', (_e, { sid, title }) => spawnCard(title, sid))
  ipcMain.handle('clear-history', () => { S.history = []; saveHistory(); return true })

  return { createOrb, spawnCard, spawnFanout, spawnWorkflow, spawnEmailCard, toggleInput, toggleOrbInput, buildTray, openDock, openTodos, openSettings, applyProject, projName, recordHistory, touchHistory }
}
