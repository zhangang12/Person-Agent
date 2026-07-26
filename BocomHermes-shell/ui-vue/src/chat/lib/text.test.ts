// 契约测试 · 文本纯函数 ↔ scripts/card-ui-selftest.mjs 用例7/11/19(#11)
// 断言语义逐条对照旧自测,旧页行为改动时两边应同时红。
import { describe, it, expect } from 'vitest'
import { esc, splitThink, splitStable, joinParts } from './text'

describe('esc(用例2:用户内容一律转义)', () => {
  it('转义 & < >', () => {
    expect(esc('<b>&"x"')).toBe('&lt;b&gt;&amp;"x"')
  })
  it('null/undefined 归空串', () => {
    expect(esc(null as any)).toBe('')
    expect(esc(undefined as any)).toBe('')
  })
})

describe('splitThink(用例7:思考两路来源,流式未闭合容忍)', () => {
  it('流式中途未闭合 <think> → 进 think,rest 为空', () => {
    const st = splitThink('<think>我先想想这个问题')
    expect(st.think).toBe('我先想想这个问题')
    expect(st.rest).toBe('')
  })
  it('闭合后正文落 rest', () => {
    const st = splitThink('<think>我先想想这个问题</think>答案第一段')
    expect(st.think).toBe('我先想想这个问题')
    expect(st.rest).toBe('答案第一段')
  })
  it('多段闭合 think 逐个收集,\\n 拼接', () => {
    const st = splitThink('<think>甲</think>中间<th>不生效</th><think>乙</think>尾')
    expect(st.think).toBe('甲\n乙')
    expect(st.rest).toContain('中间')
    expect(st.rest).toContain('尾')
  })
  it('大小写不敏感 + 残留标签清干净', () => {
    const st = splitThink('<THINK>想</THINK>正文<think>后半未闭合')
    expect(st.think).toBe('想\n后半未闭合')
    expect(st.rest).toBe('正文')
  })
  it('空 think 段不占位;null 安全', () => {
    expect(splitThink('<think>   </think>正文').think).toBe('')
    expect(splitThink(null)).toEqual({ think: '', rest: '' })
  })
})

describe('splitStable(用例19 #11:冻结切点)', () => {
  it('切点 = 最后一个 \\n\\n 之后', () => {
    expect(splitStable('块一\n\n')).toBe(4)
    expect(splitStable('块一\n\n块二\n\n')).toBe(8)
    expect(splitStable('块一\n\n块二\n\n块三\n\n尾巴')).toBe(12)
  })
  it('没有空行 → -1(全量重渲)', () => {
    expect(splitStable('还没有分段')).toBe(-1)
  })
  it('围栏未闭合 → -1(不把围栏劈开)', () => {
    expect(splitStable('前文\n\n```js\nconst a = 1\n\nconst b = 2')).toBe(-1)
  })
  it('围栏闭合后,围栏内的空行不算切点,围栏后的算', () => {
    const s = '```js\na\n\nb\n```\n\n尾巴'
    expect(splitStable(s)).toBe(s.indexOf('\n\n尾巴') + 2)
  })
  it('行尾孤立的 `` 不构成围栏边界(索引安全)', () => {
    expect(splitStable('段一\n\n``')).toBe(4)
  })
})

describe('joinParts(onStream 片段拼接)', () => {
  it('按 partID 插入序 \\n 拼接', () => {
    const m = new Map<string, string>()
    m.set('p1', '甲')
    m.set('p2', '乙')
    expect(joinParts(m)).toBe('甲\n乙')
  })
  it('同 partID 覆盖写(流式同 part 重复推全量)', () => {
    const m = new Map<string, string>()
    m.set('p1', '半截')
    m.set('p1', '半截再长一点')
    expect(joinParts(m)).toBe('半截再长一点')
  })
})
