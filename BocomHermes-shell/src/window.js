'use strict'
const USE_ACRYLIC = false
const { clipboard } = require('electron')
const email = require('./email')

module.exports = function initWindow(S, { ipcMain, app, BrowserWindow, WebContentsView, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }) {
  // 额外窗口引用
  S.todosWin = null
  S.orbInputWin = null
  S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
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

  function spawnCard(title, sid, msg, disp) {
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

  function brWireTab(tab) {
    const wc = tab.view.webContents
    const b = S.browser
    const onNav = () => {
      tab.title = wc.getTitle() || tab.title
      tab.url = wc.getURL()
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
      if (isMainFrame && !isInPlace && !tab.preserveNet) {
        tab.net = []; tab.netById = new Map()
        if (tab.id === b.activeId) sendNetSnapshot(tab)
      }
    })

    // 控制台（全等级捕获，存在 tab 上，活动标签实时推送）
    wc.on('console-message', (...args) => {
      let level, message, line, source
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const d = args[0]; level = brNormLevel(d.level); message = d.message; line = d.lineNumber; source = d.sourceId
      } else {
        level = brNormLevel(args[1]); message = args[2]; line = args[3]; source = args[4]
      }
      const entry = { level, message: String(message || '').slice(0, 4000), line, source: source || '', ts: Date.now() }
      tab.console.push(entry)
      if (tab.console.length > 500) tab.console.shift()
      if (level === 3) tab.errN++; else if (level === 2) tab.warnN++
      if (tab.id === b.activeId && b.win && !b.win.isDestroyed()) {
        b.win.webContents.send('browser-console-add', entry)
        b.win.webContents.send('browser-badge', { errN: tab.errN, warnN: tab.warnN })
      }
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
    ])
  }
  function detachDbg(tab) { try { tab.view.webContents.debugger.detach() } catch {} tab.dbg = false }

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
    function click(e) { e.preventDefault(); e.stopPropagation(); const el = cur || D.elementFromPoint(e.clientX, e.clientY); const out = el ? info(el) : null; cleanup(); resolve(out); }
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
      let lenses = (v.layers || []).filter(k => DBG_LENS[k])
      for (const k of ['frontend', 'contract', 'backend']) { if (lenses.length >= 2) break; if (!lenses.includes(k)) lenses.push(k) }
      lenses = lenses.slice(0, 3)
      lenses.forEach(k => dbgNote(cardWc, `🤖 假设·${DBG_TAG[k]} 调查中…`, 'muted'))
      const findings = await Promise.all(lenses.map(async (k) => {
        let sid
        try {
          sid = await oc.createSession(serve, '调查:' + k)
          S.sessionInfo.set(sid, { wc: cardWc, serve })   // 只读工具自动放行；写权限请求回到本卡
          const out = await oc.sendMessage(serve, sid, DBG_LENS[k] + '\n\n## 复现上下文\n' + bundlePrompt + '\n\n只聚焦你这个假设，简洁给出证据与判断，不要修改任何文件。')
          dbgNote(cardWc, `✓ 假设·${DBG_TAG[k]} 完成`, 'muted')
          return { k, out }
        } catch (e) { dbgNote(cardWc, `✗ 假设·${DBG_TAG[k]} 失败：${e.message}`, 'muted'); return { k, out: '(调查失败：' + e.message + ')' } }
        finally { if (sid) { S.sessionInfo.delete(sid); S.streamBuf.delete(sid) } }
      }))
      const merged = findings.map(f => `### 假设·${DBG_TAG[f.k]}\n${f.out}`).join('\n\n')
      inj(`下面是 ${findings.length} 路 agent 对同一问题各持一个假设做的并行调查。请交叉验证、互相反驳，给出最可能的【唯一根因】与【具体修复方案】（能给 \`\`\`diff 就给，并指明文件:行）；证据不足的假设请明确否定。\n\n## 原始复现上下文\n${bundlePrompt}\n\n## 各路调查结论\n${merged}`)
    } catch (e) {
      log('runDebugFlow err: ' + e.message)
      dbgNote(cardWc, '⚠ 分析流程出错：' + e.message + '（回退为单 agent）', 'info')
      inj(bundlePrompt)
    }
  }

  async function brAnalyze() {
    const tab = brActive(); if (!tab) return
    const wc = tab.view.webContents
    let dom = { title: '', desc: '', html: '' }
    try {
      dom = await wc.executeJavaScript(`(()=>{
        const h=document.documentElement.outerHTML;
        const d=document.querySelector('meta[name="description"]');
        return { title:document.title, desc:d?d.content:'', html: h.length>9000 ? h.slice(0,9000)+'\\n<!-- …(已截断) -->' : h };
      })()`, true)
    } catch {}
    const errs = tab.console.filter(c => c.level >= 2)
    const errText = errs.length
      ? errs.slice(-30).map(c => (c.level === 3 ? '✗ ' : '⚠ ') + c.message + (c.source ? `  (${String(c.source).split('/').pop()}:${c.line || ''})` : '')).join('\n')
      : '（无 warning / error）'
    // 网络异常（失败 / 4xx / 5xx）——附请求体与响应体，便于关联到后端代码
    const bad = tab.net.filter(r => r.state === 'failed' || (r.status && r.status >= 400))
    let netText = '（无失败 / 4xx / 5xx 请求）'
    if (bad.length) {
      const lines = []
      for (const r of bad.slice(-8)) {
        let body = ''
        try { const d = await brNetBody(r.id); if (d && d.body && !d.base64) body = String(d.body).slice(0, 1200) } catch {}
        const st = r.state === 'failed' ? ('失败 ' + (r.failText || '')) : (r.status + ' ' + (r.statusText || ''))
        lines.push(`- [${r.method}] ${st}  ${r.url}`
          + (r.postData ? `\n    请求体：${String(r.postData).slice(0, 600)}` : '')
          + (body ? `\n    响应体：${body}` : ''))
      }
      netText = lines.join('\n')
    }
    const prompt =
      `我正在用内嵌浏览器复现一个问题，请你作为资深全栈工程师帮我定位根因并给出修复方案。\n\n` +
      `页面地址：${tab.url || '(空白页)'}\n页面标题：${dom.title || tab.title}\n` +
      (dom.desc ? `页面描述：${dom.desc}\n` : '') +
      `\n## 控制台报错（${errs.length} 条）\n${errText}\n\n` +
      `## 网络异常请求（${bad.length} 条失败/4xx/5xx）\n${netText}\n\n` +
      `## 页面 DOM 结构（截断）\n\`\`\`html\n${dom.html || '(无法获取)'}\n\`\`\`\n\n` +
      `请按以下步骤分析：\n` +
      `1. 先判断问题主要在前端、后端，还是接口契约层面\n` +
      `2. 结合控制台报错 + 失败请求的状态码/响应体，定位最可能的根因\n` +
      `3. 给出具体修复建议（指明涉及的源码文件/函数方向，能给 diff 更好）\n` +
      `4. 若是常见坑（CORS、空指针、异步时序、CSS 布局、4xx 参数错误、5xx 后端异常）请点明\n` +
      `5. 当前项目目录就是相关工程时，直接用工具读源码定位到文件给出修法`
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
        const strategy = (layers.length >= 2 || difficulty >= 4) ? 'multi' : 'single'
        const summary = `URL：${tab.url || '(空白页)'}\n控制台错误/警告：${errs.length} 条${hasJsErr ? '（含 JS 错误）' : ''}\n网络异常：${bad.length} 条${be ? '（含 5xx/失败）' : ''}${ct ? '（含 4xx/CORS）' : ''}\n疑似层面：${layers.join('、') || '未定'}`
        runDebugFlow({ cardWc: b.cardView.webContents, serve: cardSi.serve, bundlePrompt: prompt, disp, heur: { layers, difficulty, strategy }, summary })   // 后台异步，不阻塞按钮
      } else {
        b.cardView.webContents.send('card-inject', { text: prompt, disp })   // 会话还没就绪 → 退化为直接注入
      }
    } else {
      spawnCard('前端调试分析', null, prompt, disp)                          // 独立浏览器：另开一张分析卡
    }
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
      backgroundColor: '#0d0e1a',
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    })
    b.win = win; b.tabs = []; b.activeId = null; b.consoleH = 0
    win.loadFile(path.join(__dirname, '..', 'ui', 'browser.html'))
    win.on('resize', brLayout)
    win.on('closed', () => {
      for (const t of b.tabs) { try { t.view.webContents.destroy() } catch {} }
      S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
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
      title: 'BocomHermes · 调试工作台', backgroundColor: '#0b0c16',
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
      for (const t of b.tabs) { try { t.view.webContents.destroy() } catch {} }
      const s = S.sessionByWc.get(b.cardWcId)   // 同 spawnCard 的会话清理逻辑
      if (s) { const si = S.sessionInfo.get(s); if (si) oc.abort(si.serve, s); S.sessionInfo.delete(s); S.streamBuf.delete(s); S.sentPrompt.delete(s); S.firstMsgCtx.delete(s) }
      S.sessionByWc.delete(b.cardWcId)
      try { cardView.webContents.destroy() } catch {}
      S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
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
  // 复制到剪贴板（供网络面板「复制 URL / 复制 cURL」、拾取「复制选择器」）
  ipcMain.handle('browser-copy', (_e, text) => { clipboard.writeText(String(text || '')); return true })

  ipcMain.handle('open-dock', () => openDock())
  ipcMain.on('get-history', (e) => { e.returnValue = S.history })
  ipcMain.handle('open-history', (_e, { sid, title }) => spawnCard(title, sid))
  ipcMain.handle('clear-history', () => { S.history = []; saveHistory(); return true })

  return { createOrb, createBrowser, createWorkspace, spawnCard, spawnFanout, spawnWorkflow, spawnEmailCard, toggleInput, toggleOrbInput, buildTray, openDock, openTodos, openSettings, applyProject, projName, recordHistory, touchHistory }
}
