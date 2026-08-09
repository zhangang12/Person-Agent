// 丢补丁回补波契约测试(node 环境,Mock window.BocomHermes):
//   ① compacting 闸防重入(摘要轮的轮末 finally 不再嵌套交棒)
//   ② 子 Agent 完成态权威轮询(subStatus fin → done,计时封顶)
//   ③ taskChild 只在非空时覆写(轮询空串不擦 SSE 真 id) + 终态配对 taskChild 优先(占位改嫁)
//   ④ 壳层直发注入按 origin 分形态(分片回流不冒充用户气泡)+ 分片派发块可辨识可跳转
//   ⑤ 分片回流事件不给主控的挂死探针续命(主控自己哑了要能被发现)
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

const sent: string[] = []
let streamCb: ((ev: any) => void) | null = null
let injectCb: ((p: any) => void) | null = null
let runCb: ((p: any) => void) | null = null
const runCalls: any[][] = []
// ⑦ 单会话审计用:cardSend 的可控回包 + 发送瞬间的回调钩子(用来在"摘要轮正在飞"的窗口里插队发消息)
let sendReply: string | null = null            // 非 null 时本次 cardSend 返回它(一次性,用完复位)
let onSend: ((t: string) => void) | null = null // 本次 cardSend 期间执行(一次性),模拟用户在回合中打字
const compactLogged: string[] = []
const mock = {
  cardSend: async (text: string) => {
    sent.push(String(text))
    if (onSend) { const f = onSend; onSend = null; f(String(text)) }
    if (sendReply !== null) { const r = sendReply; sendReply = null; return r }
    return '摘要正文'
  },
  cardReinit: async () => ({ project: '', dir: '/d', model: null, sessionId: 'ses_new' }),
  cardUsage: async () => null,
  listModels: async () => [{ providerID: 'p', modelID: 'm', name: 'M', ctx: 1000 }],
  getSettings: () => ({ knobs: { ctxHandoffPct: 0.55, autoCompactMax: 5 } }),
  compactLogLast: async () => '',
  compactLogAppend: (p: any) => { compactLogged.push(String((p && p.text) || '')) },
  onStream: (cb: (ev: any) => void) => { streamCb = cb },
  onCardInject: (cb: (p: any) => void) => { injectCb = cb },
  onRunSnapshot: (cb: (p: any) => void) => { runCb = cb },
  runApprove: async (...a: any[]) => { runCalls.push(['approve', ...a]); return { ok: true } },
  runNote: async (...a: any[]) => { runCalls.push(['note', ...a]); return { ok: true } },
  subStatus: async (_ids: string[]) => ({ ses_1: true }),
}
;(globalThis as any).window = { BocomHermes: mock }
// node 环境无 localStorage(草稿落盘在浏览器侧才有):给个最小 KV stub,行为与被测代码的 try/catch 路径一致
;(globalThis as any).localStorage = {
  _m: new Map<string, string>(),
  getItem(k: string) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k: string, v: string) { this._m.set(k, String(v)) },
  removeItem(k: string) { this._m.delete(k) },
  key(i: number) { return [...this._m.keys()][i] ?? null },
  get length() { return this._m.size },
}

// window 必须先于 store 加载就位(BH() 调用时才取,此处仅保险)
const store = await import('./store')
const { s, compactCore, wireStream, pollSubStatus, wireInject, shardMirror, wireRun, runApprove, runNote } = store

beforeAll(() => {
  wireStream()   // 捕获 onStream 回调,后续用 streamCb 直接喂事件
  wireInject()   // 捕获 onCardInject 回调,后续用 injectCb 直接喂壳层注入
  wireRun()      // 捕获 onRunSnapshot 回调:编排面板的只读投影
})

