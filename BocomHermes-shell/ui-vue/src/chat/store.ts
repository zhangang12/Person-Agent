// chat 页 · 会话生命周期与消息流 store(P2a 第一棒)
// 从 ui/card.html 平移的行为:
//   cardInit(sid/id/title/msg/disp/embedded/chat 分支) → card-bound 回发(boot)
//   cardSend/cardAbort(turn/abort);POST 结果权威收尾,流式累积兜底(reply || joinParts)
//   忙时 submit 入队、queued 气泡半透明、轮末 drain 转正(submit/drain)
//   中断「已中断」角标 + 半截保留 + 重试钮;重答;草稿发送即清、续接恢复
//   流式逐 token 防 O(n²):稳定块冻结(segs 只增)+ 尾巴区每帧重渲(tail)
//   思考两路来源(reasoning part + 文本内联 <think>),各轮思考块独立、答完不折叠
//   feed 320 条回收占位(展示层回收,数据不丢)
// 显式不做(第二棒挂载点,见文件尾 HANDOFF):
//   工具块/todo卡/权限条/提问卡/标题栏 chips 交互/子 Agent 侧边栏/技能菜单/工作流卡
import { reactive, computed } from 'vue'
import { BH } from './bridge'
import { renderMarkdown } from './rich'
import { splitThink, joinParts } from './lib/text'
import { planIncremental } from './lib/stream'
import { CtxMeter } from './lib/ctx'
import { drainNext } from './lib/queue'
import { draftKeyOf, draftSave, draftRestore, draftClear, purgeStaleDrafts } from './lib/draft'

// ── Feed 条目模型 ─────────────────────────────────────────────────────────
interface BaseItem { id: number }
/** 用户气泡(queued=排队中,半透明 + 可取消) */
export interface UserItem extends BaseItem { kind: 'user'; text: string; queued: boolean }
/** 分诊/提示行(非对话轮);retry=true 时带「重试本轮」按钮 */
export interface NoteItem extends BaseItem { kind: 'note'; text: string; muted: boolean; retry: boolean }
/** 思考块:每轮一个,答完不折叠不移除(open 保持) */
export interface ReasonItem extends BaseItem { kind: 'reason'; body: string; open: boolean }
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
export type FeedItem = UserItem | NoteItem | ReasonItem | AiItem

interface QueueEntry { text: string; files: any[] | null; item: UserItem }

interface StreamEvent {
  kind?: string; text?: string; partID?: string; status?: string
  input?: any; output?: any; title?: string; error?: any
  sub?: boolean; agentId?: string; agentName?: string
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
  /** cardInit 成功后恢复出来的草稿(ComposerBar watch 消费) */
  restoredDraft: '',
  /** ctx 估算用量(第二棒标题栏 chip 的数据源,本棒只记账) */
  ctxUsedChars: 0,
  /** 第二棒挂载点计数:tool/sub/question 等本棒不渲染的事件 */
  unhandledEvents: 0,
})

/** 可见条目(回收占位之后) */
export const visibleItems = computed(() => s.items.slice(s.archived))

// ── 会话内非响应式运行时态 ────────────────────────────────────────────────
const meter = new CtxMeter()
const queue: QueueEntry[] = []
let lastSend: { text: string; files: any[] | null } | null = null
let draftKey = ''
// 本轮流式态(turn 之间串行,全局一份即可 —— 与旧页同构)
let curAnswer: AiItem | null = null
let curReason: ReasonItem | null = null
let answerParts = new Map<string, string>()
let reasonParts = new Map<string, string>()
let flushQueued = false, needAnswer = false

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

