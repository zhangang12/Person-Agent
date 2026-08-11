// Agent 截图内嵌对话流 · 目检截图:npm run shot:stub
//
// 【为什么单独一个】这是要靠眼睛验收的改动。我在用户界面上盲改过三版、越改越差,结论是
// 「一版一验,或者干脆不碰」。这个 stub 就是那个"验":裸 Electron + 假桥,把 card-shot
// 打进真页面,截三张 PNG 出来自己看 —— 不用去动用户正在用的那个应用。
// 顺带把渲染端的报错(Vue warn / Uncaught)当失败:样式看着对、控制台在报错也不算过。
'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const ROOT = path.join(__dirname, '..')
const OUT = '/tmp'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let bad = 0

// 造一张"看着像页面截图"的 PNG:横向渐变 + 顶栏 + 侧栏色块,好判断缩放/裁切对不对
function fakeShotPng(w, h) {
  const { nativeImage } = require('electron')
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      let r = 240, g = 243, b = 246
      if (y < h * 0.07) { r = 32; g = 38; b = 48 }                       // 顶栏
      else if (x < w * 0.16) { r = 52; g = 60; b = 74 }                  // 侧栏
      else if (y > h * 0.15 && y < h * 0.2) { r = 90; g = 130; b = 240 } // 一条蓝色标题带
      else if ((y % 60) < 2) { r = 210; g = 215; b = 222 }               // 表格行线
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255       // BGRA
    }
  }
  return nativeImage.createFromBuffer(buf, { width: w, height: h }).toPNG()
}

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  const fp = path.join(OUT, name + '.png')
  fs.writeFileSync(fp, img.toPNG())
  console.log('  ✓ ' + fp)
}

async function mkWin() {
  const win = new BrowserWindow({
    // 刻意开宽:用户是在 1500px 宽的对话区上看出「太糊」的 —— 窄窗根本验不出放大
    width: 1180, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'stub-preload.cjs'), contextIsolation: true, backgroundThrottling: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 || /Uncaught|ReferenceError|TypeError|SyntaxError|\[Vue warn\]/.test(message)) { bad++; console.log('  ✗ [renderer] ' + String(message).slice(0, 240)) }
  })
  try { await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query: { title: '截图内嵌目检', id: 'shotstub' } }) }
  catch { await sleep(500); await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query: { title: '截图内嵌目检', id: 'shotstub' } }) }
  await sleep(2000)
  return win
}

