const { app, BrowserWindow, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { exec } = require('child_process')
const oc = require('./opencode')
const orch = require('./orchestrator')

const USE_ACRYLIC = false
let inputWin = null
let cardSeq = 0
let tray = null

// 日志：打包后没有终端，console 看不到 → 同时写到 userData/tianshu.log（含 serve 自身输出）
let logFile = null
let logBytes = 0
function log(m) {
  try { console.log('[tianshu] ' + m) } catch {}
  if (!logFile) return
  try {
    if (logBytes > 3 * 1024 * 1024) { fs.writeFileSync(logFile, ''); logBytes = 0 }   // 防无限增长
    const line = '[' + new Date().toISOString() + '] ' + m + '\r\n'
    fs.appendFileSync(logFile, line); logBytes += Buffer.byteLength(line)
  } catch {}
}

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
const workflows = new Map()     // 工作流卡 wc.id -> { ac(AbortController), serve, sessions:Set }

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

function spawnCard(title, sid, msg) {
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
  if (msg) query.msg = msg          // 带 msg = 发送内容不同于标题（fan-out 专用）
  win.loadFile(path.join(__dirname, 'ui', 'card.html'), { query })
  win.on('closed', () => {
    const s = sessionByWc.get(wcId)
    if (s) { const si = sessionInfo.get(s); if (si) oc.abort(si.serve, s); sessionInfo.delete(s); streamBuf.delete(s); sentPrompt.delete(s) }
    sessionByWc.delete(wcId)
  })
  return id
}

// Fan-out：同一目标以多视角并行开卡
function spawnFanout(goal) {
  const views = [
    ['安全·风险', '请从安全漏洞、边界处理、异常情况、权限校验等角度深度审视以下内容，逐条列出问题（必改/建议/可忽略）并给出修法：\n\n' + goal],
    ['性能·质量', '请从性能瓶颈、代码质量、可读性、可维护性等角度深度审视以下内容，逐条列出改进点（必改/建议/可忽略）：\n\n' + goal],
    ['业务·逻辑', '请从业务逻辑正确性、需求覆盖度、边界场景、数据一致性等角度深度审视以下内容，逐条列出问题（必改/建议/可忽略）：\n\n' + goal],
  ]
  const shortGoal = goal.length > 28 ? goal.slice(0, 27) + '…' : goal
  views.forEach(([label, msg]) => spawnCard(label + ' · ' + shortGoal, null, msg))
  return views.length
}

// 工作流卡：跑动态编排，实时展示任务图
function spawnWorkflow(goal) {
  const id = ++cardSeq
  const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
  const win = new BrowserWindow(baseOpts({
    width: 560, height: 680, minWidth: 420, minHeight: 380, resizable: true,
    alwaysOnTop: false, skipTaskbar: false,
    x: 180 + col * 56, y: 80 + row * 50 + col * 18,
  }))
  const wcId = win.webContents.id
  win.loadFile(path.join(__dirname, 'ui', 'workflow.html'), { query: { goal: goal || '未命名工作流', id: String(id) } })
  win.on('closed', () => {
    const w = workflows.get(wcId)
    if (w) { try { w.ac.abort() } catch {}; for (const s of w.sessions) { try { oc.abort(w.serve, s) } catch {}; sessionInfo.delete(s) }; workflows.delete(wcId) }
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

// ===== Unified diff 解析 + 直接写文件 =====
// 解析 unified diff → [{path, hunks:[{oldStart,oldCount,lines[]}]}]
function parseDiff(text) {
  const files = [], lines = text.split(/\r?\n/)
  let file = null, hunk = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (file && file.path) files.push(file)
      file = { path: '', hunks: [] }; hunk = null
    } else if (line.startsWith('+++ ') && !line.includes('\t/dev/null')) {
      const m = line.match(/^\+\+\+\s+(?:[ab]\/)?(.+?)(?:\t.*)?$/)
      if (m) { if (!file) file = { path: '', hunks: [] }; file.path = m[1].trim() }
    } else if (line.startsWith('@@ ') && file) {
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (m) { hunk = { oldStart: parseInt(m[1]), oldCount: m[2] !== undefined ? parseInt(m[2]) : 1, lines: [] }; file.hunks.push(hunk) }
    } else if (hunk) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) hunk.lines.push(line)
      else if (!line.startsWith('\\')) hunk = null  // "\ No newline" 忽略，其余结束当前 hunk
    }
  }
  if (file && file.path) files.push(file)
  return files.filter(f => f.path && !f.path.includes('/dev/null') && f.hunks.length)
}

