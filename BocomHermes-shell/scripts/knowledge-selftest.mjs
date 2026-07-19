// 自测:src/knowledge.js(项目级知识库·任务尾蒸馏落点)—— slug 稳定性/追加去重/注入裁剪。
// 跑法:npm run knowledge:test(纯逻辑,不连模型不起 serve)
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const K = require('../src/knowledge.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

console.log('用例1:slug —— 同目录稳定,不同目录不撞,尾斜杠不影响')
{
  const a1 = K.slugFor('C:/proj/样衣系统'), a2 = K.slugFor('C:/proj/样衣系统/'), b = K.slugFor('D:/other/样衣系统')
  ok('同目录(含尾斜杠)同一 slug', a1 === a2, [a1, a2])
  ok('同名不同路径 slug 不同(靠 hash 区分)', a1 !== b, [a1, b])
  ok('slug 可读(basename 打头)', /^样衣系统_[0-9a-f]{8}$/.test(a1), a1)
  ok('fileFor 落在 knowledge/ 下', /knowledge[\\/]样衣系统_[0-9a-f]{8}\.md$/.test(K.fileFor('C:/proj/样衣系统', '/ud')), K.fileFor('C:/proj/样衣系统', '/ud'))
}

console.log('用例2:appendEntries —— 格式化、去重、日期节复用')
{
  const r1 = K.appendEntries('', [
    { text: '计息规则在 InterestCalc 的 monthly() 里,按月复利', anchors: ['src/interest/calc.js:88'], scene: '计息/跑批' },
    { text: '门户是 H5 单页,四步流程', confidence: 'suspected' },
    { text: '  ' },   // 空条目被丢
  ], '2026-07-19')
  ok('写入 2 条', r1.added === 2, r1)
  ok('带文件头与日期节', /# 项目知识库/.test(r1.content) && /## 2026-07-19/.test(r1.content))
  ok('锚点/场景/置信度格式化', /- \[verified\] 计息规则.*\(锚点: src\/interest\/calc\.js:88\) \(场景: 计息\/跑批\)/.test(r1.content) && /- \[suspected\] 门户是 H5/.test(r1.content), r1.content)
  // 重复写同一句(大小写/空白不同)→ 去重;同日再写不重复开日期节
  const r2 = K.appendEntries(r1.content, [{ text: '计息规则在 interestcalc 的 monthly() 里,按月复利' }, { text: '新事实一条' }], '2026-07-19')
  ok('同一句去重(忽略大小写)', r2.dupes === 1 && r2.added === 1, { added: r2.added, dupes: r2.dupes })
  ok('同日续写不重复开日期节', (r2.content.match(/## 2026-07-19/g) || []).length === 1)
  // 换一天 → 开新节
  const r3 = K.appendEntries(r2.content, [{ text: '又一天的事实' }], '2026-07-20')
  ok('跨天开新日期节', /## 2026-07-20/.test(r3.content))
}

console.log('用例3:injectText —— 新→旧裁剪,超长跳短条,明示略去数')
{
  ok('空库不注入', K.injectText('', 'C:/proj/x') === '')
  let content = ''
  for (let i = 1; i <= 10; i++) content = K.appendEntries(content, [{ text: '事实' + i }], '2026-07-1' + (i % 2)).content
  const t = K.injectText(content, 'C:/proj/样衣系统', { maxEntries: 3 })
  const kept = t.split('\n').filter((l) => l.startsWith('- ['))
  ok('按 maxEntries 截到 3 条', kept.length === 3, t)
  ok('留的是最新的三条且顺序不乱(事实8/9/10)', /事实8$/.test(kept[0]) && /事实9$/.test(kept[1]) && /事实10$/.test(kept[2]), kept)
  ok('头部明示略去 7 条', /略去 7 条/.test(t), t.split('\n')[1])
  ok('包 <项目知识(目录名)> 且尾接双换行(供拼接)', t.startsWith('<项目知识(样衣系统)>') && t.endsWith('</项目知识>\n\n'))
  // maxChars:一条超长 → 跳过它继续装更老的短条目
  const c2 = K.appendEntries('', [{ text: '长'.repeat(500) }, { text: '短事实' }], '2026-07-19').content
  const t2 = K.injectText(c2, 'C:/x', { maxChars: 200 })
  ok('超长条目跳过、短条目保留', !/长长/.test(t2) && /短事实/.test(t2), t2)
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
