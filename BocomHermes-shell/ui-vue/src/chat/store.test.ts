// 丢补丁回补波契约测试(node 环境,Mock window.BocomHermes):
//   ① compacting 闸防重入(摘要轮的轮末 finally 不再嵌套交棒)
//   ② 子 Agent 完成态权威轮询(subStatus fin → done,计时封顶)
//   ③ taskChild 只在非空时覆写(轮询空串不擦 SSE 真 id) + 终态配对 taskChild 优先(占位改嫁)
import { describe, it, expect, beforeAll } from 'vitest'

const sent: string[] = []
let streamCb: ((ev: any) => void) | null = null
const mock = {
  cardSend: async (text: string) => { sent.push(String(text)); return '摘要正文' },
  cardReinit: async () => ({ project: '', dir: '/d', model: null, sessionId: 'ses_new' }),
  cardUsage: async () => null,
  listModels: async () => [{ providerID: 'p', modelID: 'm', name: 'M', ctx: 1000 }],
  getSettings: () => ({ knobs: { ctxHandoffPct: 0.55, autoCompactMax: 5 } }),
  compactLogLast: async () => '',
  compactLogAppend: () => {},
  onStream: (cb: (ev: any) => void) => { streamCb = cb },
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
const { s, compactCore, wireStream, pollSubStatus } = store

beforeAll(() => {
  wireStream()   // 捕获 onStream 回调,后续用 streamCb 直接喂事件
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
