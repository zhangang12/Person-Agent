// 自测:src/session.js(卡片↔opencode 会话 IPC 层)—— 本波改动逐条过:
//   R6 提问清理 / R7 发送失败塞回背景 / R8 stale 换 id / C2 知识懒构建 / C4 本地转录(增量·截断·轮转·回放兜底)/
//   P1 onRawMessages 降轮询 / P4 看门狗 limit 拉取 / T5 产物轨道 / 错误码人话 / C1 模型列表缓存版 /
//   P3.3 todo 权威同步 / P3.4 promptAsync knob 透传。
// 跑法:npm run session:test(零依赖 ok() 风格;假 ipcMain/oc/电子壳全注入,不连真 serve/模型;真 fs 只碰临时目录)
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
const require = createRequire(import.meta.url)

// ── 假 electron:session.js 里 require('electron').app.getPath('userData') → 指到临时 userData ──
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-session-ud-'))
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-session-proj-'))
const Module = require('module')
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => UD } }
  return origLoad.apply(this, arguments)
}

// ── 假定时器:setInterval/clearInterval 全捕获(看门狗 90s、补渲染轮询 1.2s/5s),进程不被定时器拖住 ──
const intervals = []   // { fn, ms, id }(clearInterval 时摘除)
let nextTimerId = 1
const realSetInterval = global.setInterval, realClearInterval = global.clearInterval
global.setInterval = (fn, ms) => { const id = nextTimerId++; intervals.push({ fn, ms, id }); return id }
global.clearInterval = (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1) }

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
const tick = () => new Promise((r) => setImmediate(r))
const txFileOf = (sid) => path.join(UD, 'transcripts', String(sid).replace(/[^\w-]/g, '_') + '.jsonl')

// ── 测试装配:每个用例一套全新 S/ipcMain/oc(工厂可重复调用,各注册各的 handler)──
let sidSeq = 0
function makeHarness(over = {}) {
  const handlers = {}
  const ipcMain = { handle: (n, fn) => { handlers[n] = fn }, on: (n, fn) => { handlers[n] = fn } }
  const calls = { ensureServe: 0, listModels: [], getRawMessages: [], rejectQuestion: [], recordHistory: [], replaceHistoryId: [], sendMessage: [] }
  const serve = { base: 'http://127.0.0.1:4999', dir: PROJ }
  const oc = Object.assign({
    AUTO_ALLOW: new Set(),
    ensureServe: async () => { calls.ensureServe++; return serve },
    createSession: async () => 'ses_t' + (++sidSeq),
    sessionExists: async () => false,
    getMessages: async () => [],
    sendMessage: async (...a) => { calls.sendMessage.push(a); return '终答文本' },
    listModels: async (...a) => { calls.listModels.push(a); return [] },
    abort: async () => {}, replyPermission: () => {}, replyQuestion: async () => {},
    rejectQuestion: (...a) => { calls.rejectQuestion.push(a) },
    listSessions: async () => [],
    getRawMessages: (...a) => { calls.getRawMessages.push(a); return [] },
    generationStalled: () => false,
    pollTurnParts: async () => [],
    getSessionUsage: () => null,
    retireIfOrphan: () => false,
  }, over.oc || {})
  const S = Object.assign({
    settings: {}, history: [],
    sessionByWc: new Map(), sessionInfo: new Map(),
    pendingPerm: new Map(), pendingQuestion: new Map(),
    streamBuf: new Map(), sentPrompt: new Map(), firstMsgCtx: new Map(),
    cardDir: new Map(), modelByWc: new Map(),
  }, over.S || {})
  const recordHistory = (...a) => { calls.recordHistory.push(a) }
  const replaceHistoryId = over.replaceHistoryId && ((...a) => { calls.replaceHistoryId.push(a); return over.replaceHistoryId(...a) })
  require('../src/session.js')(S, { ipcMain, path, fs, shell: { openPath: async () => '' }, oc, log: () => {}, recordHistory, touchHistory: () => {}, replaceHistoryId })
  return { handlers, S, oc, calls, serve }
}
const mkEv = (id) => { const sent = []; return { sent, sender: { id, send: (ch, p) => sent.push({ ch, p }), isDestroyed: () => false } } }
// 开一张新卡(走真 card-init),返回 { h, ev, sid }
async function openCard(h, wcId) {
  const ev = mkEv(wcId)
  const r = await h.handlers['card-init'](ev, {})
  return { ev, sid: r.sessionId, initRet: r }
}