// ── 主进程流事件(渲染端不碰 SSE,协议不变) ────────────────────────────────
let streamWired = false
export function wireStream(): void {
  if (streamWired) return
  streamWired = true
  try {
    BH()?.onStream?.((ev: StreamEvent) => {
      // 子 Agent / 工具块 / 提问卡 → 第二棒;本棒只做 ctx 记账(同 partID 只记一次)
      if (ev.sub) { s.unhandledEvents++; return }
      if (ev.kind === 'tool') {
        s.unhandledEvents++
        try {
          if (ev.partID && /complet|success|done|finish|ok|error|fail|deny|reject/i.test(String(ev.status || ''))) {
            // 存疑:旧页入参走 fmtInput(对象→缩进 JSON);这里用 JSON.stringify 长度近似,第二棒接工具块时对齐
            const inLen = ev.input == null ? 0 : (typeof ev.input === 'string' ? ev.input.length : JSON.stringify(ev.input).length)
            const outLen = ev.error ? String(ev.error).length : (ev.output != null ? String(ev.output).length : 0)
            if (meter.countTool(ev.partID, inLen + outLen)) s.ctxUsedChars = meter.usedChars
          }
        } catch { /* 静默 */ }
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

// ── 回合(turn) ────────────────────────────────────────────────────────────
function addRetryNote(msg: string): void {
  addNote(msg, { retry: !!lastSend })
}

/**
 * 一轮问答。返回 true=传输层无异常。
 * POST 结果权威收尾:reply || 流式累积兜底(内网 bocomcode POST 空 body 不丢答案)。
 */
export async function turn(text: string, files?: any[] | null): Promise<boolean> {
  const ai = addAi()
  curAnswer = ai; curReason = null
  answerParts = new Map(); reasonParts = new Map()
  needAnswer = false; flushQueued = false
  s.busy = true; s.done = false
  lastSend = { text, files: files || null }
  if (draftKey) draftClear(localStorage, draftKey)   // 草稿发送即清
  meter.bump((text || '').length); s.ctxUsedChars = meter.usedChars
  let ok = true
  try {
    const reply = await BH()!.cardSend(text, files || [], null)
    flushStream()   // 末帧兜底:rAF 还没跑的增量先落上(马上要被 finalHtml 盖掉,主要为思考块)
    const raw = reply || joinParts(answerParts)
    const st = splitThink(raw)
    if (st.think) { const r = ensureReason(); r.body = [joinParts(reasonParts), st.think].filter(Boolean).join('\n'); r.open = true }
    const finalText = st.rest
    if (finalText) {
      ai.finalHtml = renderMarkdown(finalText)
      ai.raw = finalText
      ai.status = 'done'
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
export function submit(text: string, atts: { kind: string; name: string; path?: string; mime?: string; dataUrl?: string }[]): void {
  const v = text.trim()
  if (!v && !atts.length) return
  const docRefs = atts.filter((a) => a.kind === 'doc').map((a) => '- ' + a.path + '（' + a.name + '）').join('\n')
  const docNote = docRefs ? '【用户拖入了文档，需要时用 read_document 工具读取其内容】\n' + docRefs : ''
  const images = atts.filter((a) => a.kind === 'image').map((a) => ({ mime: a.mime, url: a.dataUrl, filename: a.name }))
  const full = [docNote, v].filter(Boolean).join('\n\n')
  const dispText = (v || (images.length ? '(图片)' : '(文档)')) + (atts.length ? ' · 附件 ' + atts.length : '')
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
  const p = new URLSearchParams(location.search)
  s.title = p.get('title') || '新对话'
  const initMsg = p.get('msg') || s.title          // msg 在场时发送内容不同于标题(fan-out)
  const dispMsg = p.get('disp') || initMsg         // disp 在场时用户气泡展示它
  const sid = p.get('sid') || ''
  s.embedded = p.get('embedded') === '1'
  s.chatEmbed = s.embedded && p.get('chat') === '1'
  try { purgeStaleDrafts(localStorage) } catch { /* 静默 */ }

  // wf/orch/shard 卡不走新页(接线在第二棒):给说明,不留死路
  if (p.get('wf') === '1' || p.get('wf') === 'true') s.unsupportedMode = 'wf'
  else if (p.get('orch')) s.unsupportedMode = 'orch'
  else if (p.get('shard')) s.unsupportedMode = 'shard'
  if (s.unsupportedMode) return

  s.busy = true
  if (!sid && (!s.embedded || (s.chatEmbed && p.get('msg')))) addUser(dispMsg)
  const bootItem = addAi()
  bootItem.plainText = sid ? '正在续接对话…' : (s.embedded && !s.chatEmbed) ? '正在连接调试助手…' : '正在启动引擎…（首次较慢，请稍候）'
  try {
    const r = await BH()!.cardInit(sid ? { sid, title: s.title } : { title: s.title })
    s.project = r.project || ''
    s.dir = r.dir || ''
    s.modelLabel = (r.model && (r.model.name || r.model.modelID)) || '默认模型'
    s.sessionId = r.sessionId || ''
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