// 将 hunks 应用到文件行数组（带 offset 跟踪，支持多 hunk）
function applyHunksToLines(lines, hunks) {
  let result = [...lines], offset = 0
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1 + offset   // 0-indexed
    const newLines = []
    for (const ln of hunk.lines) {
      if (ln.startsWith('+')) newLines.push(ln.slice(1))
      else if (ln.startsWith(' ')) newLines.push(ln.slice(1))
      // '-' 行跳过（删除）
    }
    result = [...result.slice(0, start), ...newLines, ...result.slice(start + hunk.oldCount)]
    offset += newLines.length - hunk.oldCount
  }
  return result
}

// 把一段 diff text 应用到磁盘；返回 [{file, ok, error?}]
function applyDiffToDisk(baseDir, diffText) {
  const parsed = parseDiff(diffText)
  if (!parsed.length) return [{ file: '(无法解析 diff，请确认格式为 unified diff 含 +++ 文件头)', ok: false, error: '未解析到文件' }]
  return parsed.map(({ path: relPath, hunks }) => {
    let fullPath = relPath
    try {
      if (!require('path').isAbsolute(relPath) && baseDir) fullPath = require('path').join(baseDir, relPath)
      const eol = '\n'
      let lines = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n').split('\n') : []
      // 末尾空行去掉再处理，避免与 diff 行数不匹配
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      lines = applyHunksToLines(lines, hunks)
      fs.writeFileSync(fullPath, lines.join(eol) + eol, 'utf8')
      log('apply-diff ok: ' + fullPath)
      return { file: relPath, ok: true }
    } catch (e) { log('apply-diff err ' + fullPath + ': ' + e.message); return { file: relPath, ok: false, error: e.message } }
  })
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
  tray.setToolTip('个人桌面智能体')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '唤起输入框', accelerator: 'Ctrl+Shift+Space', click: () => { if (!inputWin) createInput(); else { inputWin.show(); inputWin.focus() } } },
    { label: '卡坞 · 历史对话', click: openDock },
    { label: '切换深 / 浅主题', click: toggleTheme },
    { label: '设置…', click: openSettings },
    { label: '打开日志', click: () => { if (logFile) shell.openPath(logFile).catch(() => {}) } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', toggleInput)
}

