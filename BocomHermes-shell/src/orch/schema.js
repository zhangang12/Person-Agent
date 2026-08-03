'use strict'
// ── 决策 JSON 的进出闸(契约 §6)· 纯逻辑,零依赖 ────────────────────────────
//
// 【底座是什么】全仓 grep response_format|json_schema 零命中:sendMessage 的 body 只有
// {parts, agent?, model?, providerID?, modelID?} —— 「用 JSON schema 强约束模型输出」这条路【不存在】,
// 方案文档里那句话已被删掉。能用的只有这一条链:
//     窄提示词 → extractJson(平衡括号) → coerce(宽进) → validate(严出) → 同会话一次窄重问 → 降级梯
//
// 【分工铁律】coerce 修【形状】,validate 判【语义】。
//   · coerce 绝不发明语义:why 编不出来(那是给用户看的决策理由)、done 不许猜、nodes 不许凭空造。
//     它只干"单对象包成数组 / '是'→true / '3'→3 / null→[] / 少了可选字段补默认"这类无损搬运。
//   · validate 的 errors 会被【原样】拼进重问话术:
//         '你上次输出不合法:' + errors.join(';') + '。只输出 JSON,不要解释。'
//     所以每条 errors 必须是【一句能照做的中文指令】,不是给人读的诊断名词("字段类型错误"这种写了等于没写)。
//
// ★ extractJson 用平衡括号扫描,不是 /\{[\s\S]*\}/。贪婪正则有两个死穴,都是实测被咬过的:
//     ① 它吃到【最后】一个 },后面跟着的解释文字里只要再出现一个 } 就整段作废;
//     ② 字符串里的花括号与转义引号会把配平算歪 —— goal 正文里写 "用 {tag} 占位" 是家常便饭。
//   所以这里逐字符扫,带 inString/escape 状态,并且【逐个候选】试解析:第一个 { 开出来的段落解析不了
//   (正文里的 {x} 这种)就换下一个 {,而不是整体失败。
//
// ★ done:true 的硬校验(契约 §6 末尾):final.gaps 必须逐条覆盖输入里的 ledger.gaps 与"无验证证据节点"清单。
//   这是"代码保证信息不丢、模型保留动作权"的落点 —— 取代旧闸 27 那种"代码替它自动补派一根验证棒"的越权:
//   代码不替它决定要不要补验证,但绝不许它把缺口从收口报告里省掉。
//   校验需要输入侧的清单,而契约签名是 validate(point, obj) 两个参数,所以清单走【可选第三参】ctx 传:
//        validate('replan', obj, { gaps: run.ledger.gaps, unverified: ['n3'] })
//   ⚠ 集成方不传 ctx 这条硬校验就静默不生效(退化成只查 final 形状)—— decide.js 里必须传。

const KINDS = ['work', 'probe', 'verify', 'check', 'reduce']
// 只收显而易见的同义词。宽进的边界在这儿:改错一个 kind 的代价是白跑一轮 60~90 秒的重问,
// 而 kind 本身不决定顺序(只有 deps 决定),猜错的下游风险很小。
const KIND_ALIAS = {
  survey: 'probe', research: 'probe', explore: 'probe', investigate: 'probe', scan: 'probe',
  test: 'verify', tests: 'verify', verification: 'verify', validation: 'verify',
  index: 'reduce', summary: 'reduce', summarize: 'reduce', aggregate: 'reduce',
  command: 'check', cmd: 'check', script: 'check',
  task: 'work', coding: 'work', code: 'work', dev: 'work',
  勘察: 'probe', 探查: 'probe', 调研: 'probe', 验证: 'verify', 校验: 'verify',
  检查: 'check', 索引: 'reduce', 汇总: 'reduce', 收口: 'reduce', 开发: 'work', 工作: 'work', 编码: 'work',
}

