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
  const { S, log, brActive, newTab, closeTab, activateTab, createBrowser, brScreenshot, execStep, waitNetIdle, pageRead } = ctx

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
      id, purpose, tabId: tab.id,
      startedAt: nowMs(), expiresAt: nowMs() + c.minutes * 60000,
      steps: [], asserts: [], shots: [], closed: false, result: null,
      netFrom: 0, conFrom: 0,   // 只统计本会话开始之后的网络/控制台(标签页是新开的,基线就是 0,留字段是为了将来复用已有标签)
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
    return { ok: true, url: curUrl(s), title: (snap && snap.title) || '', elements: (snap && snap.elements) || '',
      text: (snap && snap.text) || '', truncated: (snap && snap.truncated) || '' }
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
    else if (action === 'wait') {
      const ms = Math.min(Math.max(+a.ms || 800, 100), 5000)
      await new Promise((r) => setTimeout(r, ms))
      step(s, 'wait', ms + 'ms', true, '')
      return { ok: true, url: curUrl(s) }
    }
    else return { error: '未知 action: ' + action + '(可用 click|type|select|check|enter|navigate|wait)' }

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
      s.shots.push({ path: p, label: str(a && a.label).slice(0, 120), at: nowMs() - s.startedAt })
      step(s, 'shot', p, true, '')
      return { ok: true, path: p, note: '把这张图作为附件读一遍再下结论(带图消息会自动切到读图模型)' }
    } catch (e) { return { error: '截图失败: ' + e.message } }
  }

  function agentDiag(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const errs = (tab.console || []).filter((e) => e && e.level === 3).slice(-30)
      .map((e) => ({ message: str(e.message).slice(0, 400), source: str(e.source).slice(0, 200), line: e.line || 0 }))
    const warns = (tab.console || []).filter((e) => e && e.level === 2).length
    const bad = (tab.net || []).filter((r) => r && (r.state === 'failed' || r.status >= 400)).slice(-30)
      .map((r) => ({ status: r.status || 0, method: r.method, url: str(r.url).slice(0, 300), failText: str(r.failText).slice(0, 200) }))
    return { ok: true, url: curUrl(s), consoleErrors: errs, consoleWarnCount: warns, failedRequests: bad, totalRequests: (tab.net || []).length }
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

  return { agentOpen, agentRead, agentAct, agentAssert, agentShot, agentDiag, agentClose, anyLive, dropAll, policyCheck, __sessions: sessions }
}
