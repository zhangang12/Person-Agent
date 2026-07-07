// 回归测试:recorder-core.compactEvents —— 录制降噪(逐事件照录 → 有意义的操作序列)。
// 主 fixture 用真实录制 rec_mraifhpl(登录 8.141.123.141 → 用户反馈 → 导出 HTML)的原始 22 步事件流,
// 断言:密码 4 步→1、admin 2 步→1、滚动/Tab 删除、登录三重提交(Enter+点按钮+submit)收成单次点击。
// 另加合成边界用例:不跨元素误并、不误删两次真实点击、无按钮表单的 Enter 保留、survivors+dropped 可还原。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { compactEvents } = require('../src/recorder-core.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
const acts = (list) => list.map((e) => e.act)
const count = (list, pred) => list.filter(pred).length

// ── 主 fixture:rec_mraifhpl 的原始 22 步(选择器/文案/时间戳照抄真实录制)──────────
const U = 'http://8.141.123.141/login'
const raw = [
  { t: 0,     act: 'navigate', url: U },
  { t: 9784,  act: 'click',    sel: '#s', text: '' },
  { t: 10523, act: 'input',    sel: '#s', value: U },
  { t: 11111, act: 'key',      sel: '#s', key: 'Enter' },
  { t: 11112, act: 'submit',   sel: '#f' },
  { t: 13898, act: 'click',    sel: '#el-id-565-2', text: '' },
  { t: 16947, act: 'input',    sel: '#el-id-565-2', value: 'admin' },
  { t: 17258, act: 'input',    sel: '#el-id-565-2', value: 'admin' },
  { t: 17464, act: 'key',      sel: '#el-id-565-2', key: 'Tab' },
  { t: 18950, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 20473, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 21895, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 22495, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 22611, act: 'key',      sel: '#el-id-565-3', key: 'Enter' },
  { t: 22623, act: 'click',    sel: '__text__:button|登 录', text: '登 录' },
  { t: 22623, act: 'submit',   sel: '__text__:form|登 录' },
  { t: 23605, act: 'navigate', url: 'http://8.141.123.141/overview', spa: true },
  { t: 26148, act: 'scroll',   x: 0, y: 0 },
  { t: 27437, act: 'click',    sel: '__text__:span|用户反馈', text: '用户反馈' },
  { t: 27611, act: 'navigate', url: 'http://8.141.123.141/admin/user-feedback', spa: true },
  { t: 31039, act: 'click',    sel: '__text__:span|导出待处理 HTML', text: '导出待处理 HTML' },
  { t: 32243, act: 'click',    sel: 'a', text: '' },
]

