'use strict'
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage, shell, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const oc = require('./opencode')
const orch = require('./orchestrator')
const initWindow  = require('./src/window')
const initSession = require('./src/session')
const initOrch    = require('./src/orch')
const initTrigger = require('./src/trigger')
const initTodos   = require('./src/todos')

// 日志：打包后没有终端，console 看不到 → 同时写到 userData/BocomHermes.log
let logFile = null, logBytes = 0
function log(m) {
  try { console.log('[BocomHermes] ' + m) } catch {}
  if (!logFile) return
  try {
    if (logBytes > 3 * 1024 * 1024) { fs.writeFileSync(logFile, ''); logBytes = 0 }
    const line = '[' + new Date().toISOString() + '] ' + m + '\r\n'
    fs.appendFileSync(logFile, line); logBytes += Buffer.byteLength(line)
  } catch {}
}

// 共享可变状态（各模块通过同一对象引用读写）
const S = {
  settingsFile: null, historyFile: null, logFile: null,
  settings: { theme: 'light', projectDir: '', backendDir: '', serveBin: '', editorCmd: '', recentDirs: [] },
  history: [],
  cardSeq: 0,
  inputWin: null, settingsWin: null, dockWin: null, tray: null,
  sessionByWc: new Map(), sessionInfo: new Map(), pendingPerm: new Map(),
  streamBuf: new Map(), sentPrompt: new Map(), firstMsgCtx: new Map(), workflows: new Map(),
  handlers: null,   // 由 initSession 填入
}

// 关掉默认 File/Edit/View/Window/Help 菜单——它和"凭空玻璃"风格冲突，所有窗口统一不带菜单
const { Menu: __Menu } = require('electron')
__Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  S.settingsFile = path.join(app.getPath('userData'), 'settings.json')
  S.historyFile  = path.join(app.getPath('userData'), 'history.json')
  S.logFile = logFile = path.join(app.getPath('userData'), 'BocomHermes.log')
  try { logBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0; if (logBytes > 3 * 1024 * 1024) { fs.writeFileSync(logFile, ''); logBytes = 0 } } catch {}
  log('=== BocomHermes ' + app.getVersion() + ' start (' + (app.isPackaged ? 'packaged' : 'dev') + ') userData=' + app.getPath('userData') + ' ===')

  const deps = { ipcMain, app, BrowserWindow, WebContentsView, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }
  const { createOrb, createBrowser, createWorkspace, toggleOrbInput, buildTray, spawnEmailCard, recordHistory, touchHistory } = initWindow(S, deps)
  S.createOrb = createOrb   // 留给 window-all-closed 兜底拉起球

  initSession(S, { ipcMain, path, fs, shell, oc, log, recordHistory, touchHistory })
  initOrch(S, { ipcMain, oc, orch, log })
  initTodos(S, { ipcMain, app, path, fs, log })
  initTrigger(S, { path, fs, app, log, spawnEmailCard })

  // serve 启动命令：开发=opencode，打包 exe=bocomcode；可被环境变量或 settings.serveBin 覆盖
  const serveBin = process.env.BOCOMHERMES_SERVE_BIN || S.settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode')
  oc.setServeBin(serveBin)
  log('serve binary: ' + serveBin + (app.isPackaged ? ' (packaged)' : ' (dev)'))

  createOrb()
  buildTray()
  // 启动即预热引擎（即便没选项目也预热 home serve），等用户敲字时多半已就绪
  oc.ensureServe(S.settings.projectDir || '', S.handlers, log).catch((e) => log('prewarm failed: ' + e.message))

  if (!globalShortcut.register('Control+Shift+Space', toggleOrbInput)) log('global shortcut register failed (maybe in use)')
  globalShortcut.register('Control+Shift+B', () => createWorkspace())

  // Ctrl+Shift+V：把剪贴板内容带入输入框（"选中即问"快捷路径）
  globalShortcut.register('Control+Shift+V', () => {
    const text = clipboard.readText().trim()
    if (!text) return
    if (!S.orbInputWin || S.orbInputWin.isDestroyed()) toggleOrbInput()
    setTimeout(() => { if (S.orbInputWin && !S.orbInputWin.isDestroyed()) S.orbInputWin.webContents.send('fill-input', text) }, 80)
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createOrb() })
})

// 不要因为所有窗口关掉就自动退出 app —— 这是个常驻 agent。
// 进一步：如果真的没窗口了（比如球被误关），把球重新拉起来，避免"看起来退出了"。
app.on('before-quit', () => { app.isQuitting = true })
app.on('window-all-closed', () => {
  if (app.isQuitting) return
  if (BrowserWindow.getAllWindows().length === 0 && typeof S.createOrb === 'function') {
    try { S.createOrb() } catch {}
  }
})
app.on('will-quit', () => { globalShortcut.unregisterAll(); oc.killAll() })
