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

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
