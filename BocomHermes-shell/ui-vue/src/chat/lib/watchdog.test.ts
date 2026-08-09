import { describe, it, expect } from 'vitest'
import { wdSkip } from './watchdog'

describe('绕圈看门狗:该不该管这张卡', () => {
  it('★验证片整段豁免(修前:重读文件被判绕圈 → 自动中止 → 判决永远发不出来 → 整片重做)', () => {
    expect(wdSkip({ wfMode: true, verifyMode: true })).toBe('verify')
  })
  it('★普通工作流卡照旧受管 —— 豁免不许扩大到所有卡(那等于把这只狗废了)', () => {
    expect(wdSkip({ wfMode: true, verifyMode: false })).toBe('')
  })
  it('非工作流卡本来就不管(有人看着,判死权在人)', () => {
    expect(wdSkip({ wfMode: false, verifyMode: false })).toBe('not-wf')
    expect(wdSkip({ wfMode: false, verifyMode: true })).toBe('not-wf')
  })
  it('脏输入不许炸(看门狗自己崩了等于没有看门狗)', () => {
    expect(wdSkip(undefined as never)).toBe('not-wf')
    expect(wdSkip({} as never)).toBe('not-wf')
  })
})
