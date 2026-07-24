// 自测:控制台 2.0(ui/console.html + Vue 3 vendor)—— 裸 Electron 真加载,抓加载期 JS 异常/Vue 报错/DOM 渲染断言。
// 跑法:npm run console:test。注意:sendSync 频道必须打桩 —— 裸 Electron 没注册监听器时 sendSync 会
// 永久阻塞渲染主线程(0% CPU 干等,executeJavaScript/CDP 全部不返,实测),页面像"挂了"其实是 harness 缺桩。
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const ROOT = path.join(__dirname, '..')
let bad = 0
// ── IPC 桩:sendSync 给同步返回值;invoke 给最小回包(card-init 抛错 → 页面走降级错误条路径)──
ipcMain.on('get-theme', (e) => { e.returnValue = 'dark' })
ipcMain.on('get-history', (e) => { e.returnValue = [] })
ipcMain.on('get-settings', (e) => { e.returnValue = {} })
ipcMain.on('get-project', (e) => { e.returnValue = 'smoke' })
ipcMain.handle('card-init', async () => { throw new Error('smoke: 无引擎(预期降级)') })
ipcMain.handle('list-models', async () => [])
ipcMain.handle('card-usage', async () => null)
app.whenReady().then(() => {
  setTimeout(() => { console.log('❌ 冒烟超时(进程级看门狗)'); app.exit(2) }, 12000)   // 硬兜底:隐藏窗渲染节流曾把 executeJavaScript 吊死
  const win = new BrowserWindow({ width: 1180, height: 800, show: true, webPreferences: { preload: ROOT + '/preload.js', contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false } })   // show:true:隐藏窗 executeJavaScript 实测不返回,测试闪一下窗无妨
  win.webContents.on('console-message', (_e, level, message, line) => {
    if (/ipcRenderer\.sendSync.*without listeners/.test(message)) return   // 裸跑预期:无主进程监听
    if (level >= 3 || /Uncaught|ReferenceError|TypeError|SyntaxError|\[Vue warn\]/.test(message)) { bad++; console.log('  ✗ [renderer]', String(message).slice(0, 300), '@line', line) }
  })
  win.loadFile(ROOT + '/ui/console.html')
  setTimeout(async () => {
    // 渲染级断言(纯 JS 语法查不出的雷:CSS 泄漏成文本、Vue 没挂上、视图缺失)
    try {
      const r = await Promise.race([
        win.webContents.executeJavaScript("({ rail: document.querySelectorAll('#app .rail').length, views: document.querySelectorAll('#app > section').length, leak: /\\{[^{}]{0,80}var\\(--/.test(document.body.innerText || ''), vue: !!(document.querySelector('#app') && document.querySelector('#app').__vue_app__) })"),
        new Promise((res) => setTimeout(() => res(null), 3000)),
      ])
      if (!r) { bad++; console.log('  ✗ DOM 断言超时(渲染进程被节流?)') }
      else {
        if (!r.rail) { bad++; console.log('  ✗ 导航轨未渲染') }
        if (r.views < 5) { bad++; console.log('  ✗ 视图数不足 5: ' + r.views) }
        if (r.leak) { bad++; console.log('  ✗ CSS 泄漏成文本(检查 </style> 闭合)') }
        if (!r.vue) { bad++; console.log('  ✗ Vue 未挂载到 #app') }
      }
    } catch (e) { bad++; console.log('  ✗ DOM 断言执行失败: ' + e.message) }
    console.log(bad ? '❌ 有失败' : '✅ 全部通过')
    app.exit(bad ? 1 : 0)
  }, 4500)
})
