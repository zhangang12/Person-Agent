// chat 页纯函数层 · 上下文用量 chip(零 DOM 依赖,可 vitest)
// 口径平移 ui/card.html 930-981:
//   实测态 = serve 真实 prompt tokens / 上限(无 ~ 前缀);估算态 = 字符估算/1.6(~ 前缀)
//   上限 = 模型元数据 limit.context;serve 没报走型号兜底表,再兜底 128k;128k 口径硬顶(knobs.ctxLimitMax)
// ⚠ 阈值变更(设计稿优先,用户已拍板):旧页 70/90 两段变色 → 设计稿 <60% 绿 / 60-80% 橙 / >80% 红。
//   <5% 隐藏是旧页既有行为(设计稿未提,保留 —— 起步空会话不占标题栏)。

// serve 不报 limit.context 时的型号兜底表(按 modelID 小写子串匹配,保守取公开标称值;旧页原表)
export const CTX_FALLBACK: Array<[string, number]> = [
  ['claude', 200000], ['gpt-4', 128000], ['gpt-3.5', 16000], ['deepseek', 64000],
  ['qwen', 131072], ['glm', 128000], ['kimi', 131072], ['llama', 128000],
]
export function ctxFallbackFor(key: unknown): number {
  const k = String(key || '').toLowerCase()
  for (const [sub, n] of CTX_FALLBACK) if (k.includes(sub)) return n
  return 0
}
/** 128k 口径硬顶:serve 报 192k 也按 128k 收口,否则变色线算到真实上限之外,安全网永不触发 */
export function ctxCap(n: number, cap: number): number {
  return cap > 0 && n > cap ? cap : n
}
/** 估算 tokens:进过上下文的字符 / 1.6(旧页估算口径) */
export const estTokens = (usedChars: number): number => Math.round(usedChars / 1.6)
/** 水位百分比:实测优先,估算兜底 —— chip 与变色线同吃这一个口径 */
export function ctxPctVal(realTokens: number | null, usedChars: number, limitTokens: number): number {
  if (!limitTokens) return 0
  return realTokens != null ? realTokens / limitTokens : estTokens(usedChars) / limitTokens
}

export type CtxLevel = 'hidden' | 'ok' | 'warn' | 'danger'
/** 分级(设计稿 S2 语义着色):<5% 隐藏(旧页保留);<60% 绿;60-80% 橙;>80% 红(边界:60/80 归橙/红) */
export function ctxLevel(pct: number): CtxLevel {
  if (pct < 0.05) return 'hidden'
  if (pct >= 0.8) return 'danger'
  if (pct >= 0.6) return 'warn'
  return 'ok'
}
/** chip 文案:「上下文 ~42%」(~=估算态轻量区分,实测无前缀) */
export function ctxChipText(pct: number, real: boolean): string {
  return '上下文 ' + (real ? '' : '~') + Math.round(pct * 100) + '%'
}
/** chip title(用量 + 可选 KV-cache 命中率 + 压缩提示) */
export function ctxChipTitle(realTokens: number | null, usedChars: number, limitTokens: number, cacheHit: number | null, pct: number): string {
  const real = realTokens != null
  const est = real ? realTokens : estTokens(usedChars)
  let t = (real ? '本会话上下文(serve 实测):' : '本会话上下文估算:约 ')
    + (est > 999 ? (est / 1000).toFixed(1) + 'k' : est) + ' / ' + Math.round(limitTokens / 1000) + 'k tokens'
  if (cacheHit != null) t += '\nKV-cache 命中率 ' + Math.round(cacheHit * 100) + '%(前缀越稳越高;低于 ~30% 说明前缀在漂移,查注入动态内容是不是插到头部了)'
  t += pct >= 0.6
    ? '\n越接近上限回答质量越差 —— 点击「压缩续聊」:把本段对话总结成接力摘要,开新会话无缝继续'
    : '\n点击可提前压缩续聊'
  return t
}
