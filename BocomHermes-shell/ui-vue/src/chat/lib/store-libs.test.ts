// 契约测试 · ctx 记账 ↔ 用例10 | 队列 drain ↔ 用例6 | IME 守卫 ↔ 用例9 | 草稿 ↔ 用例12d
import { describe, it, expect } from 'vitest'
import { CtxMeter } from './ctx'
import { drainNext, cancelQueued } from './queue'
import { imeGuard } from './ime'
import { DRAFT_PREFIX, purgeStaleDrafts, draftSave, draftRestore, draftClear, draftKeyOf } from './draft'
import type { KVStore } from './draft'

describe('CtxMeter(用例10:同 partID 只记一次)', () => {
  it('bump 无条件累加', () => {
    const m = new CtxMeter()
    m.bump(100); m.bump(50)
    expect(m.usedChars).toBe(150)
  })
  it('工具入账:同 partID 重复推送只记一次', () => {
    const m = new CtxMeter()
    expect(m.countTool('p1', 500)).toBe(true)
    expect(m.usedChars).toBe(500)
    expect(m.countTool('p1', 500)).toBe(false)
    expect(m.usedChars).toBe(500)
    expect(m.countTool('p2', 300)).toBe(true)
    expect(m.usedChars).toBe(800)
  })
  it('空 partID 不记(没法去重,宁可不记)', () => {
    const m = new CtxMeter()
    expect(m.countTool('', 100)).toBe(false)
    expect(m.countTool(undefined, 100)).toBe(false)
    expect(m.usedChars).toBe(0)
  })
  it('reset 清零(换会话)', () => {
    const m = new CtxMeter()
    m.countTool('p1', 500); m.reset()
    expect(m.usedChars).toBe(0)
    expect(m.countTool('p1', 500)).toBe(true)   // 同 partID 新会话可重记
  })
})

describe('队列 drain(用例6:忙时入队不吞字,轮末按序自动发)', () => {
  it('忙 / 未就绪 / 空队 → 不出队', () => {
    const q = [{ text: 'a' }]
    expect(drainNext(q, true, true)).toBe(null)    // busy
    expect(q.length).toBe(1)
    expect(drainNext(q, false, false)).toBe(null)  // 未就绪
    expect(q.length).toBe(1)
    expect(drainNext([], true, false)).toBe(null)  // 空队
  })
  it('就绪且闲 → 一次只出一条,按序', () => {
    const q = [{ text: '甲' }, { text: '乙' }]
    expect(drainNext(q, true, false)?.text).toBe('甲')
    expect(q.length).toBe(1)
    expect(drainNext(q, true, false)?.text).toBe('乙')
    expect(q.length).toBe(0)
  })
  it('反悔权:取消排队项', () => {
    const a = { text: 'a' }, b = { text: 'b' }
    const q = [a, b]
    expect(cancelQueued(q, a)).toBe(true)
    expect(q).toEqual([b])
    expect(cancelQueued(q, a)).toBe(false)   // 已不在队里
  })
})

describe('IME 守卫(用例9:组合态 Enter 不发送)', () => {
  it('isComposing / keyCode 229 → 忽略', () => {
    expect(imeGuard({ isComposing: true, keyCode: 13 })).toBe(true)
    expect(imeGuard({ isComposing: false, keyCode: 229 })).toBe(true)
  })
  it('上屏后的 Enter → 放行', () => {
    expect(imeGuard({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})

// 迷你 localStorage 桩(与真 localStorage 同接口)
function lsStore(init: [string, string][] = []): KVStore & { _m: Map<string, string> } {
  const m = new Map<string, string>(init)
  return {
    _m: m,
    get length() { return m.size },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
  }
}

describe('草稿(用例12d:按会话存 / 发送即清 / 续接恢复)', () => {
  it('草稿键 = cardDraft:sid', () => {
    expect(draftKeyOf('s1')).toBe('cardDraft:s1')
    expect(draftKeyOf('')).toBe('')
  })
  it('输入即按会话存', () => {
    const ls = lsStore()
    draftSave(ls, DRAFT_PREFIX + 's1', '写了一半的话')
    expect(JSON.parse(ls._m.get('cardDraft:s1')!).v).toBe('写了一半的话')
  })
  it('清空内容 → 删条目(不留空壳);发送即清', () => {
    const ls = lsStore()
    draftSave(ls, 'cardDraft:s1', 'x')
    draftSave(ls, 'cardDraft:s1', '   ')
    expect(ls._m.has('cardDraft:s1')).toBe(false)
    draftSave(ls, 'cardDraft:s1', 'y')
    draftClear(ls, 'cardDraft:s1')
    expect(ls._m.has('cardDraft:s1')).toBe(false)
  })
  it('无 key(cardInit 前)静默不落盘', () => {
    const ls = lsStore()
    draftSave(ls, '', 'x')
    expect(ls.length).toBe(0)
  })
  it('续接恢复:有草稿且输入框空 → 恢复;已有新字 → 不打断', () => {
    const ls = lsStore([['cardDraft:s1', JSON.stringify({ t: Date.now(), v: '没发出去的草稿' })]])
    expect(draftRestore(ls, 'cardDraft:s1', '')).toBe('没发出去的草稿')
    expect(draftRestore(ls, 'cardDraft:s1', '已在打字')).toBe('')
  })
  it('>7 天陈草稿起手清一次,新草稿不动', () => {
    const now = Date.now()
    const ls = lsStore([
      ['cardDraft:old', JSON.stringify({ t: now - 8 * 86400000, v: '陈草稿' })],
      ['cardDraft:new', JSON.stringify({ t: now, v: '新草稿' })],
      ['cardDraft:bad', '{oops'],
      ['otherKey', 'z'],
    ])
    purgeStaleDrafts(ls, now)
    expect(ls._m.has('cardDraft:old')).toBe(false)
    expect(ls._m.has('cardDraft:bad')).toBe(false)
    expect(ls._m.has('cardDraft:new')).toBe(true)
    expect(ls._m.has('otherKey')).toBe(true)
  })
})
