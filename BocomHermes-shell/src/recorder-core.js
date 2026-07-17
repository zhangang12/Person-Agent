'use strict'
// 从 window.js 抽出的纯逻辑函数/常量(录制/回放/报告),无 window.js 闭包依赖,原样搬入。

  // 注入到页面里的录制监听:click/input/key/scroll/submit/navigate 全打到 console("__BR__"+JSON),
  // 主进程的 pushConsole 截留这条 message 入 rec.events,不进用户控制台。
  // 选择器优先 id > data-test/testid > name/aria-label > 短 nth-of-type 路径,尽量稳定。
  const RECORDER_JS = `
;(function(){
  if (window.__bocom_rec_init) return; window.__bocom_rec_init = true;
  // 双通道单发:优先 CDP binding(页面覆写 console.log 也打不死);binding 命中即 return,不会双通道重复入队。
  // 子框架(iframe)里发的事件带 fu=本框架 URL,回放时据此定位到对应 frame(银行老系统业务表单常在 iframe)
  var emit = function(e){
    // 源头守卫:天枢自己的 chrome 页(新标签页搜索框等,body[data-bocom-chrome])上的操作不录 —— 否则用户在地址搜索框敲目标 URL 会漏进录制,回放目标页根本没这框。__ping__ 健康自检走独立 PING_JS,不受影响。
    try { if (document.body && document.body.getAttribute && document.body.getAttribute('data-bocom-chrome')) return; } catch(_){}
    try { if (window.top !== window && !e.fu) e.fu = location.href; } catch(_){ } var s = '__BR__' + JSON.stringify(e); try { if (typeof window.__bocom_rec_emit === 'function') return window.__bocom_rec_emit(s); } catch(_){} try { console.log(s); } catch(_){} };
  // 动态 id(框架每次渲染都变,回放必失配)不作选择器候选:Element UI/Plus 的 el-id-<数字>、
  // React useId(:r../«r..»)、含 6+ 连续数字或纯 hex 的随机 id。
  var isDynId = function(id){
    id = String(id||'');
    return /^el-id-\\d/.test(id) || /^:r[0-9a-z]+:?$/i.test(id) || /^[«][^»]*[»]$/.test(id) || /\\d{6,}/.test(id) || /^[0-9a-f]{8,}$/i.test(id);
  };
  // 瞬态状态类(聚焦/激活/选中/悬停/展开…):录制时元素处于某态才有,回放状态不同 → 带进选择器会失配,建路径时剔除,只留结构/语义类。
  var TRANSIENT_CLS = /^(?:is-|has-)|(?:^|[-_])(?:focus|active|hover|selected|checked|current|expanded|open|show|visible|highlight|disabled|loading|dragging)(?:[-_]|$)/i;
  // 记多个选择器候选:回放时按优先级 fallback,DOM 结构小幅变动也能命中
  var selBuild = function(el){
    if (!el || el === document || el === document.body) return ['body'];
    var cands = [];
    if (el.id && !isDynId(el.id)) cands.push('#' + CSS.escape(el.id));
    var attrs = ['data-test','data-testid','data-cy','data-qa','name','aria-label'];
    for (var i=0;i<attrs.length;i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (!v) continue;
      // radio/checkbox 的 name 对整组恒命中第一个 → 拼上 value(常带业务主键)才定位得准
      if (attrs[i] === 'name' && el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        cands.push('input[name="' + v.replace(/"/g,'\\\\"') + '"][value="' + String(el.value||'').replace(/"/g,'\\\\"') + '"]');
        continue;
      }
      cands.push(el.tagName.toLowerCase() + '[' + attrs[i] + '="' + v.replace(/"/g,'\\\\"') + '"]');
    }
    // role + accessible name
    var role = el.getAttribute && el.getAttribute('role');
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (role && aria) cands.push('[role="'+role+'"][aria-label="'+aria.replace(/"/g,'\\\\"')+'"]');
    // 文本选择器(短可见文本):标签 + 内含文本。
    // 表单控件不取用户输入值(密码/客户号会泄进 selAlt 持久化);按钮型 INPUT 的 value 是标签文字,保留
    var txt = '';
    if (el.tagName === 'INPUT') { txt = (el.type === 'button' || el.type === 'submit' || el.type === 'reset') ? (el.value || '') : ''; }
    else if (el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') { txt = el.innerText || ''; }
    txt = String(txt).trim();
    if (txt && txt.length <= 30 && !txt.includes('\\n')) {
      cands.push('__text__:' + el.tagName.toLowerCase() + '|' + txt.replace(/"/g,'').slice(0,30));
    }
    // nth-of-type 路径作最后兜底
    var parts = []; var n = el;
    for (var d=0; d<5 && n && n.tagName && n !== document.body; d++) {
      var s = n.tagName.toLowerCase();
      if (typeof n.className === 'string' && n.className.trim()) {
        var cls = n.className.trim().split(/\\s+/).filter(function(c){return c && !TRANSIENT_CLS.test(c)}).slice(0,2).map(function(c){return '.'+CSS.escape(c)}).join('');
        if (cls) s += cls;
      }
      var par = n.parentNode;
      if (par && par.children) {
        var same = Array.prototype.filter.call(par.children, function(x){ return x.tagName === n.tagName; });
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n)+1) + ')';
      }
      parts.unshift(s); n = n.parentNode;
    }
    cands.push(parts.join(' > '));
    return cands;
  };
  window.bocomSel = function(el){ return selBuild(el)[0]; };
  var isCheckable = function(el){ return !!(el && el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')); };
  // 采字段上下文(placeholder / label 文本 / autocomplete / inputmode)—— 供"人机断点"识别(验证码/动态令牌等)。
  // autocomplete="one-time-code" 是 OTP 的 W3C 标准标记,最强信号;label 优先 el.labels,退 closest('label'),退 aria-label。
  var fieldCtx = function(el){
    var o = {};
    try {
      if (el.placeholder) o.ph = String(el.placeholder).slice(0,60);
      var ac = el.getAttribute && el.getAttribute('autocomplete'); if (ac) o.ac = String(ac).slice(0,40);
      var im = el.getAttribute && el.getAttribute('inputmode'); if (im) o.im = String(im).slice(0,20);
      var lb = '';
      if (el.labels && el.labels.length) lb = el.labels[0].innerText || el.labels[0].textContent || '';
      if (!lb && el.closest) { var L = el.closest('label'); if (L) lb = L.innerText || ''; }
      if (!lb && el.getAttribute) lb = el.getAttribute('aria-label') || '';
      if (lb) o.lb = String(lb).replace(/\\s+/g,' ').trim().slice(0,40);
    } catch(_){}
    return o;
  };
  // 输入防抖:per-element pend+flush —— 换元素/点按钮/回车/提交时先把上一个输入吐出去。
  // 修两个次序 bug:快速切换输入框丢前一个事件;敲完字 250ms 内提交 → input 排到 click/submit 之后,回放先提交空表单
  var inputTmr = null, inputPend = null;
  var flushInput = function(ret){
    if (!inputPend) return null;
    clearTimeout(inputTmr);
    var el = inputPend; inputPend = null;
    var v = el.isContentEditable ? (el.innerText||'') : (el.value||'');
    var c = selBuild(el);
    var ev = { act:'input', sel:c[0], selAlt:c.slice(1), value:String(v).slice(0,200) };
    var fc = fieldCtx(el); for (var fk in fc) ev[fk] = fc[fk];   // ph/lb/ac/im:供停录后启发式识别"人机断点"
    if (el.tagName === 'INPUT' && el.type === 'password') { ev.secret = true; ev.value = ''; }   // 密码不存明文(安全键盘控件本就录不到,这里只管普通 password 框)
    if (ret) return JSON.stringify(ev);
    emit(ev); return null;
  };
  window.__bocom_rec_flush = flushInput;
  document.addEventListener('click', function(e){
    if (!window.__bocom_rec_on) return;
    var el = e.target;
    flushInput();
    // select/checkbox/radio(含点 label 联动)由 change 监听录 act:'select'/'check',这里跳过防双发
    if (el.tagName === 'SELECT' || el.tagName === 'OPTION' || isCheckable(el)) return;
    var lb = el.closest && el.closest('label');
    if (lb && isCheckable(lb.control)) return;
    var t = '';
    if (el.tagName === 'INPUT') { t = (el.type === 'button' || el.type === 'submit' || el.type === 'reset') ? (el.value || '') : ''; }
    else if (el.tagName !== 'TEXTAREA') { t = el.innerText || ''; }
    var c = selBuild(el);
    var evc = { act:'click', sel:c[0], selAlt:c.slice(1), text:String(t).slice(0,40) };
    // 日历/日期弹层里的格子点击:选择器只能落到 nth-of-type,换月换天必失效 → 标 transient,
    // 回放时这类步失败不计入级联早停(日期终值由下面 change 补录的 input 步直接写)
    if (el.closest && el.closest('.layui-laydate,.el-picker-panel,.el-date-picker,.el-picker__popper,.ant-picker-dropdown,.ant-calendar')) evc.transient = true;
    emit(evc);
  }, true);
  document.addEventListener('input', function(e){
    if (!window.__bocom_rec_on) return;
    var el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) return;
    if (isCheckable(el)) return;   // 勾选由 change 录 act:'check',不产 value:'on' 垃圾步
    if (inputPend && inputPend !== el) flushInput();
    inputPend = el;
    clearTimeout(inputTmr);
    inputTmr = setTimeout(function(){ flushInput(); }, 250);   // 防抖,合并连续敲字
  }, true);
  document.addEventListener('keydown', function(e){
    if (!window.__bocom_rec_on) return;
    if (e.isComposing || e.keyCode === 229) return;   // IME 组合态:拼音上屏的 Enter 不是提交
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
      flushInput();
      var c = selBuild(e.target); emit({ act:'key', sel:c[0], selAlt:c.slice(1), key:e.key });
    }
  }, true);
  document.addEventListener('submit', function(e){
    if (!window.__bocom_rec_on) return;
    flushInput();
    var c = selBuild(e.target); emit({ act:'submit', sel:c[0], selAlt:c.slice(1) });
  }, true);
  // select 下拉与 checkbox/radio:change 时点才是「选定」语义(click 已跳过防双发)
  document.addEventListener('change', function(e){
    if (!window.__bocom_rec_on) return;
    var el = e.target; if (!el || !el.tagName) return;
    if (el.tagName === 'SELECT') {
      flushInput();
      var c = selBuild(el);
      var t = (el.selectedIndex >= 0 && el.options[el.selectedIndex]) ? (el.options[el.selectedIndex].text||'').trim().slice(0,60) : '';
      emit({ act:'select', sel:c[0], selAlt:c.slice(1), value:String(el.value == null ? '' : el.value).slice(0,200), text:t });   // text=跨环境字典码不同时的回退键
      return;
    }
    // 日期/日历:选定后组件程序化写 input.value,多数在终值敲定时 fire 一次 change → 补录 act:'input' 存终值,
    // 回放据此用原生 setter 直接写值,绕开脆弱的点格子路径。终值步走 selBuild 的 id/name 稳定选择器
    if (el.tagName === 'INPUT' && !isCheckable(el) && el.type !== 'file' && (el.readOnly || (el.closest && el.closest('.el-date-editor,.el-range-editor,.ant-picker,.ant-calendar-picker,.layui-input-inline')))) {
      flushInput();
      var cD = selBuild(el);
      var dv = String(el.value || '').slice(0,200);
      if (dv) emit({ act:'input', sel:cD[0], selAlt:cD.slice(1), value:dv });
      return;
    }
    if (isCheckable(el)) {
      flushInput();
      var c2 = selBuild(el);
      emit({ act:'check', sel:c2[0], selAlt:c2.slice(1), checked: !!el.checked, value:String(el.value||'').slice(0,80) });
    }
  }, true);
  // SPA 路由变化:hook history.pushState/replaceState + popstate(Vue/React 用 history mode 必走这条)
  function urlNow(){ return location.pathname + location.search + location.hash; }
  var lastUrl = urlNow();
  var emitNavIfChanged = function(){
    var u = urlNow();
    if (u !== lastUrl) { lastUrl = u; flushInput(); emit({ act:'navigate', url: location.href, spa: true }); }
  };
  var _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function(){ var r = _ps.apply(this, arguments); try { window.__bocom_rec_on && emitNavIfChanged(); } catch(_){} return r; };
  history.replaceState = function(){ var r = _rs.apply(this, arguments); try { window.__bocom_rec_on && emitNavIfChanged(); } catch(_){} return r; };
  window.addEventListener('popstate', function(){ if (window.__bocom_rec_on) emitNavIfChanged(); });
  window.addEventListener('hashchange', function(){ if (window.__bocom_rec_on) emitNavIfChanged(); });
  var scrollTmr = null;
  document.addEventListener('scroll', function(){
    if (!window.__bocom_rec_on) return;
    clearTimeout(scrollTmr);
    scrollTmr = setTimeout(function(){
      emit({ act:'scroll', x:Math.round(window.scrollX), y:Math.round(window.scrollY) });
    }, 250);
  }, { capture:true, passive:true });
})();`

  // 把"普通 CSS 选择器"或伪选择器(__text__:tag|text / __label__:文本)转成页面里能跑的"找元素"表达式
  function selExpr(sel) {
    const s = String(sel || '')
    if (s.startsWith('__text__:')) {
      const idx = s.indexOf('|'); const tag = s.slice(9, idx).toLowerCase()
      const txt = s.slice(idx + 1)
      return `(function(){var els=document.querySelectorAll(${JSON.stringify(tag)});for(var i=0;i<els.length;i++){var t=(els[i].innerText||els[i].value||'').trim();if(t===${JSON.stringify(txt)}||t.indexOf(${JSON.stringify(txt)})===0)return els[i]}return null})()`
    }
    // __label__:文本 —— 找文本匹配的 <label> 的关联控件(label.control / for→#id / 内含 input)。自愈重定位输入框用。
    if (s.startsWith('__label__:')) {
      const t = s.slice(10)
      return `(function(){var ls=document.querySelectorAll('label');for(var i=0;i<ls.length;i++){var tx=(ls[i].innerText||ls[i].textContent||'').trim();if(tx===${JSON.stringify(t)}||tx.indexOf(${JSON.stringify(t)})===0){var c=ls[i].control||(ls[i].htmlFor&&document.getElementById(ls[i].htmlFor))||ls[i].querySelector('input,textarea,select');if(c)return c}}return null})()`
    }
    return `document.querySelector(${JSON.stringify(s)})`
  }

  // ── Phase 6a·确定性自愈:选择器全失配时,靠录制的语义锚点(placeholder/label/文本)在当前页重定位 ──
  // 返回一组【稳定选择器】候选(selExpr 直接能跑);回放兜底逐个试,命中即用并回写技能(自愈=自更新)。
  // 不依赖网关:动态 id / 瞬态类 / 小改版 导致原选择器失效时,语义锚点通常还在。
  function relocateSelectors(ev) {
    if (!ev) return []
    const out = []
    const esc = (s) => String(s).replace(/"/g, '\\"')
    if (ev.act === 'input' || ev.act === 'select') {
      if (ev.ph) { out.push('input[placeholder="' + esc(ev.ph) + '"]', 'textarea[placeholder="' + esc(ev.ph) + '"]') }
      if (ev.lb) out.push('__label__:' + String(ev.lb).trim())
      if (ev.ac === 'one-time-code') out.push('input[autocomplete="one-time-code"]')
    }
    if ((ev.act === 'click' || ev.act === 'submit' || ev.act === 'check') && ev.text) {
      const t = String(ev.text).trim()
      if (t && t.length <= 40 && !String(ev.sel || '').startsWith('__text__:')) {   // 原 sel 已是 __text__ 还失配,再拼同样的没意义
        out.push('__text__:button|' + t, '__text__:a|' + t)
      }
    }
    return out
  }

  // 把 sel + selAlt 串成"按优先级 fallback,谁先找到用谁"的表达式;变量名 __el 给后续操作用
  function findElExpr(sel, alt) {
    const cands = [sel, ...(alt || [])].filter(Boolean)
    const tryList = cands.map((c) => `(__el=${selExpr(c)})`).join(' || ')
    return tryList || 'null'
  }

  // 探锚点专用的【严格】找元素表达式 —— 不能复用 findElExpr。
  // 两件事的举证责任完全不同:【执行】一步时用宽松候选链使劲找元素是合理的(你正要操作它,找不到就算失败);
  // 【探锚点】却是在断言"中间这一整段已被页面状态满足、可以整段跳过",强得多的主张,证据必须够specific。
  // 而 selAlt 的尾部候选恰恰最弱:__text__ 是【前缀】匹配 —— 「__text__:button|确定」能命中当前页任何以"确定"
  // 开头的按钮(弹窗 OK 键、别的区块的确认键);nth-of-type 兜底路径换个区块也能撞上。拿这种证据把中间 6 步
  // (填金额、选账户…)全标成 ok:true → fails=0 → 报 PASS → 还触发下载后编排。银行流程里"跳步且报成功"是最坏结果。
  // 故:只认主选择器(录制时选出的最强候选),且伪选择器要求文本【全等】不许前缀。
  // 代价是有些本该跳的段不跳了 → 那步照常失败 → 走自愈/Agent 接管(既有的降级路,安全);比静默跳过好得多。
  function anchorExpr(ev) {
    const s = String((ev && ev.sel) || '')
    if (!s) return 'null'
    if (s.startsWith('__text__:')) {
      const idx = s.indexOf('|'); if (idx < 0) return 'null'
      const tag = s.slice(9, idx).toLowerCase(); const txt = s.slice(idx + 1)
      if (!tag || !txt) return 'null'
      return `(__el=(function(){var els=document.querySelectorAll(${JSON.stringify(tag)});for(var i=0;i<els.length;i++){var t=(els[i].innerText||els[i].value||'').trim();if(t===${JSON.stringify(txt)})return els[i]}return null})())`
    }
    if (s.startsWith('__label__:')) {
      const t = s.slice(10); if (!t) return 'null'
      return `(__el=(function(){var ls=document.querySelectorAll('label');for(var i=0;i<ls.length;i++){var tx=(ls[i].innerText||ls[i].textContent||'').trim();if(tx===${JSON.stringify(t)}){var c=ls[i].control||(ls[i].htmlFor&&document.getElementById(ls[i].htmlFor))||ls[i].querySelector('input,textarea,select');if(c)return c}}return null})())`
    }
    return `(__el=document.querySelector(${JSON.stringify(s)}))`
  }

  // 定位事件该在哪个 frame 上执行:ev.fu=录制时子框架(iframe)URL → 找同 URL 的 frame;
  // 无 fu=主框架;找不到匹配 frame(iframe 已卸载/换页)则退回主框架,至少不崩。
  // 返回值有统一的 .executeJavaScript(code, userGesture) —— wc 与 WebFrameMain 同签名。
  function frameFor(wc, ev) {
    if (!ev || !ev.fu) return wc
    try {
      const frames = wc.mainFrame.framesInSubtree
      for (const f of frames) if (f !== wc.mainFrame && f.url === ev.fu) return f
      const want = String(ev.fu).split('#')[0]   // 宽松:query/hash 可能变,按 origin+path 再找一次
      for (const f of frames) if (f !== wc.mainFrame && String(f.url).split('#')[0] === want) return f
    } catch {}
    return wc
  }

  // 按文件 basename 匹配 coverage URL,统计每个 changed file 的执行函数数
  function coverageHits(cov, changedFiles) {
    const baseToFile = new Map()
    for (const f of changedFiles) {
      const b = f.split(/[\\/]/).pop()
      if (b) baseToFile.set(b, f)
    }
    const hits = new Map()
    for (const entry of cov || []) {
      const url = entry.url || ''
      const ub = url.split('?')[0].split('#')[0].split('/').pop()
      const cf = baseToFile.get(ub); if (!cf) continue
      let executed = 0
      for (const fn of entry.functions || []) {
        if (fn.ranges && fn.ranges[0] && fn.ranges[0].count > 0) executed++
      }
      hits.set(cf, (hits.get(cf) || 0) + executed)
    }
    return changedFiles.map((f) => ({ file: f, executed: hits.get(f) || 0 }))
  }

  // 只对前端常见可执行扩展报警(后端 java/py/sql 不会在浏览器里跑,缺命中是正常的)
  const JS_LIKE = /\.(?:js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i

  // ── 错误聚类: 按 stack 签名分组,降噪 ─────────────────────────────────────
  function clusterErrs(errs) {
    const groups = new Map()   // signature -> { count, sample, firstAt }
    errs.forEach((c, idx) => {
      const head = (c.message || '').split('\n')[0].slice(0, 140)
      const f0 = c.frames && c.frames[0]
      const sig = head + '|' + (f0 ? (f0.url || '') + ':' + f0.line : '')
      const g = groups.get(sig)
      if (g) { g.count++ } else groups.set(sig, { count: 1, sample: c, firstAt: idx + 1 })
    })
    return [...groups.values()]
  }

  // 报告:把 before/after diff 翻译成 PASS/FAIL 文字结论(无视觉依赖)
  function diffReport(rec, replay) {
    const before = rec.snapshot || { errs: [], bad: [] }
    const after = replay.after
    const lines = []
    lines.push(`回放 ${replay.stepReport.length}/${rec.events.length} 步,起始 URL: ${rec.startUrl}`)
    const fails = replay.stepReport.filter((s) => !s.ok && !s.transient)   // transient=日历格子预期失败,不算回归
    if (fails.length) {
      lines.push(`\n步骤失败 ${fails.length} 处(可能是修复后页面结构变了,部分元素找不到):`)
      for (const f of fails.slice(0, 10)) lines.push(`  · 步 ${f.i} ${f.act} "${String(f.sel).slice(0, 60)}" — ${f.err}`)
      if (replay.cascadeFrom >= 0) {
        const skipped = replay.totalSteps - replay.stepReport.length
        lines.push(`  ! 步 ${replay.cascadeFrom} 起连续 3 次失败 → 早停(后续 ${skipped} 步未执行),通常是早期失败破坏了页面流程,排查那个首失败点即可,后面级联多半假阳性`)
      }
    } else lines.push('所有步骤执行成功 ✓')
    lines.push(`\n报错前后对比: 修复前 ${before.errs.length} → 修复后 ${after.errs.length}`)
    if (after.errs.length) {
      const grp = new Map()   // msg head → count
      for (const e of after.errs) { const k = (e.msg || '').slice(0, 140); grp.set(k, (grp.get(k) || 0) + 1) }
      lines.push('  修复后仍有(同消息已聚合):')
      const sorted = [...grp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      for (const [msg, n] of sorted) lines.push(`    ✗ ${msg}${n > 1 ? '  ×' + n : ''}`)
    }
    lines.push(`网络/业务异常前后对比: 修复前 ${before.bad.length} → 修复后 ${after.bad.length}`)
    if (after.bad.length) {
      lines.push('  修复后仍有:')
      for (const b of after.bad.slice(0, 8)) lines.push(`    ${b.biz ? '200·业务异常 ' + b.biz : (b.status || b.state)}  ${b.url}`)
    }
    // 技能成功断言/弹窗应答:仅展示,不并入本判定(修复验证的 PASS/FAIL 语义不受用户随手填的断言影响)
    if (replay.success) lines.push(`\n技能成功断言(仅参考): ${replay.success.pass ? '✓' : '✗'} [${replay.success.kind}] "${replay.success.value}"${replay.success.err ? '(检查出错: ' + replay.success.err + ')' : ''}`)
    if (replay.dialogs && replay.dialogs.length) lines.push(`回放中自动应答弹窗 ${replay.dialogs.length} 个(confirm→确定): ` + replay.dialogs.slice(0, 3).map((d) => d.k + '「' + d.m + '」').join(' | '))
    // 断言:agent 明确声明"应让什么消失/出现",这是 PASS 的硬证据(优先于数量对比)
    let assertFail = 0
    if (replay.assertions && replay.assertions.length) {
      lines.push('\nAgent 声明的修复断言(逐条核对当前状态):')
      for (const a of replay.assertions) {
        const mark = a.pass ? '✓' : '✗'
        if (!a.pass) assertFail++
        lines.push(`  ${mark} [${a.kind}] "${a.value}"  — ${a.detail}${a.why ? '   · ' + a.why : ''}`)
      }
    }
    // 命中证据:agent 改过的前端文件,回放期间有多少函数真被执行了
    let unhitJsCount = 0
    if (replay.changedFiles && replay.changedFiles.length) {
      const jsLike = replay.hitInfo.filter((h) => JS_LIKE.test(h.file))
      const others = replay.hitInfo.filter((h) => !JS_LIKE.test(h.file))
      lines.push(`\nAgent 改动文件(本次 session 共 ${replay.changedFiles.length} 个),回放期间执行命中:`)
      if (!replay.covOn) lines.push('  ! 当前标签未挂 CDP 调试器,无法收集 V8 coverage(打开 DevTools 触发一次即可启用)')
      else {
        for (const h of jsLike) {
          const mark = h.executed > 0 ? '✓' : '✗'
          if (h.executed === 0) unhitJsCount++
          lines.push(`  ${mark} ${h.file}  (${h.executed} 个函数被执行)`)
        }
        if (others.length) lines.push(`  · 其它非 JS 改动 ${others.length} 个(java/py/sql 等不在浏览器跑,不参与命中评估):${others.map((o) => o.file).join(', ')}`)
        if (unhitJsCount > 0) lines.push(`  ! ${unhitJsCount} 个 JS/TS 改动在回放中未被执行 — 大概率改错地方,或这条复现路径不覆盖此改动`)
      }
    }
    // 判定:报错与网络异常都不多于(且无新增) + 步骤全过 + 改动都被命中(若有 JS 改动) → PASS
    const beforeErrMsgs = new Set(before.errs.map((e) => e.msg))
    const beforeBadUrls = new Set(before.bad.map((b) => b.url + '|' + (b.status || '') + '|' + (b.biz || '')))
    const newErrs = after.errs.filter((e) => !beforeErrMsgs.has(e.msg))
    const newBads = after.bad.filter((b) => !beforeBadUrls.has(b.url + '|' + (b.status || '') + '|' + (b.biz || '')))
    const errsImproved = after.errs.length <= before.errs.length
    const badsImproved = after.bad.length <= before.bad.length
    // 影响半径检查:agent 改了文件却没事先 scan_impact 扫过 = 盲改 → SUSPICIOUS
    let blindEdits = []
    if (replay.changedFiles && replay.changedFiles.length && replay.scans) {
      const scannedSet = replay.scans.scannedFiles
      // 改的文件 basename 在 scan 历史中出现过任一,就算扫过
      const scannedBase = new Set()
      for (const f of scannedSet) { const b = f.split(/[\\/]/).pop(); if (b) scannedBase.add(b) }
      blindEdits = replay.changedFiles.filter((f) => {
        const b = f.split(/[\\/]/).pop()
        return !scannedSet.has(f) && !scannedBase.has(b)
      })
      lines.push('\nAgent 改前影响半径扫描:')
      if (replay.scans.scans.length === 0) {
        lines.push('  ! 一次都没调 scan_impact — agent 没查改动影响范围,盲改')
      } else {
        lines.push(`  · 共扫了 ${replay.scans.scans.length} 个符号,覆盖 ${scannedSet.size} 个文件`)
        for (const s of replay.scans.scans.slice(0, 5)) lines.push(`    ✓ scan_impact("${s.symbol}") → ${s.files.length} 文件`)
      }
      if (blindEdits.length) lines.push(`  ! 改了 ${blindEdits.length} 个未扫过的文件(盲改):\n` + blindEdits.slice(0, 5).map((f) => '    · ' + f).join('\n'))
    }
    // Self-review 显示
    if (replay.review) {
      lines.push('\nAgent 自评 (repro_self_review):')
      lines.push(`  · 信心 ${replay.review.risk}/5 — ${replay.review.summary}`)
      if (replay.review.edge_cases) lines.push(`  · 未覆盖的边界: ${replay.review.edge_cases}`)
    } else if (replay.changedFiles && replay.changedFiles.length) {
      lines.push('\n! Agent 没调 repro_self_review — 跳过了自审环节')
    }

    const hitsOk = unhitJsCount === 0   // 若全是后端改动或无 JS 改动,自动 true
    const assertOk = assertFail === 0
    const radiusOk = blindEdits.length === 0
    const reviewOk = !replay.changedFiles || !replay.changedFiles.length || (replay.review && replay.review.risk >= 3)
    const pass = errsImproved && badsImproved && newErrs.length === 0 && newBads.length === 0 && fails.length === 0 && hitsOk && assertOk && radiusOk && reviewOk
    let verdict
    if (!assertOk) verdict = `✗ FAIL — Agent 自己声明的 ${assertFail} 条断言未通过(见上面 ✗ 标的几条) → 修复未达成 agent 自己的预期`
    else if (newErrs.length || newBads.length) verdict = `✗ FAIL — 出现了修复前没有的新问题:${newErrs.length} 条新报错 / ${newBads.length} 条新网络异常 → 回归了`
    else if (!radiusOk) verdict = `SUSPICIOUS — 改了 ${blindEdits.length} 个未扫过的文件(盲改),没确认这些改动的影响半径 → 可能改坏其他功能`
    else if (!hitsOk) verdict = `SUSPICIOUS — 报错和网络看着好了,但 ${unhitJsCount} 个 JS 改动在回放期间根本没被执行 → 可能改错地方,问题"看似消失"可能是别的因素`
    else if (!reviewOk) verdict = replay.review ? `SUSPICIOUS — Agent 自评信心 ${replay.review.risk}/5 偏低 → 修复可能不彻底,建议看 review 里的边界后再确认` : 'SUSPICIOUS — Agent 跳过了 self-review,缺少自审证据'
    else if (fails.length) verdict = 'PARTIAL — 步骤执行有失败(可能页面结构变了),无法可靠判断;建议人工再看一眼'
    else if (!errsImproved || !badsImproved) verdict = '✗ FAIL — 数量变多了 → 没修好或引入了新问题'
    else if (pass && replay.assertions && replay.assertions.length) verdict = `✓ PASS — Agent ${replay.assertions.length} 条断言全部满足 + 影响半径已扫 + self-review 信心 ${replay.review ? replay.review.risk : '-'}/5 + JS 改动均被执行 → 修复有硬证据`
    else if (pass) verdict = '✓ PASS — 复现路径全部走通,报错/网络异常未增加,JS 改动均被执行,影响半径与 self-review 完整'
    else verdict = '✓ PASS'
    return { pass, verdict, text: verdict + '\n\n' + lines.join('\n') }
  }

  function applyParams(rec, values) {
    if (!Array.isArray(rec.params) || !rec.params.length) return rec
    const clone = JSON.parse(JSON.stringify(rec))
    for (const p of clone.params) {
      const ev = clone.events[p.stepIndex]
      if (!ev || (ev.act !== 'input' && ev.act !== 'select')) continue
      const explicit = values && values[p.key] != null
      const v = explicit ? values[p.key] : p.default
      const prevVal = String(ev.value == null ? '' : ev.value)
      ev.value = String(v == null ? '' : v).slice(0, 200)
      // select 的 text 回退只在值【真的变了】时才删:新 value 未命中选项不该被 text 拉回旧选项;
      // 但 UI 填参框会把没动过的预填默认值也传上来,值没变就保留 text —— 跨环境字典差异仍可靠文本命中
      if (ev.act === 'select' && explicit && ev.value !== prevVal) delete ev.text
    }
    return clone
  }

  // 只认 http/https 的 origin(挡 javascript:/file:/data:);不要用 normalizeUrl(它补协议且放行 file:)
  function safeOrigin(s) {
    try {
      const u = new URL(String(s || '').trim())
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      if (u.origin === 'null') return null
      return u.origin
    } catch { return null }
  }

  // 环境切换(dev/uat/prod):把录制 origin 前缀替换成目标 baseUrl;换了环境就不恢复录制登录态
  function applyBaseUrl(rec, baseUrl) {
    const to = safeOrigin(baseUrl); if (!to) return rec
    let from; try { from = new URL(rec.startUrl).origin } catch { return rec }
    if (from === to) return rec
    const clone = JSON.parse(JSON.stringify(rec))
    const swap = (u) => (u === from || String(u).startsWith(from + '/')) ? to + String(u).slice(from.length) : u
    clone.startUrl = swap(clone.startUrl)
    for (const ev of clone.events) if (ev.act === 'navigate' && ev.url) ev.url = swap(ev.url)
    clone._baseSwapped = true
    return clone
  }

// ── 录制降噪:把"逐事件照录"压成"有意义的操作序列" ──────────────────────────
// 停录保存前跑一遍(window.js browser-rec-stop),纯函数、可离线自测。只删【可证明的噪声】,保守优先:
//   1 scroll —— 回放 click 自带 scrollIntoView,滚到固定 x/y 无意义且页面高度一变即失配
//   2 同元素连续 input 合并留最后 —— 用户反复敲/组件程序化重填 → 只需终值;顺带把"密码敲 4 下=4 个密码步/参数"收成 1 个
//   3 只为聚焦的 click —— 紧跟同元素 input/select/check,输入步自己会聚焦+写值,点一下纯多余
//   4 提交去重 —— Enter / 点提交按钮 / 表单 submit 三者常同时出现(一次登录仨提交步),回放会【重复提交】(银行表单危险),收成一个
//   5 key:Tab —— 纯焦点移动,回放按选择器直接写值不依赖 Tab 遍历
// newtab 搜索框(#s)这类 chrome 噪声由 RECORDER_JS 的 emit 源头守卫拦掉,不在此函数职责内。
// 返回 { events: 压缩后, dropped: [{i,act,sel,reason}] };survivors + dropped(按原下标 i)可还原原始序列,透明可回溯。
function compactEvents(events) {
  const src = Array.isArray(events) ? events : []
  const dropped = []
  const drop = (o, reason) => { dropped.push({ i: o.i, act: o.ev.act, sel: o.ev.sel || o.ev.url || '', reason }) }
  const SUBMIT_TXT = /登录|登陆|登入|提交|确定|确认|保存|搜索|查询|下一步|signin|login|submit|save|search|next/i
  const isSubmitClick = (ev) => !!(ev && ev.act === 'click' && SUBMIT_TXT.test(String(ev.text || '').replace(/\s+/g, '')))
  const gap = (a, b) => Math.abs((Number(b && b.t) || 0) - (Number(a && a.t) || 0))
  let arr = src.map((ev, i) => ({ ev, i }))   // 带原下标处理,dropped 记原始位置

  // Pass 1:删 scroll、key:Tab
  arr = arr.filter((o) => {
    if (o.ev.act === 'scroll') { drop(o, 'scroll-噪声(回放靠 scrollIntoView)'); return false }
    if (o.ev.act === 'key' && o.ev.key === 'Tab') { drop(o, 'key:Tab-纯焦点移动'); return false }
    return true
  })
  // Pass 2:同元素连续 input 合并 —— 前一次被后一次覆盖(值/secret 以最后一次为准)
  arr = arr.filter((o, idx, a) => {
    const nx = a[idx + 1]
    if (o.ev.act === 'input' && o.ev.sel && nx && nx.ev.act === 'input' && nx.ev.sel === o.ev.sel) { drop(o, 'input-被同元素后一次覆盖'); return false }
    return true
  })
  // Pass 3:删只为聚焦的 click(紧跟同元素 input/select/check)
  arr = arr.filter((o, idx, a) => {
    const nx = a[idx + 1]
    if (o.ev.act === 'click' && o.ev.sel && nx && (nx.ev.act === 'input' || nx.ev.act === 'select' || nx.ev.act === 'check') && nx.ev.sel === o.ev.sel) { drop(o, 'click-仅聚焦(后随同元素输入)'); return false }
    return true
  })
  // Pass 4:提交去重
  //  4a 紧跟 click/key:Enter 的 submit → 删(前者已触发提交,防重复提交)
  //  4b 紧跟"提交按钮 click"的 key:Enter → 删(同一次提交,保留更稳的按钮点击)
  arr = arr.filter((o, idx, a) => {
    const prev = a[idx - 1], nx = a[idx + 1]
    if (o.ev.act === 'submit' && prev && (prev.ev.act === 'click' || (prev.ev.act === 'key' && prev.ev.key === 'Enter')) && gap(prev.ev, o.ev) < 800) { drop(o, 'submit-冗余(前一步已触发提交)'); return false }
    if (o.ev.act === 'key' && o.ev.key === 'Enter' && nx && isSubmitClick(nx.ev) && gap(o.ev, nx.ev) < 800) { drop(o, 'Enter-与提交按钮点击同意图'); return false }
    return true
  })
  return { events: arr.map((o) => o.ev), dropped }
}

// ── 人机断点识别(地基第 2 层,确定性、不依赖模型网关)────────────────────────
// 有些输入必须人来、且每次不同(短信/邮箱验证码、图形码、动态口令、滑块、人脸),录制的值是一次性的、
// 回放照填必然失败或触发风控。识别出来 → 回放到这一步【暂停】,把浏览器交还给人现场输入,人填完再续跑。
// 靠字段上下文(autocomplete/placeholder/label + 选择器)+ 关键词判定;autocomplete="one-time-code" 是 OTP 的 W3C 标准标记,命中即判定。
// 两张表分开,因为【填值类】与【动作类】的判定面必须不同(见 humanGateHint 注释):
const HUMAN_RE = /验证码|校验码|短信码|短信验证|短讯验证|动态[口令码]|动态令牌|动态密码|图形码|图片码|安全码|口令卡|手机令牌|保安编码|一次性密码|U盾|ukey|MFA|二次验证|双因素|captcha|verif(?:y|ication)[-\s_]?code|one[-\s]?time|(?:^|[^a-z])otp(?:[^a-z]|$)/i
// 行为验证:不是"填个值"而是"做个动作"(滑块拖一下/刷个脸/扫个码)。录制时是 click/拖拽【不是 input】,
// 老版本 act!=='input' 一刀切 → 这类永远识别不到(关键词写了也白写),回放照点必然失败/触发风控。
const HUMAN_ACT_RE = /滑块|滑动验证|拖动验证|拖动滑块|行为验证|安全验证|人脸|刷脸|指纹|扫码|扫一扫|二维码/i
// 繁体→简体归一化(只映射关键词里用到的字):港澳台站点(实测交行香港)的「驗證碼/手機驗證碼/保安編碼器/短訊」
// 全是繁体,简体正则一个都匹配不上 → 录制识别、回放运行时探测双双失明,验证码弹窗被当成"元素定位失败"走自愈,整场跑偏。
// 匹配前过一遍映射,正则本身保持简体一份(不用每条翻倍)。与 recorder.js LIVE_GATE_JS 里的内联版保持同步。
const T2S_FROM = '驗證碼動態圖機臉掃維塊為雙紋編號訊鑑權驗証'
const T2S_TO   = '验证码动态图机脸扫维块为双纹编号讯鉴权验证'
function t2s(s) { return String(s == null ? '' : s).replace(/[㐀-鿿]/g, (c) => { const i = T2S_FROM.indexOf(c); return i >= 0 ? T2S_TO[i] : c }) }
function humanGateHint(ev) {
  if (!ev) return null
  const hay = t2s([ev.ph, ev.lb, ev.sel, ev.text, ...(Array.isArray(ev.selAlt) ? ev.selAlt : [])].filter(Boolean).join(' '))
  if (ev.act === 'input') {
    if (/one-time-code/i.test(String(ev.ac || ''))) return '验证码(one-time-code)'
    const m = hay.match(HUMAN_RE)
    return m ? m[0] : null
  }
  // 非输入步只认【行为验证】,不吃 HUMAN_RE ——「获取验证码」按钮虽带"验证码"字样,但它正是【该自动点】的那一下,
  // 认成断点会让每次回放都停下等人。填值的那个字段自己会被上面的 input 分支认出来。
  if (ev.act === 'click' || ev.act === 'submit') {
    const m = hay.match(HUMAN_ACT_RE)
    return m ? m[0] : null
  }
  return null
}
// 给事件序列打人机断点标记:命中的步置 human=true + humanHint;填值类另清空 value
// (一次性验证码不留存、回放不照填,靠人现场输入)。行为类(滑块/人脸)本就没值,不动 value。
// 纯函数:原地不改入参,返回带标记的新数组。
function markHumanGates(events) {
  return (Array.isArray(events) ? events : []).map((ev) => {
    const hint = humanGateHint(ev)
    if (!hint) return ev
    const o = Object.assign({}, ev, { human: true, humanHint: hint })
    if (ev.act === 'input' || ev.act === 'select') o.value = ''
    delete o.secret   // 人机断点语义已覆盖"不照填",secret 标记多余
    return o
  })
}

// ── SKILL 语义视图(Phase 2,对标 Codex Record & Replay 的技能文档)──────────────
// 设计:docs/技能系统-意图执行与Agent解析链设计.md。events 仍是唯一可执行真相;
// steps 是从 events 确定性生成的语义视图(ei 回指 events 下标),只承载 意图/输入来源/断点,
// 不复制 action 全量字段 —— 避免双真相漂移。events/params/skipSteps 任一变动就重建(见 window.js refreshSkillArtifacts)。
// Codex 技能四要素:何时使用 / 所需输入 / 操作步骤 / 结果核验(skillMd 按此四段渲染,给人读、给 Agent 当上下文)。
function fieldName(ev) { return ev.lb || ev.ph || null }   // 录制时抓的 label/placeholder(recorder fieldCtx)
function selDesc(ev) {
  const fn = fieldName(ev); if (fn) return fn
  const s = String(ev.sel || '')
  if (s.startsWith('__text__:')) { const i = s.indexOf('|'); return s.slice(i + 1) }
  return s.replace(/^#/, '') || ev.act
}
function stepIntent(ev) {
  switch (ev.act) {
    case 'navigate': return (ev.spa ? '页内跳转到 ' : '打开 ') + String(ev.url || '')
    case 'click': return '点击「' + (ev.text || selDesc(ev)) + '」'
    case 'input': return ev.human ? '人工输入:' + (ev.humanHint || '需人工操作') : '填写「' + selDesc(ev) + '」'
    case 'select': return '选择「' + selDesc(ev) + '」=' + (ev.text || ev.value || '')
    case 'check': return (ev.checked ? '勾选' : '取消勾选') + '「' + selDesc(ev) + '」'
    case 'key': return '按 ' + ev.key + (ev.key === 'Enter' ? '(确认)' : '')
    case 'submit': return '提交表单'
    case 'scroll': return '滚动页面'
    default: return String(ev.act || '')
  }
}
// rec(events/params/skipSteps)→ { skillRev, steps }。纯函数,离线可测,无 LLM 也能跑(降级基线);
// Phase 4 的编译时 Agent 只是在这份草稿上精修 intent/补 expect,schema 不变。
function upgradeToSkill(rec) {
  const events = Array.isArray(rec && rec.events) ? rec.events : []
  const params = Array.isArray(rec && rec.params) ? rec.params : []
  const skip = new Set(Array.isArray(rec && rec.skipSteps) ? rec.skipSteps : [])
  const ovr = (rec && rec.intentOverrides && typeof rec.intentOverrides === 'object') ? rec.intentOverrides : null   // Agent 精修的人话步名(ei 键),优先于启发式
  const byIdx = new Map(params.map((p) => [p.stepIndex, p]))
  const steps = []
  events.forEach((ev, ei) => {
    if (skip.has(ei) || !ev) return   // 用户勾掉的噪声步不进语义视图(回放层仍按 skipSteps 跳)
    const st = { ei, act: ev.act, intent: (ovr && typeof ovr[ei] === 'string' && ovr[ei]) || stepIntent(ev) }
    if (ev.act === 'input' || ev.act === 'select') {
      const p = byIdx.get(ei)
      if (ev.human) st.input = { name: ev.humanHint || '人工输入', source: 'resolve', ask: (ev.humanHint || '需人工输入') + (fieldName(ev) ? '(字段:' + fieldName(ev) + ')' : '') }
      else if (p) st.input = { name: p.label || p.key, source: 'param', key: p.key }
      else st.input = { name: selDesc(ev), source: 'static', value: ev.secret ? '' : String(ev.value == null ? '' : ev.value).slice(0, 200) }
    }
    if (ev.human) st.gate = { type: 'human', hint: ev.humanHint || '需人工操作' }
    steps.push(st)
  })
  return { skillRev: 1, steps }
}
// Codex 四段式技能文档(确定性渲染,可反复重建;.skill.md 落在 recordings 目录与 JSON 并排)
function skillMd(rec) {
  const { steps } = upgradeToSkill(rec)
  const L = ['# 技能:' + (rec.title || rec.id || '未命名'), '']
  L.push('## 何时使用')
  L.push(rec.description || rec.expectation || '(未填写 —— 建议补一句"什么情况下跑这个技能")')
  L.push('起始页:' + (rec.startUrl || ''), '')
  L.push('## 所需输入')
  const inputs = steps.filter((s) => s.input && s.input.source !== 'static')
  if (!inputs.length) L.push('无 —— 全部步骤为静态值,可直接运行。')
  for (const s of inputs) {
    if (s.input.source === 'param') L.push('- 【运行参数】' + s.input.name + '(运行前填写,key=' + s.input.key + ')')
    else L.push('- 【运行时解析】' + s.input.ask + '(回放到该步暂停,由人或 Agent 现场提供)')
  }
  L.push('', '## 操作步骤')
  steps.forEach((s, i) => {
    let line = (i + 1) + '. ' + s.intent
    if (s.input && s.input.source === 'param') line += '  [参数:' + s.input.name + ']'
    if (s.gate) line += '  [⏸ ' + s.gate.hint + ']'
    L.push(line)
  })
  L.push('', '## 结果核验')
  if (rec.success && rec.success.value) L.push('- 成功标志:' + (rec.success.kind === 'text' ? '页面出现文本' : '页面出现元素') + '「' + rec.success.value + '」')
  if (rec.expectation && rec.expectation !== rec.description) L.push('- 期望:' + rec.expectation)
  L.push('- 回放后自动核对:步骤成功率 + 控制台报错 + 网络/业务异常(diffReport)')
  if (rec.postWorkflow && rec.postWorkflow.goal) L.push('', '## 下载后编排', '回放导出/下载文件后,自动把文件交给动态工作流处理:', '> ' + String(rec.postWorkflow.goal).slice(0, 300))
  if (rec.skillNotes) L.push('', '## 注意事项(决策点/隐藏偏好)', rec.skillNotes)   // Agent 精修补的"Codex 式"决策点说明
  return L.join('\n')
}

// 「下载后编排」目标合成(纯函数):技能回放把文件导出/下载到本地后,把文件绝对路径接进动态工作流目标文本。
// template=用户填的人话目标(如"把导出的用户反馈表做成分析报告");files=本次回放捕获到的下载文件绝对路径数组。
// 值全是文件路径(业务产物,非机密),可安全进模型;显式要求子任务用读取/表格解析工具打开,别臆测。
function composePostWorkflowGoal(skillName, template, files) {
  const tpl = String(template == null ? '' : template).trim()
  if (!tpl) return ''
  const list = (Array.isArray(files) ? files : []).map((f) => String(f == null ? '' : f).trim()).filter(Boolean)
  if (!list.length) return tpl
  return tpl
    + '\n\n【输入文件】由技能「' + String(skillName || '').slice(0, 60) + '」运行时导出/下载到本地,请先读取这些文件再完成上面的目标:\n'
    + list.map((f) => '- ' + f).join('\n')
    + '\n(以上是绝对路径的本地文件;用读取/表格解析等工具打开其内容,不要凭空臆测。)'
}

// ── Phase 4·编译时 Agent:精修补丁应用(纯函数)────────────────────────────────
// Agent 产出 JSON 补丁 { title, description, intents:{ei:名}, params:[{stepIndex,label}], success, notes },
// 这里逐字段校验后应用:坏字段静默丢弃(宁缺毋滥,坏补丁绝不毁技能)。
// intent 精修存 intentOverrides(ei 键)—— upgradeToSkill 优先读,steps 随 events 重建也不丢;
// success 只在用户没设过时应用(人的判断优先于模型);params 只追加合法新参数,不动已有。
function applyRefinePatch(rec, patch) {
  const j = JSON.parse(JSON.stringify(rec || {}))
  const p = (patch && typeof patch === 'object') ? patch : {}
  const applied = []
  if (typeof p.title === 'string' && p.title.trim() && p.title.trim() !== (j.title || '')) { j.title = p.title.trim().slice(0, 40); applied.push('标题') }
  if (typeof p.description === 'string' && p.description.trim()) { j.description = p.description.trim().slice(0, 300); applied.push('何时使用') }
  const events = Array.isArray(j.events) ? j.events : []
  if (p.intents && typeof p.intents === 'object' && !Array.isArray(p.intents)) {
    const ovr = Object.assign({}, j.intentOverrides)
    let n = 0
    for (const [k, v] of Object.entries(p.intents)) {
      const ei = Number(k)
      if (!Number.isInteger(ei) || ei < 0 || ei >= events.length) continue
      if (typeof v !== 'string' || !v.trim()) continue
      ovr[ei] = v.trim().slice(0, 40); n++
    }
    if (n) { j.intentOverrides = ovr; applied.push('步骤命名×' + n) }
  }
  if (Array.isArray(p.params)) {
    const have = new Set((j.params || []).map((x) => x && x.stepIndex))
    const add = []
    for (const s of p.params) {
      const si = Number(s && s.stepIndex)
      const ev = events[si]
      if (!Number.isInteger(si) || !ev || have.has(si)) continue
      if (ev.act !== 'input' && ev.act !== 'select') continue
      if (ev.secret || ev.human) continue   // 密码/人机断点步不参数化(各有专属机制)
      const label = String((s && s.label) || '').trim().slice(0, 30); if (!label) continue
      add.push({ key: 'p' + ((j.params || []).length + add.length + 1), label, stepIndex: si, default: String(ev.value == null ? '' : ev.value).slice(0, 200) })
      have.add(si)
    }
    if (add.length) { j.params = [...(j.params || []), ...add]; applied.push('参数建议×' + add.length) }
  }
  if (!j.success && p.success && (p.success.kind === 'css' || p.success.kind === 'text') && typeof p.success.value === 'string' && p.success.value.trim()) {
    j.success = { kind: p.success.kind, value: p.success.value.trim().slice(0, 500) }; applied.push('成功判据')
  }
  if (typeof p.notes === 'string' && p.notes.trim()) { j.skillNotes = p.notes.trim().slice(0, 500); applied.push('注意事项') }
  return { rec: j, applied }
}

// ── 混合执行 · 接管上下文摘要(纯函数)─────────────────────────────────────────
// 严格回放整段失败(级联 3 连败/导航失败)→ 把技能上下文交给 Agent 流程级接管。
// 摘要含:目标/已完成/失败点/剩余步骤(意图+选择器+值)。
// 【安全】secret 值绝不进摘要:以「type_param(参数键)」指代,由引擎持值代填;
// 人机断点步注明"提醒用户到页面输入"。
function takeoverDigest(rec, fromIndex, fail) {
  const evs = Array.isArray(rec && rec.events) ? rec.events : []
  const params = Array.isArray(rec && rec.params) ? rec.params : []
  const paramIdx = new Map(params.map((p) => [p.stepIndex, p]))
  const { steps } = upgradeToSkill(rec)
  const intentAt = new Map(steps.map((s) => [s.ei, s.intent]))
  const line = (ev, i) => {
    const it = intentAt.get(i) || ev.act
    const p = paramIdx.get(i)
    let v = ''
    if (ev.act === 'input' || ev.act === 'select') {
      if (ev.human) v = ' (需人工:' + (ev.humanHint || '人工输入') + ' — 在对话里提醒用户到页面输入后再继续)'
      else if (ev.secret || (p && p.secret)) v = ' (secret 参数 ' + (p ? p.key : '') + (p && p.label ? ':' + p.label : '') + ' — 用 skill_page_act 的 type_param 代填,值不会给你)'
      else if (p) v = ' =「' + String(ev.value == null ? '' : ev.value).slice(0, 60) + '」(参数 ' + p.key + ')'
      else v = ' =「' + String(ev.value == null ? '' : ev.value).slice(0, 60) + '」'
    }
    return (i + 1) + '. ' + it + v + (ev.sel ? '  [sel: ' + String(ev.sel).slice(0, 80) + ']' : (ev.url ? '  [url: ' + String(ev.url).slice(0, 100) + ']' : ''))
  }
  const doneL = [], restL = []
  evs.forEach((ev, i) => { if (!ev) return; (i < fromIndex ? doneL : restL).push(line(ev, i)) })
  return {
    title: rec && (rec.title || rec.id) || '',
    goal: rec && (rec.description || rec.expectation) || '',
    successText: rec && rec.success && rec.success.value ? ((rec.success.kind === 'text' ? '页面出现文本' : '页面出现元素') + '「' + rec.success.value + '」') : '',
    doneText: doneL.join('\n') || '(无)',
    restText: restL.join('\n') || '(无)',
    failText: fail ? ('第 ' + (fromIndex + 1) + ' 步失败:' + (fail.err || '')) : '',
  }
}

// ── Phase 5·数据集批跑:一行数据 → 运行参数 values(纯函数)────────────────────
// Agent 从 Excel/DB 读出的行键是"人话列名",按参数 label 对齐:label 精确 → key 精确 → 包含关系(唯一命中才用)。
// 未命中的参数走 applyParams 的 default 兜底;行里多出的键收进 unmatched(报告透出,提示列名没对上)。
// 同 label 多参数(旧录制"密码×4")各自命中同一列,天然同值 —— 正确语义。
function rowToParamValues(params, row) {
  const ps = Array.isArray(params) ? params : []
  const r = (row && typeof row === 'object' && !Array.isArray(row)) ? row : {}
  const values = {}
  const used = new Set()
  for (const p of ps) {
    if (!p || !p.key) continue
    let hitKey = null
    if (p.label != null && Object.prototype.hasOwnProperty.call(r, p.label)) hitKey = p.label
    else if (Object.prototype.hasOwnProperty.call(r, p.key)) hitKey = p.key
    else if (p.label) {
      const cands = Object.keys(r).filter((k) => String(k).includes(p.label) || String(p.label).includes(String(k)))
      if (cands.length === 1) hitKey = cands[0]
    }
    if (hitKey != null) { values[p.key] = String(r[hitKey] == null ? '' : r[hitKey]).slice(0, 200); used.add(hitKey) }
  }
  const unmatched = Object.keys(r).filter((k) => !used.has(k))
  return { values, unmatched }
}

// 把录制里的登录态抹掉,专供【要交出去的副本】(证据包/给 Agent 看的 JSON)。
// 磁盘上的 recordings/<id>.json 必须留着真 preState —— 那是回放前恢复登录态的原料,抹了技能就跑不动;
// 但交给模型的证据副本不需要 cookie,留着就是明文外泄。两个方向,别混为一谈。
// 为什么 events 也要扫:replayRec 会把整个 preState 塞进 events[i]._restorePreState,
// 而 applyParams 在【无参数技能】上返回的是同一个对象引用 → 这份污染会顺着 S.browser.lastRec 一路传到证据序列化点。
function redactRec(rec) {
  if (!rec || typeof rec !== 'object') return rec
  const c = JSON.parse(JSON.stringify(rec))
  const mask = (ps) => ps && typeof ps === 'object'
    ? { cookies: '(已抹去 ' + ((ps.cookies && ps.cookies.length) || 0) + ' 条 cookie)', local: '(已抹去 localStorage)', session: '(已抹去 sessionStorage)', origin: ps.origin || '' }
    : ps
  if (c.preState) c.preState = mask(c.preState)
  for (const ev of (Array.isArray(c.events) ? c.events : [])) if (ev && ev._restorePreState) ev._restorePreState = mask(ev._restorePreState)
  return c
}
module.exports = { RECORDER_JS, selExpr, findElExpr, frameFor, safeOrigin, applyParams, applyBaseUrl, JS_LIKE, diffReport, coverageHits, clusterErrs, compactEvents, humanGateHint, markHumanGates, upgradeToSkill, skillMd, composePostWorkflowGoal, applyRefinePatch, rowToParamValues, relocateSelectors, takeoverDigest, redactRec, anchorExpr, t2s }

// ── 纯文件 IO 工厂:window.js 注入 { app, fs, path, execSync } 后解构使用 ────────
// 这些函数从 window.js 原样搬入,只把对 app/fs/path/execSync 的引用改为工厂参数(名字不变)。
function initStore({ app, fs, path, execSync }) {
  function recDir() { return path.join(app.getPath('userData'), 'recordings') }
  function readRec(id) { return JSON.parse(fs.readFileSync(path.join(recDir(), String(id).replace(/[^\w.-]/g, '') + '.json'), 'utf8')) }
  function writeLastRun(id, replay) {
    try {
      const fp = path.join(recDir(), String(id).replace(/[^\w.-]/g, '') + '.json')
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const fails = replay.stepReport.filter((s) => !s.ok && !s.transient).length
      j.lastRun = { at: Date.now(), ok: fails === 0 && (!replay.success || replay.success.pass), steps: replay.stepReport.length, fails }
      fs.writeFileSync(fp, JSON.stringify(j, null, 2))
    } catch {}
  }
  function skillList() {
    let files = []; try { files = fs.readdirSync(recDir()).filter((f) => f.endsWith('.json')) } catch { return [] }
    const out = []
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(recDir(), f), 'utf8'))
        if (!j.skill) continue
        out.push({ id: j.id || f.replace(/\.json$/, ''), name: j.title || j.id, description: j.description || '', startUrl: j.startUrl || '',
          steps: (j.events || []).length,
          lastRun: j.lastRun || null,
          hasSuccess: !!(j.success && j.success.value),
          params: (j.params || []).map((p) => ({ key: p.key, label: p.label || p.key, default: p.default != null ? p.default : '', secret: !!p.secret })) })
      } catch {}
    }
    return out
  }
  function loadAssertions(bundleId) {
    if (!bundleId) return []
    const fp = path.join(app.getPath('userData'), 'assertions', bundleId + '.json')
    try { const a = JSON.parse(fs.readFileSync(fp, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] }
  }
  function loadScans(bundleId) {
    if (!bundleId) return { scans: [], scannedFiles: new Set() }
    const fp = path.join(app.getPath('userData'), 'scans', bundleId + '.json')
    let arr = []
    try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')); if (!Array.isArray(arr)) arr = [] } catch {}
    const files = new Set()
    for (const s of arr) for (const f of (s.files || [])) files.add(f)
    return { scans: arr, scannedFiles: files }
  }
  function loadReview(bundleId) {
    if (!bundleId) return null
    const fp = path.join(app.getPath('userData'), 'reviews', bundleId + '.json')
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return null }
  }
  function gitChangedFiles(dir) {
    if (!dir) return []
    const out = new Set()
    for (const cmd of ['git diff --name-only HEAD', 'git diff --cached --name-only HEAD', 'git ls-files --others --exclude-standard']) {
      try { execSync(cmd, { cwd: dir, encoding: 'utf8', timeout: 3000 }).split('\n').forEach((l) => { l = l.trim(); if (l) out.add(l) }) } catch {}
    }
    return [...out]
  }
  return { recDir, readRec, writeLastRun, skillList, loadAssertions, loadScans, loadReview, gitChangedFiles }
}
module.exports.initStore = initStore