describe('① compacting 闸防重入(摘要轮轮末 finally 不重入交棒)', () => {
  it('wf 自动交棒全程只写一次交接单(摘要 1 次 + 续命 1 次)', async () => {
    s.wfMode = true
    s.modelKey = 'p/m'
    s.ctxLimitTokens = 1000
    s.ctxUsedChars = 900   // est 562/1000 ≈ 0.56 ≥ 0.55 交棒线
    sent.length = 0
    const ok = await compactCore({ wf: true, auto: true })
    expect(ok).toBe(true)
    // 没有 compacting 闸时:摘要轮 finally 的 maybeAutoCompact 会重入 compactCore,摘要提示词会再发一次
    const sumCalls = sent.filter((t) => t.includes('压缩成一份「接力摘要」'))
    expect(sumCalls.length).toBe(1)
    // 交棒后续命棒(恢复执行)正常发出
    expect(sent.some((t) => t.includes('恢复摘要里的计划清单'))).toBe(true)
    s.wfMode = false
  })
})

describe('② 子 Agent 权威轮询(subStatus fin → done)', () => {
  it('轮询报 fin 的子 Agent 被勾掉(计时封顶)', async () => {
    streamCb!({ sub: true, agentId: 'ses_1', agentName: '调研', kind: 'text', text: 'hello' })
    const a = s.subAgents.find((x) => x.id === 'ses_1')
    expect(a && !a.done).toBe(true)
    pollSubStatus()   // 5s 节流首拍即发;subStatus mock 报 ses_1 fin=true
    await new Promise((r) => setTimeout(r, 0))
    const a2 = s.subAgents.find((x) => x.id === 'ses_1')
    expect(a2 && a2.done).toBe(true)
  })
})

describe('③ taskChild 只认非空覆写 + 终态配对 taskChild 优先', () => {
  it('轮询通道空串不擦掉 SSE 带来的真 id', () => {
    streamCb!({ kind: 'tool', partID: 'pt1', text: 'task', status: 'running', taskChild: 'ses_9', input: { description: 'd' } })
    streamCb!({ kind: 'tool', partID: 'pt1', text: 'task', status: 'completed', taskChild: '', output: 'done' })
    const tool = s.items.find((i: any) => i.kind === 'tool' && i.partID === 'pt1') as any
    expect(tool && tool.taskChild).toBe('ses_9')
  })
  it('终态带来 taskChild:本 task 的占位改嫁真 id 并勾掉', () => {
    streamCb!({ kind: 'tool', partID: 'pt2', text: 'task', status: 'running', taskDesc: '勘察' })   // 无 id → 占位 ph:pt2
    streamCb!({ kind: 'tool', partID: 'pt2', text: 'task', status: 'completed', taskChild: 'ses_10', output: 'done' })
    const a = s.subAgents.find((x) => x.id === 'ses_10')
    expect(a && a.done).toBe(true)
    expect(s.subAgents.some((x) => x.id === 'ph:pt2')).toBe(false)   // 占位已改嫁,不留双行
  })
})

describe('④ 壳层直发注入按 origin 分形态(分片回流不冒充用户气泡)', () => {
  it('origin=orch 的注入带 origin/shardId(渲染成分片回流条,可点跳该片)', () => {
    injectCb!({ text: '<主控进度>分片「勘察认证」已完成 (1/4)…</主控进度>', disp: '分片 1/4 已完成:勘察认证', origin: 'orch', shardId: '17' })
    const it0 = [...s.items].reverse().find((i: any) => i.kind === 'user') as any
    expect(it0.text).toBe('分片 1/4 已完成:勘察认证')
    expect(it0.origin).toBe('orch')
    expect(it0.shardId).toBe('17')
  })
  it('origin=system 的壳层提醒同样不算用户说的话', () => {
    injectCb!({ text: '(系统提醒:单次 read 读入过多)', disp: '上下文提醒', origin: 'system' })
    const it0 = [...s.items].reverse().find((i: any) => i.kind === 'user') as any
    expect(it0.origin).toBe('system')
  })
  it('无 origin(浏览器/邮件等用户动作触发的注入)仍是普通用户气泡', () => {
    injectCb!({ text: '帮我看看这个页面', disp: '帮我看看这个页面' })
    const it0 = [...s.items].reverse().find((i: any) => i.kind === 'user') as any
    expect(it0.origin).toBe(undefined)
  })
})

