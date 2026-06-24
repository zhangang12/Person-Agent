'use strict'
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage, shell, clipboard, session, net, Notification } = require('electron')
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

// ── 内嵌浏览器自定义启动参数 ────────────────────────────────────────────────
// settings.browserArgs(如 "--disable-web-security --ignore-certificate-errors")里的 Chromium 开关，
// 必须在 app ready 前 appendSwitch。跨域本身已由每个标签页的 webSecurity:false 在运行期解决(见 window.js newTab)，
// 这里负责把其余高级开关也透传给 Chromium。
// ⚠ 主动过滤 --user-data-dir：Electron 把它等同整个应用的 userData，挂上去会把设置/日志搬走 → 丢配置；
//   而且跨域不需要它(那是 Chrome 对默认 profile 的限制，Electron 没有)。
function applyBrowserSwitches() {
  let cfg = null
  try { cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) } catch { return }
  const raw = cfg && typeof cfg.browserArgs === 'string' ? cfg.browserArgs.trim() : ''
  if (!raw) return
  const toks = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m
  while ((m = re.exec(raw))) toks.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]))
  for (const t of toks) {
    const s = t.replace(/^--?/, '')
    const eq = s.indexOf('=')
    const key = (eq >= 0 ? s.slice(0, eq) : s).toLowerCase()
    if (!key) continue
    if (key === 'user-data-dir') { try { console.log('[BocomHermes] 已忽略 --user-data-dir(会搬走应用数据;跨域已由 webSecurity:false 解决)') } catch {} ; continue }
    try { eq >= 0 ? app.commandLine.appendSwitch(key, s.slice(eq + 1)) : app.commandLine.appendSwitch(key) } catch {}
  }
}
applyBrowserSwitches()

app.whenReady().then(() => {
  S.settingsFile = path.join(app.getPath('userData'), 'settings.json')
  S.historyFile  = path.join(app.getPath('userData'), 'history.json')
  S.logFile = logFile = path.join(app.getPath('userData'), 'BocomHermes.log')
  try { logBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0; if (logBytes > 3 * 1024 * 1024) { fs.writeFileSync(logFile, ''); logBytes = 0 } } catch {}
  log('=== BocomHermes ' + app.getVersion() + ' start (' + (app.isPackaged ? 'packaged' : 'dev') + ') userData=' + app.getPath('userData') + ' ===')

  // ── 内网三件套 ─────────────────────────────────────────────────────────────
  // 1) HTTPS 自签名证书:内网信贷系统常见,直接放行(开发工具 + 内网定位)。
  //    要严格,可改为只放行私网域名 / 弹窗 once 询问。
  app.on('certificate-error', (e, _webContents, url, error, _cert, callback) => {
    log('cert override: ' + url + ' (' + error + ')')
    e.preventDefault(); callback(true)
  })
  // 2) HTTP 认证(Basic/Digest/NTLM):
  //    NTLM/Negotiate → 让 Chromium 直接拿 Windows 当前登录凭据传(企业 SSO 常态);
  //    Basic/Digest → 弹一个简洁输入框,记不住,只在本次连接用。
  try {
    session.defaultSession.allowNTLMCredentialsForDomains('*')
    log('NTLM/Negotiate: pass current Windows creds to all domains')
  } catch (e) { log('allowNTLM fail: ' + e.message) }
  app.on('login', async (event, webContents, request, authInfo, callback) => {
    if (authInfo.scheme === 'negotiate' || authInfo.scheme === 'ntlm') return   // Chromium 自动用 Windows 凭据
    event.preventDefault()
    const host = (authInfo.host || request.url || '?') + (authInfo.realm ? ' · ' + authInfo.realm : '')
    const r = await dialog.showMessageBox({ type: 'question', title: 'HTTP 认证', message: '该网站需要登录:\n' + host, detail: '请在弹出的输入框中输入用户名 / 密码(用 ":" 隔开)。\n例: zhangsan:p@ss', buttons: ['取消', '输入'], defaultId: 1, cancelId: 0 })
    if (r.response !== 1) return callback()
    const pr = await dialog.showSaveDialog({ title: '用户名:密码(冒号分隔)', defaultPath: 'user:pass', buttonLabel: '确定', filters: [] })
    if (pr.canceled || !pr.filePath) return callback()
    const raw = path.basename(pr.filePath).replace(/\.[^.]+$/, '')
    const i = raw.indexOf(':'); if (i < 0) return callback()
    callback(raw.slice(0, i), raw.slice(i + 1))
  })
  // 3) 代理设置(下面的 initWindow 加载完 S.settings 后再应用)

  // 4) 下载:浏览器/工作台里触发的下载都让用户看见(toast→进度→完成可"在文件夹打开")
  //    走默认目录(用户的 Downloads),不弹"另存为"以免每次中断流程。如需选位置,后续在设置里加 toggle。
  session.defaultSession.on('will-download', (_e, item) => {
    const id = 'dl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const total = item.getTotalBytes() || 0
    const name = item.getFilename()
    const savePath = path.join(app.getPath('downloads'), name)
    item.setSavePath(savePath)
    const target = S.browser && S.browser.win && !S.browser.win.isDestroyed() ? S.browser.win.webContents : null
    const send = (kind, extra) => { if (target && !target.isDestroyed()) target.send('browser-download', { id, name, total, savePath, kind, ...extra }) }
    send('start')
    item.on('updated', (_x, state) => {
      if (state === 'progressing') send('progress', { received: item.getReceivedBytes(), paused: item.isPaused() })
    })
    item.once('done', (_x, state) => send(state === 'completed' ? 'done' : 'fail', { state }))
  })

  const deps = { ipcMain, app, BrowserWindow, WebContentsView, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }
  const { createOrb, createBrowser, createWorkspace, toggleOrbInput, buildTray, spawnEmailCard, recordHistory, touchHistory } = initWindow(S, deps)
  S.createOrb = createOrb   // 留给 window-all-closed 兜底拉起球

  initSession(S, { ipcMain, path, fs, shell, oc, log, recordHistory, touchHistory })
  initOrch(S, { ipcMain, oc, orch, log })
  initTodos(S, { ipcMain, app, path, fs, log })
  initTrigger(S, { path, fs, app, log, spawnEmailCard, Notification })

  // 代理:settings.proxy 在场即应用(支持 'http://host:port' 或 PAC 'pac+http://...')
  if (S.settings && S.settings.proxy) {
    try { session.defaultSession.setProxy({ proxyRules: S.settings.proxy }).then(() => log('proxy set: ' + S.settings.proxy)).catch((e) => log('setProxy err: ' + e.message)) }
    catch (e) { log('setProxy fail: ' + e.message) }
  }

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

// 常驻 agent: 关掉所有窗口不退 app; 真没窗口了就把球重新拉起来
app.on('before-quit', () => { app.isQuitting = true })
app.on('window-all-closed', () => {
  if (app.isQuitting) return
  if (BrowserWindow.getAllWindows().length === 0 && typeof S.createOrb === 'function') {
    try { S.createOrb() } catch (e) { log('recreate orb FAIL: ' + e.message) }
  }
})
app.on('will-quit', () => { globalShortcut.unregisterAll(); oc.killAll() })
// 兜底:任何未捕获错误都进日志,便于排查偶发崩溃
process.on('uncaughtException', (e) => { try { log('uncaughtException: ' + (e && e.stack || e)) } catch {} })
process.on('unhandledRejection', (r) => { try { log('unhandledRejection: ' + r) } catch {} })
