// 自测:src/spin.js —— 空转探测(think-loop)。纯逻辑,时间由用例自己喂,不睡不等。
// 跑法: npm run spin:test
//
// 要守的核心是【两条边】:
//   左边 —— 真打转的必须抓到(内网实测:子 Agent 循环输出同一个 think,现有三条闸全抓不到);
//   右边 —— 长考绝不能误杀(4243cb5 刚把各处判死线放宽到 30min/2h,口径是"判死不判慢",
//            这个探测器要是把慢模型当打转杀了,等于把那一波整改推翻)。
// 右边比左边更要紧:漏杀只是慢,误杀是把正在干活的分片砍掉。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { createSpin, normSeg, fp, DEFAULTS } = require('../src/spin.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
const T = 1_000_000
const MIN = 60_000

console.log('用例1:归一化 —— "同一段又说了一遍"要能对上')
{
  ok('压空白', normSeg('我要  分析\n\n依赖') === '我要 分析 依赖', normSeg('我要  分析\n\n依赖'))
  ok('剥项目符号', normSeg('- 检查依赖') === normSeg('检查依赖'))
  ok('剥序号(阿拉伯/中文/多种分隔)',
    normSeg('1. 检查依赖') === normSeg('检查依赖') && normSeg('第 2 步:检查依赖').indexOf('检查依赖') === 0,
    [normSeg('1. 检查依赖'), normSeg('第 2 步:检查依赖')])
  ok('超长截断(防指纹被尾部噪音带偏)', normSeg('x'.repeat(400)).length === 240)
  ok('指纹稳定且区分得开', fp('abc') === fp('abc') && fp('abc') !== fp('abd'))
}

console.log('用例2:★真打转要抓到(不产出 + 自重复)')
{
  const d = createSpin()
  const same = '我需要先分析这个模块的依赖关系,搞清楚它到底被谁调用,然后再决定改哪里。'
  for (let i = 0; i <= 4; i++) d.note({ kind: 'reasoning', text: same, at: T + i * MIN })
  const v = d.verdict(T + 6 * MIN)
  ok('★同一段反复吐 + 零工具零正文 → 判打转', v.spinning === true, v)
  ok('  重复次数如实计', v.repeats >= 3, v)
}

console.log('用例3:★长考绝不能误杀(右边这条比左边更要紧)')
{
  const d = createSpin()
  // 内容一直在推进,只是慢:每分钟一段新的
  for (let i = 0; i < 10; i++) d.note({ kind: 'reasoning', text: '第' + i + '步:检查 src/mod' + i + '.ts 的导出与调用方,确认边界是否清晰。', at: T + i * MIN })
  const v = d.verdict(T + 12 * MIN)
  ok('★内容一直在推进(不重复)→ 不判,哪怕已经 12 分钟没产出', v.spinning === false, v)
  ok('  确实攒了很多段(不是因为没数据才没判)', v.segs >= 8, v)
}

console.log('用例4:★一边重复一边真在干活 → 不判(重复只是啰嗦)')
{
  const d = createSpin()
  const same = '我需要先分析这个模块的依赖关系,搞清楚它到底被谁调用,然后再决定改哪里。'
  for (let i = 0; i < 6; i++) {
    d.note({ kind: 'reasoning', text: same, at: T + i * MIN })
    d.note({ kind: 'tool', at: T + i * MIN + 100 })          // 每轮都真的调了工具
  }
  ok('★有工具调用 → 不判(它在推进,重复只是啰嗦)', d.verdict(T + 7 * MIN).spinning === false, d.verdict(T + 7 * MIN))

  const e = createSpin()
  for (let i = 0; i < 6; i++) {
    e.note({ kind: 'reasoning', text: same, at: T + i * MIN })
    e.note({ kind: 'text', text: '阶段结论 ' + i, at: T + i * MIN + 100 })
  }
  ok('  有非空正文同样算产出', e.verdict(T + 7 * MIN).spinning === false)
}

console.log('用例5:★空文本不算产出(网关会先开一个空 text part 占位)')
{
  const d = createSpin()
  const same = '我需要先分析这个模块的依赖关系,搞清楚它到底被谁调用,然后再决定改哪里。'
  for (let i = 0; i <= 4; i++) {
    d.note({ kind: 'reasoning', text: same, at: T + i * MIN })
    d.note({ kind: 'text', text: '   ', at: T + i * MIN + 50 })   // 空白占位
  }
  ok('★空/纯空白的 text 不给它续命(认它等于放走所有 think-loop)', d.verdict(T + 6 * MIN).spinning === true, d.verdict(T + 6 * MIN))
}

console.log('用例6:时间维度 —— 刚开始重复不算,得先熬过 idle 窗')
{
  const d = createSpin()
  const same = '我需要先分析这个模块的依赖关系,搞清楚它到底被谁调用,然后再决定改哪里。'
  for (let i = 0; i < 5; i++) d.note({ kind: 'reasoning', text: same, at: T + i * 1000 })   // 5 秒内连吐 5 遍
  ok('★重复够了但时间没到 → 不判(短时重复可能只是流式重发)', d.verdict(T + 6000).spinning === false, d.verdict(T + 6000))
  ok('  熬过窗口之后同一批数据就判了', d.verdict(T + DEFAULTS.idleMs + 1000).spinning === true)
}

console.log('用例7:短段落不参与判重(“好的。”“继续。”到处都是)')
{
  const d = createSpin()
  for (let i = 0; i <= 6; i++) d.note({ kind: 'reasoning', text: '好的。', at: T + i * MIN })
  ok('★短句重复不判(否则口头禅会把所有会话都判成打转)', d.verdict(T + 8 * MIN).spinning === false, d.verdict(T + 8 * MIN))
}

console.log('用例8:窗口与复位')
{
  const d = createSpin({ windowSegs: 6 })
  const same = '我需要先分析这个模块的依赖关系,搞清楚它到底被谁调用,然后再决定改哪里。'
  for (let i = 0; i < 3; i++) d.note({ kind: 'reasoning', text: same, at: T + i * MIN })
  // 之后一直吐新内容,把老的挤出窗口
  for (let i = 0; i < 10; i++) d.note({ kind: 'reasoning', text: '新的一段内容编号 ' + i + ',和前面完全不一样的分析。', at: T + (3 + i) * MIN })
  ok('★老的重复被挤出窗口后不再算数(很久以前说过一次不该判死)', d.verdict(T + 20 * MIN).spinning === false, d.verdict(T + 20 * MIN))

  const e = createSpin()
  for (let i = 0; i <= 4; i++) e.note({ kind: 'reasoning', text: same, at: T + i * MIN })
  ok('复位前是打转', e.verdict(T + 6 * MIN).spinning === true)
  e.reset()
  ok('reset 之后重新观察(新一轮不背上一轮的账)', e.verdict(T + 6 * MIN).spinning === false, e.peek())
}

console.log('用例9:脏输入不炸')
{
  const d = createSpin()
  d.note(null); d.note({}); d.note({ kind: 'reasoning' }); d.note({ kind: 'reasoning', text: null })
  d.note({ kind: '别的', text: 'x'.repeat(100), at: T })
  ok('空参/缺字段/未知 kind 一律安全', d.verdict(T).spinning === false)
  ok('  未知 kind 不进指纹表(只认 reasoning)', d.peek().segs === 0, d.peek())
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