describe('④b 分片派发工具块:名/标题/跳转 id 从入参与回执抠出', () => {
  it('带 parentTag → 名=派发分片、标题=该片目标、shardId=回执里的卡 id', () => {
    streamCb!({ kind: 'tool', partID: 'pt3', text: 'run_workflow', status: 'running', input: { goal: '[orch:a3f9] 勘察认证模块', parentTag: 'a3f9' } })
    streamCb!({ kind: 'tool', partID: 'pt3', text: 'run_workflow', status: 'completed', input: { goal: '[orch:a3f9] 勘察认证模块', parentTag: 'a3f9' }, output: '分片已派出,id=17。它是【无人值守隐藏工人】…' })
    const tool = s.items.find((i: any) => i.kind === 'tool' && i.partID === 'pt3') as any
    expect(tool.name).toBe('派发分片')
    expect(tool.title).toBe('勘察认证模块')
    expect(tool.shardId).toBe('17')
  })
  it('无 parentTag(对话卡直接升格)→ 仍是「升格 → 动态工作流」', () => {
    streamCb!({ kind: 'tool', partID: 'pt4', text: 'run_workflow', status: 'running', input: { goal: '整理架构' } })
    const tool = s.items.find((i: any) => i.kind === 'tool' && i.partID === 'pt4') as any
    expect(tool.name).toBe('升格 → 动态工作流')
    expect(tool.title).toBe('整理架构')
  })
})

describe('⑤ 分片回流只进镜像缓冲,不进主控对话流、不给挂死探针续命', () => {
  it('shardRoot 事件进该片缓冲,主控 feed 与侧边栏不沾', () => {
    const feedN = s.items.length, subN = s.subAgents.length
    streamCb!({ kind: 'tool', partID: 'sp1', text: 'read', status: 'completed', shardRoot: '17', output: '文件内容' })
    streamCb!({ kind: 'text', partID: 'sp2', text: '分片的正文', shardRoot: '17', sub: true, agentName: '深读者' })
    expect(s.items.length).toBe(feedN)
    expect(s.subAgents.length).toBe(subN)
    const m = shardMirror('17')
    expect(m && m.size).toBe(2)
    expect(m!.get('sp2')!.sub).toBe(true)   // 子 Agent 标记留着:分片视图据此缩进 + 挂「↳ 名字」
  })
})

describe('⑥ 规划闸兜底判据(主控卡的派发闸不许静默死锁)', () => {
  it('轮末累计 turnsDone —— WfBar 据此判断"跑过回合却始终没挂出批准条"', async () => {
    const before = s.turnsDone
    await store.turn('随便问一句')
    expect(s.turnsDone).toBe(before + 1)
  })
  it('run_workflow 不算实质执行(不许自动撤闸)—— 撤闸 = 人审闸被静默取消,比死锁更糟', () => {
    s.orchMode = true
    const approvedBefore = s.planApproved
    streamCb!({ kind: 'tool', partID: 'pg1', text: 'run_workflow', status: 'completed', input: { goal: '[orch:a3f9] x', parentTag: 'a3f9' }, output: '分片已派出,id=91。' })
    expect(s.planApproved).toBe(approvedBefore)   // 没有被 wfExecSeen 分支自动放行
    s.orchMode = false
  })
})

describe('⑥ 编排面板:只读投影 + 显式动作(不再靠嗅探)', () => {
  it('run-snapshot 推来即成为 s.run,且只读(不本地改状态)', () => {
    runCb!({ id: 'R9', goal: '摸清仓库', phase: 'awaiting-approval', wave: 1,
      counts: { total: 2, verified: 0, running: 0, queued: 0, pending: 2, failed: 0, skipped: 0 },
      nodes: [{ id: 'a', title: '甲', kind: 'work', state: 'pending', attempt: 0, patches: 0, wave: 1, cardId: null, reason: '', droppedReason: '', files: [], deps: [], exitReport: [] }],
      decisions: [], pendingDecision: null, ask: null, result: { summary: '', deliverables: [], gaps: [] }, notes: [], budget: {} })
    expect(s.run && s.run.phase).toBe('awaiting-approval')
    expect(s.runId).toBe('R9')
  })
  it('★批准/插话都是 IPC 显式转移,本地不回写 phase(唯一真相源在主进程)', async () => {
    runCalls.length = 0
    const before = s.run!.phase
    await runApprove()
    await runNote('先把甲收口')
    expect(runCalls.map((c) => c[0])).toEqual(['approve', 'note'])
    expect(runCalls[0][1]).toBe('R9')            // runId 随调用带上
    expect(runCalls[1][2]).toBe('先把甲收口')
    expect(s.run!.phase).toBe(before)            // 本地一个字段都没改
  })
})

