// 【内嵌浏览器核心】多标签 + 设备模拟 + CDP 控制台/网络面板 + 整页截图 + 元素拾取 + 浏览器/调试工作台窗口工厂。
// 从 window.js 整块搬来(原行 494-513 / 520-1034 / 1527-1556 / 1560-1603),做成 initBrowser(ctx) 工厂。
// 注意:非纯搬运——搬迁中顺带修 8 处(代码内以 #编号 标注),其余逻辑不变:
//   #1 createWorkspace 关窗清理对齐 spawnCard(退休孤儿 serve/清忙态/删 cardDir·modelByWc)、#2 网络记录加 tWall 墙钟、
//   #3 sendNetSnapshot 只刷活动标签、#6 brSendNav 用显式 deviceKey、#7 XHR json/document 响应体、
//   #8 渲染侧 netMap 裁剪(在 ui/browser.html)、#9 fetch 流式读取、#11 did-finish-load 重施缩放。
// ctx 注入:S / electron(session/app/BrowserWindow/WebContentsView)/ node(path/fs)/ log / oc,
//   + cdp-format 纯函数(cdpConsoleLevel/fmtRO/fmtException),
//   + window.js 内后定义但已提升的 function:forgetBusy / wireRecToTab / brSendRecCount(按引用注入,构造期不调用故无环)。
// 对外回传 19 个被 window.js 的浏览器 IPC / 调试层 / 录制层 / 托盘 / initWindow 返回值用到的函数。
// 时序:initBrowser 必须在 initRecorder(window.js)之前构造——后者构造时即读取返回的 brActive(const,非提升)。
// 放置约束:本文件必须在 src/ 下与 window.js 同目录,__dirname 才与原来一致(loadFile 路径不变)。
'use strict'
module.exports = function initBrowser(ctx) {
  const { S, session, log, path, fs, app, BrowserWindow, WebContentsView, oc, forgetBusy, wireRecToTab, brSendRecCount, cdpConsoleLevel, fmtRO, fmtException } = ctx
  const BR_TOP_H = 82   // 标签栏 38 + 工具栏 44
  const BR_SKILLBAR_H = 52   // 工作台底部技能控制条高度(录制/技能库/运行 + 实况)
  const SPLIT_GUTTER = 6   // 工作台模式左右分隔条宽度
  const BR_DEVICES = {
    desktop: { label: '桌面',      w: 0,   h: 0,    dpr: 0, touch: false },
    mobile:  { label: '手机 390',  w: 390, h: 844,  dpr: 3, touch: true  },
    tablet:  { label: '平板 834',  w: 834, h: 1112, dpr: 2, touch: true  },
  }

  // ── 宿主层(波7 · 内嵌浏览器真重构)───────────────────────────────────────────────
  // 两种宿主:standalone=独立工作台窗(b.win 是 BrowserWindow);shellHost=主窗口嵌入(b.win=S.mainWin,
  // chrome 是挂在主窗上的 WebContentsView)。所有视图挂接/消息经这两个访问器,下文不再直接碰 b.win。
  const hostWin = () => (S.browser.shellHost && S.mainWin && !S.mainWin.isDestroyed()) ? S.mainWin : S.browser.win
  const chromeWc = () => S.browser.shellHost
    ? (S.browser.chromeView && !S.browser.chromeView.webContents.isDestroyed() ? S.browser.chromeView.webContents : null)
    : (S.browser.win && !S.browser.win.isDestroyed() ? S.browser.win.webContents : null)
  function chromeSend(ch, payload) {
    try {
      const wc = chromeWc()
      if (wc && !wc.isDestroyed()) wc.send(ch, payload)
    } catch {}
  }
  // 浏览器页面区(原点+尺寸):standalone=窗口内容区(0,0 起);shellHost=主窗内容区(228 侧栏右/38 标题栏下/28 状态栏上)
  // 主窗内容区左边留给对话的宽度(px)。0 = 老行为:浏览器铺满内容区、与对话互斥(切过去就看不见对话)。
  // ★同屏(2026-08-10 用户要的"单会话与内嵌浏览器整合"):浏览器只占右半,左边继续显对话 ——
  //   一边聊一边看它点页面,验证的过程和结论在同一块屏幕上。
  //   只加一个减数,不动其余布局:标签栏/控制台/设备模拟/拖动分离那些几何全部按 rg 算,自动跟着缩。
  const num = (v, d) => { const n = +v; return Number.isFinite(n) ? n : d }
  // 几何抽在 src/browser-split.js(纯函数,无 Electron 依赖):本文件是 initBrowser(ctx) 工厂,
  // 要 Electron 才装载得起来,埋在里面的边界条件就没法单测。见 npm run split:test。
  const { splitChatW: calcChatW, SIDE_DEFAULT } = require('./browser-split')
  // 侧栏宽度是【可拖的】,而这里原来写死 228 —— 拖过侧栏之后浏览器视图就整体错位(既有 bug,顺带修)。
  // 渲染端拖完会把真值报上来;没报过就回落 228(老默认)。
  const sideW = () => Math.round(num(S.browser.sideW, SIDE_DEFAULT))
  const splitChatW = (cw) => calcChatW(cw, S.browser.chatW, sideW())
  function layoutRegion() {
    if (S.browser.shellHost && S.mainWin && !S.mainWin.isDestroyed()) {
      const [cw, ch] = S.mainWin.getContentSize()
      const sw = sideW(), chatW = splitChatW(cw)
      return { x: sw + chatW, y: 38, w: Math.max(0, cw - sw - chatW), h: Math.max(0, ch - 38 - 28) }
    }
    const w = S.browser.win
    if (w && !w.isDestroyed()) { const [cw, ch] = w.getContentSize(); return { x: 0, y: 0, w: cw, h: ch } }
    return null
  }

  function normalizeUrl(url) {
    url = String(url || '').trim()
    if (!url) return ''
    if (url === 'about:blank' || url.startsWith('file://') || url.startsWith('about:')) return url
    if (/^https?:\/\//i.test(url)) return url
    if (/^localhost(:\d+)?(\/|$)/i.test(url) || /^127\.|^192\.168\.|^10\.\d|^172\.(1[6-9]|2\d|3[01])\./.test(url)) return 'http://' + url
    // 含空格或无点号 → 当作搜索（内网无搜索引擎时仍按 URL 处理）
    if (/\s/.test(url) || !/\./.test(url)) return 'http://' + url
    return 'http://' + url
  }

  const brActive = () => S.browser.tabs.find(t => t.id === S.browser.activeId) || null

  function brLayout() {
    const b = S.browser
    const rg = layoutRegion(); if (!rg) return
    if (b.shellHost && !b.shellVisible) {   // 宿主模式且视图被切走:全部压 0 高度(页面 JS 照跑,回来原样)
      if (b.chromeView) { try { b.chromeView.setBounds({ x: rg.x, y: rg.y, width: rg.w, height: 0 }) } catch {} }
      if (b.cardView) { try { b.cardView.setBounds({ x: rg.x, y: rg.y, width: rg.w, height: 0 }) } catch {} }
      const t = brActive(); if (t) { try { t.view.setBounds({ x: rg.x, y: rg.y, width: rg.w, height: 0 }) } catch {} }
      return
    }
    if (b.chromeView) { try { b.chromeView.setBounds({ x: rg.x, y: rg.y, width: rg.w, height: rg.h }) } catch {} }
    const cw = rg.w, ch = rg.h
    const leftW = b.leftW || 0                 // 工作台模式:左侧 Agent 会话占的宽度
    const G = leftW ? SPLIT_GUTTER : 0
    const skillH = b.mode === 'workspace' ? BR_SKILLBAR_H : 0   // 工作台底部技能控制条(HTML chrome 层)—— 原生视图给它让出高度
    if (b.cardView && !b._dragging) { try { b.cardView.setBounds({ x: rg.x, y: rg.y, width: Math.max(0, leftW), height: Math.max(0, ch - skillH) }) } catch {} }
    const tab = brActive(); if (!tab) return
    if (b._dragging) return                     // 拖动分隔条时内容视图临时分离,跳过布局
    const rx = rg.x + leftW + G                  // 右侧浏览器内容区左边界
    // ⋯ 更多菜单 / 设置抽屉 / 通用 chrome 浮层(技能库/验证卡)打开 → 网页层从右让出一条,否则原生层会盖住 HTML 浮层
    const menuW = Math.max(b.settingsOpen ? 360 : 0, b.menuOpen ? 248 : 0, b.chromeOverlayW | 0)
    const rw = Math.max(0, cw - leftW - G - menuW)
    const areaH = Math.max(0, ch - BR_TOP_H - b.consoleH - skillH)
    // 模态卡(保存技能/填参数)打开 → 页面视图高度压 0 整体让位(页面 JS 仍在跑),关闭时恢复
    if (b.modalOpen) { tab.view.setBounds({ x: rx, y: rg.y + BR_TOP_H, width: rw, height: 0 }); return }
    const d = tab.device
    if (d && d.w) {
      const dw = Math.min(d.w, rw)
      const dh = d.h ? Math.min(d.h, areaH) : areaH
      tab.view.setBounds({ x: rx + Math.round((rw - dw) / 2), y: rg.y + BR_TOP_H, width: dw, height: dh })
    } else {
      tab.view.setBounds({ x: rx, y: rg.y + BR_TOP_H, width: rw, height: areaH })
    }
  }

  function brSendTabs() {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    chromeSend('browser-tabs', {
      tabs: b.tabs.map(t => ({ id: t.id, title: t.title, loading: t.loading, favicon: t.favicon || '' })),
      activeId: b.activeId,
    })
  }

  function brSendNav(tab) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed() || tab.id !== b.activeId) return
    const dkey = tab.deviceKey || 'desktop'   // #6 用显式 key,不再靠对象身份反查(brRotateDevice 克隆后会失配 → 误报 desktop)
    chromeSend('browser-nav', {
      url: tab.view.webContents.getURL(),
      canBack: tab.view.webContents.canGoBack(),
      canForward: tab.view.webContents.canGoForward(),
      loading: tab.loading,
      zoom: Math.round((tab.zoom || 1) * 100),
      device: dkey,
      errN: tab.errN, warnN: tab.warnN,
    })
  }

  // 把 Electron 的 level（数字或字符串）归一化为 0=log 1=info 2=warn 3=error
  function brNormLevel(lvl) {
    if (typeof lvl === 'number') return lvl
    const m = { verbose: 0, debug: 0, log: 0, info: 1, warning: 2, warn: 2, error: 3 }
    return m[String(lvl).toLowerCase()] ?? 1
  }

  // 页面级捕获:解决 CDP getResponseBody 拿不到响应体(已 GC / 流式 / 跨进程)+ 弹窗/错误模态没采集
  // 思路:在每次页面 dom-ready 时注入一段 wrapper,接管 fetch/XHR + alert/confirm/prompt,
  // 数据存 window.__BR_CAP_* 数组;compactRepro 用 executeJavaScript 拉。
  // 不依赖 CDP,内网常见 banking 框架(antd/iView/自家 modal)弹窗/接口异常都覆盖。
  const CAPTURE_JS = `;(function(){
    if (window.__bocom_cap_init) return; window.__bocom_cap_init = true;
    window.__BR_CAP_NET = []; window.__BR_CAP_DIALOG = []; window.__BR_CAP_ERRMODAL = [];
    var clip = function(s, n){ s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; };
    var nowT = function(){ return Date.now(); };
    // ── fetch 包装 ──
    if (window.fetch) {
      var _fetch = window.fetch;
      window.fetch = function(input, init){
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = (init && init.method) || (input && input.method) || 'GET';
        var reqBody = '';
        try { if (init && init.body) reqBody = typeof init.body === 'string' ? init.body : (init.body && init.body.toString ? init.body.toString() : ''); } catch(_){}
        var t0 = nowT();
        return _fetch.apply(this, arguments).then(function(resp){
          try {
            var clone = resp.clone();
            var pushBody = function(body){
              window.__BR_CAP_NET.push({ src:'fetch', method:method.toUpperCase(), url:String(url), status:resp.status, reqBody:clip(reqBody,4000), respBody:clip(body,4000), t:t0, ms:nowT()-t0 });
              if (window.__BR_CAP_NET.length > 200) window.__BR_CAP_NET.shift();
            };
            // #9 只流式读取前 ~4000 字后 cancel:避免把几十 MB 响应体整体解码进内存(clip 只保留 4000 字),顺带修永不 resolve 的无界流式响应
            if (clone.body && clone.body.getReader) {
              var reader = clone.body.getReader(), dec = new TextDecoder(), acc = '', fin = false;
              var done = function(){ if (fin) return; fin = true; try { acc += dec.decode(); } catch(_){} pushBody(acc); };   // 收尾 flush:补齐截断边界处残留的多字节 UTF-8
              var pump = function(){
                return reader.read().then(function(r){
                  if (r.done) { done(); return; }
                  try { acc += dec.decode(r.value, { stream: true }); } catch(_){}
                  if (acc.length >= 4000) { try { reader.cancel(); } catch(_){} done(); return; }
                  return pump();
                }).catch(function(){ done(); });
              };
              pump();
            } else {
              clone.text().then(function(body){ pushBody(body); }).catch(function(){});
            }
          } catch(_){}
          return resp;
        }).catch(function(e){
          window.__BR_CAP_NET.push({ src:'fetch', method:method.toUpperCase(), url:String(url), status:0, reqBody:clip(reqBody,4000), respBody:'(fetch error: '+(e && e.message || e)+')', t:t0, ms:nowT()-t0, error:true });
          throw e;
        });
      };
    }
    // ── XMLHttpRequest 包装 ──
    if (window.XMLHttpRequest) {
      var XO = window.XMLHttpRequest.prototype.open;
      var XS = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.open = function(m, u){ this.__br_m = String(m||'GET').toUpperCase(); this.__br_u = String(u||''); return XO.apply(this, arguments); };
      window.XMLHttpRequest.prototype.send = function(body){
        var xhr = this; var t0 = nowT();
        var reqBody = ''; try { reqBody = typeof body === 'string' ? body : (body && body.toString ? body.toString() : ''); } catch(_){}
        var onDone = function(){
          // #7 responseType 为 json/document 时,响应体可从 xhr.response 同步取(读 responseText 会抛),别再存占位符
          var respBody = ''; try { var _rt = xhr.responseType;
            if (_rt === '' || _rt === 'text') respBody = String(xhr.responseText || '');
            else if (_rt === 'json') respBody = JSON.stringify(xhr.response);
            else if (_rt === 'document' && xhr.response) respBody = String(xhr.response.documentElement ? xhr.response.documentElement.outerHTML : xhr.response);
            else respBody = '(' + (_rt || 'binary') + ')';
          } catch(_){}
          window.__BR_CAP_NET.push({ src:'xhr', method:xhr.__br_m||'GET', url:xhr.__br_u||'', status:xhr.status||0, reqBody:clip(reqBody,4000), respBody:clip(respBody,4000), t:t0, ms:nowT()-t0 });
          if (window.__BR_CAP_NET.length > 200) window.__BR_CAP_NET.shift();
        };
        xhr.addEventListener('loadend', onDone);
        return XS.apply(this, arguments);
      };
    }
    // ── alert/confirm/prompt 包装 ──
    ['alert','confirm','prompt'].forEach(function(k){
      var _orig = window[k]; if (typeof _orig !== 'function') return;
      window[k] = function(msg){
        try { window.__BR_CAP_DIALOG.push({ kind:k, text:clip(msg, 500), t:nowT() }); if (window.__BR_CAP_DIALOG.length > 60) window.__BR_CAP_DIALOG.shift(); } catch(_){}
        return _orig.apply(this, arguments);
      };
    });
    // ── 错误模态/Toast 自动探测 ── MutationObserver 找新增的"错误样态"节点
    var ERR_RE = /(error|fail|err|danger|warning|toast)/i;
    var TXT_RE = /(错误|失败|异常|警告|流水号|交易号|tradeNo|transactionId|requestId|serial)/i;
    try {
      var seen = 0;
      var mo = new MutationObserver(function(muts){
        for (var i=0;i<muts.length;i++) {
          for (var j=0;j<muts[i].addedNodes.length;j++) {
            var n = muts[i].addedNodes[j]; if (!n || n.nodeType !== 1) continue;
            var cls = (n.className && typeof n.className === 'string') ? n.className : '';
            var txt = (n.innerText || n.textContent || '').trim();
            if ((cls && ERR_RE.test(cls)) || (txt && TXT_RE.test(txt) && txt.length < 500)) {
              if (seen > 100) return;
              seen++;
              window.__BR_CAP_ERRMODAL.push({ cls:clip(cls, 120), text:clip(txt, 400), t:nowT() });
            }
          }
        }
      });
      var startMO = function(){ if (document.body) mo.observe(document.body, { childList:true, subtree:true }); };
      if (document.body) startMO(); else document.addEventListener('DOMContentLoaded', startMO);
    } catch(_){}
  })();`

  // ── 下载留痕 ──────────────────────────────────────────────────────────────
  // 【为什么要有】业务系统满屏"导出"。点完之后 Agent 只知道"点了",不知道下载成没成、
  // 文件落在哪、多大 —— 于是"导出功能正常"这句话没有任何证据支撑(这正是本仓最反对的那种断言)。
  // Electron 的 will-download 能把这件事变成事实:文件名/路径/字节数/成功与否,逐条记在标签页上。
  // 记在【标签页】上而不是全局:Agent 会话只该看见自己那张标签页下载了什么。
  function wireDownloads(tab) {
    const wc = tab.view.webContents
    let ses = null
    try { ses = wc.session } catch { return }
    if (!ses || ses.__bhDlWired) return
    ses.__bhDlWired = true
    ses.on('will-download', (_e, item, fromWc) => {
      const t = (S.browser.tabs || []).find((x) => { try { return x.view.webContents === fromWc } catch { return false } })
      const rec = { name: item.getFilename(), url: String(item.getURL() || '').slice(0, 300), bytes: 0, state: 'progressing', path: '', at: Date.now() }
      if (t) { t.downloads = t.downloads || []; t.downloads.push(rec); if (t.downloads.length > 50) t.downloads.shift() }
      item.on('done', (_e2, state) => {
        rec.state = String(state)
        try { rec.path = item.getSavePath() || '' } catch {}
        try { rec.bytes = item.getReceivedBytes() || 0 } catch {}
        log('[download] ' + rec.name + ' → ' + rec.state + ' ' + rec.bytes + 'B ' + rec.path)
      })
    })
  }

  function brWireTab(tab) {
    const wc = tab.view.webContents
    const b = S.browser
    wireDownloads(tab)
    // 每次 dom-ready 都重注入(防 SPA 内导航后丢失);__bocom_cap_init 防重
    wc.on('dom-ready', () => { wc.executeJavaScript(CAPTURE_JS, true).catch(() => {}) })
    const onNav = () => {
      tab.title = wc.getTitle() || tab.title
      tab.url = wc.getURL()
      // 记 URL 历史(URL 栏 datalist 用):去重,最新在前,内存上限 200
      if (tab.url && /^https?:/i.test(tab.url)) {
        const h = S.browser.history = S.browser.history || []
        const i = h.indexOf(tab.url); if (i >= 0) h.splice(i, 1)
        h.unshift(tab.url); if (h.length > 200) h.length = 200
      }
      brSendTabs(); brSendNav(tab)
    }
    wc.on('did-navigate', onNav)
    wc.on('did-navigate-in-page', onNav)
    wc.on('page-title-updated', () => { tab.title = wc.getTitle(); brSendTabs(); brSendNav(tab) })
    wc.on('did-start-loading', () => { tab.loading = true; brSendTabs(); brSendNav(tab) })
    wc.on('did-stop-loading', () => { tab.loading = false; brSendTabs(); brSendNav(tab) })
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons && icons[0] || ''; brSendTabs() })
    // #11 跨域导航时 Chromium 会把缩放重置为目标 origin 的默认值 → 页面与工具栏的 % 失同步。
    // 以 tab.zoom 为准,导航加载完成后重新施加,保证「工具栏显示的倍率 = 页面实际倍率」且缩放步进不从陈旧基准跳。
    wc.on('did-finish-load', () => { try { wc.setZoomFactor(tab.zoom || 1) } catch {} })   // 无条件以 tab.zoom 为准:Chromium 会按 origin 记忆缩放,只在 !=1 时重应用会漏掉"目标 origin 记忆了非 1 缩放"的情况
    wc.on('found-in-page', (_e, r) => {
      if (tab.id === b.activeId && b.win && !b.win.isDestroyed())
        chromeSend('browser-find-result', { active: r.activeMatchOrdinal, matches: r.matches })
    })
    wc.setWindowOpenHandler(({ url }) => { newTab(url); return { action: 'deny' } })

    // 主框架导航开始 → 清空网络记录（除非用户开了「保留日志」），对齐 DevTools 默认行为
    wc.on('did-start-navigation', (_e, navUrl, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && S.browser.noCache) {   // 禁用缓存 toggle 开 → 每次导航前清一次
        try { session.defaultSession.clearCache() } catch {}
      }
      if (isMainFrame && !isInPlace && !tab.preserveNet) {   // 对齐 DevTools：导航即清空网络 + 控制台（除非「保留日志」）
        tab.net = []; tab.netById = new Map()
        tab.console = []; tab.errN = 0; tab.warnN = 0
        if (tab.id === b.activeId && b.win && !b.win.isDestroyed()) {
          sendNetSnapshot(tab)
          chromeSend('browser-console-snapshot', { entries: [], errN: 0, warnN: 0 })
          chromeSend('browser-badge', { errN: 0, warnN: 0 })
        }
      }
    })

    // 控制台降级路径：附上 CDP 调试器后由 Runtime.consoleAPICalled 接管（更丰富），这里仅在无调试器时兜底
    wc.on('console-message', (...args) => {
      if (tab.dbg) return
      let level, message, line, source
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const d = args[0]; level = brNormLevel(d.level); message = d.message; line = d.lineNumber; source = d.sourceId
      } else {
        level = brNormLevel(args[1]); message = args[2]; line = args[3]; source = args[4]
      }
      pushConsole(tab, { level, message, line, source })
    })

    // 页面焦点下的浏览器级快捷键
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      const mod = input.control || input.meta
      if (!mod) return
      const k = (input.key || '').toLowerCase()
      const handle = (fn) => { e.preventDefault(); fn() }
      if (k === 't') handle(() => newTab(''))
      else if (k === 'w') handle(() => closeTab(b.activeId))
      else if (k === 'r') handle(() => wc.reload())
      else if (k === 'l') handle(() => chromeSend('browser-focus-url'))
      else if (k === 'f') handle(() => chromeSend('browser-open-find'))
      else if (k === '=' || k === '+') handle(() => brZoom('in'))
      else if (k === '-') handle(() => brZoom('out'))
      else if (k === '0') handle(() => brZoom('reset'))
    })
  }

  // ── 网络面板（CDP Network 域：逐 tab 抓请求/响应/时序）──────────────────────
  const MAX_NET = 600
  const slimRec = (r) => ({ id: r.id, url: r.url, method: r.method, type: r.type, status: r.status, statusText: r.statusText, mime: r.mime, size: r.size, ms: Math.round(r.ms), state: r.state, fromCache: r.fromCache, remoteIP: r.remoteIP || '', failText: r.failText || '' })
  function netSend(tab, kind, rec) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed() || tab.id !== b.activeId) return
    chromeSend('browser-net-add', { kind, rec: slimRec(rec) })
  }
  function sendNetSnapshot(tab) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed() || tab.id !== b.activeId) return   // #3 只刷当前活动标签,防后台标签(如关其 DevTools)覆盖面板
    chromeSend('browser-net-snapshot', { items: tab.net.map(slimRec) })
  }
  // ── 富控制台：把 CDP RemoteObject 格式化成可读文本（对象/数组预览 + 异常堆栈）──
  // 控制台格式化（cdpConsoleLevel/fmtRO/fmtException）搬进 ./cdp-format 纯函数模块,见文件顶部 require。
  // 统一的控制台落库 + 推送（console-message 降级路径与 CDP 富路径共用）
  function pushConsole(tab, entry) {
    // __BR__ 标记 = 录制注入脚本发来的事件,截留入 recording 队列,不进用户控制台
    const m = String(entry.message || '')
    if (m.startsWith('__BR__')) {
      try {
        const ev = JSON.parse(m.slice(6))
        // 健康自检 ping:只置连通标志,不进事件队列
        if (ev.act === '__ping__') { if (S.browser.rec) S.browser.rec._pingOk = true; return }
        if (S.browser.rec && S.browser.rec.active && S.browser.rec.tabIds && S.browser.rec.tabIds.has(tab.id)) {   // 放行本次录制纳入的所有 tab(含新开的)
          // 用主进程时间戳代替页面时钟,避免页面 Date.now 被 mock 时漂移
          ev.t = Date.now() - S.browser.rec.startedAt
          S.browser.rec.events.push(ev)
          brSendRecCount()   // 「● 已录 N 步」实时徽标
        }
      } catch {}
      return
    }
    entry.ts = Date.now()
    entry.message = String(entry.message == null ? '' : entry.message).slice(0, 8000)
    entry.line = entry.line || 0; entry.source = entry.source || ''
    tab.console.push(entry)
    if (tab.console.length > 600) tab.console.shift()
    if (entry.level === 3) tab.errN++; else if (entry.level === 2) tab.warnN++
    const b = S.browser
    if (tab.id === b.activeId && b.win && !b.win.isDestroyed()) {
      chromeSend('browser-console-add', entry)
      chromeSend('browser-badge', { errN: tab.errN, warnN: tab.warnN })
    }
  }

  function onCdp(tab, method, p) {
    if (method === 'Network.requestWillBeSent') {
      const url = (p.request && p.request.url) || ''
      if (!url || url.startsWith('data:')) return
      let rec = tab.netById.get(p.requestId)
      if (rec) { rec.url = url; rec.method = p.request.method; rec.t0 = p.timestamp; rec.state = 'pending' }   // 重定向沿用同一 requestId
      else {
        rec = { id: p.requestId, url, method: (p.request && p.request.method) || 'GET', type: p.type || 'Other',
          status: 0, statusText: '', mime: '', size: 0, t0: p.timestamp, tWall: Date.now(), ms: 0, state: 'pending',   // #2 tWall=墙钟(epoch),供 causalChains 与 user action 配对;t0=CDP 单调时钟,只用于算时延
          fromCache: false, remoteIP: '', failText: '', reqHeaders: (p.request && p.request.headers) || {}, postData: (p.request && p.request.postData) || '' }
        tab.netById.set(rec.id, rec); tab.net.push(rec)
        if (tab.net.length > MAX_NET) { const old = tab.net.shift(); tab.netById.delete(old.id) }
      }
      netSend(tab, 'add', rec)
    } else if (method === 'Network.responseReceived') {
      const rec = tab.netById.get(p.requestId); if (!rec) return
      const r = p.response || {}
      rec.status = r.status || 0; rec.statusText = r.statusText || ''; rec.mime = r.mimeType || ''
      rec.fromCache = !!r.fromDiskCache; rec.remoteIP = r.remoteIPAddress || ''
      rec.respHeaders = r.headers || {}; rec.type = p.type || rec.type
      netSend(tab, 'upd', rec)
    } else if (method === 'Network.loadingFinished') {
      const rec = tab.netById.get(p.requestId); if (!rec) return
      if (p.encodedDataLength) rec.size = p.encodedDataLength
      rec.ms = Math.max(0, (p.timestamp - rec.t0) * 1000); rec.state = 'done'
      netSend(tab, 'upd', rec)
    } else if (method === 'Network.loadingFailed') {
      const rec = tab.netById.get(p.requestId); if (!rec) return
      rec.state = p.canceled ? 'canceled' : 'failed'; rec.failText = p.errorText || ''
      rec.ms = Math.max(0, (p.timestamp - rec.t0) * 1000)
      netSend(tab, 'upd', rec)
    } else if (method === 'Runtime.consoleAPICalled') {
      const frames = ((p.stackTrace && p.stackTrace.callFrames) || []).map((c) => ({ url: c.url, line: c.lineNumber, col: c.columnNumber, fn: c.functionName }))
      const f = frames[0]
      pushConsole(tab, { level: cdpConsoleLevel(p.type), message: (p.args || []).map(fmtRO).join(' '), source: f ? f.url : '', line: f ? (f.line + 1) : 0, frames })
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {}
      const frames = ((d.stackTrace && d.stackTrace.callFrames) || []).map((c) => ({ url: c.url, line: c.lineNumber, col: c.columnNumber, fn: c.functionName }))
      const f = frames[0]
      pushConsole(tab, { level: 3, message: fmtException(d), source: f ? f.url : (d.url || ''), line: f ? (f.line + 1) : ((d.lineNumber || 0) + 1), frames })
    } else if (method === 'Runtime.bindingCalled') {
      // 录制事件主通道:页面覆写 console.log 也打不死 binding;payload 即 '__BR__...',复用 pushConsole 截留
      if (p.name === '__bocom_rec_emit') pushConsole(tab, { level: 1, message: String(p.payload || '') })
    }
  }
  function attachDbg(tab) {
    const wc = tab.view.webContents
    const dbg = wc.debugger
    if (!tab._dbgWired) { dbg.on('message', (_e, method, params) => { try { onCdp(tab, method, params) } catch {} }); tab._dbgWired = true }
    try { dbg.attach('1.3'); tab.dbg = true }
    catch (e) { tab.dbg = false; log('debugger attach failed: ' + e.message); tab._dbgReady = Promise.resolve(); return }
    tab._dbgReady = Promise.all([
      dbg.sendCommand('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 }).catch(() => {}),
      dbg.sendCommand('Page.enable').catch(() => {}),
      // Runtime.enable 失败 → 富路径死;必须把 dbg 标回 false,让 console-message 降级路径接管(消灭双死区)
      dbg.sendCommand('Runtime.enable').catch(() => { tab.dbg = false }),   // 富控制台 + 未捕获异常堆栈 + REPL 求值
      dbg.sendCommand('Runtime.addBinding', { name: '__bocom_rec_emit' }).catch(() => {}),   // 录制事件主通道(防页面覆写 console)
    ])
  }
  function detachDbg(tab) { try { tab.view.webContents.debugger.detach() } catch {} tab.dbg = false }

  // ── 后台标签的视口 ────────────────────────────────────────────────────────
  // ★真机 2026-08-11 一上手就踩到:后台标签【从来没被 setBounds 过】(brLayout 只排活动标签),
  //   于是它的视口是个窄条 —— 实测截出来 264×818,页面按手机断点渲染,截图对排查毫无价值。
  //   "看不见"不等于"没有尺寸":无头浏览器一样要显式给视口,这是 CDP Emulation 的本职。
  //   dsf=2 是为了出图够清晰(缩略图要按 2 倍分辨率给,见 window.js SHOT_W)。
  const BG_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }
  async function bgViewport(tab) {
    if (!tab || !tab.dbg) return
    try { await tab._dbgReady } catch {}
    try {
      await tab.view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', BG_VIEWPORT)
      tab._bgMetrics = true
    } catch (e) { log('后台标签设视口失败(截图可能是窄条): ' + e.message) }
  }
  /** 用户点过来看这个后台标签时,要把强制视口撤掉,否则它被钉死在 1440×900,跟着窗口缩放全失效 */
  async function clearBgViewport(tab) {
    if (!tab || !tab._bgMetrics) return
    tab._bgMetrics = false
    try { await tab.view.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride') } catch {}
  }

  // 控制台 REPL：在活动标签的页面上下文求值（含 CLI API：$ $$ $x copy keys values；$el=已拾取元素）
  async function brEval(expr) {
    const tab = brActive(); if (!tab) return { error: '无活动标签页', isErr: true }
    if (tab.dbg) {
      try {
        const r = await tab.view.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: expr, includeCommandLineAPI: true, replMode: true, objectGroup: 'console',
          awaitPromise: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true, generatePreview: true, returnByValue: false,
        })
        if (r.exceptionDetails) return { error: fmtException(r.exceptionDetails), isErr: true }
        return { result: fmtRO(r.result) }
      } catch (e) { return { error: String(e.message || e), isErr: true } }
    }
    try { const v = await tab.view.webContents.executeJavaScript(expr, true); return { result: typeof v === 'string' ? v : JSON.stringify(v) } }
    catch (e) { return { error: String(e.message || e), isErr: true } }
  }

  // Source map 还原（vlqDecode/buildSourceMap/smLookup/getSourceMap/resolveFrame）搬进 ./cdp-format,见文件顶部 require。

  function newTab(url, opts) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    const id = ++b.seq
    // 跨域开关:settings.browserArgs 里含 --disable-web-security → 本标签页关同源策略(运行期即生效,新开标签立刻可用)。
    // 解决"本地项目请求服务端跨域";配合主进程 appendSwitch 兜底。
    const wsOff = /disable-web-security/i.test(S.settings.browserArgs || '')
    const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: true, sandbox: true, webSecurity: !wsOff, allowRunningInsecureContent: wsOff } })
    const tab = { id, view, title: '新标签页', url: '', loading: false, favicon: '', console: [], errN: 0, warnN: 0, zoom: 1, device: null, deviceKey: null, net: [], netById: new Map(), preserveNet: false, dbg: false }
    b.tabs.push(tab)
    brWireTab(tab)
    attachDbg(tab)
    // ★后台标签(Agent 自主会话用):不 activateTab —— 那会把用户正在看的页面从窗口上摘下来。
    // 不激活的标签【压根不挂进 contentView】,所以它天然是"无头"的:JS 照跑、请求照发、
    // CDP 照样能截图(Page.captureScreenshot 不走合成表面),只是用户看不见。
    // 标签条照旧要推(brSendTabs)—— 用户想看它在干什么,点过去就行。看得见的可能性不能抹掉。
    if (opts && opts.background) { bgViewport(tab); brSendTabs() }
    else activateTab(id)
    if (S.browser.rec && S.browser.rec.active) wireRecToTab(tab, { crossTab: true })   // 录制中新开的标签也纳入,不丢后续操作
    const u = normalizeUrl(url)
    const doLoad = () => { if (view.webContents.isDestroyed()) return; if (u) view.webContents.loadURL(u); else view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'newtab.html')) }
    // 本地新标签页(newtab.html)无需等调试器网络域就绪 → 立即加载，避免 _dbgReady 卡住白屏。
    // 真实 URL 才等 Network/Page 域就绪(让首个文档请求进网络面板)，并加超时兜底，防调试器附加挂死导致白屏。
    if (u && tab._dbgReady) {
      let fired = false
      const go = () => { if (fired) return; fired = true; doLoad() }
      tab._dbgReady.then(go, go)
      setTimeout(go, 1200)
    } else {
      doLoad()
    }
    // 空白新标签：键盘焦点交给外壳地址栏(而非 newtab 页里的搜索框)，否则用户敲完第一次回车会落到页面空框里 → 看着像"跳回首页"
    if (!u) setTimeout(() => { if (b.win && !b.win.isDestroyed() && b.activeId === id) chromeSend('browser-focus-url') }, 60)
    return tab
  }

  function activateTab(id) {
    const b = S.browser
    if (!b.win || b.win.isDestroyed()) return
    const tab = b.tabs.find(t => t.id === id); if (!tab) return
    const prev = brActive()
    if (prev && prev.id !== id) { try { hostWin().contentView.removeChildView(prev.view) } catch {} }
    b.activeId = id
    clearBgViewport(tab)   // 从后台转到前台:撤掉强制视口,让它跟着窗口走
    try { hostWin().contentView.addChildView(tab.view) } catch {}
    brLayout()
    brSendTabs()
    brSendNav(tab)
    // 切换标签 → 重发该标签的控制台 + 网络快照
    chromeSend('browser-console-snapshot', { entries: tab.console, errN: tab.errN, warnN: tab.warnN })
    sendNetSnapshot(tab)
  }

  function closeTab(id) {
    const b = S.browser
    const idx = b.tabs.findIndex(t => t.id === id); if (idx === -1) return
    const tab = b.tabs[idx]
    const wasActive = b.activeId === id
    try { hostWin().contentView.removeChildView(tab.view) } catch {}
    try { tab.view.webContents.debugger.detach() } catch {}
    try { tab.view.webContents.destroy() } catch {}
    b.tabs.splice(idx, 1)
    if (b.tabs.length === 0) { if (b.mode === 'workspace' || b.shellHost) { newTab(''); return } b.win.close(); return }
    if (wasActive) activateTab(b.tabs[Math.min(idx, b.tabs.length - 1)].id)
    else brSendTabs()
  }

  function brZoom(dir) {
    const tab = brActive(); if (!tab) return
    let z = tab.zoom || 1
    if (dir === 'in') z = Math.min(3, +(z + 0.1).toFixed(2))
    else if (dir === 'out') z = Math.max(0.3, +(z - 0.1).toFixed(2))
    else z = 1
    tab.zoom = z
    tab.view.webContents.setZoomFactor(z)
    brSendNav(tab)
  }

  function brSetDevice(key) {
    const tab = brActive(); if (!tab) return
    const dev = BR_DEVICES[key] || BR_DEVICES.desktop
    tab.device = key === 'desktop' ? null : dev
    tab.deviceKey = key === 'desktop' ? null : key   // #6 记住 key(旋转会克隆 device 对象破坏身份反查),brSendNav 靠它回填工具栏
    // 仅靠视图边界模拟设备宽度（brLayout 居中成 dev.w 宽的框 → 页面响应式重排）。
    // 不调用 wc.enableDeviceEmulation：该原生调用在 WebContentsView 上（尤其分屏 +
    // 高 dpr 的 backing store，如手机 390×844@3x）会触发 GPU 原生崩溃，整窗/进程直接退出。
    brLayout()
    brSendNav(tab)
  }

  function brRotateDevice() {
    const tab = brActive(); if (!tab || !tab.device || !tab.device.w) return
    tab.device = { ...tab.device, w: tab.device.h, h: tab.device.w }
    brLayout()
  }

  function saveShot(buf) {
    const fp = path.join(app.getPath('downloads'), 'BocomHermes-' + Date.now() + '.png')
    fs.writeFileSync(fp, buf)
    return fp
  }
  async function brShotVisible(tab) { return saveShot((await tab.view.webContents.capturePage()).toPNG()) }
  // full=true 走 CDP 整页截图（captureBeyondViewport，含视口外内容）；失败/无调试器则回退可视区
  // CDP 截图(不依赖合成表面):窗口隐藏/视图没被绘制时,capturePage 会报
  // "Current display surface not available for capture" —— 而 Page.captureScreenshot 照样能出图。
  // Agent 自主会话常在窗口没亮到前台时截图,全靠这条路。
  async function brShotCdp(tab, full) {
    const dbg = tab.view.webContents.debugger
    const opt = { format: 'png' }
    if (full) {
      const m = await dbg.sendCommand('Page.getLayoutMetrics')
      const cs = m.cssContentSize || m.contentSize || { width: 1280, height: 800 }
      const w = Math.max(1, Math.ceil(cs.width)), h = Math.max(1, Math.min(Math.ceil(cs.height), 30000))   // 30000px 上限防超大页爆内存
      Object.assign(opt, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })
    }
    const shot = await dbg.sendCommand('Page.captureScreenshot', opt)
    return saveShot(Buffer.from(shot.data, 'base64'))
  }
  /** 对【指定标签】截图,不管它是不是当前活动标签、也不管窗口有没有亮。
   *  ★Agent 后台会话必须走这条:brScreenshot 内部取的是 brActive()——后台标签不是活动标签,
   *  它会返回 null;老代码为此在截图前 activateTab(自己的标签),那正是"把用户正在看的页面抢走"
   *  的元凶,而且抢完还不还。CDP 的 Page.captureScreenshot 不走合成表面,视图没挂在窗口上也能出图。 */
  async function brShotTab(tab, full) {
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return null
    // ★必须先等调试器就绪:attachDbg 是异步的(Network/Page/Runtime.enable 全在 _dbgReady 里),
    //   刚开的标签立刻截图会撞上 tab.dbg 还没定 —— 真机第一次自测就报「后台标签没有调试器?」。
    try { await Promise.race([tab._dbgReady || Promise.resolve(), new Promise((r) => setTimeout(r, 4000))]) } catch {}
    if (tab.dbg) { try { return await brShotCdp(tab, full) } catch (e) { log('browser shot(tab) cdp 失败: ' + e.message) } }
    if (tab.id === S.browser.activeId) { try { return await brShotVisible(tab) } catch (e) { log('browser shot(tab) 可视区兜底也失败: ' + e.message) } }
    // 最后一招:临时切前台截一张,【截完立刻还回去】。闪一下总比"截图给我"直接失败好,
    // 但必须还 —— 老代码正是"切过去就不还",那才是用户说的"又把我的会话毁掉了"。
    const prev = S.browser.activeId
    try {
      activateTab(tab.id)
      const p = await brShotVisible(tab)
      log('browser shot(tab): 无调试器,临时切前台截图后已切回(prev=' + prev + ')')
      return p
    } catch (e) { log('browser shot(tab) 全部路径失败: ' + e.message); return null }
    finally { if (prev != null && prev !== tab.id) { try { activateTab(prev) } catch {} } }
  }

  async function brScreenshot(full) {
    const tab = brActive(); if (!tab) return null
    try {
      if (full && tab.dbg) {
        const dbg = tab.view.webContents.debugger
        const m = await dbg.sendCommand('Page.getLayoutMetrics')
        const cs = m.cssContentSize || m.contentSize || { width: 1280, height: 800 }
        const w = Math.max(1, Math.ceil(cs.width)), h = Math.max(1, Math.min(Math.ceil(cs.height), 30000))   // 30000px 上限防超大页爆内存
        const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })
        return saveShot(Buffer.from(shot.data, 'base64'))
      }
      return await brShotVisible(tab)
    } catch (e) {
      log('browser screenshot err: ' + e.message)
      // ★兜底不能是"再调一次刚失败的那个方法"。原来这里 catch 完又调 brShotVisible ——
      //   而最常见的失败原因正是它自己:视图没被合成(窗口隐藏/未绘制)时 capturePage 必报
      //   "Current display surface not available for capture",重试一万次也是同一个错。
      //   换条真不一样的路:CDP 截图不走合成表面,窗口没亮也能出图。
      if (tab.dbg) { try { return await brShotCdp(tab, full) } catch (e2) { log('browser screenshot cdp 兜底也失败: ' + e2.message) } }
      try { return await brShotVisible(tab) } catch { return null }
    }
  }

  // 元素拾取：往页面注入一个高亮覆盖层，鼠标悬停描边、点击返回选择器+盒模型，Esc 取消
  const PICKER_JS = `new Promise((resolve) => {
    const D = document, root = D.documentElement, prevCur = root.style.cursor;
    const ov = D.createElement('div'); ov.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;background:rgba(74,168,255,.22);border:1px solid #4aa8ff;border-radius:2px;display:none';
    const tip = D.createElement('div'); tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#10131f;color:#cfe3ff;font:11px/1.4 ui-monospace,Menlo,monospace;padding:3px 7px;border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,.55);white-space:nowrap;display:none';
    D.body.appendChild(ov); D.body.appendChild(tip); root.style.cursor = 'crosshair';
    let cur = null;
    const escc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    function selOf(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + escc(el.id);
      const path = []; let n = el, depth = 0;
      while (n && n.nodeType === 1 && n !== D.body && n !== root && depth < 5) {
        let s = n.tagName.toLowerCase();
        if (n.id) { path.unshift('#' + escc(n.id)); break; }
        const cls = (typeof n.className === 'string' ? n.className.trim().split(/\\s+/).filter(Boolean) : []).slice(0, 2);
        if (cls.length) s += '.' + cls.map(escc).join('.');
        let i = 1, sib = n; while (sib = sib.previousElementSibling) { if (sib.tagName === n.tagName) i++; }
        if (i > 1) s += ':nth-of-type(' + i + ')';
        path.unshift(s); n = n.parentElement; depth++;
      }
      return path.join(' > ');
    }
    function info(el) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el), px = (v) => Math.round(parseFloat(v)) || 0;
      return { selector: selOf(el), tag: el.tagName.toLowerCase(), id: el.id || '', classes: (typeof el.className === 'string' ? el.className : ''),
        w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top),
        margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
        border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
        padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
        color: cs.color, bg: cs.backgroundColor, font: cs.fontSize + ' ' + (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '') };
    }
    function move(e) {
      const el = D.elementFromPoint(e.clientX, e.clientY); if (!el || el === ov || el === tip) return; cur = el;
      const r = el.getBoundingClientRect();
      ov.style.display = 'block'; ov.style.left = r.left + 'px'; ov.style.top = r.top + 'px'; ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px';
      tip.style.display = 'block'; tip.textContent = selOf(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
      let ty = r.top - 23; if (ty < 2) ty = r.bottom + 4; tip.style.left = Math.max(2, r.left) + 'px'; tip.style.top = ty + 'px';
    }
    function cleanup() { try { ov.remove(); tip.remove(); } catch (e) {} root.style.cursor = prevCur;
      D.removeEventListener('mousemove', move, true); D.removeEventListener('click', click, true); D.removeEventListener('keydown', key, true); window.removeEventListener('beforeunload', bye); }
    function click(e) { e.preventDefault(); e.stopPropagation(); const el = cur || D.elementFromPoint(e.clientX, e.clientY); try { window.$el = el } catch (_e) {} const out = el ? info(el) : null; cleanup(); resolve(out); }
    function key(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); } }
    function bye() { cleanup(); resolve(null); }
    D.addEventListener('mousemove', move, true); D.addEventListener('click', click, true); D.addEventListener('keydown', key, true); window.addEventListener('beforeunload', bye);
  })`
  async function brPickElement() {
    const tab = brActive(); if (!tab) return null
    try { return await tab.view.webContents.executeJavaScript(PICKER_JS, true) }
    catch (e) { log('pick element err: ' + e.message); return null }
  }
  async function brNetBody(id) {
    const tab = brActive(); if (!tab) return null
    const rec = tab.netById.get(id); if (!rec) return null
    let body = null, base64 = false
    if (tab.dbg && (rec.state === 'done' || rec.status)) {
      try { const r = await tab.view.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: id }); body = r.body; base64 = !!r.base64Encoded }
      catch (e) { body = '（无法获取响应体：' + e.message + '）' }
    }
    if (body && !base64 && body.length > 400000) body = body.slice(0, 400000) + '\n…（响应体过大，已截断）'
    return { id, url: rec.url, method: rec.method, status: rec.status, statusText: rec.statusText, mime: rec.mime, type: rec.type, size: rec.size, ms: Math.round(rec.ms), state: rec.state, remoteIP: rec.remoteIP || '', reqHeaders: rec.reqHeaders || {}, respHeaders: rec.respHeaders || {}, postData: rec.postData || '', body, base64 }
  }

  // ── Agent 后台用浏览器:确保有承载,但【绝不亮出来、绝不抢焦点】────────────────
  // ★为什么必须单独一条路(2026-08-11,用户连续两次"又把我的会话毁掉了"):
  //   Agent 调 browser_open 走的是 createBrowser(),而它在宿主模式下第一句就是 shellBrowserVisible(true)——
  //   浏览器 chrome + 那张写死的「调试助手」卡一起挂到主窗上,把用户正在看的对话【盖掉】。
  //   用户要的是"浏览器是对话的辅助能力",不是"Agent 一用浏览器,我的对话就没了"。
  //   这条路只保证【能用】,不动任何可见性:宿主已建就什么都不做;没建就悄悄建、且不建那张调试助手卡。
  //   用户自己点「内嵌浏览器」的行为完全不变(那是他主动选的)。
  function ensureBrowserBackground() {
    const b = S.browser
    if (b.shellHost && b.chromeView) return true          // 已是宿主模式:不碰 shellVisible
    if (b.win && !b.win.isDestroyed()) return true        // 已有独立窗:不 focus
    if (S.mainWin && !S.mainWin.isDestroyed()) { createShellBrowser({ background: true }); return true }
    createBrowser(undefined, { background: true })        // 连主窗都没有 → 独立窗,但不显示
    return !!(b.win && !b.win.isDestroyed())
  }

  function createBrowser(initialUrl, opts) {
    const b = S.browser
    const bg = !!(opts && opts.background)
    if (b.shellHost) { if (!bg) shellBrowserVisible(true); if (initialUrl) newTab(initialUrl, opts); return }   // 宿主模式:不开新窗,亮出宿主视图(后台模式不亮)
    if (b.win && !b.win.isDestroyed()) {
      if (!bg) b.win.focus()
      if (initialUrl) newTab(initialUrl, opts)
      return
    }
    const win = new BrowserWindow({
      show: !bg,                       // 后台模式:窗口建了但不显示(页面照跑,CDP 照样截图)
      width: 1320, height: 880, minWidth: 920, minHeight: 600,
      title: 'BocomHermes · 浏览器',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 13, y: 12 },
      // Windows: 用 overlay 把系统三键(最小化/最大化/关闭)染成深色，融进自绘标签栏(高 38px)
      titleBarOverlay: process.platform === 'win32' ? { color: '#f3f4f7', symbolColor: '#3c4250', height: 38 } : undefined,   // 浅色外壳:三键区随白灰系
      autoHideMenuBar: true,
      backgroundColor: '#f3f4f7',
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    })
    b.win = win; b.tabs = []; b.activeId = null; b.consoleH = 0
    win.loadFile(path.join(__dirname, '..', 'ui', 'browser.html'))
    win.on('resize', brLayout)
    win.on('closed', () => {
      // ⚠ 不要手动 destroy 子 WebContentsView 的 webContents —— Electron 自己会清,
      // 双重 destroy 在 Windows 触发 native 段错误(crashpad: not connected),整个 agent 进程会崩。
      S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
    })
    // chrome 加载完后再建首个标签（保证 IPC 能收到）
    win.webContents.once('did-finish-load', () => newTab(initialUrl || '', opts))
  }

  // ── 调试工作台：左 Agent 会话 + 右 内嵌浏览器（并排单窗口）────────────────────
  // 复用上面整套标签机制（newTab/activateTab/brLayout…），区别仅在于 b.leftW>0 + 一个左侧 cardView。
  function createWorkspace(initialUrl, opts) {
    const b = S.browser
    const openSkills = !!(opts && opts.skills)
    if (b.shellHost) { shellBrowserVisible(true); if (initialUrl) newTab(initialUrl); if (openSkills) { try { chromeSend('ws-open-skills') } catch {} } return }   // 宿主模式:不开新窗
    const embedded = !!(opts && opts.embedded)   // 嵌入式(旧方案,已废弃保留回退):作为主窗子窗跟随
    if (b.win && !b.win.isDestroyed()) {
      if (embedded && !b.embedded) { try { b.win.close() } catch {} }   // 已有独立窗,要嵌入式 → 关掉重建
      else { b.win.focus(); if (initialUrl) newTab(initialUrl); if (openSkills) { try { chromeSend('ws-open-skills') } catch {} } return }
    }
    const win = new BrowserWindow({
      width: 1500, height: 940, minWidth: 1040, minHeight: 620,
      title: openSkills ? 'BocomHermes · 录制回放工作台' : 'BocomHermes · 调试工作台',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 13, y: 12 },
      titleBarOverlay: process.platform === 'win32' ? { color: '#f3f4f7', symbolColor: '#3c4250', height: 38 } : undefined,   // 浅色外壳:三键区随白灰系
      autoHideMenuBar: true,
      backgroundColor: '#f3f4f7',
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
      // 嵌入式:挂 shell 主窗口为父窗(macOS 子窗随父窗移动/隐藏/关闭),无边框,不进任务栏
      ...(embedded ? { parent: S.mainWin, frame: false, skipTaskbar: true, show: false } : {}),
    })
    b.win = win; b.tabs = []; b.activeId = null; b.consoleH = 0; b.seq = 0
    b.mode = 'workspace'; b.leftW = 460; b._dragging = false
    b.embedded = embedded
    if (embedded) {
      // 跟随主窗口布局(内容区 = 228 侧栏以右、38 标题栏以下、28 状态栏以上)
      const region = () => {
        try {
          const r = S.mainWin.getBounds()
          return { x: r.x + 228, y: r.y + 38, width: Math.max(520, r.width - 228), height: Math.max(360, r.height - 38 - 28) }
        } catch { return null }
      }
      const follow = () => { const rg = region(); if (rg && !win.isDestroyed() && win.isVisible()) win.setBounds(rg) }
      try { S.mainWin.on('resize', follow); S.mainWin.on('move', follow) } catch {}
      const rg = region(); if (rg) win.setBounds(rg)
      win.once('ready-to-show', () => { try { win.show() } catch {} })
      // 嵌入式:点 X 不销毁,只隐藏(浏览器标签/控制台状态全保活;再进「内嵌浏览器」视图原地回来)
      win.on('close', (ev) => { if (!app.isQuitting) { ev.preventDefault(); try { win.hide() } catch {} } })
    }

    // 左侧 Agent 会话 = 一个加载 card.html 的 WebContentsView（embedded 模式：隐藏自带窗口控件）
    const cardView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } })
    b.cardView = cardView; b.cardWcId = cardView.webContents.id
    win.contentView.addChildView(cardView)
    cardView.webContents.loadFile(path.join(__dirname, '..', 'ui', 'card.html'), { query: { embedded: '1', title: '调试助手' } })

    win.loadFile(path.join(__dirname, '..', 'ui', 'browser.html'), { query: { workspace: '1' } })   // 复用浏览器壳，workspace 模式右移 chrome + 加分隔条
    win.on('resize', () => {
      const [cw] = win.getContentSize()
      b.leftW = Math.max(320, Math.min(cw - 440, b.leftW))
      brLayout()
      if (!win.isDestroyed()) win.webContents.send('browser-split-set', b.leftW)
    })
    win.on('closed', () => {
      // ⚠ 不要手动 destroy 子 WebContentsView 的 webContents —— Electron 自己会清,
      // 双重 destroy 在 Windows 触发 native 段错误(crashpad: not connected),整个 agent 进程会崩。
      // #1 左侧卡片的清理必须与独立卡 spawnCard 的 closed 处理对齐:否则关工作台会
      //   ① 漏 forgetBusy → 死 wcId 留在 busyCards,托盘提示永久卡"运行中",全局卡片的完成/空闲态失效;
      //   ② 漏 retireIfOrphan → 切过项目的卡自起的 serve 变孤儿进程;③ 漏 cardDir/modelByWc 删除 → Map 泄漏。
      const wcId = b.cardWcId
      const s = S.sessionByWc.get(wcId)
      let oldServe = null
      if (s) { const si = S.sessionInfo.get(s); if (si) { oldServe = si.serve; oc.abort(si.serve, s) } S.sessionInfo.delete(s); S.streamBuf.delete(s); S.sentPrompt.delete(s); S.firstMsgCtx.delete(s) }
      S.sessionByWc.delete(wcId)
      if (S.cardDir) S.cardDir.delete(wcId)
      if (S.modelByWc) S.modelByWc.delete(wcId)
      if (oldServe) {
        const inUseBases = new Set([...S.sessionInfo.values()].map((si) => si.serve && si.serve.base).filter(Boolean))
        try { if (oc.retireIfOrphan(oldServe, inUseBases)) log('workspace closed: serve ' + oldServe.base + ' 已退休(无会话引用)') } catch {}
      }
      if (wcId != null) forgetBusy(wcId)   // 关工作台即清"忙",避免托盘提示卡在"运行中"
      S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false, embedded: false }
    })
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('browser-split-set', b.leftW)
      brLayout()
      newTab(initialUrl || '')
      // 从「录制回放」入口进来 → 右栏直接落地技能库(满栏白页,一眼看到能跑什么;点运行/录制才切回浏览器)
      if (openSkills) win.webContents.send('ws-open-skills')
    })
  }

  // ── 宿主模式(波7 · 内嵌浏览器真重构):浏览器 chrome + 页面视图全部挂进 shell 主窗口 ──
  // chrome = 一个 WebContentsView(加载 browser.html?workspace=1),与标签页视图同为 mainWin.contentView
  // 的子视图,位置由 layoutRegion 统一算(228 侧栏右 / 38 标题栏下 / 28 状态栏上)。不再是"跟随的嵌入式子窗"。
  function createShellBrowser(opts) {
    const b = S.browser
    const bg = !!(opts && opts.background)   // 后台模式:建但不亮、也不建那张「调试助手」卡
    if (!S.mainWin || S.mainWin.isDestroyed()) { createWorkspace(); return }   // 主窗不在 → 回退独立工作台(老路径)
    if (b.shellHost && b.chromeView) { if (!bg) { b.shellVisible = true; brLayout() } return }   // 已建:亮出即可(不递归)
    if (b.win && !b.win.isDestroyed() && !b.shellHost) { try { b.win.close() } catch {} }   // 有独立/嵌入式窗 → 换宿主(tabs 重来)
    b.shellHost = true; b.embedded = false; b.shellVisible = !bg
    b.win = S.mainWin; b.tabs = []; b.activeId = null; b.consoleH = 0; b.seq = 0
    // ★后台模式不建「调试助手」卡,leftW 也就为 0。那张卡是写死的另一段会话:
    //   它一挂上来就把用户正在看的对话盖掉,还会在「历史」里凭空多出一条「调试助手」。
    //   用户明确说过:浏览器是对话的辅助能力,不是"一用浏览器,对话就没了"。
    b.mode = 'workspace'; b.leftW = bg ? 0 : 460; b._dragging = false
    // 浏览器 chrome(标签栏/工具栏/控制台/技能条):挂主窗的 WebContentsView
    const chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } })
    b.chromeView = chrome
    S.mainWin.contentView.addChildView(chrome)
    chrome.webContents.loadFile(path.join(__dirname, '..', 'ui', 'browser.html'), { query: { workspace: '1' } })
    // 左侧 Agent 会话卡(工作台分栏):同挂主窗
    if (!bg) {
      const cardView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } })
      b.cardView = cardView; b.cardWcId = cardView.webContents.id
      S.mainWin.contentView.addChildView(cardView)
      cardView.webContents.loadFile(path.join(__dirname, '..', 'ui', 'card.html'), { query: { embedded: '1', title: '调试助手' } })
    }
    // 主窗尺寸变化 → 重排(chrome/卡片/页面一起;layoutRegion 现读现算)
    const onResize = () => { brLayout(); if (!S.mainWin.isDestroyed()) chromeSend('browser-split-set', b.leftW) }
    S.mainWin.on('resize', onResize)
    chrome.webContents.once('did-finish-load', () => {
      chromeSend('browser-split-set', b.leftW)
      brLayout()
      if (!bg) newTab('')   // 后台模式不开空白首标签:Agent 自己会开它要的那个
    })
    log('browser: shell host mode on (chrome + tabs attached to mainWin)')
  }
  // 宿主视图显隐:切到「内嵌浏览器」= show;切走 = 全部压 0 高度(页面 JS 照跑,状态全保活,回来原样)
  function shellBrowserVisible(on) {
    const b = S.browser
    if (!b.shellHost) return
    b.shellVisible = !!on
    brLayout()   // visible=true 正常排布;false → brLayout 的隐藏分支统一压 0
  }

  return { brActive, newTab, closeTab, activateTab, brSetDevice, brRotateDevice, brZoom, brLayout, brSendTabs, sendNetSnapshot, attachDbg, detachDbg, normalizeUrl, brScreenshot, brShotTab, brNetBody, brPickElement, brEval, createBrowser, ensureBrowserBackground, createWorkspace, createShellBrowser, shellBrowserVisible, chromeSend }
}