async function main() {

console.log('用例1:R6 dropPendingQuestion —— 会话没了,它名下未答提问逐个 reject 再删(契约:挂在 S 上)')
{
  const h = makeHarness()
  h.S.pendingQuestion.set('q1', { sessionId: 'ses_a', v2: false, serve: h.serve })
  h.S.pendingQuestion.set('q2', { sessionId: 'ses_a', v2: true, serve: h.serve })
  h.S.pendingQuestion.set('q3', { sessionId: 'ses_b', v2: false, serve: h.serve })
  ok('S.dropPendingQuestion 已导出(window.js 关卡清理链来接)', typeof h.S.dropPendingQuestion === 'function')
  h.S.dropPendingQuestion('ses_a')
  ok('该会话条目全删,别的会话不动', !h.S.pendingQuestion.has('q1') && !h.S.pendingQuestion.has('q2') && h.S.pendingQuestion.has('q3'))
  ok('逐个 rejectQuestion(v2/ serve 透传)', h.calls.rejectQuestion.length === 2
    && h.calls.rejectQuestion.some((a) => a[0] === h.serve && a[1] === 'ses_a' && a[2] === 'q1' && a[3] === false)
    && h.calls.rejectQuestion.some((a) => a[2] === 'q2' && a[3] === true), h.calls.rejectQuestion)
  h.S.dropPendingQuestion(null); h.S.dropPendingQuestion('ses_不存在')
  ok('空参/未知会话不炸', true)
}

console.log('用例2:R8 stale 历史 —— 带 sid 重开且会话已不在,replaceHistoryId 原地换 id;deps 缺席退化新增')
{
  const h = makeHarness({ replaceHistoryId: () => {} })
  const r = await h.handlers['card-init'](mkEv(31), { sid: 'ses_old', title: '旧会话' })
  ok('stale 重开:新会话 + stale 标记 + running:false', r.stale === true && r.reattached === false && r.running === false, r)
  ok('replaceHistoryId(旧sid, 新sid) 被调一次', h.calls.replaceHistoryId.length === 1 && h.calls.replaceHistoryId[0][0] === 'ses_old' && h.calls.replaceHistoryId[0][1] === r.sessionId, h.calls.replaceHistoryId)
  ok('走换 id 时不再 recordHistory 新增条目', h.calls.recordHistory.length === 0, h.calls.recordHistory)

  const h2 = makeHarness()
  const r2 = await h2.handlers['card-init'](mkEv(32), { sid: 'ses_old', title: '旧会话' })
  ok('deps 没给 → recordHistory 退化新增(现状)', h2.calls.recordHistory.length === 1 && h2.calls.recordHistory[0][0] === r2.sessionId)

  const h3 = makeHarness({ replaceHistoryId: () => { throw new Error('boom') } })
  const r3 = await h3.handlers['card-init'](mkEv(33), { sid: 'ses_old', title: '旧会话' })
  ok('replaceHistoryId 抛错 → 兜底 recordHistory,开卡不炸', h3.calls.recordHistory.length === 1 && r3.stale === true)
}

console.log('用例3:C2 知识懒构建 —— 开卡留占位,首条发送用完整消息做 target 现场命中;未命中退新→旧')
{
  // 真知识库文件(无锚点条目,跳过 C1-C4 防腐检查,专注两级索引命中):场景词「计息/跑批」
  const K = require('../src/knowledge.js')
  const kf = K.fileFor(PROJ, UD)
  fs.mkdirSync(path.dirname(kf), { recursive: true })
  fs.writeFileSync(kf, '# 项目知识库\n\n## 2026-07-20\n\n- [verified] 计息规则在 InterestCalc 的 monthly() 里,按月复利 (场景: 计息/跑批)\n')

  const h = makeHarness(); h.S.settings.projectDir = PROJ
  const { ev, sid } = await openCard(h, 41)
  ok('开卡后背景含 KNOWLEDGE_SLOT 占位(知识尚未注入)', (h.S.firstMsgCtx.get(sid) || '').includes('KNOWLEDGE_SLOT'))
  await h.handlers['card-send'](ev, { text: '帮我看下计息逻辑' })
  const sentMsg = h.calls.sendMessage[0][2]
  ok('知识按首条消息命中拼进发出全文(场景命中注记)', sentMsg.includes('场景命中 1 条优先注入') && sentMsg.includes('计息规则在 InterestCalc'), sentMsg.slice(-400))
  ok('占位符不外泄给 serve', !sentMsg.includes('KNOWLEDGE_SLOT'))
  const note = ev.sent.find((s) => s.ch === 'card-note' && /已随首条消息注入背景/.test(s.p.text))
  ok('注入提示文案准确(含"项目知识（按首条消息命中）")', !!note && note.p.text.includes('项目知识（按首条消息命中）'), note && note.p.text)

  const h2 = makeHarness(); h2.S.settings.projectDir = PROJ
  const { ev: ev2 } = await openCard(h2, 42)
  await h2.handlers['card-send'](ev2, { text: '今天天气怎么样' })
  const sent2 = h2.calls.sendMessage[0][2]
  ok('未命中场景 → 新→旧退化注入(无命中注记)', sent2.includes('<项目知识(') && !sent2.includes('场景命中'), sent2.slice(-300))
  const note2 = ev2.sent.find((s) => s.ch === 'card-note' && /已随首条消息注入背景/.test(s.p.text))
  ok('未命中时文案不虚报"命中"', !!note2 && note2.p.text.includes('项目知识') && !note2.p.text.includes('命中'), note2 && note2.p.text)
}

console.log('用例4:C4 本地转录 —— 增量落盘、reasoning 截 500、tools 透传、超 2MB 轮转截头、回放兜底')
{
  const h = makeHarness(); h.S.settings.projectDir = PROJ
  const { ev, sid } = await openCard(h, 51)
  h.oc.getMessages = async () => [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '答一', reasoning: 'R'.repeat(800), tools: [{ name: 'read', status: 'completed' }], files: [{ path: '/x/a.png' }] },
  ]
  await h.handlers['card-send'](ev, { text: '你好' })
  const f = txFileOf(sid)
  ok('转录文件已写 userData/transcripts/<sid>.jsonl', fs.existsSync(f), f)
  const lines1 = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  ok('增量 2 行(user+assistant),字段形状 {role,text,at,...}', lines1.length === 2 && lines1[0].role === 'user' && lines1[1].role === 'assistant' && typeof lines1[1].at === 'number')
  ok('reasoning 截 500 字', lines1[1].reasoning.length === 500, lines1[1].reasoning.length)
  ok('tools/files 新形状透传', lines1[1].tools[0].name === 'read' && lines1[1].files[0].path === '/x/a.png')

  h.oc.getMessages = async () => [
    { role: 'user', text: '你好' }, { role: 'assistant', text: '答一' },
    { role: 'user', text: '二问' }, { role: 'assistant', text: '答二' },
  ]
  await h.handlers['card-send'](ev, { text: '二问' })
  const lines2 = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  ok('第二轮只 append 增量(总 4 行,第 3 行是二问)', lines2.length === 4 && lines2[2].text === '二问' && lines2[3].text === '答二', lines2.length)

  // 轮转:一轮塞进 ~2.1MB → 截头保尾(消息条数必须递增 —— 增量游标按条数走,真实场景每轮至少 +2)
  const big = 'X'.repeat(1024 * 1024)
  h.oc.getMessages = async () => [
    { role: 'user', text: '你好' }, { role: 'assistant', text: '答一' },
    { role: 'user', text: '二问' }, { role: 'assistant', text: '答二' },
    { role: 'user', text: big }, { role: 'assistant', text: big },
    { role: 'user', text: '尾巴问题' }, { role: 'assistant', text: '尾巴回答' },
  ]
  await h.handlers['card-send'](ev, { text: '三问' })
  const st = fs.statSync(f)
  ok('单文件超 2MB 轮转截头(体积 ≤ 2MB)', st.size <= 2 * 1024 * 1024, st.size)
  const lines3 = fs.readFileSync(f, 'utf8').trim().split('\n')
  ok('截头在整行边界(每行都是合法 JSON)', lines3.every((l) => { try { JSON.parse(l); return true } catch { return false } }))
  ok('尾部消息保留(尾巴回答在)', lines3.some((l) => l.includes('尾巴回答')))

  // 回放兜底:新装配(转录游标归零),serve 历史空 → 本地转录拼回放
  const h2 = makeHarness(); h2.S.settings.projectDir = PROJ
  h2.oc.sessionExists = async () => true
  h2.oc.getMessages = async () => []
  const rr = await h2.handlers['card-init'](mkEv(52), { sid })
  ok('reattach 且 serve 历史空 → 本地转录回放', rr.reattached === true && Array.isArray(rr.messages) && rr.messages.length >= 2 && rr.messages.some((m) => m.text === '尾巴回答'), rr.messages && rr.messages.length)
  ok('回放兜底回包带 running 字段', rr.running === false)
}

