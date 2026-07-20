'use strict'
// 项目级知识库(任务尾蒸馏的落点)—— 纯逻辑,依赖全部注入,可单测。
// 背景:个人记忆 memory.md 是【全局】的(所有项目共用),蒸馏出的"系统级事实"(如"计息规则在 X 文件")
// 是项目级知识,写全局会污染其它项目 → 每项目一个文件:userData/knowledge/<basename>_<md5前8>.md。
// 条目制追加(带日期/置信度/锚点/场景),注入按项目匹配。
//
// 注入防腐 C1-C4(docs/记忆系统设计.md §3,由 auditEntries 实现,注入前跑):
//   C1 锚点文件不存在 → 该锚点死;C2 符号在文件里 grep 不到 → 该锚点死。
//   多锚点策略:全死 → 整条隔离不注入(status=red);部分死 → 标黄(yellow)仍注入
//     —— 还有活锚点佐证,条目大概率仍有效,降级为"需要关注"而非误杀。
//   C3 行漂移(文件在、符号在、锚点行号对不上)→ 就近重定位(离旧行号最近的符号出现行,等距取小行号),
//     条目照常注入(status 仍 green),且回写知识库文件里的新锚点行号(返回值 content 字段,调用方负责落盘)。
//   C4 自 verified(条目无独立 verified 字段,用所在 ## 日期节日期做代理)以来,锚点文件 churn 累计超阈
//     (churnMaxLines 参数,默认 300 行)→ 标黄,注入时该条带 [待复核] 前缀。
//     churnOf 不可用(非 git 仓库等)返回 null → 跳过 C4,不影响注入。
//   符号提取规则(确定性,可单测):从条目正文取标识符 /[A-Za-z_][A-Za-z0-9_]{2,}/,去掉常见停用词,
//     按"含大写/下划线/数字优先 → 长度降序 → 字母序"取前 4 个做候选;首个在文件中仍有出现(词边界匹配)
//     的候选胜出,全部候选都没出现才判 C2 死(宁放过不误杀,防腐是筛不是判)。
//     正文无可用标识符时退化为从锚点行内容提取 —— 此时只能验证存在性,行漂移检测失效
//     (符号本就从该行提取,必然"在行上"),reasons 里标注"信任原行号"。
//   无锚点条目 / 锚点无行号 / 锚点格式不可解析 / 文件不可读(>1MB 等)→ 该锚点 unchecked,不参与生死判定。
//
// 性能(注入是开卡热路径):文件存在性/内容按 (项目目录|相对路径) 做进程内缓存,以 mtime 失效
//   (mtimeOf 由调用方注入;未提供 mtimeOf 或返回 undefined 则不缓存、每次实查,保证单测与无 git 场景确定)。
//   churn 按 (目录|文件|since日期) 缓存 —— 日期在 key 里,天然按天失效。两缓存各限 500 条,超限整表清
//   (重建成本低)。clearCache() 供测试与设置变更后清。
//
// 两级索引注入(injectText):一级 = scene 分词(按 /、,，;；空白 切分,≥2 字)或锚点路径/文件名(≥4 字符)
//   对 opts.target(当前目标文本,大小写不敏感子串匹配)确定性命中 → 必注入,优先占预算;
//   二级 = 其余条目维持新→旧兜底。预算 ≤60 条 / ≤6000 字不变;一级命中本身超预算照样截断,
//   命中/略去/隔离条数全部在头部明示(别让模型以为看到的是全部)。
//
// 治理用纯函数(供后续治理界面波次用):listEntries(解析文件 → 条目数组)/
//   deleteEntries(按 index 删,空日期节连节头一起清)/editEntry(改正文/锚点/场景/置信度)。
//   都只返回新文件内容,不落盘 —— 落盘是调用方的事。
//
// 注入依赖(deps,全部由调用方注入,本模块不碰 fs/git):
//   existsFile(rel)→bool / readFile(rel)→string|null / mtimeOf(rel)→number|undefined
//   churnOf(rel, sinceDate)→改动行数 number|null(不可用)
//   —— 调用方负责路径围栏(锚点不得越出项目目录,见 session.js knowledgeDeps)。
const path = require('path')
const crypto = require('crypto')