// ── ⑦ 单会话审计回归(压缩/队列/看门狗)─────────────────────────────────────
// 四条都要"没修就红":每条注掉对应修复都会立刻失败,不是恰好绕开的绿。
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) }

describe('⑦ 压缩续聊的三个坑(摘要冒领 / 排队消息蒸发 / 失败不放水)', () => {
  it('★摘要轮空答:判失败,不把上一条普通回答冒领成交接单', async () => {
    s.ready = true; s.wfMode = false
    sent.length = 0; compactLogged.length = 0
    // 先跑一轮普通问答,feed 里留下一条【有正文】的 ai —— 这正是旧代码会误抓的那条
    sendReply = '这是一条普通回答,不是交接单'
    store.submit('随便问一句', [])
    await settle()
    expect(s.items.some((i: any) => i.kind === 'ai' && i.raw === '这是一条普通回答,不是交接单')).toBe(true)

    sendReply = ''   // 摘要轮空答(网关静默):ai 条目照样新增,但 raw 为空
    const ok = await compactCore({})
    await settle()
    // 旧代码 `reverse().find(i => i.kind==='ai' && !!i.raw)` 会跳过这条空摘要、抓住上面那条普通回答,
    // 于是 ok=true、普通回答被当交接单落盘并注入下一棒。锚定"本轮新增条目"后,空就是空。
    expect(ok).toBe(false)
    expect(compactLogged.some((t) => t.includes('这是一条普通回答'))).toBe(false)
  })

  it('★压缩期间打的字不蒸发:气泡还在,压缩完自动发出去', async () => {
    s.ready = true; s.wfMode = false
    sent.length = 0
    onSend = () => { store.submit('压缩期间打的字', []) }   // 摘要轮正在飞时插队:compacting=true → 入队
    const ok = await compactCore({})
    await settle()
    expect(ok).toBe(true)
    // 旧代码:resetConversation() 里 s.items=[] 连气泡一起清 + queue.length=0 连正文一起清 → 这条消息人间蒸发
    expect(sent).toContain('压缩期间打的字')
    const bub = s.items.find((i: any) => i.kind === 'user' && i.text === '压缩期间打的字') as any
    expect(bub).toBeTruthy()
    expect(bub.queued).toBe(false)   // 已转正发出,不该还挂着"排队中"
  })

  it('★压缩失败也要放水:排队消息不会永久卡在队列里', async () => {
    s.ready = true; s.wfMode = false
    sent.length = 0
    sendReply = ''                                              // 摘要空答 → 走失败 return false
    onSend = () => { store.submit('失败路径排的队', []) }
    const ok = await compactCore({})
    await settle()
    expect(ok).toBe(false)
    // 旧代码:失败分支直接 return,finally 只清 compacting 不 drain;而 drain 首行按 compacting 短路,
    // 成功路径那次 drain 也是空转 → 这条消息要等用户【再发一条】才顺带被带出来,不发就一直挂着。
    expect(sent).toContain('失败路径排的队')
  })
})