// 右键菜单：选中文字→复制；输入框→剪切/复制/粘贴/全选。覆盖所有窗口。
function attachContextMenu(wc) {
  wc.on('context-menu', (_e, p) => {
    let tmpl = null
    if (p.isEditable) tmpl = [{ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { type: 'separator' }, { role: 'selectAll', label: '全选' }]
    else if (p.selectionText && p.selectionText.trim()) tmpl = [{ role: 'copy', label: '复制' }, { type: 'separator' }, { role: 'selectAll', label: '全选' }]
    if (tmpl) Menu.buildFromTemplate(tmpl).popup({ window: BrowserWindow.fromWebContents(wc) })
  })
}
app.on('web-contents-created', (_e, wc) => attachContextMenu(wc))

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = loadSettings()
  historyFile = path.join(app.getPath('userData'), 'history.json')
  loadHistory()
  logFile = path.join(app.getPath('userData'), 'tianshu.log')
  try { logBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0; if (logBytes > 3 * 1024 * 1024) { fs.writeFileSync(logFile, ''); logBytes = 0 } } catch {}
  log('=== tianshu ' + app.getVersion() + ' start (' + (app.isPackaged ? 'packaged' : 'dev') + ') userData=' + app.getPath('userData') + ' ===')

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

  // 工作流（动态编排）
  ipcMain.handle('spawn-workflow', (_e, goal) => spawnWorkflow(goal))
  ipcMain.on('abort-workflow', (e) => { const w = workflows.get(e.sender.id); if (w) { try { w.ac.abort() } catch {} } })
  ipcMain.on('wf-approve', (e, { reqId, decision, auto }) => {
    const w = workflows.get(e.sender.id); if (!w) return
    if (auto) w.auto = true
    const r = w.approvals.get(reqId); if (r) { w.approvals.delete(reqId); r(decision) }
  })
  ipcMain.handle('run-workflow', async (e, goal) => {
    const wc = e.sender
    const dir = settings.projectDir || ''
    const serve = await oc.ensureServe(dir, handlers, log)
    const ac = new AbortController()
    const entry = { ac, serve, sessions: new Set(), approvals: new Map(), auto: false }
    workflows.set(wc.id, entry)
    const send = (type, payload) => { if (!wc.isDestroyed()) wc.send('wf-event', { type, ...payload }) }
    // 人审检查点：每批计划先发给卡片等批准（卡片可一键切"自动"）
    const onBeforeBatch = (round, tasks) => new Promise((resolve) => {
      if (entry.auto) return resolve({ tasks })
      const reqId = 'ap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
      entry.approvals.set(reqId, (decision) => resolve(decision === 'abort' ? { abort: true } : { tasks }))
      send('plan-approve', { reqId, round, count: tasks.length, tasks: tasks.map((t) => ({ id: t.id, role: t.role, goal: t.goal, deps: t.deps })) })
    })
    // 每个子任务 = 一个 opencode 会话；登记到 sessionInfo 让其权限/事件路由到这张工作流卡
    const run = async (prompt, meta) => {
      const sid = await oc.createSession(serve, '编排:' + (meta && meta.kind || 'task') + (meta && meta.id ? ':' + meta.id : ''))
      if (!sid) throw new Error('createSession 失败')
      sessionInfo.set(sid, { wc, serve }); entry.sessions.add(sid)
      try { return await oc.sendMessage(serve, sid, prompt) }
      finally { sessionInfo.delete(sid); entry.sessions.delete(sid); streamBuf.delete(sid) }
    }
    try {
      const res = await orch.orchestrate(goal, {
        run, signal: ac.signal, maxConcurrency: 2, maxRounds: 4, maxTasks: 16, maxBatch: 5, taskTimeoutMs: 240000, onBeforeBatch,
        onPlan: (round, plan) => send('plan', { round, done: plan.done, tasks: plan.tasks.map((t) => ({ id: t.id, role: t.role, goal: t.goal, deps: t.deps })) }),
        onTaskStart: (t) => send('task', { id: t.id, status: 'running' }),
        onTaskDone: (t, out, st) => send('task', { id: t.id, status: 'ok', chars: (out || '').length }),
        onTaskError: (t, err, st) => send('task', { id: t.id, status: st || 'error', error: String(err && err.message || err) }),
      })
      send('final', { final: res.final, stopped: res.stopped, done: res.done, rounds: res.rounds, elapsedMs: res.elapsedMs, unmet: res.unmet })
      return { ok: true }
    } catch (err) {
      send('error', { error: String(err && err.message || err) })
      return { ok: false }
    } finally {
      for (const s of entry.sessions) sessionInfo.delete(s)
      workflows.delete(wc.id)
    }
  })

  // 开卡 / 窗口
  ipcMain.handle('spawn-card', (_e, title) => spawnCard(title))
  ipcMain.handle('spawn-fanout', (_e, goal) => spawnFanout(goal))
  ipcMain.on('close-self', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('hide-self', (e) => BrowserWindow.fromWebContents(e.sender)?.hide())
  ipcMain.on('minimize-self', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('toggle-pin', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    const v = !w.isAlwaysOnTop(); w.setAlwaysOnTop(v); return v
  })
  // 放大/还原：透明无边框窗口的 isMaximized() 不可靠，改为自管 bounds，确保能还原
  ipcMain.handle('toggle-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    if (w._restoreBounds || w.isMaximized()) {          // 已放大 → 还原到放大前
      const b = w._restoreBounds; w._restoreBounds = null
      if (w.isMaximized()) w.unmaximize()
      if (b) w.setBounds(b)
      return false
    }
    w._restoreBounds = w.getBounds()                    // 记下当前 → 铺满工作区
    const wa = screen.getDisplayMatching(w.getBounds()).workArea
    w.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height })
    return true
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
    try { return await oc.sendMessage(si.serve, sessionId, text) }
    catch (err) {
      const m = String((err && err.message) || err)
      if (/ECONNREFUSED|ECONNRESET|socket hang up|ENOTFOUND|EPIPE|fetch failed/i.test(m))
        throw new Error('引擎连接中断（serve 可能已退出）。关掉这张卡重开即可（已自动准备重启 serve）。')
      throw err
    }
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

  // 直接将 unified diff 写入文件（不经过 AI 二次执行）
  ipcMain.handle('apply-diff', (e, diffText) => {
    const sessionId = sessionByWc.get(e.sender.id); const si = sessionId && sessionInfo.get(sessionId)
    const baseDir = (si && si.serve && si.serve.dir) || settings.projectDir || ''
    return applyDiffToDisk(baseDir, String(diffText || ''))
  })

  createInput()
  buildTray()
  // 启动即预热引擎（即便没选项目也预热 home serve），等用户敲字时多半已就绪
  oc.ensureServe(settings.projectDir || '', handlers, log).catch((e) => log('prewarm failed: ' + e.message))

  if (!globalShortcut.register('Control+Shift+Space', toggleInput)) log('global shortcut register failed (maybe in use)')
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createInput() })
})

app.on('window-all-closed', () => {})
app.on('will-quit', () => { globalShortcut.unregisterAll(); oc.killAll() })
