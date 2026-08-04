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
// 丢补丁回补波(对齐旧页 card.html 为准):compacting 闸(摘要轮防重入/submit 入队/drain 不开轮/reinit 持忙)、
//   摘要轮两句+<analysis> 剥离+工作现场回填+滚动 session memory(compactLog*)、子 Agent 完成态权威轮询(pollSubStatus,5s)、
//   taskChild 只认非空覆写+终态 taskChild 优先配对(同名归并已废)/孙会话联动 done、分片镜像只写缓冲+shardVersion 150ms 合帧+终态截尾、
//   hang 探针按内容签名判活+分片/主控 300s 自动中断、chatHandoffPct 旋钮、ctx 上限读 ctx 字段+knobs.ctxLimitMax 兜底+回合补刷
import { reactive, computed, ref } from 'vue'
import { BH } from './bridge'
import { renderMarkdown } from './rich'
import { splitThink, joinParts } from './lib/text'
import { planIncremental } from './lib/stream'
import { CtxMeter } from './lib/ctx'
import { drainNext } from './lib/queue'
import { draftKeyOf, draftSave, draftRestore, draftClear, purgeStaleDrafts } from './lib/draft'
import {
  isTodoTool, isWriteEditTool, isAskTool, asObj, fmtInput, fmtOutput, toolLabel,
  toolState, toolSummary, todoModel, extractFilePath, artAbs, truncIn, truncOut,
  isDispatchTool, dispatchModel, dispatchedId,
} from './lib/tool'
import type { TodoModel, ToolState } from './lib/tool'
import { ctxFallbackFor, ctxCap, ctxPctVal } from './lib/ctxchip'
import { isHighRisk, quizCanSend, quizSummary } from './lib/perm'
import type { PermDecision, QuizQuestion } from './lib/perm'

// ── Feed 条目模型 ─────────────────────────────────────────────────────────
interface BaseItem { id: number }
/**
 * 用户气泡(queued=排队中,半透明 + 可取消)。
 * origin:壳层直发注入(card-inject)的来源 —— 'orch'=分片回流/编排闸,'system'=壳层系统提醒;
 * 空 = 用户本人说的话。这些注入必须走 submit 才能触发新回合(设计如此),但【不能长得像用户气泡】:
 * 主控卡里 N 条"分片 3/4 已完成"跟用户真插话右对齐挤在一起,谁说的话都分不出来(实测"交互乱"的视觉根因)。
 * shardId:该条回流属于哪一片 → 渲染成可点条目,直接跳该片镜像视图。
 */
export interface UserItem extends BaseItem { kind: 'user'; text: string; queued: boolean; origin?: 'orch' | 'system'; shardId?: string }
/** 分诊/提示行(非对话轮);retry=true 时带「重试本轮」按钮 */
export interface NoteItem extends BaseItem {
  kind: 'note'; text: string; muted: boolean; retry: boolean
  /** 一键继续要发出的【新消息】原文;有值就渲染「继续执行」钮。空=不渲染。
   *  与 retry 的区别很要命:retry 是把【上一条用户消息】原样重发 —— 模型会从头再做一遍;
   *  防停提醒要的是"接着上次停下的地方继续",必须是新消息(旧页 ui/card.html:1138 本来就是这个语义,Vue 平移时被降级成了 retry)。 */
  contMsg?: string
}
/** 思考块:每轮一个,答完不折叠不移除(open 保持);title 缺省「思考过程」,压缩续聊的接力摘要复用同壳;displayLen=打字机已吐字符数(可缺省=0) */
export interface ReasonItem extends BaseItem { kind: 'reason'; body: string; open: boolean; title?: string; displayLen?: number; full?: string }
/** AI 气泡:流式期 = segs(冻结段,只增) + tail(每帧重渲);收尾后 = finalHtml 全量一次;displayLen=打字机已吐字符数(快照→匀速吐的游标) */
export interface AiItem extends BaseItem {
  kind: 'ai'
  status: 'streaming' | 'done' | 'aborted' | 'error'
  segs: { id: number; html: string }[]
  frozenLen: number
  displayLen: number
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
  isTask?: boolean         // 委派工具(task/delegate_task):点块跳窗格(taskChild 或占位 ph:partID)
  shardId?: string         // run_workflow 派出的分片卡 id(从回执 "id=<n>" 抠出):点块跳该片镜像视图
  t0?: number              // 创建时刻(运行中起点;终态结算耗时 —— 设计稿 S2 工具行「做了什么、多久」)
  ms?: number              // 耗时毫秒(终态结算一次)
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

/** 编排面板投影(主进程 projectSnapshot 的形状;渲染端只读) */
export interface RunNodeView {
  id: string; title: string; kind: string; state: string
  attempt: number; patches: number; wave: number
  cardId: string | null; reason: string; droppedReason: string
  files: string[]; deps: string[]
  exitReport: { kind: string; detail: string }[]
}
export interface RunSnapshot {
  id: string; goal: string; phase: string; alias: string; wave: number
  counts: { total: number; verified: number; running: number; queued: number; pending: number; failed: number; skipped: number }
  budget: any
  nodes: RunNodeView[]
  decisions: { at: number; point: string; why: string; invalid: string }[]
  pendingDecision: { id: string; point: string; event: string; nodeId: string } | null
  ask: { question?: string; options?: string[] } | null
  result: { summary: string; deliverables: string[]; gaps: any[] }
  notes: { at: number; text: string }[]
}

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
  /** 权限模式:default=写/执行逐次确认;auto=全部自动放行(deny 红线兜底)。会话卡 TitleBar 可切(不再只藏设置页) */
  permMode: 'default' as 'default' | 'auto',
  /** 本卡选定的 Agent(空=serve 默认 build;OMO 的 sisyphus/plan 等经 TitleBar 切换,逐条消息带上) */
  agentName: '',
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
  /** 规划闸:true=方案已批(wf-plan-approved 已报主进程);planAsk=待批提示条可见;planAutoLeft=倒计时秒(0=无) */
  planApproved: false,
  planAsk: false,
  planAutoLeft: 0,
  /**
   * 已收官回合数。规划闸兜底判据用:
   * planAsk 的唯一来源是"嗅到 todowrite 且没嗅到 task/write-edit"(maybePlanGate),
   * 而主控卡的实质执行动作是 MCP 的 run_workflow —— 它【不在】wfExecSeen 的判据里(只认 task/delegate_task),
   * orch 卡还额外豁免 write/edit。于是主控若不调 todowrite:planAsk 永假 → 批准条永不渲染 →
   * planApproved 永假 → 壳层把每一次派发都拒掉,回执还叫用户"去主控卡点【开始执行】"——那个按钮从没存在过。
   * 兜底:跑过回合、没批准、也没挂出待批条时,给用户一个永远点得到的批准入口。
   * 注意【不能】改成"把 run_workflow 也算实质执行"—— maybePlanGate 命中 wfExecSeen 会【自动撤闸】,
   * 那是把静默死锁换成"人审闸被静默取消",更糟。
   */
  turnsDone: 0,
  /** 自动批准(仅 wf 卡,用户显式开启):权限请求自动放行 once 并留痕;关卡即失效 */
  wfAutoAllow: false,
  /** 主控卡分片进度(shard-progress 推送):{id, goal, status, round};shardView=就地渲染某片的镜像会话(''=主区域) */
  shards: [] as { id: string; goal: string; status: string; round: number }[],
  shardView: '',
  /**
   * 编排面板(新引擎):主进程 run-snapshot 推来的【只读投影】。
   * 它在场 = 这张卡不是对话卡而是编排面板 —— 没有回合、没有 busy、没有工具流,
   * 所以整套按"这是一张会话卡"写的 harness(规划闸嗅探/看门狗/空答重试/挂死探针/主动交棒)一律不挂载。
   * 唯一真相源在主进程,这里永远只读:批准/插话/中止都是 IPC 显式转移,不回写本地。
   */
  run: null as RunSnapshot | null,
  runId: '',
  /** 主动交棒计数(knobs.autoCompactMax 顶) */
  autoCompactN: 0,
  /** 状态行(P2c harness):忙时实时显示【正在跑什么 + Esc 中断】;aborting=已按 Esc 等引擎收尾 */
  runAct: '思考中',
  aborting: false,
  /** 看门狗第二级横幅(绕圈提醒后仍不纠偏):带【中止本轮/知道了】,判死权给人 */
  wdBanner: false,
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
  /** 标题已被用户手改 → 首轮自动命名不再覆盖(尊重手改) */
  titleCustomized: false,
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

// ── 工具连排归组(展示层):连续 tool 条目 ≥2 折成一条「组合条」(N 次调用 · 名×次数 · 当前/出错/完成),
// 点开才看逐条记录 —— 一排细条刷屏曾把对话流挤得没辨识度(用户实测"缩到一块");单条工具仍原地渲染(task 跳转 affordance 保留)。
export interface ToolGrp { kind: 'toolgrp'; id: string; tools: ToolItem[] }
export const visibleGroups = computed<(FeedItem | ToolGrp)[]>(() => {
  const out: (FeedItem | ToolGrp)[] = []
  let cur: ToolItem[] = []
  const flush = () => {
    if (cur.length >= 2) out.push({ kind: 'toolgrp', id: 'tg:' + (cur[0].partID || cur[0].id), tools: cur })
    else if (cur.length === 1) out.push(cur[0])
    cur = []
  }
  for (const it of visibleItems.value) {
    // 分片派发块【不进工具组】:归组是为了把琐碎工具流水折成一行,但派发是这条编排的骨架 ——
    // 主控派 4 片时全被折进「4 次工具调用 · 派发分片 ×4」,默认收起,派了哪几片、去了哪张卡一眼看不见(实测)。
    // 每片单独成行,名/目标/#id 直接可见可点。
    if (it.kind === 'tool' && (it as ToolItem).shardId) { flush(); out.push(it); continue }
    if (it.kind === 'tool') { cur.push(it as ToolItem); continue }
    flush(); out.push(it)
  }
  flush()
  return out
})

/** 待批准权限(feed 里的 perm 条;sticky 摘要钉 = 首个工具名 + 总数,对齐旧页 pendingPerms) */
export const pendingPerms = computed(() => s.items.filter((i): i is PermItem => i.kind === 'perm'))

// ── 会话内非响应式运行时态 ────────────────────────────────────────────────
const meter = new CtxMeter()
const queue: QueueEntry[] = []
let lastSend: { text: string; files: any[] | null } | null = null
let draftKey = ''
let cardId = ''   // 本卡 id(boot 从 URL 取):滚动 session memory 落盘键(compactLogLast/compactLogAppend)
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
// ── ReAct 时序思考块(2026-07-29 评审):思考与工具按到达顺序穿插渲染(思考→工具→思考),不再全程聚成一块 ——
// 一块一 reasoning partID,首次到达即插在答案气泡前(与工具同 insertBeforeAnswer 通道,天然按时序);
// 正文中内联的 <think> 归 '_' 块。打字机平滑逐块推进(twTick)。
const reasonItems = new Map<string, ReasonItem>()
function ensureReasonFor(key: string): ReasonItem {
  let r = reasonItems.get(key)
  if (!r) {
    r = insertBeforeAnswer<ReasonItem>({ id: nextId(), kind: 'reason', body: '', full: '', open: true, displayLen: 0 })
    if (reasonItems.size > 200) reasonItems.clear()   // 防御无界(清掉只影响后续原地更新)
    reasonItems.set(key, r)
  }
  return r
}
let answerParts = new Map<string, string>()
let reasonParts = new Map<string, string>()
// target 轮(命令块「运行」,P2b):回答渲染进命令块下的输出区 DOM,不进 feed(旧页 turn(text, target) 平移)
let targetParts: Map<string, string> | null = null
let targetEl: HTMLElement | null = null
let targetFlushQueued = false

// ── 条目构造 ──────────────────────────────────────────────────────────────
// ⚠ 响应式铁律:工作引用一律用「数组里的代理」,不能用 push 前的原始对象 ——
// 改原始对象不触发依赖(实测:流式期间 curAnswer 裸引用导致视图整体不刷新)。
export function addUser(text: string, meta?: { origin?: 'orch' | 'system'; shardId?: string }): UserItem {
  const it: UserItem = { id: nextId(), kind: 'user', text, queued: false }
  if (meta?.origin) it.origin = meta.origin
  if (meta?.shardId) it.shardId = meta.shardId
  s.items.push(it); return s.items[s.items.length - 1] as UserItem
}
export function addNote(text: string, opts?: { muted?: boolean; retry?: boolean; contMsg?: string }): NoteItem {
  const it: NoteItem = { id: nextId(), kind: 'note', text, muted: opts?.muted !== false, retry: !!opts?.retry, contMsg: opts?.contMsg }
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
    segs: [], frozenLen: 0, displayLen: 0, tail: '', finalHtml: '', raw: '', plainText: '',
    retryText: '', retryFiles: null,
  }
  s.items.push(it); return s.items[s.items.length - 1] as AiItem
}
function finalizeReasonItems(thinkTail: string): void {
  // 回合收尾:每块补全到全量(打字机已停);内联 <think> 归 '_' 块(首访才建,不抢既有块的位)
  if (thinkTail) { const ri = ensureReasonFor('_'); ri.full = [ri.full, thinkTail].filter(Boolean).join('\n') }
  for (const [k, ri] of reasonItems) {
    if (k !== '_') ri.full = reasonParts.get(k) || ri.full || ''
    ri.body = ri.full || ''
    ri.displayLen = ri.body.length
    ri.open = true
  }
}

