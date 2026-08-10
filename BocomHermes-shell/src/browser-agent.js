// Agent 自主浏览器会话 —— 让 Agent 自己开一次受围栏的、看得见的浏览器,用于端到端验证。
//
// ── 为什么要有这个模块 ────────────────────────────────────────────────────
// 在此之前,Agent 想动内嵌浏览器只有一条路:用户先【录一个技能】→ 回放 → 回放整段失败 →
// 引擎才把剩余流程"接管"给 Agent(recorder.js awaitAgentTakeover),而 skillPageAct 的第一行就是
// `if (!S.browser._takeover.active) return { error: ... }`。于是:
//   · 痛点一:浏览器没法给 Agent 直接用 —— 每次都要人先录、先跑、还得跑挂了才轮到它;
//   · 痛点二:强引擎(selAlt 兜底 / 登录态 / 红框可视化)只对"回放录好的技能"开放,
//     不是一个 Agent 随时能拿起来用的通用工具。
// 而验证棒手里的 browser_* 是 MCP 进程内另起的无头浏览器:没有登录态、用户看不见、
// 与真实使用环境不是同一个东西 —— "打开页面看过了"这句话因此含金量很低。
//
// 本模块给出第三条路:Agent 自己 open 一个会话,拿到【自己的标签页】,在围栏内 act/assert/取证,
// close 时产出一份结构化报告(可直接当验证证据)。强引擎、真登录态、用户全程看得见。
//
// ── 三条不变量(改这个文件前先读) ──────────────────────────────────────────
// ① 围栏优先于一切:每一次 act/navigate 都按【当前页面的 origin】现查,不是只在 open 时查一次。
//    页面自己会跳转(登录重定向、SSO、业务跳转),只在入口查等于没查。
// ② 一会话一标签页:绝不共用当前活跃标签。多个验证棒并行时共用一个可见标签会互相抢方向盘,
//    而且会把用户正在看的页面踩掉。标签页随会话建、随会话关。
// ③ 报告只记真发生过的事:steps/asserts 由执行路径写入,不接受调用方自述。
//    这是整条验证闭环的立身之本 —— "读过 ≠ 跑过",报告也一样,"说做过 ≠ 做过"。
//
// 安全口径:内嵌浏览器带着用户的内网登录态,所以默认只放行本机(localhost/127.0.0.1),
// 其他站点必须用户在设置里逐个加白名单(settings.browserAgent.origins)。
// 这不是"防 Agent 使坏",是防它在真业务系统上误操作 —— 同一道理,越权时给的是清晰的开通指引,不是静默失败。

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])
const MAX_SESSIONS = 3            // 并行会话上限(每个占一个可见标签页,再多就是标签爆炸)
const DEFAULT_MINUTES = 10
const MAX_MINUTES = 30
const MAX_STEPS = 400             // 单会话步数上限:跑飞了要有个头(超了 act 直接拒,报告如实记)

function nowMs() { return Date.now() }
function str(x) { return x == null ? '' : String(x) }
function arr(x) { return Array.isArray(x) ? x : [] }

/** 取 origin(protocol//host)。取不到返回空串 —— 空串在围栏里一律不放行 */
function originOf(u) {
  try { const x = new URL(str(u)); return x.protocol + '//' + x.host } catch { return '' }
}
function hostOf(u) {
  try { return new URL(str(u)).hostname } catch { return '' }
}
function isLocal(u) {
  const h = hostOf(u).toLowerCase()
  return !!h && LOCAL_HOSTS.has(h)
}

