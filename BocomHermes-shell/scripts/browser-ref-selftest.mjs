// 浏览器 ref 定位自测:npm run ref:test
//
// 【为什么要有 ref】原来 browser_read 返回的是"元素 + 现成选择器",而选择器是模型要【自己复用的字符串】:
// __text__:button|提交 在同名按钮上直接歧义,#id 遇到动态 id 又不稳 —— 拼错的后果不是报错,
// 是【点到别的元素上还成功了】,这比失败更坏(动作有回执,结论却是错的)。
// 仿 Claude Code 的做法:read_page 给每个可交互元素一个 [ref_N] 句柄,后续动作直接用句柄。
// 本仓的支撑更硬一点:读页时把 data-bh-ref 盖在 DOM 上,ref 解析成精确唯一选择器;
// 页面刷新属性就没了 → 拿旧 ref 会明确报"找不到元素",失效是【被发现的】。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// 与 src/browser-agent.js 里同口径的解析(那段埋在 initBrowserAgent(ctx) 工厂里,要 Electron 才装载)
function resolveRef(a) {
  const str = (v) => String(v == null ? '' : v)
  const refRaw = a.ref != null ? str(a.ref).trim() : ''
  const refN = refRaw ? (refRaw.match(/^(?:ref_)?(\d+)$/) || [])[1] : ''
  if (refRaw && !refN) return { error: 'bad-ref' }
  return { sel: refN ? '[data-bh-ref="' + refN + '"]' : (a.selector != null ? str(a.selector).slice(0, 1000) : '') }
}
let pass = 0, fail = 0
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : ''))) }
console.log('== 浏览器 ref 定位 ==')

ok('★ref_3 → 精确唯一选择器(不是文本匹配,不会撞同名元素)',
  resolveRef({ ref: 'ref_3' }).sel === '[data-bh-ref="3"]', resolveRef({ ref: 'ref_3' }).sel)
ok('  裸数字也认(模型常直接写 3)', resolveRef({ ref: '3' }).sel === '[data-bh-ref="3"]')
ok('  前后空格不影响', resolveRef({ ref: '  ref_12  ' }).sel === '[data-bh-ref="12"]')
ok('★ref 优先于 selector(两个都给时不许还去拼选择器)',
  resolveRef({ ref: 'ref_5', selector: '__text__:button|提交' }).sel === '[data-bh-ref="5"]')
ok('  没给 ref → 照旧用 selector(老路不许断)',
  resolveRef({ selector: '#login' }).sel === '#login')
ok('  两个都没给 → 空(交给 act 自己报缺参)', resolveRef({}).sel === '')
ok('★ref 写歪了【当场报错】,不许静默回落到 selector —— 回落会把"我以为在点 ref_3"变成点了别的',
  resolveRef({ ref: 'ref_abc', selector: '#login' }).error === 'bad-ref', resolveRef({ ref: 'ref_abc', selector: '#login' }))
ok('  空 ref 不算写歪(等于没给)', !resolveRef({ ref: '   ', selector: '#a' }).error)
ok('  超长 selector 截断到 1000(防把整段 HTML 当选择器灌进来)',
  resolveRef({ selector: 'x'.repeat(5000) }).sel.length === 1000)

console.log(fail ? ('\n❌ ref 定位:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ ref 定位:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