console.log('用例5:P1 onRawMessages —— hook 直达映射喂 onText;生效后 1.2s 轮询降 5s 兜底')
{
  intervals.length = 0
  let releaseSend = null
  const h = makeHarness({ oc: { sendMessage: async (...a) => { h.calls.sendMessage.push(a); return new Promise((r) => { releaseSend = () => r('终答') }) } } })
  h.S.settings.projectDir = PROJ
  const { ev } = await openCard(h, 61)
  const p = h.handlers['card-send'](ev, { text: 'x' })
  await tick()
  const opts = h.calls.sendMessage[0] && h.calls.sendMessage[0][6]
  ok('sendMessage 第七参带 onRawMessages hook(老版本忽略=无害)', opts && typeof opts.onRawMessages === 'function')
  ok('轮询 1.2s 起步(hook 未火时)', intervals.some((t) => t.ms === 1200))
  opts.onRawMessages([
    { info: { role: 'user' }, parts: [{ id: 'u1', type: 'text', text: 'x' }] },
    { info: { role: 'assistant' }, parts: [
      { id: 'p1', type: 'text', text: '流式片段' },
      { id: 't1', callID: 'c9', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'a.js' } } },
    ] },
  ])
  ok('hook 生效 → 轮询降 5s(旧 1.2s 已摘)', intervals.some((t) => t.ms === 5000) && !intervals.some((t) => t.ms === 1200), intervals.map((t) => t.ms))
  const streams = ev.sent.filter((s) => s.ch === 'card-stream')
  ok('hook 列表同构映射:text part 直达卡片', streams.some((s) => s.p.partID === 'p1' && s.p.text === '流式片段'))
  ok('工具 partID 同构(callID+:tool,与轮询/SSE 幂等)', streams.some((s) => s.p.partID === 'c9:tool' && s.p.kind === 'tool' && s.p.text === 'read'))
  releaseSend(); await p
}

