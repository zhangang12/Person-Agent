// P2b 验收 · stub 截图:子 Agent 侧边栏 / 命令块运行 / wf 规划闸+自动批准 / 主控分片面板。
// 跑法:npx electron scripts/chat-p2b-stub.cjs(截图到 /tmp/chat-p2b-*.png,DOM 断言随跑随报)
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
  const query = { title: 'P2b 验收 stub', id: 'stub-b1', ...(extraQuery || {}) }
  try { await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query }) }
  catch { await sleep(500); await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query }) }
  await sleep(2200)
  wins.push(win)
  return win
}
function assert(name, cond) { if (cond) console.log('  ✓ ' + name); else { bad++; console.log('  ✗ ' + name) } }

app.whenReady().then(async () => {
  setTimeout(() => { console.log('❌ 看门狗超时'); app.exit(2) }, 90000)
  const ev = (win, js) => win.webContents.executeJavaScript(js)

  // ── 场景1:子 Agent 侧边栏(task 扇出 → 窗格:思考/工具/产出;委派块终态勾掉) ──
  {
    const win = await mkWin()
    await ev(win, `__emit('stream', { kind:'tool', text:'task', partID:'tp1', status:'running', title:'分析模块', input:{description:'分析模块'}, taskChild:'child-1', taskDesc:'分析模块' })`)
    await ev(win, `__emit('stream', { kind:'reasoning', sub:true, agentId:'child-1', agentName:'分析模块', text:'先看目录结构,再抓关键入口…', partID:'r1' })`)
    await ev(win, `__emit('stream', { kind:'tool', sub:true, agentId:'child-1', agentName:'分析模块', text:'read', partID:'st1', status:'completed', title:'读文件', input:{filePath:'src/a.ts'}, output:'export const demo = 42' })`)
    await ev(win, `__emit('stream', { kind:'text', sub:true, agentId:'child-1', agentName:'分析模块', text:'结论:**模块边界干净**,一个入口文件。', partID:'so1' })`)
    await ev(win, `__emit('stream', { kind:'tool', text:'task', partID:'tp1', status:'completed', title:'分析模块', input:{description:'分析模块'}, output:'完成', taskChild:'child-1' })`)
    await sleep(700)
    assert('侧边栏自动滑出', await ev(win, `!!document.querySelector('.subrail')`))
    assert('子 Agent 在清单里', await ev(win, `(document.querySelector('.sr-list .si-name')||{}).textContent === '分析模块'`))
    assert('窗格有思考', await ev(win, `!!document.querySelector('.sa-reason')`))
    assert('窗格有工具块', await ev(win, `!!document.querySelector('.sr-pane .toolblk')`))
    assert('窗格有产出', await ev(win, `!!document.querySelector('.sa-out')`))
    assert('终态已勾(无运行中徽标)', await ev(win, `!document.querySelector('.k-hd .artbadge')`))
    await shot(win, 'chat-p2b-subrail')
  }
  // ── 场景2:命令块「运行」(bash 块 → 运行钮 → target 轮输出落块下) ──
  {
    const win = await mkWin()
    await ev(win, `(() => { const ci = document.getElementById('ci'); ci.value = '__runcmd__'; ci.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.send').click() })()`)
    await sleep(1200)
    const hasRun = await ev(win, `!!document.querySelector('.rblk [data-act="run"]')`)
    assert('命令块带「运行」钮', hasRun)
    if (hasRun) {
      await ev(win, `document.querySelector('.rblk [data-act="run"]').click()`)
      await sleep(1200)
      assert('输出落进块下 rout', await ev(win, `(document.querySelector('.rblk .rout .routbody')||{}).textContent?.includes('total 42')`))
      assert('按钮定格已运行', await ev(win, `(document.querySelector('.rblk [data-act="run"]')||{}).textContent?.includes('已运行')`))
    }
    await shot(win, 'chat-p2b-runcmd')
  }
  // ── 场景3:wf 规划闸(todowrite → 待批条 → 批准 → wfPlanApproved + 批准轮) ──
  {
    const win = await mkWin({ wf: '1' })
    await ev(win, `__emit('stream', { kind:'tool', text:'todowrite', partID:'td1', status:'completed', input: JSON.stringify({ todos: [
      { content: '勘察候选文件', status: 'in_progress' }, { content: '分片实现', status: 'pending' },
    ] }) })`)
    await ev(win, `(() => { const ci = document.getElementById('ci'); ci.value = '按方案来'; ci.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.send').click() })()`)
    await sleep(1200)
    assert('规划闸待批条出现', await ev(win, `!!document.querySelector('.wfbar .wf-go')`))
    await shot(win, 'chat-p2b-plangate')
    await ev(win, `document.querySelector('.wfbar .wf-go').click()`)
    await sleep(900)
    assert('批准已报主进程', await ev(win, `window.__flag('planApproved') === true`))
    assert('批准轮已发出(用户气泡)', await ev(win, `[...document.querySelectorAll('.msg-u')].some(x => x.textContent.includes('批准方案'))`))
  }
  // ── 场景4:wf 自动批准(开关开 → 权限事件自动 once,不出批准条) ──
  {
    const win = await mkWin({ wf: '1' })
    await ev(win, `document.querySelector('.wfbar .wf-auto').click()`)
    await sleep(300)
    await ev(win, `__emit('permission', { requestId: 'aq1', tool: 'write', detail: 'src/x.ts' })`)
    await sleep(500)
    assert('不出批准条', await ev(win, `!document.querySelector('.permbar')`))
    assert('自动批准留痕', await ev(win, `[...document.querySelectorAll('.note')].some(x => x.textContent.includes('自动批准'))`))
    await shot(win, 'chat-p2b-autoallow')
  }
  // ── 场景5:主控分片面板(shard-progress chips → 点一片看镜像会话) ──
  {
    const win = await mkWin({ wf: '1', orch: '1' })
    await ev(win, `__emit('shardProgress', { shards: [
      { id: '11', goal: '分析 models.py 与 schemas.py', status: 'running', round: 1 },
      { id: '12', goal: '分析核心业务路由', status: 'done', round: 3 },
      { id: '', goal: '分析支撑层', status: 'queued', round: 0 },
    ] })`)
    await ev(win, `__emit('stream', { shardRoot: '11', kind: 'text', text: '分片1:先读 models.py 的头部…', partID: 'x1' })`)
    await ev(win, `__emit('stream', { shardRoot: '11', kind: 'tool', text: 'read', partID: 'x2', status: 'completed', title: '读文件' })`)
    await sleep(500)
    assert('分片进度 1/3', await ev(win, `(document.querySelector('.shardpanel .sp-title')||{}).textContent?.includes('1/3')`))
    await ev(win, `document.querySelectorAll('.shardpanel .sp-chip')[0].click()`)
    await sleep(500)
    assert('分片视图渲染镜像文本', await ev(win, `[...document.querySelectorAll('.sp-view .sp-text')].some(x => x.textContent.includes('分片1'))`))
    assert('分片视图渲染镜像工具', await ev(win, `!!document.querySelector('.sp-view .sp-tool')`))
    await shot(win, 'chat-p2b-shardpanel')
  }
  for (const w of wins) { try { w.destroy() } catch {} }
  console.log(bad ? '❌ 有失败(见上)' : '✅ P2b stub 全过,无渲染错误')
  app.exit(bad ? 1 : 0)
})
