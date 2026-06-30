// BocomHermes · 需求分析管线（多Agent 对抗 → 对齐引擎 → 三类清单报告）
// 设计要点（见 docs/需求分析自动化-多Agent对抗方案.md）：
//  · 纯逻辑、可单测 —— 不直接依赖 opencode/模型/内网。靠注入的 run(prompt,meta) 跑读者/裁判，注入的 ground(q) 查真相。
//  · 读者各自独立（裸上下文 + 强对立 persona），并行 run，互不通气 —— 同模型(MiniMax)下 persona 是独立性唯一来源。
//  · 对齐引擎(align.js)只吃 findings、产出簇与三类分类；本文件负责"产出 findings / 接裁判 / grounding / 装配报告"。
//  · 多模态：Word 内嵌图片走注入的 describeImage(Qwen)，翻成文字按原位插回，引擎外预处理、翻一次。

'use strict'

const { clusterByTopic, analyzeCluster } = require('./align.js')
const { extractJson } = require('./orchestrator.js')

const clip = (s, n = 220) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s }

// ---------------- 5 个对抗读者 persona（信贷域口径，提示词可由用户细化） ----------------
const OUTPUT_SPEC =
  '只输出 JSON，不要任何解释或 <think>。格式：\n' +
  '{"findings":[{"span":"原文逐字片段(务必从原文原样抄一小段用于定位，不要改写)",' +
  '"claim":"归一化的诉求(一句话)","reading":"你这一派读出的意思","readingKey":"3-8字短标签",' +
  '"term":"涉及的核心概念名(用于跨段归并，如 额度恢复/冻结处理)"}]}\n' +
  '读不出诉求就返回 {"findings":[]}。不要编造原文里没有的内容。'

const PERSONAS = [
  {
    name: '业务字面',
    instruction: '你是"业务字面派"。只读文档【字面】要求做什么，逐条摘出，不引申、不脑补需求背后的实现。' +
      '把背景吐槽/现状和真正的诉求分开，只收"要做的事"。',
  },
  {
    name: '数据派',
    instruction: '你是"数据派"。把一切读成"哪些【数据/字段】会变"，尽量用数据库表/字段的口径表达' +
      '(信贷里 额度/授信/敞口/限额 常混用，注意归一)。说不清落到哪个字段的，也照实标出来。',
  },
  {
    name: '流程派',
    instruction: '你是"流程派"。把一切读成"哪些【流程/状态流转】会变"——什么状态、谁触发、流转到哪、有没有审批/回退。',
  },
  {
    name: '挑刺·对抗',
    instruction: '你是"挑刺·对抗派"。【假设这份文档是错的、不全的】。猎杀：藏在抱怨里的隐含诉求' +
      '("明明还了款额度没恢复"——是 BUG 还是要做的需求?)、未写明的假设、自相矛盾、' +
      '"参考XX系统/信用卡逻辑"这种甩锅(信用卡是循环授信，跟对公额度模型不是一回事)。专挑别人会漏的。',
  },
  {
    name: '历史·跨页',
    instruction: '你是"历史·跨页派"。把文档跟它自己比：跨页/跨章节是否冲突(如第3节说自动冻结、附录又说需人工复核)、' +
      '有没有 V1 残留(新版没删干净的废弃段落)。把互相矛盾的两端都钉出来。',
  },
]

function buildReaderPrompt(persona, sourceText) {
  return persona.instruction + '\n\n【需求文档原文】\n' + sourceText + '\n\n' + OUTPUT_SPEC
}

// 把读者引用的原文片段定位成 [start,end]（精确 indexOf，失败 trim 重试，再失败返回 null —— 宁可不给 span 也不给错偏移）
function locateSpan(text, quote) {
  if (!quote) return null
  let idx = text.indexOf(quote)
  if (idx >= 0) return [idx, idx + quote.length]
  const q = String(quote).trim()
  if (q && q !== quote) { idx = text.indexOf(q); if (idx >= 0) return [idx, idx + q.length] }
  return null
}

function parseFindings(raw, sourceText, persona) {
  const j = extractJson(raw)
  if (!j) return []
  const arr = Array.isArray(j) ? j : (Array.isArray(j.findings) ? j.findings : [])
  const res = []
  arr.forEach((f, i) => {
    if (!f) return
    const quote = f.span != null ? String(f.span) : (f.quote != null ? String(f.quote) : (f.text != null ? String(f.text) : ''))
    const span = locateSpan(sourceText, quote)
    res.push({
      id: persona + '#' + i,
      persona,
      span,
      spanText: span ? sourceText.slice(span[0], span[1]) : quote,
      claim: String(f.claim || ''),
      reading: String(f.reading || ''),
      readingKey: String(f.readingKey || f.reading || ('#' + persona + i)),
      term: f.term != null ? String(f.term) : '',
    })
  })
  return res
}