console.log('用例6:P4 看门狗降载 —— 判挂先带 {limit:1} 拉,返回形状不对回退全量')
{
  intervals.length = 0
  const h = makeHarness(); h.S.settings.projectDir = PROJ
  const { sid } = await openCard(h, 71)
  h.S.isCardBusy = () => true
  h.oc.listSessions = async () => [{ id: 'ses_child', parentID: sid, title: '子任务', time: { updated: Date.now() - 10 * 60 * 1000 } }]
  const aborted = []
  h.oc.abort = async (...a) => { aborted.push(a) }
  h.oc.generationStalled = () => true
  const wd = intervals.filter((t) => t.ms === 90000).pop()
  ok('看门狗定时器已挂(90s)', !!wd)
  await wd.fn()
  ok('先带 {limit:1} 拉最后一条', h.calls.getRawMessages.length >= 1 && JSON.stringify(h.calls.getRawMessages[0][2]) === '{"limit":1}', h.calls.getRawMessages)
  ok('判死后自动中止子会话', aborted.some((a) => a[1] === 'ses_child'))

  // 老版本 oc(忽略第三参返回非数组)→ 回退全量再判
  const h2 = makeHarness(); h2.S.settings.projectDir = PROJ
  const { sid: sid2 } = await openCard(h2, 72)
  h2.S.isCardBusy = () => true
  h2.oc.listSessions = async () => [{ id: 'ses_child2', parentID: sid2, title: '子', time: { updated: Date.now() - 10 * 60 * 1000 } }]
  h2.oc.getRawMessages = async (...a) => { h2.calls.getRawMessages.push(a); return 'not-an-array' }   // 第一次(limit)返回坏形状
  let fellBack = false
  h2.oc.generationStalled = (msgs) => { fellBack = fellBack || Array.isArray(msgs); return false }
  h2.calls.getRawMessages.length = 0
  const wd2 = intervals.filter((t) => t.ms === 90000).pop()
  let n = 0
  h2.oc.getRawMessages = async (...a) => { h2.calls.getRawMessages.push(a); return ++n === 1 ? 'bad' : [] }   // limit 次坏,全量次好
  await wd2.fn()
  ok('limit 返回坏形状 → 回退全量再拉一次', h2.calls.getRawMessages.length === 2 && h2.calls.getRawMessages[1].length === 2, h2.calls.getRawMessages.map((c) => c.length))
}

console.log('用例7:T5 编排产物轨道 —— skill_run/mail_send/doc_read → S.wfAction(未完成/失败不上报;缺席跳过)')
{
  const h = makeHarness()
  const ev = mkEv(81)
  h.S.sessionInfo.set('ses_x', { wc: ev.sender, serve: h.serve })
  const acts = []
  h.S.wfAction = (wcId, a) => acts.push([wcId, a])
  const onText = h.S.handlers.onText
  onText({ sessionId: 'ses_x', role: 'assistant', kind: 'tool', text: 'skill_run', partID: 'p1:tool', status: 'completed', toolOutput: '回放完成\n导出/下载文件(2 个,用 doc_read 读内容):\n  · /tmp/a.csv\n  · /tmp/b.xlsx' })
  ok('skill_run 报告下载行 → 两个 skill 产物(label=名 detail=路径)', acts.filter(([, a]) => a.kind === 'skill').length === 2 && acts[0][0] === 81 && acts[0][1].detail === '/tmp/a.csv' && acts[0][1].label.includes('a.csv'), acts)
  acts.length = 0
  onText({ sessionId: 'ses_x', role: 'assistant', kind: 'tool', text: 'skill_run', partID: 'p1b:tool', status: 'completed', toolOutput: '{"ok":true,"downloads":["/tmp/c.pdf"]}' })
  ok('downloads 数组(JSON 输出)也认', acts.length === 1 && acts[0][1].detail === '/tmp/c.pdf', acts)
  acts.length = 0
  onText({ sessionId: 'ses_x', role: 'assistant', kind: 'tool', text: 'mail_send', partID: 'p2:tool', status: 'completed', toolInput: JSON.stringify({ to: 'a@b.com,c@d.com', subject: '本周周报' }) })
  ok('mail_send → mail 产物(主题+收件人)', acts.length === 1 && acts[0][1].kind === 'mail' && acts[0][1].label.includes('本周周报') && acts[0][1].detail.includes('a@b.com'), acts)
  acts.length = 0
  onText({ sessionId: 'ses_x', role: 'assistant', kind: 'tool', text: 'BocomHermes-browser_doc_read', partID: 'p3:tool', status: 'completed', toolInput: JSON.stringify({ path: '/x/y.md' }) })
  ok('doc_read(带 MCP 服务前缀)→ doc 产物(路径)', acts.length === 1 && acts[0][1].kind === 'doc' && acts[0][1].detail === '/x/y.md', acts)
  acts.length = 0
  onText({ sessionId: 'ses_x', role: 'assistant', kind: 'tool', text: 'mail_send', partID: 'p4:tool', status: 'running', toolInput: JSON.stringify({ to: 'x@y.com', subject: 's' }) })
  onText({ sessionId: 'ses_x', role: 'assistant', kind: 'tool', text: 'mail_send', partID: 'p5:tool', status: 'error', toolError: 'boom', toolInput: JSON.stringify({ to: 'x@y.com', subject: 's' }) })
  ok('未完成/失败不上报(发信是高危,半截状态绝不记)', acts.length === 0, acts)
  const h2 = makeHarness(); h2.S.sessionInfo.set('ses_x', { wc: mkEv(82).sender, serve: h2.serve })
  h2.S.handlers.onText({ sessionId: 'ses_x', role: 'assistant', kind: 'tool', text: 'skill_run', partID: 'p:tool', status: 'completed', toolOutput: 'x' })
  ok('S.wfAction 未提供 → 静默跳过不炸(契约:window.js 接线)', true)
}

