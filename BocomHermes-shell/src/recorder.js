// 【录制回放引擎】从 window.js 整块搬来的 9 个函数，做成 initRecorder(ctx) 工厂。
// 只搬不改函数体，行为 100% 不变。函数间互相调用（模块内互见）。
// ctx 注入 window.js 闭包与 ./recorder-core 的外部符号；sleep 本模块自定义（不从 ctx 拿）。
module.exports = function initRecorder(ctx) {
  const { S, brActive, session, log, snapshotBad, RECORDER_JS, frameFor, findElExpr, coverageHits, gitChangedFiles, resolveBus } = ctx
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function injectRecorder(wc) {
    let okMain = false
    try {
      const main = wc.mainFrame
      for (const f of main.framesInSubtree) {
        try {
          await f.executeJavaScript(RECORDER_JS + '\n;window.__bocom_rec_on=true;', true)
          if (f === main) okMain = true
        } catch (e) { if (f === main) log('injectRecorder err: ' + e.message) }
      }
    } catch (e) { log('injectRecorder err: ' + e.message) }
    return okMain
  }

  // 等"网络静默":300ms 内无新请求 = 静默,最长等 maxMs
  async function waitNetIdle(tab, idleMs = 300, maxMs = 3000) {
    const t0 = Date.now()
    let lastChange = tab.net.length
    let lastSeenAt = Date.now()
    while (Date.now() - t0 < maxMs) {
      await sleep(80)
      if (tab.net.length !== lastChange) { lastChange = tab.net.length; lastSeenAt = Date.now() }
      else if (Date.now() - lastSeenAt >= idleMs) return
    }
  }
  // 等元素出现再操作 —— 取代"找不到立刻失败",慢接口/懒加载的核心解药。
  // 优先等"可交互"(有尺寸、非 disabled);但元素【存在而不可见】是样式化控件的常态
  // (Element-UI/antd 的原生 checkbox 0×0 隐藏、程序化 click 本就打得动),所以:
  // 存在但 900ms 内没显形 → 按存在放行,绝不把老引擎能成功的步变成超时失败。
  // requireVisible=false(check 步)则元素一存在就放行。
  async function waitForEl(fr, elExpr, maxMs = 5000, requireVisible = true, step = 150) {
    const t0 = Date.now()
    let existsAt = 0
    while (Date.now() - t0 < maxMs) {
      try {
        const st = await fr.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 0;var rc=__el.getBoundingClientRect?__el.getBoundingClientRect():{width:1};return (!!(rc.width||rc.height)&&!__el.disabled)?2:1})()`, true)
        if (st === 2 || (st === 1 && !requireVisible)) return true
        if (st === 1) {
          if (!existsAt) existsAt = Date.now()
          else if (Date.now() - existsAt >= 900) return true   // 存在但一直隐藏:放行交给程序化操作
        } else existsAt = 0
      } catch {}
      await sleep(step)
    }
    return false
  }
  // 回放可视化:每个 click/input/submit 前在页面里给目标元素打个红框 + 浮标"步 N",看得见在跑什么
  async function highlightTarget(fr, ev, idx) {
    if (!ev.sel || ev.act === 'navigate' || ev.act === 'scroll') return
    const elExpr = findElExpr(ev.sel, ev.selAlt)
    const label = JSON.stringify(`步 ${idx} · ${ev.act}`)
    try {
      await fr.executeJavaScript(`(()=>{
        var __el=null; if(!(${elExpr})) return;
        var rect=__el.getBoundingClientRect();
        var box=document.createElement('div'); box.id='__bocom_hi__';
        box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #ff3b30;border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,.85),0 0 14px rgba(255,59,48,.55);transition:opacity .3s';
        box.style.left=(rect.left-3)+'px'; box.style.top=(rect.top-3)+'px';
        box.style.width=(rect.width+6)+'px'; box.style.height=(rect.height+6)+'px';
        var tag=document.createElement('div'); tag.textContent=${label};
        tag.style.cssText='position:absolute;left:0;top:-22px;background:#ff3b30;color:#fff;font:600 11px system-ui;padding:2px 8px;border-radius:4px;white-space:nowrap';
        box.appendChild(tag);
        var prev=document.getElementById('__bocom_hi__'); if(prev)prev.remove();
        (document.body||document.documentElement).appendChild(box);
        setTimeout(function(){var b=document.getElementById('__bocom_hi__');if(b){b.style.opacity='0';setTimeout(function(){b&&b.remove&&b.remove()},300)}}, 700);
      })()`, true)
    } catch {}
  }
  // 解析断点(设计:docs/技能系统-意图执行与Agent解析链设计.md 第 4 节):回放到 human/resolve 步暂停,
  // 三路竞速,先到先续:
  //   ② Agent —— resolveBus 落 req + card-inject 通知工作台 Agent,Agent 用工具解出后经 skill_resolve 写回,
  //      轮询到即把值填入该步字段(原生 setter + input/change,与 input 步同款)再续跑;
  //   ③ 人·自动 —— 检测目标字段被人填入且值稳定(验证码场景,录制值已清空不照填);
  //   ③ 人·手动 —— 点 HUD 暂停横幅的「继续」。
  // 无工作台/Agent 不应答 → 链自动只剩③,技能永远跑得动。最长等 5 分钟兜底超时。
  async function awaitHumanGate(wc, ev, i, sendProg) {
    const fr = frameFor(wc, ev)
    const elExpr = findElExpr(ev.sel, ev.selAlt)
    try { await waitForEl(fr, elExpr, 5000, true) } catch {}   // 等字段出现再暂停(高亮/检测才有的放矢)
    await highlightTarget(fr, ev, i + 1)
    const gateId = 'g' + Date.now().toString(36) + '_' + (i + 1)
    let agentOn = false
    if (resolveBus) {
      const req = { gateId, step: i + 1, ei: i, ask: ev.humanHint || '需人工操作', sel: ev.sel || '', url: (() => { try { return wc.getURL() } catch { return '' } })(), at: Date.now() }
      try { resolveBus.post(req); agentOn = resolveBus.notifyAgent(req) } catch {}
    }
    sendProg({ pause: true, i: i + 1, hint: ev.humanHint || '需人工操作', sel: ev.sel || '', agent: agentOn })
    let done = false
    const manual = new Promise((res) => { S.browser._replayResume = () => { if (!done) { done = true; res({ how: 'manual' }) } } })
    const auto = (async () => {
      let lastV = null, stableAt = 0
      const t0 = Date.now()
      while (!done && Date.now() - t0 < 300000) {   // 最长 5 分钟
        await sleep(500)
        let v = ''
        try { v = await fr.executeJavaScript(`(()=>{var __el=null;return (${elExpr})?String((__el.value!=null?__el.value:__el.innerText)||''):''})()`, true) } catch {}
        if (v && v.trim().length >= 4) {   // 验证码通常 ≥4 位;滑块/无值类只能靠手动「继续」
          if (v === lastV) { if (!stableAt) stableAt = Date.now(); else if (Date.now() - stableAt >= 1200) return { how: 'auto' } }
          else { lastV = v; stableAt = 0 }
        }
      }
      return { how: 'timeout' }
    })()
    const agentP = (async () => {   // 链②:轮询 Agent 经 skill_resolve 写回的答复;无总线则永不 resolve(不影响竞速)
      if (!resolveBus) return new Promise(() => {})
      while (!done) {
        await sleep(1000)
        const r = resolveBus.check(gateId)
        if (r && typeof r.value === 'string' && r.value) return { how: 'agent', value: r.value, note: r.note || '' }
      }
      return new Promise(() => {})   // done 由别路赢下:挂起等 race 收尾,不产生结果
    })()
    const win = await Promise.race([manual, auto, agentP])
    done = true
    S.browser._replayResume = null
    if (resolveBus) { try { resolveBus.clear(gateId) } catch {} }
    // Agent 给了值 → 填入该步字段(与 execStep input 同款:原生 setter + input/change 事件)
    if (win.how === 'agent') {
      try {
        await fr.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';
          var v=${JSON.stringify(String(win.value || ''))};
          if (__el.isContentEditable){__el.focus();__el.innerText=v}
          else{var p=Object.getOwnPropertyDescriptor(__el.__proto__,'value');p&&p.set?p.set.call(__el,v):(__el.value=v);}
          __el.dispatchEvent(new Event('input',{bubbles:true}));__el.dispatchEvent(new Event('change',{bubbles:true}));return 'OK';})()`, true)
      } catch (e) { log('agent resolve 写值失败: ' + e.message) }
    }
    sendProg({ resume: true, i: i + 1 })
    log('replay 解析断点 步 ' + (i + 1) + '(' + (ev.humanHint || '') + ')续跑: ' + win.how + (win.note ? ' · ' + win.note : ''))
    return win.how
  }

  async function execStep(wc, ev, tab, opts) {
    if (ev.act === 'navigate') {
      // 事件来自页面 console 的 __BR__ 通道,被录页面可伪造 navigate 注入 file://、data: 等 —— 回放只认 http/https
      if (!/^https?:\/\//i.test(String(ev.url || ''))) return { ok: false, err: '非 http/https URL,拒绝导航: ' + String(ev.url || '').slice(0, 80) }
      const cur = wc.getURL()
      if (cur === ev.url && !ev._needRestore && !ev._restorePreState) return { ok: true }
      // SPA 路由变化:用 history.pushState + popstate,避免整页 reload 清空 SPA 状态
      if (ev.spa && !ev._restorePreState) {
        try {
          await wc.executeJavaScript(`(()=>{try{history.pushState({},'',${JSON.stringify(ev.url)});window.dispatchEvent(new PopStateEvent('popstate'))}catch(e){}})()`, true)
          return { ok: true }
        } catch (e) { return { ok: false, err: e.message } }
      }
      try { wc.loadURL(ev.url) } catch (e) { return { ok: false, err: e.message } }
      await new Promise((res) => { const t = setTimeout(res, 12000); wc.once('did-stop-loading', () => { clearTimeout(t); res() }) })
      // 首次 navigate 后,把 localStorage/sessionStorage 恢复 + reload(让页面在正确状态下重新初始化)
      if (ev._restorePreState) {
        try {
          const ls = ev._restorePreState.local || '{}'
          const ss = ev._restorePreState.session || '{}'
          await wc.executeJavaScript(`(()=>{try{var l=JSON.parse(${JSON.stringify(ls)});Object.keys(l).forEach(k=>localStorage.setItem(k,l[k]));var s=JSON.parse(${JSON.stringify(ss)});Object.keys(s).forEach(k=>sessionStorage.setItem(k,s[k]));}catch(e){}})()`, true)
          // reload 让 SPA 在恢复后的 storage 状态下重新跑入口逻辑
          try { wc.reload() } catch {}
          await new Promise((res) => { const t = setTimeout(res, 12000); wc.once('did-stop-loading', () => { clearTimeout(t); res() }) })
        } catch (e) { log('storage restore err: ' + e.message) }
      }
      return { ok: true }
    }
    const elExpr = findElExpr(ev.sel, ev.selAlt)
    const fr = frameFor(wc, ev)   // iframe 里录的步骤定位到对应子框架;主框架步骤 fr===wc
    // Codex 级健壮:元素类步骤先等目标出现,再动手(key 保持宽容:本就允许目标缺席)。
    // check 步不要求可见:样式化 checkbox 的原生 input 普遍隐藏,存在即可操作
    if (ev.act === 'click' || ev.act === 'input' || ev.act === 'select' || ev.act === 'check' || ev.act === 'submit') {
      const wms = (opts && opts.waitMs) || 5000
      const found = await waitForEl(fr, elExpr, wms, ev.act !== 'check')
      if (!found) return { ok: false, err: 'selector(+alt) not found (waited ' + wms + 'ms)' }
    }
    if (ev.act === 'click') {
      try {
        const r = await fr.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';__el.scrollIntoView({block:'center'});__el.click();return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'input') {
      // 密码步录制时不存明文:没带运行参数就显式失败(优于静默清空密码框);登录态靠 preState 恢复兜底
      if (ev.secret && !ev.value) return { ok: false, err: 'password 步未提供运行参数(录制未存明文,请把该步设为参数或先在浏览器登录)', secret: true }
      try {
        const r = await fr.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';
          var v=${JSON.stringify(String(ev.value == null ? '' : ev.value))};
          if (__el.isContentEditable){__el.focus();__el.innerText=v}
          else{var p=Object.getOwnPropertyDescriptor(__el.__proto__,'value');p&&p.set?p.set.call(__el,v):(__el.value=v);}
          __el.dispatchEvent(new Event('input',{bubbles:true}));__el.dispatchEvent(new Event('change',{bubbles:true}));return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'select') {
      try {
        const r = await fr.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';
          var v=${JSON.stringify(String(ev.value == null ? '' : ev.value))};
          var p=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
          p&&p.set?p.set.call(__el,v):(__el.value=v);
          if(__el.value!==v){
            var t=${JSON.stringify(String(ev.text || ''))};var hit=false;
            if(t){for(var i=0;i<__el.options.length;i++){if((__el.options[i].text||'').trim()===t){__el.selectedIndex=i;hit=true;break}}}
            if(!hit)return 'NV';
          }
          __el.dispatchEvent(new Event('input',{bubbles:true}));__el.dispatchEvent(new Event('change',{bubbles:true}));return 'OK';})()`, true)
        if (r === 'OK') return { ok: true }
        return { ok: false, err: r === 'NV' ? 'option value/text 未命中(参数 value 未命中选项,或环境字典差异)' : 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'check') {
      try {
        const r = await fr.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';
          var want=${ev.checked ? 'true' : 'false'};
          if(__el.checked!==want){__el.click();}
          if(__el.checked!==want){
            var p=Object.getOwnPropertyDescriptor(__el.__proto__,'checked');
            p&&p.set?p.set.call(__el,want):(__el.checked=want);
            __el.dispatchEvent(new Event('input',{bubbles:true}));__el.dispatchEvent(new Event('change',{bubbles:true}));
          }
          return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'key') {
      try {
        // 先在目标 frame 里 focus 元素,再由 webContents 发键(sendInputEvent 打到当前聚焦 frame)
        await fr.executeJavaScript(`(()=>{var __el=null;if(${elExpr})__el.focus();})()`, true)
        wc.sendInputEvent({ type: 'keyDown', keyCode: ev.key })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ev.key })
        if (ev.key === 'Enter') {
          try { await fr.executeJavaScript(`(()=>{var __el=null;if((${elExpr})&&__el.form){__el.form.requestSubmit?__el.form.requestSubmit():__el.form.submit()}})()`, true) } catch {}
        }
        return { ok: true }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'submit') {
      try {
        const r = await fr.executeJavaScript(`(()=>{var __el=null;if(!(${elExpr}))return 'NF';if(__el.tagName==='FORM'){__el.requestSubmit?__el.requestSubmit():__el.submit()}else{__el.click()}return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'scroll') {
      try { await wc.executeJavaScript(`window.scrollTo(${Number(ev.x) || 0}, ${Number(ev.y) || 0})`, true); return { ok: true } } catch (e) { return { ok: false, err: e.message } }
    }
    return { ok: true }
  }

  // ── 命中证据 ─────────────────────────────────────────────────────────────
  // 用 V8 PreciseCoverage 看 "agent 改过的文件里有多少函数在回放期间真被执行了"。
  // 若改的函数没被命中,大概率是改错地方(或该复现路径不覆盖此改动)→ 验证报告里报警。
  async function startCoverage(tab) {
    if (!tab.dbg) return false
    try {
      await tab.view.webContents.debugger.sendCommand('Profiler.enable')
      await tab.view.webContents.debugger.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
      return true
    } catch (e) { log('coverage start fail: ' + e.message); return false }
  }
  async function stopCoverage(tab) {
    try {
      const r = await tab.view.webContents.debugger.sendCommand('Profiler.takePreciseCoverage')
      try { await tab.view.webContents.debugger.sendCommand('Profiler.stopPreciseCoverage') } catch {}
      return r.result || []
    } catch (e) { log('coverage take fail: ' + e.message); return null }
  }

  // ── 断言驱动验证 ─────────────────────────────────────────────────────────
  // Agent 改完代码用 mcp 'repro_assert' 写断言到 userData/assertions/<bundleId>.json
  // 验证回放后,这里读出来逐条对照"修复后"状态打 ✓/✗
  async function checkAssertions(tab, assertions) {
    if (!assertions.length) return []
    const wc = tab.view.webContents
    const out = []
    for (const a of assertions) {
      let pass = false, detail = ''
      try {
        if (a.kind === 'no_console') {
          const v = String(a.value)
          const hit = tab.console.find((c) => c.level >= 2 && (c.message || '').includes(v))
          pass = !hit; detail = hit ? '仍出现: ' + hit.message.split('\n')[0].slice(0, 120) : '✓ 未再出现'
        } else if (a.kind === 'no_element') {
          const r = await wc.executeJavaScript(`!document.querySelector(${JSON.stringify(a.value)})`, true)
          pass = !!r; detail = pass ? '✓ 已消失' : '元素仍存在'
        } else if (a.kind === 'has_element') {
          const r = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(a.value)})`, true)
          pass = !!r; detail = pass ? '✓ 已出现' : '元素仍不存在'
        } else if (a.kind === 'no_net') {
          const v = String(a.value)
          // 既看真 4xx/5xx/failed,也看 200 业务异常
          const hit = tab.net.find((n) => (n.url || '').includes(v) && (n.state === 'failed' || (n.status >= 400) || (n.status === 200 && n._biz && n._biz.hit)))
          pass = !hit; detail = hit ? '仍异常: ' + (hit._biz ? '200·业务异常 ' + hit._biz.hint : (hit.status || hit.state)) + ' ' + hit.url : '✓ 该接口未再异常'
        }
      } catch (e) { detail = '检查时出错: ' + e.message }
      out.push({ ...a, pass, detail })
    }
    return out
  }


  // opts:{ fast, gapCap, waitMs } —— 默认值 = 原有节奏,verifyFix 无参调用零回归;
  // 技能运行传 {fast:true}(步间 gap 封顶 400ms、各固定 sleep 缩短),等待策略(waitForEl/waitNetIdle)不缩水
  async function replayRec(rec, opts = {}) {
    const fast = !!opts.fast
    const gapCap = opts.gapCap || (fast ? 400 : 2000)
    const waitMsBase = opts.waitMs || 5000
    const tab = brActive()
    if (!tab) return { ok: false, error: '没有活跃标签' }
    const wc = tab.view.webContents
    // 前置状态 restore:cookies 在 navigate 前装(请求时随发),localStorage/sessionStorage 在 load 后装 + 必要时 reload
    // 切过环境(_baseSwapped)则整体跳过:旧环境 cookie/token 灌新环境是错的
    if (rec.preState && !rec._baseSwapped) {
      try {
        for (const c of (rec.preState.cookies || [])) {
          const url = rec.startUrl
          try { await session.defaultSession.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite }) } catch {}
        }
        log('replay restored ' + (rec.preState.cookies || []).length + ' cookies')
      } catch (e) { log('cookies restore err: ' + e.message) }
    }
    // 弹窗自动应答桩:原生 confirm/alert/prompt 会同步阻塞渲染进程,无人值守回放遇「确认提交?」直接挂死。
    // confirm 恒返回 true(银行提交流程标配),应答记录随报告透出;整页 navigate 会清掉桩,导航成功后重注入
    const DLG_STUB = `;(function(){try{window.__bocom_dlgs=window.__bocom_dlgs||[];window.alert=function(m){window.__bocom_dlgs.push({k:'alert',m:String(m).slice(0,120)})};window.confirm=function(m){window.__bocom_dlgs.push({k:'confirm',m:String(m).slice(0,120)});return true};window.prompt=function(m,d){window.__bocom_dlgs.push({k:'prompt',m:String(m).slice(0,120)});return d==null?'':String(d)}}catch(e){}})()`
    try { await wc.executeJavaScript(DLG_STUB, true) } catch {}
    // 抓"修复后"状态:清空之前的报错/网络,重头开始
    tab.console = []; tab.errN = 0; tab.warnN = 0
    tab.net = []; tab.netById = new Map()
    // 启动覆盖率收集(若 CDP 调试器已挂),并收集 agent 改过的文件清单
    const changedFiles = [...new Set([...gitChangedFiles(S.settings.projectDir), ...gitChangedFiles(S.settings.backendDir)])]
    const covOn = await startCoverage(tab)
    const skipSet = new Set(Array.isArray(rec.skipSteps) ? rec.skipSteps : [])
    const stepReport = []
    // 回放进度浮层:每步推 browser-replay-progress 给 chrome 顶带 HUD(与页内红框互补:红框看"点哪",HUD 看"进到哪/卡在哪")
    const sendProg = (d) => { const w = S.browser.win; if (w && !w.isDestroyed()) w.webContents.send('browser-replay-progress', d) }
    sendProg({ start: true, total: rec.events.length, title: rec.title || rec.id || '' })
    let lastT = 0
    let storageRestored = false
    let consecutiveFails = 0; let cascadeFrom = -1
    for (let i = 0; i < rec.events.length; i++) {
      const ev = rec.events[i]
      // 跳过步(如滚动噪声)必须推占位条目并更新 lastT —— diffReport/verifyFix/skillRun 全按 stepReport 长度对齐计数
      if (skipSet.has(i)) { stepReport.push({ i: i + 1, act: ev.act, sel: '', ok: true, skipped: true }); lastT = ev.t || 0; sendProg({ i: i + 1, total: rec.events.length, act: ev.act, ok: true }); continue }
      if (!storageRestored && ev.act === 'navigate' && rec.preState && !rec._baseSwapped && (rec.preState.local !== '{}' || rec.preState.session !== '{}')) {
        ev._restorePreState = rec.preState; storageRestored = true
      }
      const gap = Math.min(Math.max(0, (ev.t || 0) - lastT), gapCap)   // 步间 sleep 封顶(fast 模式 400ms)
      if (gap > 50) await sleep(gap)
      lastT = ev.t || 0
      // 人机断点(验证码/滑块/动态令牌):暂停等人现场输入,不照填录制值(已清空),续跑后走下一步
      if (ev.human) {
        const how = await awaitHumanGate(wc, ev, i, sendProg)
        stepReport.push({ i: i + 1, act: ev.act, sel: ev.sel || '', ok: true, human: true, how })
        sendProg({ i: i + 1, total: rec.events.length, act: ev.act, ok: true })
        consecutiveFails = 0
        await waitNetIdle(tab, 300, 3000)
        continue
      }
      await highlightTarget(frameFor(wc, ev), ev, i + 1)   // 红框打在事件所属 frame(含 iframe)
      await sleep(fast ? 60 : 180)
      // 级联收缩:已有连续失败时缩短 waitForEl,防「等5s×重试」把 3 连败早停拖到 30s+;成功即复原。
      // transient 步(日历格子点击,换月后已消失)预期找不到 → 短等 800ms,不傻等 5s
      const stepOpts = { waitMs: ev.transient ? 800 : (consecutiveFails >= 1 ? Math.min(waitMsBase, 1500) : waitMsBase) }
      let r = await execStep(wc, ev, tab, stepOpts)
      // 只对「元素未找到」重试一次:executeJavaScript 异常多为页面跳转中上下文销毁,
      // click/submit 是否已生效不可知,盲目重试有真实双提交风险。transient 步不重试(终值另由 input 步写)
      if (!r.ok && ev.act !== 'navigate' && !ev.transient && String(r.err || '').startsWith('selector(+alt) not found')) {
        await sleep(400)
        r = await execStep(wc, ev, tab, { waitMs: 1500 })
        r.retried = true
      }
      const entry = { i: i + 1, act: ev.act, sel: ev.sel || ev.url || '', ok: r.ok, err: r.err || '' }
      if (r.retried) entry.retried = true
      if (r.secret) entry.secret = true
      if (ev.transient) entry.transient = true
      stepReport.push(entry)
      sendProg({ i: i + 1, total: rec.events.length, act: ev.act, ok: r.ok, err: (r.err || '').slice(0, 80) })
      if (!r.ok && ev.act === 'navigate') break
      if (r.ok && ev.act === 'navigate') { try { await wc.executeJavaScript(DLG_STUB, true) } catch {} }   // 整页加载清掉桩 → 重注入
      // 级联失败检测:连续 3 个非 navigate 步失败 → 后续大概率都依赖前面失败步,提前 break 不无谓继续。
      // 密码步的显式失败不计入(登录态靠 preState 恢复兜底,不该拖垮整场验证)
      if (!r.ok && ev.act !== 'navigate') {
        if (!r.secret && !ev.transient) {   // 密码步、日历格子(transient)的失败一并豁免,不拖垮整场回放
          consecutiveFails++
          if (consecutiveFails >= 3) {
            if (cascadeFrom < 0) cascadeFrom = i + 1 - (consecutiveFails - 1)   // 第一个连续 fail 步号
            log('replay early-abort: ' + consecutiveFails + ' consecutive fails from step ' + cascadeFrom)
            break
          }
        }
      } else if (r.ok) consecutiveFails = 0
      // 等网络静默(取代固定 sleep);click/submit/select/check 常触发 XHR(级联下拉靠它填下级 options),
      // navigate 后 SPA 首屏 XHR 是最大 flake 源
      if (ev.act === 'click' || ev.act === 'submit' || ev.act === 'key' || ev.act === 'select' || ev.act === 'check' || ev.act === 'navigate') await waitNetIdle(tab, 300, 3000)
      else await sleep(fast ? 50 : 120)
    }
    sendProg({ done: true, fails: stepReport.filter((s) => !s.ok).length, total: stepReport.length })
    await sleep(fast ? 600 : 1800)    // 播完再等异步报错/请求浮现
    const after = {
      errs: tab.console.filter((c) => c.level >= 2).map((c) => ({ level: c.level, msg: (c.message || '').split('\n')[0].slice(0, 200) })),
      bad: await snapshotBad(tab),   // 含 200 业务异常
      url: tab.url || '',
    }
    // 技能自带成功断言(保存时可选填):跑完检查一次;只写进结果,verify 判定不消费(opt-in 语义)
    let successRes = null
    if (rec.success && rec.success.value) {
      const sv = String(rec.success.value)
      let pass = false, serr = ''
      try {
        pass = rec.success.kind === 'text'
          ? await wc.executeJavaScript(`((document.body&&document.body.innerText)||'').includes(${JSON.stringify(sv)})`, true)
          : await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(sv)})`, true)
      } catch (e) { serr = e.message }
      successRes = { pass: !!pass, kind: rec.success.kind, value: sv, err: serr }
    }
    let dialogs = []
    try { dialogs = (await wc.executeJavaScript('window.__bocom_dlgs||[]', true)) || [] } catch {}
    const cov = covOn ? await stopCoverage(tab) : null
    const hitInfo = cov ? coverageHits(cov, changedFiles) : []
    return { ok: true, stepReport, after, changedFiles, hitInfo, covOn, cascadeFrom, totalSteps: rec.events.length, success: successRes, dialogs, baseSwapped: !!rec._baseSwapped }
  }

  return { injectRecorder, waitNetIdle, waitForEl, highlightTarget, execStep, startCoverage, stopCoverage, checkAssertions, replayRec }
}