module.exports = function initBrowserAgent(ctx) {
  const { S, log, brActive, newTab, closeTab, activateTab, createBrowser, brScreenshot, execStep, waitNetIdle, pageRead, brSetDevice, showShot, callerWc } = ctx

  const sessions = new Map()   // id → session

  function cfg() {
    const c = (S.settings && S.settings.browserAgent) || {}
    return {
      enabled: c.enabled !== false,                                  // 缺省开(只放行本机,已经足够安全)
      origins: Array.isArray(c.origins) ? c.origins.map(str) : [],   // 用户显式加白的站点(整串 origin,如 https://uat.example.com)
      minutes: Math.min(Math.max(+c.minutes || DEFAULT_MINUTES, 1), MAX_MINUTES),
    }
  }

  /** 这个 URL 允许 Agent 自主操作吗?返回 {ok} 或 {ok:false, err:'…(带开通指引)'} */
  function policyCheck(url) {
    const c = cfg()
    if (!c.enabled) return { ok: false, err: 'Agent 自主浏览器已被关闭(设置 → 浏览器 → Agent 自主会话)。仍可用录制技能回放。' }
    const o = originOf(url)
    if (!o) return { ok: false, err: '无法解析 URL 的 origin: ' + str(url).slice(0, 120) }
    if (!/^https?:$/.test(o.split('//')[0] + ':')) { /* 下面统一按 protocol 判 */ }
    let proto = ''
    try { proto = new URL(url).protocol } catch {}
    if (proto !== 'http:' && proto !== 'https:') return { ok: false, err: '只允许 http/https,拒绝: ' + proto }
    if (isLocal(url)) return { ok: true }
    if (c.origins.includes(o)) return { ok: true }
    return {
      ok: false,
      err: '越出围栏:' + o + ' 不在允许清单里。默认只放行本机(localhost/127.0.0.1)—— 内嵌浏览器带着你的内网登录态,'
        + '让 Agent 在真业务系统上自由点击风险太大。要放行请在 设置 → 浏览器 → Agent 自主会话 → 允许的站点 里加上「' + o + '」。',
    }
  }

  function live(id) {
    const s = sessions.get(str(id))
    if (!s || s.closed) return null
    if (nowMs() > s.expiresAt) { finish(s, 'timeout', '会话超时(' + Math.round((s.expiresAt - s.startedAt) / 60000) + ' 分钟)'); return null }
    return s
  }
  /** 有没有任意一个存活的自主会话(供 skillPageAct 放闸用) */
  function anyLive() {
    for (const s of sessions.values()) if (live(s.id)) return s
    return null
  }
  function tabOf(s) {
    const b = S.browser
    const t = (b.tabs || []).find((x) => x.id === s.tabId)
    return t && t.view && !t.view.webContents.isDestroyed() ? t : null
  }
  function curUrl(s) {
    const t = tabOf(s); if (!t) return ''
    try { return t.view.webContents.getURL() } catch { return '' }
  }
  /** 不变量①:按【当前页面】现查围栏 —— 页面自己跳走了(SSO/业务跳转)也要拦住 */
  function fenceNow(s) {
    const u = curUrl(s)
    if (!u) return { ok: false, err: '标签页还没有页面' }
    const r = policyCheck(u)
    if (!r.ok) return { ok: false, err: '当前页面已跳出围栏(' + originOf(u) + '):' + r.err }
    return { ok: true }
  }
  function step(s, kind, detail, ok, err) {
    if (s.steps.length < MAX_STEPS) s.steps.push({ i: s.steps.length + 1, kind, detail: str(detail).slice(0, 300), ok: !!ok, err: str(err).slice(0, 300), at: nowMs() - s.startedAt })
    return ok
  }

  // ── open ────────────────────────────────────────────────────────────────
  async function agentOpen(a) {
    const url = str(a && a.url)
    const purpose = str(a && a.purpose).slice(0, 200)
    if (!url) return { error: 'url 必填(要验证的页面地址)' }
    if (!purpose) return { error: 'purpose 必填 —— 一句话说清这次要验什么。它会写进报告,也会显示给用户看(浏览器是他的,得让他知道你在干嘛)。' }
    const pol = policyCheck(url)
    if (!pol.ok) return { error: pol.err }
    // 过期会话先收掉,再判并发上限(否则超时会话会永久占坑)
    for (const s of [...sessions.values()]) live(s.id)
    const liveN = [...sessions.values()].filter((s) => !s.closed).length
    if (liveN >= MAX_SESSIONS) return { error: '同时最多 ' + MAX_SESSIONS + ' 个自主浏览器会话(每个占一个标签页),先 browser_close 收掉一个再开' }

    try { createBrowser() } catch (e) { return { error: '打不开浏览器: ' + e.message } }
    const tab = newTab(url)
    if (!tab) return { error: '开标签页失败(浏览器窗口没起来)' }
    const c = cfg()
    const id = 'bs_' + nowMs().toString(36) + '_' + Math.floor(Math.random() * 1e4).toString(36)
    const s = {
      id, purpose, tabId: tab.id, tabIds: [tab.id],   // tabId=活动标签(其余代码照旧只认它);tabIds=本会话拥有的全部
      startedAt: nowMs(), expiresAt: nowMs() + c.minutes * 60000,
      steps: [], asserts: [], shots: [], closed: false, result: null,
      netFrom: 0, conFrom: 0,   // 只统计本会话开始之后的网络/控制台(标签页是新开的,基线就是 0,留字段是为了将来复用已有标签)
      // ★开会话时就钉住"是哪张对话卡在调我":截图要摆回【那张】卡。
      // 会话能开十分钟,期间别的卡也会忙起来 —— 到截图时再现算就会推给错的人。
      wc: (typeof callerWc === 'function' ? (() => { try { return callerWc() } catch { return null } })() : null),
    }
    sessions.set(id, s)
    step(s, 'open', url, true, '')
    log('[browser-agent] 开会话 ' + id + ' → ' + url + ' (' + purpose + ')')
    // 等页面基本安定再交给 Agent,省得它第一步读到空白页
    try { await waitNetIdle(tab, 400, 6000) } catch {}
    let snap = null
    try { snap = await pageRead(tab) } catch {}
    return {
      ok: true, sessionId: id, expiresInSec: Math.round((s.expiresAt - nowMs()) / 1000),
      url: curUrl(s), title: (snap && snap.title) || '', elements: (snap && snap.elements) || '', text: (snap && String(snap.text || '').slice(0, 3000)) || '',
      note: '标签页已开,用户看得见。围栏:' + (isLocal(url) ? '本机' : originOf(url)) + '。做完必须调 browser_close 出报告。',
    }
  }

  // ── read ────────────────────────────────────────────────────────────────
  async function agentRead(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    let snap = null
    try { snap = await pageRead(tab, { all: !!(a && a.all) }) } catch (e) { return { error: '读页失败: ' + e.message } }
    // truncated 必须透传:截断了却不说,模型就把"前 200 个"当成"全部"(今天一整天最贵的教训之一)
    // elemErr 同理,而且更狠:采集炸了却照样 ok:true + elements 里塞一句"(采集失败)",
    // 模型只会把它当"这页没元素"接着往下猜 selector —— 真机 2026-08-11 就是这么走的。
    // 所以炸了要【明说 + 给下一步】,而不是让它自己揣摩。
    const ee = str(snap && snap.elemErr)
    return { ok: true, url: curUrl(s), title: (snap && snap.title) || '', elements: (snap && snap.elements) || '',
      text: (snap && snap.text) || '', truncated: (snap && snap.truncated) || '',
      ...(ee ? { elemError: '元素采集失败:' + ee + ' —— 这一轮拿不到 ref 句柄,别用 ref 点(编号会指错);'
        + '先 browser_shot 看截图确认页面长什么样,或者 browser_act 用 selector 操作' } : {}) }
  }

  // ── find(仿 CC 的 find:自然语言找元素 → refs)──────────────────────────────
  // 【为什么需要】页面一大,browser_read 就算给到 200 个元素,模型也得在里面翻;
  // 真实场景里它心里想的是"那个搜索框""提交按钮",而不是第几个元素。
  // 【为什么只在已盖 ref 的元素上找,不重新扫一遍】重扫会重新编号 —— 上一次读页拿到的 ref 会集体指错,
  // 而模型不会知道(它手里那些编号看着还有效)。这是最坏的一类失败:动作成功、点的却不是它以为的那个。
  // 所以没读过页就明说"先 browser_read",与 CC 的"Call read_page first"同一条契约。
  async function agentFind(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const q = str(a && a.query).trim()
    if (!q) return { error: '要找什么?给一句话,比如「登录按钮」「用户名输入框」' }
    const limit = Math.min(Math.max(+(a && a.limit) || 10, 1), 30)
    let out = null
    try {
      out = await tab.view.webContents.executeJavaScript(`(function(){
        var es=document.querySelectorAll('[data-bh-ref]');
        if(!es.length)return {none:1};
        var q=${JSON.stringify(q)}.toLowerCase();
        // 拆词后逐词命中:中文按整串、英文/数字按空格切,任一词命中即算(宁可多给几条,也别一条不给)
        var toks=q.split(/[\\s,，、]+/).filter(Boolean);
        var hits=[];
        for(var i=0;i<es.length;i++){
          var e=es[i];
          var role=e.getAttribute('role')||e.tagName.toLowerCase();
          var name=(e.innerText||e.value||e.placeholder||(e.getAttribute&&e.getAttribute('aria-label'))||'').trim().replace(/\\s+/g,' ').slice(0,60);
          var hay=(role+' '+name+' '+(e.getAttribute('name')||'')+' '+(e.getAttribute('title')||'')+' '+(e.getAttribute('href')||'')).toLowerCase();
          var score=0;
          for(var k=0;k<toks.length;k++){ if(hay.indexOf(toks[k])>=0) score++; }
          if(!score)continue;
          if(hay.indexOf(q)>=0)score+=2;                      // 整串命中更靠前
          hits.push({ref:e.getAttribute('data-bh-ref'),role:role,name:name,score:score});
        }
        hits.sort(function(x,y){return y.score-x.score});
        return {hits:hits.slice(0,${limit}),total:hits.length};
      })()`, true)
    } catch (e) { return { error: '查找失败: ' + e.message } }
    if (out && out.none) return { error: '这一页还没读过(元素上没有 ref)—— 先 browser_read 一次,再 browser_find' }
    const hits = (out && out.hits) || []
    if (!hits.length) return { ok: true, found: 0, hint: '没找到匹配「' + q + '」的元素 —— 换个说法,或先 scroll 到那块再 browser_read' }
    return {
      ok: true, found: hits.length, total: (out && out.total) || hits.length,
      elements: hits.map((h) => '[ref_' + h.ref + '] ' + h.role + (h.name ? ' "' + h.name + '"' : '')).join('\n'),
    }
  }

  // ── act ─────────────────────────────────────────────────────────────────
  // 复用 recorder.js 的 execStep(强引擎:selAlt 兜底 + 可见性等待 + 红框高亮),不另起一套弱实现。
  async function agentAct(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    if (s.steps.length >= MAX_STEPS) return { error: '本会话步数已达上限 ' + MAX_STEPS + ' —— 跑飞了,请 browser_close 收报告' }
    const action = str(a.action)
    // ★ref 优先(仿 CC:read_page 给句柄、后续动作用句柄,模型不用拼选择器也就不会拼错)。
    //   ref 由 skillPageRead 盖在 DOM 上的 data-bh-ref 属性支撑 → 解析成精确唯一选择器。
    //   页面刷新/重渲染后属性就没了:那时 execStep 会找不到元素并报错,而不是【悄悄点到别的元素上】——
    //   后者才是最坏的结果(动作成功、点的却不是它以为的那个)。回执直接告诉它重新 browser_read。
    const refRaw = a.ref != null ? str(a.ref).trim() : ''
    const refN = refRaw ? (refRaw.match(/^(?:ref_)?(\d+)$/) || [])[1] : ''
    if (refRaw && !refN) return { error: 'ref 形如 ref_3 或 3(browser_read 返回的那个);要用选择器请填 selector' }
    const sel = refN ? '[data-bh-ref="' + refN + '"]' : (a.selector != null ? str(a.selector).slice(0, 1000) : '')
    const wc = tab.view.webContents

    // navigate 特殊:要先按【目标 URL】过策略,再执行(不能等跳过去了才发现越界)
    if (action === 'navigate') {
      const target = str(a.url)
      const pol = policyCheck(target)
      if (!pol.ok) { step(s, 'navigate', target, false, pol.err); return { error: pol.err } }
      const r = await execStep(wc, { act: 'navigate', url: target }, tab, { waitMs: 8000 })
      step(s, 'navigate', target, !!r.ok, r.err)
      try { await waitNetIdle(tab, 300, 4000) } catch {}
      return r.ok ? { ok: true, url: curUrl(s) } : { error: r.err || '导航失败' }
    }
    // 其余动作:按当前页现查围栏(不变量①)
    const f = fenceNow(s)
    if (!f.ok) { step(s, action, sel, false, f.err); return { error: f.err } }

    let ev = null
    if (action === 'click') ev = { act: 'click', sel, selAlt: [] }
    else if (action === 'type') ev = { act: 'input', sel, selAlt: [], value: str(a.value).slice(0, 500) }
    else if (action === 'select') ev = { act: 'select', sel, selAlt: [], value: str(a.value).slice(0, 200), text: str(a.text).slice(0, 60) }
    else if (action === 'check') ev = { act: 'check', sel, selAlt: [], checked: a.checked !== false }
    else if (action === 'enter') ev = { act: 'key', sel, selAlt: [], key: 'Enter' }
    // ★key:enter 只是它的一个特例。真实页面里 Escape 关弹层、Tab 移焦点、方向键选下拉项都是必需的,
    //   原来只给 enter 等于把这些流程整个挡在门外。白名单挡住"把整段文本当按键发"这种误用。
    else if (action === 'key') {
      const KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']
      const k = KEYS.find((x) => x.toLowerCase() === str(a.key).trim().toLowerCase())
      if (!k) return { error: 'key 只能是:' + KEYS.join(' / ') + '(要输入文字请用 action=type)' }
      ev = { act: 'key', sel, selAlt: [], key: k }
    }
    // ★scroll:页面很长时"点不到"最常见的原因就是它压根不在视口里 —— 而元素不可见时读页不给 ref、
    //   动作也点不着,于是模型会误判成"这个按钮不存在"。给 ref/selector 就滚到它,不给就整页滚。
    else if (action === 'scroll') {
      const dir = (str(a.direction) || 'down').toLowerCase()
      const amt = Math.min(Math.max(+a.amount || 600, 50), 5000)
      const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0
      const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0
      let r2 = null
      try {
        r2 = await wc.executeJavaScript(sel
          ? `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return {err:'找不到元素'};`
            + `e.scrollIntoView({block:'center',inline:'center'});return {ok:1,into:1}})()`
          : `(function(){window.scrollBy(${dx},${dy});return {ok:1,y:Math.round(window.scrollY)}})()`, true)
      } catch (e) { r2 = { err: e.message } }
      const bad = r2 && r2.err
      step(s, 'scroll', sel || (dir + ' ' + amt), !bad, bad || '')
      return bad ? { error: bad } : { ok: true, url: curUrl(s), scrolled: sel ? '已滚到元素' : ('已滚动 ' + dir + ' ' + amt) }
    }
    // ★hover:菜单/提示/悬浮操作条都要先悬停才出来。用【真实鼠标事件】而不是 JS 派发的 mouseover ——
    //   后者触发不了 CSS :hover,而很多下拉菜单恰恰是纯 CSS 的,只派事件会看着"悬停了却什么都没弹"。
    else if (action === 'hover') {
      if (!sel) return { error: 'hover 需要 ref 或 selector' }
      let box = null
      try {
        box = await wc.executeJavaScript(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;`
          + `var r=e.getBoundingClientRect();if(!r.width&&!r.height)return null;`
          + `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`, true)
      } catch {}
      if (!box) { step(s, 'hover', sel, false, '找不到元素或元素不可见'); return { error: '找不到元素或元素不可见(先 browser_read 拿新 ref,或先 scroll 到它)' } }
      try { wc.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y }) } catch (e) { return { error: '悬停失败: ' + e.message } }
      await new Promise((r) => setTimeout(r, 250))   // 给悬浮层一点出现时间,否则紧接着的 read 读不到它
      step(s, 'hover', sel, true, '')
      return { ok: true, url: curUrl(s), hint: '已悬停 —— 悬浮层通常要再 browser_read 一次才看得到' }
    }
    else if (action === 'wait') {
      const ms = Math.min(Math.max(+a.ms || 800, 100), 5000)
      await new Promise((r) => setTimeout(r, ms))
      step(s, 'wait', ms + 'ms', true, '')
      return { ok: true, url: curUrl(s) }
    }
    else return { error: '未知 action: ' + action + '(可用 click|type|select|check|enter|key|scroll|hover|navigate|wait)' }

    const r = await execStep(wc, ev, tab, { waitMs: 4000 })
    step(s, action, sel + (action === 'type' ? ' ← ' + str(a.value).slice(0, 40) : ''), !!r.ok, r.err)
    try { await waitNetIdle(tab, 300, 2500) } catch {}
    return r.ok ? { ok: true, url: curUrl(s) } : { error: r.err || '执行失败' }
  }

  // ── assert ──────────────────────────────────────────────────────────────
  // 断言是这套东西相对"人肉点一遍"的真正增量:结论可判、可回放、进报告。
  // 前四种查页面,后两种查【浏览器自己采集的】控制台与网络 —— 后者是"页面看着正常但其实报错了"的唯一抓手。
  async function agentAssert(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const kind = str(a.kind)
    const expect = str(a.expect)
    const label = str(a.label).slice(0, 120) || (kind + (expect ? ':' + expect.slice(0, 40) : ''))
    const wc = tab.view.webContents
    let pass = false, actual = ''
    try {
      if (kind === 'text_present' || kind === 'text_absent') {
        const body = str(await wc.executeJavaScript('(document.body&&document.body.innerText)||""', true))
        const hit = body.toLowerCase().includes(expect.toLowerCase())
        pass = kind === 'text_present' ? hit : !hit
        actual = hit ? '页面中找到了这段文本' : '页面中没有这段文本'
      } else if (kind === 'selector_exists' || kind === 'selector_absent') {
        const n = +await wc.executeJavaScript('document.querySelectorAll(' + JSON.stringify(expect) + ').length', true)
        pass = kind === 'selector_exists' ? n > 0 : n === 0
        actual = '匹配到 ' + n + ' 个元素'
      } else if (kind === 'url_matches') {
        const u = curUrl(s)
        pass = u.includes(expect)
        actual = u
      } else if (kind === 'no_console_error') {
        const errs = (tab.console || []).filter((e) => e && e.level === 3)
        pass = errs.length === 0
        actual = errs.length ? errs.length + ' 条控制台错误,首条:' + str(errs[0].message).slice(0, 200) : '无控制台错误'
      } else if (kind === 'no_failed_request') {
        const bad = (tab.net || []).filter((r) => r && (r.state === 'failed' || (r.status >= 400)))
        pass = bad.length === 0
        actual = bad.length ? bad.length + ' 个失败请求,首个:' + str(bad[0].status || bad[0].failText) + ' ' + str(bad[0].url).slice(0, 160) : '无失败请求'
      } else {
        return { error: '未知断言类型: ' + kind + '(可用 text_present|text_absent|selector_exists|selector_absent|url_matches|no_console_error|no_failed_request)' }
      }
    } catch (e) { pass = false; actual = '断言执行出错: ' + e.message }
    s.asserts.push({ label, kind, expect, pass, actual: actual.slice(0, 300), at: nowMs() - s.startedAt })
    step(s, 'assert', label, pass, pass ? '' : actual)
    return { ok: true, pass, label, actual }
  }

  // ── 取证:截图 / 控制台+网络诊断 ────────────────────────────────────────
  async function agentShot(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const b = S.browser
    const prev = b.activeId
    try {
      if (prev !== tab.id) activateTab(tab.id)   // 截的必须是本会话的标签页,不是用户当下在看的那个
      const p = await brScreenshot(!!(a && a.full))
      if (!p) return { error: '截图失败' }
      const label = str(a && a.label).slice(0, 120)
      s.shots.push({ path: p, label, at: nowMs() - s.startedAt })
      step(s, 'shot', p, true, '')
      // ★截完【直接摆到对话里给用户看】(2026-08-11 用户要的就是这个):
      // 原先只把路径回给模型,而模型没有读图能力、回复又只是纯文本 —— 它能做的最多是吐一个
      // markdown 图片语法,而那条路径渲染不出来。于是"截图给我看"这件事对用户永远只剩一行路径。
      // 谁有能力把图摆出来?壳层。所以由壳层直推进当前对话卡,不经过模型。
      let shown = false
      if (typeof showShot === 'function') { try { shown = !!showShot({ path: p, label, url: curUrl(s), full: !!(a && a.full), wc: s.wc }) } catch (e) { log('[browser-agent] 展示截图失败: ' + e.message) } }
      return { ok: true, path: p, shownToUser: shown,
        note: shown
          ? '这张图已经【直接展示在用户的对话里】了,不用再把路径念给用户、也不用叫用户自己去打开。你自己要"看"内容才需要把它当附件读一遍(读图要用带视觉的模型)。'
          : '图已存盘但没能摆进对话(当前没有活动对话卡)。要自己看内容就把它当附件读一遍(读图要用带视觉的模型)。' }
    } catch (e) { return { error: '截图失败: ' + e.message } }
  }

  // ── tabs(仿 CC 的 tabs_context / create / select / close)────────────────────
  // 【为什么需要】一次验证经常要【对着两个页面看】:改前改后、列表页与详情页、两个环境同一功能。
  // 单标签只能来回 navigate,前一页的状态(滚动位置、填了一半的表单、控制台历史)全丢 ——
  // 于是"对比"这件事实际上做不了,只能靠记忆描述,而记忆正是最不可靠的那部分。
  // 【设计上刻意保守】① 新开的标签一样过围栏(不能借开标签绕过白名单);
  //   ② 只能操作【本会话自己开的】标签 —— 用户手动开的页面不归 Agent 碰,那是他的浏览器;
  //   ③ 不许关掉最后一个(关完 tabOf 全空,后续每个工具都会报"标签页已被关掉",等于把会话废了)。
  async function agentTabs(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    if (!Array.isArray(s.tabIds)) s.tabIds = [s.tabId]
    const b = S.browser
    const own = () => s.tabIds.map((id) => (b.tabs || []).find((x) => x.id === id))
      .filter((t) => t && t.view && !t.view.webContents.isDestroyed())
    const act = str(a && a.action) || 'list'

    if (act === 'list') {
      const list = own().map((t) => ({ tabId: t.id, active: t.id === s.tabId,
        url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() }))
      s.tabIds = list.map((x) => x.tabId)                    // 顺手清掉已经没了的(用户手动关过)
      return { ok: true, tabs: list, activeTabId: s.tabId }
    }

    if (act === 'open') {
      const url = str(a && a.url)
      const pol = policyCheck(url)                            // 新标签一样过围栏
      if (!pol.ok) { step(s, 'tab-open', url, false, pol.err); return { error: pol.err } }
      if (s.tabIds.length >= 5) return { error: '一个会话最多 5 个标签(再多就该收口了 —— 验证不是浏览)' }
      let t = null
      try { t = newTab(url) } catch (e) { return { error: '开标签失败: ' + e.message } }
      const id = t && (t.id != null ? t.id : t)
      if (id == null) return { error: '开标签失败(没拿到标签 id)' }
      s.tabIds.push(id); s.tabId = id
      step(s, 'tab-open', url, true, '')
      try { await waitNetIdle(tabOf(s), 300, 4000) } catch {}
      return { ok: true, tabId: id, activeTabId: s.tabId, url: curUrl(s), hint: '已切到新标签 —— 后续 read/act 都作用在它上面' }
    }

    const tid = a && a.tabId != null ? a.tabId : null
    if (tid == null) return { error: 'switch / close 需要 tabId(用 action="list" 看有哪些)' }
    if (!s.tabIds.some((x) => String(x) === String(tid))) return { error: '这个标签不属于本会话 —— Agent 只能操作自己开的标签,用户手动开的页面不归你碰' }

    if (act === 'switch') {
      const t = (b.tabs || []).find((x) => String(x.id) === String(tid))
      if (!t) return { error: '这个标签已经没了(用 action="list" 刷新)' }
      s.tabId = t.id
      try { activateTab(t.id) } catch {}
      step(s, 'tab-switch', String(tid), true, '')
      return { ok: true, activeTabId: s.tabId, url: curUrl(s) }
    }

    if (act === 'close') {
      if (own().length <= 1) return { error: '这是本会话最后一个标签,关了后续什么都做不了 —— 要收口请用 browser_close' }
      try { closeTab(tid) } catch (e) { return { error: '关标签失败: ' + e.message } }
      s.tabIds = s.tabIds.filter((x) => String(x) !== String(tid))
      if (String(s.tabId) === String(tid)) { s.tabId = s.tabIds[s.tabIds.length - 1]; try { activateTab(s.tabId) } catch {} }
      step(s, 'tab-close', String(tid), true, '')
      return { ok: true, activeTabId: s.tabId, url: curUrl(s) }
    }
    return { error: '未知 action: ' + act + '(可用 list|open|switch|close)' }
  }

  // ── resize(仿 CC 的 resize_window:响应式 + 暗色)────────────────────────────
  // 【为什么值得有】设备模拟这套能力代码里【早就有】(BR_DEVICES + brLayout 按 device 宽度居中),
  // 只是从没暴露成工具 —— 于是"手机上布局崩没崩""暗色模式下看不看得清"这两类问题,Agent 一直验不了。
  // 【为什么不用 enableDeviceEmulation】browser.js:525 记着一条血的教训:那个原生调用在 WebContentsView 上
  // (尤其分屏 + 高 dpr backing store)会触发 GPU 原生崩溃、整窗/进程直接退出。
  // 所以走安全那条:只改视图边界让页面自己响应式重排 —— 效果一样,不碰会崩的 API。
  // 【暗色】走 CDP 的 Emulation.setEmulatedMedia(prefers-color-scheme),与设备模拟无关,不受上面那条约束。
  async function agentResize(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const out = {}
    const preset = str(a && a.preset).trim().toLowerCase()
    if (preset) {
      if (['desktop', 'mobile', 'tablet'].indexOf(preset) < 0) return { error: 'preset 只能是 desktop / mobile / tablet' }
      // brSetDevice 只作用于【活动标签】—— 会话标签未必在前台,先激活它再切
      // (激活自己的标签是无害的:这本来就是这个会话独占的那一页)
      try { activateTab(tab.id); brSetDevice(preset) } catch (e) { return { error: '切设备失败: ' + e.message } }
      out.preset = preset
    }
    const cs = str(a && a.colorScheme).trim().toLowerCase()
    if (cs) {
      if (['light', 'dark', 'no-preference'].indexOf(cs) < 0) return { error: 'colorScheme 只能是 light / dark / no-preference' }
      try {
        // 没附调试器就先附:暗色靠 CDP,不附着这条命令发不出去(而失败要说出来,不能静默不生效)
        const wc = tab.view.webContents
        if (!tab.dbg) { try { wc.debugger.attach('1.3'); tab.dbg = true } catch { /* 已附着就算了 */ } }
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cs }] })
        out.colorScheme = cs
      } catch (e) { return { error: '切配色失败(CDP 未就绪?): ' + e.message } }
    }
    if (!out.preset && !out.colorScheme) return { error: '给 preset(desktop/mobile/tablet)或 colorScheme(light/dark)至少一个' }
    step(s, 'resize', JSON.stringify(out), true, '')
    await new Promise((r) => setTimeout(r, 350))   // 给重排/重绘一点时间,紧接着的 read/shot 才是新布局
    return { ok: true, url: curUrl(s), applied: out, hint: '布局已切 —— 要看效果请再 browser_read 或 browser_shot 一次' }
  }

  // ── diag(仿 CC 的 read_console_messages / read_network_requests)──────────
  // 【原来的问题】一把抓:只给 level=3 的控制台 + 只给失败请求,各最后 30 条,不能过滤、取不到响应体。
  // 而排障真正要的是三件事:① 按关键词找那一条(报错信息通常已知一半);② 看成功请求(接口返回了
  // 什么才是问题所在,不是它有没有 200);③ 取某一条的响应体 —— 这一条最关键,"接口通了但返回体不对"
  // 是前端 bug 的大头,只看状态码永远看不见。
  // 【为什么默认值不变】不给参数时行为与老版一致(error + 失败请求),老调用不受影响。
  async function agentDiag(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const lim = Math.min(Math.max(+(a && a.limit) || 30, 1), 100)

    // ③ 取某一条响应体(按会话自己的 tab 取,不用 brNetBody —— 那个只认活动标签,会话标签未必在前台)
    const rid = a && a.requestId != null ? str(a.requestId) : ''
    if (rid) {
      const rec = tab.netById && tab.netById.get(rid)
      if (!rec) return { error: '没有这条请求(id 用 diag 列表里给的那个;列表只保留最近若干条)' }
      let body = null, base64 = false
      if (tab.dbg && (rec.state === 'done' || rec.status)) {
        try { const r = await tab.view.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: rid }); body = r.body; base64 = !!r.base64Encoded }
        catch (e) { body = '(无法获取响应体:' + e.message + ')' }
      } else body = '(这条还没收完或调试器未附着,拿不到响应体)'
      const cap = 20000   // 响应体给模型看要有预算:整包 400KB 灌进上下文比不给还坏
      let out = str(body)
      const cut = out.length > cap
      if (cut) out = out.slice(0, cap)
      return { ok: true, request: { id: rid, url: str(rec.url).slice(0, 300), method: rec.method, status: rec.status || 0, mime: rec.mime || '', size: rec.size || 0 },
        body: out, base64, truncated: cut ? ('响应体共 ' + str(body).length + ' 字,只给了前 ' + cap + ' 字') : '' }
    }

    // ① 控制台:level/关键词可筛
    const lvl = str((a && a.level) || 'error').toLowerCase()
    const wantLvl = lvl === 'all' ? null : lvl === 'warn' ? [2, 3] : [3]
    const pat = str(a && a.pattern).trim().toLowerCase()
    const allCon = arr(tab.console)
    const con = allCon.filter((e) => e && (!wantLvl || wantLvl.indexOf(e.level) >= 0)
      && (!pat || (str(e.message) + ' ' + str(e.source)).toLowerCase().indexOf(pat) >= 0))
    const errs = con.slice(-lim).map((e) => ({ level: e.level === 3 ? 'error' : e.level === 2 ? 'warn' : 'log',
      message: str(e.message).slice(0, 400), source: str(e.source).slice(0, 200), line: e.line || 0 }))

    // ② 网络:失败/全部 + url 关键词可筛;每条带 id,拿 id 再来取响应体
    const only = str((a && a.only) || 'failed').toLowerCase()
    const up = str(a && a.urlPattern).trim().toLowerCase()
    const allNet = arr(tab.net)
    const net = allNet.filter((r) => r
      && (only === 'all' || r.state === 'failed' || (r.status || 0) >= 400)
      && (!up || str(r.url).toLowerCase().indexOf(up) >= 0))
    const reqs = net.slice(-lim).map((r) => ({ id: r.id, status: r.status || 0, method: r.method,
      url: str(r.url).slice(0, 300), mime: r.mime || '', ms: Math.round(r.ms || 0), failText: str(r.failText).slice(0, 200) }))

    return { ok: true, url: curUrl(s),
      consoleErrors: errs, consoleShown: errs.length, consoleMatched: con.length, consoleTotal: allCon.length,
      consoleWarnCount: allCon.filter((e) => e && e.level === 2).length,
      failedRequests: reqs, requestsShown: reqs.length, requestsMatched: net.length, totalRequests: allNet.length,
      // 截断/筛掉了多少必须说出来:只给"最近 30 条"而不说,模型会当成"总共就这些"
      truncated: (con.length > errs.length ? ('控制台命中 ' + con.length + ' 条,只给了最近 ' + errs.length + ' 条;') : '')
        + (net.length > reqs.length ? ('请求命中 ' + net.length + ' 条,只给了最近 ' + reqs.length + ' 条;') : ''),
    }
  }

  // ── close:出报告 ────────────────────────────────────────────────────────
  function finish(s, status, note) {
    if (s.closed) return s.result
    s.closed = true
    const failed = s.asserts.filter((x) => !x.pass)
    const stepFail = s.steps.filter((x) => !x.ok)
    // verdict 由机器算,不接受调用方自述:有断言失败 / 有步骤失败 / 非正常收尾 → 一律不算 PASS。
    // 一条断言都没有也不算 PASS —— "打开看了一眼没报错"不是验证,那是浏览过。
    const verdict = status !== 'done' ? 'FAIL'
      : (failed.length || stepFail.length) ? 'FAIL'
      : s.asserts.length ? 'PASS' : 'INCONCLUSIVE'
    s.result = {
      sessionId: s.id, purpose: s.purpose, verdict, status, note: str(note).slice(0, 300),
      durationSec: Math.round((nowMs() - s.startedAt) / 1000),
      steps: s.steps, asserts: s.asserts, shots: s.shots.map((x) => x.path),
      assertPassed: s.asserts.length - failed.length, assertTotal: s.asserts.length,
      failures: [...failed.map((x) => '断言未过:' + x.label + ' —— ' + x.actual), ...stepFail.map((x) => '步骤失败:' + x.kind + ' ' + x.detail + ' —— ' + x.err)].slice(0, 20),
    }
    const t = tabOf(s)
    if (t) { try { closeTab(t.id) } catch {} }
    log('[browser-agent] 收会话 ' + s.id + ' → ' + verdict + ' (断言 ' + s.result.assertPassed + '/' + s.result.assertTotal + ', 步骤 ' + s.steps.length + ')')
    return s.result
  }
  function agentClose(a) {
    const s = sessions.get(str(a && a.sessionId))
    if (!s) return { error: '会话不存在' }
    if (s.closed) return { ok: true, report: s.result, note: '(已经收过了,返回原报告)' }
    const status = str(a && a.status) === 'failed' ? 'failed' : 'done'
    return { ok: true, report: finish(s, status, str(a && a.note)) }
  }

  /** 关卡/退出时兜底收摊:别把标签页和会话留成孤儿 */
  function dropAll(why) {
    for (const s of [...sessions.values()]) if (!s.closed) finish(s, 'failed', why || '壳层收摊')
    sessions.clear()
  }

  return { agentOpen, agentRead, agentFind, agentAct, agentTabs, agentResize, agentAssert, agentShot, agentDiag, agentClose, anyLive, dropAll, policyCheck, __sessions: sessions }
}
