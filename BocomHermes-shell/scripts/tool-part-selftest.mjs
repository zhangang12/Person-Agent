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

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
