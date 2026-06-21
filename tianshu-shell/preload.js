const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('BocomHermes', {
  // 窗口
  spawnCard: (title) => ipcRenderer.invoke('spawn-card', title),
  spawnFanout: (goal) => ipcRenderer.invoke('spawn-fanout', goal),
  spawnFanoutRoles: (goal, roles) => ipcRenderer.invoke('spawn-fanout-roles', { goal, roles }),
  getFanoutRoles: () => ipcRenderer.invoke('get-fanout-roles'),
  closeSelf: () => ipcRenderer.send('close-self'),
  hideSelf: () => ipcRenderer.send('hide-self'),
  minimizeSelf: () => ipcRenderer.send('minimize-self'),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize'),
  // 主题
  getTheme: () => ipcRenderer.sendSync('get-theme'),
  setTheme: (t) => ipcRenderer.send('set-theme', t),
  onTheme: (cb) => ipcRenderer.on('theme-changed', (_e, t) => cb(t)),
  // 项目目录
  getProject: () => ipcRenderer.sendSync('get-project'),
  pickProject: () => ipcRenderer.invoke('pick-project'),
  setProjectDir: (dir) => ipcRenderer.invoke('set-project-dir', dir),
  onProject: (cb) => ipcRenderer.on('project-changed', (_e, p) => cb(p)),
  // 设置面板
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getSettings: () => ipcRenderer.sendSync('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  // 卡坞 / 会话历史
  openDock: () => ipcRenderer.invoke('open-dock'),
  getHistory: () => ipcRenderer.sendSync('get-history'),
  openHistory: (sid, title) => ipcRenderer.invoke('open-history', { sid, title }),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  // 工作流（动态编排）
  spawnWorkflow: (goal) => ipcRenderer.invoke('spawn-workflow', goal),
  runWorkflow: (goal) => ipcRenderer.invoke('run-workflow', goal),
  abortWorkflow: () => ipcRenderer.send('abort-workflow'),
  wfApprove: (reqId, decision, auto) => ipcRenderer.send('wf-approve', { reqId, decision, auto }),
  onWorkflowEvent: (cb) => ipcRenderer.on('wf-event', (_e, p) => cb(p)),
  // 对话 ↔ opencode 会话
  cardInit: (opts) => ipcRenderer.invoke('card-init', opts || {}),
  cardSend: (text) => ipcRenderer.invoke('card-send', text),
  cardAbort: () => ipcRenderer.send('card-abort'),
  onStream: (cb) => ipcRenderer.on('card-stream', (_e, p) => cb(p)),
  openLoc: (file, line) => ipcRenderer.invoke('open-loc', { file, line }),
  applyDiff: (diffText) => ipcRenderer.invoke('apply-diff', diffText),
  onPermission: (cb) => ipcRenderer.on('permission-request', (_e, p) => cb(p)),
  permissionReply: (requestId, decision) => ipcRenderer.send('permission-reply', { requestId, decision }),
  // 任务状态上报（busy 切换时通知主进程，用于托盘徽标 + 完成提醒）
  reportBusy: (busy) => ipcRenderer.send('card-busy', busy),
  // 个人记忆库
  memoryRead: () => ipcRenderer.invoke('memory-read'),
  memoryWrite: (text) => ipcRenderer.invoke('memory-write', text),
  // 剪贴板
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  onFillInput: (cb) => ipcRenderer.on('fill-input', (_e, text) => cb(text)),
  // 待办
  todoList: () => ipcRenderer.invoke('todo-list'),
  todoAdd: (item) => ipcRenderer.invoke('todo-add', item),
  todoToggle: (id) => ipcRenderer.invoke('todo-toggle', id),
  todoDelete: (id) => ipcRenderer.invoke('todo-delete', id),
  todoClearDone: () => ipcRenderer.invoke('todo-clear-done'),
  notifyTodosUpdated: () => ipcRenderer.send('todos-updated'),
  onTodosUpdated: (cb) => ipcRenderer.on('todos-updated', () => cb()),
  // 邮件摘要
  triggerEmailSummary: () => ipcRenderer.invoke('trigger-email-summary'),
  emailTest: () => ipcRenderer.invoke('email-test'),
  openTodos: () => ipcRenderer.invoke('open-todos'),
  // 内嵌浏览器
  openBrowser: (url) => ipcRenderer.invoke('open-browser', url),
  browserNavigate:      (url) => ipcRenderer.invoke('browser-navigate', url),
  browserBack:          ()    => ipcRenderer.send('browser-back'),
  browserForward:       ()    => ipcRenderer.send('browser-forward'),
  browserReload:        ()    => ipcRenderer.send('browser-reload'),
  browserDevTools:      ()    => ipcRenderer.send('browser-devtools'),
  browserConsoleResize: (h)   => ipcRenderer.send('browser-console-resize', h),
  onBrowserNav:         (cb)  => ipcRenderer.on('browser-nav',     (_e, p) => cb(p)),
  onBrowserConsole:     (cb)  => ipcRenderer.on('browser-console', (_e, p) => cb(p)),
  // orb 窗口控制
  setOrbMousePassthrough: (pass) => ipcRenderer.send('orb-passthrough', pass),
  moveOrbBy: (dx, dy) => ipcRenderer.send('orb-move', { dx, dy }),
  snapOrbToCorner: () => ipcRenderer.send('orb-snap'),
  toggleOrbInput: (mode) => ipcRenderer.invoke('toggle-orb-input', mode),
  closeOrbInput: () => ipcRenderer.invoke('close-orb-input'),
  onOrbState: (cb) => ipcRenderer.on('orb-state', (_e, state) => cb(state)),
})
