// chat 页 · 会话生命周期与消息流 store(P2a 第一棒 + 第二棒合本)
// 从 ui/card.html 平移的行为:
//   cardInit(sid/id/title/msg/disp/embedded/chat 分支) → card-bound 回发(boot)
//   cardSend/cardAbort(turn/abort);POST 结果权威收尾,流式累积兜底(reply || joinParts)
//   忙时 submit 入队、queued 气泡半透明、轮末 drain 转正(submit/drain)
//   中断「已中断」角标 + 半截保留 + 重试钮;重答;草稿发送即清、续接恢复
//   流式逐 token 防 O(n²):稳定块冻结(segs 只增)+ 尾巴区每帧重渲(tail)
//   思考两路来源(reasoning part + 文本内联 <think>),各轮思考块独立、答完不折叠
//   feed 320 条回收占位(展示层回收,数据不丢)
// 第二棒平移(本文件内):
//   工具块(renderTool:同 partID 原地更新/默认折叠/verbose/⎿摘要/截断/write-edit→成果抽屉)
//   todowrite 一等公民清单卡;权限审批条(onPermission/sticky/Y·A·N 快捷键=设计稿新增);
//   交互提问卡(onQuestion 单/多选/custom/跳过/定格留痕);成果抽屉(artFiles/最终结论);
//   标题栏 chips(模型菜单/ctx 用量/保活灯)+ 压缩续聊(compactCore)
// 显式不做(P2b):子 Agent 侧边栏(ev.sub 仍只计数)/命令块「运行」target 轮/wf·orch·shard 卡
import { reactive, computed } from 'vue'
import { BH } from './bridge'
import { renderMarkdown } from './rich'
import { splitThink, joinParts } from './lib/text'
import { planIncremental } from './lib/stream'
import { CtxMeter } from './lib/ctx'
import { drainNext } from './lib/queue'
import { draftKeyOf, draftSave, draftRestore, draftClear, purgeStaleDrafts } from './lib/draft'
import {
  isTodoTool, isWriteEditTool, isAskTool, fmtInput, fmtOutput, toolLabel,
  toolState, toolSummary, todoModel, extractFilePath, artAbs, truncIn, truncOut,
} from './lib/tool'
import type { TodoModel, ToolState } from './lib/tool'
import { ctxFallbackFor, ctxCap, ctxPctVal } from './lib/ctxchip'
import { isHighRisk, quizCanSend, quizSummary } from './lib/perm'
import type { PermDecision, QuizQuestion } from './lib/perm'

// ── Feed 条目模型 ─────────────────────────────────────────────────────────
interface BaseItem { id: number }
/** 用户气泡(queued=排队中,半透明 + 可取消) */
export interface UserItem extends BaseItem { kind: 'user'; text: string; queued: boolean }
/** 分诊/提示行(非对话轮);retry=true 时带「重试本轮」按钮 */
export interface NoteItem extends BaseItem { kind: 'note'; text: string; muted: boolean; retry: boolean }
/** 思考块:每轮一个,答完不折叠不移除(open 保持);title 缺省「思考过程」,压缩续聊的接力摘要复用同壳 */
export interface ReasonItem extends BaseItem { kind: 'reason'; body: string; open: boolean; title?: string }
/** AI 气泡:流式期 = segs(冻结段,只增) + tail(每帧重渲);收尾后 = finalHtml 全量一次 */
export interface AiItem extends BaseItem {
  kind: 'ai'
  status: 'streaming' | 'done' | 'aborted' | 'error'
  segs: { id: number; html: string }[]
  frozenLen: number
  tail: string
  finalHtml: string
  /** 复制原文(渲染前 markdown) */
  raw: string
  /** error/空答占位文案(status=error 或 done 无正文时显示) */
  plainText: string
  /** 「重新回答」用的原问题(>8000 字不挂,对齐旧页) */
  retryText: string
  retryFiles: any[] | null
}
/** 工具块:同 partID 原地更新(运行中→完成);open=折叠态(verbose 开自动展开) */
export interface ToolItem extends BaseItem {
  kind: 'tool'
  partID: string
  name: string
  title: string
  status: string
  state: 'running' | 'done' | 'err'
  inStr: string
  outStr: string
  hasErr: boolean
  summary: string          // 「⎿ N 字」(完成且无错且有输出)
  open: boolean
  isWf: boolean            // run_workflow 高亮"升格"
  askNoted: boolean        // ask/elicit 兜底提示只挂一次
  taskChild?: string       // task/delegate_task 的真子会话 id(点工具块跳子 Agent 窗格)
}
/** todowrite 清单卡:一等公民(不折叠);model=null 时整卡隐藏(不留空白块) */
export interface TodoItem extends BaseItem {
  kind: 'todo'
  partID: string
  model: TodoModel | null
  updating: boolean        // 非终态:标题行带「· 更新中…」
}
/** 权限审批条:回复后从 feed 移除(对齐旧页 box.remove),sticky 计数随动 */
export interface PermItem extends BaseItem {
  kind: 'perm'
  requestId: string
  tool: string
  detail: string
  diff: string
  miss: { region?: string } | null
  highRisk: boolean        // 设计稿 S3:高危红 + 移除「总是允许」
}
/** 交互提问卡:answers 按问题序的 labels 数组;sent 后定格 doneText 留痕 */
export interface QuestionItem extends BaseItem {
  kind: 'question'
  requestId: string
  questions: QuizQuestion[]
  answers: string[][]
  sent: boolean
  doneText: string
}
export type FeedItem = UserItem | NoteItem | ReasonItem | AiItem | ToolItem | TodoItem | PermItem | QuestionItem

/** 子 Agent(P2b 侧边栏):一个 task/delegate_task 扇出的独立上下文单元;思考/工具/产出各自缓冲 */
export interface SubAgent {
  id: string
  name: string
  count: number          // 工具调用计数(徽标)
  reads: number          // 读文件类工具次数(快照概要用)
  t0: number
  doneAt: number
  done: boolean
  err: boolean
  tools: ToolItem[]                 // 窗格工具块(复用 ToolItem/ToolBlock)
  toolIdx: Map<string, ToolItem>    // partID → 工具块(原地更新)
  reasonParts: Map<string, string>
  outParts: Map<string, string>
  reason: string           // 思考(joinParts 累积)
  outHtml: string          // 产出(renderMarkdown 累积)
}
/** 轮次快照(清场前拍,只留概要元数据;上限 20 轮) */
export interface SubSnap { round: number; items: { name: string; count: number; ms: number; err: boolean; reads: number }[] }

interface QueueEntry { text: string; files: any[] | null; item: UserItem }

interface StreamEvent {
  kind?: string; text?: string; partID?: string; status?: string
  input?: any; output?: any; title?: string; error?: any
  sub?: boolean; agentId?: string; agentName?: string
  taskChild?: string; taskDesc?: string; shardRoot?: string
}

// ── 常量(与旧页一致,不发明) ───────────────────────────────────────────────
const FEED_CAP = 320, FEED_TRIM_TO = 280
const REGEN_MAX = 8000

// ── 状态 ──────────────────────────────────────────────────────────────────
let nid = 0
const nextId = () => ++nid