// ── 小工具(不引任何模块)────────────────────────────────────────────────────
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function str(v) { return String(v === null || v === undefined ? '' : v) }
function text(v) {
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(' ')   // why 被写成数组:拼起来,别丢
  if (isObj(v)) return str(v.text || v.why || v.summary || '')
  return str(v).trim()
}
// 第一个"给了值"的:要能把 false 与 undefined 分开(requireEvidence:false 是模型的有效表态,不能被当没给)
function first() {
  for (let i = 0; i < arguments.length; i++) { const v = arguments[i]; if (v !== undefined && v !== null) return v }
  return undefined
}
function toBool(v, dflt) {
  if (v === true || v === false) return v
  if (v === null || v === undefined || v === '') return dflt
  if (typeof v === 'number') return v !== 0
  const s = str(v).trim().toLowerCase()
  if (['true', 'yes', 'y', '1', 'ok', '是', '对', '要', '需要', '真', '有'].indexOf(s) >= 0) return true
  if (['false', 'no', 'n', '0', 'none', 'null', 'nil', '否', '不', '不要', '不需要', '假', '无', '没有'].indexOf(s) >= 0) return false
  return dflt
}
function toNum(v, dflt) {
  if (typeof v === 'number' && isFinite(v)) return v
  const n = parseInt(str(v).replace(/[^\d.\-]/g, ''), 10)     // '3 个' / '第3' 都收
  return isFinite(n) ? n : dflt
}
// 字符串数组:数组照收;单值包成数组;整串 'a, b、c' 按分隔符切(模型很爱把 writeScope 写成一行)
function toStrArr(v) {
  if (v === null || v === undefined || v === '') return []
  const list = Array.isArray(v) ? v : (isObj(v) ? [v] : str(v).split(/[,，、;；\n]/))
  const out = []
  for (const x of list) {
    const s = isObj(x) ? str(first(x.path, x.text, x.id, x.name, x.title, x.file, '')) : str(x)
    const t = s.trim()
    if (t && out.indexOf(t) < 0) out.push(t)
  }
  return out
}
// 对象数组:★单对象包成数组(模型只想给一个节点时,十有八九不套数组)
function toObjArr(v) {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v
  if (isObj(v)) return [v]
  return []
}

// ── extractJson ──────────────────────────────────────────────────────────
// 平衡括号扫描:字符串内的 { } 与 \" 一律不参与配平。返回 [start, end) 或 null。
function balancedSpan(s, from) {
  let depth = 0, inStr = false, esc = false, start = -1
  for (let i = from; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue }
    if (ch === '}') { if (depth > 0) { depth--; if (depth === 0) return [start, i + 1] } }
  }
  return null
}

// 宽进修补(只在严格解析失败后才跑,所以不怕伤到本来就合法的 JSON):
// 单引号/全角引号 → 标准双引号、// 与 /* */ 注释、全角逗号冒号、尾逗号、裸键、NaN/undefined/True/False。
// 逐字符走一遍并把【字符串段】与【结构段】分开攒:正则只作用在结构段上,不会伤到串内文本
// (串内本来就常有中文逗号和 //,一把梭正则改的就是内容而不是语法)。
function sanitizeJson(s) {
  const chunks = []                        // { s:true, v } 字符串段 / { s:false, v } 结构段
  let raw = ''
  const flush = () => { if (raw) { chunks.push({ s: false, v: raw }); raw = '' } }
  for (let i = 0; i < s.length;) {
    const ch = s[i]
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      const close = ch === '“' ? '”' : (ch === '‘' ? '’' : ch)
      let j = i + 1, body = ''
      while (j < s.length) {
        if (s[j] === '\\') { body += s[j] + (s[j + 1] || ''); j += 2; continue }   // 已转义的两字符原样搬,别二次转义
        if (s[j] === close) break
        body += (s[j] === '"') ? '\\"' : s[j]                                       // 裸双引号只可能出现在单引号/全角串里
        j++
      }
      flush()
      chunks.push({ s: true, v: '"' + body.replace(/\r?\n/g, '\\n') + '"' })        // 串内真换行是 JSON 非法字符
      i = j + 1
      continue
    }
    if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (ch === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue }
    if (ch === '，') { raw += ','; i++; continue }
    if (ch === '：') { raw += ':'; i++; continue }
    raw += ch; i++
  }
  flush()
  let out = ''
  for (const c of chunks) {
    if (c.s) { out += c.v; continue }
    out += c.v
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')      // 裸键
      .replace(/,(\s*[}\]])/g, '$1')                                   // 尾逗号
      .replace(/\b(NaN|undefined|None|nil)\b/g, 'null')
      .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false')
  }
  return out
}

