// ============================================================================
// shell 状态 store(模块单例:一个主窗口一份,与 toastStack 同款模式)
// 平移自 ui/shell.html 内联脚本的全部行为,逐条对照见 P1 报告功能清单:
//   会话 Map / 发卡收口 spawnChat / 钉出收回 / 拖出手势 / 收养(sessionList)
//   主进程广播(onFillInput/onShellView/onShellSpawn/onShellSessStatus/onSessionReattached)
//   引擎保活(onServeHealth + probeNow) / 编排并发 5s 轮询 / 快捷输入层
// 差异(报告标注):flashStatus → KToast;运行中关闭 → KDialog 确认;未读态补全。
// 会话色点按 sid hash 取色(blue/green/orange/purple,interactions.html 07 染色)。
// ============================================================================
import { reactive } from 'vue'
import { useToast } from '../components/toast'

const BH = (): any => (window as any).BocomHermes
const toast = useToast()

// webview preload 必须是绝对 file URL:本页在 ui/dist/,旧页在 ui/,preload 在仓库根
export const PRELOAD_URL = new URL('../../preload.js', location.href).href

export type ViewName = 'chat' | 'orch' | 'wf' | 'mail' | 'settings' | 'kb' | 'browser' | 'skills'
// 视图 webview 懒创建且保活(切走只是隐藏);相对路径:ui/dist/shell.html → ui/*.html
const VIEW_SRC: Record<string, string> = {
  orch: './orch.html?embed=1&mode=pipe',   // 任务编排(技能串接)
  wf: './orch.html?embed=1&mode=wf',       // 动态工作流(同页组件 wf 形态:复杂目标/模板/主控多层)
  mail: '../mailcenter.html?embed=1',
  settings: '../settings.html?embed=1',
  kb: '../knowledge.html?embed=1',   // 项目知识库(独立视图,从设置页抽出)
  skills: '../skills.html?embed=1',  // 技能中心(录制回放技能管理;录制执行在内嵌浏览器工作台)
}

export interface ChatEntry {
  key: string
  sid: string | null
  title: string
  wf: boolean
  busy: boolean
  /** 非活动会话跑完(busy→false)置未读,激活清除(设计稿会话状态补全) */
  unread: boolean
  /** 是否有 webview(收养条目=false,点击带 sid 重开) */
  hasWv: boolean
  src: string
}
interface ChatDetail { wcId: number | null; ready: boolean; pending: string; wv: any; cardId: string }

export const store = reactive({
  view: 'chat' as ViewName,
  /** 同屏分栏:对话旁边并排显示内嵌浏览器时,【对话】占的像素宽;0 = 关(浏览器与对话互斥,老行为)。
   *  存 localStorage,开着的时候切回对话视图不再隐藏浏览器 —— 一边聊一边看它点页面就是这个功能的全部意义。*/
  splitW: 0,
  visited: [] as ViewName[],          // 已创建过 webview 的视图(保活)
  chats: [] as ChatEntry[],
  activeKey: '',
  histItems: [] as Array<{ id: string; title?: string; project?: string }>,
  pinnedSids: new Set<string>(),      // 钉出中的 sid:历史区据此过滤;收回时经 session-reattached 回来
  sessLoading: true,                  // 收养(sessionList)未完成 → 侧栏骨架屏
  engine: { state: 'none' as 'none' | 'ok' | 'down', port: 0 },
  projName: '未选目录',
  projDir: '',
  wf: { running: 0, max: 0 },
  quick: { open: false, text: '' },
  confirmCloseKey: '',                // 运行中会话关闭确认闸(KDialog)
  draggingKey: '',                    // 拖出手势态(条目半透明)
  /** 活动会话的 ctx 真值(chat-ctx 回写):{key, tokens, limit, real, model};key 与 activeKey 对不上就忽略 */
  chatCtx: null as { key: string; tokens: number; limit: number; real: boolean; model: string } | null,
  /** 当前项目目录的 git 分支(git-branch IPC,10s 轮询;非 git 仓 = '') */
  gitBranch: '',
})

