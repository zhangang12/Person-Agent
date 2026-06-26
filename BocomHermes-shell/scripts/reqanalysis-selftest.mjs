// 需求分析管线自测（假 run + 假 ground，不连真模型/内网）。用法： node scripts/reqanalysis-selftest.mjs
import req from '../reqanalysis.js'
const { locateSpan, parseFindings, htmlToText, spliceImageDescriptions, pickVerdict, analyzeRequirement } = req

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

console.log('locateSpan:')
const src0 = '客户还款后额度没有恢复，需要处理。'
ok(JSON.stringify(locateSpan(src0, '额度没有恢复')) === JSON.stringify([5, 11]), '精确定位子串偏移')
ok(locateSpan(src0, '不存在的话') === null, '找不到返回 null（不给错偏移）')

console.log('parseFindings:')
const pf = parseFindings('<think>读</think>{"findings":[{"span":"额度没有恢复","claim":"额度恢复","reading":"回补","readingKey":"回补","term":"额度恢复"}]}', src0, '数据派')
ok(pf.length === 1 && pf[0].term === '额度恢复' && pf[0].span !== null, '剥 think + 抽 findings + 定位 span + 带 term')
ok(pf[0].id === '数据派#0' && pf[0].persona === '数据派', 'finding 带 persona 与唯一 id')

console.log('htmlToText / spliceImageDescriptions:')
const t = htmlToText('<p>甲</p><img src="x" alt="[[IMG0]]"><p>乙&amp;丙</p>')
ok(t.includes('[[IMG0]]') && t.includes('乙&丙'), 'img 转占位 + 实体解码 + 去标签')
const sp = spliceImageDescriptions('[[IMG0]] 中间 [[IMG1]]', ['流程图：A→B', null])
ok(sp.includes('［图1：流程图：A→B］') && sp.includes('［图2：读不准，原图在此］'), '图片占位插回文字 + 读不准诚实标')

console.log('pickVerdict:')
ok(pickVerdict('same', false) === 'same' && pickVerdict('它们不同', false) === 'different', 'same/different')
ok(pickVerdict('两者互相矛盾', true) === 'contradict', 'contradict（允许时）')
ok(pickVerdict('矛盾', false) === 'different', '不允许 contradict 时归 different')

console.log('analyzeRequirement 端到端（假 run/judge/ground）:')
const source = [
  '一、客户还款后额度没有恢复，需要处理。',
  '二、已用的部分不能动。',
  '三、命中风险后自动冻结额度。',
  '附录：冻结额度需人工复核。',
].join('\n')

const canned = {
  '业务字面': '<think>读一下</think>' + JSON.stringify({ findings: [
    { span: '客户还款后额度没有恢复', claim: '额度恢复处理', reading: '还款后回补额度', readingKey: '回补', term: '额度恢复' },
    { span: '已用的部分不能动', claim: '已用额度处理', reading: '已用只读不回补', readingKey: '只读', term: '已用额度' },
  ] }),
  '数据派': JSON.stringify({ findings: [
    { span: '额度没有恢复', claim: '额度字段恢复', reading: '还款后回补', readingKey: '回补', term: '额度恢复' },
    { span: '已用的部分不能动', claim: '已用额度字段', reading: '还款回补已用', readingKey: '回补', term: '已用额度' },
  ] }),
  '流程派': JSON.stringify({ findings: [
    { span: '自动冻结额度', claim: '风险触发冻结', reading: '命中风险自动冻结', readingKey: '自动冻结', term: '冻结处理' },
  ] }),
  '挑刺·对抗': JSON.stringify({ findings: [
    { span: '客户还款后额度没有恢复', claim: '疑似缺陷或隐藏诉求', reading: '这是BUG还是新需求?', readingKey: 'BUG存疑', term: '额度恢复' },
  ] }),
  '历史·跨页': JSON.stringify({ findings: [
    { span: '冻结额度需人工复核', claim: '冻结需复核', reading: '冻结需人工复核', readingKey: '需人工复核', term: '冻结处理' },
  ] }),
}
const fakeRun = async (_p, meta) => (meta.kind === 'read' ? (canned[meta.persona] || '{"findings":[]}') : '')
const topicJudge = async (a, b) => (a.term === '冻结处理' && b.term === '冻结处理' ? 'same' : 'different')
const readingJudge = async (a, b) => {
  const ks = [a.readingKey, b.readingKey]
  return (ks.includes('自动冻结') && ks.includes('需人工复核')) ? 'contradict' : 'different'
}
const ground = async (q) => {
  if (q.readingKey === '回补') return { found: true, ref: 'RepayFlow.java:142' }
  if (q.readingKey === '自动冻结') return { found: true, ref: '需求文档·第3节' }
  if (q.readingKey === '需人工复核') return { found: true, ref: '需求文档·附录' }
  return { found: false, ref: null }
}

const res = await analyzeRequirement(source, { run: fakeRun, topicJudge, readingJudge, ground })
ok(res.findings.length === 7, '5 读者共产出 7 条 findings')
ok(res.clusters.length === 3, '聚成 3 个话题簇（额度恢复 / 已用 / 冻结-跨页）')

const S = res.report.summary
ok(S.clear === 1 && S.split === 1 && S.conflict === 1 && S.hidden === 0, '三类汇总：clear 1 / split 1 / conflict 1')

const clearIt = res.report.items.find((i) => i.outcome === 'clear')
ok(clearIt && clearIt.riskFlags.length === 1 && clearIt.riskFlags[0].reading === 'BUG存疑', 'clear 项把挑刺派独家异见挂成 riskFlag（不拉成 split）')
ok(clearIt.quote.includes('额度'), 'clear 项钉回原话（原文片段）')

const splitIt = res.report.items.find((i) => i.outcome === 'split')
ok(splitIt && splitIt.readings.length === 2, 'split 项两种读法并列')
const rec = splitIt.readings.find((r) => r.recommended)
ok(rec && rec.key === '回补' && rec.evidence.length === 1, 'grounding 后"回补"置信最高被推荐 + 带证据 ref')
ok(splitIt.readings[0].confidence >= splitIt.readings[1].confidence, '并列读法按置信度降序')

const confIt = res.report.items.find((i) => i.outcome === 'conflict')
ok(confIt && confIt.contradiction && confIt.readings.length === 2, 'conflict 项 contradiction=true + 两端读法')

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
