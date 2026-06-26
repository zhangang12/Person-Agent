// BocomHermes · 对齐引擎 —— 第一块砖：话题聚簇（结构层）
// 设计要点（见 docs/需求分析自动化-多Agent对抗方案.md 第八节硬问题①）：
//  · 纯逻辑、可单测 —— 不依赖模型。裁判 Agent 通过注入的 judge(a,b)->'same'|'different' 提供，
//    缺省 null = 只用结构信号（span 重叠），不调模型。
//  · 输入 = 5 个读者各自产出的 findings（每个钉回原文 span）。输出 = 话题簇：把"在说同一件事"的聚到一起。
//    （第二次聚簇——簇内"读法一致 vs 分裂"——是后续的砖，不在本文件。）
//  · 两层判定：span 重叠率 >= overlapHi 自动并；overlapLo<=ratio<overlapHi 的"模糊边界"才问裁判；
//    ratio<overlapLo 结构上不并（裁判不掺和，避免 O(n^2) 调用）。
//  · 重叠率 = 交集 / 较短 span —— 容忍"一个圈整句、一个只圈半句"，比严格 IoU 更贴脏文档。
//  · 裁判只问"会桥接两个不同连通分量"的模糊对，且重叠率高的先问；一旦两者已并入同簇就跳过 —— 把裁判调用压到刀刃上。

'use strict'

// span = [start, end]（原文字符偏移，start<=end）。重叠率 = 交集长度 / 较短 span 长度，落在 [0,1]。
function spanOverlapRatio(a, b) {
  if (!a || !b) return 0
  const lo = Math.max(a[0], b[0])
  const hi = Math.min(a[1], b[1])
  const inter = Math.max(0, hi - lo)
  if (inter <= 0) return 0
  const minLen = Math.min(a[1] - a[0], b[1] - b[0])
  return minLen <= 0 ? 0 : inter / minLen
}

// 并查集（带路径压缩）
function makeDSU(n) {
  const p = Array.from({ length: n }, (_, i) => i)
  const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x] } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) { p[ra] = rb; return true } return false }
  return { find, union }
}

// findings: [{ id, persona, span:[s,e], claim, reading? }, ...]
// opts: { overlapHi=0.5, overlapLo=0.15, judge=null }
//   judge(findingA, findingB) -> 'same' | 'different'（可同步或返回 Promise）
// 返回: { clusters:[{ id, findingIds, findings, personas, spanHull:[lo,hi], size }], judgeCalls, ambiguousPairs }
async function clusterByTopic(findings, opts = {}) {
  const list = Array.isArray(findings) ? findings : []
  const overlapHi = opts.overlapHi != null ? opts.overlapHi : 0.5
  const overlapLo = opts.overlapLo != null ? opts.overlapLo : 0.15
  const judge = opts.judge || null
  const n = list.length
  const dsu = makeDSU(n)
  const ambiguous = []
  const seen = new Set()
  const addAmb = (i, j, r) => { const k = i < j ? i + ',' + j : j + ',' + i; if (!seen.has(k)) { seen.add(k); ambiguous.push([i, j, r]) } }
  let judgeCalls = 0

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = spanOverlapRatio(list[i].span, list[j].span)
      if (r >= overlapHi) dsu.union(i, j)
      else if (r >= overlapLo) addAmb(i, j, r)
    }
  }
  // 跨页同概念：共享 term（归一化概念，如"冻结处理"）但 span 不重叠的对，也交裁判 ——
  // 跨页冲突两端往往落在不同段落、span 零重叠，纯靠 span 永远聚不到一起；用 term 把候选喂给裁判，
  // 调用量仍受控（只问"同 term 且尚未同簇"的对）。
  const termMap = new Map()
  for (let i = 0; i < n; i++) { const t = list[i].term; if (t != null && t !== '') { if (!termMap.has(t)) termMap.set(t, []); termMap.get(t).push(i) } }
  for (const idxs of termMap.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a], j = idxs[b]
        if (dsu.find(i) === dsu.find(j)) continue
        const r = spanOverlapRatio(list[i].span, list[j].span)
        if (r < overlapHi) addAmb(i, j, r)
      }
    }
  }

  // 模糊边界：重叠率高的先问（更可能同题）；只问会桥接两个不同分量的对；已同簇则跳过。
  ambiguous.sort((x, y) => y[2] - x[2])
  if (judge) {
    let processed = 0
    for (const [i, j] of ambiguous) {
      if (dsu.find(i) !== dsu.find(j)) {
        judgeCalls++
        const verdict = await judge(list[i], list[j])
        if (verdict === 'same') dsu.union(i, j)
      }
      processed++
      if (opts.onProgress) { try { opts.onProgress(processed, ambiguous.length) } catch {} }
    }
  }

  const byRoot = new Map()
  for (let i = 0; i < n; i++) {
    const r = dsu.find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r).push(i)
  }

  const clusters = []
  let cid = 0
  for (const idxs of byRoot.values()) {
    const fs = idxs.map((k) => list[k])
    const personas = [...new Set(fs.map((f) => f.persona).filter(Boolean))]
    let lo = Infinity, hi = -Infinity
    for (const f of fs) { if (f.span) { lo = Math.min(lo, f.span[0]); hi = Math.max(hi, f.span[1]) } }
    clusters.push({
      id: 'C' + (++cid),
      findingIds: fs.map((f) => f.id),
      findings: fs,
      personas,
      spanHull: [lo === Infinity ? null : lo, hi === -Infinity ? null : hi],
      size: fs.length,
    })
  }
  // 按原文出现顺序排，方便面板从上往下读
  clusters.sort((a, b) => (a.spanHull[0] || 0) - (b.spanHull[0] || 0))
  return { clusters, judgeCalls, ambiguousPairs: ambiguous.length }
}

