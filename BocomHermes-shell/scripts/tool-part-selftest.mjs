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
  ok('剥离动态工作流规程(Claude Code 式主 Agent 规程,续接不露)', stripInjected('<动态工作流规程>\n一堆纪律\n</动态工作流规程>\n\n【总目标】\n查并发问题') === '【总目标】\n查并发问题')
  ok('剥离任务编排执行规程', stripInjected('<任务编排执行规程>\n规程\n</任务编排执行规程>\n\n跑技能X') === '跑技能X')
  ok('剥离项目知识注入块(首条消息懒构建)', stripInjected('<项目知识(excelshare)>\n(场景命中 2 条优先注入)\n- [verified] 某事实\n</项目知识>\n\n真实问题') === '真实问题')
  ok('剥离主控进度消息(分片收官 N/M)', stripInjected('<主控进度>分片「X」已完成 (2/4)。</主控进度>') === '')
  ok('剥离严格模式包装(步骤正文保留)', stripInjected('<任务编排·严格模式>\n【第 2/5 步】只执行这一步\n</任务编排·严格模式>\n跑第二步的内容') === '跑第二步的内容')
  ok('剥系统提醒尾巴(含内层 ASCII 括号,锚到消息尾)', stripInjected('我的真实问题\n\n(系统提醒:换策略(不同工具/关键词),不要再读相同的文件。)') === '我的真实问题')
  ok('系统提醒整条剥成空(回放该条自然消失)', stripInjected('(系统提醒:单次 read 读入 30000 字 —— 分段读。)') === '')
  ok('剥 OMO system-reminder 块(内网实测一长串提示词)', stripInjected('<system-reminder>\nYou are sisyphus, an elite agent...\n一大堆规则\n</system-reminder>\n\n我的真实问题') === '我的真实问题')
  ok('剥 OMO ultrawork-mode 注入块', stripInjected('<ultrawork-mode>ULTRAWORK MODE ENABLED! 一堆指令</ultrawork-mode>\n改这个 bug') === '改这个 bug')
  ok('剥 *reminder 同族块兜底(todo-reminder 等)', stripInjected('<todo-reminder>别忘了收尾 todowrite</todo-reminder>\n继续干活') === '继续干活')
  ok('reminder 兜底不误伤无闭合正文', stripInjected('正文里写 <todo-reminder> 但没闭合块,别动我') === '正文里写 <todo-reminder> 但没闭合块,别动我')
  ok('reasoning part 的历史思考带回', msgs[1].reasoning === '先查日志再定位', msgs[1] && msgs[1].reasoning)
  ok('正文里的 <think> 也拆进思考、正文只剩答案', msgs[3].reasoning === '这轮的思考混在正文里' && msgs[3].text === '第二轮答案', msgs[3])
  ok('每条助手消息各带各的思考(不是只有最后一轮)', !!(msgs[1].reasoning && msgs[3].reasoning))
  // splitThink 边界
  ok('未闭合 <think>(流式中途/被截断)也拆得出', splitThink('<think>想到一半就断了').think === '想到一半就断了')
  ok('无 think 原样返回', splitThink('普通正文').rest === '普通正文' && splitThink('普通正文').think === '')
})()