describe('⑦b 看门狗轮末闸:摘要轮里不许再套一层注入', () => {
  it('★压缩摘要轮收尾时,绕圈提醒不注入(轮末链另三个注入点都有这道闸,只有它漏了)', async () => {
    s.ready = true; s.wfMode = true
    // 连续两轮读同一个文件 → wdRounds 攒到 2(阈值 watchdogRounds 默认 3,差最后一脚)
    for (let k = 0; k < 2; k++) {
      onSend = () => { streamCb!({ kind: 'tool', partID: 'wd' + k, text: 'read', status: 'running', input: { filePath: '/同一个文件.ts' } }) }
      store.submit('第 ' + k + ' 轮', [])
      await settle()
    }
    sent.length = 0
    // 第三脚踩在【摘要轮】上:这一轮同样读同一个文件,轮末 wdCheck 判定成立。
    // 没闸的话它会 turn() 注入绕圈提醒 —— 而此刻正在压缩,等于往摘要轮里套嵌套回合
    // (兄弟闸 maybeContinueNudge 的注释原话:摘要泡被顶成空气泡,实测死循环)。
    onSend = () => { streamCb!({ kind: 'tool', partID: 'wd2', text: 'read', status: 'running', input: { filePath: '/同一个文件.ts' } }) }
    await compactCore({ wf: true })
    await settle()
    expect(sent.some((t) => t.includes('检测到你可能在绕圈'))).toBe(false)
    s.wfMode = false
  })
})

// ── ⑦g boot 失败不是死路:能重连,排队的消息随后自动发出 ────────────────────
// 病灶:s.ready 是全仓唯一的发信闸,而它只有 cardInit 成功那一支上的一个赋值点;catch 里只写 s.busy=false。
// 于是 cardInit 一抛错,s.ready 永久钉死 false:submit 每条都入队,drain 首行 !ready 直接返回,
// 页面内没有任何路径能救回来 —— 只能关卡重开(连队列里的正文一起没,会话没建起来 draftKey 是空的,草稿也存不下)。
// 而且 s.busy===false 让输入框显示的是"发送"而不是停止图标,用户完全看不出被挡下了。
describe('⑦g cardInit 失败后可「重试连接」,排队消息不丢', () => {
  it('★首次 boot 抛错 → 标记 bootFailed + 挂出重试钮;重连成功后 ready 恢复且队列自动发出', async () => {
    ;(globalThis as any).location = { search: '' }
    let boom = true
    ;(mock as any).cardInit = async () => {
      if (boom) throw new Error('serve down')
      return { project: '', dir: '/d', model: null, sessionId: 'ses_boot' }
    }
    store.resetConversation()
    s.ready = false; s.busy = false; s.wfMode = false; s.ctxLimitTokens = 0
    await store.boot()
    await settle()
    expect(s.ready).toBe(false)
    expect(s.bootFailed).toBe(true)
    // 自救入口必须真的挂出来(修前 catch 里只有 s.busy=false,feed 上没有任何可点的东西)
    expect(s.items.some((i: any) => i.kind === 'note' && i.retryBoot === true)).toBe(true)

    // 没连上时打的字:照旧排队(正文保住),但要有一条说人话的提示,不能闷头堆气泡
    sent.length = 0
    store.submit('没连上时打的一句话', [])
    await settle()
    expect(sent).not.toContain('没连上时打的一句话')   // 确实没发出去
    expect(s.items.some((i: any) => i.kind === 'note' && String(i.text).includes('这条先排着'))).toBe(true)

    boom = false
    await store.retryBoot()
    await settle()
    expect(s.ready).toBe(true)
    expect(s.bootFailed).toBe(false)
    expect(sent).toContain('没连上时打的一句话')   // 重连后队列自动放水
  })
  it('★重试不重复铺首条用户气泡(它在 cardInit【之前】就进 feed 了,重跑一次就成两条)', () => {
    // 注:wire* 更不能重跑 —— 那是 onStream/onCardInject 的注册点,重复注册会让同一条流式正文渲染两遍。
    // 所以 retryBoot 只调 bootSession,不调 boot;这条断言守的是 bootSession 内部的 retry 分支。
    // 按固定文案断言,不用 s.title —— 首轮成功后 maybeAutoTitle() 会把卡名改成首条消息前 24 字,
    // 到这一步 s.title 已经不是当初铺气泡时的那个值了(search 为空 → 当时的 dispMsg 是默认标题「新对话」)。
    const first = s.items.filter((i: any) => i.kind === 'user' && i.text === '新对话')
    expect(first.length).toBe(1)
  })
})