export const s = reactive({
  items: [] as FeedItem[],
  /** 展示层回收:前 archived 条不渲染(数据还在 items 里,重开卡可从历史恢复) */
  archived: 0,
  busy: false,
  ready: false,
  /** 本轮成功结束(标题 ✓,多卡扫一眼就知道谁跑完了) */
  done: false,
  // 启动参数
  title: '新对话',
  project: '',
  dir: '',
  modelLabel: '默认模型',
  sessionId: '',
  embedded: false,
  chatEmbed: false,
  /** wf/orch/shard 卡不走新页(第二棒接线):占位说明,不留死路 */
  unsupportedMode: '' as '' | 'wf' | 'orch' | 'shard',
  /** 工作流模式族(P2b-3):wf=动态工作流卡,orch=多层派发主控卡,shard=分片隐藏卡 */
  wfMode: false,
  orchMode: false,
  shardMode: false,
  /** 规划闸:true=方案已批(wf-plan-approved 已报主进程);planAsk=待批提示条可见 */
  planApproved: false,
  planAsk: false,
  /** 自动批准(仅 wf 卡,用户显式开启):权限请求自动放行 once 并留痕;关卡即失效 */
  wfAutoAllow: false,
  /** 主控卡分片进度(shard-progress 推送):{id, goal, status, round};shardView=就地渲染某片的镜像会话(''=主区域) */
  shards: [] as { id: string; goal: string; status: string; round: number }[],
  shardView: '',
  /** 主动交棒计数(knobs.autoCompactMax 顶) */
  autoCompactN: 0,
  /** cardInit 成功后恢复出来的草稿(ComposerBar watch 消费) */
  restoredDraft: '',
  /** ctx 估算用量(标题栏 chip 数据源之一) */
  ctxUsedChars: 0,
  /** ctx chip:serve 实测 tokens(null=估算态)/ KV-cache 命中率(null 不展示)/ 上下文上限 */
  ctxRealTokens: null as number | null,
  ctxCacheHit: null as number | null,
  ctxLimitTokens: 0,
  /** 当前模型 key(providerID/modelID,'' = serve 默认) */
  modelKey: '',
  /** 引擎保活灯(onServeHealth):ok=null 还没收到过心跳 */
  hb: { ok: null as boolean | null, port: 0, at: '' },
  /** 过程详情(Claude Code verbose):开=工具自动展开入参/结果;localStorage cardVerbose 记住偏好 */
  verbose: false,
  /** 成果抽屉:write/edit 落盘绝对路径(收集顺序,去重)+ 最近一轮最终结论 */
  artFiles: [] as string[],
  lastFinalText: '',
  artOpen: false,
  /** 压缩续聊确认闸(KDialog) */
  compactAsk: false,
  /** 已挂载技能('/' 菜单选择;跨轮保持直到 ✕ 卸载,对齐旧页 activeSkill) */
  activeSkill: null as { id: string; name: string; desc?: string } | null,
  /** 子 Agent 事件计数(P2b 侧边栏数据源,本棒只记账) */
  unhandledEvents: 0,
  /** 子 Agent 侧边栏(P2b):本轮 task/delegate_task 扇出的子 Agent 活动(各自独立缓冲,不占主对话流) */
  subAgents: [] as SubAgent[],
  subOpen: false,
  subActiveId: '',
  subRound: 'cur' as string,   // 轮次选择:'cur'=本轮实时,否则=历史轮快照(只读概要)
})

/** 可见条目(回收占位之后) */
export const visibleItems = computed(() => s.items.slice(s.archived))

/** 待批准权限(feed 里的 perm 条;sticky 摘要钉 = 首个工具名 + 总数,对齐旧页 pendingPerms) */
export const pendingPerms = computed(() => s.items.filter((i): i is PermItem => i.kind === 'perm'))

// ── 会话内非响应式运行时态 ────────────────────────────────────────────────
const meter = new CtxMeter()
const queue: QueueEntry[] = []
let lastSend: { text: string; files: any[] | null } | null = null
let draftKey = ''
let turnN = 0
// 子 Agent 索引:agentId → SubAgent(数组本体 = s.subAgents 响应式);跨轮清(每轮扇出重开)
const subIdx = new Map<string, SubAgent>()
let subClosedThisTurn = false   // 本轮手动关过侧边栏 → 不再自动滑出(对齐旧页 sdClosedThisTurn)
const SA_SNAP_MAX = 20
const saSnaps: SubSnap[] = []   // 历史轮只读快照(元数据,无 DOM)
// 工具块索引:partID → 数组里的代理(同 partID 原地更新);跨轮清(旧页 toolEls 同款语义)
const toolItems = new Map<string, ToolItem | TodoItem>()
// 成果抽屉去重集(清单本体 = s.artFiles 响应式)
const artFileSeen = new Set<string>()
// 模型列表缓存:空不缓存下次重试;成功缓存 60s(serve 换模型配置后列表能刷新)
let modelsCache: any[] | null = null, modelsCacheAt = 0
// 本轮流式态(turn 之间串行,全局一份即可 —— 与旧页同构)
let curAnswer: AiItem | null = null
let curReason: ReasonItem | null = null
let answerParts = new Map<string, string>()
let reasonParts = new Map<string, string>()
let flushQueued = false, needAnswer = false
// target 轮(命令块「运行」,P2b):回答渲染进命令块下的输出区 DOM,不进 feed(旧页 turn(text, target) 平移)
let targetParts: Map<string, string> | null = null
let targetEl: HTMLElement | null = null
let targetFlushQueued = false

// ── 条目构造 ──────────────────────────────────────────────────────────────
// ⚠ 响应式铁律:工作引用一律用「数组里的代理」,不能用 push 前的原始对象 ——
// 改原始对象不触发依赖(实测:流式期间 curAnswer 裸引用导致视图整体不刷新)。
export function addUser(text: string): UserItem {
  const it: UserItem = { id: nextId(), kind: 'user', text, queued: false }
  s.items.push(it); return s.items[s.items.length - 1] as UserItem
}
export function addNote(text: string, opts?: { muted?: boolean; retry?: boolean }): NoteItem {
  const it: NoteItem = { id: nextId(), kind: 'note', text, muted: opts?.muted !== false, retry: !!opts?.retry }
  s.items.push(it); return s.items[s.items.length - 1] as NoteItem
}
/** 静态 AI 气泡(查看本次改动等本地注入的富结果;raw=原文供复制) */
export function addAiStatic(markdown: string): AiItem {
  const ai = addAi()
  ai.status = 'done'; ai.raw = markdown; ai.finalHtml = renderMarkdown(markdown)
  return ai
}
function addAi(): AiItem {
  const it: AiItem = {
    id: nextId(), kind: 'ai', status: 'streaming',
    segs: [], frozenLen: 0, tail: '', finalHtml: '', raw: '', plainText: '',
    retryText: '', retryFiles: null,
  }
  s.items.push(it); return s.items[s.items.length - 1] as AiItem
}
function ensureReason(): ReasonItem {
  if (!curReason) {
    const r: ReasonItem = { id: nextId(), kind: 'reason', body: '', open: true }
    const at = curAnswer ? s.items.indexOf(curAnswer) : s.items.length
    const i = at < 0 ? s.items.length : at
    s.items.splice(i, 0, r)
    curReason = s.items[i] as ReasonItem   // 同上:用数组里的代理
  }
  return curReason
}

