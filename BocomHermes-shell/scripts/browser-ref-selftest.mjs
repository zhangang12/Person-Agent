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

// ── find 的匹配打分(与 agentFind 注入页面的那段同口径)──────────────────────
// 【为什么单测它】find 的价值在于"模型说人话就能拿到 ref";打分错了它会把不相干的排前面,
// 而模型通常只看第一条 —— 排错序 = 点错元素,和拼错选择器一个后果。
function score(hay, q) {
  const toks = q.toLowerCase().split(/[\s,，、]+/).filter(Boolean)
  const h = hay.toLowerCase()
  let sc = 0
  for (const t of toks) if (h.indexOf(t) >= 0) sc++
  if (h.indexOf(q.toLowerCase()) >= 0) sc += 2
  return sc
}
console.log('\n== find 匹配打分 ==')
ok('★整串命中排在只命中一个词的前面', score('button 登录', '登录') > score('button 登录注册说明', '登录 说明') - 3)
ok('  完全不相干 → 0(不进结果)', score('input 用户名', '提交按钮') === 0)
ok('  多词任一命中就算(宁可多给几条,也别一条不给)', score('a 退出登录', '退出 zzz') === 1)
ok('★大小写不敏感(模型写 Submit / submit 都得中)', score('button Submit', 'submit') > 0 && score('button submit', 'Submit') > 0)
ok('  中文按整串匹配(不会被空格切碎)', score('button 提交订单', '提交订单') >= 3)

// ── key 白名单 ────────────────────────────────────────────────────────────
// 【为什么要白名单】不挡的话模型会把整句话当按键发(实测常见),而那既不会报错也不会生效 ——
// 又是一个"动作看着成功、其实什么都没发生"的静默失败。
const KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']
const pickKey = (k) => KEYS.find((x) => x.toLowerCase() === String(k || '').trim().toLowerCase()) || ''
console.log('\n== key 白名单 ==')
ok('★常用键都在(Escape 关弹层 / Tab 移焦点 / 方向键选下拉,原来只有 enter)',
  ['Escape', 'Tab', 'ArrowDown'].every((k) => pickKey(k) === k))
ok('  大小写随便写', pickKey('escape') === 'Escape' && pickKey('ENTER') === 'Enter')
ok('★整句话当按键 → 拒(否则既不报错也不生效,又是一次静默失败)', pickKey('按回车提交') === '')

// ── diag 的筛选(与 agentDiag 同口径)────────────────────────────────────────
// 【为什么要测】排障时最值钱的三件事都靠它:按关键词找那一条、看【成功】请求返回了什么、取响应体。
// 原来只给 error + 失败请求 —— 而"接口通了但返回体不对"是前端 bug 的大头,只看状态码永远看不见。
const S2 = (x) => (x == null ? '' : String(x))
const A2 = (x) => (Array.isArray(x) ? x : [])
const TAB = {
  console: [{ level: 3, message: 'TypeError: x is not a function', source: 'app.js', line: 12 },
    { level: 2, message: 'deprecated api' }, { level: 1, message: 'hello' },
    { level: 3, message: 'Failed to fetch /api/user' }],
  net: [{ id: 'r1', status: 200, method: 'GET', url: '/api/user' },
    { id: 'r2', status: 500, method: 'POST', url: '/api/order' },
    { id: 'r3', state: 'failed', method: 'GET', url: '/static/x.png' }],
}
function diagPick(a) {
  const lvl = S2((a && a.level) || 'error').toLowerCase()
  const wantLvl = lvl === 'all' ? null : lvl === 'warn' ? [2, 3] : [3]
  const pat = S2(a && a.pattern).trim().toLowerCase()
  const con = A2(TAB.console).filter((e) => e && (!wantLvl || wantLvl.indexOf(e.level) >= 0)
    && (!pat || (S2(e.message) + ' ' + S2(e.source)).toLowerCase().indexOf(pat) >= 0))
  const only = S2((a && a.only) || 'failed').toLowerCase()
  const up = S2(a && a.urlPattern).trim().toLowerCase()
  const net = A2(TAB.net).filter((r) => r && (only === 'all' || r.state === 'failed' || (r.status || 0) >= 400)
    && (!up || S2(r.url).toLowerCase().indexOf(up) >= 0))
  return { con: con.length, net: net.length }
}
console.log('\n== diag 筛选 ==')
ok('缺省 = 老行为(只给 error + 失败请求),老调用不受影响',
  diagPick({}).con === 2 && diagPick({}).net === 2, diagPick({}))