// 单个调用加超时：任一 reader/判读卡住（模型那轮不返回/不给完成信号）不能冻住整条并行管线。
// 超时即按"该路返回空"处理，带 clearTimeout，绝不留悬挂定时器（自测里的瞬时 fakeRun 也不会被拖住）。
function withTimeout(promise, ms, onTimeoutValue) {
  if (!ms || ms <= 0) return promise
  let to
  const timer = new Promise((resolve, reject) => {
    to = setTimeout(() => (onTimeoutValue !== undefined ? resolve(onTimeoutValue) : reject(new Error('timeout ' + ms + 'ms'))), ms)
  })
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(to)), timer])
}

// 多视角对抗阅读：5 persona 各自独立 run（独立会话/裸上下文/互不通气）收集 findings。
// 根因修复：不再 5 路齐发——内网模型网关常只有单/少并发槽，5 路一起冲会让排最后的 reader（如"历史·跨页"）
//   长时间拿不到槽 → 配合 sendMessage 的"等完成"轮询 → 表现为卡死。改成【有界并发池(默认2)】按网关节奏喂；
//   每个 reader 仍带独立超时兜底。独立性不受影响（"并行"指互不通气，不要求同时发起）。
async function readDocument(sourceText, opts = {}) {
  const run = opts.run
  const personas = opts.personas || PERSONAS
  const onReader = opts.onReader
  const perReaderMs = opts.perReaderMs != null ? opts.perReaderMs : 120000
  const concurrency = Math.max(1, opts.concurrency || 2)
  if (!run) return []
  const results = new Array(personas.length)
  let next = 0
  async function worker() {
    while (next < personas.length) {
      if (opts.signal && opts.signal.aborted) return
      const i = next++; const p = personas[i]
      let fs = []
      try {
        const raw = await withTimeout(run(buildReaderPrompt(p, sourceText), { kind: 'read', persona: p.name, signal: opts.signal }), perReaderMs)
        fs = parseFindings(raw, sourceText, p.name)
      } catch { fs = [] }
      if (onReader) { try { onReader(p.name, fs.length) } catch {} }
      results[i] = fs
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, personas.length) }, worker))
  return results.flat()
}

// ---------------- 裁判封装（包注入 run） ----------------
function pickVerdict(raw, allowContradict) {
  const t = String(raw || '').toLowerCase()
  if (allowContradict && /(contradict|矛盾|冲突|互斥|不能并存|对立)/.test(t)) return 'contradict'
  if (/(\bsame\b|相同|一致|同一|是同|同题)/.test(t)) return 'same'
  return 'different'
}
const briefF = (f) => clip((f && (f.spanText || f.claim)) || '', 80) + '｜' + clip((f && f.reading) || '', 80)

function makeTopicJudge(run) {
  return async (a, b) => {
    const p = '判断下面两条读者结论是不是在说【同一件事】(同一个诉求/对象/改动点)。只回一个词：same 或 different。\n' +
      'A：' + briefF(a) + '\nB：' + briefF(b)
    try { return pickVerdict(await withTimeout(run(p, { kind: 'judge-topic' }), 60000), false) } catch { return 'different' }
  }
}
function makeReadingJudge(run) {
  return async (a, b) => {
    const p = '同一处需求，两位读者给出的读法，关系是哪种？只回一个词：\n' +
      'same(同一种意思) / different(不同但能并存) / contradict(互相矛盾、不能同时成立)。\n' +
      'A：' + briefF(a) + '\nB：' + briefF(b)
    try { return pickVerdict(await withTimeout(run(p, { kind: 'judge-reading' }), 60000), true) } catch { return 'different' }
  }
}

// ---------------- grounding：对 split/conflict 的每个读法查真相 ----------------
// ground(query) -> { found:bool, ref:string|null }；query={clusterId,readingKey,claim,reading,personas}
async function groundCluster(analysis, findings, opts = {}) {
  const ground = opts.ground
  const boostFactor = opts.boostFactor || 4
  const fById = new Map((findings || []).map((f) => [f.id, f]))
  const boost = {}
  const evidence = {}
  for (const r of analysis.readings) {
    const f0 = fById.get(r.findingIds[0]) || {}
    let res = {}
    try { res = await ground({ clusterId: analysis.id, readingKey: r.key, claim: f0.claim || '', reading: f0.reading || '', personas: r.personas }) || {} } catch { res = {} }
    boost[r.key] = res.found ? boostFactor : 1
    evidence[r.key] = res.ref ? [res.ref] : []
  }
  return { boost, evidence }
}

