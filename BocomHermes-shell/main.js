'use strict'
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage, shell, clipboard, session, net, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const oc = require('./opencode')
const initWindow  = require('./src/window')
const initSession = require('./src/session')
const initTrigger = require('./src/trigger')
const initTodos   = require('./src/todos')
const initAudit   = require('./src/audit')

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
  settingsWin: null, dockWin: null, tray: null,
  sessionByWc: new Map(), sessionInfo: new Map(), pendingPerm: new Map(), pendingQuestion: new Map(),
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
    // 同名不覆盖:技能连跑/批跑每次导出同名文件,以前直接写同一路径互相覆盖 —— 登记表里多条记录指向同一个被反复重写的文件。
    // 落盘用 名(1).ext 递增;100 次兜底后回退原路径(极端场景宁可覆盖也别下载失败)
    let savePath = path.join(app.getPath('downloads'), name)
    if (fs.existsSync(savePath)) {
      const ext = path.extname(name), stem = name.slice(0, name.length - ext.length)
      for (let n = 1; n < 100; n++) { const p2 = path.join(app.getPath('downloads'), stem + '(' + n + ')' + ext); if (!fs.existsSync(p2)) { savePath = p2; break } }
    }
    item.setSavePath(savePath)
    // 下载登记表:回放引擎据此「等下载落地并取回文件路径」——「下载后编排」技能的输入来源,与浏览器 UI 的进度提示解耦。
    // 滚动上限 40 条;at=发起时刻 + url=来源(回放按 at≥起点 ∧ origin∈访问过的站点 圈定本次产生的下载),state 收敛到 completed/failed。
    let srcUrl = ''; try { srcUrl = item.getURL() || '' } catch {}
    const rec = { id, name, savePath, url: srcUrl, bytes: total, at: Date.now(), state: 'progressing', doneAt: 0 }
    if (!Array.isArray(S.downloads)) S.downloads = []
    S.downloads.push(rec); if (S.downloads.length > 40) S.downloads.shift()
    const target = S.browser && S.browser.win && !S.browser.win.isDestroyed() ? S.browser.win.webContents : null
    const send = (kind, extra) => { if (target && !target.isDestroyed()) target.send('browser-download', { id, name, total, savePath, kind, ...extra }) }
    send('start')
    item.on('updated', (_x, state) => {
      if (state === 'progressing') { try { rec.bytes = item.getReceivedBytes() || rec.bytes } catch {} ; send('progress', { received: item.getReceivedBytes(), paused: item.isPaused() }) }
    })
    item.once('done', (_x, state) => {
      rec.state = state === 'completed' ? 'completed' : 'failed'; rec.doneAt = Date.now()
      if (state === 'completed') { try { rec.bytes = item.getReceivedBytes() || rec.bytes } catch {} }
      send(state === 'completed' ? 'done' : 'fail', { state })
    })
  })

  initAudit(S, { app, path, fs, ipcMain, log })   // 先于 initWindow:S.audit 供各埋点处调用
  const deps = { ipcMain, app, BrowserWindow, WebContentsView, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }
  const { createBrowser, createWorkspace, createSkillCenter, createMailCenter, createMainWindow, openMailView, buildTray, spawnEmailCard, snapAsk, recordHistory, touchHistory, replaceHistoryId } = initWindow(S, deps)
  S.snapAsk = snapAsk

  initSession(S, { ipcMain, path, fs, shell, oc, log, recordHistory, touchHistory, replaceHistoryId })
  const todosApi = initTodos(S, { ipcMain, app, path, fs, log })
  S.todosApi = todosApi   // window.js 的会议抽取在运行期经 S 调 addSuggestion(初始化顺序无环)
  initTrigger(S, { path, fs, app, log, spawnEmailCard, createMailCenter, Notification })
  require('./src/todo-reminder')(S, { log, Notification, BrowserWindow, todosApi, createMailCenter, openMailView })

  // 代理:settings.proxy 在场即应用(支持 'http://host:port' 或 PAC 'pac+http://...')
  if (S.settings && S.settings.proxy) {
    try { session.defaultSession.setProxy({ proxyRules: S.settings.proxy }).then(() => log('proxy set: ' + S.settings.proxy)).catch((e) => log('setProxy err: ' + e.message)) }
    catch (e) { log('setProxy fail: ' + e.message) }
  }

  // serve 启动命令：开发=opencode，打包 exe=bocomcode；可被环境变量或 settings.serveBin 覆盖
  const serveBin = process.env.BOCOMHERMES_SERVE_BIN || S.settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode')
  oc.setServeBin(serveBin)
  log('serve binary: ' + serveBin + (app.isPackaged ? ' (packaged)' : ' (dev)'))

  buildTray()
  createMainWindow()   // 桌面主窗口(shell.html) = 启动主界面(悬浮球/控制台 2.0 均已退役)
  // 启动即预热引擎（即便没选项目也预热 home serve），等用户敲字时多半已就绪
  oc.ensureServe(S.settings.projectDir || '', S.handlers, log).catch((e) => log('prewarm failed: ' + e.message))

  // 主窗口化:热键统一改道主窗口 —— 拉起/聚焦后 send('shell-view') 切到目标视图;
  // 窗口新建时 webContents 尚在加载,等 did-finish-load 再发,否则消息丢失
  function openMainView(view) {
    const win = createMainWindow()
    if (!win) return
    const send = () => { try { if (!win.isDestroyed()) win.webContents.send('shell-view', { view }) } catch (e) { log('shell-view send err: ' + e.message) } }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }
  // 快捷输入层(波4):拉起主窗口 + send('shell-quick-open') 由 shell 弹内置输入条(Enter 即开新会话);
  // payload.text 在场 = 预填文本(Ctrl+Shift+V 剪贴板带入)。同样等 did-finish-load 再发,防丢消息
  function openMainQuick(payload) {
    const win = createMainWindow()
    if (!win) return
    const send = () => { try { if (!win.isDestroyed()) win.webContents.send('shell-quick-open', payload || {}) } catch (e) { log('shell-quick-open send err: ' + e.message) } }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }
  if (!globalShortcut.register('Control+Shift+Space', () => openMainQuick())) log('global shortcut register failed (maybe in use)')
  globalShortcut.register('Control+Shift+B', () => openMainView('orch'))
  globalShortcut.register('Control+Shift+R', () => createSkillCenter())   // 🎬 录制与回放(技能中心在工作台,保持不变)
  globalShortcut.register('Control+Shift+M', () => openMainView('mail'))
  globalShortcut.register('Control+Shift+S', () => { try { snapAsk() } catch (e) { log('snapAsk shortcut err: ' + e.message) } })   // 截图提问

  // Ctrl+Shift+V:剪贴板内容预填进主窗口快捷输入层(波4 改道 quick-open;原 fill-input 直填会话卡
  // 输入框的路径不再发向 mainWin —— 全仓库已无其他 fill-input 发送方,shell 侧 onFillInput 处理保留兜底)
  globalShortcut.register('Control+Shift+V', () => {
    const text = clipboard.readText().trim()
    if (!text) return
    openMainQuick({ text })
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })   // mac 点 dock 图标:无窗时拉起主窗口(原是重建 orb)
})

