// P2c 验收 · stub:状态行(忙时 ✻+工具名+耗时) / 看门狗绕圈两级 / 委派驱动 / 防停连催 / 产出兜底。
// 跑法:npx electron scripts/chat-p2c-stub.cjs(截图到 /tmp/chat-p2c-*.png,DOM 断言随跑随报)
'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let bad = 0
const wins = []
async function shot(win, name) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync('/tmp/' + name + '.png', img.toPNG())
  console.log('  ✓ /tmp/' + name + '.png')
}
async function mkWin(extraQuery) {
  const win = new BrowserWindow({
    width: 760, height: 880, show: false,
    webPreferences: { preload: path.join(__dirname, 'stub-preload.cjs'), contextIsolation: true, backgroundThrottling: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 || /Uncaught|ReferenceError|TypeError|SyntaxError|\[Vue warn\]/.test(message)) { bad++; console.log('  ✗ [renderer]', String(message).slice(0, 240)) }
  })
  const query = { title: 'P2c 验收 stub', id: 'stub-c1', ...(extraQuery || {}) }
  try { await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query }) }
  catch { await sleep(500); await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query }) }
  await sleep(2400)   // boot 首轮(也=第 1 轮)跑完
  wins.push(win)
  return win
}
function assert(name, cond) { if (cond) console.log('  ✓ ' + name); else { bad++; console.log('  ✗ ' + name) } }
const sendText = async (win, t) => win.webContents.executeJavaScript(`(() => { const ci = document.getElementById('ci'); ci.value = ${JSON.stringify(t)}; ci.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.send').click() })()`)
const hasNote = (win, s) => win.webContents.executeJavaScript(`[...document.querySelectorAll('.note')].some(x => x.textContent.includes(${JSON.stringify(s)}))`)

