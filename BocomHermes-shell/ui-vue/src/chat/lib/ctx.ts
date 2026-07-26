// chat 页纯函数层 · 上下文用量记账(零 DOM 依赖,可 vitest)
// 契约锚定 card-ui-selftest 用例10:同一 partID 只记一次(completed 事件可能重复推送);
// 展示层(chip 变色/隐藏)是第二棒的标题栏 chips 挂载点,本棒只供数。
export class CtxMeter {
  /** 已记账字符数(估算口径;serve 实测用量的 pollRealUsage 接线在第二棒) */
  usedChars = 0
  private counted = new Set<string>()

  /** 无条件入账 n 字(发送文本/最终正文/思考) */
  bump(n: number): void {
    this.usedChars += Math.max(0, Math.floor(n) || 0)
  }

  /**
   * 工具事件入账(入参+结果进上下文):同 partID 只记一次。
   * 返回 true = 本次记上了;false = partID 为空或已记过。
   */
  countTool(partID: string | undefined | null, n: number): boolean {
    const k = partID || ''
    if (!k || this.counted.has(k)) return false
    this.counted.add(k)
    this.bump(n)
    return true
  }

  reset(): void {
    this.usedChars = 0
    this.counted.clear()
  }
}
