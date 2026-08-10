// 同屏分栏几何自测:npm run split:test
//
// 【为什么值得单测】这三条边界都是"错了才发现"的那种,而它们埋在 initBrowser(ctx) 工厂里
// (要 Electron 才装载得起来),所以先抽成纯模块 src/browser-split.js 再逐例断言。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { splitChatW, MIN, SIDE_DEFAULT } = require('../src/browser-split.js')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
console.log('== 同屏分栏几何(对话在左 / 内嵌浏览器在右)==')

ok('关(want=0)→ 0:浏览器铺满内容区,老行为逐字节不变', splitChatW(1600, 0, SIDE_DEFAULT) === 0)
ok('  脏值当关处理(不许把布局搞崩)',
  splitChatW(1600, null, SIDE_DEFAULT) === 0 && splitChatW(1600, NaN, SIDE_DEFAULT) === 0 && splitChatW(1600, -5, SIDE_DEFAULT) === 0)
ok('★正常窗口:对话拿到它要的宽', splitChatW(1600, 600, SIDE_DEFAULT) === 600, splitChatW(1600, 600, SIDE_DEFAULT))

// ① 太窄:硬挤的话两边都不能用 —— 宁可退回互斥
ok('★窗口挤不出两个 ' + MIN + ' → 退回互斥(0),不做"两边都不能用"的分栏',
  splitChatW(900, 400, SIDE_DEFAULT) === 0, splitChatW(900, 400, SIDE_DEFAULT))
ok('  刚好够 → 就分(边界不许多减一像素)',
  splitChatW(SIDE_DEFAULT + MIN * 2, 400, SIDE_DEFAULT) === MIN, splitChatW(SIDE_DEFAULT + MIN * 2, 400, SIDE_DEFAULT))

// ② 两头保底:谁都不许被挤没
ok('★对话要太宽 → 给浏览器保底 ' + MIN,
  splitChatW(1600, 5000, SIDE_DEFAULT) === 1600 - SIDE_DEFAULT - MIN, splitChatW(1600, 5000, SIDE_DEFAULT))
ok('★对话要太窄 → 给对话保底 ' + MIN, splitChatW(1600, 10, SIDE_DEFAULT) === MIN, splitChatW(1600, 10, SIDE_DEFAULT))

// ③ 侧栏宽度是可拖的 —— 原来 layoutRegion 写死 228,拖过侧栏整个浏览器视图就错位(既有 bug)
ok('★侧栏变宽 → 可用宽跟着缩(同样的入参,结果必须不同,否则等于没读真值)',
  splitChatW(1500, 900, 228) !== splitChatW(1500, 900, 400),
  [splitChatW(1500, 900, 228), splitChatW(1500, 900, 400)])
ok('  侧栏 400 时对话上限 = 总宽-侧栏-' + MIN,
  splitChatW(1500, 900, 400) === 1500 - 400 - MIN, splitChatW(1500, 900, 400))
ok('  没报侧栏真值 → 回落 ' + SIDE_DEFAULT + '(老默认,不是 0)',
  splitChatW(1500, 5000, undefined) === 1500 - SIDE_DEFAULT - MIN, splitChatW(1500, 5000, undefined))

console.log(fail ? ('\n❌ 分栏几何:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ 分栏几何:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
