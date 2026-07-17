// 回归测试:确认 opencode.js 的 dispatch 能把 tool part 的 名称/入参/结果/标题/错误
// 完整抽出并经 onText 转发(卡片据此渲染成可展开工具日志块)。用真实 dispatch(__test)。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const oc = require('../opencode.js')
const { dispatch } = oc.__test

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
// 收集 onText 调用
function collect() {
  const calls = []
  return { onText: (a) => calls.push(a), calls }
}

// ── 用例1:opencode 原生 tool part(state.input/output/title/status,completed)────────
;(() => {
  console.log('用例1:completed tool part(read)')
  const { onText, calls } = collect()
  const ev = {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_1',
      part: {
        id: 'prt_a', type: 'tool', callID: 'call_x', tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: 'src/foo.js' },
          output: 'line1\nline2\nline3',
          title: 'src/foo.js',
          time: { start: 1, end: 2 },
        },
      },
    },
  }
  dispatch(ev, null, onText)
  const t = calls.find((c) => c.kind === 'tool')
  ok('产生 tool 事件', !!t)
  ok('工具名 read', t && t.text === 'read', t && t.text)
  ok('状态 completed', t && t.status === 'completed', t && t.status)
  ok('入参含 filePath', t && t.toolInput && t.toolInput.filePath === 'src/foo.js', t && t.toolInput)
  ok('结果透传', t && t.toolOutput === 'line1\nline2\nline3', t && t.toolOutput)
  ok('标题透传', t && t.toolTitle === 'src/foo.js', t && t.toolTitle)
  ok('partID 用 callID+:tool', t && t.partID === 'call_x:tool', t && t.partID)
})()

// ── 用例2:running(只有入参,还没结果)──────────────────────────────────────────
;(() => {
  console.log('用例2:running tool part(bash,尚无结果)')
  const { onText, calls } = collect()
  dispatch({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_1', part: {
      id: 'prt_b', type: 'tool', callID: 'call_y', tool: 'bash',
      state: { status: 'running', input: { command: 'git status' } },
    } },
  }, null, onText)
  const t = calls.find((c) => c.kind === 'tool')
  ok('running 状态', t && t.status === 'running', t && t.status)
  ok('入参 command', t && t.toolInput && t.toolInput.command === 'git status', t && t.toolInput)
  ok('结果为空', t && (t.toolOutput == null || t.toolOutput === ''), t && t.toolOutput)
})()

// ── 用例3:error(state.error 字符串)────────────────────────────────────────────
;(() => {
  console.log('用例3:error tool part')
  const { onText, calls } = collect()
  dispatch({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_1', part: {
      id: 'prt_c', type: 'tool', callID: 'call_z', tool: 'edit',
      state: { status: 'error', input: { filePath: 'x' }, error: '文件不存在' },
    } },
  }, null, onText)
  const t = calls.find((c) => c.kind === 'tool')
  ok('error 状态', t && t.status === 'error', t && t.status)
  ok('错误信息透传', t && t.toolError === '文件不存在', t && t.toolError)
})()

// ── 用例4:text part 仍正常(不被 tool 分支影响)──────────────────────────────────
;(() => {
  console.log('用例4:text part 不受影响')
  const { onText, calls } = collect()
  dispatch({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_1', part: { id: 'prt_t', type: 'text', text: '你好', role: 'assistant' } },
  }, null, onText)
  const t = calls.find((c) => c.kind === 'text')
  ok('text 事件正常', t && t.text === '你好' && t.kind === 'text', t)
})()

// ── pickTurnText:跨多条 assistant 消息的回合收尾判定(修"卡住/无文本输出"根因)──────
const { pickTurnText } = oc.__test
const uMsg = (t) => ({ info: { role: 'user' }, parts: [{ type: 'text', text: t }] })
const aMsg = (parts, completed) => ({ info: { role: 'assistant', time: completed ? { completed: Date.now() } : {} }, parts })
const toolPart = (status) => ({ type: 'tool', tool: 'task', state: { status } })
const textPart = (t) => ({ type: 'text', text: t })