// 同一目录 → 同一 slug(跨会话稳定);不同项目不撞(同名目录靠 hash 区分)
function slugFor(dir) {
  const d = String(dir || '').replace(/[\\/]+$/, '')
  const base = (d.split(/[\\/]/).pop() || 'project').replace(/[\\/:*?"<>|\s]+/g, '_')
  const h = crypto.createHash('md5').update(d).digest('hex').slice(0, 8)
  return base + '_' + h
}
function fileFor(dir, userDataDir) {
  return path.join(userDataDir, 'knowledge', slugFor(dir) + '.md')
}

// 条目归一成一行:- [verified] 一句话 (锚点: a.js:88, b.sql:12) (场景: 计息/跑批)
// anchors/scene 可空;confidence 只认 verified|suspected(默认 verified)。
function fmtEntry(e) {
  const text = String((e && e.text) || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const conf = /suspect/i.test(String((e && e.confidence) || '')) ? 'suspected' : 'verified'
  const anchors = Array.isArray(e && e.anchors) ? e.anchors.map((a) => String(a).trim()).filter(Boolean).slice(0, 6) : []
  const scene = String((e && e.scene) || '').replace(/\s+/g, ' ').trim()
  let line = '- [' + conf + '] ' + text
  if (anchors.length) line += ' (锚点: ' + anchors.join(', ') + ')'
  if (scene) line += ' (场景: ' + scene + ')'
  return line
}
// 去重的键:一句话正文(忽略首尾空白与大小写)。完全匹配才去重 —— 近似合并是模型活,壳层不做。
function entryKey(line) {
  const m = String(line).match(/^- \[[^\]]+\]\s*(.*?)\s*(?:\((?:锚点|场景):|$)/)
  return (m ? m[1] : String(line)).trim().toLowerCase()
}

// 追加:existing=文件现有内容('' 表示没有),entries=[{text,anchors,scene,confidence}...]
// 返回 { content, added, dupes } —— added=真加进去的条数,dupes=撞重跳过的条数。
function appendEntries(existing, entries, dateStr) {
  const lines = String(existing || '').split('\n')
  const seen = new Set(lines.filter((l) => l.startsWith('- [')).map(entryKey))
  const fresh = []
  let dupes = 0
  for (const e of entries || []) {
    const line = fmtEntry(e)
    if (!line) continue
    const k = entryKey(line)
    if (seen.has(k)) { dupes++; continue }
    seen.add(k); fresh.push(line)
  }
  let content = String(existing || '').trimEnd()
  if (fresh.length) {
    const stamp = '## ' + (dateStr || new Date().toISOString().slice(0, 10))
    // 今天的节已在且是最后一节 → 续在节尾;否则开新日期节(判"最后一节"==今天,不能 endsWith:文件尾部是条目不是节头)
    const heads = content.split('\n').filter((l) => l.startsWith('## '))
    const hasToday = !!(heads.length && heads[heads.length - 1] === stamp)
    if (content && !hasToday) content += '\n\n' + stamp + '\n' + fresh.join('\n')
    else if (content) content += '\n' + fresh.join('\n')
    else content = '# 项目知识库(任务尾蒸馏:系统级事实,每条带锚点与场景)\n\n' + stamp + '\n' + fresh.join('\n')
  }
  return { content: content + (content ? '\n' : ''), added: fresh.length, dupes }
}

// ── 解析(治理/防腐共用)────────────────────────────────────────────────────────
// 单行条目解析:- [conf] 正文 (锚点: a.js:88, b.sql:12) (场景: x/y)
// 从尾部往回剥(场景在后、锚点在前),剩下的就是正文 —— 正文里就算有括号也不误判。
function parseEntryLine(line) {
  const m0 = String(line).match(/^- \[([^\]]*)\]\s*(.*)$/)
  if (!m0) return null
  let body = m0[2].trim(), anchors = [], scene = ''
  const sm = body.match(/^(.*?)\s*\(场景: ([^()]*)\)\s*$/)
  if (sm) { scene = sm[2].trim(); body = sm[1].trim() }
  const am = body.match(/^(.*?)\s*\(锚点: ([^()]*)\)\s*$/)
  if (am) { anchors = am[2].split(',').map((s) => s.trim()).filter(Boolean); body = am[1].trim() }
  return { confidence: m0[1].trim() || 'verified', text: body.trim(), anchors, scene }
}
// 解析整个文件 → [{index, date, confidence, text, anchors, scene, raw}]
// index 是全文件条目序号(0 起,治理 API 按它定位);date = 所在 ## YYYY-MM-DD 节(没有节头则为 '')。
function listEntries(rawText) {
  const out = []
  let date = ''
  for (const line of String(rawText || '').split('\n')) {
    const h = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/)
    if (h) { date = h[1]; continue }
    if (!line.startsWith('- [')) continue
    const p = parseEntryLine(line)
    if (!p) continue
    out.push({ index: out.length, date, confidence: p.confidence, text: p.text, anchors: p.anchors, scene: p.scene, raw: line })
  }
  return out
}

// ── 防腐校验 C1-C4 ────────────────────────────────────────────────────────────
// 进程内缓存(见文件头"性能"段):files 按 mtime 失效,churn 按 since 日期天然按天失效。
const _cache = { files: new Map(), churn: new Map() }
function clearCache() { _cache.files.clear(); _cache.churn.clear() }
function _fileInfo(rel, d, dirKey) {
  const key = dirKey + '|' + rel
  const mt = d.mtimeOf ? d.mtimeOf(rel) : undefined
  const hit = _cache.files.get(key)
  if (hit && mt !== undefined && hit.mtime === mt) return hit.info
  const info = { exists: false, text: null }
  try { info.exists = !!(d.existsFile && d.existsFile(rel)) } catch {}
  if (info.exists) { try { info.text = d.readFile ? d.readFile(rel) : null } catch { info.text = null } }
  if (mt !== undefined) {
    _cache.files.set(key, { mtime: mt, info })
    if (_cache.files.size > 500) _cache.files.clear()
  }
  return info
}
function _churn(rel, since, d, dirKey) {
  if (!d.churnOf || !since) return null
  const key = dirKey + '|' + rel + '|' + since
  if (_cache.churn.has(key)) return _cache.churn.get(key)
  let v = null
  try { v = d.churnOf(rel, since) } catch { v = null }
  v = (typeof v === 'number' && isFinite(v)) ? v : null
  _cache.churn.set(key, v)
  if (_cache.churn.size > 500) _cache.churn.clear()
  return v
}

// 标识符停用词(语言关键字/路径扩展名/常见英文词)—— 它们在任何文件都 grep 得到,没有防腐价值。
const STOPWORDS = new Set(('the and for with from this that true false null undefined function return const var let new if else while '
  + 'require module exports import export default class extends src index main js ts jsx tsx html css json md sql http https www com cn org net io')
  .split(' '))
// 从一段文本里提取"值得 grep"的符号候选(确定性排序见文件头),最多 4 个。
function extractSymbols(s) {
  const seen = new Set()
  for (const m of String(s || '').matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const t = m[0]
    if (!STOPWORDS.has(t.toLowerCase())) seen.add(t)
  }
  return [...seen]
    .sort((a, b) => {
      const sa = /[A-Z_0-9]/.test(a) ? 1 : 0, sb = /[A-Z_0-9]/.test(b) ? 1 : 0
      return sb - sa || b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)
    })
    .slice(0, 4)
}
// 词边界匹配,返回符号出现的行号数组(1 起)。
function findSymbolLines(text, sym) {
  const re = new RegExp('(^|[^A-Za-z0-9_])' + String(sym).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_]|$)')
  const out = []
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i + 1)
  return out
}
// 离 old 最近的出现行;等距取小行号(确定性)。
function nearestLine(occ, old) {
  let best = occ[0]
  for (const x of occ) {
    const dd = Math.abs(x - old), bd = Math.abs(best - old)
    if (dd < bd || (dd === bd && x < best)) best = x
  }
  return best
}
function parseAnchor(a) {
  const m = String(a || '').match(/^(.*?):(\d+)$/)
  if (!m || !m[1].trim()) return null
  return { file: m[1].trim(), line: +m[2] }
}