console.log('用例8:错误码人话 —— 429/401/超时翻译,ECONNRESET 原文案保留,其它原样上抛')
{
  const mk = async (errMsg) => {
    const h = makeHarness({ oc: { sendMessage: async () => { throw new Error(errMsg) } } })
    h.S.settings.projectDir = PROJ
    const { ev } = await openCard(h, 88)
    try { await h.handlers['card-send'](ev, { text: 'x' }); return null } catch (e) { return e.message }
  }
  ok('429 → 内网模型限流,等 30s 重试', (await mk('POST /session/ses_t9/message -> 429: {"err":"x"}')).includes('内网模型限流（HTTP 429），等 30 秒再重试'))
  ok('401 → 鉴权过期,联系管理员', (await mk('POST /session/ses_t9/message -> 401: unauthorized')).includes('模型网关鉴权过期（HTTP 401），请联系管理员'))
  ok('ETIMEDOUT → 模型响应超时,可重试', (await mk('request failed: ETIMEDOUT')).includes('模型响应超时，可重试'))
  ok('ECONNRESET → 现有文案保留', (await mk('read ECONNRESET')).includes('引擎连接中断（serve 可能已退出）'))
  ok('其它错误原样上抛不翻译', (await mk('some random boom')) === 'some random boom')
}

console.log('用例9:R7 注入背景丢失 —— 发送失败把已消费的 firstMsgCtx 塞回,重发仍能注入')
{
  const h = makeHarness({ oc: { sendMessage: async () => { throw new Error('POST /x -> 429: nope') } } })
  h.S.settings.projectDir = PROJ
  const { ev, sid } = await openCard(h, 91)
  try { await h.handlers['card-send'](ev, { text: '问一' }) } catch {}
  const restored = h.S.firstMsgCtx.get(sid) || ''
  ok('失败后背景塞回(知识已懒拼入,占位不再)', restored.includes('<项目背景>') && !restored.includes('KNOWLEDGE_SLOT'), restored.slice(0, 120))
  h.oc.sendMessage = async (...a) => { h.calls.sendMessage.push(a); return 'ok' }
  await h.handlers['card-send'](ev, { text: '问一' })
  ok('重发成功:背景随首发消费(含项目背景段)', h.calls.sendMessage[0][2].includes('<项目背景>') && !h.S.firstMsgCtx.has(sid))
}

console.log('用例10:C1 模型列表 —— 无 serve 不白起引擎;有 serve 走缓存版,force 仅显式刷新透传')
{
  const h = makeHarness()
  const r0 = await h.handlers['list-models'](mkEv(101), undefined)
  ok('本卡无 serve → { models: [], note: 引擎未启动 }', r0 && Array.isArray(r0.models) && r0.models.length === 0 && /引擎未启动/.test(r0.note || ''), r0)
  ok('不再 ensureServe 白起引擎', h.calls.ensureServe === 0, h.calls.ensureServe)

  h.S.settings.projectDir = PROJ
  const { ev } = await openCard(h, 101)
  h.oc.listModels = async (...a) => { h.calls.listModels.push(a); return [{ providerID: 'p', modelID: 'm', name: 'M' }] }
  const r1 = await h.handlers['list-models'](ev, { force: true })
  ok('有 serve → 模型数组(渲染层形状不变)', Array.isArray(r1) && r1.length === 1 && r1[0].modelID === 'm', r1)
  ok('opts.force 透传给 oc 缓存版', h.calls.listModels[0] && h.calls.listModels[0][1] && h.calls.listModels[0][1].force === true, h.calls.listModels[0])
  await h.handlers['list-models'](ev, undefined)
  ok('不显式刷新 → force=false(吃缓存)', h.calls.listModels[1][1].force === false)
}