// 平台默认窗口策略: mac 全关不退(dock 再点拉主窗口), 其余平台全关即退
app.on('before-quit', () => { app.isQuitting = true })
// 主窗口化:orb 兜底重建退役,恢复平台默认(mac 全关不退,其余平台退出)
app.on('window-all-closed', () => {
  if (app.isQuitting) return
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', () => { globalShortcut.unregisterAll(); oc.killAll(); try { S.brAgent && S.brAgent.dropAll('应用退出') } catch {} })   // Agent 浏览器会话收摊:别把会话留成僵尸(标签页随窗口走,但报告要落个终态)
// 兜底:任何未捕获错误都进日志,便于排查偶发崩溃
process.on('uncaughtException', (e) => { try { log('uncaughtException: ' + (e && e.stack || e)) } catch {} })
process.on('unhandledRejection', (r) => { try { log('unhandledRejection: ' + r) } catch {} })

// ★★崩溃留痕(2026-08-10:用户报"客户端会崩溃、自动关闭",而日志里【一个字都没有】)。
// 病灶不是崩溃本身,是【崩溃不留痕】:主进程这两个 handler 只兜 JS 异常,而渲染进程崩溃、
// GPU/工具子进程崩溃、窗口无响应,Electron 走的是 app 上的另外三个事件 —— 全仓一处都没监听。
// 于是一张卡的渲染端被系统 OOM 杀掉,壳层既不知道、也不记,用户只看到"卡没了 / 应用关了"。
// 这和今天 card-abort 那个坑是同一个形态:能把东西杀掉的路径必须自报姓名。
// 【为什么不在这里做恢复】先只观测:没有证据就做自动重建,等于拿一个没验证的假设去改行为
// (今天已经为此付过一次代价)。等日志说清是谁崩、为什么崩,再谈救。
// 内存快照:OOM 是"应用自己关了"最常见的死法,而事后什么都看不到 —— 崩的那一刻必须把量记下来。
// getAppMetrics 给的是【每个进程】的常驻内存,能直接指出是哪一类进程涨上去的(渲染/GPU/工具)。
function memLine() {
  try {
    const ms = (typeof app.getAppMetrics === 'function' ? app.getAppMetrics() : []) || []
    const top = ms.map((m) => ({ t: String((m.type || '?')), pid: m.pid, mb: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024) }))
      .sort((a, b) => b.mb - a.mb).slice(0, 5)
    const total = top.reduce((s, x) => s + x.mb, 0)
    return '进程数=' + ms.length + ' 前5大(MB):' + top.map((x) => x.t + '/' + x.pid + '=' + x.mb).join(' ') + ' 合计≈' + total
  } catch { return '(拿不到进程内存)' }
}
app.on('render-process-gone', (_e, wc, details) => {
  try {
    const d = details || {}
    // reason 的取值直接分诊:oom/out-of-memory=内存打爆;crashed=渲染端异常;killed=被系统或外部杀;
    // launch-failed=起不来;integrity-failure=完整性校验。内网那边看这一个词就能定方向。
    log('[crash] 渲染进程没了:reason=' + String(d.reason || '?') + ' exitCode=' + String(d.exitCode)
      + ' wc=' + (wc && !wc.isDestroyed() ? wc.id : '(已销毁)')
      + ' url=' + String((wc && !wc.isDestroyed() && wc.getURL && wc.getURL()) || '').slice(0, 160)
      + ' | ' + memLine())
  } catch {}
})
app.on('child-process-gone', (_e, details) => {
  try {
    const d = details || {}
    // type: GPU / Pepper Plugin / Utility / Zygote / Sandbox helper …;utility 崩溃常伴随网络请求失败
    log('[crash] 子进程没了:type=' + String(d.type || '?') + ' reason=' + String(d.reason || '?')
      + ' exitCode=' + String(d.exitCode) + ' name=' + String(d.name || ''))
  } catch {}
})
app.on('web-contents-created', (_e, wc) => {
  try {
    wc.on('unresponsive', () => { try { log('[crash] 窗口无响应(unresponsive) wc=' + wc.id + ' url=' + String((wc.getURL && wc.getURL()) || '').slice(0, 120)) } catch {} })
    wc.on('responsive', () => { try { log('[crash] 窗口恢复响应 wc=' + wc.id) } catch {} })
  } catch {}
})
// 退出也要留痕:分清"用户主动退出"和"最后一扇窗关了导致退出"—— 用户看到的都是"它自己关了"
app.on('before-quit', () => { try { log('[quit] before-quit(isQuitting=' + !!app.isQuitting + ',窗口数=' + BrowserWindow.getAllWindows().length + ') | ' + memLine()) } catch {} })

// ★★"上次是不是正常退出" —— 排"应用自己关了"最关键的一位信息,而且【只能在下一次启动时】拿到。
// 做法:启动写一个运行中标记,正常退出(will-quit)删掉。下次启动时标记还在 = 上次是被杀/崩掉的,
// 不是用户点的退出。没有这一位,日志里"最后一行普通日志 + 下一行是新的启动"和正常退出长得一模一样,
// 只能靠猜(内网那边我不在场,更只能靠它)。标记里带上时间与内存,好对上系统日志。
const ALIVE_MARK = path.join(app.getPath('userData'), '.running')
try {
  if (fs.existsSync(ALIVE_MARK)) {
    let prev = ''
    try { prev = fs.readFileSync(ALIVE_MARK, 'utf8').slice(0, 300) } catch {}
    log('[crash] ★上次【没有正常退出】(运行标记还在):' + prev + ' —— 崩溃/被杀,不是用户点的退出')
  }
} catch {}
const markAlive = () => { try { fs.writeFileSync(ALIVE_MARK, '起于 ' + new Date().toISOString() + ' pid=' + process.pid) } catch {} }
markAlive()
app.on('will-quit', () => { try { fs.unlinkSync(ALIVE_MARK) } catch {} })   // 正常退出才删 —— 被杀就留着,下次启动自报
