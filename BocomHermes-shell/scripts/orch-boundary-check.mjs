/**
 * 编排引擎边界 lint:src/orch/ 的纯度是【可执行的约束】,不是文档里的一句约定。
 * 跑法:node scripts/orch-boundary-check.mjs  (npm run orch:lint)
 *
 * 为什么要有这个文件:
 *   这次重构的全部收益都建立在"编排逻辑是纯的"之上 —— 纯了才能被 orch-selftest 逐行断言、
 *   才能确定性重放、才能在不起 Electron/serve/网络的情况下跑完整状态机。
 *   而"纯"是极易被顺手破坏的:某天为了取个路径 require 一下 fs,为了打个时间戳用一下 Date.now(),
 *   编排就重新变成只能靠真实跑才能验的黑盒 —— 也就是这次要根除的那个状态。
 *   现状(旧引擎)正是这么长起来的:判据、计时、投递、文案全部长在 window.js 的一个函数体里。
 *
 * 规则(逐条给理由):
 *   R1 不许 require electron / 主进程模块 —— 一旦依赖,自测就得起 Electron,回归成本立刻变高
 *   R2 不许 require fs / net / http / child_process —— 读盘与跑命令属于 effect,由 index.js 执行后【回灌成事件】
 *   R3 不许 Date.now() / new Date() / Math.random() —— 时间与 id 由外部注入(ev.at / ctx.mkId),
 *      否则同一份 journal 重放不出同一个结果,replay 用例就永远是"大概对"
 *   R4 不许出现全局状态 S. —— 编排状态的唯一真相源是传进来的 run 对象
 *   R5 nodes.js 是唯一例外:它做退出检查(读产出文件、跑验证命令),但只能通过【注入的 probe】做,
 *      自己仍不许 require fs/child_process
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'src', 'orch')

const RULES = [
  { id: 'R1', re: /require\(\s*['"](electron|\.\.\/window|\.\.\/session|\.\.\/mail|\.\.\/card-cleanup)['"]/, why: '不许依赖 Electron / 主进程模块(依赖了自测就得起 Electron)' },
  { id: 'R2', re: /require\(\s*['"](?:node:)?(?:fs|net|http|https|child_process|dgram|worker_threads)['"]/, why: '读盘/跑命令/联网属于 effect,由 index.js 执行后回灌成事件' },
  { id: 'R3a', re: /\bDate\.now\s*\(/, why: '时间由外部注入(ev.at),否则 journal 重放不出同一个结果' },
  { id: 'R3b', re: /\bnew\s+Date\s*\(\s*\)/, why: '同 R3a' },
  { id: 'R3c', re: /\bMath\.random\s*\(/, why: 'id 由外部注入(ctx.mkId),否则重放不确定' },
  { id: 'R4', re: /(^|[^\w.])S\.[a-zA-Z]/, why: '编排状态的唯一真相源是传进来的 run 对象,不许读全局 S' },
]
// 注释与文档块里出现这些字样是允许的(本文件自己就是例子):按行剥注释后再判
function stripComments(src) {
  const out = []
  let inBlock = false
  for (const raw of src.split('\n')) {
    let line = raw
    if (inBlock) { const e = line.indexOf('*/'); if (e < 0) { out.push(''); continue } line = line.slice(e + 2); inBlock = false }
    for (;;) {
      const b = line.indexOf('/*')
      if (b < 0) break
      const e = line.indexOf('*/', b + 2)
      if (e < 0) { line = line.slice(0, b); inBlock = true; break }
      line = line.slice(0, b) + line.slice(e + 2)
    }
    const l = line.indexOf('//')
    if (l >= 0) line = line.slice(0, l)
    out.push(line)
  }
  return out
}

// 豁免必须是【逐文件 + 逐规则】的白名单,不许整体放宽 —— 一旦写成"某些文件不检查",
// 纯度就会从 run.js 开始一点点漏出去。每条豁免都要写清它是什么角色、为什么必须破例。
const EXEMPT = {
  'journal.js': { rules: ['R2'], why: '状态机的存储适配器(run.json 原子写/扫描/GC),必须碰 fs;它不参与任何判定' },
  'decide.js': { rules: ['R3a', 'R3b', 'R4'], why: '模型调用的 IO 适配器:超时用墙钟(Promise.race),S 是注入依赖且只取 handlers/settings 两个只读字段喂给 oc —— 不参与任何编排判定' },
  'index.js': { rules: ['R1', 'R2', 'R3a', 'R3b', 'R3c', 'R4'], why: '装配层:全案唯一允许碰 Electron / S / fs 的文件,effects 在这里被执行' },
}

let bad = 0, files = 0
if (!fs.existsSync(DIR)) { console.log('✗ 找不到 ' + DIR); process.exit(1) }
for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()) {
  const fp = path.join(DIR, name)
  const lines = stripComments(fs.readFileSync(fp, 'utf8'))
  files++
  const ex = EXEMPT[name]
  const hits = []
  lines.forEach((line, i) => {
    for (const r of RULES) {
      if (!r.re.test(line)) continue
      if (ex && ex.rules.indexOf(r.id) >= 0) continue
      hits.push({ rule: r, line: i + 1, text: line.trim().slice(0, 110) })
    }
  })
  if (!hits.length) { console.log('  ✓ src/orch/' + name + (ex ? '  (豁免 ' + ex.rules.join('/') + ':' + ex.why + ')' : '')); continue }
  for (const h of hits) { bad++; console.log('  ✗ src/orch/' + name + ':' + h.line + '  [' + h.rule.id + '] ' + h.rule.why + '\n      ' + h.text) }
}
console.log('\n' + (bad ? '❌ ' : '✅ ') + '编排边界检查:' + files + ' 个文件,' + bad + ' 处越界')
process.exit(bad ? 1 : 0)
