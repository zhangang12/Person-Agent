// 自测:src/knowledge.js(项目级知识库·任务尾蒸馏落点)—— slug 稳定性/追加去重/注入裁剪/
//   防腐校验 C1-C4(隔离·重定位回写·churn 标黄)/多锚点策略/mtime 缓存/两级索引注入/治理 API(增删改·空节清理)。
// 跑法:npm run knowledge:test(纯逻辑,假 deps 注入,不连真 fs/git/模型)
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

// ── 防腐校验 C1-C4:假 deps(内存文件表 + churn 表),不连真 fs/git ─────────────
function fakeDeps(files, churn) {
  // files: { rel: { text, mtime } };churn: { 'rel|since': 行数 或 null }
  return {
    existsFile: (rel) => !!files[rel],
    readFile: (rel) => (files[rel] ? files[rel].text : null),
    mtimeOf: (rel) => (files[rel] ? files[rel].mtime : undefined),
    churnOf: (rel, since) => (churn && (rel + '|' + since) in churn ? churn[rel + '|' + since] : null),
  }
}
// 每次用例前清进程内缓存,避免跨用例串
function fresh() { K.clearCache() }

console.log('用例4:C1 锚点文件不存在 → 隔离标红、不注入、头部明示')
{
  fresh()
  const raw = K.appendEntries('', [
    { text: '死锚点条目 SymbolDead 在此', anchors: ['gone/file.js:10'], scene: '计息' },
    { text: '无锚点的活条目' },
  ], '2026-07-19').content
  const audit = K.auditEntries(raw, fakeDeps({}), { dir: '/p' })
  ok('一死一活:stats red=1 green=1', audit.stats.red === 1 && audit.stats.green === 1, audit.stats)
  ok('死锚点标 red 且写明 C1', audit.entries[0].status === 'red' && /C1 文件不存在/.test(audit.entries[0].anchors[0].why), audit.entries[0])
  ok('无重定位则 content=null', audit.content === null)
  const t = K.injectText(raw, 'C:/x', { audit })
  ok('红条目不注入', !/SymbolDead/.test(t) && /无锚点的活条目/.test(t), t)
  ok('头部明示隔离 1 条', /1 条锚点失效已隔离/.test(t), t.split('\n')[1])
}

console.log('用例5:C2 符号不存在 + 多锚点策略(全死隔离,部分死标黄仍注入)')
{
  fresh()
  const files = {
    'a.js': { text: 'function alphaCalc() { return 1 }', mtime: 1 },
    'b.js': { text: 'const nothing = 1', mtime: 1 },
    'c.js': { text: 'const x1 = 1', mtime: 1 },
    'd.js': { text: 'const y1 = 1', mtime: 1 },
  }
  const raw = K.appendEntries('', [
    { text: '规则在 alphaCalc 里,按月复利', anchors: ['a.js:1', 'b.js:1'] },   // a 活 b 死 → 部分死
    { text: '另一条 gammaThing 规则', anchors: ['c.js:1', 'd.js:1'] },          // 双死 → 隔离
  ], '2026-07-19').content
  const audit = K.auditEntries(raw, fakeDeps(files), { dir: '/p' })
  ok('部分死 → yellow', audit.entries[0].status === 'yellow' && /1\/2 锚点失效/.test(audit.entries[0].reasons.join()), audit.entries[0].reasons)
  ok('b.js 锚点写明 C2', audit.entries[0].anchors[1].state === 'dead' && /C2 符号不存在/.test(audit.entries[0].anchors[1].why), audit.entries[0].anchors[1])
  ok('全死 → red 隔离', audit.entries[1].status === 'red', audit.entries[1])
  const t = K.injectText(raw, 'C:/x', { audit })
  ok('黄条目注入且带 [待复核] 前缀', /\[待复核\] - \[verified\] 规则在 alphaCalc/.test(t), t)
  ok('红条目不注入', !/gammaThing/.test(t), t)
  ok('[待复核] 只在注入文本,不污染条目原文(audit.content 无)', audit.content === null)
}

console.log('用例6:C3 行漂移 → 就近重定位、回写新锚点行号、条目仍注入')
{
  fresh()
  const files = { 'calc.js': { text: '// 头部注释\n\nfunction monthly() { return 1 }\nfunction monthly2() {}\n', mtime: 1 } }
  const raw = K.appendEntries('', [
    { text: '计息规则在 monthly 函数里', anchors: ['calc.js:1'], scene: '计息' },
  ], '2026-07-19').content
  const audit = K.auditEntries(raw, fakeDeps(files), { dir: '/p' })
  const a0 = audit.entries[0].anchors[0]
  ok('行漂移重定位 1→3(monthly 实际在第 3 行)', a0.state === 'relocated' && a0.line === 3, a0)
  ok('条目仍 green,reasons 写明重定位', audit.entries[0].status === 'green' && /calc\.js:1→3/.test(audit.entries[0].reasons.join()), audit.entries[0])
  ok('回写内容里锚点已更新为 calc.js:3', !!audit.content && /\(锚点: calc\.js:3\)/.test(audit.content), audit.content)
  const t = K.injectText(raw, 'C:/x', { audit })
  ok('重定位条目照常注入(不带待复核)', /计息规则在 monthly/.test(t) && !/待复核/.test(t), t)
  // 等距取小行号:monthly 在 3,锚点写 4(距 3 为 1,距其他出现行更远) → 仍 3;再验等距:锚点写 2,monthly 出现在 3,等距不存在多解 → 3
  const raw2 = K.appendEntries('', [{ text: '计息规则在 monthly 函数里', anchors: ['calc.js:2'] }], '2026-07-19').content
  fresh()
  const audit2 = K.auditEntries(raw2, fakeDeps(files), { dir: '/p' })
  ok('就近选择最近的符号出现行(2→3)', audit2.entries[0].anchors[0].line === 3, audit2.entries[0].anchors[0])
}