// 用例16:收尾判据 = 工具状态 + 活动指纹(不再赌"这台 serve 标不标 completed")
//   · 工具在跑 → 文本再稳定也不收(治"吐一段→调>2.1s工具→续写"被截半截)
//   · 无工具在跑 + 指纹稳 ~2s → 收(治"completed 打得晚的 serve 简单问题也等 70s")
await (async () => {
  console.log('用例16:waitAssistantText 收尾判据(工具挡早收 / 迟到 completed 不拖时)')
  const { waitAssistantText } = oc.__test
  const http = await import('node:http')
  let polls = 0
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url.includes('trunc')) {          // 截半截场景:前 7 拍文本稳定但【工具还在跑】;第 8 拍工具完成+续写+标 completed
      polls++
      const done = polls >= 8
      res.end(JSON.stringify([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q2' }] },
        { info: { role: 'assistant', ...(done ? { time: { completed: 1 } } : {}) }, parts: [
          { type: 'text', text: done ? '前半段\n后半段' : '前半段' },
          { type: 'tool', tool: 'read', state: { status: done ? 'completed' : 'running' } },
        ] },
      ])); return
    }
    if (req.url.includes('late')) {           // 70s 病根场景:答案早就出完,completed 迟迟不落(等会话级收尾/标题生成)
      res.end(JSON.stringify([
        { info: { role: 'user' }, parts: [{ type: 'text', text: '你是谁' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: '我是天枢。' }] },   // 无 completed、无工具、文本不再变
      ])); return
    }
    // nomark:从不给完成标记的 serve,稳定即收兜底
    res.end(JSON.stringify([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'q' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: '只有这一段' }] },
    ]))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  const info = { base }
  const t0 = Date.now()
  const r2 = await waitAssistantText(info, 'trunc', 30000, 30000)
  ok('工具在跑时文本稳定不收 → 等到真正完成不截半截', /后半段/.test(r2), r2)
  ok('确实等过了工具窗口(耗时 ' + Math.round((Date.now() - t0) / 100) / 10 + 's > 2.8s)', Date.now() - t0 > 2800)
  const t1 = Date.now()
  const r3 = await waitAssistantText(info, 'late', 30000, 30000)
  const lateMs = Date.now() - t1
  ok('completed 迟到的 serve:无工具在跑+指纹稳 → ~3s 收(' + Math.round(lateMs / 100) / 10 + 's,以前要等到标记/超时)', r3 === '我是天枢。' && lateMs < 8000)
  const t2 = Date.now()
  const r4 = await waitAssistantText({ base }, 'nomark', 30000, 30000)
  ok('无完成标记的 serve 照常稳定即收(' + Math.round((Date.now() - t2) / 100) / 10 + 's)', r4 === '只有这一段' && Date.now() - t2 < 8000)
  srv.close()
})()

// 用例17:question.asked —— 有应答通道(onQuestion)路由给卡片弹提问卡,没有才自动 reject(治"交互提问挂死 88s 等人 Esc")
await (async () => {
  console.log('用例17:question.asked 路由 —— 有卡弹提问卡,无卡自动拒(v1/v2 端点)')
  const http = await import('node:http')
  const posts = []
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST') posts.push(req.url)
    res.setHeader('content-type', 'application/json'); res.end('true')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const info = { base: 'http://127.0.0.1:' + srv.address().port }
  const asked = []
  const onQuestion = (q) => asked.push(q)
  // 有 onQuestion:路由给卡片(带问题与请求 id),不发 reject
  dispatch({ type: 'question.asked', properties: { id: 'que_r1', sessionID: 'ses_q1', questions: [{ question: '确认?', header: 'h', options: [] }] } }, null, () => {}, info, onQuestion)
  ok('有应答通道 → 路由给卡片(请求id/会话/问题都在)', asked.length === 1 && asked[0].requestId === 'que_r1' && asked[0].sessionId === 'ses_q1' && asked[0].questions.length === 1, asked)
  await new Promise((r) => setTimeout(r, 200))
  ok('有应答通道 → 不发 reject', posts.length === 0, posts)
  // 无 onQuestion(会话无主/管线窗口):v1 → POST /question/:id/reject;v2 → /api/session/:sid/question/:id/reject
  dispatch({ type: 'question.asked', properties: { id: 'que_v1', sessionID: 'ses_q2', questions: [] } }, null, () => {}, info)
  dispatch({ type: 'question.v2.asked', properties: { id: 'que_v2', sessionID: 'ses_q3', questions: [] } }, null, () => {}, info)
  await new Promise((r) => setTimeout(r, 300))
  ok('无通道 v1 → POST /question/que_v1/reject', posts.includes('/question/que_v1/reject'), posts)
  ok('无通道 v2 → POST /api/session/ses_q3/question/que_v2/reject', posts.includes('/api/session/ses_q3/question/que_v2/reject'), posts)
  srv.close()
})()

// 用例18:generationStalled —— 卡死子 Agent 判据(未收尾+无在跑工具才判死;慢≠死)
;(() => {
  console.log('用例18:generationStalled 生成挂死判据(看门狗)')
  const { generationStalled } = oc
  const aMsg = (completed, parts) => ({ info: { role: 'assistant', time: completed ? { completed: 1 } : {} }, parts })
  const toolP = (status) => ({ type: 'tool', tool: 'read', state: { status } })
  const textP = (t) => ({ type: 'text', text: t })
  // 实测病灶:reasoning 有、text 空、消息不收尾、无工具 → 挂死
  ok('写结论挂死(未收尾+无工具)→ true', generationStalled([{ info: { role: 'user' } }, aMsg(false, [{ type: 'reasoning', text: 'I now have enough' }, textP('')])]) === true)
  // 慢≠死:工具在跑 / 已收尾 / 最后一条是 user
  ok('有工具在跑(慢,不是死)→ false', generationStalled([aMsg(false, [toolP('running')])]) === false)
  ok('已收尾 → false', generationStalled([aMsg(true, [textP('结论')])]) === false)
  ok('最后一条是 user(还没开答)→ false', generationStalled([{ info: { role: 'user' } }]) === false)
  ok('工具全终态(completed)且消息未收尾 → true(回答中断也算挂死候选)', generationStalled([aMsg(false, [toolP('completed')])]) === true)
  ok('空消息列表 → false', generationStalled([]) === false)
})()

