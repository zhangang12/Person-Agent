// 复现链路 e2e 合成测试 (走 Electron 真实环境,不依赖完整 BocomHermes UI / 真 agent)
// 跑法: npx electron scripts/e2e-repro-test.mjs    退出码 0=全过 1=任一失败
//
// 测什么(对应 8 件功能里能在脱离 UI 时验的部分):
//   T1 录制注入 + __BR__ console 标记被 main 进程截留
//   T2 input 事件捕获 + 值正确
//   T3 data-test 选择器优先 > tag 名
//   T4 __bocom_rec_on=false 后停止录制
//   T5 findElExpr/selExpr fallback:主 selector NF → __text__ 文本备选命中
//   T6 断言检查 no_element / has_element 行为正确
//   T7 highlightTarget 红框 DOM 注入
//   T8 V8 PreciseCoverage attach + take(命中证据的底层依赖)
//
// 局限: RECORDER_JS 用简化版(避免模板字面量转义陷阱);真实生产版本只多了 debounce、
// 更多 attr 候选、scroll/key/submit handler,核心路径已覆盖。

import { app, BrowserWindow } from 'electron'

const TESTPAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!doctype html><html><head><meta charset=utf-8><title>repro test</title></head>
<body>
  <button id="submit">提交</button>
  <button data-test="del-btn">删除</button>
  <span>登录</span>
  <input id="amt" name="amount" value="">
  <form id="f1"><input name="who"></form>
  <div class="error-banner">额度计算失败</div>
  <script>
    document.getElementById('submit').addEventListener('click', function(){
      try { var x = null; x.rate; } catch(e) { console.error(e); }
    });
    document.querySelector('[data-test="del-btn"]').addEventListener('click', function(){
      var el = document.querySelector('.error-banner'); if (el) el.remove();
    });
  </script>