// ── 流式增量渲染(防 O(n²):冻结段只增,尾巴每帧重渲;rAF 合帧) ──────────────
function flushStream(): void {
  flushQueued = false
  const ai = curAnswer
  if (!ai) { needAnswer = false; return }
  const st = splitThink(joinParts(answerParts))
  const reasonBody = [joinParts(reasonParts), st.think].filter(Boolean).join('\n')
  if (reasonBody) { const r = ensureReason(); r.body = reasonBody; r.open = true }
  if (needAnswer) {
    // 纯思考阶段(rest 还空)不清占位符,气泡不闪空白(对齐旧页)
    if (st.rest) {
      const plan = planIncremental(st.rest, ai.frozenLen)
      if (plan.reset) {
        ai.segs = []; ai.frozenLen = 0; ai.tail = st.rest
      } else {
        if (plan.newSeg) {
          ai.segs.push({ id: nextId(), html: renderMarkdown(plan.newSeg) })
          ai.frozenLen = plan.cut
        }
        ai.tail = plan.tail
      }
    }
    needAnswer = false
  }
}
function scheduleFlush(): void {
  if (!flushQueued) { flushQueued = true; requestAnimationFrame(flushStream) }
}
// target 轮流式渲染(rAF 合帧;输出区是 v-html 之外的自由 DOM,直接写不碍 Vue)
function flushTarget(): void {
  targetFlushQueued = false
  if (targetEl && targetParts) targetEl.innerHTML = renderMarkdown(joinParts(targetParts))
}
function scheduleTargetFlush(): void {
  if (!targetFlushQueued) { targetFlushQueued = true; requestAnimationFrame(flushTarget) }
}
/** 命令块「运行」target 轮:POST 结果权威收尾,流式累积兜底;返回值=传输层无异常(按钮态据此落) */
export async function turnToEl(text: string, el: HTMLElement): Promise<boolean> {
  if (s.busy) return false
  s.busy = true; s.done = false
  targetParts = new Map(); targetEl = el
  let ok = true
  try {
    const reply = await BH()!.cardSend(text, [], s.activeSkill ? s.activeSkill.id : null)
    const raw = reply || joinParts(targetParts)
    el.innerHTML = renderMarkdown(splitThink(raw).rest)
    meter.bump(raw.length); s.ctxUsedChars = meter.usedChars
  } catch (e: any) {
    ok = false
    const partial = joinParts(targetParts)
    el.innerHTML = (partial ? renderMarkdown(partial) : '') + '<div class="errline" style="color:var(--danger)">出错：' + String((e && e.message) || e).replace(/</g, '&lt;') + '</div>'
  } finally {
    targetParts = null; targetEl = null
    s.busy = false
    if (ok) s.done = true
    pollRealUsage()
    drain()
  }
  return ok
}

// ── 主进程流事件(渲染端不碰 SSE,协议不变) ────────────────────────────────
let streamWired = false
export function wireStream(): void {
  if (streamWired) return
  streamWired = true
  try {
    BH()?.onStream?.((ev: StreamEvent) => {
      // 多层派发分片回流(shardRoot):只进分片专属缓冲(分片视图用),主控的侧边栏/对话流不沾
      if (ev.shardRoot) { upsertShardMirror(ev); return }
      // 本卡 task 子 Agent 活动 → 侧边栏各自窗格(思考/工具/产出),不占主对话流
      if (ev.sub) { upsertSubAgentEvent(ev); return }
      if (ev.kind === 'tool') { upsertToolEvent(ev); return }
      // target 轮途中:文本增量渲染进输出区 DOM(reasoning 不进 —— 命令运行只要输出)
      if (targetParts) {
        if (ev.kind !== 'reasoning') { targetParts.set(ev.partID || '_', String(ev.text || '')); scheduleTargetFlush() }
        return
      }
      if (!curAnswer) return
      const key = ev.partID || '_'
      if (ev.kind === 'reasoning') {
        reasonParts.set(key, String(ev.text || ''))
        scheduleFlush()
      } else {
        answerParts.set(key, String(ev.text || ''))
        needAnswer = true
        scheduleFlush()
      }
    })
  } catch { /* 静默 */ }
}

// ── 工具事件 → 工具块 / todo 一等公民卡(第二棒;契约锚定旧页 renderTool/todoHtml) ──
// 落点:插在当前流式气泡【之前】(工具在答案上方流过);同 partID 原地更新;默认折叠(verbose 开自动展开)。
// wf 运行时态(非响应式):规划闸判定原料
let wfExecSeen = false      // 已实质执行(派 task / write-edit / todo 出完成项)→ 撤规划闸
let wfSawTodo = false       // 见过 todowrite(方案已出)
let shardRetryN = 0         // 分片/主控空答自动重试计数(≤2;拿到文本即归零)
function insertBeforeAnswer<T extends FeedItem>(it: T): T {
  const at = curAnswer ? s.items.indexOf(curAnswer) : -1
  const i = at < 0 ? s.items.length : at
  s.items.splice(i, 0, it as FeedItem)
  return s.items[i] as T
}
function upsertToolEvent(ev: StreamEvent): void {
  const partID = String(ev.partID || '')
  if (!partID) { s.unhandledEvents++; return }
  const name = String(ev.text || '')
  const st = toolState(ev.status)
  // 规划闸探针(wf/orch):派 task / write-edit = 实质执行(主控豁免 write/edit —— 落盘哲学要求它写勘察清单是本职)
  if (/^(task|delegate_task)$/i.test(name) || (!s.orchMode && isWriteEditTool(name))) wfExecSeen = true
  // ctx 记账:终态同 partID 只记一次(CtxMeter 自带去重)
  if (st !== 'running') {
    try {
      const inLen = fmtInput(ev.input).length
      const outLen = fmtOutput(ev).length
      if (meter.countTool(partID, inLen + outLen)) s.ctxUsedChars = meter.usedChars
    } catch { /* 静默 */ }
  }
  if (isTodoTool(name)) { upsertTodo(partID, ev, st); return }
  let it = toolItems.get(partID) as ToolItem | undefined
  if (!it) {
    it = insertBeforeAnswer<ToolItem>({
      id: nextId(), kind: 'tool', partID, name: toolLabel(name), title: '', status: '',
      state: 'running', inStr: '', outStr: '', hasErr: false, summary: '',
      open: s.verbose, isWf: /^run_workflow$/i.test(name), askNoted: false,
    })
    if (toolItems.size > 500) toolItems.clear()   // 防御:长跑会话 Map 无界(清掉只影响后续原地更新,重建不丢终态)
    toolItems.set(partID, it)
  }
  it.status = String(ev.status || '')
  it.state = st
  if (ev.title) it.title = String(ev.title).slice(0, 120)
  const inFull = fmtInput(ev.input)
  if (inFull) { const t = truncIn(inFull); it.inStr = t.text + (t.tip ? '\n' + t.tip : '') }
  const outFull = fmtOutput(ev)
  if (outFull) { const t2 = truncOut(outFull); it.outStr = t2.text + (t2.tip ? '\n' + t2.tip : '') }
  it.hasErr = !!ev.error
  it.summary = toolSummary(it.status, outFull)
  // ask/elicit 无应答通道:兜底提示一块卡只挂一次(对齐旧页)
  if (isAskTool(name) && !it.askNoted) { it.askNoted = true; addNote('模型发起了提问,但这个工具没有应答通道 —— 请直接在输入框回复它的问题') }
  // 委派工具(task/delegate_task):记 taskChild(点工具块跳子 Agent 窗格);终态勾掉对应子 Agent
  if (/^(task|delegate_task)$/i.test(name)) {
    it.taskChild = String(ev.taskChild || '')
    if (it.taskChild && st !== 'running') subAgentDone(it.taskChild, st === 'err', String(ev.taskDesc || ''))
  }
  // write/edit 落盘 → 成果抽屉(完成且无错才收;对齐旧页与 session.js wfFiles 口径)
  if (isWriteEditTool(name) && st === 'done' && !it.hasErr) {
    const fp = artAbs(extractFilePath(ev.input), s.dir)
    if (fp && !artFileSeen.has(fp)) { artFileSeen.add(fp); s.artFiles.push(fp) }
  }
}
// todowrite → 一等公民清单卡(不折叠);形状不符整卡隐藏(已创建就摘掉,不留空白块)
function upsertTodo(partID: string, ev: StreamEvent, st: ToolState): void {
  const model = todoModel(ev.input)
  if (model) {
    wfSawTodo = true   // 规划闸原料:见过 todowrite(方案已列);出完成项 = 已在执行(主控第一轮"预检"打勾不算)
    if (model.doneN > 0 && !s.orchMode) wfExecSeen = true
  }
  let it = toolItems.get(partID) as TodoItem | undefined
  if (!model) {
    if (it) { const i = s.items.indexOf(it); if (i >= 0) s.items.splice(i, 1); toolItems.delete(partID) }
    return
  }
  if (!it) {
    it = insertBeforeAnswer<TodoItem>({ id: nextId(), kind: 'todo', partID, model, updating: true })
    toolItems.set(partID, it)
  }
  it.model = model
  it.updating = st === 'running'
}

