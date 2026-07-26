// chat 页 · 富结果引擎(ESM 移植自 ui/rich.js,信任边界不变)
// 移植说明:
//   - 渲染逻辑逐行对齐 ui/rich.js(IIFE → ESM 导出),不做"顺手优化";
//   - 信任边界:renderMarkdown 产出的 HTML 只允许渲模型/引擎内容(v-html),
//     用户输入永远走 esc/文本节点,不进这里;
//   - wireActions 的 copy/extlink 行为内建;open/todo/apply/run 由调用方注入 handlers;
//   - foldLongCode 原在 card.html(>24 行 pre 收成 details),一并收进这里供指令复用。
import { esc } from './lib/text'

const FLOC = /([\w./\\-]+\.[A-Za-z]\w*):(\d+)/g
// http(s) 链接可点(系统浏览器打开):跑在 esc 之后 → 匹配已转义文本,
// &amp; 是 URL 常客要吃进去;结尾的中英文标点/右括号大概率是句子的不是 URL 的,剥掉
const EXTURL = /(https?:\/\/[^\s<>"'一-鿿＀-￯　-〿]+)/g   // 排除 CJK 与全角标点
const extlink = (s: string) => s.replace(EXTURL, (m) => {
  let u = m; const trail = u.match(/[)）\]。，,;；.!?、]+$/); if (trail) u = u.slice(0, -trail[0].length)
  return '<a class="extlink" data-url="' + u + '" title="在系统浏览器打开">' + u + '</a>' + (trail ? trail[0] : '')
})
const linkify = (s: string) => extlink(s.replace(FLOC, (m, f, l) => '<a class="floc" data-file="' + f + '" data-line="' + l + '">' + m + '</a>'))
const inline = (s: string) => linkify(esc(s))
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')

// findings 严重度徽标
const SEV: Record<string, string> = { '必改': 'must', '严重': 'must', '高危': 'must', '致命': 'must', '建议': 'sugg', '警告': 'sugg', '注意': 'sugg', '可忽略': 'info', '提示': 'info', 'nit': 'info' }
const sevBadge = (s: string) => s.replace(/^\s*\[?\s*(必改|严重|高危|致命|建议|警告|注意|可忽略|提示|nit)\s*\]?\s*[:：\-]?\s*/i, function (m, w) {
  const c = SEV[w] || SEV[String(w).toLowerCase()]; return c ? '<span class="sev sev-' + c + '">' + w + '</span>' : m
})

const SHELL = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat'])
const isDiff = (lang: string, code: string) => lang === 'diff' || lang === 'patch'
  || /^(diff --git |@@ )/m.test(code) || (/^[+-]/m.test(code) && /^@@/m.test(code))