// ── ⑦f 挂死探针按 partID 判活 ─────────────────────────────────────────────
// 病灶:渲染端用一个【标量】只跟上一个事件比签名,而主进程 pollTurnParts 每 1.2s 把本轮全部 part 原样重喂,
// 事件序列成了 A,B,A,B… → 每次都判"有新内容" → 计时被无限续命。回合只要有 ≥2 个 part(一段思考+一个工具就够),
// 90s/5min 提示永不触发 —— 正好是它要治的那个场景。主进程侧同款病灶早用 per-partID 的 si.partSigs 修掉了,这边只抄了一半。
describe('⑦f 挂死探针:轮询把 ≥2 个 part 原样重喂不许续命', () => {
  const A = { kind: 'reasoning', partID: 'hp_a', text: '在想' } as any
  const B = { kind: 'tool', partID: 'hp_b:tool', text: 'read', status: 'running', output: '' } as any
  it('★A,B 首次算活;第二遍原样重喂两条都不算活(标量版这里会判"活" → 红)', () => {
    expect(store.markStreamLive(A)).toBe(true)
    expect(store.markStreamLive(B)).toBe(true)
    expect(store.markStreamLive(A)).toBe(false)
    expect(store.markStreamLive(B)).toBe(false)
    expect(store.markStreamLive(A)).toBe(false)   // 轮询一直重喂,一直不算活
  })
  it('内容真变了照常算活(别把探针修成永远不续命)', () => {
    expect(store.markStreamLive({ ...B, output: '读到了内容' })).toBe(true)
    expect(store.markStreamLive({ ...A, text: '在想更多' })).toBe(true)
  })
})

// ── ⑦d 长任务防停:熔断之后不许自己复活 ───────────────────────────────────
// 病灶:熔断分支贴完"不再自动催"就把 contNudgeN 清了 0 —— 只挡住这一轮,下个能催的轮末又从 0 起跳,
// 于是变成"催 3 次歇一轮再催 3 次",note 里那句承诺是假的(wf 卡上等于每轮末永久注入)。
// 旧页 ui/card.html:1131 同一句 addNote 后面直接 return、不清零,熔断本来就是粘的 —— 这是 Vue 平移时加错的一行。
describe('⑦d 防停熔断是粘的,不是每 3 次歇一轮', () => {
  const feedTodo = (n: number, tag: string) => {
    // 喂一份 todo:n 项未完(latestOpenTodos 据此计算);同一 partID 覆盖更新
    streamCb!({
      kind: 'tool', partID: 'cn_' + tag, text: 'todowrite', status: 'completed',
      input: { todos: Array.from({ length: n }, (_, i) => ({ content: '第' + i + '项', status: 'pending' })) },
    })
  }
  it('★连催 3 次后彻底闭嘴:后续轮末既不催也不重复贴熔断提示(修前第 4 轮起又催 → 红)', async () => {
    s.ready = true; s.wfMode = true
    // ★关掉自动交棒:前面用例把 ctxLimitTokens 留成了 1000,水位到线会触发 compactCore →
    //   resetConversation() 把熔断复位(这是有意设计:新一棒重新开始),但会把本用例要测的东西盖掉。
    s.ctxLimitTokens = 0
    store.resetConversation()   // 把上面用例留下的 contNudge* 状态清干净
    feedTodo(2, 'a')
    sent.length = 0
    // 连跑 8 个回合:每轮末 maybeContinueNudge 都有机会催。todo 一直不动 → 永远没有"进展"
    for (let k = 0; k < 8; k++) { store.submit('第 ' + k + ' 轮', []); await settle() }
    const nags = sent.filter((t) => t.includes('任务还没完成 —— todo 还有'))
    // 修前:3 次一组、清零、再 3 次…… 8 轮里会催 5~6 次。修后:总共只催 3 次,之后彻底停
    expect(nags.length).toBe(3)
    const offNotes = s.items.filter((i: any) => i.kind === 'note' && String(i.text).includes('不再自动催'))
    expect(offNotes.length).toBe(1)   // 那句"不再自动催"也只贴一次,不是每轮重复贴
    s.wfMode = false
  })
  it('未完项变少(真有进展)→ 熔断复活,可以再催', async () => {
    s.ready = true; s.wfMode = true
    s.ctxLimitTokens = 0   // 同上:隔离自动交棒
    store.resetConversation()
    feedTodo(3, 'b')
    for (let k = 0; k < 5; k++) { store.submit('推进 ' + k, []); await settle() }   // 先催满 3 次并熔断
    sent.length = 0
    feedTodo(1, 'b')   // 3 项 → 1 项:有进展
    store.submit('又推进了', []); await settle()
    expect(sent.some((t) => t.includes('任务还没完成 —— todo 还有'))).toBe(true)
    s.wfMode = false
  })
})

