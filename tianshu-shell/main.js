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
let settings = { theme: 'light', projectDir: '', serveBin: '', editorCmd: '' }
function loadSettings() { try { return { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } } catch { return { ...settings } } }
function saveSettings() { try { fs.writeFileSync(settingsFile, JSON.stringify(settings)) } catch {} }
const projName = () => settings.projectDir ? path.basename(settings.projectDir) : '未选目录'

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
  si.wc.send('card-stream', { kind: kind || 'text', text: full })
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

function spawnCard(title) {
  const id = ++cardSeq
  const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
  const win = new BrowserWindow(baseOpts({
    width: 480, height: 600, minWidth: 360, minHeight: 320, resizable: true,
    alwaysOnTop: false,   // 不强制置顶：点别的应用时卡片自然退后，不挡操作
    skipTaskbar: false,   // 进任务栏：最小化后可从任务栏/Alt+Tab 找回
    x: 160 + col * 56, y: 90 + row * 50 + col * 18,
  }))
  const wcId = win.webContents.id   // 先存下，closed 时 webContents 已销毁不能再访问
  win.loadFile(path.join(__dirname, 'ui', 'card.html'), { query: { title: title || '未命名任务', id: String(id) } })
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

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('天枢 Tianshu')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '唤起输入框', accelerator: 'Ctrl+Shift+Space', click: () => { if (!inputWin) createInput(); else { inputWin.show(); inputWin.focus() } } },
    { label: '切换深 / 浅主题', click: toggleTheme },
    { type: 'separator' },
    { label: '退出天枢', click: () => app.quit() },
  ]))
  tray.on('click', toggleInput)
}

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = loadSettings()

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
    if (!r.canceled && r.filePaths[0]) {
      settings.projectDir = r.filePaths[0]; saveSettings()
      oc.ensureServe(settings.projectDir, handlers, log).catch((e) => log('prewarm failed: ' + e.message)) // 预热
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('project-changed', projName())
    }
    return projName()
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

  // 卡片 ↔ 会话（绑定到当前项目的 serve）
  ipcMain.handle('card-init', async (e) => {
    const dir = settings.projectDir || ''
    const serve = await oc.ensureServe(dir, handlers, log)
    const sessionId = await oc.createSession(serve, '天枢对话')
    if (!sessionId) throw new Error('create session failed')
    sessionByWc.set(e.sender.id, sessionId)
    sessionInfo.set(sessionId, { wc: e.sender, serve })
    return { sessionId, project: projName() }
  })
  ipcMain.handle('card-send', async (e, text) => {
    const sessionId = sessionByWc.get(e.sender.id); const si = sessionId && sessionInfo.get(sessionId)
    if (!si) throw new Error('session not ready')
    sentPrompt.set(sessionId, text); streamBuf.delete(sessionId)
    return await oc.sendMessage(si.serve, sessionId, text)
  })
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