// ---------------- 报告装配：引擎输出 → 逐条确认面板吃的 JSON ----------------
function assembleReport({ clusters, analyses, evidenceMap = {} }) {
  const cById = new Map(clusters.map((c) => [c.id, c]))
  const items = analyses.map((a) => {
    const c = cById.get(a.id) || { findings: [], personas: [] }
    const fById = new Map((c.findings || []).map((f) => [f.id, f]))
    const ev = evidenceMap[a.id] || {}
    const readings = a.readings.map((r) => {
      const f0 = fById.get(r.findingIds[0]) || {}
      return {
        key: r.key,
        label: f0.reading || r.key,
        personas: r.personas,
        confidence: r.confidence,
        recommended: !!r.recommended,
        quote: f0.spanText || '',
        evidence: ev[r.key] || [],
      }
    })
    const first = (c.findings || [])[0] || {}
    return {
      id: a.id,
      outcome: a.outcome,
      quote: clip(first.spanText || first.claim || '', 200),
      claim: first.claim || '',
      personas: c.personas || [],
      readings,
      riskFlags: (a.riskFlags || []).map((rf) => ({ persona: rf.persona, reading: rf.reading })),
      contradiction: !!a.contradiction,
    }
  })
  const summary = { clear: 0, split: 0, conflict: 0, hidden: 0 }
  for (const it of items) if (summary[it.outcome] != null) summary[it.outcome]++
  return { items, summary }
}

// ---------------- 端到端管线 ----------------
// analyzeRequirement(sourceText, { run, ground?, topicJudge?, readingJudge?, weightOf?, personas?, signal? })
async function analyzeRequirement(sourceText, opts = {}) {
  const run = opts.run
  const personas = opts.personas || PERSONAS
  const emit = (ev) => { if (opts.onEvent) { try { opts.onEvent(ev) } catch {} } }

  emit({ stage: 'readers-start', personas: personas.map((p) => p.name) })
  const findings = await readDocument(sourceText, {
    run, personas, signal: opts.signal,
    onReader: (persona, count) => emit({ stage: 'reader-done', persona, count }),
  })
  emit({ stage: 'readers-done', findings: findings.length })

  const topicJudge = opts.topicJudge || (run ? makeTopicJudge(run) : null)
  const { clusters } = await clusterByTopic(findings, {
    judge: topicJudge, overlapHi: opts.overlapHi, overlapLo: opts.overlapLo,
    onProgress: (done, total) => emit({ stage: 'topic-judge', done, total }),
  })
  emit({ stage: 'clustered', clusters: clusters.length })

  const readingJudge = opts.readingJudge || (run ? makeReadingJudge(run) : null)
  const analyses = []
  const running = { clear: 0, split: 0, conflict: 0, hidden: 0 }
  for (let i = 0; i < clusters.length; i++) {
    const a = await analyzeCluster(clusters[i], { readingJudge, weightOf: opts.weightOf })
    analyses.push(a)
    if (running[a.outcome] != null) running[a.outcome]++
    emit({ stage: 'analyzing', done: i + 1, total: clusters.length, summary: { ...running } })
  }
  emit({ stage: 'analyzed', summary: { ...running } })

  // grounding：只对 split/conflict 回灌，可能塌缩分裂或改推荐
  const evidenceMap = {}
  if (opts.ground) {
    for (let i = 0; i < clusters.length; i++) {
      const a = analyses[i]
      if (a.outcome === 'split' || a.outcome === 'conflict') {
        emit({ stage: 'grounding', clusterId: a.id })
        const { boost, evidence } = await groundCluster(a, clusters[i].findings, { ground: opts.ground, boostFactor: opts.boostFactor })
        evidenceMap[a.id] = evidence
        analyses[i] = await analyzeCluster(clusters[i], { readingJudge, weightOf: opts.weightOf, groundingBoost: boost })
      }
    }
  }

  const report = assembleReport({ clusters, analyses, evidenceMap })
  emit({ stage: 'report', summary: report.summary })
  return { findings, clusters, analyses, report }
}

