// 编排 · 节点镜像视图目检 stub:裸 Electron + stub-preload(全内存假桥)。
// 编排面板上点任一节点的「查看」,就地渲染那个工人卡的实时会话镜像 —— 这块没有真 serve 跑不起来,
// 以前只能靠实跑碰运气看(工具只印个名字、子 Agent 与主 Agent 输出混在一列、思考和正文混排)。
//
// 注:老版这里还测「主控调 run_workflow 派分片」的工具块,那套随旧引擎删除了 ——
// 现在节点由状态机按 deps 直接派,面板上看节点表,不看工具块。
// 跑法:npm run orch:stub(headless 截图;渲染端报错/Vue warn 一律计失败并非零退出)
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
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { bad++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(extra).slice(0, 300) : '')) }
}

const SHARDS = [
  { id: '11', goal: '勘察认证模块入口与权限链', status: 'done', round: 3 },
  { id: '12', goal: '梳理订单状态机与关键公式', status: 'running', round: 2 },
  { id: '13', goal: '盘点数据表与外部接口契约', status: 'interrupted', round: 1 },
  { id: '', goal: '整理前端路由与页面归属', status: 'queued', round: 0 },
]

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
  // orch=1 → 主控卡形态(分片进度面板 + 规划闸);wf=1 与真窗口路径一致
  await win.loadFile(path.join(ROOT, 'ui', 'dist', 'chat.html'), { query: { title: '编排 · 摸清这个仓库', id: 'stub-orch', orch: '1', wf: '1', run: 'R1' } })
  await sleep(2200)

  // ── 画面1:节点进度面板(编排面板推来的分片/节点状态)──
  await ev(`__emit('shardProgress', ${JSON.stringify({ shards: SHARDS })})`)
  await sleep(400)
  ok('节点进度面板出现(含排队计数)', await ev(`!!document.querySelector('.shardpanel .sp-queued')`))
  await shot(win, 'orch-shard-1-nodes')


  // ── 画面3:分片镜像视图(工具行带状态、子 Agent 缩进挂 ↳ 名字、思考折叠) ──
  const mir = (o) => `__emit('stream', ${JSON.stringify(o)})`
  await ev(mir({ kind: 'tool', text: 'grep', partID: 'm1', status: 'completed', shardRoot: '12', title: 'status.*machine', input: { pattern: 'status.*machine' }, output: 'src/order/state.ts:42: const MACHINE = {…}' }))
  await ev(mir({ kind: 'reasoning', text: '状态机有 7 个态,先确认哪些迁移是外部接口触发的,再回代码核对。', partID: 'm2', shardRoot: '12' }))
  await ev(mir({ kind: 'tool', text: 'task', partID: 'm3', status: 'running', shardRoot: '12', title: '深读 state.ts', input: { description: '深读订单状态机' } }))
  await ev(mir({ kind: 'tool', text: 'read', partID: 'm4', status: 'completed', shardRoot: '12', sub: true, agentName: '深读者', title: 'src/order/state.ts', input: { filePath: 'src/order/state.ts' }, output: 'export const MACHINE = { created: [...], paid: [...] }' }))
  await ev(mir({ kind: 'text', text: '状态机共 7 态,其中 `paid → refunding` 只在退款接口里触发。', partID: 'm5', shardRoot: '12', sub: true, agentName: '深读者' }))
  await ev(mir({ kind: 'tool', text: 'write', partID: 'm6', status: 'error', shardRoot: '12', title: 'docs/订单/状态机.md', input: { filePath: 'docs/订单/状态机.md' }, error: '权限被拒:写归属外的文件' }))
  await ev(mir({ kind: 'text', text: '## 阶段结论\n\n订单状态机已梳理完,详见 `docs/订单/状态机.md`。', partID: 'm7', shardRoot: '12' }))
  await sleep(400)
  await ev(`(() => { const c = [...document.querySelectorAll('.shardpanel .sp-chip')].find(e => /订单状态机/.test(e.textContent)); if (c) c.click() })()`)
  await sleep(500)
  ok('节点视图头写清是哪一个节点', await ev(`/梳理订单状态机/.test((document.querySelector('.sp-vhd .vh-goal')||{}).textContent||'')`))
  ok('工具行带状态(完成/出错/运行中)', await ev(`!!document.querySelector('.sp-tool .st.done') && !!document.querySelector('.sp-tool .st.err')`))
  ok('子 Agent 事件缩进并挂 ↳ 名字', await ev(`[...document.querySelectorAll('.shardpanel .sp-who')].some(e => /深读者/.test(e.textContent))`))
  ok('思考收进折叠块,不与正文混排', await ev(`!!document.querySelector('.shardpanel .sp-reason')`))
  // 回归闸:v-if/v-else 链断过一次 —— 收起状态的工具行会顺带渲染一条空正文行(满屏「↳ 名字」空行)
  ok('收起的工具行不额外吐空正文行', await ev(`[...document.querySelectorAll('.shardpanel .sp-text')].every(e => e.innerText.replace(/[↳\\s]/g,'').replace('深读者','').length > 0)`),
    await ev(`[...document.querySelectorAll('.shardpanel .sp-view > *')].map(e => e.className + '::' + JSON.stringify(e.innerText.slice(0,24))).join(' , ')`))
  await shot(win, 'orch-shard-3-mirror')

  // ── 画面4:展开某条工具行看入参/结果(原来只印一个工具名,查不动) ──
  await ev(`(() => { const t = [...document.querySelectorAll('.shardpanel .sp-tool')].find(e => /grep/.test(e.textContent)); if (t) t.click() })()`)
  await sleep(300)
  ok('工具行可展开出入参/结果', await ev(`!!document.querySelector('.shardpanel .sp-toolbody pre')`))
  await shot(win, 'orch-shard-4-toolopen')

  win.destroy()
  console.log(bad ? '\n❌ ' + bad + ' 项不通过' : '\n✅ 编排节点镜像视图全部通过')
  app.exit(bad ? 1 : 0)
})
