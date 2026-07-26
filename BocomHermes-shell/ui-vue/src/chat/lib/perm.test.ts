// 自测:lib/perm.ts —— 高危判定(破坏性命令特征 + 仅执行类工具生效)、permActions 分级、quiz 纯逻辑。
// 契约锚定 plan.md Stage 1 与 card.html DANGER 正则(特征不发明,照抄旧页口径)。
import { describe, it, expect } from 'vitest'
import { DANGER, isHighRisk, permActions, quizCanSend, quizSummary } from './perm'

describe('DANGER 破坏性命令特征', () => {
  it('命中典型破坏命令', () => {
    expect(DANGER.test('rm -rf /tmp/x')).toBe(true)
    expect(DANGER.test('rm -fr node_modules')).toBe(true)
    expect(DANGER.test('dd if=/dev/zero of=/dev/sda')).toBe(true)
    expect(DANGER.test('DROP TABLE users')).toBe(true)
    expect(DANGER.test('git reset --hard HEAD~3')).toBe(true)
    expect(DANGER.test('git clean -fd')).toBe(true)
    expect(DANGER.test('shutdown now')).toBe(true)
  })
  it('不命中日常命令', () => {
    expect(DANGER.test('rm dist/app.log')).toBe(false)          // 无 -r/-f 旗标
    expect(DANGER.test('ls -la && grep -r foo src/')).toBe(false)
    expect(DANGER.test('npm run build')).toBe(false)
    expect(DANGER.test('git status')).toBe(false)
  })
  it('旧页已知怪癖存档:rm -f 也命中([rf]+ 字符集含单独的 f)—— 不发明修正,照抄口径', () => {
    expect(DANGER.test('rm -f dist/app.log')).toBe(true)
  })
})

describe('isHighRisk 高危判定(仅执行类工具生效)', () => {
  it('执行类工具 + 破坏特征 → 高危', () => {
    expect(isHighRisk('bash', 'rm -rf /tmp/build')).toBe(true)
    expect(isHighRisk('shell_exec', 'drop table t')).toBe(true)
    expect(isHighRisk('run_command', 'git reset --hard')).toBe(true)
  })
  it('编辑工具入参里出现破坏性【文本】不误判(代码内容不是命令)', () => {
    expect(isHighRisk('edit', '把 cleanup() 改成 rm -rf 调用')).toBe(false)
    expect(isHighRisk('write', '{"script": "rm -rf /tmp/x"}')).toBe(false)
    expect(isHighRisk('read', 'rm -rf /tmp/x')).toBe(false)
  })
  it('执行类工具 + 普通命令 → 非高危', () => {
    expect(isHighRisk('bash', 'npm test')).toBe(false)
    expect(isHighRisk('bash', '')).toBe(false)
  })
})

describe('permActions 动作分级', () => {
  it('常规:允许一次/总是/拒绝', () => {
    expect(permActions(false)).toEqual(['once', 'always', 'reject'])
  })
  it('高危:移除「总是允许」(设计稿 S3 —— 危险操作没有快捷键习惯)', () => {
    expect(permActions(true)).toEqual(['once', 'reject'])
    expect(permActions(true)).not.toContain('always')
  })
})

describe('quiz 提问卡纯逻辑', () => {
  const qs = [{ question: 'q1', options: [{ label: 'A' }] }, { question: 'q2', multiple: true, options: [{ label: '甲' }] }]
  it('quizCanSend:问题数不够/有空答 → false;每问都有非空答案 → true', () => {
    expect(quizCanSend([], qs)).toBe(false)
    expect(quizCanSend([['A']], qs)).toBe(false)
    expect(quizCanSend([['A'], []], qs)).toBe(false)
    expect(quizCanSend([['A'], ['甲']], qs)).toBe(true)
    expect(quizCanSend([['A'], ['甲', '乙']], qs)).toBe(true)
  })
  it('quizSummary:定格留痕文案「✓ 已回答:甲、乙 / 丙」', () => {
    expect(quizSummary([['A'], ['甲', '乙']])).toBe('✓ 已回答:A / 甲、乙')
    expect(quizSummary([['自定义文本']])).toBe('✓ 已回答:自定义文本')
  })
})
