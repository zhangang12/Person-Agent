import { describe, it, expect } from 'vitest'
import { failedGates, gateChipText, gateChipTip } from './gatechip'

// 夹具照抄真机盘上的原始数据(orch-runs/R21.json),不手编:
// n28 是"混合"那种最要命的形态 —— 一道没过、一道过了,而面板把两道都染成红的。
const N28 = [
  { kind: 'artifacts', ok: false, detail: 'docs/login-explore/06-account-menus.md 不存在(ENOENT)' },
  { kind: 'noEmpty', ok: true, detail: '有回报' },
]
// n31:被限流打成零产出的核实片 —— 两道【真的】都没过
const N31 = [
  { kind: 'noEmpty', ok: false, detail: '既没有终答、也没有文件产出、声明产出在磁盘上也找不到(零产出)' },
  { kind: 'verdict', ok: false, detail: '回报缺 VERDICT 字面量' },
]
const ALL_OK = [
  { kind: 'artifacts', ok: true, detail: '3 个产出都在' },
  { kind: 'noEmpty', ok: true, detail: '有回报' },
]

describe('闸门 chip:只说没过的,别把过了的也染红', () => {
  it('★混合报告只列没过的那道(修前:artifacts/noEmpty 两道全红,而 noEmpty 是绿的)', () => {
    expect(gateChipText(N28)).toBe('artifacts')
    expect(failedGates(N28).map((x) => x.kind)).toEqual(['artifacts'])
  })

  it('★全过的时候 chip 整个不出现(修前:只要 exitReport 非空就挂一个红 chip)', () => {
    expect(gateChipText(ALL_OK)).toBe('')
    expect(failedGates(ALL_OK)).toEqual([])
  })

  it('真的都没过时,照旧全列出来(不能为了少报错而漏报)', () => {
    expect(gateChipText(N31)).toBe('noEmpty/verdict')
  })

  it('tooltip 要给全貌:过的打 ✓、没过打 ✗ 带原因(chip 只显示失败项,信息不能就此丢掉)', () => {
    const tip = gateChipTip(N28)
    expect(tip).toContain('✗ artifacts:')
    expect(tip).toContain('✓ noEmpty:有回报')
    expect(tip.split('\n')).toHaveLength(2)
  })

  it('脏数据不许炸:非数组 / null / 缺字段一律安全降级', () => {
    expect(gateChipText(undefined)).toBe('')
    expect(gateChipText(null)).toBe('')
    expect(gateChipText('noEmpty' as unknown)).toBe('')
    expect(gateChipText([null, { ok: false }, 7])).toBe('?')      // 缺 kind → '?',不抛
    expect(gateChipTip([null, 7])).toBe('')
  })

  it('ok 缺省(既非 true 也非 false)不算失败 —— 老盘上的旧记录不该被当成红', () => {
    expect(gateChipText([{ kind: 'weight' }])).toBe('')
    expect(gateChipText([{ kind: 'weight', ok: undefined }])).toBe('')
  })
})