console.log('用例11:契约补件 —— consumeAbortFlag 标记已手动停止;reattach 回包 running 反映进行中回合')
{
  const h = makeHarness(); h.S.settings.projectDir = PROJ
  h.oc.consumeAbortFlag = () => true
  const { ev } = await openCard(h, 111)
  await h.handlers['card-send'](ev, { text: 'x' })
  ok('回合收尾取 consumeAbortFlag → 卡内留「已手动停止」灰字', ev.sent.some((s) => s.ch === 'card-note' && /已手动停止/.test(s.p.text)), ev.sent.filter((s) => s.ch === 'card-note').map((s) => s.p.text))

  // 发送挂起中重开同会话 → running:true;回合结束后再开 → false
  intervals.length = 0
  let release = null
  const h2 = makeHarness({ oc: { sendMessage: async () => new Promise((r) => { release = () => r('ok') }) } })
  h2.S.settings.projectDir = PROJ
  const { sid } = await openCard(h2, 112)
  h2.oc.sessionExists = async () => true
  const p = h2.handlers['card-send'](h2.S.sessionInfo.get(sid).wc === undefined ? mkEv(112) : { sender: h2.S.sessionInfo.get(sid).wc }, { text: 'x' })
  await tick()
  const rr = await h2.handlers['card-init'](mkEv(112), { sid })
  ok('回合进行中 reattach → running:true', rr.running === true, rr.running)
  release(); await p
  const rr2 = await h2.handlers['card-init'](mkEv(112), { sid })
  ok('回合已结束 reattach → running:false', rr2.running === false, rr2.running)
}

console.log('用例12:用户权限规则(P2.3 壳层轨) —— deny 先判/allow 免弹框/分片同规/通配匹配')
{
  const mkWc = (id) => ({ id, isDestroyed: () => false, send: () => {} })
  const h = makeHarness()
  const wc = mkWc(991)
  const sid = 'ses_perm1'
  h.S.sessionByWc.set(wc.id, sid)
  h.S.sessionInfo.set(sid, { serve: h.serve, wc })
  h.S.settings.permRules = { allow: ['bash(git *)'], deny: ['bash(rm -rf*)', 'write(*.env)'] }
  const replies = []
  h.oc.replyPermission = (serve, sessionId, requestId, d) => replies.push({ requestId, d })
  h.S.handlers.onPermission({ sessionId: sid, requestId: 'r1', tool: 'bash', detail: 'rm -rf /tmp/x' })
  ok('deny 命中即拒(reject)', replies[0] && replies[0].d === 'reject', replies[0])
  h.S.handlers.onPermission({ sessionId: sid, requestId: 'r2', tool: 'write', detail: '/proj/.env' })
  ok('deny 通配 *.env 命中', replies[1] && replies[1].d === 'reject', replies[1])
  h.S.handlers.onPermission({ sessionId: sid, requestId: 'r3', tool: 'bash', detail: 'git status' })
  ok('allow 命中免弹框(once)', replies[2] && replies[2].d === 'once', replies[2])
  h.S.handlers.onPermission({ sessionId: sid, requestId: 'r4', tool: 'bash', detail: 'npm test' })
  ok('不命中维持弹框路径(登记 pendingPerm)', h.S.pendingPerm.has('r4') && !replies.find((x) => x.requestId === 'r4'))
  h.S.handlers.onPermission({ sessionId: sid, requestId: 'r5', tool: 'write', detail: 'rm -rf /tmp/x' })
  ok('工具名不匹配不拦(write 不命中 bash 规则)', h.S.pendingPerm.has('r5') && !replies.find((x) => x.requestId === 'r5' && x.d === 'reject'))

  const h2 = makeHarness()
  const wc2 = mkWc(992)
  const sid2 = 'ses_perm2'
  h2.S.sessionByWc.set(wc2.id, sid2)
  h2.S.sessionInfo.set(sid2, { serve: h2.serve, wc: wc2 })
  h2.S.shardWc = new Set([wc2.id])
  h2.S.settings.permRules = { deny: ['bash(rm -rf*)'] }
  const replies2 = []
  h2.oc.replyPermission = (serve, sessionId, requestId, d) => replies2.push({ requestId, d })
  h2.S.handlers.onPermission({ sessionId: sid2, requestId: 's1', tool: 'bash', detail: 'rm -rf /tmp/x' })
  ok('分片卡 deny 先于自动放行', replies2[0] && replies2[0].d === 'reject', replies2[0])
  h2.S.handlers.onPermission({ sessionId: sid2, requestId: 's2', tool: 'bash', detail: 'npm test' })
  ok('分片卡非 deny 维持自动放行(once)', replies2[1] && replies2[1].d === 'once', replies2[1])
}