app.whenReady().then(async () => {
  setTimeout(() => { console.log('❌ 看门狗超时'); app.exit(2) }, 120000)
  const ev = (win, js) => win.webContents.executeJavaScript(js)

  // ── 场景1:状态行(慢轮:忙时 ✻ + 工具名,完成 ✓ 耗时) ──
  {
    const win = await mkWin()
    await sendText(win, '__slow__')
    await sleep(700)
    assert('忙时状态行可见', await ev(win, `!!document.querySelector('.statusline .sl-spin')`))
    assert('显示思考中', await ev(win, `(document.querySelector('.statusline .sl-main')||{}).textContent?.includes('思考中')`))
    await ev(win, `__emit('stream', { kind:'tool', text:'read', partID:'sl1', status:'running', title:'读取文件', input:{filePath:'a.ts'} })`)
    await sleep(400)
    assert('工具名上状态行', await ev(win, `(document.querySelector('.statusline .sl-main')||{}).textContent?.includes('read')`))
    await shot(win, 'chat-p2c-statusline')
    await sleep(2600)   // 慢轮结束
    assert('完成短显 ✓', await ev(win, `(document.querySelector('.statusline')||{}).textContent?.includes('完成')`))
  }
  // ── 场景2:看门狗(3 轮读同一批文件且无 todo 进展 → 绕圈提醒) ──
  {
    const win = await mkWin({ wf: '1' })
    for (let i = 0; i < 3; i++) {
      await ev(win, `__emit('stream', { kind:'tool', text:'read', partID:'wd${i}a', status:'completed', title:'读文件', input:{filePath:'src/models.py'} })`)
      await ev(win, `__emit('stream', { kind:'tool', text:'grep', partID:'wd${i}b', status:'completed', title:'搜索', input:{pattern:'PurchaseOrder'} })`)
      await sendText(win, '再确认一下 ' + i)
      await sleep(1100)
    }
    assert('看门狗绕圈提醒', await hasNote(win, '看门狗'))
    await shot(win, 'chat-p2c-watchdog')
  }
  // ── 场景3:委派驱动(todo ≥3 + 已读文件 + ≥2 轮 + 没派 task → 催派子 Agent) ──
  {
    const win = await mkWin({ wf: '1' })
    await ev(win, `__emit('stream', { kind:'tool', text:'todowrite', partID:'dg1', status:'completed', input: JSON.stringify({ todos: [
      { content: '摸 A 模块', status: 'in_progress' }, { content: '摸 B 模块', status: 'pending' }, { content: '摸 C 模块', status: 'pending' },
    ] }) })`)
    await ev(win, `__emit('stream', { kind:'tool', text:'read', partID:'dg2', status:'completed', title:'读文件', input:{filePath:'src/a.py'} })`)
    await sendText(win, '继续摸排')
    await sleep(1300)
    assert('委派驱动提醒', await hasNote(win, '委派驱动'))
    await shot(win, 'chat-p2c-delegate')
  }
  // ── 场景4:防停(todo 有未完项 → 自动连催,至多 3 次) ──
  {
    const win = await mkWin({ wf: '1' })
    const before = await ev(win, `window.__flag('sendN')`)
    await ev(win, `__emit('stream', { kind:'tool', text:'todowrite', partID:'cn1', status:'completed', input: JSON.stringify({ todos: [
      { content: '第一步', status: 'completed' }, { content: '第二步', status: 'pending' },
    ] }) })`)
    await sendText(win, '干到这')
    await sleep(4500)   // 连催链:手动 1 + 催 ≤3
    const after = await ev(win, `window.__flag('sendN')`)
    assert('自动连催(多发 2~4 轮)', (after - before) >= 2 && (after - before) <= 5)
    await shot(win, 'chat-p2c-continue')
  }
  // ── 场景5:产出兜底(todo 全勾 + 零落盘 → 补 MD 提醒) ──
  {
    const win = await mkWin({ wf: '1' })
    await ev(win, `__emit('stream', { kind:'tool', text:'todowrite', partID:'pd1', status:'completed', input: JSON.stringify({ todos: [
      { content: '唯一一步', status: 'completed' },
    ] }) })`)
    await sendText(win, '做完')
    await sleep(1500)
    assert('产出兜底提醒', await hasNote(win, '尚无落盘产出'))
    await shot(win, 'chat-p2c-produce')
  }
  // ── 场景6:规划闸倒计时(knobs.approvalTimeoutMin=0.03 ≈1.8s → 自动开跑) ──
  {
    const win = await mkWin({ wf: '1', __knobs: JSON.stringify({ approvalTimeoutMin: 0.03 }) })
    await ev(win, `__emit('stream', { kind:'tool', text:'todowrite', partID:'cd1', status:'completed', input: JSON.stringify({ todos: [
      { content: '第一步', status: 'in_progress' }, { content: '第二步', status: 'pending' },
    ] }) })`)
    await sendText(win, '按方案来')
    await sleep(1300)
    assert('倒计时文案出现', await ev(win, `!!document.querySelector('.wfbar .wf-cd')`))
    await sleep(2200)   // 倒计时到期
    assert('倒计时自动批准', await ev(win, `window.__flag('planApproved') === true`))
    await shot(win, 'chat-p2c-plancountdown')
  }
  // ── 场景7:todo 提醒兜底(knobs.todoNudgeRounds=1:N 轮没动 todo → 下条消息尾附提醒) ──
  {
    const win = await mkWin({ wf: '1', __knobs: JSON.stringify({ todoNudgeRounds: 1 }) })
    await ev(win, `__emit('stream', { kind:'tool', text:'todowrite', partID:'tn1', status:'completed', input: JSON.stringify({ todos: [
      { content: '第一步', status: 'completed' }, { content: '第二步', status: 'pending' },
    ] }) })`)
    await sendText(win, '继续干')          // 这轮更新 turnN,todo 仍未再动
    await sleep(1200)
    await sendText(win, '再来一轮')        // 本轮发出时 turnN-wfTodoLastTurn ≥ 1 → 尾部附提醒
    await sleep(800)
    assert('消息尾部附 todo 提醒', await ev(win, `window.__flag('sendTexts').some(t => t.includes('todo 清单已多轮未更新'))`))
  }
  for (const w of wins) { try { w.destroy() } catch {} }
  console.log(bad ? '❌ 有失败(见上)' : '✅ P2c stub 全过,无渲染错误')
  app.exit(bad ? 1 : 0)
})
