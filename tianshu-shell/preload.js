const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tianshu', {
  // 窗口
  spawnCard: (title) => ipcRenderer.invoke('spawn-card', title),
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
  onProject: (cb) => ipcRenderer.on('project-changed', (_e, p) => cb(p)),
  // 对话 ↔ opencode 会话
  cardInit: () => ipcRenderer.invoke('card-init'),
  cardSend: (text) => ipcRenderer.invoke('card-send', text),
  cardAbort: () => ipcRenderer.send('card-abort'),
  onStream: (cb) => ipcRenderer.on('card-stream', (_e, p) => cb(p)),
  openLoc: (file, line) => ipcRenderer.invoke('open-loc', { file, line }),
  onPermission: (cb) => ipcRenderer.on('permission-request', (_e, p) => cb(p)),
  permissionReply: (requestId, decision) => ipcRenderer.send('permission-reply', { requestId, decision }),
})
