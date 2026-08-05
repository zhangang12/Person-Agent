// chat 页纯函数层 · 工具事件归类与展示模型(零 DOM 依赖,可 vitest)
// 契约锚定 card-ui-selftest 用例2/用例3 与 ui/card.html renderTool(1667-1731)/todoHtml(1580-1595):
//   默认折叠(verbose 自动展开) / completed 摘要带「⎿ N 字」/ 入参 4000 字、结果 20000 字截断提示
//   todowrite → 一等公民清单卡(☒◐⊘☐ 三记号 + meta N/M)
//   write/edit 落盘路径 → 成果抽屉清单(artAbs/artRel 平移 1595-1665)

// ── 工具名归类 ────────────────────────────────────────────────────────────
/** todo 清单工具(一等公民卡,不走可折叠工具行) */
export const isTodoTool = (name: unknown): boolean => /^todo(write|read)$/i.test(String(name || ''))
/** write/edit 类(含 write_file 等下划线变体)→ 成果抽屉收集 */
export const isWriteEditTool = (name: unknown): boolean => /^(write|edit)(_[a-z]+)*$/i.test(String(name || ''))
/** 交互提问类(MCP ask/elicit 无应答通道,挂提示兜底) */
export const isAskTool = (name: unknown): boolean => /^(ask|elicit)$/i.test(String(name || ''))
/** 特殊显示名(对齐旧页 TOOL_LABEL) */
export const TOOL_LABEL: Record<string, string> = { run_workflow: '升格 → 动态工作流', task: '子Agent', run_orchestration: '升格 → 多层派发主控' }
export const toolLabel = (name: unknown): string => TOOL_LABEL[String(name)] || String(name || '?')
/** 派发类工具(run_workflow):带 parentTag = 主控在派自己名下的分片,不是"又升格一个独立工作流" */
export const isDispatchTool = (name: unknown): boolean => /^run_workflow$/i.test(String(name || ''))

// ── 分片派发展示模型(主控卡里 N 条派发全叫"升格 → 动态工作流",要展开看 JSON 才知道派了哪片 —— 实测看不懂)──
/** goal 里可能被模型手写的 [orch:TAG] 前缀:展示层一律剥掉(壳层也会剥,以 parentTag 为准) */
export const stripOrchTag = (g: unknown): string =>
  String(g || '').replace(/[[【]\s*orch\s*[:：]\s*[A-Za-z0-9-]+\s*[\]】]/g, '').replace(/\s+/g, ' ').trim()
export interface DispatchModel { shard: boolean; goal: string }
/** run_workflow 入参 → {是否分片, 目标摘要};入参还没到/形状不符返回 null */
export function dispatchModel(input: unknown): DispatchModel | null {
  const obj = asObj(input)
  if (!obj) return null
  const goal = stripOrchTag(obj.goal)
  if (!goal) return null
  return { shard: !!String(obj.parentTag || '').trim(), goal }
}
/** 派发回执文本里的分片卡 id(orch-mcp 回执统一写 "id=<n>")→ 工具块可点跳该片镜像视图 */
export function dispatchedId(outStr: unknown): string {
  const m = String(outStr || '').match(/\bid=(\d+)/)
  return m ? m[1] : ''
}

// ── 入参/结果格式化 ───────────────────────────────────────────────────────
/** 有的 serve 把工具入参给成 JSON 字符串:对象直返,字符串尝试 parse,其它 null */
export function asObj(v: unknown): any {
  if (v && typeof v === 'object') return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { /* 静默 */ } }
  return null
}
/** 入参展示:字符串原样,对象缩进 JSON(旧页 fmtInput) */
export function fmtInput(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}
/** 结果展示:error 优先,否则 output(旧页 outStr 口径) */
export function fmtOutput(data: { output?: unknown; error?: unknown }): string {
  if (data.error != null && data.error !== '') return String(data.error)
  return data.output != null ? String(data.output) : ''
}

// ── 状态判定(词表与旧页一致,不发明) ───────────────────────────────────────
export type ToolState = 'running' | 'done' | 'err'
const RE_DONE = /complet|success|done|finish|ok/i
const RE_ERR = /error|fail|deny|reject/i
export const isDoneStatus = (status: unknown): boolean => RE_DONE.test(String(status || ''))
export const isErrStatus = (status: unknown): boolean => RE_ERR.test(String(status || ''))
export function toolState(status: unknown): ToolState {
  if (isErrStatus(status)) return 'err'
  if (isDoneStatus(status)) return 'done'
  return 'running'
}
export const toolStateText = (st: ToolState): string => (st === 'err' ? '出错' : st === 'done' ? '完成' : '运行中…')

