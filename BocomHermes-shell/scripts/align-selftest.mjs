// 对齐引擎·话题聚簇自测（不连真模型，裁判用假函数）。用法： node scripts/align-selftest.mjs
import align from '../align.js'
const { spanOverlapRatio, clusterByTopic, analyzeCluster, analyzeClusters } = align

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }
const near = (a, b) => Math.abs(a - b) < 1e-9

console.log('spanOverlapRatio:')
ok(near(spanOverlapRatio([0, 40], [0, 40]), 1), '完全相同 = 1')
ok(spanOverlapRatio([0, 40], [40, 80]) === 0, '相接不相交 = 0')
ok(spanOverlapRatio([0, 100], [200, 300]) === 0, '完全分离 = 0')
ok(near(spanOverlapRatio([10, 20], [0, 100]), 1), '短 span 被长 span 完全包含 = 1（除以较短）')
ok(near(spanOverlapRatio([50, 90], [78, 118]), 0.3), '部分重叠按较短长度算 = 0.3')

console.log('clusterByTopic（仅结构信号，无裁判）:')
const A = [
  { id: 'f1', persona: '业务字面', span: [10, 40], claim: '冻结额度' },
  { id: 'f2', persona: '数据派', span: [12, 38], claim: 'limit status 改 1' },
  { id: 'f3', persona: '流程派', span: [200, 230], claim: '审批流程调整' },
]
const ra = await clusterByTopic(A)
ok(ra.clusters.length === 2, '高重叠的 f1/f2 并成 1 簇、f3 独立 = 2 簇')
const big = ra.clusters.find((c) => c.size === 2)
ok(big && big.personas.length === 2, '同簇聚到不同 persona（业务字面+数据派）')
ok(ra.judgeCalls === 0, '无裁判时不调用裁判')

console.log('保守：模糊边界无裁判则不并:')
const B = [
  { id: 'a', persona: 'p1', span: [0, 40], claim: 'A' },
  { id: 'b', persona: 'p2', span: [20, 60], claim: 'B' },   // a-b 重叠 0.5 → 自动并
  { id: 'c', persona: 'p3', span: [50, 90], claim: 'C' },   // b-c 重叠 0.25 → 模糊
]
const rb = await clusterByTopic(B)
ok(rb.clusters.length === 2 && rb.ambiguousPairs === 1, '模糊对未并、留待裁判：2 簇 + 1 模糊对')

console.log('裁判桥接模糊边界:')
let calls = 0
const sameJudge = async () => { calls++; return 'same' }
const rc = await clusterByTopic(B, { judge: sameJudge })
ok(rc.clusters.length === 1, '裁判判 same → a/b/c 并成 1 簇')
ok(calls === 1 && rc.judgeCalls === 1, '只对 b-c 这一个桥接模糊对问了裁判（1 次）')

console.log('裁判判 different 则不并:')
const rc2 = await clusterByTopic(B, { judge: async () => 'different' })
ok(rc2.clusters.length === 2 && rc2.judgeCalls === 1, '裁判判 different → 仍 2 簇，问了 1 次')

console.log('已同簇的模糊对跳过裁判（省调用）:')
const C = [
  { id: 'a', persona: 'p1', span: [0, 55], claim: 'A' },
  { id: 'b', persona: 'p2', span: [30, 70], claim: 'B' },   // a-b 0.625 → 自动并
  { id: 'c', persona: 'p3', span: [45, 85], claim: 'C' },   // b-c 0.625 → 自动并；a-c 0.25 → 模糊但已同簇
]
let calls2 = 0
const rc3 = await clusterByTopic(C, { judge: async () => { calls2++; return 'same' } })
ok(rc3.clusters.length === 1, 'a/b/c 经自动并已成 1 簇')
ok(calls2 === 0, 'a-c 虽是模糊对但已同簇 → 不问裁判（0 次）')

console.log('空输入:')
const re = await clusterByTopic([])
ok(re.clusters.length === 0 && re.judgeCalls === 0, '空 findings 安全返回')

console.log('跨页 term 桥接（span 零重叠，靠共享 term + 裁判）:')
const T = [
  { id: 'p', persona: '流程派', span: [100, 112], term: '冻结处理', claim: '自动冻结' },
  { id: 'h', persona: '历史·跨页', span: [300, 316], term: '冻结处理', claim: '需人工复核' },
]
const rt1 = await clusterByTopic(T, { judge: async () => 'same' })
ok(rt1.clusters.length === 1 && rt1.judgeCalls === 1, '共享 term 的跨页对经裁判并成 1 簇（问 1 次）')
const rt2 = await clusterByTopic(T)
ok(rt2.clusters.length === 2 && rt2.judgeCalls === 0, '无裁判时跨页对不并（保守）')