console.log('用例7:C4 churn 超阈 → 标黄注入带 [待复核];churn 不可用(null)→ 跳过;阈值可调')
{
  fresh()
  const files = { 'calc.js': { text: 'function monthly() {}', mtime: 1 } }
  const mk = () => K.appendEntries('', [{ text: '计息在 monthly 里', anchors: ['calc.js:1'] }], '2026-07-19').content
  const hot = K.auditEntries(mk(), fakeDeps(files, { 'calc.js|2026-07-19': 500 }), { dir: '/p' })
  ok('churn 500 > 默认阈值 300 → yellow', hot.entries[0].status === 'yellow' && /churn 500 行/.test(hot.entries[0].reasons.join()), hot.entries[0].reasons)
  const t = K.injectText(mk(), 'C:/x', { audit: hot })
  ok('注入带 [待复核]', /\[待复核\] - \[verified\] 计息在 monthly/.test(t), t)
  fresh()
  const nogit = K.auditEntries(mk(), fakeDeps(files, {}), { dir: '/p' })   // churnOf 全 null → 跳过 C4
  ok('churn 不可用 → 不受影响(green)', nogit.entries[0].status === 'green', nogit.entries[0])
  fresh()
  const hi = K.auditEntries(mk(), fakeDeps(files, { 'calc.js|2026-07-19': 500 }), { dir: '/p', churnMaxLines: 1000 })
  ok('阈值旋钮 churnMaxLines=1000 → 500 不超,green', hi.entries[0].status === 'green', hi.entries[0])
}

console.log('用例8:进程内缓存 —— mtime 不变不重读,mtime 变即失效,clearCache 强制失效')
{
  fresh()
  let reads = 0
  const files = { 'calc.js': { text: 'function monthly() {}', mtime: 1 } }
  const deps = {
    existsFile: (rel) => !!files[rel],
    readFile: (rel) => { reads++; return files[rel] ? files[rel].text : null },
    mtimeOf: (rel) => (files[rel] ? files[rel].mtime : undefined),
    churnOf: () => null,
  }
  const mk = () => K.appendEntries('', [{ text: '计息在 monthly 里', anchors: ['calc.js:1'] }], '2026-07-19').content
  K.auditEntries(mk(), deps, { dir: '/p' })
  K.auditEntries(mk(), deps, { dir: '/p' })
  ok('两次 audit 只读一遍文件(mtime 缓存)', reads === 1, reads)
  files['calc.js'].mtime = 2
  K.auditEntries(mk(), deps, { dir: '/p' })
  ok('mtime 变化 → 缓存失效重读', reads === 2, reads)
  K.clearCache()
  K.auditEntries(mk(), deps, { dir: '/p' })
  ok('clearCache 后重读', reads === 3, reads)
  const noMt = { existsFile: deps.existsFile, readFile: deps.readFile, churnOf: () => null }   // 无 mtimeOf
  const before = reads
  K.auditEntries(mk(), noMt, { dir: '/q' }); K.auditEntries(mk(), noMt, { dir: '/q' })
  ok('无 mtimeOf → 不缓存,每次实查', reads === before + 2, reads)
}

console.log('用例9:两级索引 —— scene/锚点命中必注入(优先占预算),target 为空退化纯新→旧')
{
  fresh()
  let content = K.appendEntries('', [{ text: '旧事实 计息规则在此', scene: '计息/跑批' }], '2026-07-10').content
  for (let i = 1; i <= 5; i++) content = K.appendEntries(content, [{ text: '新事实' + i }], '2026-07-20').content
  // 纯新→旧:maxEntries=3 → 最老的"旧事实"被略去
  const t0 = K.injectText(content, 'C:/x', { maxEntries: 3 })
  ok('无 target:旧事实被新→旧略去', !/旧事实/.test(t0) && /新事实5/.test(t0), t0)
  // 带 target:命中 scene"计息"的旧事实必注入,哪怕它最老
  const t1 = K.injectText(content, 'C:/x', { maxEntries: 3, target: '帮我看下计息逻辑' })
  const kept1 = t1.split('\n').filter((l) => l.startsWith('- [') || l.startsWith('[待复核]'))
  ok('命中条目越过新→旧被注入', /旧事实 计息规则在此/.test(t1), t1)
  ok('命中 1 条 + 兜底 2 条(新事实5/4)', kept1.length === 3 && /新事实5/.test(t1) && /新事实4/.test(t1) && !/新事实3/.test(t1), kept1)
  ok('头部明示场景命中 1 条优先注入', /场景命中 1 条优先注入/.test(t1), t1.split('\n')[1])
  // 锚点文件名命中(大小写不敏感)
  const c9 = K.appendEntries('', [{ text: '规则细节', anchors: ['src/x/CalcEngine.js:9'] }], '2026-07-10').content
  const t9 = K.injectText(c9, 'C:/x', { target: 'calcengine.js 这个文件干啥的' })
  ok('锚点文件名命中(大小写不敏感)', /场景命中 1 条/.test(t9), t9.split('\n')[1])
}

