// chat 页纯函数层 · 输入草稿持久化(零 DOM 依赖,可 vitest;localStorage 以接口注入)
// 契约锚定 card-ui-selftest 用例12d:输入即按会话存(cardDraft:sid)/ 发送即清 / 续接恢复;
// >7 天陈草稿起手清一次防胀(card.html:819-837 原样平移)。
export interface KVStore {
  readonly length: number
  key(i: number): string | null
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

export const DRAFT_PREFIX = 'cardDraft:'
export const DRAFT_STALE_MS = 7 * 86400000

export function draftKeyOf(sessionId: string): string {
  return sessionId ? DRAFT_PREFIX + sessionId : ''
}

/** 陈草稿清理(起手一次):>7 天或解析失败的条目删掉 */
export function purgeStaleDrafts(ls: KVStore, now: number = Date.now()): void {
  const cutoff = now - DRAFT_STALE_MS
  for (let i = ls.length - 1; i >= 0; i--) {
    const k = ls.key(i)
    if (k && k.startsWith(DRAFT_PREFIX)) {
      try {
        const d = JSON.parse(ls.getItem(k) || '{}')
        if (!d.t || d.t < cutoff) ls.removeItem(k)
      } catch { ls.removeItem(k) }
    }
  }
}

/** 输入即存;空内容(或全空白)删条目 —— 不留空壳 */
export function draftSave(ls: KVStore, key: string, value: string): void {
  if (!key) return
  try {
    if (value && value.trim()) ls.setItem(key, JSON.stringify({ t: Date.now(), v: value }))
    else ls.removeItem(key)
  } catch { /* 静默 */ }
}

/**
 * 续接恢复:有草稿且当前输入框是空的才恢复(不打断用户已打的新字)。
 * 返回应填入的文本;不恢复返回 ''。
 */
export function draftRestore(ls: KVStore, key: string, currentValue: string): string {
  if (!key) return ''
  try {
    const d = JSON.parse(ls.getItem(key) || 'null')
    if (d && typeof d.v === 'string' && d.v.trim() && !currentValue.trim()) return d.v
  } catch { /* 静默 */ }
  return ''
}

/** 发送成功即清 */
export function draftClear(ls: KVStore, key: string): void {
  if (key) try { ls.removeItem(key) } catch { /* 静默 */ }
}
