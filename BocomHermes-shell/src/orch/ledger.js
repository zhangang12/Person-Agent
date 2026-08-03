'use strict'
// ── 编排账本(契约 §5)· 纯逻辑,零依赖 ───────────────────────────────────────
// 职责:一个 run 的四本账 —— facts(已确认事实)/ open(未决)/ assumptions(假设)/ gaps(缺口)。
//
// 【为什么要有它】现状是把账序列化成中文塞进主控卡,指望模型每轮把"哪条事实来自哪片、哪条还没定"
// 重述一遍。模型一转述就丢锚点(第 3 波之后 file:行号 基本掉光),后续决策再想回原文核对已经找不着门。
// 账住在代码里,决策器只读不写 —— 这是"代码保证信息不丢、模型保留动作权"里【不丢】的那一半。
//
// 【只增不改】条目一旦入账就不再被编辑:去重靠归一化键在【入账前】拦,不去回头改老条目。
//   唯一的例外是 resolveOpen(未决被解决 → 移出 open),那是状态迁移不是篡改。
//
// 【不原地改】每个 add* 都返回【新的 ledger 对象】(四个数组也是新数组)。
//   ★ 这条是被 run.js 逼出来的:applyEvent 必须是纯函数、"新 run 是新对象",账本是 run 的一部分,
//     这里原地 push 一下,那条不变式就在这儿破一个洞,replay 立刻对不上。
//
// 【不读时钟】at 一律由调用方从 ev.at 带进来。本模块不出现取当前时间的调用 —— 同一串事件必须重放出同一份账。
//
// 【为什么去重要归一化】同一条事实会从两个来源进账(n2 的报告里写一次、replan 的 facts 里又写一次),
//   模型两次转述必然差一个逗号或一个空格。按原文去重 = 等于没去重,账本 20 条里 12 条是同义反复,
//   下一轮 replan 的输入被这堆重复挤爆。所以按【去空白 + 去标点 + 小写】后的键去重。

const CAP = 200                       // 每本账的条目上限
const BOOKS = ['facts', 'open', 'assumptions', 'gaps']

// 归一化去重键:去掉一切空白与常见中英标点、英文转小写。
// 刻意【不】动 / 与 \ —— 锚点路径(src/a.ts)靠它们保持可读;: 与 . 会被去掉,对去重无害。
// 副作用清楚在案:'foo_bar' 与 'foobar' 会被判成同一条(_ 与 - 也在去除集里)——
// 账本装的是中文事实句而不是标识符,这个误合并的代价远小于满账同义反复。
function normKey(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，,。.、；;：:！!？?…“”"'‘’（）()【】\[\]《》〈〉「」『』<>~～—－\-_·`|]/g, '')
}

function toList(items) {
  if (items === null || items === undefined) return []
  return Array.isArray(items) ? items : [items]
}

function toAnchors(v) {
  if (v === null || v === undefined) return []
  const list = Array.isArray(v) ? v : String(v).split(/[,，、;；\n]/)
  const out = []
  for (const a of list) {
    const s = String(a === null || a === undefined ? '' : (typeof a === 'object' ? (a.anchor || a.path || a.file || '') : a)).trim()
    if (s && out.indexOf(s) < 0) out.push(s)
    if (out.length >= 20) break        // 锚点是给人回原文用的,20 条够定位;再多是模型在灌水
  }
  return out
}

// 一条入账记录:{ text, anchors, src, at }(契约 §5 的形状,不加不减)。
// 兼容两种写法:字符串(open/gaps 常见)、对象。gaps 允许 {nodeId,kind,detail} 这种结构化写法 ——
// 拼成一句人话当 text,同时把 nodeId/kind 原样留着:渲染端要按节点归组,丢了就得回头去 nodes 里反查。
function entryOf(item, src, at) {
  const o = (item && typeof item === 'object') ? item : { text: item }
  let text = String(o.text === null || o.text === undefined ? '' : o.text).trim()
  if (!text) {
    const parts = [o.nodeId ? String(o.nodeId) : '', o.kind ? String(o.kind) : '', o.detail ? String(o.detail) : '']
    text = parts.filter(Boolean).join(': ')
  }
  const e = {
    text,
    anchors: toAnchors(o.anchors),
    src: String((o.src || o.source || src || '') === null ? '' : (o.src || o.source || src || '')),
    at: typeof o.at === 'number' ? o.at : (typeof at === 'number' ? at : 0),
  }
  if (o.nodeId) e.nodeId = String(o.nodeId)
  if (o.kind) e.kind = String(o.kind)
  return e
}

// ★ 不截断 text:长事实的锚点常挂在句尾,截了正好把锚点切掉。
//   显示长度归 render.js 管 —— 账本存原文,渲染端决定给模型看多少。
function clone(ledger) {
  const src = (ledger && typeof ledger === 'object') ? ledger : {}
  const out = {}
  for (const k of Object.keys(src)) out[k] = src[k]      // 保留调用方挂的额外字段,不做减法
  for (const b of BOOKS) out[b] = Array.isArray(src[b]) ? src[b].slice() : []
  return out
}

