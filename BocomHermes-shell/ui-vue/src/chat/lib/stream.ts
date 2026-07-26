// chat 页纯函数层 · 流式增量渲染计划(零 DOM 依赖,可 vitest)
// 防 O(n²) 与文本选择被炸的核心:累计文本按"已闭合块"切开 —— 闭合部分只渲一次
// (真冻结,Vue 里已冻结段 props 不变、节点不被重写),只有尾巴在每帧重渲。
// 本模块把 card.html:1763 paintAnswerIncremental 的切分判定抽成纯函数;
// DOM/组件层只负责按 plan 落子。契约锚定 card-ui-selftest 用例19 #11。
import { splitStable } from './text'

export interface IncrPlan {
  /** true = 还没有稳定块或围栏未闭合:整棵重渲,冻结区清零(等价老行为) */
  reset: boolean
  /** 本次切点(splitStable 原值;reset 时通常为 -1 或 0) */
  cut: number
  /** 新冻结段原文(frozenLen..cut);无新增稳定块时为空串 */
  newSeg: string
  /** 尾巴区原文(从 max(cut, frozenLen) 起 —— 防文本回缩时与冻结区重影) */
  tail: string
}

/**
 * 根据累计正文与已冻结长度,算出这一帧的增量渲染计划。
 * 与 paintAnswerIncremental 的分支一一对应:
 *   cut <= 0            → reset(全量重渲,frozenLen 归 0)
 *   cut >  frozenLen    → 追加一段冻结(seg = acc[frozenLen..cut])
 *   否则                → 只更新尾巴
 */
export function planIncremental(acc: string, frozenLen: number): IncrPlan {
  const cut = splitStable(acc)
  if (cut <= 0) return { reset: true, cut, newSeg: '', tail: acc }
  const newSeg = cut > frozenLen ? acc.slice(frozenLen, cut) : ''
  return { reset: false, cut, newSeg, tail: acc.slice(Math.max(cut, frozenLen)) }
}