function tryParse(cut) {
  try { const v = JSON.parse(cut); return isObj(v) ? v : null } catch (e) {}
  try { const v = JSON.parse(sanitizeJson(cut)); return isObj(v) ? v : null } catch (e) {}
  return null
}

function scanObjects(s) {
  // 逐个候选试:第一个能【闭合且解析得动】的对象胜出。
  // 空对象 {} 不算数(正文里"什么都不用改就返回 {}"这种话术会先命中),留到最后兜底。
  let fallback = null
  let i = s.indexOf('{')
  while (i >= 0) {
    const span = balancedSpan(s, i)
    if (!span) break                       // 后面再没有能闭合的了
    const v = tryParse(s.slice(span[0], span[1]))
    if (v && Object.keys(v).length) return v
    if (v && !fallback) fallback = v
    i = s.indexOf('{', span[0] + 1)        // 换下一个 { 再试(含嵌套):外层不合法时内层可能就是答案
  }
  return fallback
}

function extractJson(input) {
  if (input && typeof input === 'object') return isObj(input) ? input : null   // 桩/重放可能直接喂对象
  const s = str(input)
  if (!s) return null
  // 有 ``` 围栏就先扫围栏里的:围栏外的解释文字里出现 {…} 是常态,先扫围栏能少一次误判
  const fences = []
  const re = /```[a-zA-Z]*\s*([\s\S]*?)```/g
  let m
  while ((m = re.exec(s))) fences.push(m[1])
  for (const f of fences) { const v = scanObjects(f); if (v) return v }
  return scanObjects(s)
}

