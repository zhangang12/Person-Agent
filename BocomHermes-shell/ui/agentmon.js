// 子agent状态监控共享组件（从 ui/card.html 的 .subbox 全套抽出，四窗复用：card / workflow / reqflow / reqplan）。
// 职责：任务分组（<details class="subbox">）+ 组内实时工具行 + 调用计数/耗时/状态流转 + card-stream 绑定器。
// 用法：
//   const mon = AgentMon.create({ host, before })            // host=组容器；before()=插入锚点(返回 null → appendChild)
//   mon.ensure(key, name) / mon.tool(key, name, toolName, status, input, callId) / mon.done(key, status, name) / mon.has(key) / mon.clear()
//   AgentMon.bindStream(monOrGetter, mapKey)                 // mapKey(payload)->{key,name}|null；mon 可传 () => window.__mon(窗口重建后换实例)
// 铁律：绑定器回调里绝不把文本 delta 塞进 DOM —— 非 tool 事件只用于"让组出现"（高频事件，进 DOM 会卡）。
;(function () {
  'use strict'

  // ── 样式（card.html 原 .subbox 原样迁移；变量来自 glass.css，四窗都 link）──
  // --c-think 宿主可能没定义（card.html 之外的主题变量集更瘦）→ 回落 --accent
  const CSS = [
    '.subbox { align-self: stretch; max-width: 96%; margin: 3px 0; border: .5px solid var(--composer-border); border-radius: 10px; background: var(--composer-bg); overflow: hidden; }',
    '.subbox > summary { cursor: pointer; padding: 6px 11px; list-style: none; user-select: none; }',
    '.subbox > summary::-webkit-details-marker { display: none; }',
    '.subbox > summary .ahead { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--c-think, var(--accent)); }',
    '.subbox .aico { flex: none; }',
    '.subbox .subname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.subbox .subhint { margin-left: auto; flex: none; font-weight: 400; color: var(--txt3); font-size: 10.5px; font-family: var(--mono); }',
    '.subbox.done .astat { color: var(--green); } .subbox.err .astat { color: var(--diff-del); }',
    '.subbox .alatest { font-size: 10.5px; font-family: var(--mono); color: var(--txt3); margin-top: 3px; padding-left: 19px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.subbox .alatest.run { color: var(--accent); } .subbox .alatest.e { color: var(--diff-del); }',
    '.subbox[open] .alatest { display: none; }',   // 展开后由下方完整清单接管,隐藏"最新行"避免重复
    '.subbox .subwrap { padding: 3px 10px 8px 14px; }',
    '.subbox .alist { display: flex; flex-direction: column; gap: 1px; max-height: 240px; overflow: auto; }',
    '.subbox .aline { font-size: 11px; font-family: var(--mono); color: var(--txt3); display: flex; gap: 6px; align-items: baseline; line-height: 1.55; }',
    '.subbox .aline.run .aln-t { color: var(--accent); } .subbox .aline.ok .aln-t { color: var(--txt2); } .subbox .aline.e .aln-t { color: var(--diff-del); }',
    '.subbox .aln-ic { color: var(--txt3); flex: none; }',
    '.subbox .aln-t { font-weight: 600; flex: none; }',
    '.subbox .aln-g { color: var(--txt3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  ].join('\n')
  let cssInjected = false
  function injectCss() {
    if (cssInjected) return
    cssInjected = true
    const st = document.createElement('style')
    st.textContent = CSS
    document.head.appendChild(st)
  }

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const fmtElapsed = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's' }
  // 工具入参 → 一行目标摘要(文件/命令/查询…)
  const toolTarget = (input) => {
    if (input == null) return ''
    if (typeof input === 'string') return input.slice(0, 120)
    const v = input.filePath || input.path || input.file || input.pattern || input.command || input.cmd || input.query || input.url || input.description || ''
    return String(v).slice(0, 120)
  }

  // 工厂：一窗一实例。每组 = 🔍 名字 · N 次调用 · 耗时 · 状态；组内实时列工具行（↳ 工具 目标）。
  function create(opts) {
    opts = opts || {}
    const host = opts.host, before = opts.before
    injectCss()
    const groups = new Map()   // key -> { box, list, latest, calls:Map(callId->lineEl), count, t0, done }
    let timer = null
    function tick() {
      let running = false
      for (const a of groups.values()) { if (!a.done) { running = true; const e = a.box.querySelector('.aelapsed'); if (e) e.textContent = fmtElapsed(Date.now() - a.t0) } }
      if (!running && timer) { clearInterval(timer); timer = null }
    }
    function ensure(key, name) {
      let a = groups.get(key)
      if (a) { if (name && name !== '子agent') { const h = a.box.querySelector('.subname'); if (h && h.textContent !== name) h.textContent = name } return a }
      const box = document.createElement('details'); box.className = 'subbox'   // 默认收起:表头 + 最新一条(紧凑视图),点开看全部工具
      box.innerHTML = '<summary><div class="ahead"><span class="aico">🔍</span><span class="subname">' + esc(name || '子agent') + '</span>'
        + '<span class="subhint"><span class="acount">0</span> 次调用 · <span class="aelapsed">0s</span><span class="astat"> · 探索中…</span></span></div>'
        + '<div class="alatest">↳ 准备中…</div></summary>'
        + '<div class="subwrap"><div class="alist"></div></div>'
      a = { box, list: box.querySelector('.alist'), latest: box.querySelector('.alatest'), calls: new Map(), count: 0, t0: Date.now(), done: false }
      groups.set(key, a)
      let anchor = null
      if (before) { try { anchor = before() } catch (e) { anchor = null } }
      if (anchor && anchor.parentNode === host) host.insertBefore(box, anchor); else host.appendChild(box)   // 锚点缺席 → 追加到尾部(对齐 card.html 原行为)
      if (!timer) timer = setInterval(tick, 1000)
      return a
    }
    function tool(key, name, toolName, status, input, callId) {
      const a = ensure(key, name)
      let line = a.calls.get(callId)
      if (!line) {
        line = document.createElement('div'); a.list.appendChild(line); a.calls.set(callId, line)
        a.count++; const c = a.box.querySelector('.acount'); if (c) c.textContent = a.count
      }
      const fin = /complet|success|done|finish|ok/i.test(status), err = /error|fail|deny|reject/i.test(status)
      const cls = err ? ' e' : fin ? ' ok' : ' run'
      const html = '<span class="aln-ic">↳</span><span class="aln-t">' + esc(toolName) + '</span><span class="aln-g">' + esc(toolTarget(input)) + '</span>'
      line.className = 'aline' + cls; line.innerHTML = html
      if (a.latest) { a.latest.className = 'alatest' + cls; a.latest.innerHTML = html }   // 表头下"最新一条"(收起时可见)
      const e = a.box.querySelector('.aelapsed'); if (e) e.textContent = fmtElapsed(Date.now() - a.t0)
      host.scrollTop = host.scrollHeight
    }
    function done(key, status, name) {
      const a = groups.get(key); if (!a || a.done) return
      if (name) { const h = a.box.querySelector('.subname'); if (h) h.textContent = name }
      const err = /error|fail|deny|reject/i.test(status)
      a.done = true
      a.box.classList.toggle('done', !err); a.box.classList.toggle('err', err)
      const st = a.box.querySelector('.astat'); if (st) st.textContent = err ? ' · 出错' : ' · 完成'
      const e = a.box.querySelector('.aelapsed'); if (e) e.textContent = fmtElapsed(Date.now() - a.t0)
      a.box.open = false                                    // 结束自动收起,腾地方给最终成果
    }
    function has(key) { return groups.has(key) }
    function clear() { groups.clear(); if (timer) { clearInterval(timer); timer = null } }
    return { ensure, tool, done, has, clear }
  }

  // card-stream 绑定器（通用化 card.html 的路由）。mapKey(payload) -> {key,name} | null(不归本窗管)。
  // 嵌套子agent由各窗 mapKey 处理：p.sub===true 时 key=顶层key+'/'+p.agentId、name=顶层名+' ▸ '+p.agentName。
  // 注意：会话收尾竞态下最后状态可能停在 running，权威收尾靠各窗编排事件调 mon.done()。
  function bindStream(mon, mapKey) {
    const getMon = (typeof mon === 'function') ? mon : function () { return mon }
    window.BocomHermes.onStream((p) => {
      const m = mapKey(p); if (!m) return
      const inst = getMon(); if (!inst) return
      inst.ensure(m.key, m.name)               // 任何活动(含思考/文本)先让组出现;文本内容绝不进 DOM
      if (p.kind !== 'tool') return
      if (p.text === 'task' && !p.sub) {       // 父会话 task 工具收尾 → 嵌套子组标完成
        const fin = /complet|success|done|finish|error|fail|deny|reject/i.test(p.status || '')
        if (fin && p.taskChild) inst.done(m.key + '/' + p.taskChild, p.status || '', p.taskDesc)
        return
      }
      inst.tool(m.key, m.name, p.text, p.status || '', p.input, p.partID || '_')
    })
  }

  window.AgentMon = { create, bindStream }
})()