// ---- 块渲染 ----
function actBtn(act: string, label: string, primary?: boolean) {
  return '<button class="' + (primary ? 'rbtn-primary' : 'rbtn-ghost') + '" data-act="' + act + '">' + label + '</button>'
}
function head(typeLabel: string, fileAttr: string, acts: string) {
  return '<div class="rbhd"><span class="rfile mono"' + fileAttr + '>' + esc(typeLabel) + '</span><span class="racts">' + acts + '</span></div>'
}
function diffMeta(code: string) {
  const m = code.match(/^\+\+\+\s+b\/(.+)$/m) || code.match(/^\+\+\+\s+(.+)$/m)
    || code.match(/^diff --git a\/\S+ b\/(.+)$/m) || code.match(/^---\s+a\/(.+)$/m)
  const lm = code.match(/@@\s*-\d+(?:,\d+)?\s*\+(\d+)/)
  return { file: m ? m[1].trim() : '', line: lm ? lm[1] : '1' }
}
function diffLineClass(l: string) {
  if (/^@@/.test(l)) return 'dl-hunk'
  if (/^(\+\+\+|---|diff |index )/.test(l)) return 'dl-meta'
  if (/^\+/.test(l)) return 'dl-add'
  if (/^-/.test(l)) return 'dl-del'
  return ''
}
function splitDiffFiles(code: string): string[] {
  const lines = code.split('\n')
  let bounds: number[] = []
  lines.forEach((l, i) => { if (/^diff --git /.test(l)) bounds.push(i) })
  if (bounds.length < 2) {
    const idx: number[] = []
    for (let i = 0; i < lines.length - 1; i++) if (/^--- /.test(lines[i]) && /^\+\+\+ /.test(lines[i + 1])) idx.push(i)
    if (idx.length >= 2) bounds = idx
  }
  if (bounds.length < 2) return [code]
  const chunks: string[] = []
  for (let k = 0; k < bounds.length; k++) {
    const end = k + 1 < bounds.length ? bounds[k + 1] : lines.length
    chunks.push(lines.slice(bounds[k], end).join('\n').replace(/\n+$/, ''))
  }
  if (bounds[0] > 0) chunks[0] = lines.slice(0, bounds[0]).join('\n') + '\n' + chunks[0]
  return chunks
}
function renderOneDiff(code: string) {
  const { file, line } = diffMeta(code)
  const fileAttr = file ? ' data-file="' + esc(file) + '" data-line="' + line + '"' : ''
  const acts = actBtn('apply', '应用', true) + actBtn('copy', '复制') + (file ? actBtn('open', '打开') : '')
  const body = code.split('\n').map((l) => '<div class="dl ' + diffLineClass(l) + '" style="min-height:15px">' + esc(l) + '</div>').join('')
  return '<div class="rblk" data-type="diff">' + head(file || 'diff', fileAttr, acts) + '<div class="rbody rdiff">' + body + '</div></div>'
}
function renderDiff(code: string) {
  const files = splitDiffFiles(code)
  if (files.length <= 1) return renderOneDiff(code)
  const bar = '<div class="rsetbar"><span class="rsetlabel mono">' + files.length + ' 个文件</span><span class="racts">'
    + actBtn('applyall', '全部应用', true) + actBtn('copyall', '复制全部') + '</span></div>'
  return '<div class="rdiffset">' + bar + files.map(renderOneDiff).join('') + '</div>'
}
// ---- 轻量语法高亮(消费 design.css 的 syntax 色板:kw/str/cmt/fn/var/num,不用任何外库)----
// 一遍主正则分词:注释(按语言)// 或 # → 字符串 → 数字 → 标识符(关键词/函数名/普通),逐段 esc 后包 span。
const KW: Record<string, string> = {
  js: 'const|let|var|function|return|if|else|for|while|do|break|continue|switch|case|default|try|catch|finally|throw|new|class|extends|super|this|null|undefined|true|false|typeof|instanceof|in|of|async|await|yield|static|import|from|export|delete|void',
  java: 'public|private|protected|static|final|class|interface|extends|implements|new|return|if|else|for|while|do|break|continue|switch|case|default|try|catch|finally|throw|throws|this|super|null|true|false|void|int|long|double|float|boolean|char|byte|short|import|package|synchronized|volatile|abstract|enum|instanceof',
  py: 'def|class|return|if|elif|else|for|while|break|continue|pass|try|except|finally|raise|import|from|as|with|lambda|None|True|False|and|or|not|in|is|global|nonlocal|yield|async|await|print|self',
  sql: 'SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|AS|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END|UNION|ALL|DESC|ASC|LIKE|BETWEEN|EXISTS|HAVING',
  sh: 'if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|local|export|echo|cd|set|unset|shift|exit|source|eval|exec|readonly|declare',
}
function langKey(lang: string): string {
  if (/^(js|jsx|ts|tsx|javascript|typescript|mjs|cjs|vue|json)$/.test(lang)) return 'js'
  if (/^(java|kt|kotlin|scala|go|rs|rust|c|cpp|cc|cs|csharp)$/.test(lang)) return 'java'
  if (/^(py|python)$/.test(lang)) return 'py'
  if (/^(sql|mysql|plsql|obsql)$/.test(lang)) return 'sql'
  if (/^(sh|bash|zsh|shell|cmd|bat|powershell|ps1)$/.test(lang)) return 'sh'
  return ''
}
export function hlCode(code: string, lang: string): string {
  const key = langKey(lang)
  // 注释形状:c 系 // /* */;py/sh/yaml/toml 用 #
  const cmtSrc = /^(py|python|sh|bash|zsh|shell|yaml|yml|toml|ini|conf)$/.test(lang) ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'
  const master = new RegExp(
    '(' + cmtSrc + ')'
    + '|(' + "'(?:[^'\\\\\\n]|\\\\.)*'|\"(?:[^\"\\\\\\n]|\\\\.)*\"|`(?:[^`\\\\]|\\\\.)*`" + ')'
    + '|(\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?[lLf]?\b)'
    + '|([A-Za-z_$][\\w$.]*)', 'g')
  const kwRe = key ? new RegExp('^(?:' + KW[key] + ')$') : null
  let out = '', last = 0, m: RegExpExecArray | null
  while ((m = master.exec(code))) {
    out += esc(code.slice(last, m.index))
    const [, c, s, n, w] = m
    if (c) out += '<span class="tk-c">' + esc(c) + '</span>'
    else if (s) out += '<span class="tk-s">' + esc(s) + '</span>'
    else if (n) out += '<span class="tk-n">' + esc(n) + '</span>'
    else if (w) {
      if (kwRe && kwRe.test(w)) out += '<span class="tk-k">' + esc(w) + '</span>'
      else if (/^\s*\(/.test(code.slice(m.index + w.length, m.index + w.length + 2))) out += '<span class="tk-f">' + esc(w) + '</span>'
      else out += '<span class="tk-v">' + esc(w) + '</span>'
    }
    last = m.index + m[0].length
  }
  return out + esc(code.slice(last))
}
function renderCmd(code: string, lang: string) {
  const acts = actBtn('run', '运行', true) + actBtn('copy', '复制')
  return '<div class="rblk" data-type="cmd">' + head(lang || 'bash', '', acts) + '<pre class="rbody"><code>' + hlCode(code, lang) + '</code></pre></div>'
}
function renderCode(code: string, lang: string) {
  const acts = actBtn('copy', '复制')
  return '<div class="rblk" data-type="code">' + head(lang || 'code', '', acts) + '<pre class="rbody"><code>' + hlCode(code, lang) + '</code></pre></div>'
}
function renderBlock(lang: string, code: string) {
  if (isDiff(lang, code)) return renderDiff(code)
  if (SHELL.has(lang)) return renderCmd(code, lang)
  return renderCode(code, lang)
}

// ---- Markdown(逐行解析,围栏块走 renderBlock)----
export function renderMarkdown(md: string): string {
  if (!md) return ''
  const blocks: string[] = []
  md = md.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, function (_m, lang: string, code: string) {
    blocks.push(renderBlock((lang || '').toLowerCase(), code.replace(/\n$/, '')))
    return '@@CB' + (blocks.length - 1) + '@@'
  })
  const lines = md.replace(/\r/g, '').split('\n')
  const sep = (s: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s)
  const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  let html = '', i = 0
  while (i < lines.length) {
    const line = lines[i]
    const ph = line.match(/^@@CB(\d+)@@$/)
    if (ph) { html += blocks[+ph[1]]; i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && sep(lines[i + 1])) {
      const h = cells(line); i += 2; const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++ }
      html += '<table><thead><tr>' + h.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
      continue
    }
    const hm = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (hm) { const lv = Math.min(hm[1].length, 4); html += '<h' + lv + '>' + inline(hm[2]) + '</h' + lv + '>'; i++; continue }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {   // 分隔线:模型爱连发一排(尤其收尾段),去重只留一条,别把对话流刷成一叠细线
      if (!html.endsWith('<hr>')) html += '<hr>'
      i++; continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const it: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*[-*+]\s+/, '')
        const todo = renderTodoLine(raw.trim())
        it.push(todo ? todo : '<li>' + sevBadge(inline(raw)) + '</li>')
        i++
      }
      html += it.some(s => s.startsWith('<div class="todo')) ? it.join('') : '<ul>' + it.join('') + '</ul>'
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) { const it: string[] = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { it.push('<li>' + sevBadge(inline(lines[i].replace(/^\s*\d+\.\s+/, ''))) + '</li>'); i++ } html += '<ol>' + it.join('') + '</ol>'; continue }
    if (/^\s*>\s?/.test(line)) { const it: string[] = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { it.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++ } html += '<blockquote>' + it.join('<br>') + '</blockquote>'; continue }
    if (/^\s*$/.test(line)) { i++; continue }
    const para = [line]; i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^@@CB\d+@@$/.test(lines[i])) { para.push(lines[i]); i++ }
    html += '<p>' + para.map(inline).join('<br>') + '</p>'
  }
  return html.replace(/@@CB(\d+)@@/g, function (_m, n) { return blocks[+n] })
}

