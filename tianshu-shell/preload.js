const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('BocomHermes', {
  // 窗口
  spawnCard: (title) => ipcRenderer.invoke('spawn-card', title),
  spawnFanout: (goal) => ipcRenderer.invoke('spawn-fanout', goal),
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
})
