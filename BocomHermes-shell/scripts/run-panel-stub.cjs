// 编排面板目检 stub:裸 Electron + stub-preload,把新引擎面板的四个关键画面各截一张到 /tmp/run-panel-*.png。
// 跑法:npm run run:stub
//
// 为什么要有它:编排面板只在真 serve + 真模型跑起来时才看得见,
// 而那条链一次要几分钟。这里用假快照直接把面板的四种形态摆出来目检 + 断言,秒级反馈。
'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let bad = 0
async function shot(win, name) {
  fs.writeFileSync('/tmp/' + name + '.png', (await win.webContents.capturePage()).toPNG())
  console.log('  ✓ /tmp/' + name + '.png')
}
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { bad++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(extra).slice(0, 300) : '')) }
}

const node = (o) => Object.assign({
  id: 'n1', title: '节点', kind: 'work', state: 'pending', attempt: 0, patches: 0, wave: 1,
  cardId: null, reason: '', droppedReason: '', files: [], deps: [], exitReport: [],
}, o)
const snap = (o) => Object.assign({
  id: 'R1', goal: '摸清这个仓库的编排链路并写成开发手册', phase: 'executing', alias: 'RUN-ab', wave: 1,
  counts: { total: 0, verified: 0, running: 0, queued: 0, pending: 0, failed: 0, skipped: 0 },
  budget: { maxNodes: 24, spawned: 0, maxDecides: 48, spentDecides: 0 },
  nodes: [], decisions: [], pendingDecision: null, ask: null,
  result: { summary: '', deliverables: [], gaps: [] }, notes: [],
}, o)
const countOf = (nodes) => ({
  total: nodes.length,
  verified: nodes.filter((n) => n.state === 'verified').length,
  running: nodes.filter((n) => n.state === 'running').length,
  queued: nodes.filter((n) => n.state === 'queued').length,
  pending: nodes.filter((n) => n.state === 'pending').length,
  failed: nodes.filter((n) => n.state === 'failed').length,
  skipped: nodes.filter((n) => n.state === 'skipped').length,
})

