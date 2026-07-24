// 统一卡片拖动 + 边缘缩放：
//  · 抓卡身任意非交互/非滚动处即可拖动窗口（参考需求分析卡）。
//  · <html data-resizable="1"> 的页面额外开八向边缘缩放 —— 无边框透明窗没有原生缩放边框,
//    只能自绘:贴窗缘 6px 内按住即缩(含四角),悬停有手型反馈,下钳各窗自己的 minWidth/minHeight
//    (主进程 set-self-bounds 统一钳;左/上边缘缩放时钳位保持对侧边不动)。
// 用法：任意玻璃卡在 </body> 前 <script src="carddrag.js"></script> 即生效(要缩放在 <html> 加 data-resizable="1")。
//  · 会自动关掉 glass.css 默认的原生 app-region 拖动（JS 拖动与 app-region 不能并存）。
//  · 交互元素 / 作者标注的 .nodrag / 可选文字 / 滚动区 一律不发起拖动或缩放 → 点击、输入、滚动、选择都不受影响。
(function () {
  const H = window.BocomHermes
  if (!H || typeof H.getSelfBounds !== 'function' || typeof H.setSelfBounds !== 'function') return

  // 关掉原生 app-region 拖动，改用本脚本（两者并存会让 OS 抢走鼠标事件）
  try {
    const st = document.createElement('style')
    st.textContent = 'html .glass, html .card { -webkit-app-region: no-drag !important; }'
    document.head.appendChild(st)
  } catch (e) {}

  const SKIP = 'button, input, a, textarea, select, label, [contenteditable], .nodrag, .selectable'
  const EDGE = 6   // 边缘感应宽度(px):贴缘才算,不往里侵内容
  const RESIZABLE = document.documentElement.dataset.resizable === '1'

  // 可滚动容器内不发起拖动/缩放（留给滚动/选择;滚动条贴右缘,这条尤其重要）
  function inScrollable(el) {
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (/(auto|scroll)/.test(s.overflowY + ' ' + s.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return true
    }
    return false
  }

  // 命中窗缘哪几条边:'' = 不在边缘;否则 'l'/'r'/'t'/'b'/'tl'/'tr'/'bl'/'br'(竖向字母在前)
  function edgeAt(e) {
    if (!RESIZABLE) return ''
    let v = '', h = ''
    if (e.clientY <= EDGE) v = 't'
    else if (e.clientY >= window.innerHeight - EDGE) v = 'b'
    if (e.clientX <= EDGE) h = 'l'
    else if (e.clientX >= window.innerWidth - EDGE) h = 'r'
    return v + h
  }
  function cursorFor(d) {
    if (d === 'l' || d === 'r') return 'ew-resize'
    if (d === 't' || d === 'b') return 'ns-resize'
    if (d === 'tl' || d === 'br') return 'nwse-resize'
    if (d === 'tr' || d === 'bl') return 'nesw-resize'
    return ''
  }

  let mode = '', edges = '', b = null, mx = 0, my = 0
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (e.target.closest && e.target.closest(SKIP)) return
    if (inScrollable(e.target)) return
    edges = edgeAt(e)
    mode = edges ? 'resize' : 'drag'
    b = H.getSelfBounds(); if (!b) { mode = ''; edges = ''; return }
    mx = e.screenX; my = e.screenY; e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!mode || !b) {
      // 悬停手型反馈(缩放的"UI 可见性";交互/滚动元素上不抢它们自己的手型)
      if (!RESIZABLE) return
      const skip = (e.target.closest && e.target.closest(SKIP)) || inScrollable(e.target)
      const cur = skip ? '' : cursorFor(edgeAt(e))
      if (document.body.style.cursor !== cur) document.body.style.cursor = cur
      return
    }
    const dx = e.screenX - mx, dy = e.screenY - my
    if (mode === 'drag') { H.setSelfBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }); return }
    let { x, y, width, height } = b
    if (edges.indexOf('l') >= 0) { x = b.x + dx; width = b.width - dx }
    if (edges.indexOf('r') >= 0) width = b.width + dx
    if (edges.indexOf('t') >= 0) { y = b.y + dy; height = b.height - dy }
    if (edges.indexOf('b') >= 0) height = b.height + dy
    H.setSelfBounds({ x, y, width, height, edges })   // edges 给主进程:钳最小尺寸时左/上边缘要连带修位置
  })
  window.addEventListener('mouseup', () => { mode = ''; edges = ''; b = null })
})()
