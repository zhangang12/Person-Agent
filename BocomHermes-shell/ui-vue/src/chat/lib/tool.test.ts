// 契约测试 · 工具块(用例2:折叠/verbose/⎿摘要/截断;用例3:todocard 三记号) ↔ card-ui-selftest
import { describe, it, expect } from 'vitest'
import {
  isTodoTool, isWriteEditTool, isAskTool, toolLabel, asObj, fmtInput, fmtOutput,
  toolState, toolStateText, toolSummary, truncIn, truncOut, IN_CAP, OUT_CAP,
  todoModel, extractFilePath, artAbs, artRel,
  isDispatchTool, stripOrchTag, dispatchModel, dispatchedId,
} from './tool'

describe('工具归类', () => {
  it('todo 工具:write/read 都算,大小写不敏感', () => {
    expect(isTodoTool('todowrite')).toBe(true)
    expect(isTodoTool('TodoRead')).toBe(true)
    expect(isTodoTool('todo')).toBe(false)
    expect(isTodoTool('todolist')).toBe(false)
  })
  it('write/edit 类(含下划线变体)→ 成果抽屉', () => {
    expect(isWriteEditTool('write')).toBe(true)
    expect(isWriteEditTool('Edit')).toBe(true)
    expect(isWriteEditTool('write_file')).toBe(true)
    expect(isWriteEditTool('edit_range')).toBe(true)
    expect(isWriteEditTool('rewrite')).toBe(false)   // 前缀不算,必须整体匹配
    expect(isWriteEditTool('read')).toBe(false)
  })
  it('ask/elicit 交互提问兜底识别', () => {
    expect(isAskTool('ask')).toBe(true)
    expect(isAskTool('elicit')).toBe(true)
    expect(isAskTool('question')).toBe(false)
  })
  it('特殊显示名(TOOL_LABEL)', () => {
    expect(toolLabel('run_workflow')).toBe('升格 → 动态工作流')
    expect(toolLabel('task')).toBe('子Agent')
    expect(toolLabel('read')).toBe('read')
  })
})

describe('入参/结果格式化', () => {
  it('asObj:对象直返 / JSON 字符串解析 / 垃圾 null', () => {
    expect(asObj({ a: 1 })).toEqual({ a: 1 })
    expect(asObj('{"a":1}')).toEqual({ a: 1 })
    expect(asObj('not json')).toBe(null)
    expect(asObj(null)).toBe(null)
    expect(asObj(42)).toBe(null)
  })
  it('fmtInput:字符串原样,对象缩进 JSON', () => {
    expect(fmtInput(null)).toBe('')
    expect(fmtInput('echo hi')).toBe('echo hi')
    expect(fmtInput({ filePath: 'a.js' })).toBe(JSON.stringify({ filePath: 'a.js' }, null, 2))
  })
  it('fmtOutput:error 优先于 output', () => {
    expect(fmtOutput({ output: 'o', error: 'e' })).toBe('e')
    expect(fmtOutput({ output: 'o' })).toBe('o')
    expect(fmtOutput({})).toBe('')
  })
})

describe('状态与摘要(用例2 契约)', () => {
  it('状态词表:completed→done / error→err / running→running', () => {
    expect(toolState('completed')).toBe('done')
    expect(toolState('success')).toBe('done')
    expect(toolState('error')).toBe('err')
    expect(toolState('deny')).toBe('err')
    expect(toolState('rejected')).toBe('err')
    expect(toolState('denied')).toBe('running')   // 旧页词表 /deny/ 不覆盖 denied —— 原样平移(存疑)
    expect(toolState('running')).toBe('running')
    expect(toolState('')).toBe('running')
    expect(toolStateText('done')).toBe('完成')
    expect(toolStateText('err')).toBe('出错')
    expect(toolStateText('running')).toBe('运行中…')
  })
  it('completed 摘要带输出量:⎿ N 字 / ⎿ X.Xk 字', () => {
    expect(toolSummary('completed', 'x'.repeat(1500))).toBe('⎿ 1.5k 字')
    expect(toolSummary('completed', 'x'.repeat(999))).toBe('⎿ 999 字')
    expect(toolSummary('completed', 'x'.repeat(1000))).toBe('⎿ 1.0k 字')
    expect(toolSummary('running', 'x'.repeat(100))).toBe('')    // 未完成不带
    expect(toolSummary('error', 'x'.repeat(100))).toBe('')      // 出错不带
    expect(toolSummary('completed', '')).toBe('')               // 无输出不带
  })
  it('截断:入参 4000 / 结果 20000,提示带总字数', () => {
    const a = truncIn('x'.repeat(IN_CAP + 10))
    expect(a.text.length).toBe(IN_CAP)
    expect(a.tip).toBe('… 已截断:共 ' + (IN_CAP + 10) + ' 字,仅显示前 ' + IN_CAP + ' 字')
    expect(truncIn('short').tip).toBe('')
    const b = truncOut('y'.repeat(OUT_CAP + 5))
    expect(b.text.length).toBe(OUT_CAP)
    expect(b.tip).toContain('仅显示前 ' + OUT_CAP + ' 字')
  })
})