// ---- TODO 块 ----
const TODO_RE = /^TODO:\s*\[?(高|中|低)\]?\s*(?:\[?来自[：:]\s*([^\]]*)\]?)?\s*(.*)/i
const MAILIDX_RE = /\[mailIdx[：:]\s*(\d+)\s*\]/i
const MSGID_RE = /\[msgId[：:]\s*([^\s\]]+)\s*\]/i
function renderTodoLine(line: string): string | null {
  const m = line.match(TODO_RE); if (!m) return null
  const urgency = m[1] || '中', from = (m[2] || '').trim()
  let text = (m[3] || '').trim()
  let mailIdx = '', mailMsgId = ''
  const mid = text.match(MSGID_RE); if (mid) { mailMsgId = mid[1]; text = text.replace(MSGID_RE, '').trim() }
  const mi = text.match(MAILIDX_RE); if (mi) { mailIdx = mi[1]; text = text.replace(MAILIDX_RE, '').trim() }
  const urgCls = urgency === '高' ? 'sev-must' : urgency === '中' ? 'sev-sugg' : 'sev-info'
  const mailTag = mailMsgId
    ? `<span style="font-size:10.5px;color:var(--blue);margin-right:6px" title="关联邮件 msgId=${esc(mailMsgId)}">✉</span>`
    : mailIdx ? `<span style="font-size:10.5px;color:var(--blue);margin-right:6px" title="关联原邮件 #${esc(mailIdx)}">✉ #${esc(mailIdx)}</span>` : ''
  return `<div class="todo-blk" data-act="todo" data-urgency="${esc(urgency)}" data-from="${esc(from)}" data-text="${esc(text)}"${mailIdx ? ' data-mailidx="' + esc(mailIdx) + '"' : ''}${mailMsgId ? ' data-mailmsgid="' + esc(mailMsgId) + '"' : ''}>`
    + `<span class="sev ${urgCls}">${esc(urgency)}</span>`
    + (from ? `<span style="font-size:11px;color:var(--label-3);margin-right:6px">来自：${esc(from)}</span>` : '')
    + mailTag
    + `<span style="font-size:12.5px">${esc(text)}</span>`
    + `<button class="rbtn-ghost" data-act="todo" style="margin-left:auto;flex:none;font-size:11px">＋ 加入待办</button>`
    + `</div>`
}