// ── coerce ───────────────────────────────────────────────────────────────
function toKind(v) {
  const k = str(v).trim().toLowerCase()
  if (!k) return 'work'
  if (KINDS.indexOf(k) >= 0) return k
  const a = KIND_ALIAS[k] || KIND_ALIAS[str(v).trim()]
  return a || k                              // 认不出来的原样留着 → 交给 validate 报错(代码不替它选 kind)
}
function toMore(v) {
  const s = str(v).trim().toLowerCase()
  if (!s) return 'unknown'
  if (['no', 'none', 'done', 'false', '否', '没有了', '无', '完'].indexOf(s) >= 0) return 'no'
  if (v === false) return 'no'
  return 'unknown'                           // ★拿不准一律 unknown:代码不替模型宣布"没有后续了"
}
function coerceNodeSpec(v) {
  const n = isObj(v) ? v : {}
  const exit = isObj(n.exit) ? n.exit : {}
  const goal = text(first(n.goal, n.instruction, n.description, n.desc, n.detail, ''))
  // title 缺了就从 goal 截 20 字:标题只是 UI 标签,为它退回重问一轮 = 把正确判断惩罚成白跑 90 秒。
  // 而 why 绝不这么补 —— 那是给用户看的决策理由,代码编不出来(见 validate)。
  return {
    title: text(first(n.title, n.name, '')) || goal.slice(0, 20),
    goal,
    kind: toKind(first(n.kind, n.type, '')),
    deps: toStrArr(first(n.deps, n.dependsOn, n.depends_on, n.after, [])),
    writeScope: toStrArr(first(n.writeScope, n.write_scope, n.scope, n.files, [])),
    contract: toStrArr(first(n.contract, n.contracts, n.signatures, [])),
    artifacts: toStrArr(first(n.artifacts, exit.artifacts, n.outputs, n.deliverables, [])),
    requireEvidence: toBool(first(n.requireEvidence, n.require_evidence, exit.requireEvidence), false),
    requireVerdict: toBool(first(n.requireVerdict, n.require_verdict, exit.requireVerdict), false),
    verifyCmd: text(first(n.verifyCmd, n.verify_cmd, exit.verifyCmd, '')),
    noEmpty: toBool(first(n.noEmpty, exit.noEmpty), true),
    maxAttempts: toNum(first(n.maxAttempts, 2), 2),
  }
}
function coerceFact(v) {
  if (isObj(v)) return { text: text(first(v.text, v.fact, v.summary, '')), anchors: toStrArr(first(v.anchors, v.anchor, v.refs, [])) }
  return { text: text(v), anchors: [] }
}
function coerceDrop(v) {
  if (isObj(v)) return { id: text(first(v.id, v.nodeId, v.node, '')), why: text(first(v.why, v.reason, '')) }
  return { id: text(v), why: '' }
}
// dropNodes 写成 ['n5'] 是常见简写:字符串项补成 {id,why:''},不要求模型记住形状
function toDropArr(v) {
  if (v === null || v === undefined || v === '') return []
  return (Array.isArray(v) ? v : [v]).map(coerceDrop).filter((d) => d.id)
}
// 缺口条目一律拍平成一句话,但【nodeId 必须留在句子里】—— done:true 的覆盖校验按节点 id 逐条对
function gapText(v) {
  if (!isObj(v)) return text(v)
  const t = text(first(v.text, v.detail, v.why, v.summary, ''))
  const id = text(first(v.nodeId, v.id, ''))
  const kind = text(first(v.kind, ''))
  if (!id) return [kind, t].filter(Boolean).join(': ')
  return [id, kind, t].filter(Boolean).join(': ')
}
function toGapArr(v) {
  const list = (v === null || v === undefined) ? [] : (Array.isArray(v) ? v : [v])
  const out = []
  for (const x of list) { const t = gapText(x); if (t) out.push(t) }
  return out
}
function coerceFinal(v) {
  if (v === null || v === undefined || v === '') return null
  if (!isObj(v)) return { summary: text(v), deliverables: [], gaps: [] }
  return {
    summary: text(first(v.summary, v.text, v.conclusion, '')),
    deliverables: toStrArr(first(v.deliverables, v.artifacts, v.outputs, [])),
    gaps: toGapArr(first(v.gaps, v.gap, [])),
  }
}
function coerceAsk(v) {
  if (v === null || v === undefined || v === '' || v === false) return null
  if (isObj(v)) {
    const q = text(first(v.question, v.text, v.ask, ''))
    return q ? { question: q, options: toStrArr(first(v.options, v.choices, [])) } : null
  }
  const q = text(v)
  return q ? { question: q, options: [] } : null
}

function coerce(point, obj) {
  const o = isObj(obj) ? obj : {}
  // 决策器有时把答案套一层("result"/"output"/"data"/"json"):剥一层再看,剥不出来就用原对象
  const inner = ['result', 'output', 'data', 'json', 'answer'].map((k) => o[k]).filter(isObj)[0]
  const src = (inner && (inner.nodes || inner.addNodes || inner.done !== undefined || inner.more)) ? inner : o
  if (point === 'plan') {
    return {
      needGrounding: toBool(first(src.needGrounding, src.need_grounding), false),
      nodes: toObjArr(first(src.nodes, src.addNodes, src.tasks, src.shards, [])).map(coerceNodeSpec).filter((n) => n.goal || n.title),
      more: toMore(first(src.more, src.hasMore)),
      open: toStrArr(first(src.open, src.openQuestions, [])),
      why: text(first(src.why, src.reason, src.rationale, '')),
    }
  }
  // replan
  return {
    needGrounding: toBool(first(src.needGrounding, src.need_grounding), false),
    addNodes: toObjArr(first(src.addNodes, src.nodes, src.add, [])).map(coerceNodeSpec).filter((n) => n.goal || n.title),
    dropNodes: toDropArr(first(src.dropNodes, src.drop, [])),
    done: toBool(first(src.done, src.finished, src.complete), false),
    askUser: coerceAsk(first(src.askUser, src.ask_user, src.question)),
    facts: ((src.facts === null || src.facts === undefined) ? [] : (Array.isArray(src.facts) ? src.facts : [src.facts])).map(coerceFact).filter((f) => f.text),
    open: toStrArr(first(src.open, src.openQuestions, [])),
    more: toMore(first(src.more, src.hasMore)),
    why: text(first(src.why, src.reason, src.rationale, '')),
    final: coerceFinal(first(src.final, src.result, null)),
  }
}

