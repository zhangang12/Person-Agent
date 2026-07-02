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

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