console.log('用例10:一级命中超预算 → 截断并明示')
{
  fresh()
  let content = ''
  for (let i = 1; i <= 3; i++) content = K.appendEntries(content, [{ text: '计息事实' + i, scene: '计息' }], '2026-07-1' + i).content
  const t = K.injectText(content, 'C:/x', { maxEntries: 2, target: '计息' })
  const kept = t.split('\n').filter((l) => l.startsWith('- ['))
  ok('命中 3 条只注入 2 条(留最新两条)', kept.length === 2 && /计息事实2/.test(t) && /计息事实3/.test(t) && !/计息事实1/.test(t), t)
  ok('头部明示命中超预算略去 1 条', /命中超预算略去 1 条/.test(t), t.split('\n')[1])
}

console.log('用例11:治理 API —— listEntries 解析 / editEntry 改 / deleteEntries 删 + 空节清理')
{
  fresh()
  let content = K.appendEntries('', [
    { text: '计息规则在 monthly 里', anchors: ['calc.js:88'], scene: '计息/跑批', confidence: 'verified' },
    { text: '门户是 H5 单页', confidence: 'suspected' },
  ], '2026-07-19').content
  content = K.appendEntries(content, [{ text: '第二天的事实' }], '2026-07-20').content
  const list = K.listEntries(content)
  ok('解析出 3 条,index 连续', list.length === 3 && list.map((e) => e.index).join() === '0,1,2', list.map((e) => e.index))
  ok('字段齐全(date/confidence/text/anchors/scene/raw)',
    list[0].date === '2026-07-19' && list[0].confidence === 'verified' && list[0].text === '计息规则在 monthly 里'
    && list[0].anchors.join() === 'calc.js:88' && list[0].scene === '计息/跑批' && list[0].raw.startsWith('- [verified]')
    && list[1].confidence === 'suspected' && list[2].date === '2026-07-20', list)
  // editEntry:改正文+锚点+场景
  const e1 = K.editEntry(content, 1, { text: '门户其实是桌面壳', anchors: ['src/shell.js:7'], scene: '架构' })
  const l1 = K.listEntries(e1)[1]
  ok('editEntry 改正文/锚点/场景', l1.text === '门户其实是桌面壳' && l1.anchors.join() === 'src/shell.js:7' && l1.scene === '架构', l1)
  ok('editEntry 不动其他条目', K.listEntries(e1)[0].text === '计息规则在 monthly 里' && K.listEntries(e1)[2].text === '第二天的事实')
  ok('editEntry 非法 index 原样返回', K.editEntry(content, 99, { text: 'x' }) === content)
  ok('editEntry 空 text 视为不改', K.listEntries(K.editEntry(content, 0, { text: '  ' }))[0].text === '计息规则在 monthly 里')
  // deleteEntries:删 2026-07-19 节全部两条 → 该节头连节删掉,另一节保留
  const d1 = K.deleteEntries(content, [0, 1])
  ok('删除后只剩 1 条', K.listEntries(d1).length === 1 && K.listEntries(d1)[0].text === '第二天的事实', d1)
  ok('空日期节连节头清掉(## 2026-07-19 没了,## 2026-07-20 还在)', !/## 2026-07-19/.test(d1) && /## 2026-07-20/.test(d1), d1)
  ok('文件头保留', /# 项目知识库/.test(d1))
  // 全删完 → 只剩文件头
  const d2 = K.deleteEntries(content, [0, 1, 2])
  ok('全删完只剩文件头,无日期节残留', K.listEntries(d2).length === 0 && !/## /.test(d2) && /# 项目知识库/.test(d2), d2)
}

console.log('用例12:正文无标识符 → 锚点行内容兜底(只验证存在性,信任原行号)')
{
  fresh()
  const files = { 'x.js': { text: 'const alphaOne = 1\nconst betaTwo = 2\n', mtime: 1 } }
  const raw = K.appendEntries('', [{ text: '这里没有标识符', anchors: ['x.js:1'] }], '2026-07-19').content
  const audit = K.auditEntries(raw, fakeDeps(files), { dir: '/p' })
  const a0 = audit.entries[0].anchors[0]
  ok('锚点行提取符号验证存在 → ok 且注明信任原行号', a0.state === 'ok' && /信任原行号/.test(a0.why), a0)
  ok('条目 green 注入', audit.entries[0].status === 'green' && /这里没有标识符/.test(K.injectText(raw, 'C:/x', { audit })))
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