// ===== 第二块砖：簇内"读法分簇 + 分类 + 置信度聚合"（第八节硬问题②）=====
// 在一个话题簇内部，再按"读法"二次聚簇：
//   · 结构信号：先按 readingKey（读者给的归一化读法标签，缺省退化到 reading 文本 / 各自一组）分组。
//   · 裁判(可选注入) readingJudge(a,b)->'same'|'different'|'contradict'：
//       same     合并成同一读法；
//       different 留作并列读法（= 分裂）；
//       contradict 标记该簇为"冲突"（互斥读法，尤其跨页）。
// 分类（结构决定，置信度只排序不决策）：
//   size<=1 或 无非挑刺派背书  → hidden（隐藏/易漏，仅 1 人/仅挑刺派发现）
//   有 contradict              → conflict（矛盾·待裁）
//   非挑刺派只剩 1 种读法       → clear（明确·已解释）
//   否则                       → split（不明确·并列待选）
// 挑刺派不对称：挑刺派"独家"的异见不把多数读法拉下水（不算入 clear/split 判定），
//   而是单独挂成 riskFlags（专职找茬的票能掀旗、但不替大家定读法）。

async function analyzeCluster(cluster, opts = {}) {
  const critic = opts.criticPersona || '挑刺·对抗'
  const weightOf = opts.weightOf || (() => 1)
  const readingJudge = opts.readingJudge || null
  const groundingBoost = opts.groundingBoost || {}
  const findings = (cluster && cluster.findings) || []
  const size = findings.length

  // 1) 按 readingKey 初分组
  const keyOf = (f) => (f.readingKey != null ? f.readingKey : (f.reading != null ? f.reading : '#' + f.id))
  const groupMap = new Map()
  for (const f of findings) {
    const k = keyOf(f)
    if (!groupMap.has(k)) groupMap.set(k, { key: k, fs: [] })
    groupMap.get(k).fs.push(f)
  }
  let groups = [...groupMap.values()]

  // 2) 裁判：在初分组代表上两两问 —— same 合并、contradict 标冲突
  let judgeCalls = 0
  let contradiction = false
  if (readingJudge && groups.length > 1) {
    const m = groups.length
    const dsu = makeDSU(m)
    const contradicts = []
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        judgeCalls++
        const v = await readingJudge(groups[i].fs[0], groups[j].fs[0])
        if (v === 'same') dsu.union(i, j)
        else if (v === 'contradict') contradicts.push([i, j])
      }
    }
    const byRoot = new Map()
    for (let i = 0; i < m; i++) {
      const r = dsu.find(i)
      if (!byRoot.has(r)) byRoot.set(r, { key: groups[i].key, fs: [] })
      byRoot.get(r).fs.push(...groups[i].fs)
    }
    contradiction = contradicts.some(([i, j]) => dsu.find(i) !== dsu.find(j))
    groups = [...byRoot.values()]
  }

  // 3) 每种读法聚 persona / 背书
  const subs = groups.map((g) => {
    const personas = [...new Set(g.fs.map((f) => f.persona).filter(Boolean))]
    const backing = g.fs.reduce((s, f) => s + weightOf(f), 0)
    return { key: g.key, personas, findingIds: g.fs.map((f) => f.id), backing, criticOnly: personas.length > 0 && personas.every((p) => p === critic) }
  })

  // 4) 分类
  const nonCritic = subs.filter((s) => !s.criticOnly)
  const criticOnly = subs.filter((s) => s.criticOnly)
  let outcome
  if (size <= 1 || nonCritic.length === 0) outcome = 'hidden'
  else if (contradiction) outcome = 'conflict'
  else if (nonCritic.length === 1) outcome = 'clear'
  else outcome = 'split'

  // 5) 置信度（只排序/打标签）：背书 × grounding 加成，归一化
  const chosen = outcome === 'hidden' ? subs : nonCritic
  const total = chosen.reduce((a, s) => a + s.backing * (groundingBoost[s.key] || 1), 0) || 1
  const readings = chosen.map((s) => ({
    key: s.key, personas: s.personas, findingIds: s.findingIds, backing: s.backing,
    confidence: Number(((s.backing * (groundingBoost[s.key] || 1)) / total).toFixed(2)),
  })).sort((a, b) => b.confidence - a.confidence)
  if (readings.length) readings[0].recommended = true

  const riskFlags = outcome === 'hidden' ? [] : criticOnly.map((s) => ({ persona: critic, reading: s.key, findingIds: s.findingIds }))

  return { id: cluster && cluster.id, outcome, readings, riskFlags, contradiction, size, judgeCalls }
}

// 对一批话题簇逐个分析，并给出三类清单的汇总计数（对应工作流窗"一致/分裂/矛盾/隐藏"）。
async function analyzeClusters(clusters, opts = {}) {
  const list = Array.isArray(clusters) ? clusters : []
  const items = []
  const summary = { clear: 0, split: 0, conflict: 0, hidden: 0 }
  let judgeCalls = 0
  for (const c of list) {
    const r = await analyzeCluster(c, opts)
    items.push(r)
    summary[r.outcome]++
    judgeCalls += r.judgeCalls
  }
  return { items, summary, judgeCalls }
}

module.exports = { spanOverlapRatio, makeDSU, clusterByTopic, analyzeCluster, analyzeClusters }
