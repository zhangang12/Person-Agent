const { app, BrowserWindow, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { exec } = require('child_process')
const oc = require('./opencode')

const USE_ACRYLIC = false
let inputWin = null
let cardSeq = 0
let tray = null
const log = (m) => console.log('[tianshu] ' + m)

// ===== 设置（主题 + 当前项目目录）=====
let settingsFile = null
let settings = { theme: 'light', projectDir: '', serveBin: '', editorCmd: '', recentDirs: [] }
function loadSettings() { try { return { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } } catch { return { ...settings } } }
function saveSettings() { try { fs.writeFileSync(settingsFile, JSON.stringify(settings)) } catch {} }
const projName = () => settings.projectDir ? path.basename(settings.projectDir) : '未选目录'

// 切换当前项目目录：记入最近列表、预热其 serve、广播给所有窗口
function applyProject(dir) {
  settings.projectDir = dir
  settings.recentDirs = [dir, ...(settings.recentDirs || []).filter((d) => d !== dir)].slice(0, 6)
  saveSettings()
  oc.ensureServe(dir, handlers, log).catch((e) => log('prewarm failed: ' + e.message))
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('project-changed', projName())
}

// ===== 会话历史索引（天枢自己的轻量台账，不是 opencode 配置）=====
// 只记 sessionId/标题/目录/时间，用于"卡坞"续接；真正的对话状态在 opencode 会话里。
let historyFile = null
let history = []   // [{ id, title, dir, project, ts, created }]，最近在前
function loadHistory() { try { const a = JSON.parse(fs.readFileSync(historyFile, 'utf8')); if (Array.isArray(a)) history = a } catch {} }
function saveHistory() { try { fs.writeFileSync(historyFile, JSON.stringify(history.slice(0, 50))) } catch {} }
function recordHistory(id, title, dir) {
  const t = (title || '对话').replace(/\s+/g, ' ').trim().slice(0, 80)
  history = [{ id, title: t, dir: dir || '', project: dir ? path.basename(dir) : '未选目录', ts: Date.now(), created: Date.now() },
    ...history.filter((h) => h.id !== id)].slice(0, 50)
  saveHistory()
}
function touchHistory(id) { const h = history.find((x) => x.id === id); if (h) { h.ts = Date.now(); saveHistory() } }

// ===== 会话映射（跨多 serve）=====
const sessionByWc = new Map()   // webContents.id -> sessionId
const sessionInfo = new Map()   // sessionId -> { wc, serve }   serve = 该项目的 serve 池信息
const pendingPerm = new Map()   // requestId -> sessionId
const streamBuf = new Map()     // sessionId -> { partID, text }
const sentPrompt = new Map()    // sessionId -> 最近用户输入

// 事件回调（所有 serve 的事件循环共用；按 sessionId 路由回对应卡片 + 对应 serve）
function onPermission({ sessionId, requestId, tool }) {
  const si = sessionInfo.get(sessionId); if (!si) return
  if (oc.AUTO_ALLOW.has(tool)) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
  if (!si.wc || si.wc.isDestroyed()) { oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return }
  pendingPerm.set(requestId, sessionId)
  si.wc.send('permission-request', { requestId, tool })
}
function onText({ sessionId, text, role, partID, kind }) {
  const si = sessionInfo.get(sessionId); if (!si || !si.wc || si.wc.isDestroyed()) return
  if (role && role !== 'assistant') return
  if (!role && kind !== 'reasoning' && text === sentPrompt.get(sessionId)) return
  let buf = streamBuf.get(sessionId); if (!buf) { buf = {}; streamBuf.set(sessionId, buf) }
  const prev = buf[partID] || ''
  const full = prev && !text.startsWith(prev) ? prev + text : text   // 兼容累积/增量
  buf[partID] = full
  si.wc.send('card-stream', { kind: kind || 'text', text: full, partID })
}
const handlers = { onPermission, onText }

function baseOpts(extra) {
  const opts = {
    frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    ...extra,
  }
  if (USE_ACRYLIC) { opts.transparent = false; opts.backgroundColor = '#00000000'; opts.backgroundMaterial = 'acrylic' }
  else { opts.transparent = true }
  return opts
}

function createInput() {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  inputWin = new BrowserWindow(baseOpts({ width: 600, height: 112, x: Math.round(width / 2 - 300), y: 84, skipTaskbar: false }))
  inputWin.loadFile(path.join(__dirname, 'ui', 'input.html'))
  inputWin.on('closed', () => { inputWin = null })
}

function spawnCard(title, sid) {
  const id = ++cardSeq
  const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
  const win = new BrowserWindow(baseOpts({
    width: 480, height: 600, minWidth: 360, minHeight: 320, resizable: true,
    alwaysOnTop: false,   // 不强制置顶：点别的应用时卡片自然退后，不挡操作
    skipTaskbar: false,   // 进任务栏：最小化后可从任务栏/Alt+Tab 找回
    x: 160 + col * 56, y: 90 + row * 50 + col * 18,
  }))
  const wcId = win.webContents.id   // 先存下，closed 时 webContents 已销毁不能再访问
  const query = { title: title || '未命名任务', id: String(id) }
  if (sid) query.sid = sid          // 带 sid = 续接已有会话（卡坞打开）
  win.loadFile(path.join(__dirname, 'ui', 'card.html'), { query })
  win.on('closed', () => {
    const s = sessionByWc.get(wcId)
    if (s) { const si = sessionInfo.get(s); if (si) oc.abort(si.serve, s); sessionInfo.delete(s); streamBuf.delete(s); sentPrompt.delete(s) }
    sessionByWc.delete(wcId)
  })
  return id
}

function toggleInput() {
  if (!inputWin) { createInput(); return }
  if (inputWin.isVisible()) inputWin.hide()
  else { inputWin.show(); inputWin.focus() }
}

function toggleTheme() {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; saveSettings()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme-changed', settings.theme)
}

// 在编辑器里打开 文件:行（默认 VS Code；可在 settings.editorCmd 配 IDEA 等）
function openInEditor(file, line) {
  const tmpl = settings.editorCmd || 'code -g "{file}:{line}"'
  const cmd = tmpl.replace(/\{file\}/g, file).replace(/\{line\}/g, String(line || 1))
  exec(cmd, (err) => { if (err) shell.openPath(file).catch(() => {}) }) // 编辑器命令失败则用默认程序打开
}

// 设置面板（小玻璃卡）：主题 / 编辑器命令 / serve 二进制 / 当前项目
let settingsWin = null
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return }
  const { width } = screen.getPrimaryDisplay().workAreaSize
  settingsWin = new BrowserWindow(baseOpts({
    width: 460, height: 500, x: Math.round(width / 2 - 230), y: 140,
    skipTaskbar: false, alwaysOnTop: true, resizable: false,
  }))
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
}

