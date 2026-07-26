// chat 页纯函数层 · 权限条 payload(零 DOM 依赖,可 vitest)
// 常规橙/高危红 = 设计稿 S3 新增分级(旧页权限条无高危分级 —— 存疑新规则,标注):
//   高危判定复用旧页富结果的破坏性命令特征正则(card.html:2288 DANGER,契约数值不发明),
//   且仅对执行类工具名生效 —— 编辑工具入参里出现 "rm -rf" 字样的文本不误判。
// 设计稿契约:高危条【移除「总是允许」】—— 危险操作没有快捷键习惯。

/** 破坏性命令特征(照抄旧页 DANGER 正则,不增删) */
export const DANGER =
  /(\brm\s+-[rf]+|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\b(drop|truncate)\s+(table|database)\b|\bshutdown\b|\breboot\b|\bformat\s+[a-z]:|\bdel\s+\/[sq]|\brd\s+\/s|\b(git\s+)?reset\s+--hard|\bgit\s+clean\s+-[a-z]*f)/i

/** 执行类工具名(跑命令的才可能"高危";写文件类最高=常规写操作) */
const RE_EXEC_TOOL = /bash|shell|exec|cmd|command|terminal|run/i

/**
 * 高危判定:执行类工具 + 命令文本命中破坏性特征。
 * 存疑:旧页无此分级(一律同款橙色条),本规则为设计稿 S3 高危红条的实现口径。
 */
export function isHighRisk(tool: unknown, detail: unknown): boolean {
  if (!RE_EXEC_TOOL.test(String(tool || ''))) return false
  return DANGER.test(String(detail || ''))
}

/** 权限条可用动作:高危移除「总是允许」(设计稿 S3 spec) */
export type PermDecision = 'once' | 'always' | 'reject'
export function permActions(highRisk: boolean): PermDecision[] {
  return highRisk ? ['once', 'reject'] : ['once', 'always', 'reject']
}

// ── 交互提问卡纯逻辑(card.html 1487-1554 平移) ────────────────────────────
export interface QuizQuestion {
  header?: string; question?: string; multiple?: boolean; custom?: boolean
  options?: Array<{ label?: string; description?: string }>
}
/** 点够问题数且每问都有非空答案 → 可提交(单选点选即满足;多选按 ✓ 选定才写入 answers) */
export function quizCanSend(answers: string[][], questions: QuizQuestion[]): boolean {
  const qs = questions || []
  if (answers.length < qs.length) return false
  return answers.every((a) => Array.isArray(a) && a.length > 0)
}
/** 答完定格留痕文案:「✓ 已回答:甲、乙 / 丙」 */
export function quizSummary(answers: string[][]): string {
  return '✓ 已回答:' + answers.map((a) => a.join('、')).join(' / ')
}
