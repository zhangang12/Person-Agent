// 丢补丁回补波契约测试(node 环境,Mock window.BocomHermes):
//   ① compacting 闸防重入(摘要轮的轮末 finally 不再嵌套交棒)
//   ② 子 Agent 完成态权威轮询(subStatus fin → done,计时封顶)
//   ③ taskChild 只在非空时覆写(轮询空串不擦 SSE 真 id) + 终态配对 taskChild 优先(占位改嫁)
//   ④ 壳层直发注入按 origin 分形态(分片回流不冒充用户气泡)+ 分片派发块可辨识可跳转
//   ⑤ 分片回流事件不给主控的挂死探针续命(主控自己哑了要能被发现)
import { describe, it, expect, beforeAll } from 'vitest'

const sent: string[] = []
let streamCb: ((ev: any) => void) | null = null
let injectCb: ((p: any) => void) | null = null
let runCb: ((p: any) => void) | null = null
const runCalls: any[][] = []
const mock = {
  cardSend: async (text: string) => { sent.push(String(text)); return '摘要正文' },
  cardReinit: async () => ({ project: '', dir: '/d', model: null, sessionId: 'ses_new' }),
  cardUsage: async () => null,
  listModels: async () => [{ providerID: 'p', modelID: 'm', name: 'M', ctx: 1000 }],
  getSettings: () => ({ knobs: { ctxHandoffPct: 0.55, autoCompactMax: 5 } }),
  compactLogLast: async () => '',
  compactLogAppend: () => {},
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