// ── 子 Agent 侧边栏(P2b,旧页 1795-1885 平移):扇出自动滑出(本轮没手动关过)、各自窗格 ──
const READ_TOOL = /^(read|grep|glob|list|ls|find|tree)$/i
function subAgent(id: string, name?: string): SubAgent {
  const hit = subIdx.get(id)
  if (hit) { if (name && name !== '子agent') hit.name = name; return hit }
  const a: SubAgent = {
    id, name: name || '子agent', count: 0, reads: 0, t0: Date.now(), doneAt: 0, done: false, err: false,
    tools: [], toolIdx: new Map(), reasonParts: new Map(), outParts: new Map(), reason: '', outHtml: '',
  }
  s.subAgents.push(a)
  const proxy = s.subAgents[s.subAgents.length - 1]   // 响应式铁律:索引存数组里的代理 —— 存原对象改属性不触发更新(实测:subAgentDone 勾不掉)
  subIdx.set(id, proxy)
  s.subActiveId = id                 // 新子 Agent 自动成为当前窗格
  if (!subClosedThisTurn) s.subOpen = true   // fan-out 必须被看见(本轮没被手动关过就自动滑出)
  return proxy
}
function upsertSubAgentEvent(ev: StreamEvent): void {
  const a = subAgent(ev.agentId || '_', ev.agentName)
  if (ev.kind === 'tool') {
    const partID = String(ev.partID || '')
    if (partID && !a.toolIdx.has(partID)) { a.count++; if (READ_TOOL.test(String(ev.text || ''))) a.reads++ }
    let t = partID ? a.toolIdx.get(partID) : undefined
    if (!t) {
      t = {
        id: nextId(), kind: 'tool', partID: partID || ('_' + a.tools.length), name: toolLabel(ev.text), title: '', status: '',
        state: 'running', inStr: '', outStr: '', hasErr: false, summary: '', open: s.verbose, isWf: false, askNoted: false,
      }
      a.tools.push(t)
      const proxy = a.tools[a.tools.length - 1]
      if (partID) a.toolIdx.set(partID, proxy)
      t = proxy
    }
    t.status = String(ev.status || '')
    t.state = toolState(t.status)
    if (ev.title) t.title = String(ev.title).slice(0, 120)
    const inFull = fmtInput(ev.input)
    if (inFull) { const x = truncIn(inFull); t.inStr = x.text + (x.tip ? '\n' + x.tip : '') }
    const outFull = fmtOutput(ev)
    if (outFull) { const x2 = truncOut(outFull); t.outStr = x2.text + (x2.tip ? '\n' + x2.tip : '') }
    t.hasErr = !!ev.error
    t.summary = toolSummary(t.status, outFull)
    if (t.state === 'err') a.err = true
  } else if (ev.kind === 'reasoning') {
    a.reasonParts.set(ev.partID || '_', String(ev.text || ''))
    a.reason = joinParts(a.reasonParts)
  } else {
    a.outParts.set(ev.partID || '_', String(ev.text || ''))
    a.outHtml = renderMarkdown(joinParts(a.outParts))
  }
}
/** task/delegate_task 终态 → 勾掉对应子 Agent(主 feed 的委派工具块带来真子会话 id) */
function subAgentDone(id: string, err: boolean, name?: string): void {
  const a = subIdx.get(id); if (!a || a.done) return
  if (name) a.name = name
  a.done = true; a.doneAt = Date.now(); if (err) a.err = true
}
/** 点委派工具块跳到该子 Agent 窗格(ToolBlock 调用) */
export function subJump(agentId: string): void {
  if (!subIdx.has(agentId)) return
  s.subActiveId = agentId; s.subOpen = true; s.subRound = 'cur'
}
export function subToggle(open?: boolean): void {
  s.subOpen = open !== undefined ? open : !s.subOpen
  subClosedThisTurn = !s.subOpen
}
/** 运行中的子 Agent 数(标题栏徽标) */
export function subRunningCount(): number { let n = 0; for (const a of s.subAgents) if (!a.done) n++; return n }
/** 清场前拍轮次快照(只留概要,上限 20 轮;历史轮只读,实时窗格永远属本轮) */
function snapshotSubAgents(): void {
  if (!subIdx.size) return
  const items = [...subIdx.values()].map((a) => ({
    name: a.name, count: a.count, ms: Math.max(0, (a.done ? a.doneAt : Date.now()) - a.t0), err: a.err, reads: a.reads,
  }))
  saSnaps.push({ round: turnN, items })
  if (saSnaps.length > SA_SNAP_MAX) saSnaps.shift()
}
export function subSnapList(): SubSnap[] { return saSnaps }