;(() => {
  console.log('用例5:回合被拆成 [工具调用消息 + 答案消息]（核心 bug 场景）')
  // #2 user → #3 assistant(task 工具,已完成,无 text) → #4 assistant(最终答案,已完成)
  const list = [
    uMsg('帮我分析代码架构'),
    aMsg([{ type: 'reasoning', reasoning: '...' }, toolPart('completed'), { type: 'step-finish' }], true),
    aMsg([textPart('## 架构分析\n这是最终答案')], true),
  ]
  const r = pickTurnText(list)
  ok('收尾 done=true', r.done === true, r)
  ok('文本取到答案', r.text.includes('最终答案'), r.text)
})()

;(() => {
  console.log('用例6:只有工具调用消息、已完成但无文本（答案还没起）→ 必须继续等')
  const list = [uMsg('q'), aMsg([toolPart('completed'), { type: 'step-finish' }], true)]
  const r = pickTurnText(list)
  ok('done=false（不能过早收尾）', r.done === false, r)
  ok('laDone=true 但 laText 空', r.laDone === true && !r.laText, r)
})()

;(() => {
  console.log('用例7:任务运行中（工具 running,消息未完成）→ 继续等')
  const list = [uMsg('q'), aMsg([toolPart('running')], false)]
  const r = pickTurnText(list)
  ok('done=false', r.done === false, r)
})()

;(() => {
  console.log('用例8:普通纯文本回合')
  const list = [uMsg('hi'), aMsg([textPart('你好')], true)]
  const r = pickTurnText(list)
  ok('done=true 且文本正确', r.done === true && r.text === '你好', r)
})()

;(() => {
  console.log('用例9:只取最后一个 user 之后的 assistant（忽略历史轮）')
  const list = [
    uMsg('第一轮'), aMsg([textPart('旧答案')], true),
    uMsg('第二轮'), aMsg([textPart('新答案')], true),
  ]
  const r = pickTurnText(list)
  ok('文本只含新答案', r.text === '新答案', r.text)
})()

// ── 子agent(子会话)事件路由:重定向到父卡片 + 打 subagent 标记 ──────────────────
;(() => {
  console.log('用例10:session 事件建映射 → 子会话事件路由到父会话')
  const { onText, calls } = collect()
  // 子会话创建事件(带 parentID)→ 建立 子→父 映射
  dispatch({ type: 'session.updated', properties: { info: { id: 'ses_childA', parentID: 'ses_parentA', title: 'Explore (@explore subagent)' } } }, null, onText)
  // 子会话的一条 text part → 应被路由到父会话且 subagent=true
  dispatch({ type: 'message.part.updated', properties: { sessionID: 'ses_childA', part: { id: 'pA', type: 'text', text: '子agent的输出', role: 'assistant' } } }, null, onText)
  const t = calls.find((c) => c.text === '子agent的输出')
  ok('路由到父会话', t && t.sessionId === 'ses_parentA', t && t.sessionId)
  ok('标记 subagent=true', t && t.subagent === true, t && t.subagent)
  ok('带子agent名', t && /subagent/.test(t.agentName || ''), t && t.agentName)
})()

;(() => {
  console.log('用例11:无 session 事件时,从 task 工具结果里刨子会话ID兜底建映射')
  const { onText, calls } = collect()
  // 父会话里的 task 工具完成,output 开头形如 "task_id: ses_childB ..."
  dispatch({ type: 'message.part.updated', properties: { sessionID: 'ses_parentB', part: {
    type: 'tool', tool: 'task', callID: 'cB', state: { status: 'completed', output: 'task_id: ses_childB (for resuming to continue)\n\n<task_result>done</task_result>' } } } }, null, onText)
  // 该 task 事件本身属于父会话,不该被当子agent
  const tp = calls.find((c) => c.kind === 'tool' && c.text === 'task')
  ok('父会话的 task 工具 subagent=false', tp && tp.subagent === false, tp && tp.subagent)
  // 之后 ses_childB 的事件 → 应路由到父会话
  dispatch({ type: 'message.part.updated', properties: { sessionID: 'ses_childB', part: { id: 'pB', type: 'tool', tool: 'read', callID: 'rB', state: { status: 'running', input: { filePath: 'x.js' } } } } }, null, onText)
  const tc = calls.find((c) => c.kind === 'tool' && c.text === 'read')
  ok('子agent的 read 路由到父会话', tc && tc.sessionId === 'ses_parentB', tc && tc.sessionId)
  ok('子agent的 read subagent=true', tc && tc.subagent === true, tc && tc.subagent)
})()

