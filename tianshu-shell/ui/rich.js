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
  function renderDiff(code) {
    const { file, line } = diffMeta(code)
    const fileAttr = file ? ' data-file="' + esc(file) + '" data-line="' + line + '"' : ''
    const acts = actBtn('apply', '应用', true) + actBtn('copy', '复制') + (file ? actBtn('open', '打开') : '')
    const body = code.split('\n').map((l) => '<div class="dl ' + diffLineClass(l) + '" style="min-height:15px">' + esc(l) + '</div>').join('')
    return '<div class="rblk" data-type="diff">' + head(file || 'diff', fileAttr, acts) + '<div class="rbody rdiff">' + body + '</div></div>'
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
      if (/^\s*[-*+]\s+/.test(line)) { const it = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { it.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++ } html += '<ul>' + it.join('') + '</ul>'; continue }
      if (/^\s*\d+\.\s+/.test(line)) { const it = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { it.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++ } html += '<ol>' + it.join('') + '</ol>'; continue }
      if (/^\s*$/.test(line)) { i++; continue }
      const para = [line]; i++
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i]) && !/^@@CB\d+@@$/.test(lines[i])) { para.push(lines[i]); i++ }
      html += '<p>' + para.map(inline).join('<br>') + '</p>'
    }
    return html.replace(/@@CB(\d+)@@/g, function (m, n) { return blocks[+n] })
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
      const blk = btn.closest('.rblk'); if (!blk) return
      const type = blk.dataset.type, act = btn.dataset.act
      const fileEl = blk.querySelector('.rfile')
      const file = (fileEl && fileEl.dataset.file) || ''
      const line = (fileEl && fileEl.dataset.line) || '1'
      const raw = blockRaw(blk, type)
      if (act === 'copy') { try { navigator.clipboard.writeText(raw) } catch (_) {} copyFeedback(btn) }
      else if (act === 'open') { h.open && h.open(file, line) }
      else if (act === 'apply') { h.apply && h.apply({ file, raw }, btn) }
      else if (act === 'run') { h.run && h.run({ raw }, btn) }
    })
  }

  window.Rich = { renderMarkdown, wireActions }
})()