const details = new Map<string, ChatDetail>()
let chatSeq = 0

// 状态点按 sid hash 取色(会话染色,同源 interactions.html 07)
const DOTS = ['blue', 'green', 'orange', 'purple'] as const
export function dotColor(sid: string | null | undefined): (typeof DOTS)[number] {
  let h = 0
  const s = String(sid || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return DOTS[h % DOTS.length]
}

function removeEntry(key: string) {
  const i = store.chats.findIndex((x) => x.key === key)
  if (i >= 0) store.chats.splice(i, 1)
  details.delete(key)
}

// ── 视图切换(同时只显一个;webview 懒创建且保活)──
/** 上报"当前活动对话"的 wcId —— 内嵌浏览器的「发给 Agent」要注进你正在聊的这个会话。
 *  浏览器是会话的辅助面板,不该另有一个"调试助手"接住它(见 browser.js createShellBrowser)。 */
export function pushActiveChat(): void {
  try {
    const d = details.get(store.activeKey)
    BH()?.shellActiveChat?.(d && d.wcId != null ? d.wcId : null)
  } catch { /* 静默 */ }
}

export function showView(view: string) {
  if (view === 'browser') {
    // 内嵌浏览器:工作台 = shell 主窗口的嵌入式子窗(覆盖内容区),不再独立出窗
    try { BH()?.browserSplit?.({ chatW: 0, sideW: sideWNow() }) } catch (e) { /* 静默 */ }   // 全屏看浏览器:不给对话留宽
    try { BH()?.browserEmbed?.(true) } catch (e) { /* 静默 */ }
    store.view = 'browser' as ViewName
    return
  }
  // ★分栏开着 + 回到对话视图 → 浏览器【不隐藏】,让出左边那块继续显对话(同屏)。
  //   其余视图(编排/邮件/设置…)照旧隐藏:那些页面本来就要占满内容区,并排没有意义。
  if (store.splitW > 0 && view === 'chat') {
    try { BH()?.browserSplit?.({ chatW: store.splitW, sideW: sideWNow() }) } catch (e) { /* 静默 */ }
    try { BH()?.browserEmbed?.(true) } catch (e) { /* 静默 */ }
    store.view = 'chat' as ViewName
    return
  }
  try { BH()?.browserEmbed?.(false) } catch (e) { /* 静默 */ }   // 切走即隐藏(工作台保活,回来原样)
  const v = (['chat', 'orch', 'wf', 'mail', 'settings', 'kb', 'skills'].includes(view) ? view : 'chat') as ViewName
  store.view = v
  if (v !== 'chat' && !store.visited.includes(v)) store.visited.push(v)
}
export function viewSrc(v: ViewName) { return VIEW_SRC[v] || '' }

// ── 同屏分栏 ────────────────────────────────────────────────────────────────
// 【为什么值得做】浏览器与对话原来是主窗口里互斥的两个视图:看浏览器就看不见对话。
// 而"让 Agent 去页面上验一遍"这件事,价值恰恰在于【过程和结论在同一块屏幕上】——
// 你能看着它点,它的结论就在旁边;分屏切换等于把证据和判断拆开看。
const SPLIT_KEY = 'bh.splitW'
export function sideWNow(): number {
  const n = +(localStorage.getItem('bh.sbw') || 228)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 228
}
/** 报给主进程:对话占多宽、侧栏真实多宽(主进程原来把侧栏写死 228,拖过就错位)。 */
export function pushSplit(): void {
  try { BH()?.browserSplit?.({ chatW: store.splitW, sideW: sideWNow() }) } catch { /* 静默 */ }
}
/** 开/关同屏分栏。开:默认对话占内容区一半;关:浏览器隐回去,对话铺满。 */
export function toggleSplit(on?: boolean): void {
  const want = on == null ? store.splitW <= 0 : !!on
  if (want) {
    const saved = +(localStorage.getItem(SPLIT_KEY) || 0)
    const half = Math.round((window.innerWidth - sideWNow()) / 2)
    store.splitW = Math.max(360, saved > 0 ? saved : half)
  } else {
    store.splitW = 0
  }
  try { localStorage.setItem(SPLIT_KEY, String(store.splitW)) } catch { /* 静默 */ }
  if (store.splitW > 0) { pushSplit(); try { BH()?.browserEmbed?.(true) } catch { /* 静默 */ } }
  else { try { BH()?.browserSplit?.({ chatW: 0, sideW: sideWNow() }) } catch { /* 静默 */ } ; try { BH()?.browserEmbed?.(false) } catch { /* 静默 */ } }
}
/** 拖分隔条:只改宽度并即时报上去(落定时才写 localStorage,拖动过程不写)。 */
export function setSplitW(w: number, persist = false): void {
  store.splitW = Math.max(360, Math.round(w || 0))
  pushSplit()
  if (persist) { try { localStorage.setItem(SPLIT_KEY, String(store.splitW)) } catch { /* 静默 */ } }
}

// 视图 webview 元素引用(ShellApp ref 回调登记,备用)
export const viewWv: Record<string, any> = {}

// ── 历史区:最近 8 条(排除活动 sid 与钉出 sid),点击 = 带 sid 重开 ──
export function refreshHist() {
  let hist: any[] = []
  try { hist = (BH()?.getHistory?.()) || [] } catch (e) { /* 静默 */ }
  const act = new Set(store.chats.map((c) => c.sid).filter(Boolean))
  store.histItems = hist.filter((h) => h && h.id && !act.has(h.id) && !store.pinnedSids.has(h.id)).slice(0, 8)
}

function titleForSid(sid: string): string {
  try {
    const h = ((BH()?.getHistory?.()) || []).find((x: any) => x && x.id === sid)
    return (h && h.title) || ''
  } catch (e) { return '' }
}

// ── 发卡收口落点:主进程 spawnCard → shell-spawn {id,title,sid,msg,disp,orch,wf};
// 本地「新建对话」(仅 title)、历史点击(sid+title)、wf-open 聚焦(仅 sid)同走这里 ──
export function spawnChat(p: any = {}) {
  showView('chat')
  if (p.sid) {   // 同 sid 已开 → 激活;收养条目(无 webview)摘掉重建
    for (const c of [...store.chats]) {
      if (c.sid === p.sid) {
        if (c.hasWv) { activateChat(c.key); return }
        removeEntry(c.key)
        break
      }
    }
  }
  const key = 'c' + (++chatSeq)
  // query 字段与主进程 spawnCard 真窗口路径一一对应;chat=1 与工作台调试助手卡区分
  const q = new URLSearchParams({ embedded: '1', chat: '1', title: p.title || '新会话' })
  if (p.id) q.set('id', p.id)       // 卡 id:附件暂存(getCardFiles)与 wf 注册表(session-bind)都靠它对上
  if (p.sid) q.set('sid', p.sid)
  if (p.msg) q.set('msg', p.msg)
  if (p.disp) q.set('disp', p.disp)
  if (p.orch) q.set('orch', '1')
  if (p.wf) q.set('wf', '1')
  // run:编排面板的身份。丢了它 → 内嵌卡的 s.runId 恒空 → ChatApp 不命中面板分支 → RunPanel 永不挂载,
  // 用户看到的是一张空的 wf/orch 对话卡。主进程 spawnCard 已经把 run 放进 shell-spawn 载荷了,是这里漏组。
  // (run-panel-stub 直接 loadFile chat.html 绕过了 shell,所以这个洞目检覆盖不到)
  if (p.run) q.set('run', String(p.run))
  // cardImpl 双轨(P2a/P2b):默认 Vue 对话页(./chat.html,与 shell 同目录 dist;wf/orch 已于 P2b-3 迁移)
  let cardImpl = 'vue'
  try { cardImpl = ((BH()?.getSettings?.() || {}) as any).cardImpl || 'vue' } catch { /* 静默 */ }
  const useVue = cardImpl !== 'legacy'
  store.chats.push({
    key, sid: p.sid || null, title: p.title || '新会话',
    wf: !!p.wf, busy: false, unread: false, hasWv: true,
    src: (useVue ? './chat.html?' : '../card.html?') + q.toString(),
  })
  details.set(key, { wcId: null, ready: false, pending: '', wv: null, cardId: p.id || '' })
  refreshHist()
  activateChat(key)
}

// webview 挂接:Vue ref 回调(el=null = 摘出 DOM,guest webContents 随之销毁)
// 事件(dom-ready/ipc-message/destroyed)一律 addEventListener,与 legacy 同序同语义
export function bindWv(key: string, el: any) {
  const d = details.get(key)
  if (!d) return
  if (!el) { d.wv = null; return }
  if (d.wv === el) return
  d.wv = el
  el.addEventListener('dom-ready', () => {
    d.ready = true
    try {
      d.wcId = el.getWebContentsId()
      if (d.wcId != null && BH()?.sessionBind) BH().sessionBind(d.cardId, d.wcId)   // 登记 wcId↔卡(wf 注册表补 wcId)
      if (key === store.activeKey) pushActiveChat()   // 首个会话:切在前、绑在后 —— 只在切换时报会漏掉它
    } catch (e) { /* 静默 */ }
    if (d.pending) { const t = d.pending; d.pending = ''; fillChat(t) }
  })
  el.addEventListener('ipc-message', (ev: any) => {   // guest 经 sendToHost 回写绑定(cardBoundEmit)
    if (ev.channel === 'chat-ctx') {   // ctx 用量/模型回写(chatCtxEmit)→ 状态栏真值
      const m = ev.args && ev.args[0]
      if (m) store.chatCtx = { key, tokens: +m.tokens || 0, limit: +m.limit || 0, real: !!m.real, model: String(m.model || '') }
      return
    }
    if (ev.channel !== 'card-bound') return
    const m = ev.args && ev.args[0]
    if (!m) return
    const c = store.chats.find((x) => x.key === key)
    if (!c) return
    if (m.sid && c.sid !== m.sid) { c.sid = m.sid; refreshHist() }
    if (m.title) c.title = m.title
  })
  el.addEventListener('destroyed', () => {   // 兜底:webview 被销毁(非走 × 的路径)幂等收尾
    if (!store.chats.some((x) => x.key === key)) return   // 已摘(×/钉出路径) → 空转
    removeEntry(key)
    if (d.wcId != null) { try { BH()?.sessionClose?.(d.wcId) } catch (e) { /* 静默 */ } }
    if (store.activeKey === key) store.activeKey = ''
    refreshHist()
  })
}

export function activateChat(key: string) {
  const c = store.chats.find((x) => x.key === key)
  if (!c) return
  if (!c.hasWv) { spawnChat({ sid: c.sid, title: c.title }); return }   // 收养条目:带 sid 重开
  store.activeKey = key
  c.unread = false
  pushActiveChat()          // 切会话就上报:内嵌浏览器的「发给 Agent」要送到这一个
  showView('chat')
}

export function closeChat(key: string, force = false) {
  const c = store.chats.find((x) => x.key === key)
  if (!c) return
  if (c.busy && !force) { store.confirmCloseKey = key; return }   // 运行中 → KDialog 确认闸(见报告)
  const d = details.get(key)
  removeEntry(key)   // 先摘:webview destroyed 兜底与 sessionClose 双通道幂等
  if (d && d.wcId != null) { try { BH()?.sessionClose?.(d.wcId) } catch (e) { /* 静默 */ } }   // 卡关闭清理链:abort 会话/retire serve/forgetBusy
  if (store.activeKey === key) {
    store.activeKey = ''
    const first = store.chats[0]
    if (first) activateChat(first.key)
  }
  refreshHist()
}

// ── 钉出/收回:钉出 = 会话挪进独立迷你卡(真窗口,detach 语义,会话不 abort)──
export async function pinChat(key: string, pos?: { x: number; y: number }) {
  const c = store.chats.find((x) => x.key === key)
  if (!c) return
  if (!c.sid) { toast.info('会话尚未就绪,稍候再钉'); return }
  const arg: any = { sid: c.sid }
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) { arg.x = Math.round(pos.x); arg.y = Math.round(pos.y) }
  let r: any = null
  try { r = await BH()?.sessionPinOut?.(arg) } catch (e: any) { r = { ok: false, err: String((e && e.message) || e) } }
  if (!r || !r.ok) { toast.warning('钉出失败:' + ((r && r.err) || '未知错误')); return }
  store.pinnedSids.add(c.sid)
  removeEntry(key)   // 先摘:webview destroyed 兜底看到 key 不在即空转;会话由钉出窗自持
  if (store.activeKey === key) {
    store.activeKey = ''
    const first = store.chats[0]
    if (first) activateChat(first.key)
  }
  refreshHist()
}