const cl = (id, findings) => ({ id, findings })

console.log('analyzeCluster — clear（全体一致）:')
const r1 = await analyzeCluster(cl('C1', [
  { id: 'a', persona: '业务字面', readingKey: '回补' },
  { id: 'b', persona: '数据派', readingKey: '回补' },
  { id: 'c', persona: '流程派', readingKey: '回补' },
  { id: 'd', persona: '历史·跨页', readingKey: '回补' },
]))
ok(r1.outcome === 'clear', '4 人同一 readingKey → clear')
ok(r1.readings.length === 1 && near(r1.readings[0].confidence, 1) && r1.readings[0].recommended, '单读法 置信度 1 + 推荐')

console.log('analyzeCluster — split（读法分裂）:')
const r2 = await analyzeCluster(cl('C2', [
  { id: 'a', persona: '业务字面', readingKey: '只读' },
  { id: 'b', persona: '流程派', readingKey: '只读' },
  { id: 'c', persona: '数据派', readingKey: '回补' },
]))
ok(r2.outcome === 'split' && r2.readings.length === 2, '两种读法 → split，2 个并列读法')
ok(near(r2.readings[0].confidence, 0.67) && r2.readings[0].key === '只读', '背书多的读法置信度更高、排前并推荐')

console.log('analyzeCluster — 挑刺派不对称:')
const r3 = await analyzeCluster(cl('C3', [
  { id: 'a', persona: '业务字面', readingKey: '回补' },
  { id: 'b', persona: '数据派', readingKey: '回补' },
  { id: 'c', persona: '流程派', readingKey: '回补' },
  { id: 'x', persona: '挑刺·对抗', readingKey: '冻结' },
]))
ok(r3.outcome === 'clear', '挑刺派独家异见不把多数拉成 split → 仍 clear')
ok(r3.riskFlags.length === 1 && r3.riskFlags[0].reading === '冻结', '挑刺派异见单独挂成 riskFlag')
ok(r3.readings.length === 1, '并列读法里不含挑刺派独家读法')

console.log('analyzeCluster — hidden:')
const r4 = await analyzeCluster(cl('C4', [{ id: 'a', persona: '业务字面', readingKey: 'x' }]))
ok(r4.outcome === 'hidden', 'size 1 → hidden（仅 1 人发现）')
const r5 = await analyzeCluster(cl('C5', [
  { id: 'a', persona: '挑刺·对抗', readingKey: 'x' },
  { id: 'b', persona: '挑刺·对抗', readingKey: 'x' },
]))
ok(r5.outcome === 'hidden', '仅挑刺派发现（无非挑刺背书）→ hidden')

console.log('analyzeCluster — conflict（裁判判 contradict）:')
const r6 = await analyzeCluster(cl('C6', [
  { id: 'a', persona: '流程派', readingKey: '自动冻结' },
  { id: 'b', persona: '历史·跨页', readingKey: '需人工复核' },
]), { readingJudge: async () => 'contradict' })
ok(r6.outcome === 'conflict' && r6.contradiction, '互斥读法 → conflict')
ok(r6.judgeCalls === 1, '只问了 1 次裁判（2 组 1 对）')

console.log('analyzeCluster — 裁判 same 合并读法 → clear:')
const r7 = await analyzeCluster(cl('C7', [
  { id: 'a', persona: '业务字面', readingKey: '额度回补' },
  { id: 'b', persona: '数据派', readingKey: '可用额度恢复' },
]), { readingJudge: async () => 'same' })
ok(r7.outcome === 'clear' && r7.readings.length === 1, '裁判判 same → 两读法合并 → clear')

console.log('analyzeCluster — grounding 加成改排序:')
const r8 = await analyzeCluster(cl('C8', [
  { id: 'a', persona: '业务字面', readingKey: '只读' },
  { id: 'b', persona: '流程派', readingKey: '只读' },
  { id: 'c', persona: '数据派', readingKey: '回补' },
]), { groundingBoost: { 回补: 5 } })
ok(r8.readings[0].key === '回补' && r8.readings[0].recommended, 'grounding 把"回补"加成到置信最高 + 推荐')

console.log('analyzeClusters — 汇总计数:')
const rs = await analyzeClusters([
  cl('a', [{ id: '1', persona: '业务字面', readingKey: 'k' }, { id: '2', persona: '数据派', readingKey: 'k' }]),
  cl('b', [{ id: '3', persona: '业务字面', readingKey: 'p' }, { id: '4', persona: '流程派', readingKey: 'q' }]),
  cl('c', [{ id: '5', persona: '业务字面', readingKey: 'z' }]),
])
ok(rs.summary.clear === 1 && rs.summary.split === 1 && rs.summary.hidden === 1, '汇总：clear 1 / split 1 / hidden 1')

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
