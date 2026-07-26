// chat 页纯函数层 · 输入法组合态守卫(零 DOM 依赖,可 vitest)
// 契约锚定 card-ui-selftest 用例9:中文 IME 组合态里,选字的 Enter/↑↓ 是给候选框的,
// 不发送不翻历史(不守 = 半截拼音被发出去)。与 card.html:2211 一致。
export interface ImeKeyEventLike {
  isComposing?: boolean
  keyCode?: number
}

/** true = 这个按键事件应被忽略(组合态选字中) */
export function imeGuard(e: ImeKeyEventLike): boolean {
  return !!(e && (e.isComposing || e.keyCode === 229))
}