// ── 流式增量渲染(防 O(n²):冻结段只增,尾巴每帧重渲) + 打字机平滑 ──────────────
// 数据侧是快照流(1.2s 轮询 / SSE 增量 / POST 一次性返回),直接渲会"一坨一坨跳"。
// 这里加匀速缓冲:快照只记账(displayLen 游标),40ms 一拍按 backlog/4(≥2 字符)匀速吐出 ——
// 任何来源看起来都是连续打字;思考块同款平滑。用 setTimeout 不用 rAF:隐藏分片卡 rAF 会冻结。
const TW_MS = 40
let twTimer: ReturnType<typeof setTimeout> | null = null
function twStop(): void { if (twTimer) { clearTimeout(twTimer); twTimer = null } }
function twTick(): void {
  twTimer = null
  const ai = curAnswer
  if (!ai) return
  const st = splitThink(joinParts(answerParts))
  const full = st.rest
  // 思考块平滑(ReAct 时序):逐块匀速推进 displayLen —— 每个 reasoning partID 一块,与工具块按到达顺序穿插
  let reasonCaughtUp = true
  if (st.think) { const ri = ensureReasonFor('_'); ri.full = st.think }   // 正文内联 <think> 兜底
  for (const [k, ri] of reasonItems) {
    if (k !== '_') ri.full = reasonParts.get(k) || ri.full || ''
    const f = ri.full || ''
    if (!f) continue
    const rd = ri.displayLen || 0
    if (rd < f.length) {
      ri.displayLen = Math.min(f.length, rd + Math.max(2, Math.ceil((f.length - rd) / 4)))
      reasonCaughtUp = false
    }
    ri.body = f.slice(0, ri.displayLen)
    ri.open = true
  }
  // 正文平滑:先推进游标,再把"已吐前缀"走 planIncremental(冻结段只增+尾巴重渲)
  if (ai.displayLen < full.length) {
    ai.displayLen = Math.min(full.length, ai.displayLen + Math.max(2, Math.ceil((full.length - ai.displayLen) / 4)))
    const dispRest = full.slice(0, ai.displayLen)
    if (dispRest) {
      const plan = planIncremental(dispRest, ai.frozenLen)
      if (plan.reset) {
        ai.segs = []; ai.frozenLen = 0; ai.tail = dispRest
      } else {
        if (plan.newSeg) {
          // 分隔线跨段去重:冻结段各自独立渲染(每段一次 renderMarkdown),连发 --- 被切成多段时
          // 每段都出一条 <hr> 叠成一摞(实测);新段是纯 <hr> 且上一段也是 → 跳过
          const html = renderMarkdown(plan.newSeg)
          const lastIsHr = ai.segs.length > 0 && ai.segs[ai.segs.length - 1].html === '<hr>'
          if (!(html === '<hr>' && lastIsHr)) ai.segs.push({ id: nextId(), html })
          ai.frozenLen = plan.cut
        }
        ai.tail = plan.tail
      }
    }
  }
  if (ai.displayLen < full.length || !reasonCaughtUp) twTimer = setTimeout(twTick, TW_MS)
}
function scheduleFlush(): void {
  if (!twTimer) twTimer = setTimeout(twTick, TW_MS)
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

/** 权限模式开关(TitleBar chip):default ↔ auto;【按会话】一卡一开关(主进程按 wcId 存),下一条权限请求起用新档 */
export function togglePermMode(): void {
  s.permMode = s.permMode === 'auto' ? 'default' : 'auto'
  try { BH()?.cardPermModeSet?.(s.permMode) } catch { /* 静默 */ }
  addNote(s.permMode === 'auto'
    ? '本会话已切到【自动放行】：写文件/执行命令不再弹框（deny 红线仍兜底、edit 预检仍生效、每次放行记审计）；只影响本卡，别的会话不受影响'
    : '本会话已切回【逐次确认】：写文件/执行命令会弹框等你批准', { muted: true })
}

// ── 主进程流事件(渲染端不碰 SSE,协议不变) ────────────────────────────────
let streamWired = false
// hang 探针判活按内容签名:轮询通道会把同内容快照反复重发,同内容不算活(分片/主控 300s 长牙的判据)
// ★签名要【按 partID 各记一份】,不能用一个标量跟"上一个事件"比。
//   主进程 pollTurnParts 每 1.2s 把本轮全部 part 原样重喂一遍(session.js feedParts),事件序列成了 A,B,A,B…;
//   标量版每次都跟上一个事件比,A 和 B 天然不同 → 判"有新内容" → lastStreamAt 被无限续命。
//   于是回合只要产出过 ≥2 个 part(一段思考 + 一个工具就够),90s / 5min 提示【永不触发】—— 正好是它要治的那个场景:
//   用户对着"思考中"干等到手动 Esc,一句提示都等不到。
//   主进程侧同一病灶早就用 per-partID 的 si.partSigs 修掉了(session.js:685-706,注释写得很清楚),这边只抄了一半。
const lastStreamSig = new Map<string, string>()
function streamSig(ev: StreamEvent): string {
  const t = String(ev.text || ''), o = ev.output == null ? '' : String(ev.output)
  return [ev.kind, ev.partID, ev.status, t.length + ':' + t.slice(-64), o.length + ':' + o.slice(-32), ev.title, ev.shardRoot, ev.agentId].join('|')
}
/** 挂死探针打点:这条事件带来新内容才算"活"。返回是否续了命(导出供回归测试直接打点,不必去碰 setInterval) */
export function markStreamLive(ev: StreamEvent): boolean {
  const key = String(ev.partID || '_'), sig = streamSig(ev)
  if (lastStreamSig.get(key) === sig) return false   // 轮询原样重喂:同 part 同内容,不续命
  if (lastStreamSig.size > 500) lastStreamSig.clear()   // 防长跑膨胀(清空代价只是多刷一次计时,无害;与主进程 partSigs 同款)
  lastStreamSig.set(key, sig)
  lastStreamAt = Date.now()
  return true
}
export function wireStream(): void {
  if (streamWired) return
  streamWired = true
  try {
    BH()?.onStream?.((ev: StreamEvent) => {
      // 多层派发分片回流(shardRoot):只进分片专属缓冲(分片视图用),主控的侧边栏/对话流不沾。
      // 【必须先于挂死探针打点】—— 分片的回流事件不是主控自己的活口:主控回合撞上网关静默时,
      // 名下几片还在哗哗刷屏,原来会把 lastStreamAt 一直续命,主控这一轮就永远等不到 90s/5min 长牙(实测停摆无感知)。
      if (ev.shardRoot) { upsertShardMirror(ev); return }
      markStreamLive(ev)   // 静默挂死探针:按 partID 比签名,有新内容才算活(90s/5min 的打点)
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
        ensureReasonFor(key)   // ReAct 时序:新思考 part 立即占位成块(与工具块按到达顺序穿插,不再全程聚一块)
        scheduleFlush()
      } else {
        answerParts.set(key, String(ev.text || ''))
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
// ── harness(P2c,旧页 1061-1300 平移):看门狗/委派驱动/防停/产出兜底/hang 探针/状态行 ──
function knobNum(key: string, dflt: number): number {
  try {
    const k = ((BH()?.getSettings?.() || {}) as any).knobs
    const v = k && +k[key]
    return Number.isFinite(v) ? v : dflt
  } catch { return dflt }
}
// 状态行:运行中的工具登记(partID → 摘要;完成/出错注销),StatusLine 组件按秒针读 s.runAct
const runningTools = new Map<string, string>()
function paintRunAct(): void {
  if (!runningTools.size) { s.runAct = '思考中'; return }
  const last = [...runningTools.values()].pop() || '思考中'
  s.runAct = last + (runningTools.size > 1 ? '（共 ' + runningTools.size + ' 个工具在跑）' : '')
}
// hang 探针:新内容事件打点(同内容重发不算,见 streamSig);忙碌期 15s 一拍 —— 90s 无输出提示,5min 升级
// 分片/主控无人值守卡 5min 长牙:提示没人点,直接自动中断本轮(壳层按 aborted 判 interrupted 收官);可见卡维持只提示不代劳
let lastStreamAt = 0, hangNag90 = false, hangNag300 = false
setInterval(() => {
  if (!s.busy || !lastStreamAt) return
  const sil = Date.now() - lastStreamAt
  if (sil >= 300000 && !hangNag300) {
    hangNag300 = true
    // ★这里【只提示,不代劳】。无人值守卡(分片/主控)的自动中断归主进程:src/session.js 的挂死看门狗
    //   按 si.lastEventAt 判 300s 静默后 oc.abort,它那边的注释也写明了分工("可见工作流卡有人看着…不代劳")。
    //   渲染端原来也自己 cardAbort 一次 —— 同一件事两份账本。以前因为上面的签名 bug 这支从来没真跑过,
    //   签名修好后它就会和主进程看门狗对撞(两边都到 300s,渲染端 15s 一拍先到,主进程 45s 一拍再补一刀)。
    //   撤掉这份,留主进程那份:它拿的是 SSE 一手状态,而且不依赖卡片页还活着。
    addNote(s.shardMode || s.orchMode
      ? '⚠ 已 5 分钟没有任何新输出 —— 无人值守卡,壳层看门狗会自动中断本轮并交回主控重派'
      : '⚠ 已 5 分钟没有任何输出 —— 大概率是网关挂死(不是慢)。建议按 Esc 中断后点「重试本轮」')
  }
  else if (sil >= 90000 && !hangNag90) { hangNag90 = true; addNote('模型已 90 秒没有输出 —— 可能在长考,也可能是网关挂死。可继续等,或按 Esc 中断') }
}, 15000)
// 看门狗(仅 wf 卡):最近连续 N 轮读文件集合高度重合(∩/∪≥阈值)且 todo 无勾选进展 → 注入绕圈提醒;
// 提醒后再绕 M 轮 → 醒目横幅+【中止】(判死权给人);分片无人值守 → 自动中止(横幅没人点)。
const WD_READ = /^(read|grep|glob|ls|find|tree|list|search)(_[a-z]+)*$/i
let wdCurFiles = new Set<string>()
const wdRounds: { turn: number; files: Set<string> }[] = []
let wdWarned = false, wdEscLoops = 0
let wdWarnSet: Set<string> | null = null, wdWarnTurn = -1
let wfTodoDoneTurn = -1, wfTodoLastTurn = -1
// 委派驱动/防停/产出兜底运行时态
let delegatedSeen = false, delegateNudged = false
let contNudgeN = 0, contLastOpen = -1, contNudgeOff = false   // contNudgeOff:熔断粘性标志(只有真有进展才复活),见 maybeContinueNudge
let wfProduceNag = false
let latestOpenTodos: string[] = [], latestTodoTotal = 0
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
  // 状态行登记:运行中登记(工具名:标题),终态注销(Claude Code 式"正在跑什么")
  {
    const label = toolLabel(name) + (ev.title ? ' ' + String(ev.title).slice(0, 40) : '')
    if (st === 'running') runningTools.set(partID, label)
    else runningTools.delete(partID)
    paintRunAct()
  }
  // 委派驱动探针:派过子 Agent 就不再催
  if (/^(task|delegate_task)$/i.test(name)) delegatedSeen = true
  // 看门狗记账:本轮主 Agent 读文件类工具的目标集合(绕圈判据的原料;子 Agent 隔离上下文不记)
  if (WD_READ.test(name)) {
    try {
      const inp = asObj(ev.input)
      const tgt = inp && (inp.filePath || inp.path || inp.file || inp.pattern || inp.query || inp.command || inp.cmd)
      if (tgt) wdCurFiles.add(name.toLowerCase() + ':' + String(tgt).toLowerCase())
    } catch { /* 静默 */ }
  }
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
      open: s.verbose, isWf: /^run_workflow$/i.test(name), askNoted: false, t0: Date.now(),
    })
    if (toolItems.size > 500) toolItems.clear()   // 防御:长跑会话 Map 无界(清掉只影响后续原地更新,重建不丢终态)
    toolItems.set(partID, it)
  }
  it.status = String(ev.status || '')
  it.state = st
  if (st !== 'running' && !it.ms && it.t0) it.ms = Date.now() - it.t0   // 耗时:首个终态事件结算一次
  if (ev.title) it.title = String(ev.title).slice(0, 120)
  const inFull = fmtInput(ev.input)
  if (inFull) { const t = truncIn(inFull); it.inStr = t.text + (t.tip ? '\n' + t.tip : '') }
  const outFull = fmtOutput(ev)
  if (outFull) { const t2 = truncOut(outFull); it.outStr = t2.text + (t2.tip ? '\n' + t2.tip : '') }
  it.hasErr = !!ev.error
  it.summary = toolSummary(it.status, outFull)
  // 分片派发块可辨识 + 可跳转:N 条派发原本全叫「升格 → 动态工作流」,归组后只剩一行「4 次工具调用 · 升格 ×4」,
  // 派了哪几片、去了哪张卡一概看不见(用户实测的头号困惑)。改成 名=派发分片 / 标题=该片目标 / 点块跳该片镜像视图。
  if (isDispatchTool(name)) {
    const dm = dispatchModel(ev.input)
    if (dm) {
      if (dm.shard) it.name = '派发分片'
      it.title = dm.goal.slice(0, 120)
    }
    const sid = dispatchedId(outFull)
    if (sid) it.shardId = sid
  }
  // ask/elicit 无应答通道:兜底提示一块卡只挂一次(对齐旧页)
  if (isAskTool(name) && !it.askNoted) { it.askNoted = true; addNote('模型发起了提问,但这个工具没有应答通道 —— 请直接在输入框回复它的问题') }
  // 委派工具(task/delegate_task):记 taskChild(点工具块跳子 Agent 窗格);终态勾掉对应子 Agent。
  // 子等会话 id 提不到(serve 形状各异,实测)→ 立刻建占位条目:侧边栏必须有得看,不能空等(用户实测"点不进去看")
  if (/^(task|delegate_task)$/i.test(name)) {
    it.isTask = true   // 委派工具:点块跳子 Agent 窗格(taskChild 或占位 ph:partID)
    if (ev.taskChild) it.taskChild = String(ev.taskChild)   // 只在非空时覆写:轮询通道恒空串,会把 SSE 带来的真 id 擦掉
    if (st !== 'running') {
      if (it.taskChild) {
        adoptPlaceholder('ph:' + partID, it.taskChild)   // 终态配对 taskChild 优先:本 task 的占位改嫁真 id(FIFO 领养仅作兜底的另一路)
        subAgentDone(it.taskChild, st === 'err', String(ev.taskDesc || ''))
      } else {
        const ph = subAgent('ph:' + partID, String(ev.taskDesc || ev.title || '子任务'))
        subAgentDone(ph.id, st === 'err')
      }
    } else if (!it.taskChild) {
      subAgent('ph:' + partID, String(ev.taskDesc || ev.title || '子任务'))   // 运行中且无真 id:先建占位,侧边栏不能空等(用户实测"点不进去看")
    }
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
    wfTodoLastTurn = turnN   // todo 提醒兜底:最近更新轮次(连着 N 轮没动 → 下条消息尾附提醒)
    if (model.doneN > 0) { if (!s.orchMode) wfExecSeen = true; wfTodoDoneTurn = turnN }   // 看门狗判进展也用这个
    // 防停/委派驱动原料:最近一次 todo 的未完项与总数
    try {
      const obj = asObj(ev.input)
      const ts = obj && Array.isArray(obj.todos) ? obj.todos : []
      latestOpenTodos = ts.filter((t: any) => !/complet|cancel/i.test(String(t && t.status || ''))).map((t: any) => String((t && (t.content || t.text || t.title)) || '')).filter(Boolean)
      latestTodoTotal = ts.length
    } catch { /* 静默 */ }
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
/** 占位改嫁真身:task 终态带来真子会话 id 时,把本 task 的占位(ph:partID)配对给它 —— 终态配对 taskChild 优先,FIFO 仅兜底 */
function adoptPlaceholder(phId: string, realId: string): void {
  if (subIdx.has(realId)) return
  const ph = subIdx.get(phId)
  if (!ph || !ph.id.startsWith('ph:')) return
  subIdx.set(realId, ph)   // 旧 ph key 留在 subIdx 当别名:task 块的 subJump('ph:partID') 不失效
  if (s.subActiveId === ph.id) s.subActiveId = realId
  ph.id = realId
}
function subAgent(id: string, name?: string): SubAgent {
  const hit = subIdx.get(id)
  if (hit) { if (name && name !== '子agent') hit.name = name; return hit }
  // 真身领养占位(兜底):子等会话 id 经 sub 事件先到、task 终态没带 taskChild 时 ——
  // 最老的占位改嫁成真身(同 turn 内派出顺序一致,FIFO 配对);两个同名子会话各是各,不做同名归并(归并会把第二个的活动并丢)
  if (!id.startsWith('ph:')) {
    const ph = s.subAgents.find((a) => a.id.startsWith('ph:'))
    if (ph) {
      const oldId = ph.id
      subIdx.set(id, ph)
      if (name && name !== '子agent') ph.name = name
      if (s.subActiveId === oldId) s.subActiveId = id
      ph.id = id
      return ph
    }
  }
  const a: SubAgent = {
    id, name: name || '子agent', count: 0, reads: 0, t0: Date.now(), doneAt: 0, done: false, err: false,
    tools: [], toolIdx: new Map(), reasonParts: new Map(), outParts: new Map(), reason: '', outHtml: '',
  }
  s.subAgents.push(a)
  const proxy = s.subAgents[s.subAgents.length - 1]   // 响应式铁律:索引存数组里的代理 —— 存原对象改属性不触发更新(实测:subAgentDone 勾不掉)
  subIdx.set(id, proxy)
  s.subActiveId = proxy.id                 // 新子 Agent 自动成为当前窗格
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
        state: 'running', inStr: '', outStr: '', hasErr: false, summary: '', open: s.verbose, isWf: false, askNoted: false, t0: Date.now(),
      }
      a.tools.push(t)
      const proxy = a.tools[a.tools.length - 1]
      if (partID) a.toolIdx.set(partID, proxy)
      t = proxy
    }
    t.status = String(ev.status || '')
    t.state = toolState(t.status)
    if (t.state !== 'running' && !t.ms && t.t0) t.ms = Date.now() - t.t0
    if (ev.title) t.title = String(ev.title).slice(0, 120)
    const inFull = fmtInput(ev.input)
    if (inFull) { const x = truncIn(inFull); t.inStr = x.text + (x.tip ? '\n' + x.tip : '') }
    const outFull = fmtOutput(ev)
    if (outFull) { const x2 = truncOut(outFull); t.outStr = x2.text + (x2.tip ? '\n' + x2.tip : '') }
    t.hasErr = !!ev.error
    t.summary = toolSummary(t.status, outFull)
    if (t.state === 'err') a.err = true
    // 孙会话:子 Agent 又派 task(嵌套),终态联动勾掉孙 Agent —— 此前嵌套 task 永不 done(计时永不封顶的又一来源)
    if (/^(task|delegate_task)$/i.test(String(ev.text || '')) && t.state !== 'running' && ev.taskChild) subAgentDone(String(ev.taskChild), t.state === 'err')
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
// 完成态权威轮询(旧页 saTick 平移,SubAgentRail 的 1s tick 驱动):serve 的 task 完成事件缺 taskChild 时配对不上,
// 子 Agent 一直"运行中"、计时永不封顶(实测)—— 每 5s 对未 done 的真身条目按子会话消息判完成,兜底配对失败的全部情形
let saPollAt = 0, saPolling = false
export function pollSubStatus(): void {
  if (saPolling || Date.now() - saPollAt < 5000) return
  const fn = BH()?.subStatus
  if (typeof fn !== 'function') return
  const ids = s.subAgents.filter((a) => !a.done && !a.id.startsWith('ph:') && a.id !== '_').map((a) => a.id)
  saPollAt = Date.now()
  if (!ids.length) return
  saPolling = true
  Promise.resolve(fn(ids)).then((st: any) => {
    try { for (const [id, fin] of Object.entries(st || {})) { if (fin) subAgentDone(id, false) } } catch { /* 静默 */ }
  }).catch(() => { /* 静默 */ }).finally(() => { saPolling = false })
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
  const items = [...new Set(subIdx.values())].map((a) => ({   // Set 去重:占位改嫁真身后 subIdx 留了 ph 别名,同一本体两个键
    name: a.name, count: a.count, ms: Math.max(0, (a.done ? a.doneAt : Date.now()) - a.t0), err: a.err, reads: a.reads,
  }))
  saSnaps.push({ round: turnN, items })
  if (saSnaps.length > SA_SNAP_MAX) saSnaps.shift()
}
export function subSnapList(): SubSnap[] { return saSnaps }

// ── 分片回流镜像(P2b-3 分片视图的数据层;点进度卡细看某片时渲染) ──
// shardRoot → Map<partID, 事件快照>;只写缓冲+置脏标记(旧页 card.html 731-744 平移),150ms 合帧 bump 版本号让 computed 重算 ——
// 普通 Map 不触发响应式,不 bump 的话打开分片视图后新事件不重渲染、视图定格(实测回归)
export interface ShardMirrorItem { partID?: string; kind?: string; text?: string; status?: string; input?: any; output?: any; title?: string; error?: any; sub?: boolean; agentName?: string; shardRoot?: string }
const shardStreams = new Map<string, Map<string, ShardMirrorItem>>()
/** 镜像缓冲版本号:分片视图 computed 读它建立依赖(脏标记合帧驱动) */
export const shardVersion = ref(0)
let shardDirty = false
setInterval(() => { if (shardDirty) { shardDirty = false; shardVersion.value++ } }, 150)
function upsertShardMirror(ev: ShardMirrorItem): void {
  const root = String(ev.shardRoot || ''); if (!root) return
  let m = shardStreams.get(root); if (!m) { m = new Map(); shardStreams.set(root, m) }
  m.set(ev.partID || ((ev.kind || 'x') + '_' + m.size), ev)
  shardDirty = true
  // 分片 write/edit 落盘 → 主控卡成果抽屉(8 片文档+索引都在磁盘,抽屉不能显示"无")
  try {
    if (ev.kind === 'tool' && /complet|success|done/i.test(String(ev.status || '')) && !ev.error && isWriteEditTool(ev.text)) {
      const fp = artAbs(extractFilePath(ev.input), s.dir)
      if (fp && !artFileSeen.has(fp)) { artFileSeen.add(fp); s.artFiles.push(fp) }
    }
  } catch { /* 静默 */ }
}
/** 分片 chip 变 done/interrupted → 该片缓冲截尾(末 50 条、单条 output 截 4k):终态分片不再增量,防长跑主控内存无界 */
function trimShardBuffer(root: string): void {
  const m = shardStreams.get(root); if (!m) return
  const keep = [...m.entries()].slice(-50)
  m.clear()
  for (const [k, v] of keep) {
    if (v && typeof v.output === 'string' && v.output.length > 4096) v.output = v.output.slice(0, 4096) + '\n…(截尾)'
    m.set(k, v)
  }
  shardDirty = true
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
  clearPlanTimers()   // 撤条必清倒计时(泄漏/二次注入防线)
  lastStreamAt = Date.now(); lastStreamSig.clear(); hangNag90 = hangNag300 = false   // hang 探针复位(新一轮重新计)
  if (!ctxLimitReal) refreshCtxLimit()   // 上限还没拿到真值(serve 晚起/列表为空):每个回合补刷,防开卡终身吃兜底
  s.aborting = false
  runningTools.clear(); paintRunAct()   // 状态行:新一轮从"思考中"起
  const ai = addAi()
  curAnswer = ai
  answerParts = new Map(); reasonParts = new Map(); reasonItems.clear()
  twStop()   // 新一轮:打字机游标随新 AiItem 归零(displayLen 在 addAi 初始化),旧 ticker 停掉
  s.busy = true; s.done = false
  lastSend = { text, files: files || null }
  if (draftKey) draftClear(localStorage, draftKey)   // 草稿发送即清
  meter.bump((text || '').length); s.ctxUsedChars = meter.usedChars
  let ok = true, gotText = false
  try {
    const reply = await BH()!.cardSend(text, files || [], s.activeSkill ? s.activeSkill.id : null)   // 挂载技能(作答方法论预置,对齐旧页 submit 第三参)
    twStop()   // 末帧:停打字机 ticker(终态由 finalHtml 全量接管;思考块逐块补全)
    const raw = reply || joinParts(answerParts)
    const st = splitThink(raw)
    finalizeReasonItems(st.think)
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
    finalizeReasonItems(pst.think)
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
    twStop()   // 回合收尾:停打字机 ticker(终态已用 finalHtml 全量渲染,游标不再推进)
    curAnswer = null; reasonItems.clear()
    s.busy = false
    if (ok) { s.done = true; maybeAutoTitle() }   // 首轮成功 → 默认名自动换成首条消息前 24 字
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
    s.turnsDone++       // 已收官回合数(WfBar 的规划闸兜底判据用:主控跑过回合却始终没挂出批准条 = 闸死了)
    maybePlanGate()     // 规划闸:方案出了没执行 → 待批提示(分片卡静默自动批)
    // ── harness 轮末链(旧页同序):看门狗结算+判定 → 委派驱动 → 防停 → 产出兜底 → 普通卡水位提醒 → 主动交棒 ──
    wdFinalizeRound()
    wdCheck()
    maybeDelegateNudge()
    maybeContinueNudge()
    maybeWfProduceNag()
    maybeCtxNag()
    maybeAutoCompact()  // wf 主动交棒:水位达标写交接单换下一棒
    drain()
  }
  return ok
}

/** 中断本轮(Esc / 发送钮变停止钮) */
export function abort(): void {
  s.aborting = true   // 状态行:「正在停止…(等引擎收尾)」
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
export function submit(
  text: string,
  atts: { kind: string; name: string; path?: string; mime?: string; dataUrl?: string }[],
  disp?: string,
  meta?: { origin?: 'orch' | 'system'; shardId?: string },
): void {
  const v = text.trim()
  if (!v && !atts.length) return
  const docRefs = atts.filter((a) => a.kind === 'doc').map((a) => '- ' + a.path + '（' + a.name + '）').join('\n')
  const docNote = docRefs ? '【用户拖入了文档，需要时用 read_document 工具读取其内容】\n' + docRefs : ''
  const images = atts.filter((a) => a.kind === 'image').map((a) => ({ mime: a.mime, url: a.dataUrl, filename: a.name }))
  let full = [docNote, v].filter(Boolean).join('\n\n')
  // todo 提醒兜底(wf 卡,knobs.todoNudgeRounds 默认 3):连着 N 轮没动 todo 且还有未完项 →
  // 本条消息尾部附一行提醒(对齐 Claude Code harness 的 task 提醒;只随消息进 serve,气泡不显示)
  if (s.wfMode && latestOpenTodos.length && turnN - wfTodoLastTurn >= knobNum('todoNudgeRounds', 3)) {
    full += '\n(系统提醒:todo 清单已多轮未更新,还有 ' + latestOpenTodos.length + ' 项未完成:「' + latestOpenTodos.slice(0, 3).join('、') + '」—— 请先用 todowrite 如实更新各项状态,再继续推进。)'
  }
  const dispText = disp || (v || (images.length ? '(图片)' : '(文档)')) + (atts.length ? ' · 附件 ' + atts.length : '')   // card-inject:用户气泡看 disp,引擎收全文
  const el = addUser(dispText, meta)
  if (s.busy || !s.ready || compacting) {   // compacting 期间一律入队:摘要轮/交棒 reinit 窗口不开新轮(compacting 闸,旧页平移)
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

/** 轮末 drain:就绪且闲且有队 → 出一条转正发出;compacting 期间不开轮(摘要轮/交棒窗口) */
function drain(): void {
  if (compacting) return
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

// ── 系统灰字条(card-note:注入背景/拦停/多模态切换等过程提示) ───────────────
let noteWired = false
export function wireCardNote(): void {
  if (noteWired) return
  noteWired = true
  try {
    BH()?.onCardNote?.((p: any) => {
      if (!p || !p.text) return
      addNote(String(p.text))
      // 首条注入背景(记忆/项目背景/知识,常有几 KB)也计入 ctx 估算 —— 以前只算用户可见部分,估算系统性偏低
      const m = String(p.text).match(/已随首条消息注入背景.*?（(\d+) 字）/)
      if (m) { meter.bump(+m[1] || 0); s.ctxUsedChars = meter.usedChars }
    })
  } catch { /* 静默 */ }
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
// 超时自动开跑(knobs.approvalTimeoutMin,分钟;默认 0=永不 —— 产品拍板的保守默认):
// 倒计时双计时器(点火+秒级刷新文案),撤闸/新轮/手动批/取消必须两个都清 —— 防泄漏,更防闸死后二次注入。
let planAutoTimer: ReturnType<typeof setTimeout> | null = null
let planAutoTick: ReturnType<typeof setInterval> | null = null
function clearPlanTimers(): void {
  if (planAutoTimer) { clearTimeout(planAutoTimer); planAutoTimer = null }
  if (planAutoTick) { clearInterval(planAutoTick); planAutoTick = null }
  s.planAutoLeft = 0
}
/** 取消倒计时自动批准(只拆引信,闸本身还在,仍可手动批) */
export function cancelPlanAuto(): void {
  clearPlanTimers()
  addNote('已取消自动开跑 —— 计划仍待批准,手动点【批准方案 → 改】或输入调整意见')
}
function armPlanAuto(): void {
  clearPlanTimers()
  const min = knobNum('approvalTimeoutMin', 0)
  if (min <= 0) return
  const endAt = Date.now() + min * 60000
  const paint = () => { s.planAutoLeft = Math.max(0, Math.round((endAt - Date.now()) / 1000)) }
  paint()
  planAutoTick = setInterval(paint, 1000)
  planAutoTimer = setTimeout(() => { clearPlanTimers(); approvePlan(true) }, min * 60000)
}
function maybePlanGate(): void {
  if (s.runId) return   // 编排面板:批准是主进程的显式 phase,不走"嗅 todowrite"这条推断链
  if (!(s.wfMode || s.orchMode) || s.planApproved) return
  if (s.shardMode) { approvePlan(true); return }   // 分片卡:拆分方案主控卡已批,静默自动开跑
  if (wfSawTodo && !wfExecSeen) { if (!s.planAsk) { s.planAsk = true; armPlanAuto() } return }
  // 模型已实质执行(没守"首轮只规划")→ 闸没意义:撤闸并注入继续指令(只埋闸不吭声会让守规矩等批准的模型软死锁,实测)
  if (wfExecSeen) {
    // 撤闸和"已通知它继续"必须同进同出:planApproved 一旦置真,下个轮末会在上面第二行就 return,这段再也不会走第二次。
    // 所以闸没过时【什么都不做】,整体推迟到下一个干净轮末 —— 否则就是闸撤了、通知没发出去,模型继续干等批准(软死锁)。
    if (!canInject()) return
    s.planApproved = true; s.planAsk = false; clearPlanTimers()
    try { BH()?.wfPlanApproved?.() } catch { /* 静默 */ }
    addNote('模型已开始实质执行 —— 计划批准闸已自动跳过(已通知它继续,不用等批准)')
    injectTurn('(系统提醒:你已提前开始实质执行,计划批准闸已自动跳过 —— 不用等批准,请继续按当前计划执行直至总目标完成;执行中保持 todo 勾选可见。)')
  }
}
export function approvePlan(auto?: boolean): void {
  if (s.planApproved) return
  s.planApproved = true; s.planAsk = false; clearPlanTimers()
  try { BH()?.wfPlanApproved?.() } catch { /* 静默 */ }   // relay 层放行 run_workflow 派发
  addNote(auto ? '✅ 倒计时到期,自动批准开跑' : (s.shardMode ? '✅ 分片自动批准开跑(拆分方案主控已批)' : '✅ 已批准,开始执行'))
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
      // origin(主进程标注)决定气泡形态:orch=分片回流/编排闸,system=壳层系统提醒,空=按用户消息(浏览器/邮件/技能等
      // 用户动作触发的注入,那些本来就代表"用户让我干这个",保留用户气泡)
      const origin = p.origin === 'orch' || p.origin === 'system' ? p.origin : undefined
      submit(String(p.text), [], String(p.disp || ''), origin ? { origin, shardId: p.shardId ? String(p.shardId) : undefined } : undefined)
    })
  } catch { /* 静默 */ }
}

// ── 主控卡分片进度(shard-progress 推送)+ 分片视图(点一片就地渲染镜像会话) ─────
let shardProgWired = false
const shardTrimmed = new Set<string>()   // 已截尾的分片(终态只截一次)
function mapShardList(list: any[]): { id: string; goal: string; status: string; round: number }[] {
  return (list || []).map((x: any) => ({ id: String(x.id || ''), goal: String(x.goal || ''), status: String(x.status || ''), round: +x.round || 0 }))
}
function applyShards(list: any[]): void {
  s.shards = mapShardList(list)
  for (const sh of s.shards) {   // 终态分片镜像缓冲截尾(防无界增长;一片只截一次)
    if (sh.id && (sh.status === 'done' || sh.status === 'interrupted') && !shardTrimmed.has(sh.id)) { shardTrimmed.add(sh.id); trimShardBuffer(sh.id) }
  }
}
export function wireShardProgress(): void {
  if (shardProgWired) return
  shardProgWired = true
  try {
    BH()?.onShardProgress?.((p: any) => {
      if (!p || !Array.isArray(p.shards)) return
      applyShards(p.shards)
    })
  } catch { /* 静默 */ }
}
export function openShardView(id: string): void { s.shardView = id || '' }

// ── 编排面板(新引擎):只读投影 + 显式动作 ────────────────────────────────
// 与旧主控卡最大的不同:这里【没有推断】。批准不是"嗅到 todowrite 就亮按钮",
// 是主进程 phase==='awaiting-approval' 明说的;进度不是数中文消息,是 counts。
let runWired = false
export function wireRun(): void {
  if (runWired) return
  runWired = true
  try {
    BH()?.onRunSnapshot?.((snap: any) => {
      if (!snap || !snap.id) return
      s.run = snap as RunSnapshot
      s.runId = String(snap.id)
      if (snap.goal && !s.titleCustomized) s.title = String(snap.goal).slice(0, 40)
    })
  } catch { /* 静默 */ }
}
async function runCall(fn: string, ...args: any[]): Promise<void> {
  try { await (BH() as any)?.[fn]?.(s.runId || null, ...args) } catch (e: any) { addNote('编排操作失败:' + ((e && e.message) || e)) }
  // 主进程会主动推新快照;这里不本地改状态 —— 唯一真相源在主进程,本地改就是第二本账
}
export const runApprove = () => runCall('runApprove', null)
export const runReject = (note: string) => runCall('runReject', note)
export const runNote = (text: string) => runCall('runNote', text)
export const runAbort = () => runCall('runAbort')
export const runResume = () => runCall('runResume')
export const runRetryNode = (nodeId: string) => runCall('runRetryNode', nodeId)
/**
 * 跳到某片的镜像视图(派发工具块 / 分片回流条点击):分片没在面板里(已被逐出注册表、或本卡不是主控)时
 * 给一条提示而不是静默无反应 —— 点了没动静比点不动更糟(旧页实测)。
 */
export function shardJump(id: string): boolean {
  const sid = String(id || '')
  if (!sid) return false
  if (!s.shards.some((x) => x.id === sid)) { addNote('分片 #' + sid + ' 不在当前进度面板里(可能已收官出表,或这张卡不是它的主控)'); return false }
  s.shardView = sid
  return true
}

// ── 工作流卡【主动交棒】(旧页 1037-1049 平移):水位 ≥knobs.ctxHandoffPct(默认 0.55)且轮末空闲
// → 写交接单换下一棒主 Agent(全新 128k);上限 knobs.autoCompactMax(默认 5)防病态循环,到顶转人工。
function handoffDue(): boolean {   // 交棒优先于一切轮末催办:水位到线的轮末谁也别起新回合(催办曾把交棒饿死,实测回归)
  return s.wfMode && !!s.ctxLimitTokens && ctxPctVal(s.ctxRealTokens, s.ctxUsedChars, s.ctxLimitTokens) >= knobNum('ctxHandoffPct', 0.55)
}

// ── 系统注入的唯一闸门 ────────────────────────────────────────────────────
// 轮末链上有 5 处会以"系统提醒"的名义自己起一个回合(计划闸 / 看门狗 / 委派驱动 / 长任务防停 / 产出兜底)。
// 原先每处在函数首行各抄一遍同一道闸 —— 抄对 3 份、漏掉 2 份:
//   · wdCheck 整条闸都没抄 → 压缩摘要轮收尾时照样注入,等于往摘要轮里套嵌套回合(把摘要泡顶成空气泡)
//   · maybePlanGate 同样没抄,且它撤闸后只会走一次,注入没送出去就是永久丢失
// 同一条判断散成 5 份,漏一份就是一个活 bug,而且不会有人发现。这里收成一份:谁要起系统回合都从这里过。
// 三个分量各有出处,别随手删:
//   busy       —— 同一条轮末链里前面的注入已经开跑,再起一个会两个回合抢同一份 answerParts
//   compacting —— 摘要轮 / 交棒 reinit 窗口内一律不开新轮(compacting 闸)
//   handoffDue —— 水位到线时交棒优先,催办曾经把交棒活活饿死(实测回归)
function canInject(): boolean { return !s.busy && !compacting && !handoffDue() }
/**
 * 起一个系统提醒回合。闸没过就不起并返回 false。
 * ★"只催一次"的记账标志一律要在闸【之后】才置位:先置位再被闸挡下 = 这次提醒永远送不出去,
 *   而下一轮末因为标志已置位不会再来第二次。所以调用方要么先 canInject() 再记账,要么按返回值决定记不记。
 */
function injectTurn(text: string): boolean {
  if (!canInject()) return false
  turn(text)
  return true
}
function maybeAutoCompact(): void {
  compactClock++   // 轮末节拍:本函数每轮末调一次,熔断冷却按它数
  if (compacting || !s.wfMode || s.busy || !s.ctxLimitTokens) return   // compacting 闸:摘要轮/交棒进行中绝不重入
  let handoff = 0.55, maxN = 5
  try {
    const knobs = ((BH()?.getSettings?.() || {}) as any).knobs || {}
    if (+knobs.ctxHandoffPct > 0) handoff = +knobs.ctxHandoffPct
    if (Math.round(+knobs.autoCompactMax) >= 1) maxN = Math.round(+knobs.autoCompactMax)
  } catch { /* 静默 */ }
  const pct = ctxPctVal(s.ctxRealTokens, s.ctxUsedChars, s.ctxLimitTokens)
  if (pct < handoff) return
  if (compactFailStreak >= 2) {   // 连败熔断:停自动重试转人工(只贴一次;手动/自动成功即复位)
    if (!compactFailNoted) { compactFailNoted = true; addNote('交棒连续失败 2 次，已停止自动重试——请点上下文 chip 手动压缩或检查模型状态') }
    return
  }
  if (compactFailSeq >= 0 && compactClock - compactFailSeq < 2) return   // 失败冷却:隔一个轮末再试
  if (s.autoCompactN >= maxN) return   // 到顶转人工(ctx chip 手动压)
  compactCore({ wf: true, auto: true })
}

// ── 进展型看门狗(判死看进展不看时长;仅 wf 卡,旧页 1193-1254 平移)────────────
// 轮末结算:本轮有读文件 → 进历史(上限 10 轮);无读文件的轮不进("连续"因此断开)
function wdFinalizeRound(): void {
  if (wdCurFiles.size) { wdRounds.push({ turn: turnN, files: wdCurFiles }); if (wdRounds.length > 10) wdRounds.shift() }
  wdCurFiles = new Set()
}
function wdCheck(): void {
  if (!s.wfMode) return
  // busy/compacting/交棒闸:轮末链上另外三个注入点(maybeDelegateNudge/maybeContinueNudge/maybeWfProduceNag)首行都有这道闸,
  // 只有这里漏了 —— 而本函数在链首,是四个里唯一能在【压缩摘要轮】收尾时开跑的。doCompact() 内部靠 turn() 发摘要,
  // 那一轮的 finally 照样走整条链:三个兄弟按 compacting 躲开,它不躲,于是往摘要轮里套嵌套回合(兄弟注释原话:实测死循环)。
  // 整体返回而不是"只跳过注入":一级分支会置 wdWarned/wdWarnTurn/wdWarnSet,若记了账却没真发出提醒,
  // 二级就会拿一句从没送达的警告去升级中止。这里退出不丢检测 —— wdRounds 仍由 wdFinalizeRound 累积,下一个干净轮末原样复算。
  if (!canInject()) return
  const N = Math.max(2, Math.round(knobNum('watchdogRounds', 3)))
  const ov = knobNum('watchdogOverlap', 0.7)
  const M = Math.max(1, Math.round(knobNum('watchdogEscalateRounds', 2)))
  if (!wdWarned) {
    // 第一级:最近连续 N 轮(轮次号相邻、每轮都有读)集合高度重合且无 todo 完成项
    const win = wdRounds.slice(-N)
    const noTodoProgress = wfTodoDoneTurn < 0 || (win.length > 0 && wfTodoDoneTurn < win[0].turn)
    const consecutive = win.length === N && win.every((r, i) => i === 0 || r.turn === win[i - 1].turn + 1)
    if (!consecutive || !noTodoProgress) return
    const inter = new Set([...win[0].files].filter((f) => win.every((r) => r.files.has(f))))
    const union = new Set<string>(); for (const r of win) for (const f of r.files) union.add(f)
    if (!(union.size > 0 && inter.size / union.size >= ov)) return
    wdWarned = true; wdEscLoops = 0; wdWarnTurn = turnN; wdWarnSet = union
    addNote('看门狗：检测到连续 ' + N + ' 轮反复读同一批文件且无进展，已提醒 Agent 换策略')
    // 提醒带总目标背诵(recitation):弱模型被纠偏后容易漂,把目标重进上下文尾部(近期注意力区)
    injectTurn('(系统提醒:检测到你可能在绕圈 —— 连续多轮反复读取同一批文件,而计划没有任何进展。重申总目标:「' + s.title.slice(0, 80) + '」。请立即停止重复读取:先汇聚已有发现给出结论;信息不够就换策略(不同工具/关键词/换个角度),不要再读相同的文件。)')
    return
  }
  // 第二级(已警告):只看"是不是还在绕那批文件" —— 无读文件轮不计数也不复位
  if (wfTodoDoneTurn > wdWarnTurn) { wdWarned = false; wdEscLoops = 0; wdWarnSet = null; return }   // todo 刚有进展 = 真纠偏
  const last = wdRounds.length ? wdRounds[wdRounds.length - 1] : null
  if (!last || last.turn !== turnN) return   // 本轮没读文件:不算绕也不算纠偏,状态保持
  const same = [...last.files].filter((f) => wdWarnSet && wdWarnSet.has(f)).length
  if (last.files.size > 0 && same / last.files.size >= ov) {
    if (++wdEscLoops >= M) {
      if (s.shardMode) {   // 分片无人值守:横幅没人点,"判死权给人"=永远不死 → 自动中止本轮
        addNote('看门狗：绕圈提醒后仍未纠偏，分片无人值守 → 自动中止本轮（壳层按 aborted 判 interrupted 收官）')
        try { BH()?.cardAbort?.() } catch { /* 静默 */ }
        wdWarned = false; wdEscLoops = 0; wdWarnSet = null
      } else {
        s.wdBanner = true   // 第二级:醒目横幅+【中止本轮/知道了】(判死权给人;ChatApp 渲染)
      }
    }
  } else { wdWarned = false; wdEscLoops = 0; wdWarnSet = null }   // 读了不同的文件 = 换策略了,复位
}

// ── 委派驱动(harness,旧页 1061-1078):复杂任务主 Agent 一直单干 = 必走歪路 ──
// todo ≥3 步 且 已实质干活 且 ≥2 轮 且 从未派过 task → wf 自动注入派子 Agent 规程;普通卡给可见建议。每任务只催一次。
function maybeDelegateNudge(): void {
  if (!canInject() || delegatedSeen || delegateNudged) return   // 闸的三个分量见 canInject;记账标志(delegateNudged)在闸之后才置位
  if (latestTodoTotal < 3 || turnN < 2) return
  if (!wdRounds.length && !wfExecSeen) return
  delegateNudged = true
  if (s.wfMode) {
    addNote('委派驱动:检测到复杂任务在单干,已提醒按规程派子 Agent 并行')
    injectTurn('(系统提醒:这是一个多步骤复杂任务,你已多轮亲自单干 —— 按规程第 4 条:满足【彼此独立 + 需深读很多文件 + 能同时干】的工作块,用 task 一条消息一次派多个子 Agent 并行(各自独立 128k),指令只写目标/文件路径清单/边界/回报格式,贴原文会被壳层拦停。你只保留综合与验收;琐碎块可以自干,大片深读/大改造必须下放。)')
  } else {
    addNote('这个任务有多步且已读了不少文件 —— 适合对我说「派子 Agent 并行干」或从卡坞开【动态工作流】,比单会话串行啃快且不容易丢上下文')
  }
}
// ── 长任务防停(旧页 1082-1103):todo 还有未完项就催它继续 ──
// wf 自动注入"继续"(停下=链死);普通卡出可见「继续执行」按钮。连催 3 次且无进展 → 停催转人工;未完项变少即复位。
function maybeContinueNudge(): void {
  if (!canInject()) return   // 闸的三个分量见 canInject(此处最痛的是 compacting:摘要轮里再注入会把摘要泡顶成空气泡,实测死循环)
  const open = latestOpenTodos
  if (!open.length) { contNudgeN = 0; contLastOpen = -1; contNudgeOff = false; return }   // 全干完了:整组状态归零,下个任务重新计
  if (contLastOpen >= 0 && open.length < contLastOpen) { contNudgeN = 0; contNudgeOff = false }   // 未完项变少 = 真有进展 → 熔断复活
  contLastOpen = open.length
  if (contNudgeOff) return   // ★已转人工:彻底闭嘴,连那句"不再自动催"也不重复贴
  if (contNudgeN >= 3) {
    // ★原来这里贴完 note 还把 contNudgeN 清了 0 —— 熔断只挡住【这一轮】,下个能催的轮末又从 0 起跳,
    //   于是变成"催 3 次歇一轮再催 3 次",note 里那句"不再自动催"是假承诺,wf 卡上等于每轮末永久注入。
    //   旧页 ui/card.html:1131 同一句 addNote 后面直接 return、不清零 —— 熔断本来就是粘的,这是平移时加错的一行。
    //   改成粘性标志:只有"未完项变少(真有进展)"或"todo 清空"才复活,别的一律不复活。
    contNudgeOff = true
    addNote('任务仍未完成(todo 剩 ' + open.length + ' 项),已连续催 3 次无进展 —— 不再自动催,请人工看看卡在哪')
    return
  }
  contNudgeN++
  if (s.wfMode) {
    injectTurn('(系统提醒:任务还没完成 —— todo 还有 ' + open.length + ' 项未完成:「' + open.slice(0, 3).join('、') + (open.length > 3 ? '…' : '') + '」。不要停在这里,立即继续执行下一步;真遇到阻塞,明说卡在哪、需要什么。)')
  } else {
    // 按钮语义必须与文案一致:retry 是把上一条用户消息原样重发(模型从头再做一遍),而这里要的是"接着上次停下的地方"。
    // 与旧页 ui/card.html:1138 对齐 —— 发一条新消息,不是重试。
    addNote('任务清单还有 ' + open.length + ' 项未完成，Agent 提前停下了 —— ', {
      contMsg: '继续执行：接着上次停下的地方，把剩余 ' + open.length + ' 项任务继续做完。',
    })
  }
}
// ── 产出兜底(wf 卡,规程第 7 条):todo 全勾却零落盘产出 → 注入补 MD 提醒(一次) ──
function maybeWfProduceNag(): void {
  if (!s.wfMode || !canInject() || wfProduceNag || !latestTodoTotal) return   // 闸的三个分量见 canInject;wfProduceNag 在闸之后才置位
  if (latestOpenTodos.length) return   // 还有未完项,不算"快完成"
  if (s.artFiles.length) return
  wfProduceNag = true
  addNote('⚠ 系统提醒:尚无落盘产出 —— 请补写 MD 文档')
  injectTurn('(系统提醒:工作流即将完成,但尚未有任何落盘产出。按规程第 7 条【默认必须落盘产出 MD】:把最终成果写成 docs/ 下的 MD 文档(报告/手册/清单/改动说明),写完再交付;确有理由不落盘的,请在交付回答里明确说明理由。)')
}
// ── 普通对话卡水位主动提醒(不自动压缩 —— 会清可见对话,越权):≥knobs.chatHandoffPct(缺省 0.9,0=不提醒)且轮末空闲 → 提醒一次 ──
let ctxNag = false
function maybeCtxNag(): void {
  if (s.wfMode || ctxNag || compacting || !s.ctxLimitTokens) return
  const line = knobNum('chatHandoffPct', 0.9)   // 死旋钮复活:阈值跟设置页 knobs.chatHandoffPct 走;0=用户关了提醒
  if (line <= 0) return
  const pct = ctxPctVal(s.ctxRealTokens, s.ctxUsedChars, s.ctxLimitTokens)
  if (pct < line) return
  ctxNag = true
  addNote('上下文已用 ' + Math.round(pct * 100) + '% —— 继续聊质量会下降,建议点上方上下文 chip「压缩续聊」')
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
    // 响应式代理过不了 IPC 结构化克隆(实测 "An object could not be cloned")—— 剥成纯数组再发
    const r = await BH()?.questionReply?.(it.requestId, it.answers.map((a) => (Array.isArray(a) ? [...a] : a)))
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

// ── ctx chip 数据源:上限(listModels 60s 缓存 → 型号兜底 → knobs.ctxLimitMax 兜底)/ 实测用量(轮末轮询) ──
// ctxLimitReal=false 时 turn() 每回合补刷:serve 未起时开卡 list-models 落空,不补刷会终身吃兜底值(实测)
let ctxLimitReal = false
export async function refreshCtxLimit(): Promise<void> {
  let limit = 0
  try {
    const now = Date.now()
    if (!modelsCache || now - modelsCacheAt > 60000) {
      const list = (await BH()?.listModels?.()) || []
      if (list.length) { modelsCache = list; modelsCacheAt = now }   // 空不缓存:下次调用重试(serve 晚起是常态),拿到真列表才起 60s 缓存
    }
    const cur = s.modelKey && (modelsCache || []).find((m: any) => (m.providerID + '/' + m.modelID) === s.modelKey)
    limit = (cur && (cur.ctx || (cur.limit && cur.limit.context) || cur.context || 0)) || 0   // list-models 上限字段是 ctx(opencode.js),limit.context/context 兼容兜底
    if (limit) ctxLimitReal = true
  } catch { /* 静默 */ }
  if (!limit) limit = ctxFallbackFor(s.modelKey || s.modelLabel)
  let capMax = 128000
  try { capMax = Math.floor(+((((BH()?.getSettings?.() || {}) as any).knobs || {}).ctxLimitMax)) || 128000 } catch { /* 静默 */ }
  if (!limit) limit = capMax   // 全部读不到:兜底取 knobs.ctxLimitMax(壳层口径同源,knobs 改上限这里跟随),不写死
  s.ctxLimitTokens = ctxCap(limit, capMax)
  emitCtxToHost()
}
export async function pollRealUsage(): Promise<void> {
  try {
    const u = await BH()?.cardUsage?.()
    s.ctxRealTokens = u && u.tokens ? u.tokens : null
    s.ctxCacheHit = u && typeof (u as any).cacheHit === 'number' ? (u as any).cacheHit : null
  } catch { /* 静默 */ }
  emitCtxToHost()
}
/** ctx/模型回写宿主 shell(状态栏真值;顶层窗静默) */
function emitCtxToHost(): void {
  try {
    BH()?.chatCtxEmit?.({
      tokens: s.ctxRealTokens != null ? s.ctxRealTokens : Math.round(s.ctxUsedChars / 1.6),
      limit: s.ctxLimitTokens || 0,
      real: s.ctxRealTokens != null,
      model: s.modelLabel || '',
    })
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
// ── Agent 切换(OMO 兼容):serve 的 /agent 清单(primary 非隐藏);空清单=老 serve,UI 藏入口 ──
let agentsCache: any[] | null = null, agentsCacheAt = 0
export async function listAgents(): Promise<any[]> {
  try {
    const now = Date.now()
    if (!agentsCache || now - agentsCacheAt > 60000) {
      const r: any = await BH()?.listAgents?.()
      agentsCache = (r && r.agents) || []; agentsCacheAt = now
    }
  } catch { /* 静默 */ }
  return agentsCache || []
}
export async function setAgent(name: string): Promise<void> {
  try { await BH()?.cardSetAgent?.(name || '') } catch { /* 静默 */ }
  s.agentName = name || ''
  addNote(name ? '本会话 Agent 已切到【' + name + '】(下一条消息起生效)' : '本会话 Agent 已切回默认(build)', { muted: true })
}
/** 作答技能('/' 菜单):挂到 activeSkill,submit 时随 cardSend 第三参发出;✕ 卸载 */
export async function listSkills(): Promise<any[]> {
  try { return (await BH()?.skillsList?.()) || [] } catch { return [] }
}
export function setActiveSkill(sk: { id: string; name: string; desc?: string } | null): void {
  s.activeSkill = sk
}

/** 改会话名:标题栏内联改名 / 首轮自动命名。三处同步:本卡标题、宿主侧栏(card-bound)、历史索引(history-rename)。 */
const DEFAULT_TITLES = /^(新会话|新对话|BocomHermes 对话|对话)$/
export function setSessionTitle(t: string, opts?: { manual?: boolean }): void {
  const title = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!title || title === s.title) return
  if (opts && opts.manual) s.titleCustomized = true
  s.title = title
  try { BH()?.cardBoundEmit?.({ sid: s.sessionId, title }) } catch { /* 静默 */ }
  try { BH()?.historyRename?.(s.sessionId, title) } catch { /* 静默 */ }
}
/** 首轮结束自动命名:默认名 + 没手改过 → 用首条消息前 24 字(一卡一话题,名字说人话) */
function maybeAutoTitle(): void {
  if (s.titleCustomized || !DEFAULT_TITLES.test(s.title) || !lastSend) return
  setSessionTitle(String(lastSend.text).slice(0, 24))
}

/** 项目目录切换(标题栏项目 chip):选目录 → 换目录 = 换引擎,本卡重开会话(对齐旧卡 paintProj+cardReinit) */
export async function pickProject(): Promise<void> {
  try {
    const r = await BH()?.cardPickProject?.()
    if (!r || !r.changed) return
    const nr = await BH()!.cardReinit({})
    resetConversation()
    s.project = nr.project || ''
    s.dir = nr.dir || s.dir
    s.modelLabel = (nr.model && (nr.model.name || nr.model.modelID)) || s.modelLabel
    s.modelKey = nr.model ? (nr.model.providerID + '/' + nr.model.modelID) : s.modelKey
    s.sessionId = nr.sessionId || s.sessionId
    draftKey = draftKeyOf(s.sessionId)
    refreshCtxLimit()
    addNote('已切换目录:' + (nr.dir || '') + '(换目录 = 换引擎,已新开会话)')
  } catch { /* 静默 */ }
}

// ── 压缩续聊(compactCore,旧页 982-1017 平移):模型写接力摘要 → cardReinit(carryCtx) → 清场续聊 ──
// wf 变体(主动交棒):工作流专用摘要提示 + 压缩后自动发「恢复执行」棒次,无人值守链不断。
const SUM_PROMPT_CHAT = '请把我们这段对话压缩成一份「接力摘要」，供新会话继续用。包含：1) 正在做的事与目标 2) 已确认的关键结论/决定（保留文件路径、命令、数据） 3) 未完成事项与下一步 4) 已排除的思路与失败尝试（各附一句原因 —— 保错误证据，下一棒不重犯） 5) 需要沿用的约束与偏好 6) 用户消息清单：逐条列出本段对话中用户发过的所有消息（原话，不含工具结果） 7) 已读文件清单：本段精读过的文件路径，各附一句"读到了什么"，新会话直接采信结论、不要重读 8) 下一步：逐字引用最近一条进行中的对话原话，说明做到哪、接着做什么（防意图漂移）。可以先打 <analysis> 草稿再定稿，但只输出定稿后的摘要正文（草稿会被剥离）；本轮直接输出，不要调用任何工具。'
const SUM_PROMPT_WF = '请把本工作流到目前为止压缩成一份「接力摘要」，供新会话无缝继续执行。必须包含：1) 总目标 2) todo 计划清单及各项当前状态（原样逐条列出） 3) 已确认的关键结论与产出（保留文件路径、file:行号、命令、数据；子 Agent 已回报的发现逐条保留） 4) 未完成事项与下一步打算 5) 已尝试与已排除路径（失败的方法/走过的死胡同/被否决的方案，各附一句原因 —— 保错误证据，下一棒不重犯） 6) 需沿用的约束 7) 用户消息清单：逐条列出本工作流中用户发过的所有消息（原话，不含工具结果） 8) 已读文件清单：本棒已精读过的文件路径，各附一句"读到了什么"，下一棒直接采信结论、不要重读 9) 下一步：逐字引用最近一条进行中的对话原话，说明做到哪、接着做什么（防意图漂移）。可以先打 <analysis> 草稿再定稿，但只输出定稿后的摘要正文（草稿会被剥离）；本轮直接输出，不要调用任何工具。'
const RESUME_MSG = '接力摘要已随本消息注入（见上方摘要块）。摘要中的已读文件清单直接采信，不要重读；请先用 todowrite 恢复摘要里的计划清单，然后按未完成事项继续执行，直至总目标完成。'
/** 清场:压缩续聊/切目录专用 —— feed/队列/工具账本/成果抽屉全清,会话级草稿键由调用方负责换 */
export function resetConversation(): void {
  // ★排队消息跨清场存活:queue 里躺的是【用户已经打完、气泡还挂着 queued】的消息。原来这里 s.items=[] 连气泡一起清、
  //   紧接着 queue.length=0 连正文一起清 —— 交棒/切目录期间打的字连条痕迹都不剩,用户既看不到也等不来(实测直接蒸发)。
  //   正确语义是"这几条还没送出去",清场只该换会话、不该替用户撤回,所以队列原样留着,送进新会话。
  //   气泡对象必须在 s.items=[] 之前抓出来再挂回去:否则 queue 里的 item 成了不在 feed 上的孤儿,
  //   drain 时消息发得出去、气泡却永远不出现(看着像又丢了一条)。挂回后仍是 queued 态,等 compactCore 的 finally 统一 drain。
  const keptQueued = queue.map((q) => q.item)
  s.items = []; s.archived = 0
  toolItems.clear(); artFileSeen.clear(); s.artFiles = []; s.lastFinalText = ''
  for (const it of keptQueued) { it.queued = true; s.items.push(it) }
  curAnswer = null; reasonItems.clear()
  answerParts = new Map(); reasonParts = new Map()
  meter.reset(); s.ctxUsedChars = 0; s.ctxRealTokens = null; s.ctxCacheHit = null
  wfExecSeen = false; wfSawTodo = false   // 新会话重看规划/执行信号(planApproved 主进程侧按卡记,不动)
  ctxNag = false   // 水位提醒复位:上下文已回起点,下次涨回 90% 要允许再提醒
  delegateNudged = false; contNudgeN = 0; contLastOpen = -1; contNudgeOff = false; wfProduceNag = false   // contNudgeOff 必须一起复位:交棒是新一棒,不能让上一棒的熔断把防停永久哑掉
  if (!s.shardMode) {   // 看门狗账本清零(分片不清:跨棒绕圈正是分片死循环的典型形态,账本跨棒连续才抓得到)
    wdCurFiles = new Set(); wdRounds.length = 0; wdWarned = false; wdEscLoops = 0; wdWarnSet = null; wdWarnTurn = -1; s.wdBanner = false
  }
}
// 交棒熔断(借鉴 CC autoCompact consecutiveFailures,依据 借鉴清单 A1):成功复位、失败不耗棒次、
// 连败 2 次停自动重试转人工、失败隔一个轮末再试(冷却按 maybeAutoCompact 的轮末节拍数)。台账见 docs/项目记忆/弱模型行为台账.md
let compactFailStreak = 0, compactFailSeq = -1, compactClock = 0, compactFailNoted = false
// compacting 闸(旧页 card.html:992 平移):摘要轮的轮末 finally 会再触发 maybeAutoCompact/催办链,没这闸会重入交棒(实测死循环);
// 入口置位、finally 复位;compacting 期间 submit 一律入队、drain 不开轮(reinit 窗口不持忙的回归一并修)
let compacting = false
// 滚动 session memory(CC 同款):上一棒交接单作基座只增量合并,摘要不再每次从零重写(弱模型漂移更少)。
// 内存态随卡存活(交棒链同卡);落盘按卡 id 存 userData/compacts/(compactLogLast/compactLogAppend IPC,键稳定重启能找回)
let lastCompactSummary = ''
export function isCompacting(): boolean { return compacting }
export async function compactCore(opts?: { wf?: boolean; auto?: boolean }): Promise<boolean> {
  const wf = !!(opts && opts.wf), auto = !!(opts && opts.auto)
  if (compacting) return false   // 重入闸:静默拒(忙线拒绝在下条,带提示)
  if (s.busy) { addNote('正在回答中，等这轮结束再压缩'); return false }   // 忙线拒绝不算失败(不计熔断)
  compacting = true
  try {
    addNote(auto ? '到达主动交棒水位,接力给下一棒主 Agent(第 ' + (s.autoCompactN + 1) + ' 棒):正在写交接单…' : '压缩续聊:正在让模型总结本段对话…')
    const oldSid = s.sessionId   // 逃生舱 transcript 属于旧会话(reinit 后换新号)
    // 滚动 session memory:上一棒交接单(内存优先,落盘兜底)作基座拼进摘要提示,只增量合并
    let sumPrompt = wf ? SUM_PROMPT_WF : SUM_PROMPT_CHAT
    try {
      const prev = lastCompactSummary || (typeof (BH() as any)?.compactLogLast === 'function' ? await (BH() as any).compactLogLast(cardId || 'card') : '')
      if (prev && String(prev).trim()) sumPrompt += '\n\n【上一棒交接单(基座,直接采信)】\n' + String(prev).trim() + '\n【/上一棒交接单】\n要求:以它为基座,只把本段新内容增量合并进来(保留仍成立的事实,删掉过期事实,别整段重写)。'
    } catch { /* 静默 */ }
    // ★摘要必须取【本轮新产生】的那条 ai,不能全 feed 倒着找。
    //   原来的 `reverse().find(i => i.kind==='ai' && !!i.raw)` 带了个 raw 非空条件:摘要轮一旦空答(网关静默/模型直接收尾),
    //   这条空摘要被跳过,find 顺势抓到【上一条普通回答】—— 于是"压缩失败"被判成成功,把一段普通对话回答当交接单
    //   写进 lastCompactSummary、落盘 compactLogAppend、再注入新会话。下一棒拿着一份驴唇不对马嘴的摘要接着干,且完全无感。
    //   锚定用"轮前条目集合"而不是下标:轮末 maybeCapFeed 会裁剪 feed 头部(320→280),下标会整体漂移,引用不会。
    const before = new Set(s.items)
    const ok = await turn(sumPrompt)
    const lastAi = [...s.items].reverse().find((i): i is AiItem => i.kind === 'ai' && !before.has(i))
    let summary = ok && lastAi ? String(lastAi.raw || '') : ''   // 新条目存在但 raw 为空 → summary 空 → 老实走下面的失败分支(计熔断、不落盘)
    // analysis 机械剥离(CC 摘要模板同款纪律):模型先打 <analysis> 草稿再定稿,只许定稿进新会话(CoT 提质量但不该花 token 带进下一棒)
    const am = summary.match(/<analysis>[\s\S]*?<\/analysis>/i)
    if (am) summary = summary.replace(am[0], '').trim()
    if (!summary.trim()) { compactFailStreak++; compactFailSeq = compactClock; addNote('压缩失败：没拿到摘要，继续用原会话（可稍后重试）'); return false }
    // 工作现场回填(CC buildPostCompactMessages 同款):最近 write/edit 落盘的 5 个文件随摘要注入新会话 ——
    // 换棒失忆是弱模型最痛的一档;必须在 resetConversation 清场之前取(清场后 artFiles 已空)
    const siteFiles = s.artFiles.slice(-5)
    if (siteFiles.length) summary += '\n\n<工作现场回填>上一棒最近 write/edit 落盘的文件（需要最新内容时按路径重读，不要全部重读）：' + siteFiles.join('、') + '</工作现场回填>'
    lastCompactSummary = summary   // 滚动 session memory:本棒交接单记为下一棒基座(内存态 + 落盘双写)
    try { if (typeof (BH() as any)?.compactLogAppend === 'function') (BH() as any).compactLogAppend({ sid: cardId || 'card', text: summary }) } catch { /* 静默 */ }
    try {
      s.busy = true   // reinit 窗口持忙(旧页 setBusy(true) 平移):清场到新会话就绪之间,submit 入队、drain 不开轮
      const r = await BH()!.cardReinit({ dir: s.dir, carryCtx: summary, shard: s.shardMode || undefined })
      resetConversation()
      s.project = r.project || s.project; s.dir = r.dir || s.dir
      s.modelLabel = (r.model && (r.model.name || r.model.modelID)) || s.modelLabel
      s.sessionId = r.sessionId || s.sessionId
      draftKey = draftKeyOf(s.sessionId)
      // ⚠ 此处不再 bump summary 长度:新会话首条注入的 ctxPrefix(含摘要)会经 card-note 整长计账,两边都 bump 水位虚高一个摘要身位(实测回归)
      s.items.push({ id: nextId(), kind: 'reason', body: summary, open: false, title: '接力摘要（已随新会话注入）' })
      compactFailStreak = 0; compactFailNoted = false   // 成功复位(手动 chip 压成功同样复位)
      s.busy = false
      if (auto) {
        s.autoCompactN++   // 棒次只计成功(失败不耗额度)
        let resume = RESUME_MSG
        try { const txp = await (BH() as any)?.transcriptPath?.(oldSid); if (txp) resume += '上一棒完整记录见：' + txp + '，需要细节可回查。' } catch { /* 静默 */ }
        addNote('已交棒:下一棒主 Agent 带着交接单上阵(全新 128k),继续执行未完成步骤')
        await turn(resume)
      } else {
        addNote('已压缩续聊：新会话就绪，摘要已注入，直接继续提问即可。')
      }   // drain 不在这里调:此刻 compacting 还是 true(要等下面 finally 才清),drain 首行就 `if (compacting) return`,纯空转。统一挪到 finally
      return true
    } catch (e: any) { s.busy = false; compactFailStreak++; compactFailSeq = compactClock; addNote('开新会话失败：' + ((e && e.message) || e) + '（原会话不受影响）'); return false }
  // 先落闸再放水,且放在唯一出口:compacting 期间 submit 一律入队,而 drain 首行按 compacting 短路 ——
  // 原来两条失败路径(摘要为空 / cardReinit 抛错)直接 return,谁也没再 drain,队列就永久卡着,
  // 得等用户【再发一条】才顺带带出来一条(不发就一直挂着)。成功路径那次 drain 又因 compacting 尚未清而空转。
  // 收敛成 finally 里的一次:成功/失败/抛异常全覆盖。若此刻 s.busy(auto 分支刚开的恢复轮),drainNext 返回空,
  // 由那一轮自己的轮末 drain 接手,不会漏。
  } finally { compacting = false; drain() }
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
  wireCardNote()       // 系统灰字条 + 注入背景计入 ctx 估算(此前整组没接,提示丢失且估算偏低)
  wirePermission()     // 权限审批条(feed PermItem + sticky 计数;wf 自动批准分支)
  wireQuestion()       // 交互提问卡(单/多选/custom/跳过)
  wireServeHealth()    // 标题栏保活灯
  wireInject()         // card-inject:严格模式下一步 / 主控进度唤醒(过 card-send 闭环)
  wireShardProgress()  // 主控卡分片进度面板
  wireRun()            // 编排面板:主进程 run-snapshot 只读投影
  initVerbose()        // 过程详情偏好(localStorage cardVerbose)
  const p = new URLSearchParams(location.search)
  s.title = p.get('title') || '新对话'
  cardId = p.get('id') || ''   // 滚动 session memory 落盘键(compactLog*)
  const initMsg = p.get('msg') || s.title          // msg 在场时发送内容不同于标题(fan-out)
  const dispMsg = p.get('disp') || initMsg         // disp 在场时用户气泡展示它
  const sid = p.get('sid') || ''
  s.embedded = p.get('embedded') === '1'
  s.chatEmbed = s.embedded && p.get('chat') === '1'
  // 工作流模式族(P2b-3):wf=动态工作流卡(规划闸/自动批准/主动交棒),orch=主控(分片进度面板),shard=分片(静默自动批+空答重试)
  s.wfMode = p.get('wf') === '1' || p.get('wf') === 'true'
  s.orchMode = !!p.get('orch')
  s.shardMode = p.get('shard') === '1'
  s.runId = p.get('run') || ''
  try { purgeStaleDrafts(localStorage) } catch { /* 静默 */ }

  s.busy = true
  if (!s.runId && !sid && (!s.embedded || (s.chatEmbed && p.get('msg')))) addUser(dispMsg)
  const bootItem = addAi()
  bootItem.plainText = sid ? '正在续接对话…' : (s.embedded && !s.chatEmbed) ? '正在连接调试助手…' : '正在启动引擎…（首次较慢，请稍候）'
  try {
    const r = await BH()!.cardInit(sid ? { sid, title: s.title } : { title: s.title })
    s.project = r.project || ''
    s.dir = r.dir || ''
    s.modelLabel = (r.model && (r.model.name || r.model.modelID)) || '默认模型'
    s.modelKey = r.model ? (r.model.providerID + '/' + r.model.modelID) : ''
    s.sessionId = r.sessionId || ''
    try { const m = await Promise.resolve(BH()?.cardPermModeGet?.()); s.permMode = m === 'auto' ? 'auto' : 'default' } catch { /* 静默 */ }   // 权限模式按会话(本卡自己的档,缺省回退全局默认)
    s.agentName = (r as any).agent || ''   // 建会话时预选的 Agent(card-init 回包;空=默认 build)
    try { const sh = (r as any).shards; if (Array.isArray(sh)) applyShards(sh) } catch { /* 静默 */ }   // card-init 回包带分片进度(主控卡重开恢复面板);字段缺席不炸
    refreshCtxLimit()   // ctx chip 上限(listModels → 型号兜底 → knobs.ctxLimitMax 兜底;fire-and-forget)
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
    } else if (s.runId) {
      // 编排面板:那段会话只为兼容而建(mirrorToOrch / 关卡级联杀 / 卡坞列表都按"有会话的 orch 卡"找它),
      // 【永不发消息】—— 编排不是"跟一个 Agent 聊天"。首屏直接拉一次快照,之后由 run-snapshot 推。
      s.busy = false
      try { const snap = await (BH() as any)?.runSnapshot?.(s.runId); if (snap && snap.id) { s.run = snap; s.runId = String(snap.id) } } catch { /* 静默 */ }
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