;(() => {
  console.log('用例12:普通父会话事件不被误判为 subagent')
  const { onText, calls } = collect()
  dispatch({ type: 'message.part.updated', properties: { sessionID: 'ses_plain', part: { id: 'pP', type: 'text', text: '正常回答', role: 'assistant' } } }, null, onText)
  const t = calls.find((c) => c.text === '正常回答')
  ok('subagent=false', t && t.subagent === false, t && t.subagent)
})()

;(() => {
  console.log('用例13:abortedSince —— "被中止"只认本次发送之后的 abort(治"点过一次停止,该会话永久失去 4xx 降级重发")')
  const { abortedSince, abortedSids } = oc.__test
  const sid = 'ses_abtest'
  abortedSids.delete(sid)
  ok('从没 abort 过 → false', abortedSince(sid, Date.now() - 1000) === false)
  const abortAt = Date.now()
  abortedSids.set(sid, abortAt)   // 模拟 abort 记账(不发真 HTTP)
  ok('本次发送(t0 早于 abort)期间被中止 → true', abortedSince(sid, abortAt - 5000) === true)
  ok('abort 之后才发起的新一次发送 → false(历史账不吃)', abortedSince(sid, abortAt + 1) === false)
  ok('同一毫秒(t0===abortAt)算被中止(边界含)', abortedSince(sid, abortAt) === true)
  abortedSids.delete(sid)
})()

