// 契约测试 · 流式增量渲染计划 ↔ card-ui-selftest 用例19 #11
// 旧自测盯 DOM(冻结区只 append/尾巴区是当前未完成块);这里盯同源的切分判定:
// 稳定块只增、尾巴不重影、围栏未闭合回退全量。
import { describe, it, expect } from 'vitest'
import { planIncremental } from './stream'

describe('planIncremental(用例19 #11:冻结区只增,尾巴区跟最新)', () => {
  it('首个稳定块 → 一段冻结,尾巴空', () => {
    const p = planIncremental('块一\n\n', 0)
    expect(p.reset).toBe(false)
    expect(p.newSeg).toBe('块一\n\n')
    expect(p.tail).toBe('')
    expect(p.cut).toBe(4)
  })
  it('文本增长 → 只新增多出来的稳定段(已有段零触碰)', () => {
    // 模拟流式序列:'块一\n\n' → '块一\n\n块二\n\n' → '块一\n\n块二\n\n块三\n\n尾巴'
    let frozenLen = 0
    const segs: string[] = []
    for (const acc of ['块一\n\n', '块一\n\n块二\n\n', '块一\n\n块二\n\n块三\n\n尾巴']) {
      const p = planIncremental(acc, frozenLen)
      expect(p.reset).toBe(false)
      if (p.newSeg) { segs.push(p.newSeg); frozenLen = p.cut }
    }
    expect(segs).toEqual(['块一\n\n', '块二\n\n', '块三\n\n'])
    const last = planIncremental('块一\n\n块二\n\n块三\n\n尾巴', frozenLen)
    expect(last.newSeg).toBe('')
    expect(last.tail).toBe('尾巴')
  })
  it('没有稳定块 → reset(等价老行为:整棵重渲)', () => {
    const p = planIncremental('一整段没换行', 0)
    expect(p.reset).toBe(true)
    expect(p.tail).toBe('一整段没换行')
  })
  it('围栏未闭合 → reset,且已有冻结作废(frozenLen 由调用方归 0)', () => {
    const p = planIncremental('块一\n\n```js\ncode\n\n还在写', 4)
    expect(p.reset).toBe(true)
    expect(p.tail).toBe('块一\n\n```js\ncode\n\n还在写')
  })
  it('文本回缩不重影:tail 从 max(cut, frozenLen) 起', () => {
    // cut(8) 落后于 frozenLen(12) 的异常输入下,尾巴不从更早的位置重来
    const p = planIncremental('块一\n\n块二\n\n', 12)
    expect(p.reset).toBe(false)
    expect(p.newSeg).toBe('')
    expect(p.tail).toBe('')
  })
})