// ---------------- Word 内嵌图片预处理（多模态走 Qwen） ----------------
function htmlToText(html) {
  return String(html)
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*>/gi, '\n')
    .replace(/<img[^>]*alt="\[\[IMG(\d+)\]\]"[^>]*>/gi, '[[IMG$1]]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// 把 [[IMGk]] 占位替换成 Qwen 给的文字；读不准则诚实标注，绝不留空当没图
function spliceImageDescriptions(text, descs) {
  return String(text).replace(/\[\[IMG(\d+)\]\]/g, (m, k) => {
    const i = Number(k)
    const d = descs[i]
    return d ? ('［图' + (i + 1) + '：' + d + '］') : ('［图' + (i + 1) + '：读不准，原图在此］')
  })
}

// parseDocx(path, { describeImage }) -> { text, images, messages }
//  · mammoth 把内嵌图片抠出来、原位留 [[IMGk]] 占位；describeImage(image) 走 Qwen 翻成文字；按位插回。
//  · describeImage 缺省=不识别(占位标"读不准")。需在装了 mammoth 的环境对真实 .docx 跑。
async function parseDocx(path, opts = {}) {
  const mammoth = require('mammoth')
  const images = []
  const result = await mammoth.convertToHtml({ path }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const idx = images.length
      let base64 = ''
      try { base64 = await image.read('base64') } catch {}
      images.push({ idx, contentType: image.contentType, base64 })
      return { alt: '[[IMG' + idx + ']]' }
    }),
  })
  let text = htmlToText(result.value)
  const describeImage = opts.describeImage
  const descs = []
  for (const im of images) {
    let d = null
    if (describeImage) { try { d = await describeImage(im) } catch { d = null } }
    descs[im.idx] = d
  }
  text = spliceImageDescriptions(text, descs)
  return { text, images: images.length, messages: result.messages || [] }
}

// 把报告渲染成 Markdown 产物文档（人可读、可粘进 Word/wiki、零依赖）
function reportToMarkdown(report, meta = {}) {
  const items = (report && report.items) || []
  const s = (report && report.summary) || {}
  const date = new Date(meta.ts || Date.now()).toLocaleString('zh-CN')
  const LAB = { clear: '明确 · 已解释', split: '不明确 · 待选', conflict: '矛盾 · 待裁', hidden: '隐藏 · 易漏' }
  const L = []
  L.push('# 需求分析报告 · ' + (meta.file || '需求文档'))
  L.push('')
  L.push('> ' + date + ' · 共 ' + (meta.findings != null ? meta.findings + ' findings · ' : '') + items.length + ' 个话题')
  L.push('> 明确 ' + (s.clear || 0) + ' ｜ 不明确 ' + (s.split || 0) + ' ｜ 矛盾 ' + (s.conflict || 0) + ' ｜ 隐藏 ' + (s.hidden || 0))
  L.push('')
  for (const cat of ['clear', 'split', 'conflict', 'hidden']) {
    const sub = items.filter((it) => it.outcome === cat)
    if (!sub.length) continue
    L.push('## ' + LAB[cat] + '（' + sub.length + '）')
    L.push('')
    for (const it of sub) {
      L.push('### ' + (it.claim || it.quote || '(未命名)'))
      if (it.quote) L.push('> 原文：' + it.quote)
      if (it.personas && it.personas.length) L.push('- 读者：' + it.personas.join('、'))
      for (const r of (it.readings || [])) {
        const conf = r.confidence != null ? '（' + Math.round(r.confidence * 100) + '%）' : ''
        const rec = r.recommended ? ' ★推荐' : ''
        const ev = (r.evidence && r.evidence.length) ? ' ｜证据：' + r.evidence.join('、') : ''
        L.push('- 读法：' + (r.label || r.key) + conf + rec + ev)
      }
      for (const rf of (it.riskFlags || [])) L.push('- ⚑ 挑刺派异见：' + (rf.reading || ''))
      L.push('')
    }
  }
  L.push('---')
  L.push('')
  L.push('（机器只摊开三类清单、不替人拍板；经人工二次确认后才 append-only 落档。）')
  return L.join('\n')
}

module.exports = {
  PERSONAS, OUTPUT_SPEC, buildReaderPrompt, locateSpan, parseFindings, readDocument,
  pickVerdict, makeTopicJudge, makeReadingJudge, groundCluster, assembleReport, analyzeRequirement,
  htmlToText, spliceImageDescriptions, parseDocx, reportToMarkdown,
}