/** 完成摘要:「⎿ N 字」/「⎿ X.Xk 字」(完成且无错且有输出才带,对齐 Claude Code "⎿ 120 lines") */
export function toolSummary(status: unknown, outStr: string): string {
  if (!(isDoneStatus(status) && !isErrStatus(status) && outStr)) return ''
  const n = outStr.length
  return '⎿ ' + (n > 999 ? (n / 1000).toFixed(1) + 'k 字' : n + ' 字')
}

// ── 截断(上限与提示文案均为旧页契约数值) ───────────────────────────────────
export const IN_CAP = 4000, OUT_CAP = 20000
export function truncIn(s: string): { text: string; tip: string } {
  if (s.length <= IN_CAP) return { text: s, tip: '' }
  return { text: s.slice(0, IN_CAP), tip: '… 已截断:共 ' + s.length + ' 字,仅显示前 ' + IN_CAP + ' 字' }
}
export function truncOut(s: string): { text: string; tip: string } {
  if (s.length <= OUT_CAP) return { text: s, tip: '' }
  return { text: s.slice(0, OUT_CAP), tip: '… 已截断:共 ' + s.length + ' 字,仅显示前 ' + OUT_CAP + ' 字' }
}

// ── todowrite → 勾选清单(旧页 todoHtml;形状不符退回 null,调用方隐藏整卡) ──
export interface TodoRow { mark: string; text: string; cls: '' | 'done' | 'doing' }
export interface TodoModel { rows: TodoRow[]; meta: string; doneN: number; total: number }
export function todoModel(input: unknown): TodoModel | null {
  const obj = asObj(input)
  const todos = obj && Array.isArray(obj.todos) ? obj.todos : null
  if (!todos || !todos.length) return null
  const rows: TodoRow[] = []
  for (const t of todos) {
    const text = String((t && (t.content || t.text || t.title)) || '').trim()
    if (!text) continue
    const st = String((t && t.status) || '')
    const done = /complet/i.test(st), doing = /progress|doing/i.test(st), cancel = /cancel/i.test(st)
    const mark = done ? '☒' : doing ? '◐' : cancel ? '⊘' : '☐'
    rows.push({ mark, text, cls: done || cancel ? 'done' : doing ? 'doing' : '' })
  }
  if (!rows.length) return null
  const doneN = todos.filter((t: any) => /complet/i.test(String(t && t.status || ''))).length
  return { rows, meta: doneN + '/' + todos.length, doneN, total: todos.length }
}

// ── 成果抽屉路径(旧页 artAbs/artRel) ───────────────────────────────────────
/**
 * write/edit 入参里的落盘路径。
 * ★别名表必须与主进程 src/writescope.js 的 TOOL_PATH_KEYS 保持一致 —— 两边是同一件事的两份实现
 * (跨运行时,渲染端 import 不到 src/,只能各留一份),有 scripts/tool-part-selftest 的契约用例钉住。
 * 各家工具的入参名不一样:opencode 用 filePath,Anthropic 系用 file_path,还有 path/file/target_file……
 * 只认 filePath 的话,内网 fork 一换名字,成果抽屉就一个文件都收不到。
 */
export const TOOL_PATH_KEYS = ['filePath', 'file_path', 'path', 'file', 'filename', 'file_name', 'target_file', 'targetFile', 'filepath']
export function extractFilePath(input: unknown): string {
  const obj = asObj(input) as Record<string, unknown> | null
  if (!obj) return ''
  for (const k of TOOL_PATH_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}
/** 相对路径按本卡目录拼绝对(读文件走主进程白名单校验) */
export function artAbs(p: unknown, curDir: string): string {
  const s = String(p || '').trim()
  if (!s) return ''
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(s)) return s
  return (curDir ? curDir.replace(/[\\/]+$/, '') + '/' : '') + s
}
/** 展示用相对路径:在本卡目录下的砍前缀,砍不动原样显示 */
export function artRel(p: string, curDir: string): string {
  const d = (curDir || '').replace(/[\\/]+$/, '').toLowerCase()
  const lp = p.toLowerCase()
  if (d && (lp.startsWith(d + '/') || lp.startsWith(d + '\\'))) return p.slice(d.length + 1)
  return p
}