app.whenReady().then(async () => {
  setTimeout(() => { console.log('❌ 看门狗超时'); app.exit(2) }, 90000)
  const wins = []
  const ev = (win, js) => win.webContents.executeJavaScript(js)
  // 照抄壳层真身的口径(SHOT_W=1520 物理像素 + JPEG88),看到的就是真机会看到的东西。
  // ★这个口径必须跟 window.js 的 SHOT_W 一致,否则目检出来的清晰度是假的。
  const SHOT_W = 1520
  const mk = (w, h) => 'data:image/jpeg;base64,' + require('electron').nativeImage
    .createFromBuffer(fakeShotPng(w, h)).resize({ width: SHOT_W, quality: 'best' }).toJPEG(88).toString('base64')
  const wide = mk(1280, 800)
  const tall = mk(1280, 4200)

  // ── 场景1:一轮问答之后来一张截图(最常见的形态)──
  {
    const win = await mkWin()
    await ev(win, `(() => { const ci = document.getElementById('ci'); ci.value = '打开首页截个图给我'; ci.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.send').click() })()`)
    await sleep(700)
    await ev(win, `__emit('shot', ${JSON.stringify({ path: '/Users/x/Downloads/BocomHermes-1.png', label: '项目总览页', url: 'http://127.0.0.1:5173/overview', w: 1280, h: 800, full: false }).replace(/}$/, '')}, dataUrl: ${JSON.stringify(wide)} })`)
    await sleep(500)
    // ★量出来,不靠眼估:显示宽必须 ≤ 图片自然宽的一半(Retina 2x 才是 1:1)。
    //   第一版就是"出图 760、显示占满 1500",放大 2 倍 —— 用户一眼看出糊,而我看代码看不出来。
    const box = await ev(win, `(() => { const i = document.querySelector('.shot-img'); if (!i) return null; return { css: Math.round(i.getBoundingClientRect().width), nat: i.naturalWidth } })()`)
    console.log('  · 显示宽 ' + (box && box.css) + 'px / 图片自然宽 ' + (box && box.nat) + 'px')
    if (!box || box.css > box.nat / 2 + 1) { bad++; console.log('  ✗ 图被放大了(显示宽超过自然宽的一半)—— Retina 上必糊') }
    await shot(win, 'shot-stub-1-normal')
    const flag = await ev(win, `(() => { const b = document.querySelector('.shot-open'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`)
    await sleep(200)
    const opened = await ev(win, `window.__flag('shotOpen') || ''`)
    console.log('  · 「打开原图」按钮:' + flag + ',回传路径=' + (opened || '(空)'))
    if (opened !== '/Users/x/Downloads/BocomHermes-1.png') { bad++; console.log('  ✗ 点按钮没把原图路径传回主进程') }
    wins.push(win)
  }
  // ── 场景2:整页长截图(必须被 max-height 收住,不能把一屏全占掉)──
  {
    const win = await mkWin()
    await ev(win, `__emit('shot', ${JSON.stringify({ path: '/Users/x/Downloads/BocomHermes-2.png', label: '整页 · 含视口外内容', url: 'http://127.0.0.1:5173/list', w: 1280, h: 4200, full: true }).replace(/}$/, '')}, dataUrl: ${JSON.stringify(tall)} })`)
    await sleep(500)
    await shot(win, 'shot-stub-2-fullpage')
    wins.push(win)
  }
  // ── 场景3:缩略图缺失(缩图失败)—— 也要成条,不能悄悄消失 ──
  {
    const win = await mkWin()
    await ev(win, `__emit('shot', { path: '/Users/x/Downloads/BocomHermes-3.png', label: '', url: '', w: 0, h: 0, full: false, dataUrl: '' })`)
    await sleep(400)
    const n = await ev(win, `document.querySelectorAll('.shot').length`)
    if (n !== 1) { bad++; console.log('  ✗ 没有缩略图时条目没渲染出来(n=' + n + ')') }
    await shot(win, 'shot-stub-3-nothumb')
    wins.push(win)
  }
  // ── 场景4:交错时序(用户 2026-08-12 的原话:"工具调用和截图在最上面,输出一直在最底部")──
  {
    const win = await mkWin()
    const say = (t, id) => ev(win, `__emit('stream', ${JSON.stringify({ kind: 'text', text: t, partID: id })})`)
    const tool = (n, id, title, out) => ev(win, `__emit('stream', ${JSON.stringify({ kind: 'tool', text: n, partID: id, status: 'completed', title, input: '{}', output: out })})`)
    await sleep(1200)   // ★先等开卡自动首条那一轮收尾 —— 不等的话我这条会被排队,后面的 emits 落进上一轮的气泡
    await ev(win, `(() => { const ci = document.getElementById('ci'); ci.value = '把这几个页面都跑一遍截图 __hold__'; ci.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.send').click() })()`)
    await sleep(600)
    await say('C1 项目目录。先打开看看。', 'a1'); await sleep(350)
    await tool('browser_open', 't1', '打开页面', 'ok'); await sleep(250)
    await ev(win, `__emit('shot', ${JSON.stringify({ path: '/x/1.png', label: 'C1 项目目录', url: 'http://127.0.0.1:5173/', w: 1440, h: 900, full: false }).replace(/}$/, '')}, dataUrl: ${JSON.stringify(wide)} })`)
    await sleep(300)
    await say('C1 项目目录。先打开看看。\n\nC1 加载成功(9 个 tab)。截图。\n\nC2 采购管理。', 'a1'); await sleep(350)
    await tool('browser_act', 't2', '点击 采购管理', 'ok'); await sleep(250)
    await ev(win, `__emit('shot', ${JSON.stringify({ path: '/x/2.png', label: 'C2 采购管理', url: 'http://127.0.0.1:5173/purchase', w: 1440, h: 900, full: false }).replace(/}$/, '')}, dataUrl: ${JSON.stringify(wide)} })`)
    await sleep(300)
    await say('C1 项目目录。先打开看看。\n\nC1 加载成功(9 个 tab)。截图。\n\nC2 采购管理。\n\nC2 加载成功。截图。', 'a1')
    await ev(win, `window.__release()`)   // 收尾:回合正常结束
    await sleep(900)
    const order = await ev(win, `[...document.querySelectorAll('.msg-a, .toolblk, .shot')].map(e => e.classList.contains('shot') ? 'shot' : e.classList.contains('toolblk') ? 'tool' : 'text').join(' ')`)
    console.log('  · feed 顺序:' + order)
    if (!/text tool shot text tool shot/.test(order)) { bad++; console.log('  ✗ 时序没有交错(工具/截图应该夹在两段文字中间)') }
    const segs = await ev(win, `[...document.querySelectorAll('.msg-a')].map(e => e.innerText.replace(/\\s+/g,' ').trim().slice(0,40))`)
    console.log('  · 各段文字:' + JSON.stringify(segs))
    if (!segs.some((x) => /C2 加载成功/.test(x))) { bad++; console.log('  ✗ 最后一段文字丢了(封存偏移把尾巴也吃掉了?)') }
    if (segs.filter((x) => !x).length) { bad++; console.log('  ✗ feed 里留了空气泡') }
    const dup = await ev(win, `(() => { const t = [...document.querySelectorAll('.msg-a')].map(e => e.innerText).join('|'); return (t.match(/C1 加载成功/g) || []).length })()`)
    if (dup !== 1) { bad++; console.log('  ✗ 分段后文字重复了 ' + dup + ' 次(封存偏移没算对)') }
    await shot(win, 'shot-stub-4-interleave')
    wins.push(win)
  }
  for (const w of wins) { try { w.destroy() } catch {} }
  console.log(bad ? '❌ 有问题(见上)' : '✅ 目检截图完成,无渲染错误')
  app.exit(bad ? 1 : 0)
})