// 用例19:128k 口径硬闸埋点 —— task 工具 part 带 taskChars(description+prompt 字符数);非 task 工具恒 0
;(() => {
  console.log('用例19:task 工具 taskChars 计量(128k 硬闸)')
  const { onText, calls } = collect()
  dispatch({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_t1', part: {
      id: 'prt_t', type: 'tool', callID: 'call_t', tool: 'task',
      state: { status: 'running', input: { description: '探索认证模块', prompt: '读 src/auth/ 下的文件并总结' } },
    } },
  }, null, onText)
  const t = calls.find((c) => c.kind === 'tool' && c.text === 'task')
  const expect = '探索认证模块'.length + '读 src/auth/ 下的文件并总结'.length
  ok('task 事件带 taskChars = description+prompt 字符数', t && t.taskChars === expect, t && t.taskChars)
  ok('非 task 工具 taskChars = 0', (() => {
    const { onText: ot2, calls: c2 } = collect()
    dispatch({ type: 'message.part.updated', properties: { sessionID: 'ses_t2', part: { id: 'prt_r', type: 'tool', callID: 'call_r', tool: 'read', state: { status: 'running', input: { filePath: 'a.js' } } } } }, null, ot2)
    const r = c2.find((c) => c.kind === 'tool')
    return r && r.taskChars === 0
  })())
  ok('delegate_task(oh-my-openagent)同样计量 taskChars', (() => {
    const { onText: ot3, calls: c3 } = collect()
    dispatch({ type: 'message.part.updated', properties: { sessionID: 'ses_t3', part: { id: 'prt_d', type: 'tool', callID: 'call_d', tool: 'delegate_task', state: { status: 'running', input: { description: '深读认证', prompt: '读 src/auth', load_skills: [] } } } } }, null, ot3)
    const d = c3.find((c) => c.kind === 'tool' && c.text === 'delegate_task')
    return d && d.taskChars === ('深读认证'.length + '读 src/auth'.length)
  })())
})()

// 用例20:onChildSession —— 带 parentID 的会话事件触发回调(128k 硬闸拦停子会话的介入点)
;(() => {
  console.log('用例20:onChildSession 回调(子会话诞生瞬间)')
  const born = []
  const onChildSession = (a) => born.push(a)
  const info = { base: 'http://127.0.0.1:1' }
  dispatch({ type: 'session.updated', properties: { info: { id: 'ses_kid1', parentID: 'ses_root1', title: 'Explore' } } }, null, () => {}, info, null, onChildSession)
  ok('子会话事件 → onChildSession(parentId/childId/title/info)', born.length === 1 && born[0].parentId === 'ses_root1' && born[0].childId === 'ses_kid1' && born[0].title === 'Explore' && born[0].info === info, born)
  ok('无 parentID 的会话事件不触发', (() => {
    const n0 = born.length
    dispatch({ type: 'session.updated', properties: { info: { id: 'ses_root2' } } }, null, () => {}, info, null, onChildSession)
    return born.length === n0
  })())
})()

// 用例19:session.diff → onDiffStat 解析(对象形/数组形都要兼容)
;(() => {
  console.log('用例19:session.diff 事件 → onDiffStat(权威改动账本进注册表)')
  const got = []
  const onDiffStat = (d) => got.push(d)
  dispatch({ type: 'session.diff', properties: { sessionID: 'ses_d1', diff: { files: 3, additions: 120, deletions: 45 } } }, null, () => {}, null, null, null, onDiffStat)
  dispatch({ type: 'session.diff', properties: { sessionID: 'ses_d2', diff: [{ file: 'a.py' }, { file: 'b.py' }] } }, null, () => {}, null, null, null, onDiffStat)
  ok('对象形:files/additions/deletions 全解析', got[0] && got[0].sessionId === 'ses_d1' && got[0].files === 3 && got[0].additions === 120 && got[0].deletions === 45, got[0])
  ok('数组形:按文件数折算', got[1] && got[1].files === 2 && got[1].additions === 0, got[1])
})()