// 用例14:waitAssistantText 被 abort 后 ~3s 快收(以前:serve 不标 completed 就干等满 idleMs,点了停止卡片转圈 10 分钟)
await (async () => {
  console.log('用例14:waitAssistantText 中止快收(假 serve 永不收尾,只有半截文本)')
  const { waitAssistantText, abortedSids } = oc.__test
  const http = await import('node:http')
  // 假 serve:GET /session/:id/message 永远回"未完成的半截回答"(无 completed 标记,文本不再变 → 但拍 3 稳定收尾会先触发,
  // 所以文本每次都变一点,模拟"还在生成中被停止")
  let n = 0
  const srv = http.createServer((req, res) => {
    n++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify([
      { info: { role: 'user' }, parts: [{ type: 'text', text: '问题' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: '半截回答' + '.'.repeat(n) }] },
    ]))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  const sid = 'ses_fastabort'
  abortedSids.delete(sid)
  const t0 = Date.now()
  setTimeout(() => abortedSids.set(sid, Date.now()), 900)   // 0.9s 后模拟用户点「停止」
  const out = await Promise.race([
    waitAssistantText({ base }, sid, 60000, 60000),
    new Promise((r) => setTimeout(() => r('__HUNG__'), 12000)),
  ])
  const ms = Date.now() - t0
  ok('没挂死(12s 内返回,实际 ' + ms + 'ms)', out !== '__HUNG__')
  ok('停止后 ~3s 宽限即收尾(<8s)', ms < 8000, ms)
  ok('返回的是已收到的半截文本(不丢)', /^半截回答/.test(String(out)), String(out).slice(0, 20))
  abortedSids.delete(sid)
  srv.close()
})()

;(() => {
  console.log('用例15:normalizeMessages —— 续接回放不带注入前缀,历史思考链一并带回')
  const { normalizeMessages, stripInjected, splitThink } = oc.__test
  // 首条用户消息在发送时被拼上 <个人记忆>/<项目背景>/<作答技能>;serve 历史存全文,回放展示必须剥掉
  const injected = '<个人记忆>\n我是信贷后端\n</个人记忆>\n\n<项目背景>\n当前项目工作目录：C:/x\n</项目背景>\n\n<作答技能:前端UI设计>\n方法论若干\n</作答技能>\n\n帮我看这个报错'
  const msgs = normalizeMessages([
    { info: { role: 'user' }, parts: [{ type: 'text', text: injected }] },
    { info: { role: 'assistant' }, parts: [{ type: 'reasoning', text: '先查日志再定位' }, { type: 'text', text: '结论是配置错了' }] },
    { info: { role: 'user' }, parts: [{ type: 'text', text: '第二个问题' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: '<think>这轮的思考混在正文里</think>第二轮答案' }] },
  ])
  ok('用户气泡只剩原文(注入前缀全剥掉)', msgs[0].role === 'user' && msgs[0].text === '帮我看这个报错', msgs[0] && msgs[0].text)
  ok('剥离只认标记块,不误伤正文', stripInjected('正文里聊到 <个人记忆> 这个词但没闭合') === '正文里聊到 <个人记忆> 这个词但没闭合')
  ok('reasoning part 的历史思考带回', msgs[1].reasoning === '先查日志再定位', msgs[1] && msgs[1].reasoning)
  ok('正文里的 <think> 也拆进思考、正文只剩答案', msgs[3].reasoning === '这轮的思考混在正文里' && msgs[3].text === '第二轮答案', msgs[3])
  ok('每条助手消息各带各的思考(不是只有最后一轮)', !!(msgs[1].reasoning && msgs[3].reasoning))
  // splitThink 边界
  ok('未闭合 <think>(流式中途/被截断)也拆得出', splitThink('<think>想到一半就断了').think === '想到一半就断了')
  ok('无 think 原样返回', splitThink('普通正文').rest === '普通正文' && splitThink('普通正文').think === '')
})()

// 用例16:有完成标记的 serve 不许"文本稳定2s"蒙混收尾(治"模型吐一段→调>2.1s工具→续写,答案被截半截")
await (async () => {
  console.log('用例16:waitAssistantText 稳定即收只给无完成标记的 serve 兜底')
  const { waitAssistantText } = oc.__test
  const http = await import('node:http')
  let polls = 0
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url.includes('teach')) {          // 第一轮:带 completed 标记 → 教会 info 这台 serve 有收尾信号
      res.end(JSON.stringify([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q1' }] },
        { info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: '第一轮答案' }] },
      ])); return
    }
    if (req.url.includes('trunc')) {          // 第二轮:前 7 拍文本稳定但无标记(模型在调工具);第 8 拍起续写完成
      polls++
      const done = polls >= 8
      res.end(JSON.stringify([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q2' }] },
        { info: { role: 'assistant', ...(done ? { time: { completed: 1 } } : {}) }, parts: [{ type: 'text', text: done ? '前半段\n后半段' : '前半段' }] },
      ])); return
    }
    // nomark:从不给完成标记,文本稳定 → 兜底收尾必须还活着(不然这类 serve 永远收不了尾)
    res.end(JSON.stringify([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'q' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: '只有这一段' }] },
    ]))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  const info = { base }                        // 同一 info 对象跨两轮(能力学在它身上)
  const r1 = await waitAssistantText(info, 'teach', 30000, 30000)
  ok('第一轮正常收尾并学到完成标记能力', r1 === '第一轮答案' && info.hasCompletedMarker === true)
  const t0 = Date.now()
  const r2 = await waitAssistantText(info, 'trunc', 30000, 30000)
  ok('工具间隙文本稳定 >2s 不再截半截(等到真正完成)', /后半段/.test(r2), r2)
  ok('确实等过了稳定窗口(耗时 ' + Math.round((Date.now() - t0) / 100) / 10 + 's > 2.8s)', Date.now() - t0 > 2800)
  const info2 = { base }                       // 全新 info:没见过标记的 serve,稳定即收兜底必须保留
  const t1 = Date.now()
  const r3 = await waitAssistantText(info2, 'nomark', 30000, 30000)
  ok('无完成标记的 serve 仍走稳定即收(向后兼容,' + Math.round((Date.now() - t1) / 100) / 10 + 's)', r3 === '只有这一段' && Date.now() - t1 < 8000)
  srv.close()
})()

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
