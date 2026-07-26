// 契约测试 · ctx chip 阈值(设计稿 60/80,变更标注见 ctxchip.ts 头注释)+ 权限 payload + 提问卡纯逻辑
import { describe, it, expect } from 'vitest'
import { ctxFallbackFor, ctxCap, estTokens, ctxPctVal, ctxLevel, ctxChipText, ctxChipTitle } from './ctxchip'
import { DANGER, isHighRisk, permActions, quizCanSend, quizSummary } from './perm'

describe('ctx chip(用例10 展示侧 + 设计稿阈值)', () => {
  it('型号兜底表:子串匹配,未知 0', () => {
    expect(ctxFallbackFor('intranet/qwen3-coder')).toBe(131072)
    expect(ctxFallbackFor('claude-sonnet')).toBe(200000)
    expect(ctxFallbackFor('mystery-model')).toBe(0)
  })
  it('128k 口径硬顶:serve 报 192k 按 128k 收口', () => {
    expect(ctxCap(192000, 128000)).toBe(128000)
    expect(ctxCap(64000, 128000)).toBe(64000)
    expect(ctxCap(192000, 0)).toBe(192000)   // cap≤0 不生效(防御)
  })
  it('估算口径:chars/1.6;实测优先', () => {
    expect(estTokens(1600)).toBe(1000)
    expect(ctxPctVal(null, 1600, 128000)).toBeCloseTo(1000 / 128000)
    expect(ctxPctVal(64000, 1600, 128000)).toBeCloseTo(0.5)   // 实测在场不看估算
    expect(ctxPctVal(null, 100, 0)).toBe(0)                    // 无上限不除零
  })
  it('阈值分级(设计稿:<60 绿 / 60-80 橙 / >80 红;<5% 隐藏)', () => {
    expect(ctxLevel(0.04)).toBe('hidden')
    expect(ctxLevel(0.05)).toBe('ok')
    expect(ctxLevel(0.42)).toBe('ok')
    expect(ctxLevel(0.59)).toBe('ok')
    expect(ctxLevel(0.6)).toBe('warn')     // 60 归橙(设计稿 "60–80% 橙")
    expect(ctxLevel(0.78)).toBe('warn')
    expect(ctxLevel(0.79)).toBe('warn')
    expect(ctxLevel(0.8)).toBe('danger')   // 80 归红(">80% 红"按区间语义含 80 起点)
    expect(ctxLevel(0.95)).toBe('danger')
  })
  it('chip 文案:~ 前缀 = 估算态;实测无前缀', () => {
    expect(ctxChipText(0.42, false)).toBe('上下文 ~42%')
    expect(ctxChipText(0.42, true)).toBe('上下文 42%')
  })
  it('title:用量 + cache 命中率 + 压缩提示(≥60% 换警告语)', () => {
    const t = ctxChipTitle(null, 160000, 128000, 0.5, 0.78)
    expect(t).toContain('100.0k / 128k tokens')
    expect(t).toContain('KV-cache 命中率 50%')
    expect(t).toContain('越接近上限回答质量越差')
    expect(ctxChipTitle(32000, 0, 128000, null, 0.25)).toContain('点击可提前压缩续聊')
  })
})

describe('权限条 payload(设计稿 S3:常规橙/高危红)', () => {
  it('DANGER 正则照抄旧页:rm -rf / drop table / reset --hard / fork 炸弹', () => {
    expect(DANGER.test('rm -rf target/')).toBe(true)
    expect(DANGER.test('git reset --hard HEAD~1')).toBe(true)
    expect(DANGER.test('DROP TABLE users')).toBe(true)
    expect(DANGER.test(':(){ :|:& };:')).toBe(true)
    expect(DANGER.test('mvn test -pl interest')).toBe(false)
  })
  it('高危 = 执行类工具 + 破坏性命令;编辑工具不误判', () => {
    expect(isHighRisk('bash', 'rm -rf target/')).toBe(true)
    expect(isHighRisk('bash', 'mvn deploy -pl interest')).toBe(false)
    expect(isHighRisk('edit', 'rm -rf target/')).toBe(false)   // 写文件类最高=常规
    expect(isHighRisk('write_file', 'x')).toBe(false)
  })
  it('高危移除「总是允许」(设计稿 spec)', () => {
    expect(permActions(false)).toEqual(['once', 'always', 'reject'])
    expect(permActions(true)).toEqual(['once', 'reject'])
  })
})

describe('提问卡纯逻辑(用例12c 契约)', () => {
  it('canSend:点够问题数且每问非空', () => {
    const qs = [{ question: 'a' }, { question: 'b' }]
    expect(quizCanSend([], qs)).toBe(false)
    expect(quizCanSend([['甲']], qs)).toBe(false)        // 还缺一问
    expect(quizCanSend([['甲'], []], qs)).toBe(false)    // 空答案不算
    expect(quizCanSend([['甲'], ['乙', '丙']], qs)).toBe(true)
  })
  it('定格留痕:「✓ 已回答:甲、乙 / 丙」', () => {
    expect(quizSummary([['调整范围']])).toBe('✓ 已回答:调整范围')
    expect(quizSummary([['甲', '乙'], ['丙']])).toBe('✓ 已回答:甲、乙 / 丙')
  })
})