// ---- 动作分发 ----
export interface RichHandlers {
  open?: (file: string, line: string) => void
  apply?: (payload: { file: string; raw: string; all?: boolean }, btn: HTMLElement) => void
  run?: (payload: { raw: string }, btn: HTMLElement) => void
  todo?: (payload: { urgency: string; from: string; text: string; mailIdx: string; mailMsgId: string }, btn: HTMLElement) => void
}

function copyFeedback(btn: HTMLElement) {
  const old = btn.innerHTML; btn.textContent = '已复制 ✓'; (btn as HTMLButtonElement).disabled = true
  setTimeout(() => { btn.innerHTML = old; (btn as HTMLButtonElement).disabled = false }, 1500)
}
function blockRaw(blk: Element, type: string): string {
  if (type === 'diff') return Array.from(blk.querySelectorAll('.dl')).map((d) => d.textContent).join('\n')
  const code = blk.querySelector('code'); return code ? (code.textContent || '') : ''
}
export function wireActions(root: HTMLElement, h: RichHandlers): void {
  root.addEventListener('click', (e) => {
    const ext = (e.target as HTMLElement).closest('a.extlink') as HTMLElement | null
    if (ext) { e.preventDefault(); try { window.BocomHermes && window.BocomHermes.openExternalUrl && window.BocomHermes.openExternalUrl(ext.dataset.url) } catch (_) { /* 静默 */ } return }
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null
    if (!btn || (btn as HTMLButtonElement).disabled) return
    const act = btn.dataset.act || ''
    if (act === 'applyall' || act === 'copyall') {
      const set = btn.closest('.rdiffset'); if (!set) return
      const raw = Array.from(set.querySelectorAll('.rblk[data-type="diff"]')).map((f) => blockRaw(f, 'diff')).join('\n')
      if (act === 'copyall') { try { navigator.clipboard.writeText(raw) } catch (_) { /* 静默 */ } copyFeedback(btn) }
      else { h.apply && h.apply({ file: '', raw, all: true }, btn) }
      return
    }
    const blk = btn.closest('.rblk') as HTMLElement | null; if (!blk) return
    const type = blk.dataset.type || ''
    const fileEl = blk.querySelector('.rfile') as HTMLElement | null
    const file = (fileEl && fileEl.dataset.file) || ''
    const line = (fileEl && fileEl.dataset.line) || '1'
    const raw = blockRaw(blk, type)
    if (act === 'copy') { try { navigator.clipboard.writeText(raw) } catch (_) { /* 静默 */ } copyFeedback(btn) }
    else if (act === 'open') { h.open && h.open(file, line) }
    else if (act === 'apply') { h.apply && h.apply({ file, raw }, btn) }
    else if (act === 'run') { h.run && h.run({ raw }, btn) }
    else if (act === 'todo') {
      const tb = btn.closest('.todo-blk') as HTMLElement | null; if (!tb || !h.todo) return
      h.todo({ urgency: tb.dataset.urgency || '', from: tb.dataset.from || '', text: tb.dataset.text || '', mailIdx: tb.dataset.mailidx || '', mailMsgId: tb.dataset.mailmsgid || '' }, btn)
    }
  })
}

/**
 * 长代码块折叠(原 card.html foldLongCode):>24 行的 pre 收成 details(默认折叠)。
 * 只在收尾/静态渲染后跑;流式尾巴区不跑(每帧重渲,折了也白折)。
 */
export function foldLongCode(root: HTMLElement): void {
  try {
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.closest && pre.closest('details.foldcode')) return
      const lines = ((pre.textContent || '').match(/\n/g) || []).length + 1
      if (lines < 24) return
      const d = document.createElement('details'); d.className = 'foldcode'
      const sum = document.createElement('summary'); sum.textContent = '代码 ' + lines + ' 行 —— 点击展开'
      pre.parentNode!.insertBefore(d, pre); d.appendChild(sum); d.appendChild(pre)
    })
  } catch { /* 静默 */ }
}