</body></html>
`)

// 简化版 RECORDER_JS(同 src/window.js 概念,去掉 debounce 便于即点即测)
const RECORDER_JS = `;(function(){
  if (window.__bocom_rec_init) return; window.__bocom_rec_init = true;
  var emit = function(e){ try { console.log('__BR__' + JSON.stringify(e)); } catch(_){} };
  var sel = function(el){
    if (!el || el === document.body) return ['body'];
    var c = [];
    if (el.id) c.push('#' + el.id);
    var dt = el.getAttribute && el.getAttribute('data-test');
    if (dt) c.push(el.tagName.toLowerCase() + '[data-test="' + dt + '"]');
    var txt = (el.innerText || el.value || '').trim();
    if (txt && txt.length <= 30) c.push('__text__:' + el.tagName.toLowerCase() + '|' + txt);
    c.push(el.tagName.toLowerCase());
    return c;
  };
  document.addEventListener('click', function(e){
    if (!window.__bocom_rec_on) return;
    var c = sel(e.target);
    emit({ act:'click', sel:c[0], selAlt:c.slice(1), text:(e.target.innerText||'').slice(0,40) });
  }, true);
  document.addEventListener('input', function(e){
    if (!window.__bocom_rec_on) return;
    var c = sel(e.target);
    emit({ act:'input', sel:c[0], selAlt:c.slice(1), value:String(e.target.value||'').slice(0,200) });
  }, true);
})();`

// 从 src/window.js 复制过来的 selExpr/findElExpr(回放路径的核心字符串构造,纯函数)
function selExpr(sel) {
  const s = String(sel || '')
  if (s.startsWith('__text__:')) {
    const idx = s.indexOf('|'); const tag = s.slice(9, idx).toLowerCase(); const txt = s.slice(idx + 1)
    return `(function(){var els=document.querySelectorAll(${JSON.stringify(tag)});for(var i=0;i<els.length;i++){var t=(els[i].innerText||els[i].value||'').trim();if(t===${JSON.stringify(txt)}||t.indexOf(${JSON.stringify(txt)})===0)return els[i]}return null})()`
  }
  return `document.querySelector(${JSON.stringify(s)})`
}
function findElExpr(sel, alt) {
  const cands = [sel, ...(alt || [])].filter(Boolean)
  return cands.map((c) => `(__el=${selExpr(c)})`).join(' || ') || 'null'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const wc = win.webContents

  // console-message 在 Electron 25+ 把所有参数打包进 details 对象,旧版是 (e, level, msg, ...)。两种都吃。
  const recorded = []
  wc.on('console-message', (...args) => {
    let msg
    if (args.length >= 2 && args[1] && typeof args[1] === 'object' && 'message' in args[1]) msg = args[1].message
    else if (args.length >= 3) msg = args[2]
    if (typeof msg === 'string' && msg.startsWith('__BR__')) { try { recorded.push(JSON.parse(msg.slice(6))) } catch {} }
  })

  console.log('loading test page…')
  await new Promise((res) => { wc.once('did-finish-load', res); wc.loadURL(TESTPAGE) })
  console.log('page loaded\n')

  // T1 注入 + click 捕获
  console.log('T1 录制注入 + click 捕获:')
  await wc.executeJavaScript(RECORDER_JS + ';window.__bocom_rec_on=true;', true)
  await wc.executeJavaScript(`document.getElementById('submit').click()`, true)
  await sleep(250)
  ok(recorded.some((e) => e.act === 'click' && e.sel === '#submit'), 'click on #submit 被捕获 (sel=#submit)')
  const submitEv = recorded.find((e) => e.act === 'click' && e.sel === '#submit')
  ok(submitEv && Array.isArray(submitEv.selAlt) && submitEv.selAlt.some((s) => s.startsWith('__text__:button|')), '同时记录了 __text__ 备选(' + (submitEv?.selAlt || []).filter((s) => s.startsWith('__text__')).join() + ')')

  // T2 input 事件
  console.log('\nT2 input 事件 + 值:')
  recorded.length = 0
  await wc.executeJavaScript(`(()=>{var el=document.getElementById('amt');var p=Object.getOwnPropertyDescriptor(el.__proto__,'value');p.set.call(el,'50000');el.dispatchEvent(new Event('input',{bubbles:true}))})()`, true)
  await sleep(250)
  const inEv = recorded.find((e) => e.act === 'input' && e.sel === '#amt')
  ok(!!inEv, 'input on #amt 被捕获')
  ok(inEv && inEv.value === '50000', 'input.value 正确 = "' + (inEv?.value || '') + '"')

  // T3 data-test 选择器优先
  console.log('\nT3 data-test 优先:')
  recorded.length = 0
  await wc.executeJavaScript(`document.querySelector('[data-test="del-btn"]').click()`, true)
  await sleep(250)
  const delEv = recorded.find((e) => e.act === 'click' && e.sel === 'button[data-test="del-btn"]')
  ok(!!delEv, 'data-test 作主选择器命中(button[data-test="del-btn"])')

  // T4 停止录制
  console.log('\nT4 __bocom_rec_on=false 停止:')
  recorded.length = 0
  await wc.executeJavaScript(';window.__bocom_rec_on=false;', true)
  await wc.executeJavaScript(`document.getElementById('submit').click()`, true)
  await sleep(250)
  ok(recorded.length === 0, '停止后 click 不再上报 (recorded.length=' + recorded.length + ')')

  // T5 回放 fallback
  console.log('\nT5 selector fallback (主 NF → __text__):')
  await new Promise((res) => { wc.once('did-finish-load', res); wc.reload() })
  const fbExpr = `(()=>{var __el=null; ${findElExpr('#nonexistent-x', ['__text__:span|登录'])}; return __el ? __el.textContent : 'MISS'})()`
  const fb = await wc.executeJavaScript(fbExpr, true)
  ok(fb === '登录', '主 selector NF → fallback 命中 __text__ span|登录 (返回 "' + fb + '")')

  // T6 断言检查 no_element / has_element 等价 JS
  console.log('\nT6 断言检查:')
  const a1 = await wc.executeJavaScript(`!document.querySelector('.nope-never-exists')`, true)
  ok(a1 === true, 'no_element 对不存在元素 → true(应通过)')
  const a2 = await wc.executeJavaScript(`!document.querySelector('.error-banner')`, true)
  ok(a2 === false, 'no_element 对存在元素 → false(应失败)')
  await wc.executeJavaScript(`document.querySelector('.error-banner').remove()`, true)
  const a3 = await wc.executeJavaScript(`!document.querySelector('.error-banner')`, true)
  ok(a3 === true, '元素被移除后 no_element → true(应通过)')
  const a4 = await wc.executeJavaScript(`!!document.querySelector('#submit')`, true)
  ok(a4 === true, 'has_element 对存在元素 → true')

  // T7 highlightTarget 注入红框
  console.log('\nT7 高亮浮框注入:')
  await new Promise((res) => { wc.once('did-finish-load', res); wc.reload() })
  const hiJS = `(()=>{var __el=null;if(!(${findElExpr('#submit', [])}))return 'NF';
    var rect=__el.getBoundingClientRect();
    var box=document.createElement('div');box.id='__bocom_hi__';
    box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #ff3b30';
    box.style.left=(rect.left-3)+'px';box.style.top=(rect.top-3)+'px';
    box.style.width=(rect.width+6)+'px';box.style.height=(rect.height+6)+'px';
    (document.body||document.documentElement).appendChild(box);return 'OK';})()`
  const hr = await wc.executeJavaScript(hiJS, true)
  ok(hr === 'OK', 'highlightTarget JS 执行成功 (return="' + hr + '")')
  const has = await wc.executeJavaScript(`!!document.getElementById('__bocom_hi__')`, true)
  ok(has === true, '#__bocom_hi__ 元素已挂载')

  // T8 V8 PreciseCoverage(命中证据的底层 API 能不能用)
  console.log('\nT8 V8 PreciseCoverage:')
  try {
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Profiler.enable')
    await wc.debugger.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    // 触发一些 JS 代码执行
    await wc.executeJavaScript(`document.getElementById('submit').click(); var a=0; for(var i=0;i<100;i++)a+=i; a`, true)
    await sleep(200)
    const cov = await wc.debugger.sendCommand('Profiler.takePreciseCoverage')
    await wc.debugger.sendCommand('Profiler.stopPreciseCoverage')
    try { wc.debugger.detach() } catch {}
    ok(Array.isArray(cov.result) && cov.result.length > 0, 'takePreciseCoverage 返回 ' + (cov.result?.length || 0) + ' 个脚本 entries')
    const someHit = (cov.result || []).some((e) => (e.functions || []).some((f) => (f.ranges || []).some((r) => r.count > 0)))
    ok(someHit, '至少有一个函数 ranges[].count > 0(coverage 真在工作)')
  } catch (e) {
    fail++; console.log('  ✗ coverage 失败: ' + e.message)
  }

  console.log(`\n小结: ${pass} 通过 / ${fail} 失败`)
  try { win.destroy() } catch {}
  setImmediate(() => app.exit(fail ? 1 : 0))
})

app.on('window-all-closed', () => { /* 让我们自己控制退出 */ })
