// BocomHermes · 出详设管线（确认后的需求点 → 跨仓定位代码切片 → agent 起草详设卡 → 实施方案文档）
// 设计要点（见 docs/需求分析自动化-多Agent对抗方案.md 续）：
//  · 纯逻辑、可单测 —— 不直接依赖 opencode/ripgrep/内网。靠注入的 locate(point) 定位、plan(point,located) 起草。
//  · locate = 方案B(确定性 grep，代码不进模型上下文)；plan = agent 只读 locate 命中的切片(上下文有界)。
//  · 铁律：files.line / 表.字段 全是真 ref（可点开），拿不准的进 opens，绝不替人拍板、绝不臆造。
//  · 统一脊柱 + 按场景插：场景一在 plan 里多判"归哪个系统"(system)，场景三在 locate 里多顺跨层调用链。

'use strict'

const { extractJson } = require('./orchestrator.js')

const clip = (s, n = 200) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s }

// ---------------- 决策归一：reqconfirm 落档给的是数组，也兼容对象 ----------------
function normalizeDecisions(d) {
  if (!d) return {}
  if (Array.isArray(d)) { const m = {}; for (const x of d) if (x && x.id != null) m[x.id] = x; return m }
  return d
}

// ---------------- 从三类清单 + 人工决策，整理出"待出详设的需求点" ----------------
//  · clear        → 纳入（已解释的诉求）
//  · split        → 纳入；选了读法用选定意图，没选标 unresolved（方案为初稿）
//  · conflict     → 纳入；裁了用裁定，没裁标 unresolved
//  · hidden       → 仅 include 才纳入；ignore/defect 跳过
function collectPoints(report, decisionsIn = {}) {
  const items = (report && report.items) || []
  const decisions = normalizeDecisions(decisionsIn)
  const readingLabel = (it, key) => { const r = (it.readings || []).find((x) => x.key === key); return r ? (r.label || r.key) : '' }
  const pts = []
  for (const it of items) {
    const d = decisions[it.id]
    const choice = (d && d.choice) || ''
    if (it.outcome === 'hidden' && choice !== 'include') {
      // 未确认的隐藏项默认带进来当"待评估"，但 ignore/defect 明确排除
      if (choice === 'ignore' || choice === 'defect') continue
    }
    let intent = it.claim || it.quote || ''
    let unresolved = false
    if (it.outcome === 'split') {
      if (/^pick:/.test(choice)) intent = readingLabel(it, choice.slice(5)) || intent
      else { unresolved = true }
    } else if (it.outcome === 'conflict') {
      if (/^rule:/.test(choice)) intent = readingLabel(it, choice.slice(5)) || intent
      else if (choice === 'branch') intent = '（两种读法都要，分支处理）' + intent
      else unresolved = true
    }
    pts.push({
      id: it.id,
      reqPoint: clip(it.claim || it.quote || '(未命名需求点)', 120),
      quote: it.quote || '',
      intent,
      outcome: it.outcome,
      decision: choice || null,
      unresolved,
    })
  }
  return pts
}

// ---------------- plan 提示词 + 输出契约 ----------------
const PLAN_OUTPUT_SPEC =
  '只输出 JSON，不要任何解释或 <think>。格式：\n' +
  '{"system":"(可选)归属系统名；优先采用上方代码定位中【】标注的系统，多个则取命中最多的，没有标注再据需求判断",' +
  '"files":[{"path":"务必原样抄给你的路径，不要改写","line":行号数字,"symbol":"方法/类名","change":"该处怎么改"}],' +
  '"tables":[{"table":"表名","column":"字段","change":"数据怎么变"}],' +
  '"interfaces":[{"method":"GET/POST...","path":"接口路径","caller":"谁调用","change":"接口怎么变"}],' +
  '"change":"总体改动说明(一段话)","steps":["实施步骤1","步骤2"],' +
  '"opens":["拿不准、需人工确认的点"]}\n' +
  '【铁律】只填给你的代码切片支持得了的内容；没有依据就给空数组。绝不臆造文件/行号/表名/字段。' +
  '拿不准的一律写进 opens，不要替人决定。'

function buildPlanPrompt(point, located = {}) {
  const refs = (located.refs || []).map((r) => '- ' + (r.system ? '【' + r.system + '】' : '') + r.path + (r.line ? ':' + r.line : '') + (r.symbol ? ' ' + r.symbol : '')).join('\n')
  const slices = (located.slices || []).map((s) => '# ' + (s.system ? '【' + s.system + '】' : '') + s.path + (s.line ? ':' + s.line : '') + '\n' + s.text).join('\n\n')
  return [
    '你是资深研发。为下面这个【已确认的需求点】写一份"详设级"实施方案。',
    '',
    '【需求点】' + (point.reqPoint || ''),
    point.intent && point.intent !== point.reqPoint ? '【确认的意图/读法】' + point.intent : '',
    point.quote ? '【需求原文】' + point.quote : '',
    point.unresolved ? '【注意】此点尚未人工确认读法/裁决，请基于最可能的理解给初稿，并把不确定写进 opens。' : '',
    '',
    '【代码定位（grep 命中，路径请原样引用）】',
    refs || '(无命中——很可能是新增；把缺口写进 opens)',
    slices ? '\n【相关代码切片】\n' + slices : '',
    '',
    PLAN_OUTPUT_SPEC,
  ].filter(Boolean).join('\n')
}

