// ── 邮件 HTML 渲染共享模块(mailview.html / mailcenter.html 共用)──────────────
// 职责:构建沙箱 iframe 的 srcdoc(Foxmail 式完整还原:表格/内联样式/图片)
//      + 装配链接拦截(转系统浏览器)与高度自适应。
// 安全红线:配套 iframe 必须是 sandbox="allow-same-origin"(不加 allow-scripts)。
//   same-origin + scripts = 邮件内容可直达父页与 preload 桥(等于远程代码注入),
//   绝不可同时开;srcdoc 内 CSP script-src 'none' 是第二道保险。
(function () {
  'use strict'

  function buildSrcdoc(html, opts) {
    const remote = !!(opts && opts.remote)
    // 远程图默认拦截(防追踪);cid 图已在主进程替换成 data:,故 img-src 不再需要 cid:
    const img = remote ? "img-src data: https: http:;" : "img-src data:;"
    const csp = "default-src 'none'; script-src 'none'; form-action 'none'; " + img +
                " style-src 'unsafe-inline'; font-src data:; media-src data:;"
    return '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
      + '<style>'
      +   'html,body{margin:0;-webkit-user-select:text;user-select:text;cursor:auto}'
      +   'body{padding:14px 16px;font-family:Calibri,Arial,"Microsoft YaHei",sans-serif;font-size:14px;color:#1a1a1a;background:#fff;word-wrap:break-word;overflow-wrap:break-word}'
      +   'img{max-width:100%;height:auto}'   /* 注意:不要写 table{max-width:100%} —— 会压坏 Outlook 固定宽表格;超宽表格让 iframe 横向滚(Foxmail 同款行为) */
      +   'blockquote{margin:.4em 0 .4em .8ex;border-left:2px #1a73e8 solid;padding-left:1ex}a{color:#1a73e8}'
      + '</style></head><body>' + (html || '') + '</body></html>'
  }

  function hasRemoteImg(html) { return /<img[^>]+src\s*=\s*["']?https?:/i.test(html || '') }

  // 必须在设置 srcdoc 之前调用;每次 srcdoc 重设都会再触发 load
  function wire(f, opts) {
    const onHeight = opts && opts.onHeight
    f.addEventListener('load', () => {
      const doc = f.contentDocument; if (!doc) return
      // 链接拦截:沙箱内导航本来就被禁,这里 preventDefault 后转外部浏览器打开
      doc.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[href]')
        if (!a) return
        e.preventDefault(); e.stopPropagation()
        const href = String(a.getAttribute('href') || '')
        if (/^(https?:|mailto:)/i.test(href)) window.BocomHermes.openExternalUrl(href)
      }, true)
      if (onHeight) {   // 高度自适应(mailcenter 内嵌用;mailview 全高不传)
        const measure = () => onHeight(Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0))
        measure()
        for (const img of doc.images) { img.addEventListener('load', measure); img.addEventListener('error', measure) }
        try { new ResizeObserver(measure).observe(doc.documentElement) } catch {}
        setTimeout(measure, 300)   // 字体/布局迟到兜底
      }
    })
  }

  window.MailFrame = { buildSrcdoc, wire, hasRemoteImg }
})()