function addTo(ledger, book, items, src, at) {
  const L = clone(ledger)
  const list = L[book]
  const seen = new Set()
  for (const e of list) seen.add(normKey(e && e.text))
  for (const it of toList(items)) {
    const e = entryOf(it, src, at)
    const key = normKey(e.text)
    if (!key || seen.has(key)) continue                   // 空条与重复条直接不入账(不入账 = 不需要回头改)
    seen.add(key)
    list.push(e)
  }
  // 超上限保留【最新】200 条:账本是喂给 replan 的输入,新事实才是决策依据;
  // 被挤掉的老条目在各节点的 result 与 decisions 留痕里仍可回溯,不是真的没了。
  if (list.length > CAP) L[book] = list.slice(list.length - CAP)
  return L
}

function addFacts(ledger, items, src, at) { return addTo(ledger, 'facts', items, src, at) }
function addOpen(ledger, items, src, at) { return addTo(ledger, 'open', items, src, at) }
function addGaps(ledger, items, src, at) { return addTo(ledger, 'gaps', items, src, at) }
function addAssumptions(ledger, items, src, at) { return addTo(ledger, 'assumptions', items, src, at) }

// 决策说某条未决已解决 → 移出 open。
// 匹配放宽一档:归一化后相等【或】互相包含(短的那条 ≥6 个归一化字符才算)——
// 模型回述未决项时几乎不会一字不差,严格相等等于这个接口永远不生效,open 只进不出会把 replan 输入撑爆。
function resolveOpen(ledger, texts) {
  const L = clone(ledger)
  const keys = toList(texts).map((t) => normKey((t && typeof t === 'object') ? t.text : t)).filter(Boolean)
  if (!keys.length) return L
  L.open = L.open.filter((e) => {
    const k = normKey(e && e.text)
    if (!k) return true
    return !keys.some((q) => {
      if (q === k) return true
      const short = q.length <= k.length ? q : k
      const long = q.length <= k.length ? k : q
      return short.length >= 6 && long.indexOf(short) >= 0
    })
  })
  return L
}

function size(ledger) {
  const L = (ledger && typeof ledger === 'object') ? ledger : {}
  let n = 0
  for (const b of BOOKS) n += Array.isArray(L[b]) ? L[b].length : 0
  return n
}

module.exports = { addFacts, addOpen, addGaps, addAssumptions, resolveOpen, size }

// ── 最小验证(独立可跑)──────────────────────────────────────────────────────
// 整段贴进 node REPL,或存成文件后 node 它;全绿打印 ledger ok。
//
// const L = require('./src/orch/ledger.js')
// const assert = require('assert')
// let l = { facts: [], open: [], assumptions: [], gaps: [] }
// // ① 入账带出处与时间,不读时钟
// l = L.addFacts(l, [{ text: 'pay 与 order 共享 DTO', anchors: ['src/shared/dto.ts:40'] }], 'n2', 1000)
// assert.deepStrictEqual(l.facts[0], { text: 'pay 与 order 共享 DTO', anchors: ['src/shared/dto.ts:40'], src: 'n2', at: 1000 })
// // ② 归一化去重:空格/标点/大小写差异算同一条
// l = L.addFacts(l, ['pay 与 order 共享 DTO。'], 'n3', 1001)
// l = L.addFacts(l, [' PAY 与 ORDER 共享 dto '], 'n4', 1002)
// assert.strictEqual(l.facts.length, 1)
// // ③ 不原地改:老账本一动不动
// const before = { facts: [], open: [], assumptions: [], gaps: [] }
// const after = L.addOpen(before, ['分片3 的 API 契约未定'], 'plan', 5)
// assert.strictEqual(before.open.length, 0); assert.strictEqual(after.open.length, 1)
// // ④ gaps 吃结构化写法,nodeId 留着
// l = L.addGaps(l, [{ nodeId: 'n3', kind: 'contract', detail: '缺 createPayment' }], 'code', 7)
// assert.strictEqual(l.gaps[0].text, 'n3: contract: 缺 createPayment'); assert.strictEqual(l.gaps[0].nodeId, 'n3')
// // ⑤ resolveOpen 容忍转述差异
// const l2 = L.resolveOpen(after, ['分片 3 的 API 契约,未定'])
// assert.strictEqual(l2.open.length, 0)
// // ⑥ 上限 200 且保留最新
// let big = { facts: [], open: [], assumptions: [], gaps: [] }
// for (let i = 0; i < 260; i++) big = L.addFacts(big, ['事实' + i], 'n1', i)
// assert.strictEqual(big.facts.length, 200); assert.strictEqual(big.facts[199].text, '事实259')
// assert.strictEqual(L.size(l), 3)
// console.log('ledger ok')