// ── 拖出手势:条目 mousedown 记起点;>8px 进拖拽态(条目半透明 + 标题幻影贴光标),
// mouseup 以光标屏幕坐标钉出。document 级监听(Chromium 拖出窗外交互期间仍回报本窗)──
interface DragSess { key: string; x0: number; y0: number; dragging: boolean; ghost: HTMLElement | null }
let dragSess: DragSess | null = null
let suppressClick = false      // 拖拽收尾的那个 click 不算"点击切换"

export function sessMouseDown(key: string, ev: MouseEvent) {
  if (ev.button !== 0) return
  const t = ev.target as HTMLElement | null
  if (t && t.closest && (t.closest('.x') || t.closest('.pin') || t.closest('.k-menu-wrap'))) return
  suppressClick = false   // 新手势清掉上一轮的拖拽抑制(防陈旧标记误吞正常点击)
  dragSess = { key, x0: ev.screenX, y0: ev.screenY, dragging: false, ghost: null }
}
export function sessClick(key: string) {
  if (suppressClick) { suppressClick = false; return }
  activateChat(key)
}
document.addEventListener('mousemove', (ev) => {
  const d = dragSess
  if (!d) return
  if (!d.dragging) {
    if (Math.hypot(ev.screenX - d.x0, ev.screenY - d.y0) <= 8) return
    d.dragging = true
    const c = store.chats.find((x) => x.key === d.key)
    store.draggingKey = d.key
    d.ghost = document.createElement('div')
    d.ghost.className = 'dragGhost'
    d.ghost.textContent = '📌 ' + ((c && c.title) || '会话')
    document.body.appendChild(d.ghost)
    document.body.style.cursor = 'grabbing'
  }
  if (d.ghost) { d.ghost.style.left = (ev.clientX + 14) + 'px'; d.ghost.style.top = (ev.clientY + 12) + 'px' }
})
document.addEventListener('mouseup', (ev) => {
  const d = dragSess
  dragSess = null
  if (!d) return
  store.draggingKey = ''
  if (d.ghost) { try { d.ghost.remove() } catch (e) { /* 静默 */ } }
  document.body.style.cursor = ''
  if (d.dragging) {
    suppressClick = true   // 拖拽收尾的 click 不算"点击切换"(条目随即被钉出移除)
    pinChat(d.key, { x: ev.screenX, y: ev.screenY })
  }
})