// 防腐校验:对文件里每条目跑 C1-C4。
// 返回 { entries: [{index, date, line, status: green|yellow|red, reasons[], anchors: [{raw, file, line, state, why?}]}],
//        content: 有 C3 重定位时为回写后的新文件内容(否则 null,调用方落盘), stats: {total, green, yellow, red} }
// 锚点 state: ok(在) / relocated(C3 已重定位,line 是新行号) / dead(C1/C2 死) / unchecked(无法判定,不参与生死)。
function auditEntries(rawText, deps, opts) {
  const o = opts || {}
  const d = deps || {}
  const dirKey = String(o.dir || '')
  const churnMax = o.churnMaxLines == null ? 300 : o.churnMaxLines
  const parsed = listEntries(rawText)
  const results = []
  const relosByEntry = new Map()   // entryIndex → [{file, from, to}]
  for (const e of parsed) {
    const anchors = []
    const reasons = []
    let dead = 0
    const relos = []
    for (const a of e.anchors) {
      const pa = parseAnchor(a)
      if (!pa) { anchors.push({ raw: a, file: String(a), line: null, state: 'unchecked', why: '锚点格式无法解析' }); continue }
      const info = _fileInfo(pa.file, d, dirKey)
      if (!info.exists) { dead++; anchors.push({ raw: a, file: pa.file, line: pa.line, state: 'dead', why: 'C1 文件不存在' }); continue }
      if (info.text == null) { anchors.push({ raw: a, file: pa.file, line: pa.line, state: 'unchecked', why: '文件不可读/过大,跳过符号校验' }); continue }
      let syms = extractSymbols(e.text)
      let fallback = false
      if (!syms.length && pa.line) {   // 正文无标识符 → 退化用锚点行内容(只能验证存在性,行漂移不可检)
        syms = extractSymbols(String(info.text).split('\n')[pa.line - 1] || '')
        fallback = true
      }
      if (!syms.length) { anchors.push({ raw: a, file: pa.file, line: pa.line, state: 'unchecked', why: '无可用符号,仅校验文件存在' }); continue }
      let occ = [], winSym = ''
      for (const s of syms) { const ls = findSymbolLines(info.text, s); if (ls.length) { occ = ls; winSym = s; break } }
      if (!occ.length) { dead++; anchors.push({ raw: a, file: pa.file, line: pa.line, state: 'dead', why: 'C2 符号不存在: ' + syms.join('/') }); continue }
      if (!pa.line) { anchors.push({ raw: a, file: pa.file, line: null, state: 'ok', why: '无行号,符号 "' + winSym + '" 在' }); continue }
      if (fallback) { anchors.push({ raw: a, file: pa.file, line: pa.line, state: 'ok', why: '符号取自锚点行,行漂移不可检,信任原行号' }); continue }
      if (occ.indexOf(pa.line) >= 0) { anchors.push({ raw: a, file: pa.file, line: pa.line, state: 'ok' }); continue }
      const nl = nearestLine(occ, pa.line)   // C3 行漂移 → 就近重定位,回写由下方统一生成
      relos.push({ file: pa.file, from: pa.line, to: nl })
      anchors.push({ raw: a, file: pa.file, line: nl, state: 'relocated', why: 'C3 行漂移 ' + pa.line + '→' + nl + '(符号 "' + winSym + '")' })
    }
    let status = 'green'
    if (e.anchors.length && dead === e.anchors.length) { status = 'red'; reasons.push('锚点全死(C1/C2),隔离不注入') }
    else if (dead) { status = 'yellow'; reasons.push(dead + '/' + e.anchors.length + ' 锚点失效(C1/C2)') }
    if (relos.length) { reasons.push('行漂移已重定位: ' + relos.map((r) => r.file + ':' + r.from + '→' + r.to).join(', ')); relosByEntry.set(e.index, relos) }
    // C4:自所在日期节(verified 代理)以来锚点文件 churn 超阈 → 标黄。churnOf 全不可用则跳过。
    if (status !== 'red' && e.date && d.churnOf) {
      const files = [...new Set(e.anchors.map(parseAnchor).filter(Boolean).map((p) => p.file))]
      let sum = 0, avail = false
      for (const f of files) { const v = _churn(f, e.date, d, dirKey); if (v != null) { avail = true; sum += v } }
      if (avail && sum > churnMax) { status = 'yellow'; reasons.push('自 ' + e.date + ' 以来锚点文件 churn ' + sum + ' 行(阈值 ' + churnMax + '),注入带 [待复核]') }
    }
    results.push({ index: e.index, date: e.date, line: e.raw, status, reasons, anchors })
  }
  // C3 回写:有重定位才生成新文件内容(纯函数不落盘,调用方写)。
  let content = null
  if (relosByEntry.size) {
    const lines = String(rawText || '').split('\n')
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('- [')) continue
      idx++
      const rs = relosByEntry.get(idx)
      if (rs) for (const r of rs) lines[i] = lines[i].replace(r.file + ':' + r.from, r.file + ':' + r.to)
    }
    content = lines.join('\n')
  }
  const stats = { total: results.length, green: 0, yellow: 0, red: 0 }
  for (const r of results) stats[r.status]++
  return { entries: results, content, stats }
}

