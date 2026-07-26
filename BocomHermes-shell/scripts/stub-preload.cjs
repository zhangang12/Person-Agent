// P2a-2 验收 stub 桥:裸 Electron 里给 chat 页灌一套【全内存假 BocomHermes】——
// sendSync 频道全部有返回值(裸 Electron 无监听时 sendSync 会永久阻塞渲染主线程,实测);
// 流式/权限/提问/保活事件回调捕获到 cbs,页面里 window.__emit(kind, payload) 反向驱动场景。
'use strict'
const { contextBridge } = require('electron')
const cbs = {}
const flags = { planApproved: false, sendN: 0, lastSend: '', sendTexts: [] }
// ctx 三态场景用:URL query __tokens 传用量(配合 listModels 的 100k 上限);preload 在渲染进程,env 不可控,走 query 最稳
const TOKENS = Math.floor(+((new URLSearchParams(location.search)).get('__tokens'))) || 0
contextBridge.exposeInMainWorld('BocomHermes', {
  getTheme: () => 'dark',
  onTheme: () => {},
  getSettings: () => {   // query __knobs={"k":v} 传旋钮(规划倒计时/todo提醒兜底等场景)
    try { const k = JSON.parse((new URLSearchParams(location.search)).get('__knobs') || '{}'); return { knobs: k } } catch { return {} }
  },
  getHistory: () => [],
  cardInit: async () => ({ sessionId: 'stub-sid', project: 'demo-repo', dir: '/tmp/demo', model: { providerID: 'm', modelID: 'mimo-v2', name: 'MiMo V2 Free' }, reattached: false, messages: [], running: false }),
  cardSend: async (text) => {
    flags.sendN++
    flags.lastSend = String(text || '')
    flags.sendTexts.push(String(text || ''))
    if (/__slow__/.test(String(text))) {   // 慢轮(状态行/hang 探针场景):2.5s 才回
      await new Promise((r) => setTimeout(r, 2500))
      return '慢回答'
    }
    if (/__hl__/.test(String(text))) {   // 富排版目检(语法高亮/标题/引用/表格)
      const md = '## 分析报告\n\n问题定位如下：\n\n```js\n// 计算利息(30/360 口径)\nconst days = 30 * months\nfunction interest(p, rate) {\n  return p * rate * days / 360\n}\nconst total = interest(100000, 0.05)\n```\n\n> 注意：跨月分段时 2 月会少算 1-2 天。\n\n```sql\nSELECT project_code, SUM(amount) AS total\nFROM interest_accrued\nWHERE biz_date BETWEEN \'2026-01-01\' AND \'2026-03-31\'\nGROUP BY project_code\nORDER BY total DESC\nLIMIT 20\n```\n\n- 当前实现按 **30/360** 折算\n- 核心系统按 `实际天数/365` 计息\n\n| 口径 | 结果 |\n|---|---|\n| 30/360 | 1250.00 |\n| ACT/365 | 1267.12 |'
      if (cbs.stream) cbs.stream({ kind: 'text', text: md, partID: 'a1' })
      return md
    }
    if (/请运行下面这条命令/.test(String(text))) {   // 命令块「运行」target 轮:流式给输出
      if (cbs.stream) cbs.stream({ kind: 'text', text: 'total 42\n-rw-r--r--  demo.ts', partID: 'run1' })
      return 'total 42\n-rw-r--r--  demo.ts'
    }
    if (/__runcmd__/.test(String(text))) {   // 先让 AI 产出带 bash 命令块的回答(点「运行」的前置)
      const md = '先看这条命令:\n\n```bash\nls -la | wc -l\n```\n\n点运行试试。'
      if (cbs.stream) cbs.stream({ kind: 'text', text: md, partID: 'a1' })
      return md
    }
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
  onCardInject: (cb) => { cbs.inject = cb },
  onShardProgress: (cb) => { cbs.shardProgress = cb },
  wfPlanApproved: () => { flags.planApproved = true },
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
contextBridge.exposeInMainWorld('__flag', (name) => flags[name])