// 把文本填进当前活动会话卡的输入框(#ci,textarea)并聚焦;无会话先建,未就绪先暂存 dom-ready 后补填
export function fillChat(t: string) {
  const c = store.activeKey ? store.chats.find((x) => x.key === store.activeKey) : null
  if (!c || !c.hasWv) {
    spawnChat(c ? { sid: c.sid, title: c.title } : { title: '新会话' })
    const nc = store.activeKey ? store.chats.find((x) => x.key === store.activeKey) : null
    const nd = nc && details.get(nc.key)
    if (nd) nd.pending = t
    return
  }
  const d = details.get(c.key)
  if (!d || !d.ready) { if (d) d.pending = t; return }
  const js = '(function(){var ci=document.getElementById("ci");if(ci){ci.value=' + JSON.stringify(String(t))
    + ';ci.focus();ci.dispatchEvent(new Event("input",{bubbles:true}))}})();void 0'
  try { d.wv.executeJavaScript(js).catch(() => {}) } catch (e) { /* 静默 */ }
}

// ── 快捷输入层:主进程热键 send('shell-quick-open') → 唤起;Enter = 隐藏 + 发卡收口同路径 ──
export function openQuick(text?: string) {
  store.quick.text = typeof text === 'string' ? text : ''
  store.quick.open = true
}
export function closeQuick() {
  store.quick.open = false
  store.quick.text = ''   // 关闭即清空:下次唤起是干净的输入条
}
export function submitQuick() {
  const t = store.quick.text.trim()
  closeQuick()
  // 与 shell-spawn {title,msg} 同一落点:title 截 20 字;card embedded 带 msg 自动首发
  if (t) spawnChat({ title: t.slice(0, 20), msg: t })
}