// ── 分片回流镜像(P2b-3 分片视图的数据层;点进度卡细看某片时渲染) ──
// shardRoot → Map<partID, 事件快照>;只缓冲不渲染(渲染在分片视图组件,合帧)。
export interface ShardMirrorItem { partID?: string; kind?: string; text?: string; status?: string; input?: any; output?: any; title?: string; error?: any; sub?: boolean; agentName?: string; shardRoot?: string }
const shardStreams = new Map<string, Map<string, ShardMirrorItem>>()
function upsertShardMirror(ev: ShardMirrorItem): void {
  const root = String(ev.shardRoot || ''); if (!root) return
  let m = shardStreams.get(root); if (!m) { m = new Map(); shardStreams.set(root, m) }
  m.set(ev.partID || ((ev.kind || 'x') + '_' + m.size), ev)
  // 分片 write/edit 落盘 → 主控卡成果抽屉(8 片文档+索引都在磁盘,抽屉不能显示"无")
  try {
    if (ev.kind === 'tool' && /complet|success|done/i.test(String(ev.status || '')) && !ev.error && isWriteEditTool(ev.text)) {
      const fp = artAbs(extractFilePath(ev.input), s.dir)
      if (fp && !artFileSeen.has(fp)) { artFileSeen.add(fp); s.artFiles.push(fp) }
    }
  } catch { /* 静默 */ }
}
export function shardMirror(root: string): Map<string, ShardMirrorItem> | undefined { return shardStreams.get(root) }

// ── 回合(turn) ────────────────────────────────────────────────────────────
function addRetryNote(msg: string): void {
  addNote(msg, { retry: !!lastSend })
}

/**
 * 一轮问答。返回 true=传输层无异常。
 * POST 结果权威收尾:reply || 流式累积兜底(内网 bocomcode POST 空 body 不丢答案)。
 */
export async function turn(text: string, files?: any[] | null): Promise<boolean> {
  // 新一轮:拍上一轮的子 Agent 快照(历史轮只读)→ 清场开本轮扇出
  snapshotSubAgents()
  s.subAgents = []; subIdx.clear(); s.subActiveId = ''; subClosedThisTurn = false; s.subRound = 'cur'
  turnN++
  s.planAsk = false   // 新一轮开跑即撤规划闸提示(用户在调整方案,轮末若仍待批会重挂)
  const ai = addAi()
  curAnswer = ai; curReason = null
  answerParts = new Map(); reasonParts = new Map()
  needAnswer = false; flushQueued = false
  s.busy = true; s.done = false
  lastSend = { text, files: files || null }
  if (draftKey) draftClear(localStorage, draftKey)   // 草稿发送即清
  meter.bump((text || '').length); s.ctxUsedChars = meter.usedChars
  let ok = true, gotText = false
  try {
    const reply = await BH()!.cardSend(text, files || [], s.activeSkill ? s.activeSkill.id : null)   // 挂载技能(作答方法论预置,对齐旧页 submit 第三参)
    flushStream()   // 末帧兜底:rAF 还没跑的增量先落上(马上要被 finalHtml 盖掉,主要为思考块)
    const raw = reply || joinParts(answerParts)
    const st = splitThink(raw)
    if (st.think) { const r = ensureReason(); r.body = [joinParts(reasonParts), st.think].filter(Boolean).join('\n'); r.open = true }
    const finalText = st.rest
    if (finalText) {
      gotText = true
      ai.finalHtml = renderMarkdown(finalText)
      ai.raw = finalText
      ai.status = 'done'
      s.lastFinalText = finalText   // 成果抽屉「最终结论」数据源(最近一轮终答)
      if ((text || '').length <= REGEN_MAX) { ai.retryText = text; ai.retryFiles = files || null }
    } else if (st.think) {
      ai.status = 'done'; ai.plainText = '（本轮只有思考过程，见上方思考块）'
    } else {
      ai.status = 'done'; ai.plainText = '（无文本输出）'
      addRetryNote('没拿到文本输出(网关静默/模型空答)—— 可直接重试，同一条消息不用重打')
    }
    meter.bump(finalText.length + (st.think ? st.think.length : 0)); s.ctxUsedChars = meter.usedChars
  } catch (e: any) {
    ok = false
    // 半截答案是用户的,错误不许覆盖它:保留半截 + 错误另起一行 note;思考同样分流进思考块
    const pst = splitThink(joinParts(answerParts))
    if (pst.think) { const r = ensureReason(); r.body = [joinParts(reasonParts), pst.think].filter(Boolean).join('\n'); r.open = true }
    if (pst.rest) {
      gotText = true   // 半截也是文本(分片/主控空答重试不冤枉它)
      ai.finalHtml = renderMarkdown(pst.rest)
      ai.raw = pst.rest
      ai.status = 'aborted'
      addRetryNote('回合中断：' + ((e && e.message) || e) + '（以上是中断前已收到的部分回答）')
    } else {
      ai.status = 'error'
      ai.plainText = '出错：' + ((e && e.message) || e)
      addRetryNote('内网网关抖动是常态，可直接重试（同一条消息，不用重打）')
    }
  } finally {
    curAnswer = null; curReason = null
    s.busy = false
    if (ok) s.done = true
    maybeCapFeed()
    pollRealUsage()   // 轮末刷实测用量(ctx chip 实测态;fire-and-forget)
    // 分片/主控卡空答自动重试(≤2,网关静默不能卡死无人值守链;拿到文本即归零)
    if (ok && gotText) shardRetryN = 0
    if (ok && !gotText && (s.shardMode || s.orchMode) && shardRetryN < 2 && lastSend) {
      shardRetryN++
      addNote((s.shardMode ? '分片' : '主控') + '自动重试(' + shardRetryN + '/2):网关静默/模型空答')
      turn(lastSend.text, lastSend.files)
      return ok
    }
    maybePlanGate()     // 规划闸:方案出了没执行 → 待批提示(分片卡静默自动批)
    maybeAutoCompact()  // wf 主动交棒:水位达标写交接单换下一棒
    drain()
  }
  return ok
}

/** 中断本轮(Esc / 发送钮变停止钮) */
export function abort(): void {
  try { BH()?.cardAbort?.() } catch { /* 静默 */ }
}

/** 重试本轮(同一条消息原样重发) */
export function retryLast(): void {
  if (s.busy || !lastSend) return
  turn(lastSend.text, lastSend.files)
}

/** 重新回答(把同样的问题再问一遍,新答案追加在下方) */
export function regen(text: string, files?: any[] | null): void {
  if (s.busy) return
  turn(text, files)
}

// ── 发送 / 排队 ───────────────────────────────────────────────────────────
/**
 * composer 提交:组装文档引用/图片附件,忙时入队(气泡立即上屏,半透明+可取消),
 * 闲时直接开轮。与旧页 submit() 同构。
 */
export function submit(text: string, atts: { kind: string; name: string; path?: string; mime?: string; dataUrl?: string }[], disp?: string): void {
  const v = text.trim()
  if (!v && !atts.length) return
  const docRefs = atts.filter((a) => a.kind === 'doc').map((a) => '- ' + a.path + '（' + a.name + '）').join('\n')
  const docNote = docRefs ? '【用户拖入了文档，需要时用 read_document 工具读取其内容】\n' + docRefs : ''
  const images = atts.filter((a) => a.kind === 'image').map((a) => ({ mime: a.mime, url: a.dataUrl, filename: a.name }))
  const full = [docNote, v].filter(Boolean).join('\n\n')
  const dispText = disp || (v || (images.length ? '(图片)' : '(文档)')) + (atts.length ? ' · 附件 ' + atts.length : '')   // card-inject:用户气泡看 disp,引擎收全文
  const el = addUser(dispText)
  if (s.busy || !s.ready) {
    el.queued = true
    queue.push({ text: full || '(见附件)', files: images, item: el })
    return
  }
  turn(full || '(见附件)', images)
}