console.log('用例12b:permMode auto —— 写/执行自动放行;deny 红线仍先判;edit 预检未命中仍拒/命中放行;审计留痕不弹框')
{
  const mkWc = (id) => ({ id, isDestroyed: () => false, send: () => {} })
  const h = makeHarness()
  const wc = mkWc(993)
  const sid = 'ses_auto1'
  h.S.sessionByWc.set(wc.id, sid)
  h.S.sessionInfo.set(sid, { serve: h.serve, wc })
  h.S.settings.permMode = 'auto'
  h.S.settings.permRules = { deny: ['bash(rm -rf*)'] }
  const audits = []
  h.S.audit = (...a) => audits.push(a)
  const replies = []
  h.oc.replyPermission = (serve, sessionId, requestId, d) => replies.push({ requestId, d })

  h.S.handlers.onPermission({ sessionId: sid, requestId: 'a1', tool: 'bash', detail: 'npm test' })
  ok('auto:bash 自动放行(once)', replies[0] && replies[0].d === 'once', replies[0])
  ok('auto:不登记 pendingPerm(不弹框)', !h.S.pendingPerm.has('a1'))
  ok('auto:放行记审计', audits.some((a) => a[0] === 'permission' && /auto/.test(String(a[1]))), audits)

  h.S.handlers.onPermission({ sessionId: sid, requestId: 'a2', tool: 'bash', detail: 'rm -rf /tmp/x' })
  ok('auto:deny 红线仍先判(reject)', !!replies.find((x) => x.requestId === 'a2' && x.d === 'reject'), replies)

  // edit 预检(async 链,等两拍落停):真文件不含 oldString → 拒;含 → 放行
  fs.writeFileSync(path.join(PROJ, 'target-file.txt'), 'line1 actual content\nline2\n')
  h.oc.getRawMessages = async () => [{ parts: [{ type: 'tool', tool: 'edit', state: { status: 'running', input: { filePath: 'target-file.txt', oldString: '根本不存在的旧内容', newString: 'x' } } }] }]
  h.S.handlers.onPermission({ sessionId: sid, requestId: 'a3', tool: 'edit', detail: 'target-file.txt' })
  await tick(); await tick()
  ok('auto:edit 预检未命中仍拒(reject)', !!replies.find((x) => x.requestId === 'a3' && x.d === 'reject'), replies)
  h.oc.getRawMessages = async () => [{ parts: [{ type: 'tool', tool: 'edit', state: { status: 'running', input: { filePath: 'target-file.txt', oldString: 'line1 actual content', newString: 'x' } } }] }]
  h.S.handlers.onPermission({ sessionId: sid, requestId: 'a4', tool: 'edit', detail: 'target-file.txt' })
  await tick(); await tick()
  ok('auto:edit 预检通过自动放行(once)', !!replies.find((x) => x.requestId === 'a4' && x.d === 'once'), replies)

  // 分片卡不受 auto 影响(分片分支在前,本就自动放行 + 写归属闸)—— 这里只验 auto 不把 deny 翻掉
  const h2 = makeHarness()
  const wc2 = mkWc(994)
  const sid2 = 'ses_auto2'
  h2.S.sessionByWc.set(wc2.id, sid2)
  h2.S.sessionInfo.set(sid2, { serve: h2.serve, wc: wc2 })
  h2.S.shardWc = new Set([wc2.id])
  h2.S.settings.permMode = 'auto'
  h2.S.settings.permRules = { deny: ['write(*.env)'] }
  const replies2 = []
  h2.oc.replyPermission = (serve, sessionId, requestId, d) => replies2.push({ requestId, d })
  h2.S.handlers.onPermission({ sessionId: sid2, requestId: 'b1', tool: 'write', detail: '/proj/.env' })
  ok('auto+分片:deny 仍不可翻(reject)', replies2[0] && replies2[0].d === 'reject', replies2[0])
}

