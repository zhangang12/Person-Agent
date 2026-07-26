// chat 页纯函数层 · 文本处理(零 DOM 依赖,可 vitest)
// 从 ui/card.html 原样平移,行为契约锚定 scripts/card-ui-selftest.mjs:
//   esc        → 用例2(esc 全程词法定义,用户内容一律转义)
//   splitThink → 用例7(思考两路来源:①reasoning part ②文本内联 <think>,容忍流式未闭合)
//   splitStable→ 用例19 #11(冻结切点 = 最后一个不在 ``` 围栏内的 \n\n;围栏未闭合 → -1 全量重渲)
//   joinParts  → onStream 各 partID 片段拼接(1954-2026)

/** HTML 转义:用户内容/动态文本进 innerHTML 前的唯一通道 */
export function esc(s: string): string {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 拆 <think>(容忍未闭合,流式中途就是未闭合态):
 * think 进思考块,rest 才是答案正文。多段闭合 think 逐个收集,\n 拼接。
 * 与 card.html:1732 逐行一致。
 */
export function splitThink(s: string | null | undefined): { think: string; rest: string } {
  let t = String(s == null ? '' : s)
  const think: string[] = []
  t = t.replace(/<think>([\s\S]*?)<\/think>/gi, (_, c: string) => { if (c.trim()) think.push(c.trim()); return '' })
  const open = t.search(/<think>/i)
  if (open >= 0) { const c = t.slice(open).replace(/^<think>/i, '').trim(); if (c) think.push(c); t = t.slice(0, open) }
  return { think: think.join('\n'), rest: t.replace(/<\/?think>/gi, '').trim() }
}

/**
 * 流式增量渲染的冻结切点:最后一个「不在 ``` 围栏内」的空行(\n\n)之后;
 * 围栏未闭合 → 返回 -1(调用方回退整棵重渲 —— 围栏里的空行切块会把围栏劈开)。
 * 与 card.html:1755 逐行一致。
 */
export function splitStable(s: string): number {
  let fence = false, last = -1
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === '`' && s[i + 1] === '`' && s[i + 2] === '`') { fence = !fence; i += 2; continue }
    if (!fence && s[i] === '\n' && s[i + 1] === '\n') last = i + 2
  }
  return fence ? -1 : last
}

/** onStream 同一 partID 覆盖写、不同 partID 按序拼接(card.html:1562) */
export function joinParts(m: Map<string, string>): string {
  return Array.from(m.values()).join('\n')
}