/** 取消一条排队中的消息(出队 + 撤气泡) */
export function cancelQueuedItem(item: UserItem): void {
  const at = queue.findIndex((q) => q.item === item)
  if (at >= 0) queue.splice(at, 1)
  const i = s.items.indexOf(item)
  if (i >= 0) s.items.splice(i, 1)
}

/** 轮末 drain:就绪且闲且有队 → 出一条转正发出 */
function drain(): void {
  const qi = drainNext(queue, s.ready, s.busy)
  if (!qi) return
  qi.item.queued = false
  turn(qi.text, qi.files)
}

// ── feed 展示层回收(超 320 收到 280 + 顶部收纳占位;数据不丢) ─────────────
function maybeCapFeed(): void {
  const over = s.items.length - s.archived - FEED_CAP
  if (over > 0) s.archived = s.items.length - FEED_TRIM_TO
}

// ── 草稿(ComposerBar 调用) ────────────────────────────────────────────────
export function saveDraft(value: string): void {
  if (draftKey) draftSave(localStorage, draftKey, value)
}

// ── 权限审批条(第二棒):feed 内 PermItem(答完移除)+ pendingPerms 计数(sticky 摘要钉) ──
let permWired = false
export function wirePermission(): void {
  if (permWired) return
  permWired = true
  try {
    BH()?.onPermission?.((p: any) => {
      if (!p || !p.requestId) return
      // 自动批准(仅 wf 卡,用户显式开启):本卡权限请求自动放行 once 并留痕;关卡即失效
      if (s.wfMode && s.wfAutoAllow) {
        try { BH()?.permissionReply?.(p.requestId, 'once') } catch { /* 静默 */ }
        addNote('🤝 自动批准:' + String(p.tool || '?') + (p.detail ? ' · ' + String(p.detail).slice(0, 120) : ''))
        return
      }
      s.items.push({
        id: nextId(), kind: 'perm', requestId: String(p.requestId),
        tool: String(p.tool || '?'), detail: String(p.detail || ''), diff: String(p.diff || ''),
        miss: p.miss || null, highRisk: isHighRisk(p.tool, p.detail),
      })
    })
  } catch { /* 静默 */ }
}
export function replyPerm(it: PermItem, d: PermDecision): void {
  try { BH()?.permissionReply?.(it.requestId, d) } catch { /* 静默 */ }
  const i = s.items.indexOf(it); if (i >= 0) s.items.splice(i, 1)   // 对齐旧页 box.remove;sticky 计数随动
}
export function toggleWfAutoAllow(): void {
  s.wfAutoAllow = !s.wfAutoAllow
  addNote(s.wfAutoAllow ? '已开启【自动批准】:本工作流的写文件/执行命令等权限请求将自动放行(工具日志留痕,再点一次关闭)' : '已关闭【自动批准】:恢复逐个人工确认')
}

// ── 规划闸(wf/orch,旧页 1153 平移):方案(todowrite)出了但没实质执行 → 待批提示;分片自动批 ──
const APPROVE_MSG = '批准方案。请按你刚才的计划用编辑工具完成修改;改完调 repro_assert/repro_self_review 登记,再简要总结改了什么。我改完后会自动用 git diff 把改动展示给我看。'
function maybePlanGate(): void {
  if (!(s.wfMode || s.orchMode) || s.planApproved) return
  if (s.shardMode) { approvePlan(true); return }   // 分片卡:拆分方案主控卡已批,静默自动开跑
  if (wfSawTodo && !wfExecSeen) s.planAsk = true
}
export function approvePlan(auto?: boolean): void {
  if (s.planApproved) return
  s.planApproved = true; s.planAsk = false
  try { BH()?.wfPlanApproved?.() } catch { /* 静默 */ }   // relay 层放行 run_workflow 派发
  addNote(auto ? '✅ 分片自动批准开跑(拆分方案主控已批)' : '✅ 已批准,开始执行')
  submit(APPROVE_MSG, [])
}

// ── 主进程直发注入(card-inject:严格模式下一步 / 主控进度唤醒) ───────────────
// 等同用户消息过 card-send 通道 —— 这样每轮终答必回调 wfTurnDone,链条闭环不依赖主进程直发后的回合检测。
let injectWired = false
export function wireInject(): void {
  if (injectWired) return
  injectWired = true
  try {
    BH()?.onCardInject?.((p: any) => {
      if (!p || !p.text) return
      submit(String(p.text), [], String(p.disp || ''))
    })
  } catch { /* 静默 */ }
}

// ── 主控卡分片进度(shard-progress 推送)+ 分片视图(点一片就地渲染镜像会话) ─────
let shardProgWired = false
export function wireShardProgress(): void {
  if (shardProgWired) return
  shardProgWired = true
  try {
    BH()?.onShardProgress?.((p: any) => {
      if (!p || !Array.isArray(p.shards)) return
      s.shards = p.shards.map((x: any) => ({ id: String(x.id || ''), goal: String(x.goal || ''), status: String(x.status || ''), round: +x.round || 0 }))
    })
  } catch { /* 静默 */ }
}
export function openShardView(id: string): void { s.shardView = id || '' }

// ── 工作流卡【主动交棒】(旧页 1037-1049 平移):水位 ≥knobs.ctxHandoffPct(默认 0.55)且轮末空闲
// → 写交接单换下一棒主 Agent(全新 128k);上限 knobs.autoCompactMax(默认 5)防病态循环,到顶转人工。
function maybeAutoCompact(): void {
  if (!s.wfMode || s.busy || !s.ctxLimitTokens) return
  let handoff = 0.55, maxN = 5
  try {
    const knobs = ((BH()?.getSettings?.() || {}) as any).knobs || {}
    if (+knobs.ctxHandoffPct > 0) handoff = +knobs.ctxHandoffPct
    if (Math.round(+knobs.autoCompactMax) >= 1) maxN = Math.round(+knobs.autoCompactMax)
  } catch { /* 静默 */ }
  const pct = ctxPctVal(s.ctxRealTokens, s.ctxUsedChars, s.ctxLimitTokens)
  if (pct < handoff) return
  if (s.autoCompactN >= maxN) return   // 到顶转人工(ctx chip 手动压)
  s.autoCompactN++
  compactCore({ wf: true, auto: true })
}

// ── 交互提问卡(第二棒):单/多选/custom/跳过,答完定格 doneText 留痕 ─────────────
let questionWired = false
export function wireQuestion(): void {
  if (questionWired) return
  questionWired = true
  try {
    BH()?.onQuestion?.((p: any) => {
      if (!p || !p.requestId) return
      s.items.push({
        id: nextId(), kind: 'question', requestId: String(p.requestId),
        questions: Array.isArray(p.questions) ? p.questions : [], answers: [], sent: false, doneText: '',
      })
    })
  } catch { /* 静默 */ }
}
export async function sendQuestion(it: QuestionItem): Promise<void> {
  if (it.sent || !quizCanSend(it.answers, it.questions)) return
  it.sent = true
  try {
    const r = await BH()?.questionReply?.(it.requestId, it.answers)
    it.doneText = (r && r.ok) ? quizSummary(it.answers) : ('⚠ 回答没送达:' + ((r && r.err) || '未知错误') + '(可直接把答复打在输入框发出)')
  } catch (e: any) { it.doneText = '⚠ 回答没送达:' + ((e && e.message) || e) }
}
export async function rejectQuestion(it: QuestionItem): Promise<void> {
  if (it.sent) return
  it.sent = true
  try {
    const r = await BH()?.questionReject?.(it.requestId)
    it.doneText = (r && r.ok) ? '✕ 已跳过(拒绝回答)' : '⚠ 拒绝没送达(可直接把答复打在输入框发出)'
  } catch (e: any) { it.doneText = '⚠ 拒绝没送达:' + ((e && e.message) || e) }
}

