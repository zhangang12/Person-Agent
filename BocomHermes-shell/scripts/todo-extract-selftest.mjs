// 自测:src/todo-extract-llm.js(邮件待办语义提取)——
//   预筛 hasTimeSignal / prompt 构建 / parseItems 健壮性(废话包装/markdown 围栏/坏 JSON/类型校验/去重/上限)/
//   extract 端到端(假 askLLM:防幻觉 msgId/at 原文→时间戳/字段回填);meeting-extract.resolveWhen 时间换算。
// 跑法:npm run todo:test(零依赖 ok() 风格,不连真 serve/模型)
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const X = require('../src/todo-extract-llm.js')
const { resolveWhen } = require('../src/meeting-extract.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const EM = (id, subject, body, date) => ({ messageId: id, from: 'a@b.com', subject, text: body, date: date || '2026-07-28T09:00:00+08:00' })

console.log('用例1:hasTimeSignal 预筛 —— 有日期/截止/会议信号才送模型,啥都没有的邮件直接弃')
{
  ok('有截止时间信号', X.hasTimeSignal(EM('m1', '周报提醒', '请大家周五前提交周报')))
  ok('有日期信号', X.hasTimeSignal(EM('m2', '安排', '7月30日有个评审')))
  ok('有会议词', X.hasTimeSignal(EM('m3', '会议邀请', 'zoom 链接如下')))
  ok('纯知会无信号 → 弃', !X.hasTimeSignal(EM('m4', '关于发布新流程的通知', '现将新流程予以公布,请知悉。')))
  ok('空邮件不炸', !X.hasTimeSignal({}), true)
}

console.log('用例2:buildPrompt —— 邮件进 prompt、正文截断、两类口径与负面清单都在')
{
  const p = X.buildPrompt([EM('m1', '主题甲', '正文'), EM('m2', '主题乙', 'x'.repeat(2000))])
  ok('msgId/主题进 prompt', p.includes('m1') && p.includes('主题甲') && p.includes('m2'))
  ok('正文截 600 字', !p.includes('x'.repeat(700)))
  ok('口径:ddl + meeting 两类', p.includes('"ddl"') && p.includes('"meeting"'))
  ok('负面清单在(讨论/订阅/含糊时间)', p.includes('不要挑') && p.includes('尽快'))
}

console.log('用例3:parseItems —— 各种模型输出形态的健壮性')
{
  ok('干净 JSON', X.parseItems('[{"msgId":"m1","type":"ddl","title":"交周报","at":"周五"}]').length === 1)
  ok('废话包装', X.parseItems('好的,结果如下:\n[{"msgId":"m1","type":"meeting","title":"评审","at":""}]\n以上。').length === 1)
  ok('markdown 围栏', X.parseItems('```json\n[{"msgId":"m1","type":"ddl","title":"t","at":""}]\n```').length === 1)
  ok('坏 JSON → []', X.parseItems('[{"msgId":"m1",').length === 0)
  ok('无数组 → []', X.parseItems('没有可挑的').length === 0)
  ok('type 非法丢弃', X.parseItems('[{"msgId":"m1","type":"task","title":"t","at":""}]').length === 0)
  ok('msgId 空丢弃', X.parseItems('[{"msgId":"","type":"ddl","title":"t","at":""}]').length === 0)
  const dup = X.parseItems('[{"msgId":"m1","type":"ddl","title":"a","at":""},{"msgId":"m1","type":"meeting","title":"b","at":""}]')
  ok('同 msgId 只留第一项', dup.length === 1 && dup[0].title === 'a', dup)
  const many = '[' + Array.from({ length: 30 }, (_, i) => '{"msgId":"x' + i + '","type":"ddl","title":"t","at":""}').join(',') + ']'
  ok('cap 20', X.parseItems(many).length === 20)
}

console.log('用例4:extract 端到端(假 askLLM)—— 防幻觉 msgId/at→时间戳/字段回填/空批次')
{
  const batch = [EM('m1', '周报截止提醒', '请于明天下午3点前提交周报'), EM('m2', '评审会邀请', '7月30日18:00 评审,链接 https://meeting.tencent.com/x')]
  const ask = async (prompt) => {
    ok('prompt 含两封邮件', prompt.includes('m1') && prompt.includes('m2'))
    return '[{"msgId":"m1","type":"ddl","title":"提交周报","at":"明天下午3点"},'
      + '{"msgId":"m2","type":"meeting","title":"评审会","at":"7月30日18:00","link":"https://meeting.tencent.com/x"},'
      + '{"msgId":"m999","type":"ddl","title":"幻觉项","at":"明天"}]'
  }
  const items = await X.extract(batch, ask)
  ok('两项命中,幻觉 msgId 被丢', items.length === 2, items)
  const d = items.find((x) => x.msgId === 'm1')
  ok('ddl:kind/text 回填', d && d.kind === 'ddl' && d.text === '提交周报', d)
  ok('ddl:at→meetingAt(明天15:00)', d && d.meetingAt > 0 && new Date(d.meetingAt).getHours() === 15, d && d.meetingAt)
  const m = items.find((x) => x.msgId === 'm2')
  ok('meeting:链接+时间(18:00)', m && m.link.includes('tencent') && new Date(m.meetingAt).getHours() === 18, m)
  ok('空批次不调模型', await X.extract([], async () => { throw new Error('不该被调') }).then((r) => r.length === 0))
  ok('模型返回 [] → []', (await X.extract(batch, async () => '[]')).length === 0)
}

console.log('用例5:resolveWhen —— 时间点原文换算(规则与语义同历)')
{
  const base = Date.parse('2026-07-28T09:00:00+08:00')   // 周二
  const t1 = resolveWhen('明天下午3点', base)
  ok('明天下午3点 → +1天 15:00', t1 > 0 && new Date(t1).getHours() === 15 && new Date(t1).getDate() === 29, t1)
  const t2 = resolveWhen('7月30日18:00', base)
  ok('7月30日18:00 → 30号 18:00', t2 > 0 && new Date(t2).getDate() === 30 && new Date(t2).getHours() === 18, t2)
  const t3 = resolveWhen('周五 14:30', base)
  ok('周五 14:30 → 本周五(7/31)', t3 > 0 && new Date(t3).getDay() === 5 && new Date(t3).getHours() === 14 && new Date(t3).getMinutes() === 30, t3)
  ok('解不出 → 0', resolveWhen('尽快', base) === 0 && resolveWhen('', base) === 0)
}

console.log('')
if (fail) { console.log('❌ 有失败  ' + pass + ' passed, ' + fail + ' failed'); process.exit(1) }
console.log('✅ 全部通过  ' + pass + ' passed, 0 failed')
