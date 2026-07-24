// 自测:控制台 2.0(ui/console.html + Vue 3 vendor)—— 裸 Electron 真加载,抓加载期 JS 异常/Vue 报错。
// 跑法:npm run console:test(IPC 处理器未注册属预期:页面应降级显示错误条,不许抛 Uncaught)
const { app, BrowserWindow } = require('electron')
const path = require('path')
const ROOT = path.join(__dirname, '..')
let bad = 0
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1180, height: 800, show: false, webPreferences: { preload: ROOT + '/preload.js', contextIsolation: true, nodeIntegration: false } })
  win.webContents.on('console-message', (_e, level, message, line) => {
    if (/ipcRenderer\.sendSync.*without listeners/.test(message)) return   // 裸跑预期:无主进程监听
    if (level >= 3 || /Uncaught|ReferenceError|TypeError|SyntaxError|\[Vue warn\]/.test(message)) { bad++; console.log('  ✗ [renderer]', String(message).slice(0, 300), '@line', line) }
  })
  win.loadFile(ROOT + '/ui/console.html')
  setTimeout(() => {
    console.log(bad ? '❌ 有失败' : '✅ 全部通过')
    app.exit(bad ? 1 : 0)
  }, 4500)
})
