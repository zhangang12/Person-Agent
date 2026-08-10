// 同屏分栏的几何(纯函数,无 Electron 依赖 —— 便于逐例断言)。
//
// 【为什么单独抽出来】browser.js 是 initBrowser(ctx) 工厂,要 Electron 才装载得起来,
// 里面的几何就没法单测。而这段几何有三条边界,每条都是"错了才发现"的那种:
//   · 窗口太窄硬挤 → 两边都不能用(对话读不了、页面也看不清),不如退回互斥;
//   · 对话要太宽 → 浏览器被挤没;反过来对话被挤没同理;
//   · 侧栏宽度是【可拖的】,而 layoutRegion 原来把它写死 228 —— 拖过侧栏之后整个浏览器视图错位(既有 bug)。
'use strict'
const MIN = 360          // 两边各自的最小可用宽度:再窄对话没法读、页面也没法看
const SIDE_DEFAULT = 228 // 侧栏默认宽(渲染端没报真值时的回落)

const num = (v, d) => { const n = +v; return Number.isFinite(n) ? n : d }

/**
 * 主窗内容区左边留给【对话】的实际像素宽。
 * @param cw    主窗内容区总宽
 * @param want  对话想占多宽(0 = 关闭分栏,浏览器铺满 —— 老行为)
 * @param sideW 侧栏真实宽度(渲染端上报;缺省 228)
 * @returns 实际给对话的宽;0 表示"这次不分栏"
 */
function splitChatW(cw, want, sideW) {
  const w = Math.round(num(want, 0))
  if (w <= 0) return 0
  const avail = Math.max(0, Math.round(num(cw, 0)) - Math.round(num(sideW, SIDE_DEFAULT)))
  if (avail < MIN * 2) return 0                     // 挤不出两个 MIN → 退回互斥,不做"两边都不能用"的分栏
  return Math.min(Math.max(w, MIN), avail - MIN)    // 两头都保底
}

module.exports = { splitChatW, MIN, SIDE_DEFAULT }
