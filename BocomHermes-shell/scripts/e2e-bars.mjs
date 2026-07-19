// e2e 复现"三条横条":真 Chromium 加载真实 card.html,桩 BocomHermes 桥,重放批准后轮事件流,截图+倒 DOM
// 跑法: node_modules/.bin/electron scripts/e2e-bars.mjs   (产物在 /tmp/bars-e2e.png + stdout DOM 清单)
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const dir = path.dirname(fileURLToPath(import.meta.url))

const STUB_PRELOAD = path.join(dir, 'e2e-bars-preload.cjs')
fs.writeFileSync(STUB_PRELOAD, `
const { contextBridge } = require('electron')
let streamCb = null
const async0 = async () => null
contextBridge.exposeInMainWorld('BocomHermes', {
  onStream: (f) => { streamCb = f },
  onPermission: () => {}, onCardInject: () => {}, onCardNote: () => {}, onServeHealth: () => {}, onServeProbe: () => {}, onTheme: () => {},
  getTheme: () => 'light', getSettings: () => ({}), getDropPath: () => '', getProbeLog: async () => [],
  cardInit: async () => ({ sessionId: 'w1', project: 'demo', dir: 'C:/demo', model: null, reattached: false }),
  cardSend: async () => { await new Promise((r) => setTimeout(r, 60000)); return '' },   // 60s 窗口:一直"在跑"
  cardAbort: async0, cardReinit: async0, cardSetModel: async0, cardPickProject: async0,
  listModels: async () => [], readFileText: async () => ({ ok: false, err: 'stub' }),
  memoryRead: async () => '', memoryWrite: async0, skillsList: async () => [], skillsOpenDir: async0,
  todoAdd: async0, notifyTodosUpdated: async0, applyDiff: async0, currentDiff: async0, getCardFiles: async () => [],
  openLoc: () => {}, permissionReply: () => {}, probeNow: () => {}, reportBusy: () => {},
  closeSelf: () => {}, minimizeSelf: () => {}, toggleMaximize: () => {}, togglePin: () => {},
})
contextBridge.exposeInMainWorld('__fire', (ev) => { if (streamCb) streamCb(JSON.parse(JSON.stringify(ev))) })
`)

