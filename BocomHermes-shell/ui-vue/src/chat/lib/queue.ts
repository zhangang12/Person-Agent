// chat 页纯函数层 · 注入/排队队列 drain(零 DOM 依赖,可 vitest)
// 契约锚定 card-ui-selftest 用例6:忙时 submit 入队而不吞字;本轮一结束按序自动发出,
// 一次只出队一条(turn 是串行的,drain 后新轮末会再次 drain)。
// 与 card.html:1321 maybeDrain 的守卫条件一致:!cardReady || busy || 空队 → 不动。

/**
 * 出队一条待发消息;不就绪/忙/空队时返回 null(队列原样不动)。
 * 调用方负责把返回项发出去(turn),并在项上把气泡"转正"(去 queued 态)。
 */
export function drainNext<T>(queue: T[], ready: boolean, busy: boolean): T | null {
  if (!ready || busy || !queue.length) return null
  return queue.shift() ?? null
}

/** 反悔权:取消一条还在排队的消息(出队);返回是否真删到了 */
export function cancelQueued<T>(queue: T[], item: T): boolean {
  const at = queue.indexOf(item)
  if (at < 0) return false
  queue.splice(at, 1)
  return true
}