app.whenReady().then(async () => {
  setTimeout(() => { console.log('❌ 看门狗超时'); app.exit(2) }, 90000)
  const win = new BrowserWindow({
    width: 760, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'stub-preload.cjs'), contextIsolation: true, backgroundThrottling: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 || /Uncaught|ReferenceError|TypeError|SyntaxError|\[Vue warn\]/.test(message)) { bad++; console.log('  ✗ [renderer]', String(message).slice(0, 240)) }
  })
  const ev = (js) => win.webContents.executeJavaScript(js)
  // run=<id> → 渲染端走【编排面板】形态(不是对话流)
  await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query: { title: '编排 · 摸清仓库', id: 'stub-run', orch: '1', wf: '1', run: 'R1' } })
  await sleep(2200)

  ok('★编排面板卡没有对话流(它没有回合)', !(await ev(`!!document.querySelector('.feed')`)))
  ok('★也没有对话输入条', !(await ev(`!!document.querySelector('.composer, #ci')`)))

  // ── 画面1:等批准 ──
  const plan = [
    node({ id: 'a', title: '勘察认证模块与权限链', writeScope: ['src/auth'] }),
    node({ id: 'b', title: '梳理订单状态机' }),
    node({ id: 'c', title: '盘点数据表与接口契约' }),
  ]
  await ev(`__emit('runSnapshot', ${JSON.stringify(snap({ phase: 'awaiting-approval', nodes: plan, counts: countOf(plan), decisions: [{ at: 1, point: 'plan', why: '三块相互独立,可并行', invalid: '' }] }))})`)
  await sleep(400)
  ok('等批准:亮出【开始执行】(是显式 phase,不是嗅探出来的)', await ev(`!!document.querySelector('.rp-go')`))
  ok('节点表已列出 3 个节点', (await ev(`document.querySelectorAll('.rp-node').length`)) === 3)
  await shot(win, 'run-panel-1-approve')

  // ── 画面2:执行中(含补做 / 重做 / 失败 / 跳过 / 第 2 波)──
  const running = [
    node({ id: 'a', title: '勘察认证模块与权限链', state: 'verified', files: ['docs/auth.md'] }),
    node({ id: 'b', title: '梳理订单状态机', state: 'running', patches: 1, cardId: '12', exitReport: [{ kind: 'evidence', detail: '没有构建/测试执行证据' }] }),
    node({ id: 'c', title: '盘点数据表与接口契约', state: 'failed', attempt: 2, reason: 'contract-miss', exitReport: [{ kind: 'contract', detail: '缺 createPayment' }] }),
    node({ id: 'd', title: '抽出共享 DTO', state: 'pending', wave: 2, deps: ['b'] }),
    node({ id: 'e', title: '前端路由归属', state: 'skipped', droppedReason: '被重规划撤掉' }),
  ]
  await ev(`__emit('runSnapshot', ${JSON.stringify(snap({
    phase: 'executing', wave: 2, nodes: running, counts: countOf(running),
    pendingDecision: { id: 'd7', point: 'replan', event: 'node-failed', nodeId: 'c' },
    decisions: [
      { at: 1, point: 'plan', why: '三块相互独立,可并行', invalid: '' },
      { at: 2, point: 'replan', why: 'b 发现共享 DTO,补一片抽出来', invalid: '' },
      { at: 3, point: 'replan', why: '', invalid: 'schemaFail' },
    ],
  }))})`)
  await sleep(400)
  ok('★补做次数可见(补1 = 原卡补做过一次,没重开卡)', await ev(`!!document.querySelector('.rn-tag.patch')`))
  ok('★重做次数与补做分开显示', await ev(`!!document.querySelector('.rn-tag.redo')`))
  ok('★没过的退出闸直接标在节点上', await ev(`!!document.querySelector('.rn-tag.bad')`))
  ok('★波次可见(小批 replan 有没有真发生,看这个数)', await ev(`/第 2 波/.test(document.querySelector('.rp-wave').textContent)`))
  ok('在飞决策有指示', await ev(`!!document.querySelector('.rp-thinking')`))
  ok('失败节点给【重试】', await ev(`!!document.querySelector('.rn-retry')`))
  await ev(`document.querySelector('.rp-dechd').click()`)
  await sleep(200)
  ok('决策留痕可展开,不合法的标红', await ev(`!!document.querySelector('.rp-decrow.bad')`))
  await shot(win, 'run-panel-2-executing')

  // ── 画面3:停下来等用户拿主意 ──
  await ev(`__emit('runSnapshot', ${JSON.stringify(snap({
    phase: 'awaiting-user', nodes: running, counts: countOf(running),
    ask: { question: '订单状态机有两种拆法:按状态拆 or 按接口拆,你倾向哪个?', options: ['按状态拆', '按接口拆'] },
  }))})`)
  await sleep(300)
  ok('★等用户拿主意时把问题摆出来(不自动替它选)', await ev(`/两种拆法/.test(document.body.innerText)`))
  ok('给出可点选项', (await ev(`document.querySelectorAll('.rp-ask.warn .rp-alt').length`)) === 2)
  await shot(win, 'run-panel-3-askuser')

  // ── 画面4:收口 ──
  const doneNodes = running.map((n) => (n.state === 'failed' ? n : Object.assign({}, n, { state: 'verified' })))
  await ev(`__emit('runSnapshot', ${JSON.stringify(snap({
    phase: 'done', wave: 3, nodes: doneNodes, counts: countOf(doneNodes),
    result: { summary: '已产出联合开发手册,覆盖认证/订单/数据三块', deliverables: ['docs/README.md', 'docs/auth.md'], gaps: [{ text: 'c 片契约缺 createPayment,未完成' }] },
  }))})`)
  await sleep(300)
  ok('收口显示成果与产出清单', await ev(`!!document.querySelector('.rp-result .rr-file')`))
  ok('★缺口如实列出(不许把没做完说成做完)', await ev(`/createPayment/.test(document.querySelector('.rr-gaps').textContent)`))
  ok('终态不再显示插话框', !(await ev(`!!document.querySelector('.rp-say')`)))
  await shot(win, 'run-panel-4-done')

  win.destroy()
  console.log(bad ? '\n❌ ' + bad + ' 项不通过' : '\n✅ 编排面板全部通过')
  app.exit(bad ? 1 : 0)
})