app.whenReady().then(async () => {
  console.log('[e2e] ready')
  const win = new BrowserWindow({
    width: 640, height: 760, show: false,
    webPreferences: { preload: STUB_PRELOAD, contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.on('console-message', (_e, _l, msg) => { if (!/VERBOSE|Autofill/.test(msg)) console.log('[page]', msg.slice(0, 200)) })
  win.webContents.on('did-fail-load', (_e, c, d) => console.log('[e2e] load failed', c, d))
  await win.loadFile(path.join(dir, '..', 'ui', 'card.html'), { query: { wf: '1', title: '工作流 · 测', msg: '分析下这个项目' } })
  console.log('[e2e] loaded')
  await new Promise((r) => setTimeout(r, 1200))   // boot:cardInit → 首轮发出(挂 60s)

  const fire = (ev) => win.webContents.executeJavaScript(`__fire(${JSON.stringify(ev)})`)
  // 批准后轮的真实事件形状(按 serve 消息流重放)
  await fire({ kind: 'reasoning', partID: 'r1', text: 'Now let me start executing the plan. I will parallel.' })
  await fire({ kind: 'text', partID: 't1', text: '开始执行。前三项彼此独立，并行派子 Agent 深读。' })
  await fire({ kind: 'tool', text: 'todowrite', partID: 'call_td:tool', status: 'completed', input: { todos: [{ content: '后端模块架构深读', status: 'in_progress' }, { content: '前端模块架构深读', status: 'pending' }, { content: '数据库 schema 全貌', status: 'pending' }, { content: '运维部署体系', status: 'pending' }, { content: '测试体系', status: 'pending' }, { content: '综合产出报告', status: 'pending' }] } })
  const tasks = [['call_A', 'ses_A', '后端模块架构深读'], ['call_B', 'ses_B', '前端模块架构深读'], ['call_C', 'ses_C', '数据库 schema 全貌']]
  for (const [cid, gid, desc] of tasks) {
    await fire({ kind: 'tool', text: 'task', partID: cid + ':tool', status: 'running', input: { description: desc, prompt: '深读该模块,带 file:行号' }, title: desc, taskChild: gid, taskDesc: desc })
    await fire({ kind: 'reasoning', partID: gid + 'r1', text: '子agent开始思考', sub: true, agentId: gid, agentName: desc })
    await fire({ kind: 'tool', text: 'read', partID: gid + 'rd1:tool', status: 'running', input: { filePath: 'src/a.js' }, sub: true, agentId: gid, agentName: desc })
  }
  await new Promise((r) => setTimeout(r, 800))

  // 暴力枚举:各种异形工具事件,看哪种产出"全宽+蓝左条+空"的细条
  const variants = [
    ['v1', { kind: 'tool', text: 'todowrite', partID: 'v1:tool', status: 'completed', input: {} }],
    ['v2', { kind: 'tool', text: 'todowrite', partID: 'v2:tool', status: 'completed', input: { todos: [] } }],
    ['v3', { kind: 'tool', text: 'todowrite', partID: 'v3:tool', status: 'completed', input: '{"todos":[{"content":"x","status":"pending"}]}' }],
    ['v4', { kind: 'tool', text: 'todowrite', partID: 'v4:tool', status: 'running', input: null }],
    ['v5', { kind: 'tool', text: '', partID: 'v5:tool', status: 'completed', input: {}, title: '' }],
    ['v6', { kind: 'tool', text: 'todoread', partID: 'v6:tool', status: 'completed', input: {} }],
    ['v7', { kind: 'tool', text: 'todowrite', partID: 'v7:tool', status: 'completed', input: { todos: 'not-array' } }],
  ]
  for (const [, ev] of variants) await fire(ev)
  await new Promise((r) => setTimeout(r, 400))

  const dump2 = await win.webContents.executeJavaScript(`(function(){
    const feed = document.getElementById('feed')
    return Array.from(feed.children).slice(-10).map((c) => {
      const r = c.getBoundingClientRect()
      return [c.tagName.toLowerCase(), c.className, 'hidden=' + c.hidden, 'h=' + Math.round(r.height), 'w=' + Math.round(r.width), JSON.stringify((c.innerText || '').replace(/\\s+/g, ' ').slice(0, 40))].join(' | ')
    }).join('\\n')
  })()`)
  console.log('=== 异形事件后的 feed 尾部 ===\n' + dump2)

  const dump = await win.webContents.executeJavaScript(`(function(){
    const feed = document.getElementById('feed')
    const lines = Array.from(feed.children).map((c) => {
      const r = c.getBoundingClientRect()
      return [c.tagName.toLowerCase(), c.className, 'open=' + (c.open === undefined ? '-' : c.open), 'h=' + Math.round(r.height), 'w=' + Math.round(r.width), JSON.stringify((c.innerText || '').replace(/\\s+/g, ' ').slice(0, 50))].join(' | ')
    })
    // 找出所有高度 < 14px 的后代元素(细条嫌疑人),报标签/class/前 120 字 outerHTML
    const thin = []
    feed.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.height > 0 && r.height < 14 && r.width > 200) thin.push(el.tagName.toLowerCase() + '.' + el.className + ' h=' + Math.round(r.height) + ' w=' + Math.round(r.width) + ' :: ' + el.outerHTML.slice(0, 160).replace(/\\n/g, ' '))
    })
    return lines.join('\\n') + '\\n=== 细条嫌疑元素 ===\\n' + thin.join('\\n')
  })()`)
  console.log('=== feed 孩子(真实渲染) ===\n' + dump)

  const shot = await win.webContents.capturePage()
  fs.writeFileSync('/tmp/bars-e2e.png', shot.toPNG())
  console.log('screenshot: /tmp/bars-e2e.png')
  app.exit(0)
})