ok('★level=all 看得到 warn 与 log(排"页面看着正常"的问题要靠它)', diagPick({ level: 'all' }).con === 4, diagPick({ level: 'all' }))
ok('  level=warn 含 warn 与 error', diagPick({ level: 'warn' }).con === 3, diagPick({ level: 'warn' }))
ok('★pattern 按关键词命中那一条(报错信息通常已知一半)', diagPick({ pattern: 'fetch' }).con === 1, diagPick({ pattern: 'fetch' }))
ok('  pattern 也匹配来源文件', diagPick({ pattern: 'app.js' }).con === 1)
ok('★only=all 才看得到【成功】请求 —— "接口通了但返回体不对"只有这样才发现得了',
  diagPick({ only: 'all' }).net === 3, diagPick({ only: 'all' }))
ok('★urlPattern 收窄到某个接口', diagPick({ only: 'all', urlPattern: '/api' }).net === 2, diagPick({ only: 'all', urlPattern: '/api' }))
ok('  筛不到就是 0(不许兜底把全部倒出来)', diagPick({ only: 'all', urlPattern: '/nope' }).net === 0)

// ── 多标签的三条守则(与 agentTabs 同口径)──────────────────────────────────
// 这三条都是"不守就出事"的:借开标签绕过白名单 / 去动用户自己的页面 / 把会话关成空壳。
function tabsGuard(st, a, policyOk) {
  const ids = st.tabIds
  const act = String((a && a.action) || 'list')
  if (act === 'open') {
    if (!policyOk) return 'fenced'
    if (ids.length >= 5) return 'too-many'
    return 'ok'
  }
  const tid = a && a.tabId != null ? a.tabId : null
  if (act === 'switch' || act === 'close') {
    if (tid == null) return 'need-id'
    if (!ids.some((x) => String(x) === String(tid))) return 'not-mine'
    if (act === 'close' && ids.length <= 1) return 'last-one'
  }
  return 'ok'
}
console.log('\n== 多标签守则 ==')
ok('★新开标签一样过围栏(不许借开标签绕过白名单)',
  tabsGuard({ tabIds: [1] }, { action: 'open', url: 'http://evil' }, false) === 'fenced')
ok('  围栏放行就能开', tabsGuard({ tabIds: [1] }, { action: 'open' }, true) === 'ok')
ok('★只能操作自己开的标签(用户手动开的页面不归 Agent 碰)',
  tabsGuard({ tabIds: [1, 2] }, { action: 'switch', tabId: 9 }, true) === 'not-mine')
ok('  自己的标签可以切', tabsGuard({ tabIds: [1, 2] }, { action: 'switch', tabId: 2 }, true) === 'ok')
ok('★不许关掉最后一个(关完 tabOf 全空,后续每个工具都报"标签页已被关掉",会话等于废了)',
  tabsGuard({ tabIds: [1] }, { action: 'close', tabId: 1 }, true) === 'last-one')
ok('  还有两个时可以关', tabsGuard({ tabIds: [1, 2] }, { action: 'close', tabId: 1 }, true) === 'ok')
ok('  switch/close 必须给 tabId', tabsGuard({ tabIds: [1, 2] }, { action: 'close' }, true) === 'need-id')
ok('  标签数封顶 5(验证不是浏览)', tabsGuard({ tabIds: [1, 2, 3, 4, 5] }, { action: 'open' }, true) === 'too-many')

console.log(fail ? ('\n❌ ref 定位:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ ref 定位:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