describe('todowrite → 勾选清单(用例3 契约)', () => {
  it('三记号 ☒◐☐ + meta N/M', () => {
    const m = todoModel({ todos: [
      { content: '读代码', status: 'completed' },
      { content: '写修复', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
    ] })
    expect(m).not.toBe(null)
    expect(m!.rows.map((r) => r.mark)).toEqual(['☒', '◐', '☐'])
    expect(m!.rows.map((r) => r.cls)).toEqual(['done', 'doing', ''])
    expect(m!.meta).toBe('1/3')
  })
  it('cancelled → ⊘ 且归 done 类(灰掉)但不计入完成数', () => {
    const m = todoModel({ todos: [{ content: '弃项', status: 'cancelled' }] })
    expect(m!.rows[0].mark).toBe('⊘')
    expect(m!.rows[0].cls).toBe('done')
    expect(m!.meta).toBe('0/1')
  })
  it('空文本行跳过;全空/形状不符 → null(调用方整卡隐藏)', () => {
    expect(todoModel({ todos: [{ content: '  ', status: 'pending' }] })).toBe(null)
    expect(todoModel({ todos: [] })).toBe(null)
    expect(todoModel({})).toBe(null)
    expect(todoModel('{"todos":[{"content":"甲","status":"pending"}]}')).not.toBe(null)   // JSON 字符串入参
    expect(todoModel(null)).toBe(null)
  })
  it('text/title 字段别名', () => {
    const m = todoModel({ todos: [{ text: '乙', status: 'pending' }, { title: '丙', status: 'pending' }] })
    expect(m!.rows.map((r) => r.text)).toEqual(['乙', '丙'])
  })
})

describe('成果抽屉路径(artAbs/artRel)', () => {
  it('extractFilePath:filePath > path > filename;JSON 字符串入参也认', () => {
    expect(extractFilePath({ filePath: '/a/b.md' })).toBe('/a/b.md')
    expect(extractFilePath({ path: '/a/c.md' })).toBe('/a/c.md')
    expect(extractFilePath({ filename: '/a/d.md' })).toBe('/a/d.md')
    expect(extractFilePath('{"filePath":"/a/e.md"}')).toBe('/a/e.md')
    expect(extractFilePath({})).toBe('')
  })
  it('artAbs:绝对路径原样(含 win/UNC),相对的按本卡目录拼', () => {
    expect(artAbs('/x/y.md', '/proj')).toBe('/x/y.md')
    expect(artAbs('C:\\x\\y.md', '/proj')).toBe('C:\\x\\y.md')
    expect(artAbs('docs/a.md', '/proj')).toBe('/proj/docs/a.md')
    expect(artAbs('docs/a.md', '/proj/')).toBe('/proj/docs/a.md')   // 目录尾斜杠不叠
    expect(artAbs('', '/proj')).toBe('')
  })
  it('artRel:本卡目录下砍前缀,砍不动原样', () => {
    expect(artRel('/proj/docs/a.md', '/proj')).toBe('docs/a.md')
    expect(artRel('/other/a.md', '/proj')).toBe('/other/a.md')
    expect(artRel('/proj/a.md', '')).toBe('/proj/a.md')
  })
})

// ── 分片派发展示模型:主控卡里 N 条派发原本全叫「升格 → 动态工作流」,归组后只剩「4 次工具调用 · 升格 ×4」,
//    派了哪几片、去了哪张卡一概看不见(用户实测头号困惑)。现在名/标题/跳转 id 都从入参与回执里抠。
describe('分片派发展示模型(run_workflow)', () => {
  it('isDispatchTool:只认 run_workflow', () => {
    expect(isDispatchTool('run_workflow')).toBe(true)
    expect(isDispatchTool('RUN_WORKFLOW')).toBe(true)
    expect(isDispatchTool('run_orchestration')).toBe(false)
    expect(isDispatchTool('task')).toBe(false)
  })
  it('stripOrchTag:半角/全角/带空格的手写标记一律剥掉(壳层也剥,展示层同口径)', () => {
    expect(stripOrchTag('[orch:a3f9] 勘察认证模块')).toBe('勘察认证模块')
    expect(stripOrchTag('【orch：a3f9】勘察认证模块')).toBe('勘察认证模块')
    expect(stripOrchTag('勘察 [orch: a3f9 ] 认证模块')).toBe('勘察 认证模块')
    expect(stripOrchTag('没有标记的目标')).toBe('没有标记的目标')
    expect(stripOrchTag(undefined)).toBe('')
  })
  it('dispatchModel:parentTag 在场 = 分片派发(不是又升格一个独立工作流)', () => {
    expect(dispatchModel({ goal: '[orch:a3f9] 勘察认证模块', parentTag: 'a3f9' })).toEqual({ shard: true, goal: '勘察认证模块' })
    expect(dispatchModel({ goal: '整理这个仓库的架构' })).toEqual({ shard: false, goal: '整理这个仓库的架构' })
    expect(dispatchModel('{"goal":"读文档","parentTag":"b1"}')).toEqual({ shard: true, goal: '读文档' })
    expect(dispatchModel({ parentTag: 'a3f9' })).toBe(null)   // 入参还没到齐(goal 空)→ 不改名不改标题
    expect(dispatchModel(null)).toBe(null)
  })
  it('dispatchedId:从回执抠分片卡 id(点块跳该片镜像视图)', () => {
    expect(dispatchedId('分片已派出,id=17。它是【无人值守隐藏工人】…')).toBe('17')
    expect(dispatchedId('已拉起动态工作流,id=3(卡片已打开…)')).toBe('3')
    expect(dispatchedId('派发被拒:主控方案尚未批准')).toBe('')
    expect(dispatchedId('')).toBe('')
  })
})
