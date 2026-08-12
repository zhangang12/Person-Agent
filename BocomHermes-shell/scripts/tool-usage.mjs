// 工具使用率:npm run tool:usage
//
// 【这个脚本回答一个问题】那 28 个工具做出来了,内网的 opencode 到底【会不会自己用】?
// 这问题问我或问它都不算数 —— 它是可数的。壳层每次工具调用都记一笔(userData/tool-usage.json),
// 这里把它摊开:谁被用得最多、谁一次都没碰过、谁的失败率高。
//
// 怎么读:
// · 从没被调用过 → 要么它不知道有(规程/回执没讲到),要么它不需要。二者的处理完全不同,别混。
// · 失败率高 → 工具本身有问题,或者它用错了姿势(看失败原因)。
// · act 按动作分开计:click 用一万次而 point/drag 从没用过,那才是真实情况。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
// 全表:relay 路由 + act 的每个动作。改工具时这里要跟着加,不然"从没用过"会漏报成"没这个工具"。
const ROUTES = ['open', 'read', 'find', 'act', 'eval', 'html', 'upload', 'save_flow', 'see', 'state', 'cookie', 'tabs', 'resize', 'assert', 'shot', 'diag', 'close']
const ACTS = ['click', 'right_click', 'double_click', 'type', 'select', 'check', 'enter', 'key', 'scroll', 'wheel', 'hover', 'navigate', 'back', 'forward', 'dialog', 'drag', 'point', 'wait']
const ALL = [...ROUTES.filter((r) => r !== 'act'), ...ACTS.map((x) => 'act:' + x)]

const f = path.join(userData(), 'tool-usage.json')
let u = null
try { u = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
if (!u) {
  console.log('还没有 ' + f)
  console.log('—— 说明这台机器上【一次工具调用都没发生过】(或者还没重启过带这个功能的版本)。')
  console.log('让 Agent 真跑一轮浏览器任务,再回来跑本脚本。')
  process.exit(0)
}
const rows = Object.entries(u).map(([k, v]) => ({ k, n: v.n || 0, fail: v.fail || 0, avg: v.n ? Math.round(v.ms / v.n) : 0, last: v.last || '' }))
rows.sort((a, b) => b.n - a.n)
const total = rows.reduce((s, r) => s + r.n, 0)

console.log('== 用过的工具(共 ' + total + ' 次调用)==')
for (const r of rows) {
  const bar = '█'.repeat(Math.max(1, Math.round((r.n / (rows[0].n || 1)) * 24)))
  console.log('  ' + r.k.padEnd(18) + String(r.n).padStart(5) + ' 次  ' + bar
    + (r.fail ? '  失败 ' + r.fail + ' (' + Math.round((r.fail / r.n) * 100) + '%)' : '')
    + '  均 ' + r.avg + 'ms')
}
const never = ALL.filter((k) => !u[k])
console.log('\n== ★一次都没被调用过(' + never.length + '/' + ALL.length + ')==')
console.log(never.length ? '  ' + never.join('  ') : '  (没有 —— 全都用过至少一次)')
console.log('\n【怎么处理】没被调用的工具分两种,处理完全不同:')
console.log('  · 它不知道有 → 补规程 / 补回执提示(壳层的事)。判据:这类场景明明出现过,它却绕路解决了。')
console.log('  · 它不需要 → 不用管。判据:场景根本没出现过(比如这些页面就没有拖拽)。')
console.log('分不清的时候看思考过程:它有没有【为这件事纠结过】。纠结了还没用,就是第一种。')
const hi = rows.filter((r) => r.n >= 3 && r.fail / r.n > 0.3)
if (hi.length) {
  console.log('\n== ⚠ 失败率超 30% 的(工具有问题,或者它用错了姿势)==')
  for (const r of hi) console.log('  ' + r.k + '  ' + r.fail + '/' + r.n)
}