// ── 引擎保活:真源 = 主进程保活心跳聚合推送(serve-health);标题栏 chip 与状态栏灯同源 ──
function setEngine(st: { state: 'none' | 'ok' | 'down'; port?: number }) {
  const was = store.engine.state
  store.engine.state = st.state
  store.engine.port = st.port || 0
  // 失连(ok→down 跳变)给一次可恢复的提示(设计稿错误态:说清发生了什么 + 一个恢复动作)
  if (was === 'ok' && st.state === 'down') {
    toast.error('引擎心跳丢失,已失连', { action: { label: '重连', onClick: () => { try { BH()?.probeNow?.() } catch (e) { /* 静默 */ } } } })
  }
}

// ── 编排并发:主进程只读 IPC wf-running-count({running,max});5s 轮询,页面隐藏即停 ──
let wfTimer: ReturnType<typeof setInterval> | null = null
async function pollWf() {
  try {
    const r = await BH()?.wfRunningCount?.()
    if (r) { store.wf.running = r.running || 0; store.wf.max = r.max || 0 }
  } catch (e) { /* 静默 */ }
}
function startWfPoll() { if (wfTimer) return; pollWf(); wfTimer = setInterval(pollWf, 5000) }
function stopWfPoll() { if (wfTimer) { clearInterval(wfTimer); wfTimer = null } }
document.addEventListener('visibilitychange', () => { if (document.hidden) stopWfPoll(); else startWfPoll() })

