'use strict'
// 用已装的 Electron 把 SVG 图标渲染成透明 PNG（本机无 SVG 栅格化工具时的可靠方案）。
// 用法：electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')

const targets = [
  { html: path.join(ROOT, 'build', 'icon-src.html'),  out: path.join(ROOT, 'build', 'icon-1024.png'), size: 1024 },
  { html: path.join(ROOT, 'build', 'icon-tray.html'), out: path.join(ROOT, 'assets', 'tray.png'),     size: 128 },
]

async function render(t) {
  const win = new BrowserWindow({
    width: t.size, height: t.size, x: -3000, y: 0, show: true,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    webPreferences: { offscreen: false },
  })
  await win.loadFile(t.html)
  await new Promise((r) => setTimeout(r, 500))          // 等 SVG 滤镜/渐变绘制完成
  const img = await win.webContents.capturePage()
  const png = img.resize({ width: t.size, height: t.size, quality: 'best' }).toPNG()
  fs.writeFileSync(t.out, png)
  console.log('wrote ' + path.relative(ROOT, t.out) + ' (' + png.length + ' bytes)')
  win.destroy()
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  // 多窗口在同一进程内连续渲染会偶发 ERR_FAILED，按需用 ICON_TARGET 过滤、分进程跑更稳
  const only = process.env.ICON_TARGET
  const list = only ? targets.filter((t) => t.out.includes(only)) : targets
  for (const t of list) { try { await render(t) } catch (e) { console.error('render fail ' + t.out + ': ' + e.message) } }
  app.quit()
})