// ── 两级索引注入 ──────────────────────────────────────────────────────────────
// 一级命中:scene 分词(≥2 字)或锚点路径/文件名(≥4 字符)对 target 的大小写不敏感子串命中。
function hitsTarget(e, target) {
  const sceneToks = String(e.scene || '').split(/[\/,，、;；\s]+/).filter((t) => t.length >= 2)
  for (const t of sceneToks) if (target.indexOf(t.toLowerCase()) >= 0) return true
  for (const a of e.anchors) {
    const p = String(a).replace(/:\d+$/, '').replace(/\\/g, '/').toLowerCase()
    if (p.length >= 4 && target.indexOf(p) >= 0) return true
    const base = p.split('/').pop()
    if (base && base.length >= 4 && target.indexOf(base) >= 0) return true
  }
  return false
}

// 注入文本:两级索引(一级命中必注入、优先占预算;二级新→旧兜底),预算 maxEntries 条 / maxChars 字。
// opts: { maxEntries=60, maxChars=6000, target='', audit=auditEntries 结果(可选) }
//   audit 在场时:red 隔离不注入、yellow 带 [待复核] 前缀(前缀也算进字符预算);
//   命中/略去/隔离条数在头部明示(别让模型以为看到的是全部)。
function injectText(existing, dir, opts) {
  const o = opts || {}
  const maxEntries = o.maxEntries || 60, maxChars = o.maxChars || 6000
  const target = String(o.target || '').toLowerCase()
  const parsed = listEntries(existing)
  if (!parsed.length) return ''
  const isolated = new Set(), flagged = new Set()
  if (o.audit && Array.isArray(o.audit.entries)) for (const a of o.audit.entries) {
    if (a.status === 'red') isolated.add(a.index)
    else if (a.status === 'yellow') flagged.add(a.index)
  }
  const alive = parsed.filter((e) => !isolated.has(e.index))
  const hit = [], rest = []
  for (const e of alive) (target && hitsTarget(e, target) ? hit : rest).push(e)
  const lineOf = (e) => (flagged.has(e.index) ? '[待复核] ' : '') + e.raw
  // 一级:命中必注入,优先占预算(同级内新→旧;超预算截断并单独计数明示)
  const keep1 = []
  let chars = 0, l1Dropped = 0
  for (let i = hit.length - 1; i >= 0; i--) {
    const L = lineOf(hit[i])
    if (keep1.length >= maxEntries || chars + L.length > maxChars) { l1Dropped++; continue }
    keep1.unshift(L); chars += L.length
  }
  // 二级:其余新→旧兜底(超长条目跳过,继续试更老的短条目)
  const keep2 = []
  for (let i = rest.length - 1; i >= 0 && keep1.length + keep2.length < maxEntries; i--) {
    const L = lineOf(rest[i])
    if (chars + L.length > maxChars) continue
    keep2.unshift(L); chars += L.length
  }
  const dropped = alive.length - keep1.length - keep2.length - l1Dropped
  const notes = []
  if (hit.length) notes.push('场景命中 ' + keep1.length + ' 条优先注入' + (l1Dropped ? ',命中超预算略去 ' + l1Dropped + ' 条' : ''))
  if (dropped) notes.push('共 ' + alive.length + ' 条,按新→旧注入 ' + (keep1.length + keep2.length) + ' 条,略去 ' + dropped + ' 条')
  if (isolated.size) notes.push(isolated.size + ' 条锚点失效已隔离(未注入)')
  const name = path.basename(String(dir || '').replace(/[\\/]+$/, '')) || '本项目'
  return '<项目知识(' + name + ')>\n'
    + (notes.length ? '(' + notes.join(';') + ')\n' : '')
    + keep1.concat(keep2).join('\n') + '\n</项目知识>\n\n'
}

