// 富结果引擎（独立模块，挂到 window.Rich）
// 职责：Markdown 渲染 + 围栏块识别（diff / 命令 / 代码）+ 动作条 + 动作分发。
// 以后加新块类型 / 新动作，只改这个文件，不动 card.html 的会话逻辑。
// 铁律：本模块只识别/渲染/读取 DOM；真正"应用/运行"由 card.html 经 opencode + 权限执行。
(function () {
  'use strict'
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const FLOC = /([\w./\\-]+\.[A-Za-z]\w*):(\d+)/g
  const linkify = (s) => s.replace(FLOC, (m, f, l) => '<a class="floc" data-file="' + f + '" data-line="' + l + '">' + m + '</a>')
  const inline = (s) => linkify(esc(s))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

  // findings 严重度徽标：列表项以 必改/建议/可忽略 等开头时，染成彩色标签
  const SEV = { '必改': 'must', '严重': 'must', '高危': 'must', '致命': 'must', '建议': 'sugg', '警告': 'sugg', '注意': 'sugg', '可忽略': 'info', '提示': 'info', 'nit': 'info' }
  const sevBadge = (s) => s.replace(/^\s*\[?\s*(必改|严重|高危|致命|建议|警告|注意|可忽略|提示|nit)\s*\]?\s*[:：\-]?\s*/i, function (m, w) {
    const c = SEV[w] || SEV[w.toLowerCase()]; return c ? '<span class="sev sev-' + c + '">' + w + '</span>' : m
  })

  const SHELL = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat'])
  const isDiff = (lang, code) => lang === 'diff' || lang === 'patch'
    || /^(diff --git |@@ )/m.test(code) || (/^[+-]/m.test(code) && /^@@/m.test(code))

  // ---- 块渲染：每个块带 data-type + 动作条；raw 可从 DOM 还原（无需全局 store）----
  function actBtn(act, label, primary) {
    return '<button class="' + (primary ? 'rbtn-primary' : 'rbtn-ghost') + '" data-act="' + act + '">' + label + '</button>'
  }
  function head(typeLabel, fileAttr, acts) {
    return '<div class="rbhd"><span class="rfile mono"' + fileAttr + '>' + esc(typeLabel) + '</span><span class="racts">' + acts + '</span></div>'
  }
  function diffMeta(code) {
    const m = code.match(/^\+\+\+\s+b\/(.+)$/m) || code.match(/^\+\+\+\s+(.+)$/m)
      || code.match(/^diff --git a\/\S+ b\/(.+)$/m) || code.match(/^---\s+a\/(.+)$/m)
    const lm = code.match(/@@\s*-\d+(?:,\d+)?\s*\+(\d+)/)
    return { file: m ? m[1].trim() : '', line: lm ? lm[1] : '1' }
  }
  function diffLineClass(l) {
    if (/^@@/.test(l)) return 'dl-hunk'
    if (/^(\+\+\+|---|diff |index )/.test(l)) return 'dl-meta'
    if (/^\+/.test(l)) return 'dl-add'
    if (/^-/.test(l)) return 'dl-del'
    return ''
  }
  // 把统一 diff 按文件切片：优先 'diff --git' 边界，退化为成对的 '--- /+++' 文件头。
  function splitDiffFiles(code) {
    const lines = code.split('\n')
    let bounds = []
    lines.forEach((l, i) => { if (/^diff --git /.test(l)) bounds.push(i) })
    if (bounds.length < 2) {
      const idx = []
      for (let i = 0; i < lines.length - 1; i++) if (/^--- /.test(lines[i]) && /^\+\+\+ /.test(lines[i + 1])) idx.push(i)
      if (idx.length >= 2) bounds = idx
    }
    if (bounds.length < 2) return [code]
    const chunks = []
    for (let k = 0; k < bounds.length; k++) {
      const end = k + 1 < bounds.length ? bounds[k + 1] : lines.length
      chunks.push(lines.slice(bounds[k], end).join('\n').replace(/\n+$/, ''))
    }
    if (bounds[0] > 0) chunks[0] = lines.slice(0, bounds[0]).join('\n') + '\n' + chunks[0]  // 前导并入首段
    return chunks
  }
  function renderOneDiff(code) {
    const { file, line } = diffMeta(code)
    const fileAttr = file ? ' data-file="' + esc(file) + '" data-line="' + line + '"' : ''
    const acts = actBtn('apply', '应用', true) + actBtn('copy', '复制') + (file ? actBtn('open', '打开') : '')
    const body = code.split('\n').map((l) => '<div class="dl ' + diffLineClass(l) + '" style="min-height:15px">' + esc(l) + '</div>').join('')
    return '<div class="rblk" data-type="diff">' + head(file || 'diff', fileAttr, acts) + '<div class="rbody rdiff">' + body + '</div></div>'
  }
  function renderDiff(code) {
    const files = splitDiffFiles(code)
    if (files.length <= 1) return renderOneDiff(code)
    const bar = '<div class="rsetbar"><span class="rsetlabel mono">' + files.length + ' 个文件</span><span class="racts">'
      + actBtn('applyall', '全部应用', true) + actBtn('copyall', '复制全部') + '</span></div>'
    return '<div class="rdiffset">' + bar + files.map(renderOneDiff).join('') + '</div>'
  }
  function renderCmd(code, lang) {
    const acts = actBtn('run', '运行', true) + actBtn('copy', '复制')
    return '<div class="rblk" data-type="cmd">' + head(lang || 'bash', '', acts) + '<pre class="rbody"><code>' + esc(code) + '</code></pre></div>'
  }
  function renderCode(code, lang) {
    const acts = actBtn('copy', '复制')
    return '<div class="rblk" data-type="code">' + head(lang || 'code', '', acts) + '<pre class="rbody"><code>' + esc(code) + '</code></pre></div>'
  }
  function renderBlock(lang, code) {
    if (isDiff(lang, code)) return renderDiff(code)
    if (SHELL.has(lang)) return renderCmd(code, lang)
    return renderCode(code, lang)
  }

  // ---- Markdown（逐行解析，围栏块走 renderBlock）----
  function renderMarkdown(md) {
    if (!md) return ''
    const blocks = []
    md = md.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, function (m, lang, code) {
      blocks.push(renderBlock((lang || '').toLowerCase(), code.replace(/\n$/, '')))
      return '@@CB' + (blocks.length - 1) + '@@'
    })
    const lines = md.replace(/\r/g, '').split('\n')
    const sep = (s) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s)
    const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    let html = '', i = 0
    while (i < lines.length) {
      const line = lines[i]
      const ph = line.match(/^@@CB(\d+)@@$/)
      if (ph) { html += blocks[+ph[1]]; i++; continue }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && sep(lines[i + 1])) {
        const h = cells(line); i += 2; const rows = []
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++ }
        html += '<table><thead><tr>' + h.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
        continue
      }
      const hm = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
      if (hm) { const lv = Math.min(hm[1].length, 4); html += '<h' + lv + '>' + inline(hm[2]) + '</h' + lv + '>'; i++; continue }
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { html += '<hr>'; i++; continue }
      if (/^\s*[-*+]\s+/.test(line)) {
        const it = []
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          const raw = lines[i].replace(/^\s*[-*+]\s+/, '')
          const todo = renderTodoLine(raw.trim())
          it.push(todo ? todo : '<li>' + sevBadge(inline(raw)) + '</li>')
          i++
        }
        html += it.some(s => s.startsWith('<div class="todo')) ? it.join('') : '<ul>' + it.join('') + '</ul>'
        continue
      }
      if (/^\s*\d+\.\s+/.test(line)) { const it = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { it.push('<li>' + sevBadge(inline(lines[i].replace(/^\s*\d+\.\s+/, ''))) + '</li>'); i++ } html += '<ol>' + it.join('') + '</ol>'; continue }
      if (/^\s*>\s?/.test(line)) { const it = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { it.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++ } html += '<blockquote>' + it.join('<br>') + '</blockquote>'; continue }
      if (/^\s*$/.test(line)) { i++; continue }
      const para = [line]; i++
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^@@CB\d+@@$/.test(lines[i])) { para.push(lines[i]); i++ }
      html += '<p>' + para.map(inline).join('<br>') + '</p>'
    }
    return html.replace(/@@CB(\d+)@@/g, function (m, n) { return blocks[+n] })
  }

  // ---- TODO 块：识别 "TODO: [高/中/低] [来自：xxx] 事项 [msgId:xxx]" 并渲染为可操作卡 ----
  // msgId 是邮件的 Message-ID,跨会话稳定(从 mail_list 输出抠);mailIdx 是老格式,本会话序号(兼容保留)
  const TODO_RE = /^TODO:\s*\[?(高|中|低)\]?\s*(?:\[?来自[：:]\s*([^\]]*)\]?)?\s*(.*)/i
  const MAILIDX_RE = /\[mailIdx[：:]\s*(\d+)\s*\]/i
  const MSGID_RE   = /\[msgId[：:]\s*([^\s\]]+)\s*\]/i
  function renderTodoLine(line) {
    const m = line.match(TODO_RE); if (!m) return null
    const urgency = m[1] || '中', from = (m[2] || '').trim()
    let text = (m[3] || '').trim()
    let mailIdx = '', mailMsgId = ''
    const mid = text.match(MSGID_RE);   if (mid) { mailMsgId = mid[1]; text = text.replace(MSGID_RE, '').trim() }
    const mi  = text.match(MAILIDX_RE); if (mi)  { mailIdx   = mi[1];  text = text.replace(MAILIDX_RE, '').trim() }
    const urgCls = urgency === '高' ? 'sev-must' : urgency === '中' ? 'sev-sugg' : 'sev-info'
    // 优先 msgId(跨会话稳定);只有 mailIdx 时显示原标签
    const mailTag = mailMsgId
      ? `<span style="font-size:10.5px;color:var(--accent);margin-right:6px" title="关联邮件 msgId=${esc(mailMsgId)}">📧</span>`
      : mailIdx ? `<span style="font-size:10.5px;color:var(--accent);margin-right:6px" title="关联原邮件 #${esc(mailIdx)}">📧#${esc(mailIdx)}</span>` : ''
    return `<div class="todo-blk" data-act="todo" data-urgency="${esc(urgency)}" data-from="${esc(from)}" data-text="${esc(text)}"${mailIdx ? ' data-mailidx="' + esc(mailIdx) + '"' : ''}${mailMsgId ? ' data-mailmsgid="' + esc(mailMsgId) + '"' : ''}>`
      + `<span class="sev ${urgCls}">${esc(urgency)}</span>`
      + (from ? `<span style="font-size:11px;color:var(--txt3);margin-right:6px">来自：${esc(from)}</span>` : '')
      + mailTag
      + `<span style="font-size:12.5px">${esc(text)}</span>`
      + `<button class="rbtn-ghost" data-act="todo" style="margin-left:auto;flex:none;font-size:11px">＋ 加入待办</button>`
      + `</div>`
  }

  // ---- 动作分发：事件委托在 root；raw 从 DOM 还原；执行交给 card 提供的 handlers ----
  function copyFeedback(btn) {
    const old = btn.innerHTML; btn.textContent = '已复制 ✓'; btn.disabled = true
    setTimeout(() => { btn.innerHTML = old; btn.disabled = false }, 1500)
  }
  function blockRaw(blk, type) {
    if (type === 'diff') return Array.from(blk.querySelectorAll('.dl')).map((d) => d.textContent).join('\n')
    const code = blk.querySelector('code'); return code ? code.textContent : ''
  }
  function wireActions(root, h) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]'); if (!btn || btn.disabled) return
      const act = btn.dataset.act
      // 多文件 diff 的整组动作（按钮在 .rsetbar 里，不在某个 .rblk 内）
      if (act === 'applyall' || act === 'copyall') {
        const set = btn.closest('.rdiffset'); if (!set) return
        const raw = Array.from(set.querySelectorAll('.rblk[data-type="diff"]')).map((f) => blockRaw(f, 'diff')).join('\n')
        if (act === 'copyall') { try { navigator.clipboard.writeText(raw) } catch (_) {} copyFeedback(btn) }
        else { h.apply && h.apply({ file: '', raw, all: true }, btn) }
        return
      }
      const blk = btn.closest('.rblk'); if (!blk) return
      const type = blk.dataset.type
      const fileEl = blk.querySelector('.rfile')
      const file = (fileEl && fileEl.dataset.file) || ''
      const line = (fileEl && fileEl.dataset.line) || '1'
      const raw = blockRaw(blk, type)
      if (act === 'copy') { try { navigator.clipboard.writeText(raw) } catch (_) {} copyFeedback(btn) }
      else if (act === 'open') { h.open && h.open(file, line) }
      else if (act === 'apply') { h.apply && h.apply({ file, raw }, btn) }
      else if (act === 'run') { h.run && h.run({ raw }, btn) }
      else if (act === 'todo') {
        const blk = btn.closest('.todo-blk'); if (!blk || !h.todo) return
        h.todo({ urgency: blk.dataset.urgency, from: blk.dataset.from, text: blk.dataset.text, mailIdx: blk.dataset.mailidx || '', mailMsgId: blk.dataset.mailmsgid || '' }, btn)
      }
    })
  }

  window.Rich = { renderMarkdown, wireActions }
})()
