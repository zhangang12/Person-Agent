// 出详设管线自测（假 locate + 假 plan，不连真模型/内网）。用法： node scripts/reqplan-selftest.mjs
import plan from '../reqplan.js'
const { normalizeDecisions, collectPoints, parsePlanCard, planRequirement, planToMarkdown, buildPlanPrompt } = plan

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

// 模拟 reqanalysis assembleReport 出来的报告
const report = {
  summary: { clear: 1, split: 1, conflict: 1, hidden: 1 },
  items: [
    { id: 'c1', outcome: 'clear', claim: '还款后恢复额度', quote: '客户还款后额度没有恢复', readings: [] },
    { id: 's1', outcome: 'split', claim: '已用额度处理', quote: '已用的部分不能动', readings: [
      { key: '回补', label: '还款后回补已用额度' }, { key: '只读', label: '已用只读不回补' } ] },
    { id: 'x1', outcome: 'conflict', claim: '冻结是否需复核', quote: '自动冻结额度', readings: [
      { key: '自动', label: '命中风险自动冻结' }, { key: '复核', label: '冻结需人工复核' } ] },
    { id: 'h1', outcome: 'hidden', claim: '疑似缺陷', quote: '额度没恢复', readings: [] },
  ],
}

console.log('normalizeDecisions:')
ok(JSON.stringify(normalizeDecisions([{ id: 'a', choice: 'claim' }])) === JSON.stringify({ a: { id: 'a', choice: 'claim' } }), '数组 → 按 id 索引的对象')
ok(Object.keys(normalizeDecisions(null)).length === 0, 'null → 空对象')

console.log('collectPoints:')
const decisions = [
  { id: 'c1', outcome: 'clear', choice: 'claim' },
  { id: 's1', outcome: 'split', choice: 'pick:只读' },
  { id: 'h1', outcome: 'hidden', choice: 'ignore' },
  // x1 未裁决
]
const pts = collectPoints(report, decisions)
ok(pts.length === 3, 'ignore 的隐藏项被排除（4→3）')
const s1 = pts.find((p) => p.id === 's1')
ok(s1 && s1.intent === '已用只读不回补' && !s1.unresolved, 'split 选了读法 → 用选定意图、不标未决')
const x1 = pts.find((p) => p.id === 'x1')
ok(x1 && x1.unresolved === true, 'conflict 未裁决 → 标 unresolved')

console.log('buildPlanPrompt:')
const prompt = buildPlanPrompt(pts.find((p) => p.id === 'c1'), { refs: [{ path: 'a/LimitService.java', line: 142, symbol: 'recoverLimit()' }], slices: [{ path: 'a/LimitService.java', line: 142, text: 'void recoverLimit(){}' }] })
ok(prompt.includes('LimitService.java:142') && prompt.includes('recoverLimit()'), 'prompt 带 grep 命中 ref')
ok(prompt.includes('只输出 JSON') && prompt.includes('绝不臆造'), 'prompt 带输出契约 + 铁律')

console.log('parsePlanCard:')
const card = parsePlanCard('<think>分析</think>{"system":"渠道整合平台","files":[{"path":"a/LimitService.java","line":142,"symbol":"recoverLimit()","change":"还款回调后释放冻结额度"}],"tables":[{"table":"loan_limit","column":"credit_amt","change":"回补"}],"interfaces":[],"change":"同步释放","steps":["改回调","加测试"],"opens":["部分还款是否按比例"]}', pts.find((p) => p.id === 'c1'))
ok(card.system === '渠道整合平台', '剥 think + 解析 system')
ok(card.files.length === 1 && card.files[0].line === 142, '解析 files（带行号）')
ok(card.tables.length === 1 && card.tables[0].table === 'loan_limit', '解析 tables')
ok(card.steps.length === 2 && card.opens.length === 1, '解析 steps / opens')

console.log('parsePlanCard 兜底:')
const card2 = parsePlanCard('模型乱回没JSON', x1, { refs: [{ path: 'b/Freeze.java', line: 9 }] })
ok(card2.files.length === 1 && card2.files[0].path === 'b/Freeze.java', 'plan 没给 files → 回落挂 locate 命中(可点定位)')
ok(card2.opens[0].includes('未经') || card2.opens[0].includes('初稿'), 'unresolved 点把"初稿"声明置顶到 opens')

console.log('planRequirement 端到端（假 locate/plan）:')
const fakeLocate = async (p) => ({ refs: [{ path: 'src/' + p.id + '.java', line: 10, symbol: 'm()' }], slices: [{ path: 'src/' + p.id + '.java', line: 10, text: 'code' }] })
const fakePlan = async (p, located) => JSON.stringify({
  system: '渠道整合平台',
  files: located.refs.map((r) => ({ path: r.path, line: r.line, symbol: r.symbol, change: '改这里' })),
  tables: [], interfaces: [], change: '方案 for ' + p.id, steps: ['步骤'], opens: [],
})
let stages = []
const res = await planRequirement(report, { locate: fakeLocate, plan: fakePlan, decisions, onEvent: (ev) => stages.push(ev.stage) })
ok(res.cards.length === 3, '出 3 张详设卡（与 collectPoints 一致）')
ok(res.cards.every((c) => c.files.length === 1 && c.change), '每卡带影响文件 + 总体改动')
const xcard = res.cards.find((c) => c.id === 'x1')
ok(xcard && xcard.opens.some((o) => o.includes('初稿')), '未裁决的 conflict 卡仍标"初稿"未决')
ok(stages.includes('plan-start') && stages.includes('locating') && stages.includes('planning') && stages.includes('plan-done'), '推全套进度事件')

console.log('planToMarkdown:')
const md = planToMarkdown(res, { file: '电子渠道需求.docx' })
ok(md.includes('# 实施方案 · 电子渠道需求.docx') && md.includes('**影响文件**'), 'Markdown 带标题 + 影响文件分节')
ok(md.includes('【渠道整合平台】'), 'Markdown 带系统归属')
ok(md.includes('⛑ 未决'), 'Markdown 渲染未决项')

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