// ── 治理 API(纯逻辑,不落盘;供后续治理界面波次用)────────────────────────────
// 空日期节清理:节头后(到下一节头/文件尾)没有任何条目 → 连节头带前导空行一起删;多余空行压成一行。
function cleanupSections(content) {
  const lines = String(content || '').split('\n')
  const keep = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^##\s/.test(l)) {
      let has = false
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s/.test(lines[j])) break
        if (lines[j].startsWith('- [')) { has = true; break }
      }
      if (!has) { while (keep.length && keep[keep.length - 1] === '') keep.pop(); continue }
    }
    keep.push(l)
  }
  const s = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  return s ? s + '\n' : ''
}
// 删除指定 index 的条目 → 新文件内容(空日期节自动清理;全删完保留文件头)。
function deleteEntries(rawText, indexes) {
  const kill = new Set((Array.isArray(indexes) ? indexes : []).map(Number))
  const lines = String(rawText || '').split('\n')
  const out = []
  let idx = -1
  for (const line of lines) {
    if (line.startsWith('- [')) { idx++; if (kill.has(idx)) continue }
    out.push(line)
  }
  return cleanupSections(out.join('\n'))
}
// 编辑指定 index 条目 → 新文件内容。patch: {text?, anchors?, scene?, confidence?},未给的字段保持原值;
// text 给空串视为"不改"(要删条目请用 deleteEntries);index 越界/行不可解析 → 原样返回。
function editEntry(rawText, index, patch) {
  const src = String(rawText || '')
  const lines = src.split('\n')
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('- [')) continue
    idx++
    if (idx !== Number(index)) continue
    const cur = parseEntryLine(lines[i])
    if (!cur) return src
    const p = patch || {}
    const line = fmtEntry({
      text: p.text != null && String(p.text).trim() ? p.text : cur.text,
      anchors: Array.isArray(p.anchors) ? p.anchors : cur.anchors,
      scene: p.scene != null ? p.scene : cur.scene,
      confidence: p.confidence != null ? p.confidence : cur.confidence,
    })
    if (line) lines[i] = line
    return lines.join('\n')
  }
  return src
}

module.exports = {
  slugFor, fileFor, fmtEntry, entryKey, appendEntries, injectText,
  parseEntryLine, listEntries, auditEntries, extractSymbols, clearCache,
  deleteEntries, editEntry,
}