// ── 保活灯 / verbose(过程详情) ─────────────────────────────────────────────
let hbWired = false
export function wireServeHealth(): void {
  if (hbWired) return
  hbWired = true
  try {
    BH()?.onServeHealth?.((p: any) => {
      // 心跳到了就算活着(形状防御:不带 ok 字段也算);灯色组件按 ok 染
      s.hb = { ok: !p || p.ok !== false, port: (p && p.port) || 0, at: new Date().toTimeString().slice(0, 8) }
    })
  } catch { /* 静默 */ }
}
export function initVerbose(): void { try { s.verbose = localStorage.getItem('cardVerbose') === '1' } catch { /* 静默 */ } }
export function toggleVerbose(): void {
  s.verbose = !s.verbose
  try { localStorage.setItem('cardVerbose', s.verbose ? '1' : '0') } catch { /* 静默 */ }
}

// ── ctx chip 数据源:上限(listModels 60s 缓存 → 型号兜底 → 128k 硬顶)/ 实测用量(轮末轮询) ──
export async function refreshCtxLimit(): Promise<void> {
  let limit = 0
  try {
    const now = Date.now()
    if (!modelsCache || now - modelsCacheAt > 60000) { modelsCache = (await BH()?.listModels?.()) || []; modelsCacheAt = now }
    const cur = s.modelKey && (modelsCache || []).find((m: any) => (m.providerID + '/' + m.modelID) === s.modelKey)
    limit = (cur && ((cur.limit && cur.limit.context) || cur.context || 0)) || 0
  } catch { /* 静默 */ }
  if (!limit) limit = ctxFallbackFor(s.modelKey || s.modelLabel)
  if (!limit) limit = 128000
  let capMax = 128000
  try { capMax = Math.floor(+((((BH()?.getSettings?.() || {}) as any).knobs || {}).ctxLimitMax)) || 128000 } catch { /* 静默 */ }
  s.ctxLimitTokens = ctxCap(limit, capMax)
}
export async function pollRealUsage(): Promise<void> {
  try {
    const u = await BH()?.cardUsage?.()
    s.ctxRealTokens = u && u.tokens ? u.tokens : null
    s.ctxCacheHit = u && typeof (u as any).cacheHit === 'number' ? (u as any).cacheHit : null
  } catch { /* 静默 */ }
}
/** 模型菜单数据源(60s 缓存,与 refreshCtxLimit 共用一份) */
export async function listModels(): Promise<any[]> {
  try {
    const now = Date.now()
    if (!modelsCache || now - modelsCacheAt > 60000) { modelsCache = (await BH()?.listModels?.()) || []; modelsCacheAt = now }
  } catch { /* 静默 */ }
  return modelsCache || []
}
export async function setModel(key: string): Promise<void> {
  const m = (modelsCache || []).find((x: any) => (x.providerID + '/' + x.modelID) === key)
  if (!m) return
  try { await BH()?.cardSetModel?.({ providerID: m.providerID, modelID: m.modelID, name: m.name }) } catch { /* 静默 */ }
  s.modelKey = key
  s.modelLabel = m.name || m.modelID
  refreshCtxLimit()   // 换模型 → 上限重估(兜底表按新型号匹配)
}
/** 作答技能('/' 菜单):挂到 activeSkill,submit 时随 cardSend 第三参发出;✕ 卸载 */
export async function listSkills(): Promise<any[]> {
  try { return (await BH()?.skillsList?.()) || [] } catch { return [] }
}
export function setActiveSkill(sk: { id: string; name: string; desc?: string } | null): void {
  s.activeSkill = sk
}

// ── 压缩续聊(compactCore,旧页 982-1017 平移):模型写接力摘要 → cardReinit(carryCtx) → 清场续聊 ──
// wf 变体(主动交棒):工作流专用摘要提示 + 压缩后自动发「恢复执行」棒次,无人值守链不断。
const SUM_PROMPT_CHAT = '请把我们这段对话压缩成一份「接力摘要」，供新会话继续用。包含：1) 正在做的事与目标 2) 已确认的关键结论/决定（保留文件路径、命令、数据） 3) 未完成事项与下一步 4) 已排除的思路与失败尝试（各附一句原因 —— 保错误证据，下一棒不重犯） 5) 需要沿用的约束与偏好。只输出摘要正文。'
const SUM_PROMPT_WF = '请把本工作流到目前为止压缩成一份「接力摘要」，供新会话无缝继续执行。必须包含：1) 总目标 2) todo 计划清单及各项当前状态（原样逐条列出） 3) 已确认的关键结论与产出（保留文件路径、file:行号、命令、数据；子 Agent 已回报的发现逐条保留） 4) 未完成事项与下一步打算 5) 已尝试与已排除路径（失败的方法/走过的死胡同/被否决的方案，各附一句原因 —— 保错误证据，下一棒不重犯） 6) 需沿用的约束。只输出摘要正文。'
const RESUME_MSG = '接力摘要已随本消息注入（见上方摘要块）。请先用 todowrite 恢复摘要里的计划清单，然后按未完成事项继续执行，直至总目标完成。'
/** 清场:压缩续聊/切目录专用 —— feed/队列/工具账本/成果抽屉全清,会话级草稿键由调用方负责换 */
export function resetConversation(): void {
  s.items = []; s.archived = 0
  toolItems.clear(); artFileSeen.clear(); s.artFiles = []; s.lastFinalText = ''
  queue.length = 0; curAnswer = null; curReason = null
  answerParts = new Map(); reasonParts = new Map()
  meter.reset(); s.ctxUsedChars = 0; s.ctxRealTokens = null; s.ctxCacheHit = null
  wfExecSeen = false; wfSawTodo = false   // 新会话重看规划/执行信号(planApproved 主进程侧按卡记,不动)
}
export async function compactCore(opts?: { wf?: boolean; auto?: boolean }): Promise<boolean> {
  const wf = !!(opts && opts.wf), auto = !!(opts && opts.auto)
  if (s.busy) { addNote('正在回答中，等这轮结束再压缩'); return false }
  addNote(auto ? '到达主动交棒水位,接力给下一棒主 Agent(第 ' + s.autoCompactN + ' 棒):正在写交接单…' : '压缩续聊:正在让模型总结本段对话…')
  const ok = await turn(wf ? SUM_PROMPT_WF : SUM_PROMPT_CHAT)
  const lastAi = [...s.items].reverse().find((i): i is AiItem => i.kind === 'ai' && !!(i as AiItem).raw)
  const summary = ok && lastAi ? String(lastAi!.raw || '') : ''
  if (!summary.trim()) { addNote('压缩失败：没拿到摘要，继续用原会话（可稍后重试）'); return false }
  try {
    const r = await BH()!.cardReinit({ dir: s.dir, carryCtx: summary, shard: s.shardMode || undefined })
    resetConversation()
    s.project = r.project || s.project; s.dir = r.dir || s.dir
    s.modelLabel = (r.model && (r.model.name || r.model.modelID)) || s.modelLabel
    s.sessionId = r.sessionId || s.sessionId
    draftKey = draftKeyOf(s.sessionId)
    meter.bump(summary.length); s.ctxUsedChars = meter.usedChars
    s.items.push({ id: nextId(), kind: 'reason', body: summary, open: false, title: '接力摘要（已随新会话注入）' })
    if (auto) {
      addNote('已交棒:下一棒主 Agent 带着交接单上阵(全新 128k),继续执行未完成步骤')
      await turn(RESUME_MSG)
    } else {
      addNote('已压缩续聊：新会话就绪，摘要已注入，直接继续提问即可。')
      drain()
    }
    return true
  } catch (e: any) { addNote('开新会话失败：' + ((e && e.message) || e) + '（原会话不受影响）'); return false }
}

