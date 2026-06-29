// 统一卡片拖动（参考需求分析卡）：抓卡身任意非交互/非滚动处即可拖动窗口；锁定尺寸，绝不缩放。
// 用法：任意玻璃卡在 </body> 前 <script src="carddrag.js"></script> 即生效。
//  · 会自动关掉 glass.css 默认的原生 app-region 拖动（JS 拖动与 app-region 不能并存）。
//  · 交互元素 / 作者标注的 .nodrag / 可选文字 / 滚动区 一律不发起拖动 → 点击、输入、滚动、选择都不受影响。
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
  // 可滚动容器内不发起拖动（留给滚动/选择）
  function inScrollable(el) {
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (/(auto|scroll)/.test(s.overflowY + ' ' + s.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return true
    }
    return false
  }

  let drag = false, b = null, mx = 0, my = 0
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (e.target.closest && e.target.closest(SKIP)) return
    if (inScrollable(e.target)) return
    b = H.getSelfBounds(); if (!b) return
    drag = true; mx = e.screenX; my = e.screenY; e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!drag || !b) return
    H.setSelfBounds({ x: b.x + (e.screenX - mx), y: b.y + (e.screenY - my), width: b.width, height: b.height })
  })
  window.addEventListener('mouseup', () => { drag = false; b = null })
})()
