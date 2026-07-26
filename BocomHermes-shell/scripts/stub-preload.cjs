// P2a-2 验收 stub 桥:裸 Electron 里给 chat 页灌一套【全内存假 BocomHermes】——
// sendSync 频道全部有返回值(裸 Electron 无监听时 sendSync 会永久阻塞渲染主线程,实测);
// 流式/权限/提问/保活事件回调捕获到 cbs,页面里 window.__emit(kind, payload) 反向驱动场景。
'use strict'
const { contextBridge } = require('electron')
const cbs = {}
// ctx 三态场景用:URL query __tokens 传用量(配合 listModels 的 100k 上限);preload 在渲染进程,env 不可控,走 query 最稳
const TOKENS = Math.floor(+((new URLSearchParams(location.search)).get('__tokens'))) || 0
contextBridge.exposeInMainWorld('BocomHermes', {
  getTheme: () => 'dark',
  onTheme: () => {},
  getSettings: () => ({}),
  getHistory: () => [],
  cardInit: async () => ({ sessionId: 'stub-sid', project: 'demo-repo', dir: '/tmp/demo', model: { providerID: 'm', modelID: 'mimo-v2', name: 'MiMo V2 Free' }, reattached: false, messages: [], running: false }),
  cardSend: async (text) => {
    if (cbs.stream) {
      cbs.stream({ kind: 'reasoning', text: '先分析用户意图,再组织回答结构…', partID: 'r1' })
      cbs.stream({ kind: 'text', text: '好的,这是**加粗**、`行内代码` 与列表:\n\n- 甲\n- 乙', partID: 'a1' })
    }
    return '好的,这是**加粗**、`行内代码` 与列表:\n\n- 甲\n- 乙'
  },
  cardAbort: () => {},
  cardReinit: async () => ({ sessionId: 'stub-sid-2', project: 'demo-repo', dir: '/tmp/demo', model: { providerID: 'm', modelID: 'mimo-v2', name: 'MiMo V2 Free' }, running: false }),
  cardUsage: async () => (TOKENS ? { tokens: TOKENS, total: TOKENS } : null),
  listModels: async () => [
    { providerID: 'm', modelID: 'mimo-v2', name: 'MiMo V2 Free', limit: { context: 100000 } },
    { providerID: 'm', modelID: 'ds-v4', name: 'DeepSeek V4 Pro', limit: { context: 64000 } },
  ],
  cardSetModel: async () => {},
  onStream: (cb) => { cbs.stream = cb },
  onCardNote: (cb) => { cbs.note = cb },
  onPermission: (cb) => { cbs.permission = cb },
  onQuestion: (cb) => { cbs.question = cb },
  onServeHealth: (cb) => { cbs.hb = cb; setTimeout(() => cb({ ok: true, port: 4096 }), 400) },
  permissionReply: () => {},
  questionReply: async () => ({ ok: true }),
  questionReject: async () => ({ ok: true }),
  readFileText: async () => ({ ok: true, text: '// src/a.ts 预览\nexport const demo = 42\nline3\nline4' }),
  reportBusy: () => {},
  skillsList: async () => [{ id: 'sk1', name: '复盘', desc: '把本轮过程整理成复盘报告' }, { id: 'sk2', name: '评审', desc: '多视角对抗评审' }],
  memoryRead: async () => '我是后端开发,优先给 Java 示例。',
  memoryWrite: async () => {},
  currentDiff: async () => 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new',
  getCardFiles: async () => [],
  togglePin: async () => true,
  closeSelf: () => {}, minimizeSelf: () => {}, toggleMaximize: () => {},
  readClipboard: async () => '',
  getDropPath: () => '',
})
contextBridge.exposeInMainWorld('__emit', (kind, payload) => { const cb = cbs[kind]; if (cb) cb(payload) })