// ── 启动引导(cardInit 生命周期) ───────────────────────────────────────────
function replayMessages(list: any[]): void {
  for (const m of list || []) {
    if (m.role === 'assistant' && m.reasoning) {
      // 历史思考链随消息回放,默认折叠(几十轮全展开会淹没对话),点标题即展开
      s.items.push({ id: nextId(), kind: 'reason', body: String(m.reasoning), open: false })
    }
    if (m.text) {
      if (m.role === 'user') addUser(String(m.text))
      else {
        const ai = addAi()
        ai.status = 'done'; ai.raw = String(m.text); ai.finalHtml = renderMarkdown(String(m.text))
      }
    }
  }
}

export async function boot(): Promise<void> {
  wireStream()
  wirePermission()     // 权限审批条(feed PermItem + sticky 计数;wf 自动批准分支)
  wireQuestion()       // 交互提问卡(单/多选/custom/跳过)
  wireServeHealth()    // 标题栏保活灯
  wireInject()         // card-inject:严格模式下一步 / 主控进度唤醒(过 card-send 闭环)
  wireShardProgress()  // 主控卡分片进度面板
  initVerbose()        // 过程详情偏好(localStorage cardVerbose)
  const p = new URLSearchParams(location.search)
  s.title = p.get('title') || '新对话'
  const initMsg = p.get('msg') || s.title          // msg 在场时发送内容不同于标题(fan-out)
  const dispMsg = p.get('disp') || initMsg         // disp 在场时用户气泡展示它
  const sid = p.get('sid') || ''
  s.embedded = p.get('embedded') === '1'
  s.chatEmbed = s.embedded && p.get('chat') === '1'
  // 工作流模式族(P2b-3):wf=动态工作流卡(规划闸/自动批准/主动交棒),orch=主控(分片进度面板),shard=分片(静默自动批+空答重试)
  s.wfMode = p.get('wf') === '1' || p.get('wf') === 'true'
  s.orchMode = !!p.get('orch')
  s.shardMode = p.get('shard') === '1'
  try { purgeStaleDrafts(localStorage) } catch { /* 静默 */ }

  s.busy = true
  if (!sid && (!s.embedded || (s.chatEmbed && p.get('msg')))) addUser(dispMsg)
  const bootItem = addAi()
  bootItem.plainText = sid ? '正在续接对话…' : (s.embedded && !s.chatEmbed) ? '正在连接调试助手…' : '正在启动引擎…（首次较慢，请稍候）'
  try {
    const r = await BH()!.cardInit(sid ? { sid, title: s.title } : { title: s.title })
    s.project = r.project || ''
    s.dir = r.dir || ''
    s.modelLabel = (r.model && (r.model.name || r.model.modelID)) || '默认模型'
    s.modelKey = r.model ? (r.model.providerID + '/' + r.model.modelID) : ''
    s.sessionId = r.sessionId || ''
    refreshCtxLimit()   // ctx chip 上限(listModels → 型号兜底 → 128k 硬顶;fire-and-forget)
    draftKey = draftKeyOf(s.sessionId)
    // 续接/调试卡恢复草稿;新卡自动发首条消息,不恢复(对齐旧页)
    if (sid || s.embedded) {
      const d = draftRestore(localStorage, draftKey, '')
      if (d) s.restoredDraft = d
    }
    const bi = s.items.indexOf(bootItem); if (bi >= 0) s.items.splice(bi, 1)
    s.ready = true
    // 主窗口内嵌会话卡:绑定的 sid/标题回写宿主 shell 侧栏(硬兼容点①)
    if (s.chatEmbed) {
      try { BH()?.cardBoundEmit?.({ cardId: p.get('id') || '', sid: s.sessionId, title: s.title, wf: false }) } catch { /* 静默 */ }
    }
    if (sid) {
      if (r.reattached) {
        if (r.messages && r.messages.length) replayMessages(r.messages)
        else addNote('（历史消息未能载入，可直接继续这段对话）')
      } else {
        if (r.messages && r.messages.length) {
          replayMessages(r.messages)
          addNote('（原会话已不在引擎：以上是本地存档回放，继续对话将写入新的一段）')
        } else addNote('（原对话已不在引擎中，已为你新开一段，标题：' + s.title + '）')
      }
      s.busy = false
    } else if (s.embedded && !s.chatEmbed) {
      s.busy = false
      addNote('我是你的调试助手。在右侧浏览器复现问题后点「发给 Agent」，我会拿到控制台报错、网络异常和页面结构来定位；也可以直接在下面提问。')
    } else if (s.chatEmbed && !p.get('msg')) {
      s.busy = false   // 主窗口「新建对话」:空态等输入,不把标题当首条消息发出去
    } else {
      let initFiles: any[] = []
      try { const cid = p.get('id'); if (cid) initFiles = (await BH()?.getCardFiles?.(cid)) || [] } catch { /* 静默 */ }
      await turn(initMsg, initFiles)
    }
    drain()
  } catch (e: any) {
    bootItem.status = 'error'
    bootItem.plainText = (sid ? '无法续接：' : '引擎未就绪：') + ((e && e.message) || e) + (sid ? '' : '（确认 opencode/bocomcode 已装、模型已配）')
    s.busy = false
  }
}

// ── 给第二棒的挂载点(HANDOFF) ─────────────────────────────────────────────
//  · 工具块:onStream kind==='tool' 目前在 wireStream 里只记账(unhandledEvents++),
//    渲染插槽 = FeedView 的 MessageItem(kind:'tool') + s.items 里插 ToolItem。
//  · 提问卡/权限条:onQuestion/onPermission 尚未 wire,挂在 wireStream 旁边即可。
//  · 标题栏 chips:s.modelLabel/s.ctxUsedChars/s.done 已备好,TitleBar 里 data-slot 占位。
//  · todo 卡:todowrite 事件同工具块插槽;rich.ts 的 TODO: 行内块已可用。
//  · 富结果「运行」动作:依赖 turn(text, target) 的 target 轮,本棒 turn 无 target 形参(存疑平移)。