console.log('用例13:P3.3 todo 权威数据源 —— 回合收尾 getSessionTodo 非空才覆盖注册表;空/异常/无桩/非wf卡一律不动不炸')
{
  // 非空 → wfTodos(本卡, 权威清单) 被调一次,注册表被覆盖
  const h = makeHarness({ oc: { getSessionTodo: async () => [{ content: '步骤一', status: 'completed' }] } })
  h.S.settings.projectDir = PROJ
  const reg = { id: 'wf13', wcId: 131, todos: [{ content: '旧清单', status: 'pending' }] }
  h.S.wfCardByWc = new Map([[131, reg]])
  const wfCalls = []
  h.S.wfTodos = (wcId, todos) => { wfCalls.push([wcId, todos]); if (Array.isArray(todos)) reg.todos = todos }
  const { ev } = await openCard(h, 131)
  await h.handlers['card-send'](ev, { text: 'x' })
  await tick(); await tick()   // fire-and-forget 的 then 链走两拍落停
  ok('wf 卡回合收尾:getSessionTodo 非空 → wfTodos 被调一次(本卡+权威清单)', wfCalls.length === 1 && wfCalls[0][0] === 131 && wfCalls[0][1][0].content === '步骤一', wfCalls)
  ok('注册表 todos 已覆盖为 serve 权威清单', reg.todos.length === 1 && reg.todos[0].content === '步骤一', reg.todos)

  // 空数组 → wfTodos 不调(保留工具入参学习兜底)
  const h2 = makeHarness({ oc: { getSessionTodo: async () => [] } })
  h2.S.settings.projectDir = PROJ
  const reg2 = { id: 'wf13b', wcId: 132, todos: [{ content: '旧清单', status: 'pending' }] }
  h2.S.wfCardByWc = new Map([[132, reg2]])
  const calls2 = []
  h2.S.wfTodos = (...a) => { calls2.push(a) }
  const { ev: ev2 } = await openCard(h2, 132)
  await h2.handlers['card-send'](ev2, { text: 'x' })
  await tick(); await tick()
  ok('空数组 → wfTodos 不调,注册表原样', calls2.length === 0 && reg2.todos[0].content === '旧清单', calls2)

  // 异常 → wfTodos 不调,回合不炸
  const h3 = makeHarness({ oc: { getSessionTodo: async () => { throw new Error('GET /session/x/todo -> 404: nf') } } })
  h3.S.settings.projectDir = PROJ
  const reg3 = { id: 'wf13c', wcId: 133, todos: [{ content: '旧清单', status: 'pending' }] }
  h3.S.wfCardByWc = new Map([[133, reg3]])
  let wf3 = 0
  h3.S.wfTodos = () => { wf3++ }
  const { ev: ev3 } = await openCard(h3, 133)
  await h3.handlers['card-send'](ev3, { text: 'x' })
  await tick(); await tick()
  ok('getSessionTodo 抛异常 → wfTodos 未调,回合不炸', wf3 === 0 && reg3.todos[0].content === '旧清单', wf3)

  // oc 无该函数(老版本)→ typeof 守卫安全跳过
  const h4 = makeHarness()
  h4.S.settings.projectDir = PROJ
  h4.S.wfCardByWc = new Map([[134, { id: 'wf13d', wcId: 134, todos: [] }]])
  let wf4 = 0
  h4.S.wfTodos = () => { wf4++ }
  const { ev: ev4 } = await openCard(h4, 134)
  await h4.handlers['card-send'](ev4, { text: 'x' })
  await tick(); await tick()
  ok('oc.getSessionTodo 缺席(老版本)→ 安全跳过不炸', wf4 === 0)

  // 非 wf 卡(wfCardByWc 无登记)→ 根本不发请求
  let todoReqs = 0
  const h5 = makeHarness({ oc: { getSessionTodo: async () => { todoReqs++; return [{ content: 'x' }] } } })
  h5.S.settings.projectDir = PROJ
  h5.S.wfCardByWc = new Map()
  h5.S.wfTodos = () => {}
  const { ev: ev5 } = await openCard(h5, 135)
  await h5.handlers['card-send'](ev5, { text: 'x' })
  await tick(); await tick()
  ok('非 wf 卡 → 不打 todo 请求', todoReqs === 0, todoReqs)
}

console.log('用例14:P3.4 promptAsync knob —— truthy 透传 opts.promptAsync;knobs 缺席不传(原路径不动)')
{
  const h = makeHarness()
  h.S.settings.projectDir = PROJ
  h.S.settings.knobs = { promptAsync: 1 }
  const { ev } = await openCard(h, 141)
  await h.handlers['card-send'](ev, { text: 'x' })
  const opts1 = h.calls.sendMessage[0] && h.calls.sendMessage[0][6]
  ok('knobs.promptAsync=1 → sendMessage 第七参带 promptAsync:true', !!(opts1 && opts1.promptAsync === true), opts1)

  const h2 = makeHarness()
  h2.S.settings.projectDir = PROJ   // knobs 缺席
  const { ev: ev2 } = await openCard(h2, 142)
  await h2.handlers['card-send'](ev2, { text: 'x' })
  const opts2 = h2.calls.sendMessage[0] && h2.calls.sendMessage[0][6]
  ok('knobs 缺席 → 不带 promptAsync(原路径)', !!(opts2 && !('promptAsync' in opts2)), opts2)
}

  console.log('\n' + (fail ? '❌ 有失败' : '✅ 全部通过') + '  ' + pass + ' passed, ' + fail + ' failed')
  Module._load = origLoad
  global.setInterval = realSetInterval
  global.clearInterval = realClearInterval
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('自测异常中止:', e); process.exit(1) })