// 卡坞（会话历史）窗口
let dockWin = null
function openDock() {
  if (dockWin && !dockWin.isDestroyed()) { dockWin.show(); dockWin.focus(); return }
  const { width } = screen.getPrimaryDisplay().workAreaSize
  dockWin = new BrowserWindow(baseOpts({
    width: 440, height: 540, x: Math.round(width / 2 - 220), y: 130,
    skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 340, minHeight: 300,
  }))
  dockWin.loadFile(path.join(__dirname, 'ui', 'dock.html'))
  dockWin.on('closed', () => { dockWin = null })
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('天枢 Tianshu')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '唤起输入框', accelerator: 'Ctrl+Shift+Space', click: () => { if (!inputWin) createInput(); else { inputWin.show(); inputWin.focus() } } },
    { label: '卡坞 · 历史对话', click: openDock },
    { label: '切换深 / 浅主题', click: toggleTheme },
    { label: '设置…', click: openSettings },
    { type: 'separator' },
    { label: '退出天枢', click: () => app.quit() },
  ]))
  tray.on('click', toggleInput)
}

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = loadSettings()
  historyFile = path.join(app.getPath('userData'), 'history.json')
  loadHistory()

  // serve 启动命令：开发=opencode，打包 exe=bocomcode；可被环境变量或 settings.serveBin 覆盖
  const serveBin = process.env.TIANSHU_SERVE_BIN || settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode')
  oc.setServeBin(serveBin)
  log('serve binary: ' + serveBin + (app.isPackaged ? ' (packaged)' : ' (dev)'))

  // 主题
  ipcMain.on('get-theme', (e) => { e.returnValue = settings.theme })
  ipcMain.on('set-theme', (_e, t) => {
    settings.theme = t === 'dark' ? 'dark' : 'light'; saveSettings()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme-changed', settings.theme)
  })

  // 项目目录：只改"当前选择"，影响之后新开的卡；不动已开卡的 serve
  ipcMain.on('get-project', (e) => { e.returnValue = projName() })
  ipcMain.handle('pick-project', async () => {
    const r = await dialog.showOpenDialog({ title: '选择代码仓库（新卡将对它说话）', properties: ['openDirectory'] })
    if (!r.canceled && r.filePaths[0]) applyProject(r.filePaths[0])
    return projName()
  })
  // 从最近列表一键切换（无需弹框）
  ipcMain.handle('set-project-dir', (_e, dir) => {
    if (dir && fs.existsSync(dir)) applyProject(dir)
    else { settings.recentDirs = (settings.recentDirs || []).filter((d) => d !== dir); saveSettings() } // 失效路径剔除
    return projName()
  })

  // 设置面板
  ipcMain.handle('open-settings', () => openSettings())
  ipcMain.on('get-settings', (e) => {
    e.returnValue = {
      theme: settings.theme,
      editorCmd: settings.editorCmd || '',
      serveBin: settings.serveBin || '',
      serveBinEffective: process.env.TIANSHU_SERVE_BIN || settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode'),
      serveBinLocked: !!process.env.TIANSHU_SERVE_BIN,   // 环境变量在场时面板里只读
      project: projName(),
      projectDir: settings.projectDir || '',
      recentDirs: settings.recentDirs || [],
    }
  })
  ipcMain.handle('set-settings', (_e, patch) => {
    if (patch && typeof patch.editorCmd === 'string') settings.editorCmd = patch.editorCmd.trim()
    if (patch && typeof patch.serveBin === 'string') {
      settings.serveBin = patch.serveBin.trim()
      if (!process.env.TIANSHU_SERVE_BIN && settings.serveBin) oc.setServeBin(settings.serveBin) // 立即对新开 serve 生效（已起的不动）
    }
    saveSettings()
    return true
  })

  // 开卡 / 窗口
  ipcMain.handle('spawn-card', (_e, title) => spawnCard(title))
  ipcMain.on('close-self', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('hide-self', (e) => BrowserWindow.fromWebContents(e.sender)?.hide())
  ipcMain.on('minimize-self', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('toggle-pin', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    const v = !w.isAlwaysOnTop(); w.setAlwaysOnTop(v); return v
  })
  ipcMain.handle('toggle-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    if (w.isMaximized()) w.unmaximize(); else w.maximize(); return w.isMaximized()
  })

  // 卡片 ↔ 会话（绑定到当前项目的 serve）。opts.sid 在场 = 续接卡坞里的旧会话。
  ipcMain.handle('card-init', async (e, opts) => {
    const sid = opts && opts.sid
    const wantTitle = (opts && opts.title) || ''
    if (sid) {
      const h = history.find((x) => x.id === sid)
      const dir = (h && h.dir) || settings.projectDir || ''
      const serve = await oc.ensureServe(dir, handlers, log)
      const proj = dir ? path.basename(dir) : projName()
      if (await oc.sessionExists(serve, sid)) {                 // 会话还在 → 重连 + 回放
        sessionByWc.set(e.sender.id, sid)
        sessionInfo.set(sid, { wc: e.sender, serve })
        touchHistory(sid)
        let messages = []; try { messages = await oc.getMessages(serve, sid) } catch {}
        return { sessionId: sid, project: proj, reattached: true, messages }
      }
      const ns = await oc.createSession(serve, wantTitle || (h && h.title) || '天枢对话')  // 已不在 → 新开一段
      if (!ns) throw new Error('create session failed')
      sessionByWc.set(e.sender.id, ns)
      sessionInfo.set(ns, { wc: e.sender, serve })
      recordHistory(ns, wantTitle || (h && h.title), dir)
      return { sessionId: ns, project: proj, reattached: false, stale: true }
    }
    const dir = settings.projectDir || ''
    const serve = await oc.ensureServe(dir, handlers, log)
    const sessionId = await oc.createSession(serve, '天枢对话')
    if (!sessionId) throw new Error('create session failed')
    sessionByWc.set(e.sender.id, sessionId)
    sessionInfo.set(sessionId, { wc: e.sender, serve })
    recordHistory(sessionId, wantTitle, dir)
    return { sessionId, project: projName(), reattached: false }
  })
  ipcMain.handle('card-send', async (e, text) => {
    const sessionId = sessionByWc.get(e.sender.id); const si = sessionId && sessionInfo.get(sessionId)
    if (!si) throw new Error('session not ready')
    sentPrompt.set(sessionId, text); streamBuf.delete(sessionId)
    touchHistory(sessionId)
    return await oc.sendMessage(si.serve, sessionId, text)
  })
  // 卡坞：历史列表 + 打开
  ipcMain.handle('open-dock', () => openDock())
  ipcMain.on('get-history', (e) => { e.returnValue = history })
  ipcMain.handle('open-history', (_e, { sid, title }) => spawnCard(title, sid))
  ipcMain.handle('clear-history', () => { history = []; saveHistory(); return true })
  ipcMain.on('card-abort', (e) => {
    const sessionId = sessionByWc.get(e.sender.id); const si = sessionId && sessionInfo.get(sessionId)
    if (si) oc.abort(si.serve, sessionId)
  })
  ipcMain.on('permission-reply', (_e, { requestId, decision }) => {
    const sessionId = pendingPerm.get(requestId); pendingPerm.delete(requestId)
    const si = sessionId && sessionInfo.get(sessionId)
    if (si) oc.replyPermission(si.serve, sessionId, requestId, decision === 'always' ? 'always' : decision === 'once' ? 'once' : 'reject')
  })
  ipcMain.handle('open-loc', (e, { file, line }) => {
    const sessionId = sessionByWc.get(e.sender.id); const si = sessionId && sessionInfo.get(sessionId)
    const baseDir = (si && si.serve && si.serve.dir) || settings.projectDir || ''
    let full = file
    try { if (!path.isAbsolute(file) && baseDir) full = path.join(baseDir, file) } catch {}
    openInEditor(full, line)
  })

  createInput()
  buildTray()
  if (settings.projectDir) oc.ensureServe(settings.projectDir, handlers, log).catch((e) => log('prewarm failed: ' + e.message))

  if (!globalShortcut.register('Control+Shift+Space', toggleInput)) log('global shortcut register failed (maybe in use)')
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createInput() })
})

app.on('window-all-closed', () => {})
app.on('will-quit', () => { globalShortcut.unregisterAll(); oc.killAll() })