// ── listPendingQuestions 会话归属过滤 ★会红的回归 ─────────────────────────
// 病灶:GET /question 是【整台 serve】的清单(端点自述 across all sessions,条目带 sessionID),
// 而同目录多张卡共用一台池化 serve 是常态。不过滤 = 谁先轮到谁按【自己的】sessionId 冒领;
// 先轮到的若是分片隐藏卡,session.js 的 onQuestion 会走无人值守分支【当场自动拒答】——
// 该弹提问卡的那张卡什么也不弹,用户只看见回合莫名其妙继续了。
// 起真的本地 http server 跑(api() 走 node http,顺带把 api 这一段也覆盖到)。
await (async () => {
  console.log('用例N:GET /question 待答清单按会话归属过滤(整台 serve 共用时不许冒领)')
  const http = (await import('node:http')).default
  const BODY = [
    { id: 'q_mine', sessionID: 'ses_mine', questions: [{ question: '我的' }] },
    { id: 'q_other', sessionID: 'ses_other', questions: [{ question: '别人的' }] },
    { id: 'q_child', sessionID: 'ses_child', questions: [{ question: '我派的子 Agent 问的' }] },
    { id: 'q_legacy', questions: [{ question: '老 fork 不带 sessionID' }] },
  ]
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(BODY))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  try {
    oc.__test.noteChild('ses_child', 'ses_mine', '子 Agent', base)   // 子会话经 rootSession 归到父卡(与 SSE 路由同构)
    const mine = await oc.listPendingQuestions(base, 'ses_mine')
    const ids = (mine || []).map((q) => q.id)
    ok('★别人会话的待答被过滤掉(不冒领 → 不会替别人自动拒答)', !ids.includes('q_other'), ids)
    ok('  自己的待答留下', ids.includes('q_mine'), ids)
    ok('  自己派的子 Agent 的待答也留下(rootSession 归并)', ids.includes('q_child'), ids)
    // 老 fork 条目没有 sessionID:证不出归属 —— 不丢也不静默冒领,打标交上层决定
    // (可见卡宁可多弹一次让人看见;无人值守卡不认领,认领=替别人当场拒答,不可逆)
    const legacy = (mine || []).find((q) => q.id === 'q_legacy')
    ok('  无 sessionID 的条目不丢,打 _unowned 标交上层', !!legacy && legacy._unowned === true, legacy)
    const all = await oc.listPendingQuestions(base)
    ok('  不传 sessionId 时原样返回(老调用方不受影响)', (all || []).length === 4)
  } finally { srv.close() }
})()

;(() => {
  console.log('用例:★回合级错误(info.error)必须被看见 —— 真机 402 现场')
  // 2026-08-07 真机:DeepSeek 返 402「Insufficient Balance」,serve 把它挂在 assistant 消息的
  // info.error 上。pickTurnText 原来【一个字都不看】,于是轮询看到"没文本" → 返回空串 →
  // 编排把空串误诊成「nodes 是空数组但 more 不是 no」,照着这句去重问模型,烧完两轮转人工。
  // 余额不足这种一句话能解决的事,被翻译成一句与真相毫无关系的话 —— 最坏的失败形态不是没修好,
  // 是报错在撒谎。
  const errMsg = (data, parts) => ({ info: { role: 'assistant', id: 'm' + Math.abs(data.statusCode || 0),
    time: { completed: Date.now() }, error: { name: 'APIError', data } }, parts: parts || [] })
  const r = pickTurnText([uMsg('q'), errMsg({ message: 'Insufficient Balance', statusCode: 402 })])
  ok('★回合失败时 err 非空(修前:这里什么都看不到)', !!r.err, r.err)
  ok('  带上供应商原话与状态码(人要能直接看懂该干嘛)',
    /Insufficient Balance/.test(r.err) && /402/.test(r.err), r.err)
  ok('  正常回合 err 为空(不许无中生有)',
    !pickTurnText([uMsg('q'), aMsg([textPart('答完了')], true)]).err)
  // 只认结构化 error 字段:去正文里猜会把模型自己写的"出错了"当成回合失败
  ok('★不从正文里猜错误(模型自己写"APIError 402"不算回合失败)',
    !pickTurnText([uMsg('q'), aMsg([textPart('执行时出错了,APIError 402')], true)]).err)
  // 有半截文本时文本与错误都要在:上层的规矩是"有总比无强",由它决定返半截还是抛
  const rp = pickTurnText([uMsg('q'), errMsg({ message: 'timeout', statusCode: 504 }, [textPart('写了一半')])])
  ok('  带半截文本的失败回合:文本与错误都在', rp.text === '写了一半' && !!rp.err, { text: rp.text, err: rp.err })
})()


console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