// ── git 分支(git-branch IPC):10s 轮询 + 项目切换即刷;非 git 仓 → '' ──
let gitTimer: ReturnType<typeof setInterval> | null = null
export async function pollGitBranch() {
  try {
    const r = await BH()?.gitBranch?.()
    store.gitBranch = (r && r.branch) || ''
  } catch (e) { /* 静默 */ }
}
function startGitPoll() { if (gitTimer) return; pollGitBranch(); gitTimer = setInterval(pollGitBranch, 10000) }

// ── 装配:项目目录 / 主题 / 收养 / 主进程广播 / 引擎探测(一窗一次)──
let wired = false
export function wireShell() {
  if (wired) return
  wired = true
  const bh = BH()
  // 状态栏·项目目录(拿得到什么显示什么)
  try {
    const name = bh?.getProject?.()
    let dir = ''
    try { const s = bh?.getSettings?.(); dir = (s && s.projectDir) || '' } catch (e) { /* 静默 */ }
    store.projName = name || (dir ? dir.split(/[\\/]/).pop() : '未选目录')
    store.projDir = dir
  } catch (e) { /* 静默 */ }
  startGitPoll()   // 状态栏 ⎇ 分支(10s 轮询)
  // 主题:浅色单主题(锁定);广播恒为 light,幂等
  bh?.onTheme?.(() => { document.documentElement.dataset.theme = 'light' })

  // 收养:shell 重载前主进程里还活着的内嵌会话 → 先列进侧栏,点击带 sid 重开;
  // 钉出中的会话(独立窗活着)不收养 —— 记进 pinnedSids,收回时经 session-reattached 回来
  ;(async () => {
    try {
      const list = await (bh?.sessionList ? bh.sessionList() : Promise.resolve([]))
      for (const s of list || []) {
        if (!s || !s.sid) continue
        if (s.pinned) { store.pinnedSids.add(s.sid); continue }
        if (!s.embed) continue
        const key = 'c' + (++chatSeq)
        store.chats.push({ key, sid: s.sid, title: s.title || '对话', wf: !!s.wf, busy: !!s.busy, unread: false, hasWv: false, src: '' })
        details.set(key, { wcId: s.wcId != null ? s.wcId : null, ready: false, pending: '', wv: null, cardId: '' })
      }
    } catch (e) { /* 静默 */ } finally {
      store.sessLoading = false
      refreshHist()
    }
  })()

  // 热键/托盘带来文本(如 ⌃⇧V 剪贴板):聚焦对话视图,无会话则新建,dom-ready 后填入
  bh?.onFillInput?.((text: string) => { showView('chat'); fillChat(text) })
  bh?.onShellView?.((p: any) => { if (p && p.view) showView(p.view) })
  bh?.onShellSpawn?.((p: any) => spawnChat(p || {}))
  // 会话忙闲(card-busy 转发):按 wcId 找条目改状态点/转圈;跑完(busy→false)非活动会话置未读
  bh?.onShellSessStatus?.((p: any) => {
    if (!p) return
    for (const [key, d] of details) {
      if (d.wcId != null && d.wcId === p.wcId) {
        const c = store.chats.find((x) => x.key === key)
        if (c) {
          const was = c.busy
          c.busy = !!p.busy
          if (was && !c.busy && key !== store.activeKey) c.unread = true
        }
        break
      }
    }
  })
  // 收回:钉出窗被关 → 按 sid 重建 webview(shell-spawn {sid} 同路径)
  bh?.onSessionReattached?.((p: any) => {
    if (!p || !p.sid) return
    store.pinnedSids.delete(p.sid)
    spawnChat({ sid: p.sid, title: titleForSid(p.sid) || '对话' })
  })
  bh?.onShellQuickOpen?.((p: any) => openQuick(p && p.text))
  // 快捷输入层开着的时,焦点不在输入框也能 Esc
  document.addEventListener('keydown', (ev) => { if (store.quick.open && ev.key === 'Escape') closeQuick() })

  // 引擎:初始态走现有探针当场探一次 —— shell 顶层 webContents 没有卡会话,probeNow 多半回 null,
  // 此时保持「未连接」等首次心跳推送,不造假数据
  bh?.onServeHealth?.((p: any) => {
    if (!p) return
    setEngine(p.healthy && p.port ? { state: 'ok', port: p.port } : { state: 'down', port: p.port })
  })
  ;(async () => {
    try {
      const r = await (bh?.probeNow ? bh.probeNow() : Promise.resolve(null))
      if (r && r.port != null) setEngine(r.healthy ? { state: 'ok', port: r.port } : { state: 'down', port: r.port })
    } catch (e) { /* 静默 */ }
  })()

  startWfPoll()
  refreshHist()
}