console.log('用例1:真实录制 rec_mraifhpl 22 步降噪')
const { events: out, dropped } = compactEvents(raw)
ok('22 步 → 11 步', out.length === 11, { got: out.length, dropped: dropped.length })
ok('survivors + dropped = 原始 22 步(可还原)', out.length + dropped.length === raw.length, { out: out.length, dropped: dropped.length })
ok('密码步(#el-id-565-3)由 4 → 1(治 4 个密码参数)', count(out, (e) => e.sel === '#el-id-565-3') === 1, count(out, (e) => e.sel === '#el-id-565-3'))
ok('保留的密码步 secret 与终值正确', (() => { const p = out.find((e) => e.sel === '#el-id-565-3'); return p && p.act === 'input' && p.secret === true })())
ok('admin 输入(#el-id-565-2)由 2 → 1', count(out, (e) => e.sel === '#el-id-565-2' && e.act === 'input') === 1)
ok('scroll 已删', count(out, (e) => e.act === 'scroll') === 0)
ok('key:Tab 已删', count(out, (e) => e.act === 'key' && e.key === 'Tab') === 0)
ok('登录三重提交(Enter+点按钮+submit)→ 单次:submit 全删', count(out, (e) => e.act === 'submit') === 0, acts(out))
ok('登录按钮点击保留(比 Enter/submit 更稳)', count(out, (e) => e.act === 'click' && /登.*录/.test(String(e.text || ''))) === 1)
ok('#el-id-565-3 上的 Enter 被删(与点按钮同意图)', count(out, (e) => e.act === 'key' && e.sel === '#el-id-565-3') === 0)
ok('仅聚焦的 click(#s / #el-id-565-2 后随输入)已删', count(out, (e) => e.act === 'click' && (e.sel === '#s' || e.sel === '#el-id-565-2')) === 0)
ok('业务点击均保留(登录/用户反馈/导出/末尾链接 = 4)', count(out, (e) => e.act === 'click') === 4, acts(out))
ok('导航步全保留(login/overview/feedback = 3)', count(out, (e) => e.act === 'navigate') === 3)
// 边界说明:#s 是新标签页搜索框,属 chrome 噪声;compaction 只能把它从 4 步(click/input/Enter/submit)压到 2 步
// (input + Enter,click/submit 被去焦点/提交去重删掉),彻底根治靠 RECORDER_JS 的源头守卫(新录制不再进这些步)。
ok('#s 搜索框残留 2 步(源头守卫负责根治,非 compaction 职责)', count(out, (e) => e.sel === '#s') === 2, acts(out))
// 每条 dropped 都带原下标与原因
ok('dropped 明细带 i/act/reason', dropped.every((d) => Number.isInteger(d.i) && d.act && d.reason), dropped.slice(0, 2))

console.log('用例2:不跨元素误并输入')
{
  const r = [
    { t: 0, act: 'input', sel: '#a', value: '1' },
    { t: 1, act: 'input', sel: '#b', value: '2' },
    { t: 2, act: 'input', sel: '#a', value: '3' },
  ]
  const { events } = compactEvents(r)
  ok('三个不连续/不同元素输入全保留', events.length === 3, acts(events))
}

console.log('用例3:同元素连续输入取最后值')
{
  const r = [
    { t: 0, act: 'input', sel: '#a', value: 'ab' },
    { t: 1, act: 'input', sel: '#a', value: 'abc' },
    { t: 2, act: 'input', sel: '#a', value: 'abcd' },
  ]
  const { events } = compactEvents(r)
  ok('3 连输入 → 1', events.length === 1)
  ok('保留最后一次的值 abcd', events[0] && events[0].value === 'abcd', events[0])
}

console.log('用例4:无提交按钮的表单 —— Enter 保留(回放靠它 requestSubmit)')
{
  const r = [
    { t: 0, act: 'input', sel: '#q', value: 'x' },
    { t: 1, act: 'key',   sel: '#q', key: 'Enter' },
  ]
  const { events } = compactEvents(r)
  ok('input + Enter 都保留', events.length === 2 && events[1].key === 'Enter', acts(events))
}

console.log('用例5:两次真实点击不同按钮 —— 不误删')
{
  const r = [
    { t: 0, act: 'click', sel: '#add', text: '新增' },
    { t: 1, act: 'click', sel: '#save', text: '保存' },
  ]
  const { events } = compactEvents(r)
  ok('新增 + 保存两次点击都保留', events.length === 2, acts(events))
}

console.log('用例6:Enter 后跟【非提交】点击 —— Enter 不误删')
{
  const r = [
    { t: 0, act: 'key',   sel: '#q', key: 'Enter' },
    { t: 1, act: 'click', sel: '#row3', text: '张三' },   // 点搜索结果行,不是提交
  ]
  const { events } = compactEvents(r)
  ok('Enter 与结果行点击都保留', events.length === 2 && count(events, (e) => e.act === 'key') === 1, acts(events))
}

console.log('用例7:空输入/异常入参不崩')
{
  ok('null → 空', compactEvents(null).events.length === 0)
  ok('[] → 空', compactEvents([]).events.length === 0)
  ok('无 t 字段不崩', compactEvents([{ act: 'submit', sel: '#f' }, { act: 'click', sel: '#b', text: '提交' }]).events.length >= 1)
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
