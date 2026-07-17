// 【录制回放引擎】从 window.js 整块搬来的 9 个函数，做成 initRecorder(ctx) 工厂。
// 只搬不改函数体，行为 100% 不变。函数间互相调用（模块内互见）。
// ctx 注入 window.js 闭包与 ./recorder-core 的外部符号；sleep 本模块自定义（不从 ctx 拿）。
module.exports = function initRecorder(ctx) {
  const { S, brActive, session, log, snapshotBad, RECORDER_JS, frameFor, findElExpr, anchorExpr, coverageHits, gitChangedFiles, resolveBus, relocateSelectors, persistHeal, takeoverDigest, pageRead } = ctx
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // executeJavaScript 竞速超时:页面卡在加载态/渲染进程假死时,Electron 的 executeJavaScript 的 promise 可能【永远不 settle】——
  // waitForEl/execStep 里 while(Date.now()-t0<maxMs) 的时间检查根本轮不到,整个 skillRun 就此挂死,连回放互斥锁都不释放
  // (e2e 实测:data: 页面上直接复现,真实场景=页面假死/渲染进程卡住)。回放路径的页面求值一律走这里:
  // 超时抛错交给既有失败处理(重试/自愈/级联)。动作类(点击/提交)超时的错误文案不含 "selector not found",
  // 不会命中"未找到才重试"的条件 —— 不存在超时后盲重试导致双击/双提交。
  function evalJs(target, code, userGesture, ms) {
    return Promise.race([
      target.executeJavaScript(code, userGesture !== false),
      new Promise((_, rej) => setTimeout(() => rej(new Error('页面求值超时(' + (ms || 8000) + 'ms,页面可能卡在加载态或渲染进程假死)')), ms || 8000)),
    ])
  }
  async function injectRecorder(wc) {
    let okMain = false
    try {
      const main = wc.mainFrame
      for (const f of main.framesInSubtree) {
        try {
          await evalJs(f, RECORDER_JS + '\n;window.__bocom_rec_on=true;', true)
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
        const st = await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return 0;var rc=__el.getBoundingClientRect?__el.getBoundingClientRect():{width:1};return (!!(rc.width||rc.height)&&!__el.disabled)?2:1})()`, true)
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
      await evalJs(fr, `(()=>{
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
    // 自动续跑判定(三路,治"只认值≥4位"的老毛病 —— 滑块/扫码/点选这类【无值】验证以前只能手点「继续」):
    //  ① 值填够且稳定 1.2s(经典验证码)  ② 见过的 gate 元素消失/隐藏了(滑块拖过、弹窗关了 = 人已通过)
    //  ③ 页面跳走了(扫码登录/填完即提交)。②要求"先见过"——一开始就没有的元素不算通过,避免误判续跑。
    // ③ 只比 origin+path,不比 query/hash:SPA 在断点期间 replaceState 清个 ?from=、补个 ?redirect=,或动一下 hash,
    // 按完整 URL 比就成了"页面跳走了" → 人还没输码就续跑,下一步提交空表单(报告还显示"自动检测页面跳转",看着一切正常)。
    // 真正过关的跳转(扫码登录成功/填完即提交)都会换 path,照样认得出。
    const navKey = (s) => { try { const x = new URL(s); return x.origin + x.pathname } catch { return String(s || '') } }
    const auto = (async () => {
      let lastV = null, stableAt = 0, seen = false
      let url0 = ''; try { url0 = navKey(wc.getURL()) } catch {}
      const t0 = Date.now()
      while (!done && Date.now() - t0 < 300000) {   // 最长 5 分钟
        await sleep(500)
        let u = ''; try { u = navKey(wc.getURL()) } catch {}
        if (url0 && u && u !== url0) return { how: 'auto-nav' }   // ③ 页面跳走 = 这关过了
        let st = null
        try {
          // fill=这个元素到底【装不装得下值】(input/textarea 有 .value;富文本框 isContentEditable)。
          // 只有装得下值的才配走 ① 值稳定。以前对任意元素拿 innerText 兜底,滑块/刷脸是 div:没有 .value → 取到
          // innerText="向右滑动完成验证" —— 静态文案天生稳定 → 横幅刚弹出 ~2.7s 就自动续跑,人还没碰滑块,
          // 下一步必失败。行为类断点(滑块/人脸/扫码)本就【无值可等】,只能靠 ②元素消失 / ③页面跳走 / 人点「继续」。
          st = await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return {gone:1};
            var r=__el.getBoundingClientRect();var s=getComputedStyle(__el);
            var vis=!!(r.width||r.height)&&s.visibility!=='hidden'&&s.display!=='none';
            var ce=__el.isContentEditable===true;var hasV=__el.value!=null;
            return {gone:0,vis:vis?1:0,fill:(hasV||ce)?1:0,v:String((hasV?__el.value:(ce?__el.innerText:''))||'')}})()`, true)
        } catch {}
        if (!st) continue
        if (st.gone || !st.vis) { if (seen) return { how: 'auto-gone' }; continue }   // ② 见过又没了 = 人做完了
        seen = true
        const v = String(st.v || '')
        if (st.fill && v.trim().length >= 4) {   // ① 经典验证码:值稳定即续跑(仅限真能装值的字段)
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
        await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return 'NF';
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

  // ── 运行时人机断点探测:录制时【没有】、回放时【冒出来】的验证码/行为验证(风控偶发、二次校验)──────
  // 老行为:引擎完全不知道页面被拦了,只会「selector not found」→ 自愈→级联→早停,把"该等人 5 秒"变成"整场失败"。
  // 现在:某步找不到元素时扫一眼当前页,发现【可见且空】的验证码字段 / 可见的行为验证控件 → 停下等人,人过完关重试该步。
  // 【保守优先】只在步骤已经失败时才探(页面确实不对劲了),且只认强信号 —— 误停会卡死无人值守的批跑,比漏停更糟。
  // 故意不认"扫码/二维码"(页脚"扫码下载APP"这类横幅遍地都是,误报率高);录制时人真去点了才认(见 HUMAN_ACT_RE)。
  const LIVE_GATE_JS = `(()=>{try{
    var KW=/验证码|校验码|短信码|短信验证|动态口令|动态令牌|动态密码|图形码|图片码|安全码|captcha|verif|one-time|otp/i;
    var ACT=/滑块|滑动验证|拖动验证|行为验证|安全验证|人脸验证|刷脸/i;
    function vis(el){try{var r=el.getBoundingClientRect();if(!(r.width||r.height))return false;var s=getComputedStyle(el);
      return s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'}catch(e){return false}}
    function lab(el){var t='';try{if(el.id){var l=document.querySelector('label[for="'+el.id.replace(/"/g,'')+'"]');if(l)t+=' '+l.innerText}
      var p=el.closest&&el.closest('label');if(p)t+=' '+p.innerText}catch(e){}return t}
    function q(s){return String(s||'').replace(/"/g,'\\\\"')}
    function selOf(el){if(el.id)return '#'+el.id;if(el.name)return el.tagName.toLowerCase()+'[name="'+q(el.name)+'"]';
      if(el.placeholder)return 'input[placeholder="'+q(el.placeholder)+'"]';return ''}
    var ins=[].slice.call(document.querySelectorAll('input:not([type=hidden])'));
    for(var i=0;i<ins.length;i++){var el=ins[i];
      if(!vis(el))continue; if(String(el.value||'').trim())continue;   // 已有值 = 不用人填
      var ac=String(el.getAttribute('autocomplete')||'');
      if(/one-time-code/i.test(ac))return{found:1,hint:'验证码(one-time-code)',sel:selOf(el)};
      var hay=[el.placeholder,el.name,el.id,el.className,lab(el)].filter(Boolean).join(' ');
      var m=hay.match(KW); if(m)return{found:1,hint:m[0],sel:selOf(el)};
    }
    var all=[].slice.call(document.querySelectorAll('div,span,button,canvas')).slice(0,2500);
    for(var j=0;j<all.length;j++){var e2=all[j]; if(!vis(e2))continue;
      var cn=e2.className; cn=(cn&&cn.baseVal!==undefined)?cn.baseVal:cn;
      var h2=[cn,e2.id,(e2.innerText||'').slice(0,40),e2.getAttribute?e2.getAttribute('aria-label'):''].filter(Boolean).join(' ');
      var m2=h2.match(ACT); if(m2)return{found:1,hint:m2[0],sel:e2.id?('#'+e2.id):''};
    }
    return{found:0}}catch(e){return{found:0}}})()`
  async function detectLiveGate(wc, ev) {
    try {
      const r = await evalJs(frameFor(wc, ev), LIVE_GATE_JS, true)
      return (r && r.found) ? r : null
    } catch { return null }
  }

  // ── Phase 6·自愈回放:某步选择器全失配(页面改版/动态 id/瞬态类) → 不早停,重新定位 ──
  // 6a 确定性:靠录制的语义锚点(placeholder/label/文本)在当前页找同一元素 → 换稳定选择器重跑;
  // 6b Agent:6a 无锚点/未命中 → 采集页面可交互元素摘要 + 这步意图,经 resolveBus 交 Agent 回一个新选择器。
  // 命中即回写技能(自愈=自更新,下次直接用);无工作台/Agent/超时 → 返回 null,退回原早停逻辑。
  async function selfHeal(wc, ev, tab, i, sendProg) {
    const fr = frameFor(wc, ev)
    const tryCand = async (c, waitMs) => {
      const found = await waitForEl(fr, findElExpr(c, []), waitMs, ev.act !== 'check').catch(() => false)
      if (!found) return null
      const r = await execStep(wc, { ...ev, sel: c, selAlt: [] }, tab, { waitMs: Math.min(waitMs, 1500) })
      return r.ok ? r : null
    }
    // 6a:确定性语义重定位
    for (const c of (relocateSelectors ? relocateSelectors(ev) : [])) {
      const r = await tryCand(c, 1500)
      if (r) { log('replay self-heal 步 ' + (i + 1) + ' 确定性命中: ' + c); return { ok: true, how: 'auto', sel: c } }
    }
    // 6b:交 Agent 重定位(需 resolveBus;无工作台/不应答则超时退回)
    if (!resolveBus) return null
    let cands = ''
    try {
      cands = await evalJs(fr, `(function(){var out=[];var els=document.querySelectorAll('button,a,input,select,textarea,[role="button"],[onclick]');for(var i=0;i<els.length&&out.length<60;i++){var e=els[i];var r=e.getBoundingClientRect();if(!r.width&&!r.height)continue;var t=(e.innerText||e.value||e.placeholder||e.getAttribute&&e.getAttribute('aria-label')||'').trim().slice(0,40);var id=e.id&&!/^el-id-\\d|\\d{6,}/.test(e.id)?('#'+e.id):'';out.push(e.tagName.toLowerCase()+(id?' '+id:'')+(t?' \\''+t+'\\'':'')+(e.name?' name='+e.name:''))}return out.join('\\n')})()`, true)
    } catch {}
    const gateId = 'g' + Date.now().toString(36) + '_h' + (i + 1)
    const intent = (ev.act === 'input' ? '填写' : ev.act + ' ') + (ev.text || ev.lb || ev.ph || ev.sel || '')
    const req = { gateId, kind: 'relocate', step: i + 1, ei: i, ask: '这步找不到元素,请给一个能定位它的 CSS 选择器。意图:' + intent, sel: ev.sel || '', origAlt: (ev.selAlt || []).join(' | '), candidates: cands, url: (() => { try { return wc.getURL() } catch { return '' } })(), at: Date.now() }
    let agentOn = false
    try { resolveBus.post(req); agentOn = resolveBus.notifyAgent(req) } catch {}
    if (!agentOn) { try { resolveBus.clear(gateId) } catch {} return null }   // 没通知到 Agent 就别空等,直接退回早停
    sendProg({ pause: true, i: i + 1, hint: '定位失败,Agent 重定位中…', sel: ev.sel || '', agent: true, heal: true })
    let newSel = null
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {   // 自愈等 Agent 最长 2 分钟
      await sleep(1200)
      const res = resolveBus.check(gateId)
      if (res && typeof res.value === 'string' && res.value) { newSel = res.value.slice(0, 1000); break }
    }
    try { resolveBus.clear(gateId) } catch {}
    sendProg({ resume: true, i: i + 1 })
    if (!newSel) return null
    // 容错:LLM 常给非原生 CSS 的 :has-text("X") / :contains("X") / tag:has-text('X') → 转成本系统的 __text__:tag|X(selExpr 支持)
    const ht = newSel.match(/^\s*([a-z][\w-]*)?\s*:(?:has-text|contains)\(\s*["']?(.+?)["']?\s*\)\s*$/i)
    if (ht) newSel = '__text__:' + (ht[1] || '*').toLowerCase() + '|' + ht[2].trim()
    const r = await tryCand(newSel, 2000)
    if (r) { log('replay self-heal 步 ' + (i + 1) + ' Agent 重定位命中: ' + newSel); return { ok: true, how: 'agent', sel: newSel } }
    log('replay self-heal 步 ' + (i + 1) + ' Agent 给的选择器仍未命中: ' + newSel)
    return null
  }

  // ── 混合执行 · 噪声层①:锚点跳段(纯确定性,零 LLM)────────────────────────────
  // 元素步找不到时向前探测:若窗口内某后续步的目标【已在当前页】,说明中间那段已被页面状态满足
  // (典型:登录缓存 → 登录块整段该跳;录制里的菜单往返 → 目标页早已就位),整段跳过不计失败。
  // 只探到下一个 navigate 边界(跨页锚点无意义);navigate 步本身按"URL 路径 == 当前页"算命中。
  async function probeAnchor(wc, events, from, skipSet) {
    let curPath = ''
    try { curPath = new URL(wc.getURL()).pathname } catch {}
    const LIM = Math.min(events.length, from + 1 + 12)
    for (let j = from + 1; j < LIM; j++) {
      if (skipSet.has(j)) continue
      const e2 = events[j]; if (!e2) continue
      if (e2.act === 'navigate') {
        try { if (new URL(e2.url).pathname === curPath) return j } catch {}
        return -1   // 跨页边界:后面的元素在别的页上,当前页探不到
      }
      if (e2.human) continue   // 人机断点步(验证码)不当锚点:它属于被跳过的登录块的概率更高
      if (!e2.sel || !['click', 'input', 'select', 'check', 'submit'].includes(e2.act)) continue
      try {
        // anchorExpr 而非 findElExpr:探锚点要断言"整段可跳过",不能拿 selAlt 里的弱候选(__text__ 前缀匹配 /
        // nth-of-type 兜底)当证据 —— 撞上一个无关的"确定"按钮就会静默跳掉中间的真实业务步并报 PASS。详见 anchorExpr。
        const hit = await evalJs(frameFor(wc, e2), `(()=>{var __el=null;return !!(${anchorExpr(e2)})})()`, true)
        if (hit) return j
      } catch {}
    }
    return -1
  }

  // ── 混合执行 · 流程级接管:严格回放整段失败 → 把剩余流程交给工作台 Agent ─────────
  // Agent 拿到:技能目标/已完成/失败点/剩余步骤摘要(secret 以 type_param 指代,值由引擎持有代填),
  // 用 skill_page_read / skill_page_act 直接操作内嵌浏览器,做完调 skill_takeover_done(gateId, status)。
  // 无工作台/Agent 不应答 → 返回 null,退回原早停。上限 10 分钟;用户点「继续」= 人工确认已完成。
  async function awaitAgentTakeover(wc, tab, fromIndex, rec, paramValues, sendProg, failInfo) {
    if (!resolveBus || typeof takeoverDigest !== 'function') return null
    const digest = takeoverDigest(rec, fromIndex, failInfo)
    const gateId = 'g' + Date.now().toString(36) + '_t' + (fromIndex + 1)
    S.browser._takeover = { gateId, active: true, fromIndex, paramValues: paramValues || {}, result: null }
    // 把当前页快照(可交互元素+现成选择器)直接嵌进接管请求 —— opencode Agent 不用先花一个回合 read,上手即动
    let pageSnap = null
    try { if (typeof pageRead === 'function') pageSnap = await pageRead() } catch {}
    const req = { gateId, kind: 'takeover', step: fromIndex + 1, ...digest, url: (() => { try { return wc.getURL() } catch { return '' } })(), pageTitle: (pageSnap && pageSnap.title) || '', pageElements: (pageSnap && String(pageSnap.elements || '').slice(0, 4000)) || '', at: Date.now() }
    let agentOn = false
    try { agentOn = resolveBus.notifyAgent(req) } catch {}
    if (!agentOn) { S.browser._takeover = null; return null }
    log('replay takeover: 步 ' + (fromIndex + 1) + ' 起交给 Agent(' + gateId + ')')
    sendProg({ pause: true, takeover: true, i: fromIndex + 1, hint: 'Agent 已接管执行,过程见左侧对话', agent: true })
    let done = false
    const manual = new Promise((res) => { S.browser._replayResume = () => { if (!done) { done = true; res({ status: 'done', note: '用户确认完成' }) } } })
    const agentP = (async () => {
      const t0 = Date.now()
      while (!done && Date.now() - t0 < 600000) {   // 最长 10 分钟
        await sleep(1000)
        const t = S.browser._takeover
        if (t && t.result) return t.result
      }
      return { status: 'timeout', note: 'Agent 接管超时(10 分钟)' }
    })()
    const win = await Promise.race([manual, agentP])
    done = true
    S.browser._replayResume = null
    S.browser._takeover = null
    sendProg({ resume: true, i: fromIndex + 1 })
    log('replay takeover 结束: ' + win.status + (win.note ? ' — ' + win.note : ''))
    return win
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
          await evalJs(wc, `(()=>{try{history.pushState({},'',${JSON.stringify(ev.url)});window.dispatchEvent(new PopStateEvent('popstate'))}catch(e){}})()`, true)
          return { ok: true }
        } catch (e) { return { ok: false, err: e.message } }
      }
      try { wc.loadURL(ev.url) } catch (e) { return { ok: false, err: e.message } }
      await new Promise((res) => { const t = setTimeout(res, 12000); wc.once('did-stop-loading', () => { clearTimeout(t); res() }) })
      // 混合执行·噪声层:导航被重定向(如登录缓存 → /login 直落 /overview)要让上层知道,
      // 后续"登录页元素找不到"就能快速失败 + 锚点跳段,而不是傻等 5s 再级联早停
      let redirected = false
      try { redirected = new URL(wc.getURL()).pathname !== new URL(ev.url).pathname } catch {}
      // 首次 navigate 后,把 localStorage/sessionStorage 恢复 + reload(让页面在正确状态下重新初始化)
      if (ev._restorePreState) {
        try {
          const ls = ev._restorePreState.local || '{}'
          const ss = ev._restorePreState.session || '{}'
          await evalJs(wc, `(()=>{try{var l=JSON.parse(${JSON.stringify(ls)});Object.keys(l).forEach(k=>localStorage.setItem(k,l[k]));var s=JSON.parse(${JSON.stringify(ss)});Object.keys(s).forEach(k=>sessionStorage.setItem(k,s[k]));}catch(e){}})()`, true)
          // reload 让 SPA 在恢复后的 storage 状态下重新跑入口逻辑
          try { wc.reload() } catch {}
          await new Promise((res) => { const t = setTimeout(res, 12000); wc.once('did-stop-loading', () => { clearTimeout(t); res() }) })
        } catch (e) { log('storage restore err: ' + e.message) }
      }
      return { ok: true, redirected }
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
        const r = await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return 'NF';__el.scrollIntoView({block:'center'});__el.click();return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'input') {
      // 密码步录制时不存明文:没带运行参数就显式失败(优于静默清空密码框);登录态靠 preState 恢复兜底
      if (ev.secret && !ev.value) return { ok: false, err: 'password 步未提供运行参数(录制未存明文,请把该步设为参数或先在浏览器登录)', secret: true }
      try {
        const r = await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return 'NF';
          var v=${JSON.stringify(String(ev.value == null ? '' : ev.value))};
          if (__el.isContentEditable){__el.focus();__el.innerText=v}
          else{var p=Object.getOwnPropertyDescriptor(__el.__proto__,'value');p&&p.set?p.set.call(__el,v):(__el.value=v);}
          __el.dispatchEvent(new Event('input',{bubbles:true}));__el.dispatchEvent(new Event('change',{bubbles:true}));return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'select') {
      try {
        const r = await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return 'NF';
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
        const r = await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return 'NF';
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
        await evalJs(fr, `(()=>{var __el=null;if(${elExpr})__el.focus();})()`, true)
        wc.sendInputEvent({ type: 'keyDown', keyCode: ev.key })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ev.key })
        if (ev.key === 'Enter') {
          try { await evalJs(fr, `(()=>{var __el=null;if((${elExpr})&&__el.form){__el.form.requestSubmit?__el.form.requestSubmit():__el.form.submit()}})()`, true) } catch {}
        }
        return { ok: true }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'submit') {
      try {
        const r = await evalJs(fr, `(()=>{var __el=null;if(!(${elExpr}))return 'NF';if(__el.tagName==='FORM'){__el.requestSubmit?__el.requestSubmit():__el.submit()}else{__el.click()}return 'OK';})()`, true)
        return r === 'OK' ? { ok: true } : { ok: false, err: 'selector(+alt) not found' }
      } catch (e) { return { ok: false, err: e.message } }
    }
    if (ev.act === 'scroll') {
      try { await evalJs(wc, `window.scrollTo(${Number(ev.x) || 0}, ${Number(ev.y) || 0})`, true); return { ok: true } } catch (e) { return { ok: false, err: e.message } }
    }
    return { ok: true }
  }

  // ── 命中证据 ─────────────────────────────────────────────────────────────
  // 用 V8 PreciseCoverage 看 "agent 改过的文件里有多少函数在回放期间真被执行了"。
  // 若改的函数没被命中,大概率是改错地方(或该复现路径不覆盖此改动)→ 验证报告里报警。
  const covWc = (tab) => (tab && tab.view && !tab.view.webContents.isDestroyed()) ? tab.view.webContents : null   // 标签/视图可能已销毁(回放中途关页/切标签)→ 守卫,消 coverage 噪声报错
  async function startCoverage(tab) {
    const wc = covWc(tab); if (!tab.dbg || !wc) return false
    try {
      await wc.debugger.sendCommand('Profiler.enable')
      await wc.debugger.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
      return true
    } catch (e) { log('coverage start fail: ' + e.message); return false }
  }
  async function stopCoverage(tab) {
    const wc = covWc(tab); if (!wc) return null
    try {
      const r = await wc.debugger.sendCommand('Profiler.takePreciseCoverage')
      try { await wc.debugger.sendCommand('Profiler.stopPreciseCoverage') } catch {}
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
          const r = await evalJs(wc, `!document.querySelector(${JSON.stringify(a.value)})`, true)
          pass = !!r; detail = pass ? '✓ 已消失' : '元素仍存在'
        } else if (a.kind === 'has_element') {
          const r = await evalJs(wc, `!!document.querySelector(${JSON.stringify(a.value)})`, true)
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


  // 技能级「禁用缓存」(rec.noCache):跑前清一次 HTTP 缓存 + 回放期间每次导航前再清
  // (置 S.browser.noCache,由 browser.js 的 did-start-navigation 钩子消费 —— 复用工具栏那个 toggle 的同一条路,不另造)。
  // 为什么要包一层:回放中途抛异常也必须还原用户原本的 toggle 状态,否则"禁用缓存"会悄悄常开,之后每次导航都清缓存。
  // 注意只清 HTTP 缓存,不碰 cookie/localStorage —— 那是 preState 的活(回放前【恢复】登录态,方向相反,清了就白登了)。
  // 回放互斥:一个标签页同时只能有一场回放。两个 replayRec 并发会一起驱动 brActive() 的【同一个标签页】,
  // 互相点对方的页面 —— 而 skillRun 既开放给 UI 又开放给 MCP relay,以前谁都没拦(_batchRunning 只挡批跑对批跑)。
  // 这把锁顺带根治 noCache 的并发踩踏:prev 存的是共享全局的瞬时值,并发时 A 存 false、B 存到 A 刚写的 true →
  // A 还原 false(B 中途静默失去禁用缓存)、B 还原 true → 「禁用缓存」永久卡死为开,正是上面那段注释想避免的"悄悄常开"。
  async function replayRec(rec, opts = {}) {
    if (S.browser._replayBusy) return { ok: false, error: '已有回放在跑(同一个标签页不能同时跑两场),等它结束再发起' }
    S.browser._replayBusy = true
    try { return await replayNoCacheWrap(rec, opts) }
    finally { S.browser._replayBusy = false }
  }
  async function replayNoCacheWrap(rec, opts) {
    const on = !!(rec && rec.noCache)
    if (!on) return await replayRecInner(rec, opts)
    const prev = S.browser.noCache
    S.browser.noCache = true
    try { await session.defaultSession.clearCache(); log('replay: 技能开了「禁用缓存」→ 已清 HTTP 缓存,回放期间每次导航前再清') } catch (e) { log('clearCache err: ' + e.message) }
    try { return await replayRecInner(rec, opts) }
    finally { S.browser.noCache = prev }
  }
  // opts:{ fast, gapCap, waitMs } —— 默认值 = 原有节奏,verifyFix 无参调用零回归;
  // 技能运行传 {fast:true}(步间 gap 封顶 400ms、各固定 sleep 缩短),等待策略(waitForEl/waitNetIdle)不缩水
  async function replayRecInner(rec, opts = {}) {
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
    try { await evalJs(wc, DLG_STUB, true) } catch {}
    // 抓"修复后"状态:清空之前的报错/网络,重头开始
    tab.console = []; tab.errN = 0; tab.warnN = 0
    tab.net = []; tab.netById = new Map()
    // 启动覆盖率收集(若 CDP 调试器已挂),并收集 agent 改过的文件清单
    const changedFiles = [...new Set([...gitChangedFiles(S.settings.projectDir), ...gitChangedFiles(S.settings.backendDir)])]
    const covOn = await startCoverage(tab)
    const skipSet = new Set(Array.isArray(rec.skipSteps) ? rec.skipSteps : [])
    const stepReport = []
    // 回放进度浮层:每步推 browser-replay-progress —— 浏览器 chrome 顶带 HUD + 「录制与回放」中心实况条,双端同步
    const sendProg = (d) => { for (const w of [S.browser.win, S.skillsWin]) if (w && !w.isDestroyed()) { try { w.webContents.send('browser-replay-progress', d) } catch {} } }
    sendProg({ start: true, total: rec.events.length, title: rec.title || rec.id || '' })
    let lastT = 0
    let storageRestored = false
    let consecutiveFails = 0; let cascadeFrom = -1
    let liveGateN = 0   // 运行时人机断点触发次数(上限 3,防病态死循环)
    const healed = []   // 自愈成功的步(回放结束回写技能:selector 自更新)
    // 混合执行:运行时参数值表(applyParams 后从事件里取)——Agent 接管时引擎持值代填(type_param),secret 值不进模型
    const paramValues = {}
    for (const p of (rec.params || [])) { const e2 = rec.events[p.stepIndex]; if (e2 && e2.value != null) paramValues[p.key] = String(e2.value) }
    let redirectFast = false   // 导航被重定向(如登录缓存直落主页)→ 元素步快速失败,把时间留给锚点跳段
    let takeoverInfo = null    // 流程级接管结果 { from, status, note }
    const dlBase = Date.now()  // 下载登记基线:本次回放起点 —— 收尾时按 at≥dlBase 圈定"本次产生的下载"(见循环后采集)
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
      let liveGateInfo = null   // 本步是否被"回放时才冒出来的验证"拦过(拦到并过关 → 进 stepReport 留痕)
      // 级联收缩:已有连续失败时缩短 waitForEl,防「等5s×重试」把 3 连败早停拖到 30s+;成功即复原。
      // transient 步(日历格子点击,换月后已消失)预期找不到 → 短等 800ms,不傻等 5s
      const stepOpts = { waitMs: ev.transient ? 800 : (redirectFast ? 1200 : (consecutiveFails >= 1 ? Math.min(waitMsBase, 1500) : waitMsBase)) }
      let r = await execStep(wc, ev, tab, stepOpts)
      // 只对「元素未找到」重试一次:executeJavaScript 异常多为页面跳转中上下文销毁,
      // click/submit 是否已生效不可知,盲目重试有真实双提交风险。transient 步不重试(终值另由 input 步写)
      if (!r.ok && ev.act !== 'navigate' && !ev.transient && String(r.err || '').startsWith('selector(+alt) not found')) {
        await sleep(400)
        r = await execStep(wc, ev, tab, { waitMs: 1500 })
        r.retried = true
      }
      // 运行时人机断点:这步找不到元素,但页面上冒出了录制时没有的验证码/行为验证(风控偶发/二次校验)
      // → 停下等人过关,人过完【重试这步】继续跑。以前这里只会一路失败到早停。上限 3 次,防病态死循环。
      if (!r.ok && !ev.transient && liveGateN < 3 && String(r.err || '').startsWith('selector(+alt) not found') && ['click', 'input', 'select', 'check', 'submit'].includes(ev.act)) {
        const lg = await detectLiveGate(wc, ev)
        if (lg) {
          liveGateN++
          log('replay live-gate: 步 ' + (i + 1) + ' 前页面出现「' + lg.hint + '」(录制时没有)→ 暂停等人工')
          const how = await awaitHumanGate(wc, { act: 'input', sel: lg.sel || ev.sel, selAlt: [], human: true, humanHint: lg.hint + '(回放时出现的验证,录制时没有)' }, i, sendProg)
          r = await execStep(wc, ev, tab, { waitMs: 3000 })
          // 留痕【不看重试成没成】:以前只在 r.ok 时记,可"没人管、干等 5 分钟 timeout"恰恰是重试失败那条路 ——
          // 于是报告里那句"⚠ 有人机断点超时未处理"永远不触发,只剩一句"selector not found",
          // 只字不提引擎刚为这步等了 5 分钟人。失败的断点才是最该告诉用户的。
          liveGateInfo = { hint: lg.hint, how, ok: !!r.ok }
          if (r.ok) consecutiveFails = 0
        }
      }
      // 混合执行·噪声层①:找不到先向前探锚点 —— 若后续某步的目标已在当前页,说明中间段已被
      // 页面状态满足(登录缓存跳过登录块 / 录制里的菜单往返),整段跳过不计失败(零 LLM)
      if (!r.ok && !ev.transient && String(r.err || '').startsWith('selector(+alt) not found') && ['click', 'input', 'select', 'check', 'submit'].includes(ev.act)) {
        const j = await probeAnchor(wc, rec.events, i, skipSet)
        if (j > i) {
          for (let k = i; k < j; k++) {
            const e2 = rec.events[k]
            stepReport.push({ i: k + 1, act: e2.act, sel: e2.sel || e2.url || '', ok: true, skipped: 'state' })
            sendProg({ i: k + 1, total: rec.events.length, act: e2.act, ok: true })
          }
          log('replay skip-ahead: 步 ' + (i + 1) + '~' + j + ' 已被页面状态满足(登录缓存/菜单往返),跳到步 ' + (j + 1))
          lastT = (rec.events[j - 1] && rec.events[j - 1].t) || lastT
          consecutiveFails = 0; redirectFast = false
          i = j - 1
          continue
        }
      }
      // 自愈:重试后仍"找不到元素"的可定位步 → 语义重定位(6a)/ Agent 重定位(6b);命中即续跑并回写技能
      let healHow = null
      if (!r.ok && !ev.transient && String(r.err || '').startsWith('selector(+alt) not found') && ['click', 'input', 'select', 'check', 'submit'].includes(ev.act)) {
        const h = await selfHeal(wc, ev, tab, i, sendProg)
        if (h && h.ok) { r = { ok: true }; healHow = h.how; healed.push({ ei: i, sel: h.sel, selAlt: [] }) }
      }
      const entry = { i: i + 1, act: ev.act, sel: ev.sel || ev.url || '', ok: r.ok, err: r.err || '' }
      if (liveGateInfo) entry.liveGate = liveGateInfo   // 回放时冒出的验证:拦过就留痕(ok=过关后重试成没成)
      if (r.retried) entry.retried = true
      if (healHow) { entry.healed = healHow; entry.sel = healed[healed.length - 1].sel }
      if (r.secret) entry.secret = true
      if (ev.transient) entry.transient = true
      stepReport.push(entry)
      sendProg({ i: i + 1, total: rec.events.length, act: ev.act, ok: r.ok, err: (r.err || '').slice(0, 80) })
      if (!r.ok && ev.act === 'navigate') {
        // 混合执行:导航都到不了 → 交给 Agent 流程级接管(带技能摘要,操作内嵌浏览器完成剩余);不可用则维持早停
        const tk = await awaitAgentTakeover(wc, tab, i, rec, paramValues, sendProg, { err: r.err })
        if (tk && tk.status === 'done') {
          entry.ok = true; entry.agent = true; entry.err = ''
          for (let k = i + 1; k < rec.events.length; k++) { const e2 = rec.events[k]; stepReport.push({ i: k + 1, act: e2.act, sel: e2.sel || e2.url || '', ok: true, agent: true }) }
          takeoverInfo = { from: i + 1, status: 'done', note: tk.note || '' }
        } else if (tk) takeoverInfo = { from: i + 1, status: tk.status, note: tk.note || '' }
        break
      }
      if (r.ok && ev.act === 'navigate') {
        try { await evalJs(wc, DLG_STUB, true) } catch {}   // 整页加载清掉桩 → 重注入
        if (r.redirected) { redirectFast = true; log('replay: 导航被重定向(可能已登录/路由守卫),后续步启用快速失败+锚点跳段') }
      }
      // 级联失败检测:连续 3 个非 navigate 步失败 → 后续大概率都依赖前面失败步,提前 break 不无谓继续。
      // 密码步的显式失败不计入(登录态靠 preState 恢复兜底,不该拖垮整场验证)
      if (!r.ok && ev.act !== 'navigate') {
        if (!r.secret && !ev.transient) {   // 密码步、日历格子(transient)的失败一并豁免,不拖垮整场回放
          consecutiveFails++
          if (consecutiveFails >= 3) {
            if (cascadeFrom < 0) cascadeFrom = i + 1 - (consecutiveFails - 1)   // 第一个连续 fail 步号
            // 混合执行:级联失败不再直接早停 → 先尝试 Agent 流程级接管(从首个失败步起);不可用才早停
            const tk = await awaitAgentTakeover(wc, tab, cascadeFrom - 1, rec, paramValues, sendProg, { err: r.err })
            if (tk && tk.status === 'done') {
              for (const e of stepReport) if (e.i >= cascadeFrom && !e.ok) { e.ok = true; e.agent = true; e.err = '' }   // 级联段:目标已由 Agent 达成
              for (let k = i + 1; k < rec.events.length; k++) { const e2 = rec.events[k]; stepReport.push({ i: k + 1, act: e2.act, sel: e2.sel || e2.url || '', ok: true, agent: true }) }
              takeoverInfo = { from: cascadeFrom, status: 'done', note: tk.note || '' }
              cascadeFrom = -1   // 已被接管完成,不再当级联早停上报
            } else {
              if (tk) takeoverInfo = { from: cascadeFrom, status: tk.status, note: tk.note || '' }
              log('replay early-abort: ' + consecutiveFails + ' consecutive fails from step ' + cascadeFrom)
            }
            break
          }
        }
      } else if (r.ok) { consecutiveFails = 0; if (ev.act !== 'navigate') redirectFast = false }
      // 等网络静默(取代固定 sleep);click/submit/select/check 常触发 XHR(级联下拉靠它填下级 options),
      // navigate 后 SPA 首屏 XHR 是最大 flake 源
      if (ev.act === 'click' || ev.act === 'submit' || ev.act === 'key' || ev.act === 'select' || ev.act === 'check' || ev.act === 'navigate') await waitNetIdle(tab, 300, 3000)
      else await sleep(fast ? 50 : 120)
    }
    // 下载后编排的输入采集:回放跑完文件常常还没落地(导出是异步的)。若本次回放期间触发了下载(S.downloads 里 at≥dlBase),
    // 或技能配了「下载后编排」(必然期待一次导出)→ 等下载全部落定再收尾,把已完成的绝对路径交给上层(skillRun 据此起工作流)。
    // 纯确定性轮询,零 LLM;硬等(postWorkflow)最长 90s,自动模式(仅探到下载才等)最长 30s、4s 内无下载起头就判定"非下载技能"不空等。
    let downloads = []
    try {
      const expectDl = !!(rec.postWorkflow && rec.postWorkflow.goal)
      const mine = () => (Array.isArray(S.downloads) ? S.downloads : []).filter((d) => d && d.at >= dlBase)
      if (expectDl || mine().length) {
        const deadline = Date.now() + (expectDl ? 90000 : 30000)
        sendProg({ i: rec.events.length, total: rec.events.length, act: 'download', ok: true, waitDownload: true })
        while (Date.now() < deadline) {
          const m = mine()
          const pending = m.filter((d) => d.state === 'progressing')
          if (m.length && !pending.length) break                          // 本次下载全部落定(成功或失败)
          if (!expectDl && !m.length && Date.now() - dlBase > 4000) break  // 自动模式:4s 内没任何下载起头 → 这不是下载技能,不空等
          await sleep(800)
        }
        downloads = mine().filter((d) => d.state === 'completed').map((d) => d.savePath)
        if (downloads.length) log('replay downloads: 捕获 ' + downloads.length + ' 个下载文件(' + downloads.map((p) => String(p).split(/[\\/]/).pop()).join(', ') + ')')
        else if (expectDl) log('replay downloads: 技能配了「下载后编排」但本次未捕获到已完成的下载(导出是否成功?)')
      }
    } catch (e) { log('replay download wait err: ' + e.message) }
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
          ? await evalJs(wc, `((document.body&&document.body.innerText)||'').includes(${JSON.stringify(sv)})`, true)
          : await evalJs(wc, `!!document.querySelector(${JSON.stringify(sv)})`, true)
      } catch (e) { serr = e.message }
      successRes = { pass: !!pass, kind: rec.success.kind, value: sv, err: serr }
    }
    let dialogs = []
    try { dialogs = (await evalJs(wc, 'window.__bocom_dlgs||[]', true)) || [] } catch {}
    const cov = covOn ? await stopCoverage(tab) : null
    const hitInfo = cov ? coverageHits(cov, changedFiles) : []
    // 自愈回写:换环境(_baseSwapped)不写(DOM 可能不同);仅对有 id 的技能持久化修正后的选择器,下次直接命中
    if (healed.length && rec.id && !rec._baseSwapped && typeof persistHeal === 'function') { try { persistHeal(rec.id, healed) } catch (e) { log('persistHeal err: ' + e.message) } }
    return { ok: true, stepReport, after, changedFiles, hitInfo, covOn, cascadeFrom, totalSteps: rec.events.length, success: successRes, dialogs, baseSwapped: !!rec._baseSwapped, healed, takeover: takeoverInfo, downloads }
  }

  return { injectRecorder, waitNetIdle, waitForEl, highlightTarget, execStep, startCoverage, stopCoverage, checkAssertions, replayRec }
}