// ── validate ─────────────────────────────────────────────────────────────
// 与 ledger 的 normKey 是同一套口径,但【故意复制一份】:契约 §1 规定 schema.js 的允许依赖是"无",
// 连 ./ledger 都不许引。这是两个叶子模块,不共享私有工具是它的定价。
function normKey(t) {
  return String(t === null || t === undefined ? '' : t).toLowerCase().replace(/\s+/g, '')
    .replace(/[，,。.、；;：:！!？?…“”"'‘’（）()【】\[\]《》〈〉「」『』<>~～—－\-_·`|]/g, '')
}
// 节点 id 在一段文字里的"整词"命中:防 n3 命中 n30
function mentionsId(hay, id) {
  const s = str(hay), k = str(id).trim()
  if (!k) return false
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(^|[^A-Za-z0-9_])' + esc + '([^A-Za-z0-9_]|$)', 'i').test(s)
}

function checkNodeList(list, prefix, errors) {
  for (let i = 0; i < list.length; i++) {
    const n = isObj(list[i]) ? list[i] : {}
    const at = prefix + '[' + i + ']'
    if (!text(n.goal)) errors.push(at + '.goal 为空 —— 每个节点都要写完整的指令正文(不限长度,别只给一个标题)')
    if (!text(n.title)) errors.push(at + '.title 为空 —— 给一句 20 字以内的标题')
    if (KINDS.indexOf(str(n.kind)) < 0) errors.push(at + '.kind 是「' + str(n.kind) + '」,不在允许范围内;只能填 ' + KINDS.join(' / ') + ' 之一')
    if (!Array.isArray(n.deps)) errors.push(at + '.deps 必须是数组(没有依赖就写 [])')
    if (!Array.isArray(n.writeScope)) errors.push(at + '.writeScope 必须是数组(相对工作目录的路径;不写文件就写 [])')
    if (!Array.isArray(n.contract)) errors.push(at + '.contract 必须是数组(没有要交付的签名就写 [])')
    if (!Array.isArray(n.artifacts)) errors.push(at + '.artifacts 必须是数组(没有必须落盘的文件就写 [])')
    if (typeof n.requireEvidence !== 'boolean') errors.push(at + '.requireEvidence 必须是 true 或 false —— 这片要不要跑构建/测试当证据,由你判断')
    if (typeof n.requireVerdict !== 'boolean') errors.push(at + '.requireVerdict 必须是 true 或 false')
    if (typeof n.verifyCmd !== 'string') errors.push(at + '.verifyCmd 必须是字符串(不需要壳层代跑命令就写 "")')
  }
}

// done:true 的硬校验:把输入侧的缺口清单摊开成"必须逐条交代"的待覆盖项
function requiredCoverage(ctx) {
  const c = isObj(ctx) ? ctx : {}
  const led = isObj(c.ledger) ? c.ledger : {}
  const gaps = first(c.gaps, led.gaps, []) || []
  const unv = first(c.unverified, c.unverifiedNodes, c.noEvidenceNodes, []) || []
  const need = []
  for (const g of (Array.isArray(gaps) ? gaps : [gaps])) {
    const id = isObj(g) ? str(first(g.nodeId, g.id, '')) : ''
    const t = isObj(g) ? str(first(g.text, g.detail, '')) : str(g)
    if (!id && !t) continue
    need.push({ id, key: normKey(t), label: '缺口:' + (id ? id + ' ' : '') + (t || '') })
  }
  for (const u of (Array.isArray(unv) ? unv : [unv])) {
    const id = isObj(u) ? str(first(u.id, u.nodeId, '')) : str(u)
    if (!id) continue
    need.push({ id, key: '', label: '无验证证据的节点:' + id })
  }
  return need
}
function coverageMisses(finalGaps, need) {
  const list = (Array.isArray(finalGaps) ? finalGaps : []).map((g) => str(isObj(g) ? first(g.text, g.detail, '') : g))
  const miss = []
  for (const n of need) {
    const hit = list.some((g) => {
      if (n.id && mentionsId(g, n.id)) return true
      if (!n.key) return false
      const k = normKey(g)
      if (!k) return false
      const short = n.key.length <= k.length ? n.key : k
      const long = n.key.length <= k.length ? k : n.key
      return short.length >= 4 && long.indexOf(short) >= 0
    })
    if (!hit) miss.push(n.label)
  }
  return miss
}

function validate(point, obj, ctx) {
  const errors = []
  if (!isObj(obj)) return { ok: false, errors: ['整个输出必须是一个 JSON 对象(顶层不要用数组,也不要在 JSON 外写解释文字)'] }

  if (point === 'plan') {
    if (!Array.isArray(obj.nodes)) errors.push('nodes 必须是数组;只有一个节点也要放进数组里')
    else {
      checkNodeList(obj.nodes, 'nodes', errors)
      // ★ 空数组不是"待定":代码不替它宣布收口,也不接受"我还没想好"这种半截答案
      if (!obj.nodes.length && str(obj.more) !== 'no') {
        errors.push('nodes 是空数组但 more 不是 "no" —— 要么给出至少一个节点;要么确实判断不值得拆,那就同时写 more:"no";如果只是还没看清代码,请给一个 kind:"probe" 的勘察节点,或把不确定的点写进 open')
      }
    }
    if (['no', 'unknown'].indexOf(str(obj.more)) < 0) errors.push('more 只能是 "no"(没有后续了)或 "unknown"(我还会有后续,别急着收口)')
    if (!Array.isArray(obj.open)) errors.push('open 必须是数组(没有未决问题就写 [])')
    if (typeof obj.needGrounding !== 'boolean') errors.push('needGrounding 必须是 true 或 false')
    return { ok: !errors.length, errors }
  }

  if (point === 'replan') {
    if (!Array.isArray(obj.addNodes)) errors.push('addNodes 必须是数组(这一步不加节点就写 [])')
    else checkNodeList(obj.addNodes, 'addNodes', errors)
    if (!Array.isArray(obj.dropNodes)) errors.push('dropNodes 必须是数组(不撤节点就写 [])')
    else obj.dropNodes.forEach((d, i) => { if (!isObj(d) || !text(d.id)) errors.push('dropNodes[' + i + '] 要写成 {"id":"n5","why":"撤掉的理由"};id 不能为空') })
    if (typeof obj.done !== 'boolean') errors.push('done 必须是 true 或 false')
    if (!Array.isArray(obj.facts)) errors.push('facts 必须是数组(没有新事实就写 [])')
    if (!Array.isArray(obj.open)) errors.push('open 必须是数组(没有未决问题就写 [])')
    if (['no', 'unknown'].indexOf(str(obj.more)) < 0) errors.push('more 只能是 "no" 或 "unknown"')
    if (typeof obj.needGrounding !== 'boolean') errors.push('needGrounding 必须是 true 或 false')
    // why 必填且不许代码代笔:它会原样显示给用户看"它为什么这么决定"
    if (!text(obj.why)) errors.push('why 为空 —— 必须用一句话说明这一步为什么这么决定(会原样展示给用户,不能省)')
    if (obj.askUser !== null && obj.askUser !== undefined && !(isObj(obj.askUser) && text(obj.askUser.question))) {
      errors.push('askUser 要么是 null,要么写成 {"question":"要问用户的话","options":["选项A","选项B"]}')
    }
    if (obj.done === true) {
      if (obj.addNodes && obj.addNodes.length) errors.push('done:true 和 addNodes 同时出现,自相矛盾 —— 要么继续加节点(done:false),要么收口(addNodes:[])')
      if (obj.askUser) errors.push('done:true 和 askUser 不能同时给 —— 还要问用户就不算收口')
      if (!isObj(obj.final)) errors.push('done:true 时 final 必填,形状是 {"summary":"总结","deliverables":["产出路径"],"gaps":["还差什么"]}')
      else {
        if (!text(obj.final.summary)) errors.push('final.summary 为空 —— 收口报告要有一段总结')
        if (!Array.isArray(obj.final.deliverables)) errors.push('final.deliverables 必须是数组(产出文件/路径清单,没有就写 [])')
        if (!Array.isArray(obj.final.gaps)) errors.push('final.gaps 必须是数组(没有缺口就写 [])')
        else {
          const miss = coverageMisses(obj.final.gaps, requiredCoverage(ctx))
          if (miss.length) {
            errors.push('done:true 但 final.gaps 漏了这些必须逐条交代的项:' + miss.join('、')
              + ' —— 每一条都要单独写进 final.gaps 并说明现状与影响;可以判断它不重要,但不能不写(也不许合并成"其余无问题"这类一句话)')
          }
        }
      }
    } else if (obj.final !== null && obj.final !== undefined && !isObj(obj.final)) {
      errors.push('final 只在 done:true 时填,平时写 null')
    }
    return { ok: !errors.length, errors }
  }

  return { ok: false, errors: ['未知的决策点「' + str(point) + '」:只有 plan 与 replan 两个'] }
}

module.exports = { extractJson, coerce, validate, KINDS }

// ── 最小验证(独立可跑)──────────────────────────────────────────────────────
// 整段贴进 node REPL,或存成文件后 node 它;全绿打印 schema ok。
//
// const S = require('./src/orch/schema.js')
// const assert = require('assert')
// // ① 解释文字 + 围栏 + 对象 + 后续废话:抠出对象,串内花括号与转义引号不影响配平
// const raw = '好的,我的方案如下:\n```json\n{"nodes":[{"title":"迁移 order","goal":"用 {tag} 占位,别写成 \\"x\\"}","kind":"work"}],"more":"unknown","open":[],"why":"先拆一片"}\n```\n以上,如有问题请告知。}'
// const got = S.extractJson(raw)
// assert.strictEqual(got.nodes[0].goal, '用 {tag} 占位,别写成 "x"}')
// // ② 贪婪正则的死穴:后面还有 } 时 /\{[\s\S]*\}/ 会吃到最后一个,平衡扫描不会
// assert.strictEqual(JSON.stringify(S.extractJson('前言 {"a":1} 后面还有一个 }')), '{"a":1}')
// // ③ 宽进:单对象包成数组 / '是'→true / '3'→3 / null→[]
// const p = S.coerce('plan', { nodes: { title: 't', goal: 'g', requireEvidence: '是', maxAttempts: '3' }, more: null, open: null })
// assert.strictEqual(p.nodes.length, 1); assert.strictEqual(p.nodes[0].requireEvidence, true)
// assert.strictEqual(p.nodes[0].maxAttempts, 3); assert.deepStrictEqual(p.open, []); assert.strictEqual(p.more, 'unknown')
// assert.strictEqual(S.validate('plan', p).ok, true)
// // ④ 严出:空 nodes 又不写 more:'no' → 驳回,错误话术可直接喂回模型
// const v = S.validate('plan', S.coerce('plan', { nodes: [], more: 'unknown' }))
// assert.strictEqual(v.ok, false); assert.ok(/probe/.test(v.errors.join(';')))
// // ⑤ done:true 的硬校验:final.gaps 漏了 ledger.gaps 或无证据节点 → 不合法
// const done = S.coerce('replan', { done: true, why: '都齐了', final: { summary: '完成', deliverables: ['docs/README.md'], gaps: ['n3 契约缺 createPayment'] } })
// const ctx = { gaps: [{ nodeId: 'n3', detail: '契约缺 createPayment' }], unverified: ['n5'] }
// const v2 = S.validate('replan', done, ctx)
// assert.strictEqual(v2.ok, false); assert.ok(/n5/.test(v2.errors.join(';')))
// done.final.gaps.push('n5 没有跑过构建/测试,未验证')
// assert.strictEqual(S.validate('replan', done, ctx).ok, true)
// // ⑥ why 不许代码代笔
// assert.strictEqual(S.validate('replan', S.coerce('replan', { addNodes: [] })).ok, false)
// console.log('schema ok')
