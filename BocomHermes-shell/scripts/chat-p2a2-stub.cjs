// P2a-2 验收 · stub 截图:裸 Electron + stub-preload(全内存假桥),驱动 chat 页关键状态各截一张到 /tmp/chat-p2a2-*.png。
// 跑法:node scripts/chat-p2a2-stub.cjs(headless 截图,show:false;webContents 事件驱动,executeJavaScript 在 stub 桥下可用)
'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let bad = 0
async function shot(win, name) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync('/tmp/' + name + '.png', img.toPNG())
  console.log('  ✓ /tmp/' + name + '.png')
}
async function mkWin(tokens) {
  const win = new BrowserWindow({
    width: 720, height: 860, show: false,
    webPreferences: { preload: path.join(__dirname, 'stub-preload.cjs'), contextIsolation: true, backgroundThrottling: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 || /Uncaught|ReferenceError|TypeError|SyntaxError|\[Vue warn\]/.test(message)) { bad++; console.log('  ✗ [renderer]', String(message).slice(0, 240)) }
  })
  const query = { title: 'P2a-2 验收 stub', id: 'stub1' }
  if (tokens) query.__tokens = String(tokens)
  // 连开多窗时偶发 ERR_FAILED(Electron 怪癖):重试一次;窗统一在末尾 destroy
  try { await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query }) }
  catch { await sleep(500); await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query }) }
  await sleep(2200)   // boot:cardInit stub 回包 + 首屏
  return win
}
app.whenReady().then(async () => {
  setTimeout(() => { console.log('❌ 看门狗超时'); app.exit(2) }, 90000)
  const wins = []
  const ev = (win, js) => win.webContents.executeJavaScript(js)

  // ── 场景1:工具块(折叠+展开)+ todo 卡 + 一轮问答 ──
  {
    const win = await mkWin(0)
    await ev(win, `__emit('stream', { kind:'tool', text:'read', partID:'t1', status:'running', title:'读取文件', input:'{"filePath":"src/a.ts"}' })`)
    await sleep(300)
    await ev(win, `__emit('stream', { kind:'tool', text:'read', partID:'t1', status:'completed', title:'读取文件', input:'{"filePath":"src/a.ts"}', output:'export const demo = 42' })`)
    await ev(win, `__emit('stream', { kind:'tool', text:'grep', partID:'t2', status:'completed', title:'搜索', input:'{"pattern":"demo"}', output:'src/a.ts:1: export const demo = 42' })`)
    await ev(win, `__emit('stream', { kind:'tool', text:'todowrite', partID:'td1', status:'completed', input: JSON.stringify({ todos: [
      { content: '设计数据模型', status: 'completed' },
      { content: '实现接口与单测', status: 'in_progress' },
      { content: '联调验收', status: 'pending' },
    ] }) })`)
    await sleep(400)
    await ev(win, `(() => { const hds = document.querySelectorAll('.toolblk .tb-hd'); if (hds[1]) hds[1].click() })()`)
    await ev(win, `(() => { const ci = document.getElementById('ci'); ci.value = '帮我看看这个项目结构'; ci.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.send').click() })()`)
    await sleep(900)
    await shot(win, 'chat-p2a2-tools-todo')
    wins.push(win)
  }
  // ── 场景2:权限条 常规橙 + 高危红 ──
  {
    const win = await mkWin(0)
    await ev(win, `__emit('permission', { requestId: 'q1', tool: 'edit', detail: 'src/a.ts', diff: '+ 新增一行\\n- 删除一行' })`)
    await ev(win, `__emit('permission', { requestId: 'q2', tool: 'bash', detail: 'rm -rf /tmp/build 然后重新编译' })`)
    await sleep(500)
    await shot(win, 'chat-p2a2-perm')
    wins.push(win)
  }
  // ── 场景3:提问卡 单选 + 多选/custom ──
  {
    const win = await mkWin(0)
    await ev(win, `__emit('question', { requestId: 'qz1', questions: [
      { header: '方案', question: '两个实现路径选哪个?', options: [{ label: 'A · 兼容旧表', description: '改动小,风险低' }, { label: 'B · 重建新表', description: '干净但要迁移' }] },
      { question: '顺带处理哪些?(多选)', multiple: true, options: [{ label: '补索引' }, { label: '加审计字段' }], custom: true },
    ] })`)
    await sleep(500)
    await shot(win, 'chat-p2a2-question')
    wins.push(win)
  }
  // ── 场景4:ctx chip 三态(绿/橙/红,配 100k 上限) ──
  for (const [tokens, name] of [[30000, 'ctx-green'], [70000, 'ctx-warn'], [90000, 'ctx-danger']]) {
    const win = await mkWin(tokens)
    await ev(win, `(() => { const ci = document.getElementById('ci'); ci.value = '刷一下用量'; ci.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.send').click() })()`)
    await sleep(900)   // 轮末 pollRealUsage 落实测
    await shot(win, 'chat-p2a2-' + name)
    wins.push(win)
  }
  // ── 场景5:成果抽屉(write 落盘 → 抽屉 → 预览) ──
  {
    const win = await mkWin(0)
    await ev(win, `__emit('stream', { kind:'tool', text:'write', partID:'w1', status:'completed', title:'写入文件', input:'{"filePath":"src/a.ts","content":"export const demo = 42"}', output:'ok' })`)
    await sleep(400)
    await ev(win, `(() => { document.querySelector('.artbtn').click() })()`)
    await sleep(400)
    await ev(win, `(() => { const f = document.querySelector('.ad-file'); if (f) f.click() })()`)
    await sleep(500)
    await shot(win, 'chat-p2a2-artdrawer')
    wins.push(win)
  }
  // ── 场景6:模型菜单(chip → KMenu) ──
  {
    const win = await mkWin(0)
    await ev(win, `(() => { const c = document.querySelector('.k-hd .k-chip.clickable'); if (c) c.click() })()`)
    await sleep(500)
    await shot(win, 'chat-p2a2-modelmenu')
    wins.push(win)
  }
  for (const w of wins) { try { w.destroy() } catch {} }
  console.log(bad ? '❌ 有渲染错误(见上)' : '✅ stub 截图完成,无渲染错误')
  app.exit(bad ? 1 : 0)
})