describe('⑦e 普通卡的"继续"按钮是发新消息,不是重发上一条', () => {
  it('★note 带 contMsg(接着上次停下的地方),而不是 retry(把上一条原样重发,模型从头再做一遍)', async () => {
    s.ready = true; s.wfMode = false
    store.resetConversation()
    streamCb!({
      kind: 'tool', partID: 'cn_c', text: 'todowrite', status: 'completed',
      input: { todos: [{ content: '甲', status: 'pending' }, { content: '乙', status: 'pending' }] },
    })
    store.submit('帮我做甲和乙', []); await settle()
    const note = s.items.find((i: any) => i.kind === 'note' && String(i.text).includes('Agent 提前停下了')) as any
    expect(note).toBeTruthy()
    expect(note.retry).toBe(false)                       // retry=重发上一条用户消息 → 从头再做一遍,与文案相反
    expect(String(note.contMsg)).toContain('接着上次停下的地方')
  })
})

// ── ⑦c 结构契约:轮末系统注入必须走唯一闸门 ────────────────────────────────
// 行为测试只能证明"今天这几个注入点有闸";这条证明的是"以后新加的也必须有"。
// 病根就是同一道闸散成 5 份各抄一遍:抄对 3 份、漏掉 2 份(wdCheck / maybePlanGate),
// 而漏掉的那两份没有任何测试会发现。收敛成 canInject()/injectTurn() 之后,用源码断言钉住这个收敛。
describe('⑦c 结构契约:5 个轮末注入点不许绕开 canInject/injectTurn', () => {
  const GATED = ['maybePlanGate', 'wdCheck', 'maybeDelegateNudge', 'maybeContinueNudge', 'maybeWfProduceNag']
  const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
  // 注释要先剥掉:这些函数的注释里本来就在讲 "turn()"(例如 wdCheck 解释 doCompact 靠 turn() 发摘要),
  // 不剥就会把说明文字当成违规调用。按行切,只砍【引号外】的 //(注入提示词是单引号长串,别把串里的内容误砍)。
  const stripComments = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((ln) => {
      for (let i = 0; i < ln.length - 1; i++) {
        if (ln[i] === '/' && ln[i + 1] === '/') {
          const quotes = (ln.slice(0, i).match(/'/g) || []).length
          if (quotes % 2 === 0) return ln.slice(0, i)
        }
      }
      return ln
    }).join('\n')
  const bodyOf = (name: string) => {
    const at = src.indexOf('function ' + name + '(')
    if (at < 0) throw new Error('找不到函数 ' + name + '(改名了?契约测试要同步更新)')
    const end = src.indexOf('\n}', at)
    return stripComments(src.slice(at, end))
  }
  for (const name of GATED) {
    it(name + ' 经闸门起回合,不直调 turn()', () => {
      const body = bodyOf(name)
      // 直调 turn( = 绕开闸门(injectTurn( 不匹配:前面是字母,\b 边界挡住)
      expect(/(?<![A-Za-z_])turn\s*\(/.test(body), name + ' 里出现了直调 turn(,应改用 injectTurn(').toBe(false)
      expect(/canInject\(\)|injectTurn\(/.test(body), name + ' 既没过 canInject 也没走 injectTurn').toBe(true)
    })
  }
})