// ---------------- 解析 agent 输出 → 详设卡 ----------------
function parsePlanCard(raw, point, located = {}) {
  const j = extractJson(raw) || {}
  const arr = (x) => (Array.isArray(x) ? x : [])
  const card = {
    id: point.id,
    reqPoint: point.reqPoint,
    quote: point.quote || '',
    outcome: point.outcome,
    system: j.system ? String(j.system) : '',
    files: arr(j.files).map((f) => ({
      path: String((f && f.path) || ''), line: Number(f && f.line) || null,
      symbol: String((f && f.symbol) || ''), change: String((f && f.change) || ''),
    })).filter((f) => f.path),
    tables: arr(j.tables).map((t) => ({
      table: String((t && t.table) || ''), column: String((t && t.column) || ''), change: String((t && t.change) || ''),
    })).filter((t) => t.table),
    interfaces: arr(j.interfaces).map((i) => ({
      method: String((i && i.method) || ''), path: String((i && i.path) || ''),
      caller: String((i && i.caller) || ''), change: String((i && i.change) || ''),
    })).filter((i) => i.method || i.path),
    change: String(j.change || ''),
    steps: arr(j.steps).map((s) => String(s)).filter(Boolean),
    opens: arr(j.opens).map((s) => String(s)).filter(Boolean),
  }
  // 未确认的歧义/矛盾 → 诚实地置顶到 opens
  if (point.unresolved) card.opens.unshift('该需求点尚未人工确认读法/裁决，本方案为初稿')
  // plan 没给 files 但 locate 有命中 → 至少挂上可点定位，不让人空手
  if (!card.files.length && (located.refs || []).length) {
    card.files = (located.refs || []).slice(0, 5).map((r) => ({ path: r.path, line: r.line || null, symbol: r.symbol || '', change: '' }))
  }
  return card
}

// ---------------- 端到端：planRequirement(report, { locate, plan, decisions, onEvent, signal }) ----------------
async function planRequirement(report, opts = {}) {
  const locate = opts.locate
  const plan = opts.plan
  const emit = (ev) => { if (opts.onEvent) { try { opts.onEvent(ev) } catch {} } }
  const points = collectPoints(report, opts.decisions)
  emit({ stage: 'plan-start', total: points.length })

  const cards = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (opts.signal && opts.signal.aborted) throw new Error('已中止')
    emit({ stage: 'locating', done: i, total: points.length, reqPoint: p.reqPoint })
    let located = { refs: [], slices: [] }
    if (locate) { try { located = (await locate(p, { signal: opts.signal })) || located } catch { located = { refs: [], slices: [] } } }
    emit({ stage: 'planning', done: i, total: points.length, reqPoint: p.reqPoint, refs: (located.refs || []).length })
    let raw = ''
    if (plan) { try { raw = await plan(p, located, { signal: opts.signal }) } catch { raw = '' } }
    const card = parsePlanCard(raw, p, located)
    cards.push(card)
    emit({ stage: 'planned', done: i + 1, total: points.length, system: card.system })
  }
  emit({ stage: 'plan-done', cards: cards.length })
  return { cards, points }
}

// ---------------- 实施方案 → Markdown 产物文档（零依赖，可粘 Word/wiki） ----------------
function planToMarkdown(result, meta = {}) {
  const cards = (result && result.cards) || []
  const date = new Date(meta.ts || Date.now()).toLocaleString('zh-CN')
  const L = []
  L.push('# 实施方案 · ' + (meta.file || '需求文档'))
  L.push('')
  L.push('> ' + date + ' · 共 ' + cards.length + ' 个需求点 · 详设级（证据锚定，未决项已标注）')
  L.push('')
  cards.forEach((c, i) => {
    L.push('## ' + (i + 1) + '. ' + (c.reqPoint || '(未命名)') + (c.system ? '　【' + c.system + '】' : ''))
    if (c.quote) L.push('> 原文：' + clip(c.quote, 200))
    if (c.change) { L.push(''); L.push(c.change) }
    if (c.files.length) {
      L.push(''); L.push('**影响文件**')
      for (const f of c.files) L.push('- `' + f.path + (f.line ? ':' + f.line : '') + '`' + (f.symbol ? ' ' + f.symbol : '') + (f.change ? ' — ' + f.change : ''))
    }
    if (c.tables.length) {
      L.push(''); L.push('**影响数据**')
      for (const t of c.tables) L.push('- `' + t.table + (t.column ? '.' + t.column : '') + '`' + (t.change ? ' — ' + t.change : ''))
    }
    if (c.interfaces.length) {
      L.push(''); L.push('**影响接口**')
      for (const it of c.interfaces) L.push('- `' + (it.method ? it.method + ' ' : '') + it.path + '`' + (it.caller ? '（' + it.caller + '）' : '') + (it.change ? ' — ' + it.change : ''))
    }
    if (c.steps.length) {
      L.push(''); L.push('**实施步骤**')
      c.steps.forEach((s, k) => L.push((k + 1) + '. ' + s))
    }
    if (c.opens.length) {
      L.push(''); L.push('**⛑ 未决（待人工确认，未替人拍板）**')
      for (const o of c.opens) L.push('- ' + o)
    }
    L.push('')
  })
  L.push('---')
  L.push('')
  L.push('（详设级方案基于真实代码切片定位生成；标注「未决」的点需人工确认后再落地。）')
  return L.join('\n')
}

module.exports = {
  normalizeDecisions, collectPoints, PLAN_OUTPUT_SPEC, buildPlanPrompt, parsePlanCard, planRequirement, planToMarkdown,
}
