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
  const { S, log, brActive, newTab, closeTab, activateTab, createBrowser, ensureBrowserBackground, brScreenshot, brShotTab, execStep, waitNetIdle, pageRead, brSetDevice, showShot, callerWc, visionInfo, saveRec, readRec, skillList, askVision } = ctx

  const sessions = new Map()   // id → session

  function cfg() {
    const c = (S.settings && S.settings.browserAgent) || {}
    return {
      enabled: c.enabled !== false,                                  // 缺省开(只放行本机,已经足够安全)
      origins: Array.isArray(c.origins) ? c.origins.map(str) : [],   // 用户显式加白的站点(整串 origin,如 https://uat.example.com)
      fence: ['off', 'local', 'list'].includes(str(c.fence)) ? str(c.fence) : 'off',   // 缺省不限(2026-08-12 用户拍板)
      minutes: Math.min(Math.max(+c.minutes || DEFAULT_MINUTES, 1), MAX_MINUTES),
    }
  }

  /** 这个 URL 允许 Agent 自主操作吗?返回 {ok} 或 {ok:false, err:'…(带开通指引)'}
   *  ★围栏模式(2026-08-12 用户拍板"现在什么网站都应该可以访问"):
   *    settings.browserAgent.fence = 'off'(缺省,放行任意 http/https)| 'local'(只本机)| 'list'(只白名单)
   *    放开之后仍然保留两件事:① 只允许 http/https(file:/data: 永远不放行,那是读本地文件的口子)
   *    ② 每一次跨出本机的访问都【留痕】—— 权限可以放宽,痕迹不能少,否则出事时查不回来。 */
  function policyCheck(url) {
    const c = cfg()
    if (!c.enabled) return { ok: false, err: 'Agent 自主浏览器已被关闭(设置 → 浏览器 → Agent 自主会话)。仍可用录制技能回放。' }
    const o = originOf(url)
    if (!o) return { ok: false, err: '无法解析 URL 的 origin: ' + str(url).slice(0, 120) }
    let proto = ''
    try { proto = new URL(url).protocol } catch {}
    if (proto !== 'http:' && proto !== 'https:') return { ok: false, err: '只允许 http/https,拒绝: ' + proto + '(file:/data: 这类是读本地文件的口子,任何模式下都不放行)' }
    if (isLocal(url)) return { ok: true }
    if (c.fence === 'off') { log('[browser-agent] 访问外部站点(围栏已放开):' + o); return { ok: true } }
    if (c.origins.includes(o)) return { ok: true }
    if (c.fence === 'local') {
      return { ok: false, err: '围栏当前是【只本机】:' + o + ' 不放行。要放开请在 设置 → 浏览器 → Agent 自主会话 里把围栏改成"不限",或把这个站点加进允许清单。' }
    }
    return { ok: false, err: '围栏当前是【白名单】:' + o + ' 不在清单里。要放行请在 设置 → 浏览器 → Agent 自主会话 → 允许的站点 里加上「' + o + '」(或把围栏改成"不限")。' }
  }

  // ★时间盒改成【滑动的】(2026-08-12 真机最贵的一处):原来从 open 那一刻起固定 N 分钟,
  //   于是跑长流程必被腰斩 —— 日志实录「收会话 → FAIL (断言 0/0, 步骤 105)」:跑到第 105 步
  //   被自己的定时器收掉,紧接着两条工具调用报"会话不存在",模型只好重开一个会话【并重新登录】。
  //   时间盒的本意是防"开了忘关",不是防"正在干活":每来一次工具调用就续期,
  //   同时留一个绝对上限,跑飞了照样有个头。两种超时的说法也要分开,否则查不出是哪一种。
  const HARD_CAP_MS = 60 * 60000        // 绝对上限:再怎么续期也不能超过一小时
  function live(id, touch) {
    const s = sessions.get(str(id))
    if (!s || s.closed) return null
    const now = nowMs()
    if (now > s.hardExpiresAt) {
      finish(s, 'timeout', '会话总时长到顶(' + Math.round(HARD_CAP_MS / 60000) + ' 分钟)—— 这么长通常是跑飞了,重开一个并缩小目标')
      return null
    }
    if (now > s.expiresAt) {
      finish(s, 'timeout', '会话空闲超时(' + Math.round(cfg().minutes) + ' 分钟没有任何操作)—— 只要还在操作就会自动续期,这条说明它真的停了')
      return null
    }
    if (touch !== false) s.expiresAt = now + cfg().minutes * 60000   // 有动作 = 还在干活,续期
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
  // ── 召回:这个站点是不是已经有人(或它自己)跑通过 ────────────────────────────
  // 【沉淀的价值全在这一半】用户原话:"试错了很多次后跑通了,还是没法在其他会话中复用"。
  // 只存不召回等于没沉淀 —— 技能库里明明躺着一条现成的,模型也不会主动去 skill_list 翻,
  // 它会当零起点重新试错一遍。所以【开会话时把匹配结果推到它眼前,放回执第一行】。
  // 按 host 匹配就够了:同一个系统的路径千变万化,host 是唯一稳定的锚。
  const hostOf = (u) => { try { return new URL(str(u)).host.toLowerCase() } catch { return '' } }
  function recallFor(url) {
    const h = hostOf(url); if (!h) return []
    let all = []; try { all = skillList ? (skillList() || []) : [] } catch { return [] }
    return all.filter((k) => hostOf(k.startUrl) === h)
      .sort((x, y) => ((y.runs || 0) - (x.runs || 0)) || ((+new Date(y.lastRun || 0) || 0) - (+new Date(x.lastRun || 0) || 0)))
      .slice(0, 3)
  }
  function recallNote(url) {
    const ks = recallFor(url)
    if (!ks.length) return ''
    return '★这个站点已经有 ' + ks.length + ' 条沉淀好的流程:\n'
      + ks.map((k) => '  · ' + k.id + ' 「' + k.name + '」' + k.steps + ' 步'
        + (k.runs > 1 ? ' 跑通过 ' + k.runs + ' 次' : '')
        + (k.auto ? '(自动存的,名字是当时的 purpose 凑的,未经确认)' : '')
        + (k.params && k.params.length ? '(参数:' + k.params.map((x) => x.key).join(',') + ')' : '')
        + (k.description ? ' —— ' + str(k.description).slice(0, 80) : '')).join('\n')
      + '\n【先用 skill_run 跑现成的这条】,别从零试错一遍 —— 它已经带选择器自愈,比你现场猜稳。'
      + '只有确认它办不了你这件事,才自己动手。'
  }

  // ── 自动沉淀:不指望模型自觉 ─────────────────────────────────────────────────
  // 【上一版错在哪】三处提示全是"推给模型、靠它自己调 save_flow"——也就是【一步都不自动】。
  // 模型不调就永久丢掉,而"试错半小时跑通、下个会话从零再来"正是用户报的那个问题本身。
  // 靠自觉的机制在这条链路上不成立:它把流程试通时上下文已经很满,收尾那一步最容易被省掉。
  // 所以改成:收会话时【壳层自己先存一份】,模型愿意的话再来认领、改个准名字。
  //
  // 会不会把技能库堆满?按【动作指纹】存:同一个站点 + 同一串动作 → 同一个 id,重跑只覆盖并 runs+1。
  // 同一条路跑 20 次,库里还是一条,而 runs=20 恰好说明它最常用(召回时优先推它)。
  // 密码不会泄:flow 入栈时密码步就已经标 secret、删掉了 value(见 act 里那段),自动存也拿不到明文。
  const fp8 = (t) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = (h * 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') }
  function flowFp(s) {
    const host = hostOf((arr(s.flow)[0] || {}).url || curUrl(s))
    return fp8(host + '|' + arr(s.flow).map((e) => e.act + ':' + str(e.sel || e.url || e.key || '').slice(0, 60)).join('>'))
  }
  function autoSediment(s, verdict) {
    const id = 'auto-' + flowFp(s)
    let prev = null; try { prev = readRec ? readRec(id) : null } catch {}
    const claimed = !!(prev && prev.auto === false)   // 已被认领过:不许把人起的名字覆盖回 purpose
    const rec = {
      id,
      title: claimed ? prev.title : (str(s.purpose).slice(0, 60) || 'Agent 跑过的流程'),
      description: claimed ? prev.description : ('自动沉淀:' + str(s.purpose).slice(0, 200) + '(判定 ' + verdict + ')'),
      startUrl: (arr(s.flow)[0] || {}).url || curUrl(s),
      skill: true, auto: !claimed, createdBy: 'agent-auto',
      createdAt: (prev && prev.createdAt) || new Date().toISOString(),
      runs: ((prev && +prev.runs) || 0) + 1,
      events: arr(s.flow), params: (prev && prev.params) || [],
    }
    try { saveRec(rec) } catch (e) { log('[browser-agent] 自动沉淀失败: ' + e.message); return null }
    s.autoId = id
    log('[browser-agent] 自动沉淀 ' + id + ' 「' + rec.title + '」' + rec.events.length + ' 步(第 ' + rec.runs + ' 次)')
    return rec
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
    for (const s of [...sessions.values()]) live(s.id, false)   // ★清扫用,不许顺手续期(会把别人的空闲计时抹掉)
    const liveN = [...sessions.values()].filter((s) => !s.closed).length
    if (liveN >= MAX_SESSIONS) return { error: '同时最多 ' + MAX_SESSIONS + ' 个自主浏览器会话(每个占一个标签页),先 browser_close 收掉一个再开' }

    // ★后台起浏览器,不抢屏(2026-08-11 用户连着两次"又把我的会话毁掉了"):
    //   老写法 createBrowser() 在宿主模式下第一句就是 shellBrowserVisible(true) —— 浏览器 chrome
    //   加那张写死的「调试助手」卡一起挂到主窗上,把用户正在看的对话盖掉。
    //   浏览器是对话的辅助能力,Agent 用它不该让用户的对话消失。
    //   标签仍然在标签条上列着,用户想看它在干什么点过去就行(可看性没被抹掉,只是不再强塞)。
    try { ensureBrowserBackground() } catch (e) { return { error: '打不开浏览器: ' + e.message } }
    const tab = newTab(url, { background: true })
    if (!tab) return { error: '开标签页失败(浏览器窗口没起来)' }
    const c = cfg()
    const id = 'bs_' + nowMs().toString(36) + '_' + Math.floor(Math.random() * 1e4).toString(36)
    const s = {
      id, purpose, tabId: tab.id, tabIds: [tab.id],   // tabId=活动标签(其余代码照旧只认它);tabIds=本会话拥有的全部
      startedAt: nowMs(), expiresAt: nowMs() + c.minutes * 60000, hardExpiresAt: nowMs() + HARD_CAP_MS,
      steps: [], asserts: [], shots: [], closed: false, result: null,
      // ★可回放的动作流(2026-08-12 用户:"试错很多次跑通了,却没法在别的会话复用")。
      // steps 是给人看的流水(带失败、带 read/shot 这些不可回放的动作),flow 是给机器回放的:
      // 只记【成功的、真会改变页面状态的】那几种,形状与录制技能的 events 完全一致 ——
      // 这样存下来就能直接进技能库,复用现成的回放引擎(选择器自愈/参数化/skill_run),不另造一套。
      flow: [{ act: 'navigate', url }],
      recent: [],   // 最近几次动作的指纹(原地打转检测用,见 loopGuard)
      netFrom: 0, conFrom: 0,   // 只统计本会话开始之后的网络/控制台(标签页是新开的,基线就是 0,留字段是为了将来复用已有标签)
      // ★开会话时就钉住"是哪张对话卡在调我":截图要摆回【那张】卡。
      // 会话能开十分钟,期间别的卡也会忙起来 —— 到截图时再现算就会推给错的人。
      wc: (typeof callerWc === 'function' ? (() => { try { return callerWc() } catch { return null } })() : null),
    }
    sessions.set(id, s)
    try { await installDialogGuard(tab) } catch (e) { log('[browser-agent] 弹窗守卫装不上: ' + e.message) }
    step(s, 'open', url, true, '')
    log('[browser-agent] 开会话 ' + id + ' → ' + url + ' (' + purpose + ')')
    // 等页面基本安定再交给 Agent,省得它第一步读到空白页
    try { await waitNetIdle(tab, 400, 6000) } catch {}

    // ★★主文档没打开就必须【报错】,不许回 ok(2026-08-11 真机,用户说"截图毁了"):
    //   dev server 没起来,主文档 ERR_CONNECTION_REFUSED,而 open 照样回 ok:true —— 只是
    //   elements/text 是空的。模型于是接着截图,拿到一张全白的图,再对用户说"已启动并截图"。
    //   用户看到的是一张白图,而真因("端口上没有服务")在三层之外。
    //   "打开失败"和"页面是空的"必须在【第一步】就分开,这是整条链路的地基。
    const mainFail = arr(tab.net).find((r) => r && r.state === 'failed'
      && (str(r.url) === url || str(r.url).replace(/\/$/, '') === url.replace(/\/$/, '')))
    if (mainFail) {
      const why = str(mainFail.failText) || '加载失败'
      closeTab(tab.id); sessions.delete(id)
      const refused = /CONNECTION_REFUSED/i.test(why)
      return { error: '页面没打开:' + why + '(' + url + ')'
        + (refused
          ? ' —— 这个端口上没有服务在听。先确认服务起没起(preview_start / 看进程),'
            + '另外注意 127.0.0.1 与 localhost 【不是一回事】:有的 dev server 只监听 IPv6 的 ::1,'
            + '那时 localhost 通、127.0.0.1 被拒;反过来也有。两个都试一下再下结论。'
          : ' —— 先把这一层修好再谈页面内容,现在读到的任何"空页面"都只是这条错误的影子。') }
    }

    let snap = null
    try { snap = await pageRead(tab) } catch {}
    // 打开了但页面是【空壳】(SPA 没挂载):也要明说,别让模型把空页当"这页就是没东西"
    const emptyish = !str(snap && snap.elements).trim() && str(snap && snap.text).trim().length < 8
    return {
      ok: true, sessionId: id, expiresInSec: Math.round((s.expiresAt - nowMs()) / 1000),
      ...(recallNote(url) ? { recall: recallNote(url) } : {}),
      ...(emptyish ? { warning: '页面打开了,但一个可交互元素、几乎一个字都没有 —— 多半是 SPA 还没挂载完,'
        + '或者这个端口上跑的【不是你以为的那个项目】(端口冲突很常见)。'
        + '先 browser_eval 看一眼 document.title / location.href / #app 的内容再往下走,别急着截图。' } : {}),
      url: curUrl(s), title: (snap && snap.title) || '', elements: (snap && snap.elements) || '', text: (snap && String(snap.text || '').slice(0, 3000)) || '',
      note: '标签页已开,用户看得见(在标签条上,点过去就能看)。做完必须调 browser_close 出报告 —— '
        + '流程会在 browser_close 时【自动沉淀】进技能库,你不用记着存;想给它起个准名字再调 browser_save_flow。',
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
    const dlgs = arr(await dialogsOf(tab)).slice(-5)
    const ee = str(snap && snap.elemErr)
    return { ok: true, url: curUrl(s), title: (snap && snap.title) || '', elements: (snap && snap.elements) || '',
      text: (snap && snap.text) || '', truncated: (snap && snap.truncated) || '',
      // 弹窗是"悄悄发生然后改变一切"的东西:出现过就必须说,否则模型会对着一个被拦掉的操作继续推
      ...(dlgs.length ? { dialogs: dlgs.map((d) => d.kind + '「' + d.text + '」→ ' + (d.answered || '已忽略')) } : {}),
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
    // ★原地打转要拦在执行【之前】—— 拦在之后那 4 秒等待照样白烧,而那正是最贵的部分
    {
      const stuck = loopGuard(s, action, a.ref != null ? a.ref : a.selector, a.value)
      if (stuck) { step(s, action, str(a.selector || a.ref), false, '原地打转已拦下'); return { error: stuck } }
    }
    // ★ref 优先(仿 CC:read_page 给句柄、后续动作用句柄,模型不用拼选择器也就不会拼错)。
    //   ref 由 skillPageRead 盖在 DOM 上的 data-bh-ref 属性支撑 → 解析成精确唯一选择器。
    //   页面刷新/重渲染后属性就没了:那时 execStep 会找不到元素并报错,而不是【悄悄点到别的元素上】——
    //   后者才是最坏的结果(动作成功、点的却不是它以为的那个)。回执直接告诉它重新 browser_read。
    const refRaw = a.ref != null ? str(a.ref).trim() : ''
    const refN = refRaw ? (refRaw.match(/^(?:ref_)?(\d+)$/) || [])[1] : ''
    if (refRaw && !refN) return { error: 'ref 形如 ref_3 或 3(browser_read 返回的那个);要用选择器请填 selector' }
    // ★把填进 selector 的 ref 也认了(2026-08-11 真机):browser_read 回的是「[ref_58] textbox "…"」,
    //   模型很自然地写 selector:"ref_58" —— 而这里原来只认独立的 ref 参数,于是 ref_58 被当成 CSS 选择器
    //   丢给 querySelector,必然找不到,然后它开始瞎猜 .el-dialog .frow:nth-of-type(3) …(实测连猜 4 次全废)。
    //   工具不该因为"参数填错格子"就惩罚模型 —— 这个意图毫无歧义,认下来就是。
    const selRaw = a.selector != null ? str(a.selector).trim() : ''
    const selRefN = (selRaw.match(/^ref[_-]?(\d+)$/i) || [])[1]
    const sel = refN ? '[data-bh-ref="' + refN + '"]'
      : selRefN ? '[data-bh-ref="' + selRefN + '"]'
        : selRaw.slice(0, 1000)
    const wc = tab.view.webContents

    // navigate 特殊:要先按【目标 URL】过策略,再执行(不能等跳过去了才发现越界)
    if (action === 'navigate') {
      const target = str(a.url)
      const pol = policyCheck(target)
      if (!pol.ok) { step(s, 'navigate', target, false, pol.err); return { error: pol.err } }
      const r = await execStep(wc, { act: 'navigate', url: target }, tab, { waitMs: 8000 })
      step(s, 'navigate', target, !!r.ok, r.err)
      if (r.ok) s.flow.push({ act: 'navigate', url: target })
      try { await waitNetIdle(tab, 300, 4000) } catch {}
      return r.ok ? { ok: true, url: curUrl(s) } : { error: r.err || '导航失败' }
    }
    // 其余动作:按当前页现查围栏(不变量①)
    const f = fenceNow(s)
    if (!f.ok) { step(s, action, sel, false, f.err); return { error: f.err } }

    let ev = null
    if (action === 'click') ev = { act: 'click', sel, selAlt: [] }
    else if (action === 'type') ev = { act: 'input', sel, selAlt: [], value: str(a.value).slice(0, 500) }
    else if (action === 'select') {
      // ★组件库的下拉不是原生 <select>(Element-Plus 的 el-select 是 div + 浮层列表),
      //   原生 select 那条路对它完全无效。真机里模型只能"点触发器 → read → 在浮层里找选项 → 点",
      //   一个下拉三次往返,而这套表单里下拉极多。
      //   这里先看它到底是不是原生:是就走原生;不是就在页面里【一次做完】展开+按文本选中,
      //   省掉那两次往返,也省掉模型自己去猜浮层的 class。
      const want = str(a.text || a.value).slice(0, 60)
      const native = await wc.executeJavaScript('(function(){try{var e=document.querySelector('
        + JSON.stringify(sel) + ');return !!e&&e.tagName===\'SELECT\'}catch(err){return false}})()', true).catch(() => false)
      if (!native) {
        if (!want) return { error: 'select 非原生下拉时要给 text(要选的那一项的文字)' }
        const r2 = await comboSelect(wc, sel, want)
        step(s, 'select', sel + ' → ' + want, !!r2.ok, r2.err)
        try { await waitNetIdle(tab, 300, 2500) } catch {}
        return r2.ok ? { ok: true, url: curUrl(s), picked: r2.picked }
          : { error: str(r2.err) + ' —— 这是组件库的下拉(不是原生 select)。可以先 browser_act{action:"click"} 点开它,'
            + '再 browser_read 看浮层里有哪些项,然后按 ref 点。' }
      }
      ev = { act: 'select', sel, selAlt: [], value: str(a.value).slice(0, 200), text: str(a.text).slice(0, 60) }
    }
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
    else if (action === 'scroll' || action === 'wheel') {
      const dir = (str(a.direction) || 'down').toLowerCase()
      const amt = Math.min(Math.max(+a.amount || 600, 50), 5000)
      const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0
      const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0
      // scroll + 给了 ref/selector = "滚到这个元素"(老语义,不动)
      if (action === 'scroll' && sel) {
        let r2 = null
        try {
          r2 = await wc.executeJavaScript('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');'
            + 'if(!e)return {err:\'找不到元素\'};e.scrollIntoView({block:\'center\',inline:\'center\'});return {ok:1}})()', true)
        } catch (e) { r2 = { err: e.message } }
        const bad2 = r2 && r2.err
        step(s, 'scroll', sel, !bad2, bad2 || '')
        return bad2 ? { error: bad2 } : { ok: true, url: curUrl(s), scrolled: '已滚到元素' }
      }
      // ★其余情况:发【真滚轮】+ 内层容器兜底(2026-08-12 用户问"是不是还没有鼠标滚轮")
      //   原来无 ref 时只有 window.scrollBy,两件事都做不了:
      //   ① 内层滚动容器(overflow:auto 的表格体 / el-scrollbar / 弹层 / 虚拟列表)一动不动 ——
      //      业务系统里真正要滚的几乎都是它们,而不是 document;
      //   ② 依赖 wheel 事件的组件(虚拟滚动、无限加载、自定义滚动条、地图缩放)收不到任何信号。
      //   所以:先在目标位置发真 mouseWheel(让监听器有机会响应),再回读位移;
      //   没动就找【最近的可滚动祖先 / 页面上最大的可滚动容器】直接设 scrollTop 兜底。
      //   回执如实说"滚的是谁、位移多少、到底了没有" —— 滚不动和到底了是两回事。
      let at = { x: 720, y: 450 }
      if (sel) {
        try {
          const box = await wc.executeJavaScript('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');'
            + 'if(!e)return null;var r=e.getBoundingClientRect();if(!r.width&&!r.height)return null;'
            + 'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()', true)
          if (box) at = box
        } catch {}
      }
      const before = await scrollPos(wc, sel)
      // 先试真实输入事件:标签页在前台时它最"真"。★后台标签收不到(实测 wheel 监听器计数为 0),
      // 所以它只是锦上添花,真正干活的是下面那条合成事件 + 直接滚。
      try { wc.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: -dx, deltaY: -dy, canScroll: true }) }
      catch (e) { log('[browser-agent] 真实滚轮事件发不出去(' + e.message + ')') }
      await new Promise((r) => setTimeout(r, 100))
      let after = await scrollPos(wc, sel)
      let how = '真实滚轮'
      if (!before || !after || before.pos === after.pos) {
        const r3 = await scrollByJs(wc, sel, dx, dy)
        if (r3 && r3.no) {
          step(s, action, (sel || dir) + ' ' + amt, false, '没有可滚动的容器')
          return { error: '这个位置没有可滚动的容器 —— 先 browser_read 或 browser_eval 确认要滚的是哪一块,'
            + '再把那块的 ref/selector 给我(业务系统里真正带滚动条的几乎都是内层容器,不是整页)' }
        }
        await new Promise((r) => setTimeout(r, 60))
        after = await scrollPos(wc, sel)
        how = '合成 wheel 事件 + 直接滚(后台标签收不到真实输入事件)'
      }
      const moved = before && after ? Math.abs(after.pos - before.pos) : 0
      const atEnd = !!(after && after.atEnd)
      step(s, action, (sel || dir) + ' ' + amt, true, '')
      return { ok: true, url: curUrl(s), how, target: (after && after.what) || '(未知)',
        moved, atEnd,
        scrolled: moved ? ('已滚动 ' + moved + 'px(' + how + ',对象:' + ((after && after.what) || '?') + ')')
          : (atEnd ? '没动 —— 已经到底/到顶了' : '没动 —— 这个位置没有可滚动的容器,换个 ref 再试(或先 browser_read 确认要滚的是哪块)') }
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
      // ★后台标签【收不到真实输入事件】(滚轮那次实测:监听器计数为 0)—— 所以真实事件只是
      //   标签在前台时的锦上添花,真正让浮层出来的是下面这组合成事件。
      try { wc.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y }) } catch {}
      try {
        await wc.executeJavaScript('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(!e)return 0;'
          + 'var r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;'
          + 'var o={bubbles:true,cancelable:true,clientX:x,clientY:y};'
          + '["pointerover","mouseover","pointerenter","mouseenter","pointermove","mousemove"].forEach(function(t){'
          + 'try{e.dispatchEvent(new MouseEvent(t,o))}catch(err){}});return 1})()', true)
      } catch (e) { return { error: '悬停失败: ' + e.message } }
      await new Promise((r) => setTimeout(r, 250))   // 给悬浮层一点出现时间,否则紧接着的 read 读不到它
      step(s, 'hover', sel, true, '')
      return { ok: true, url: curUrl(s), hint: '已悬停 —— 悬浮层通常要再 browser_read 一次才看得到' }
    }
    else if (action === 'wait') {
      // ★等【条件】,不是等时间(2026-08-12):原来只能盲睡,而真实卡点是"提交后 loading 什么时候消失"、
      //   "表格什么时候刷出来"、"跳转什么时候完成"—— 睡短了假失败,睡长了白等,两头都亏。
      //   给了 until/urlContains 就轮询到条件成立;什么都不给才退回定时睡(老行为不断)。
      const cap = Math.min(Math.max(+a.ms || 800, 100), 30000)
      const until = str(a.until).toLowerCase()          // visible | hidden | gone
      const urlPart = str(a.urlContains)
      if (!until && !urlPart) {
        await new Promise((r) => setTimeout(r, Math.min(cap, 5000)))
        step(s, 'wait', cap + 'ms', true, '')
        return { ok: true, url: curUrl(s), waited: cap + 'ms(定时)' }
      }
      if (until && !sel) return { error: 'until=' + until + ' 要配 ref 或 selector(等哪个元素)' }
      const t0 = nowMs()
      let hit = false, last = ''
      while (nowMs() - t0 < cap) {
        if (urlPart) { if (str(curUrl(s)).indexOf(urlPart) >= 0) { hit = true; break } last = curUrl(s) }
        if (until) {
          let st2 = null
          try {
            st2 = await wc.executeJavaScript('(function(){var e=null;try{e=document.querySelector('
              + JSON.stringify(sel) + ')}catch(err){return "bad"}'
              + 'if(!e)return "gone";var r=e.getBoundingClientRect();'
              + 'var cs=getComputedStyle(e);'
              + 'return (r.width||r.height)&&cs.visibility!=="hidden"&&cs.display!=="none"?"visible":"hidden"})()', true)
          } catch (e) { st2 = 'bad' }
          if (st2 === 'bad') return { error: '选择器不合法: ' + sel }
          last = str(st2)
          if ((until === 'visible' && st2 === 'visible')
            || (until === 'hidden' && (st2 === 'hidden' || st2 === 'gone'))
            || (until === 'gone' && st2 === 'gone')) { hit = true; break }
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      const took = nowMs() - t0
      step(s, 'wait', (until || ('url~' + urlPart)) + ' ' + (hit ? '命中' : '超时'), hit, hit ? '' : '等了 ' + took + 'ms 仍未满足')
      if (hit) return { ok: true, url: curUrl(s), waited: took + 'ms', met: until || ('url 含 ' + urlPart) }
      return { error: '等了 ' + took + 'ms,条件仍未满足(当前:' + (last || '未知') + ')'
        + ' —— 别再等同一个条件了:用 browser_read 看这一刻页面到底是什么样,'
        + '或 browser_diag 看有没有请求失败(等不到往往是那一步根本没成功,不是慢)' }
    }
    else if (action === 'back' || action === 'forward') {
      // 表单流程里"返回上一步"很常见;原来只能重新 navigate —— 那会丢掉页面状态
      const can = action === 'back' ? wc.canGoBack() : wc.canGoForward()
      if (!can) return { error: action === 'back' ? '没有可后退的历史(这是第一页)' : '没有可前进的历史' }
      try { if (action === 'back') wc.goBack(); else wc.goForward() } catch (e) { return { error: e.message } }
      try { await waitNetIdle(tab, 300, 5000) } catch {}
      step(s, action, curUrl(s), true, '')
      s.flow.push({ act: 'navigate', url: curUrl(s) })   // 沉淀时按"导航到那个地址"回放,比重放历史稳
      return { ok: true, url: curUrl(s) }
    }
    else if (action === 'drag') {
      // ★拖拽:排序、拖放上传、滑块、看板拖卡都要它。
      //   两套机制必须都发 —— 库不同做法完全不同:
      //   · HTML5 原生 DnD(draggable + dragstart/dragover/drop):要带 DataTransfer,少一个事件就不落地;
      //   · 鼠标模拟(sortablejs / el-slider / 大部分自研拖拽):认 pointerdown/mousemove/mouseup,
      //     而且【中间必须有多个 move】—— 只发首尾两个,判"拖动了没有"的阈值过不去,表现是"点了一下没拖动"。
      //   后台标签收不到真实输入事件(实测),所以全部走合成事件。
      const toSel = (() => {
        const tr = a.toRef != null ? str(a.toRef).trim() : ''
        const trN = tr ? (tr.match(/^(?:ref[_-]?)?(\d+)$/i) || [])[1] : ''
        if (trN) return '[data-bh-ref="' + trN + '"]'
        const ts = a.toSelector != null ? str(a.toSelector).trim() : ''
        const tsN = (ts.match(/^ref[_-]?(\d+)$/i) || [])[1]
        return tsN ? '[data-bh-ref="' + tsN + '"]' : ts
      })()
      const ddx = +a.dx || 0, ddy = +a.dy || 0
      if (!sel) return { error: 'drag 要给源元素(ref 或 selector)' }
      if (!toSel && !ddx && !ddy) return { error: 'drag 要给目标:toRef/toSelector(拖到哪个元素上),或者 dx/dy(相对位移,如滑块)' }
      let r2 = null
      try {
        r2 = await wc.executeJavaScript('(function(){'
          + 'var a1=document.querySelector(' + JSON.stringify(sel) + ');if(!a1)return {err:"找不到源元素"};'
          + 'var b1=' + (toSel ? 'document.querySelector(' + JSON.stringify(toSel) + ')' : 'null') + ';'
          + (toSel ? 'if(!b1)return {err:"找不到目标元素"};' : '')
          + 'function C(e){var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}}'
          + 'var p1=C(a1);var p2=b1?C(b1):{x:p1.x+' + ddx + ',y:p1.y+' + ddy + '};'
          + 'function mk(t,x,y,extra){var o={bubbles:true,cancelable:true,clientX:x,clientY:y,buttons:1};'
          + 'if(extra)for(var k in extra)o[k]=extra[k];'
          + 'try{return new MouseEvent(t,o)}catch(e){var ev=document.createEvent("MouseEvent");ev.initMouseEvent(t,true,true,window,0,0,0,x,y,false,false,false,false,0,null);return ev}}'
          + 'var dt=null;try{dt=new DataTransfer()}catch(e){dt={data:{},setData:function(k,v){this.data[k]=v},getData:function(k){return this.data[k]},items:[],files:[],effectAllowed:"all",dropEffect:"move"}}'
          + 'function dnd(t,el,x,y){var e2;try{e2=new DragEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,dataTransfer:dt})}catch(err){e2=mk(t,x,y);try{e2.dataTransfer=dt}catch(e3){}}el.dispatchEvent(e2)}'
          + 'a1.dispatchEvent(mk("pointerdown",p1.x,p1.y));a1.dispatchEvent(mk("mousedown",p1.x,p1.y));'
          + 'dnd("dragstart",a1,p1.x,p1.y);'
          // ★中间步:少了它,拖动阈值过不去 —— 表现成"点了一下没拖动"
          + 'var N=8;for(var i=1;i<=N;i++){var x=p1.x+(p2.x-p1.x)*i/N,y=p1.y+(p2.y-p1.y)*i/N;'
          + 'document.dispatchEvent(mk("pointermove",x,y));document.dispatchEvent(mk("mousemove",x,y));'
          + 'var over=document.elementFromPoint(x,y)||(b1||a1);dnd("dragover",over,x,y)}'
          + 'var tgt=b1||document.elementFromPoint(p2.x,p2.y)||a1;'
          + 'dnd("drop",tgt,p2.x,p2.y);'
          + 'tgt.dispatchEvent(mk("pointerup",p2.x,p2.y));tgt.dispatchEvent(mk("mouseup",p2.x,p2.y));'
          + 'dnd("dragend",a1,p2.x,p2.y);'
          + 'return {ok:1,from:[Math.round(p1.x),Math.round(p1.y)],to:[Math.round(p2.x),Math.round(p2.y)]}})()', true)
      } catch (e) { r2 = { err: e.message } }
      const bad3 = r2 && r2.err
      step(s, 'drag', sel + ' → ' + (toSel || ('+' + ddx + ',' + ddy)), !bad3, bad3 || '')
      loopNote(s, action, sel, toSel, !bad3)
      if (bad3) return { error: bad3 }
      s.flow.push({ act: 'drag', sel, selAlt: [], toSel, dx: ddx, dy: ddy })
      try { await waitNetIdle(tab, 300, 2500) } catch {}
      return { ok: true, url: curUrl(s), from: r2.from, to: r2.to,
        note: '两套机制都发了(HTML5 DnD + 鼠标模拟,中间带 8 个移动步)。拖完【务必再 browser_read 或 browser_eval 核一下结果】——'
          + '合成事件能不能被那个库认下来,只有看结果才知道,不能凭"没报错"当成拖成功了。' }
    }
    else if (action === 'point') {
      // ★坐标点击:canvas / 地图 / 图表内部【没有 DOM 元素可选】,只能按坐标点。
      //   给了 ref/selector 就以它为原点(x/y 是相对偏移),不给就按视口绝对坐标 ——
      //   相对偏移稳得多:窗口一变,绝对坐标就全错。
      const px = +a.x || 0, py = +a.y || 0
      let r2 = null
      try {
        r2 = await wc.executeJavaScript('(function(){'
          + 'var base={x:0,y:0};'
          + (sel ? 'var e0=document.querySelector(' + JSON.stringify(sel) + ');if(!e0)return {err:"找不到基准元素"};'
            + 'var r0=e0.getBoundingClientRect();base={x:r0.left,y:r0.top};' : '')
          + 'var x=base.x+' + px + ',y=base.y+' + py + ';'
          + 'var el=document.elementFromPoint(x,y);if(!el)return {err:"这个坐标上没有元素(x="+Math.round(x)+" y="+Math.round(y)+",可能超出了视口)"};'
          + 'function mk(t){var o={bubbles:true,cancelable:true,clientX:x,clientY:y,buttons:1};'
          + 'try{return new MouseEvent(t,o)}catch(e){var ev=document.createEvent("MouseEvent");ev.initMouseEvent(t,true,true,window,0,0,0,x,y,false,false,false,false,0,null);return ev}}'
          + '["pointerdown","mousedown","pointerup","mouseup","click"].forEach(function(t){el.dispatchEvent(mk(t))});'
          + 'return {ok:1,at:[Math.round(x),Math.round(y)],hit:(el.tagName||"").toLowerCase()+(el.className?"."+String(el.className).split(" ")[0]:"")}})()', true)
      } catch (e) { r2 = { err: e.message } }
      const bad4 = r2 && r2.err
      step(s, 'point', (sel ? sel + ' ' : '') + px + ',' + py, !bad4, bad4 || '')
      loopNote(s, action, sel + ':' + px + ',' + py, '', !bad4)
      if (bad4) return { error: bad4 }
      return { ok: true, url: curUrl(s), at: r2.at, hit: r2.hit,
        note: '点在 ' + r2.hit + ' 上(clientX/clientY 已带上,canvas 的处理器读的就是这两个值)。'
          + (sel ? '' : '★没给基准元素时用的是视口绝对坐标 —— 窗口一变就全错,能给 ref 就给。') }
    }
    else if (action === 'dialog') {
      // 预置【下一个】原生弹窗的答案。一次只管一个 —— 不设成常驻是刻意的:
      // "以后所有 confirm 都点确定"这种设置,踩到删除确认时就是灾难。
      let r2 = 0
      try { r2 = await wc.executeJavaScript(armDialogJs(a.accept !== false, a.text), true) } catch {}
      if (!r2) return { error: '这一页的弹窗守卫还没装上(通常是页面刚跳转);先 browser_read 一次再试' }
      step(s, 'dialog', (a.accept !== false ? '确定' : '取消') + (a.text ? ' ' + str(a.text).slice(0, 40) : ''), true, '')
      return { ok: true, armed: (a.accept !== false ? '确定' : '取消'),
        note: '只对【下一个】弹窗生效。做完那个动作后建议 browser_read 一次,回执里能看到弹窗实际问了什么。' }
    }
    else return { error: '未知 action: ' + action + '(可用 click|type|select|check|enter|key|scroll|hover|navigate|wait)' }

    const r = await execStep(wc, ev, tab, { waitMs: 4000 })
    step(s, action, sel + (action === 'type' ? ' ← ' + str(a.value).slice(0, 40) : ''), !!r.ok, r.err)
    try { await waitNetIdle(tab, 300, 2500) } catch {}
    loopNote(s, action, sel, ev.value, !!r.ok)
    if (r.ok) {
      // 只把【会改变页面状态】的动作记进可回放流(scroll/wheel/hover 是辅助动作,回放时不必要)
      if (['click', 'input', 'select', 'check', 'key', 'submit'].includes(ev.act)) {
        const keep = { act: ev.act, sel: ev.sel, selAlt: [] }
        if (ev.value != null) keep.value = ev.value
        if (ev.text) keep.text = ev.text
        if (ev.key) keep.key = ev.key
        if (ev.checked != null) keep.checked = ev.checked
        // 密码不落明文(与录制同一条口径):标 secret,回放时要求现场提供
        if (/password/i.test(str(ev.sel)) || /密码/.test(str(ev.sel))) { keep.secret = true; delete keep.value }
        s.flow.push(keep)
      }
      return { ok: true, url: curUrl(s) }
    }
    // ★"找不到元素"的回执必须【指出下一步】。真机 2026-08-11:回执只有一句
    //   「selector(+alt) not found (waited 4000ms)」,模型于是接着猜 —— 连猜 4 个
    //   .el-dialog .frow:nth-of-type(3) .el-form 这种选择器,每次白等 4 秒,最后被用户掐掉。
    //   它不是不听话,是回执没告诉它"别猜、回去重读"。ref 句柄这条路存在的全部意义就是不用猜,
    //   而弹层/新页面出现后必须重读一次才有新句柄 —— 这句话得由工具说出来。
    const notFound = /not found|找不到/.test(str(r.err))
    return { error: str(r.err || '执行失败') + (notFound
      ? ' —— 别再换选择器猜了(猜错的代价是点到别的元素上还成功)。正确的下一步:重新 browser_read'
        + '(弹层/新页面出现后旧的 ref 就失效了,读一次拿到新的 [ref_N]),然后用 selector:"ref_N"。'
        + '元素在视口外时读页不会给它 ref —— 那就先 browser_act{action:"scroll"} 滚过去再读。'
      : '') }
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
      } else if (kind === 'download_ok') {
        // ★"导出功能正常"这句话得有证据:文件真的落盘了、字节数不为 0。
        //   expect 给了就再按文件名匹配(如 .xlsx 或 "采购单")。
        const dls = downloadsOf(s)
        const want = str(expect).trim()
        const hit = dls.filter((d) => d.state === 'completed' && d.bytes > 0 && (!want || String(d.name).indexOf(want) >= 0 || String(d.name).endsWith(want)))
        pass = hit.length > 0
        actual = hit.length ? ('已下载 ' + hit.map((d) => d.name + '(' + d.bytes + 'B)').join('、')
          + ' → ' + (hit[0].path || '(路径未知)'))
          : (dls.length ? ('本会话有 ' + dls.length + ' 次下载,但' + (want ? '没有匹配「' + want + '」的' : '都没有成功落盘')
            + ':' + dls.map((d) => d.name + '/' + d.state + '/' + d.bytes + 'B').join('、'))
            : '本会话【一次下载都没发生】—— 点了"导出"但浏览器没收到文件,多半是接口报错或前端没触发下载')
      } else if (kind === 'no_console_error') {
        // expect = 豁免清单(逗号分隔的片段):反向用例里"页面本该报这个错",不豁免就必然误判
        const ex = str(expect).split(/[,，]/).map((x) => x.trim()).filter(Boolean)
        const all = (tab.console || []).filter((e) => e && e.level === 3)
        const errs = all.filter((e) => !ex.some((x) => str(e.message).indexOf(x) >= 0))
        pass = errs.length === 0
        actual = errs.length ? errs.length + ' 条控制台错误,首条:' + str(errs[0].message).slice(0, 200)
          : (ex.length && all.length ? '无非预期的控制台错误(已豁免 ' + (all.length - errs.length) + ' 条)' : '无控制台错误')
      } else if (kind === 'no_failed_request') {
        // expect = 豁免清单(url 片段 或 状态码):反向用例期望的 400/422 不该算失败
        const ex = str(expect).split(/[,，]/).map((x) => x.trim()).filter(Boolean)
        const all = (tab.net || []).filter((r) => r && (r.state === 'failed' || (r.status >= 400)))
        const bad = all.filter((r) => !ex.some((x) => str(r.url).indexOf(x) >= 0 || String(r.status) === x))
        pass = bad.length === 0
        actual = bad.length ? bad.length + ' 个失败请求,首个:' + str(bad[0].status || bad[0].failText) + ' ' + str(bad[0].url).slice(0, 160)
          : (ex.length && all.length ? '无非预期的失败请求(已豁免 ' + (all.length - bad.length) + ' 个)' : '无失败请求')
      } else if (kind === 'request_status') {
        // ★反向用例的核心:断言某个接口【确实】返回了预期状态码。
        //   "点了提交、页面弹了红字"只能证明前端显示了什么;而"后端确实拒了这条脏数据"要看这个。
        //   expect 形如 "/api/purchase 400"(最后一段是状态码,前面是 url 片段)。
        const parts = str(expect).trim().split(/\s+/)
        const code = parts.length > 1 ? parts.pop() : ''
        const urlPart = parts.join(' ')
        if (!code || !/^\d{3}$/.test(code)) return { error: 'request_status 的 expect 形如 "/api/purchase 400"(url 片段 + 空格 + 三位状态码)' }
        const hits = (tab.net || []).filter((r) => r && (!urlPart || str(r.url).indexOf(urlPart) >= 0))
        const ok2 = hits.filter((r) => String(r.status) === code)
        pass = ok2.length > 0
        actual = ok2.length ? ('命中 ' + ok2.length + ' 条:' + str(ok2[0].status) + ' ' + str(ok2[0].url).slice(0, 160))
          : (hits.length ? ('匹配 ' + urlPart + ' 的请求有 ' + hits.length + ' 条,状态码是 '
              + [...new Set(hits.map((r) => String(r.status || r.state)))].join('/') + ',不是 ' + code)
            : ('本会话【没有】匹配 ' + (urlPart || '(任意)') + ' 的请求 —— 可能前端根本没发出去,或者路径写错了'))
      } else if (kind === 'no_request') {
        // ★另一半反向用例:前端就该把它拦住,一个请求都不许发出去(比如必填项为空时点提交)
        const urlPart = str(expect).trim()
        if (!urlPart) return { error: 'no_request 的 expect 要给 url 片段(断言这个接口【没有】被调用)' }
        const hits = (tab.net || []).filter((r) => r && str(r.url).indexOf(urlPart) >= 0)
        pass = hits.length === 0
        actual = hits.length ? ('不该发出去却发了 ' + hits.length + ' 条,首个:' + str(hits[0].status) + ' ' + str(hits[0].url).slice(0, 160))
          : ('没有任何请求打到 ' + urlPart + '(前端拦住了)')
      } else {
        return { error: '未知断言类型: ' + kind + '(可用 text_present|text_absent|selector_exists|selector_absent|url_matches|no_console_error|no_failed_request|request_status|no_request|download_ok)' }
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
    try {
      // ★对【本会话的标签】直接截,不 activateTab。
      //   老写法为了让 brScreenshot(内部取 brActive())能拿到图,先把自己的标签激活 ——
      //   那等于把用户正在看的页面从窗口上摘下来,而且截完【不还】。
      //   CDP 的 Page.captureScreenshot 不走合成表面,后台标签照样出图。
      // brShotTab 现在可能回 {path,note,buf}(整页图按像素预算截断时要把这件事说出来);
      // 自测里的假实现回字符串 —— 两种都接,少一层耦合
      const rr = await brShotTab(tab, !!(a && a.full))
      const p = typeof rr === 'string' ? rr : (rr && rr.path)
      const shotNote = (rr && rr.note) || ''
      if (!p) return { error: '截图失败(后台标签没有调试器?)' }
      const label = str(a && a.label).slice(0, 120)
      s.shots.push({ path: p, label, at: nowMs() - s.startedAt })
      step(s, 'shot', p, true, '')
      // ★截完【直接摆到对话里给用户看】(2026-08-11 用户要的就是这个):
      // 原先只把路径回给模型,而模型没有读图能力、回复又只是纯文本 —— 它能做的最多是吐一个
      // markdown 图片语法,而那条路径渲染不出来。于是"截图给我看"这件事对用户永远只剩一行路径。
      // 谁有能力把图摆出来?壳层。所以由壳层直推进当前对话卡,不经过模型。
      let shown = false
      const shotInfo = { path: p, label, url: curUrl(s), full: !!(a && a.full), wc: s.wc, buf: (rr && rr.buf) || null }
      if (typeof showShot === 'function') { try { shown = !!showShot(shotInfo) } catch (e) { log('[browser-agent] 展示截图失败: ' + e.message) } }
      // ★"你自己能不能看这张图"必须说实话(2026-08-12):本机 12 个模型一个都不能读图,
      //   而回执以前写着"要看就把它当附件读一遍"—— 模型照做,拿回
      //   「image omitted: could not be resized below the image size limit」,白烧一轮,
      //   然后改去翻数据库、翻后端源码。说不了就说不了,并把还能用的路指出来。
      let vis = { ok: false, why: '' }
      if (typeof visionInfo === 'function') { try { vis = await visionInfo() } catch {} }
      const selfSee = vis.ok
        ? '你自己要"看"内容的话,把这个文件当附件读一遍(本机的读图模型会接手)。'
        : '★你【看不了】这张图(' + (vis.why || '本机没有能读图的模型') + ')—— 别去 read 这个 png,'
          + '那只会拿回一句"image omitted"白烧一轮。要确认页面状态请用 browser_read(元素+ref)/'
          + ' browser_eval(直接查 DOM)/ browser_html(看结构),这三样给的是文字,你读得到。'
      return { ok: true, path: p, shownToUser: shown, youCanSeeIt: !!vis.ok,
        // ★截断要如实说:不说的话模型会把"顶部一屏"当成整页,后面的内容当成不存在
        ...(shotNote ? { truncated: shotNote + ' —— 要看下面的内容:browser_act{action:"scroll"} 往下滚再截一张' } : {}),
        // ★"截到了"和"截了个寂寞"必须分开说:全白图看着也是成功,模型会拿它当证据往下走
        ...(shotInfo.blankish ? { warning: shotInfo.blankish + ' —— 别拿它当"页面正常"的证据。'
          + '先 browser_eval 看一眼 document.body.innerText.length / document.readyState,确认页面真渲染出来了再截。' } : {}),
        note: (shown
          ? '这张图已经【直接展示在用户的对话里】了,不用再把路径念给用户、也不用叫用户自己去打开。'
          : '图已存盘但没能摆进对话(当前没有活动对话卡)。') + selfSee }
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
  // 找"该滚的那个东西":给了选择器就往上找最近的可滚动祖先;没给就找页面上最大的可滚动容器。
  // ★为什么不是 document:业务系统里真正带滚动条的几乎都是内层容器(表格体、弹层、侧栏),
  //   document 本身常常一点都不滚 —— 只滚 window 等于什么都没做。
  // ★这里【只产语句片段】,不自带 (function(){ —— 第一版自带了开头、调用方又包一层,
  //   少一个闭合括号,整段是语法错;而调用处 catch 把它吞了,表现成"没有可滚动的容器"。
  //   又一次:静默 catch 把我自己的 bug 藏成了业务结论。
  const scrollFinderJs = (sel) => 'function __bhCan(e){if(!e||e===document.body||e===document.documentElement)return false;'
    + 'var cs=getComputedStyle(e);return /auto|scroll/.test(cs.overflowY+cs.overflowX)&&(e.scrollHeight>e.clientHeight+4||e.scrollWidth>e.clientWidth+4)}'
    + 'var t=null;'
    + (sel
      ? 'var e0=document.querySelector(' + JSON.stringify(sel) + ');for(var p=e0;p;p=p.parentElement){if(__bhCan(p)){t=p;break}}'
      : 'var best=null,area=0,all=document.querySelectorAll("*");'
        + 'for(var i=0;i<all.length;i++){var e=all[i];if(!__bhCan(e))continue;var r=e.getBoundingClientRect();var a2=r.width*r.height;if(a2>area){area=a2;best=e}}t=best;')
    + 'if(!t&&document.documentElement.scrollHeight>innerHeight+4)t=document.scrollingElement;'
  async function scrollPos(wc, sel) {
    try {
      return await wc.executeJavaScript('(function(){' + scrollFinderJs(sel)
        + 'if(!t)return null;'
        + 'var isDoc=(t===document.scrollingElement);'
        + 'return {pos:Math.round(t.scrollTop+t.scrollLeft),'
        + 'atEnd:(t.scrollTop+t.clientHeight>=t.scrollHeight-2),'
        + 'what:isDoc?"整页":((t.tagName||"").toLowerCase()+(t.className?"."+String(t.className).split(" ")[0]:""))}})()', true)
    } catch (e) { log('[browser-agent] 找滚动容器失败: ' + e.message); return null }   // ★不许静默:吞掉就成了"没有可滚动容器"
  }
  /** 在目标容器上派发【合成 wheel 事件】再直接滚 —— 后台标签收不到真实输入事件(实测),
   *  而虚拟滚动/无限加载/自定义滚动条这些只认 wheel;合成事件虽然 isTrusted=false,
   *  但绝大多数前端库不查这个,照样会响应。 */
  async function scrollByJs(wc, sel, dx, dy) {
    try {
      return await wc.executeJavaScript('(function(){' + scrollFinderJs(sel)
        + 'if(!t)return {no:1};'
        + 'try{t.dispatchEvent(new WheelEvent("wheel",{deltaX:' + dx + ',deltaY:' + dy + ',bubbles:true,cancelable:true}))}catch(e){}'
        + 't.scrollTop+=' + dy + ';t.scrollLeft+=' + dx + ';return {ok:1}})()', true)
    } catch (e) { log('[browser-agent] JS 滚动失败: ' + e.message); return { err: e.message } }
  }

  // ── 组件库下拉(el-select / ant-select / 任意 role=combobox)────────────────
  // 【为什么要在页面里一次做完】分成 click → read → click 三个来回的话:
  //   ① 每一步都要模型自己判断浮层出没出来、选项在哪个 class 里(它猜不准,真机里猜过很多次);
  //   ② 浮层常常挂在 body 末尾而不是触发器里面,read 的清单里位置很远,ref 也容易指错。
  // 所以把"点开 → 等浮层 → 按文本找 → 点中"写成一段例程,回执直接告诉它选中了哪一项。
  // 找不到时把【浮层里实际有哪些项】原样带回来 —— 比一句"没找到"有用得多(常见真因是文案对不上)。
  const COMBO_OPT_SEL = '.el-select-dropdown__item,.ant-select-item-option,[role=\"option\"],li[role=\"menuitem\"],.el-option'
  async function comboSelect(wc, sel, want) {
    try {
      const r = await wc.executeJavaScript('(function(){return new Promise(function(res){'
        + 'var trig=null;try{trig=document.querySelector(' + JSON.stringify(sel) + ')}catch(e){return res({err:\'选择器不合法\'})}'
        + 'if(!trig)return res({err:\'找不到这个下拉\'});'
        + 'var inner=trig.querySelector&&trig.querySelector(\'input,.el-select__wrapper,.el-input__inner\');'
        + '(inner||trig).click();'
        + 'var want=' + JSON.stringify(want) + ';var t0=Date.now();'
        + 'function pick(){'
        + 'var opts=[].slice.call(document.querySelectorAll(' + JSON.stringify(COMBO_OPT_SEL) + '))'
        + '.filter(function(o){var r2=o.getBoundingClientRect();return r2.width||r2.height});'
        + 'if(opts.length){'
        + 'var texts=opts.map(function(o){return (o.innerText||o.textContent||\'\').trim()});'
        + 'var i=texts.indexOf(want);'
        + 'if(i<0)i=texts.findIndex(function(t){return t&&t.indexOf(want)===0});'
        + 'if(i<0)i=texts.findIndex(function(t){return t&&t.indexOf(want)>=0});'
        + 'if(i>=0){opts[i].click();return res({ok:1,picked:texts[i]})}'
        + 'if(Date.now()-t0>2500)return res({err:\'浮层里没有匹配的选项\',options:texts.slice(0,20)})}'
        + 'if(Date.now()-t0>2500)return res({err:\'点开之后没等到选项浮层\'});'
        + 'setTimeout(pick,120)}'
        + 'setTimeout(pick,120)})})()', true)
      if (r && r.ok) return { ok: true, picked: str(r.picked) }
      const opts = arr(r && r.options)
      return { ok: false, err: str((r && r.err) || '选中失败') + (opts.length ? '(浮层里实际有:' + opts.join(' / ') + ')' : '') }
    } catch (e) { return { ok: false, err: e.message } }
  }

  // ── upload(文件上传)────────────────────────────────────────────────────
  // 【为什么必须有】业务系统到处是"上传附件/导入" —— 没有它,这一整类端到端验证做不了:
  //   Agent 只能点开文件框然后卡住(sendInputEvent 设不了 file input,JS 也造不出真 File)。
  //   走 CDP 的 DOM.setFileInputFiles 才是真路子(和真人选文件等价,change 事件也会正常派发)。
  // ★安全边界:只允许【用户自己目录里】的文件 —— 下载/桌面/文档/项目目录。
  //   不设这道闸的话,一句"把配置传上去"就能把 ~/.ssh/id_rsa 传进一个业务系统,
  //   而这个浏览器还带着用户的登录态。与发信附件同一条口径(见 mail.js checkAttachments)。
  function uploadAllowRoots() {
    const st = (S.settings || {})
    const out = []
    try {
      const { app } = require('electron')
      for (const k of ['downloads', 'desktop', 'documents']) { try { out.push(app.getPath(k)) } catch {} }
    } catch { /* 非 Electron 环境(自测)*/ }
    if (st.projectDir) out.push(st.projectDir)
    if (st.backendDir) out.push(st.backendDir)
    return out.filter(Boolean)
  }
  async function agentUpload(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const f = fenceNow(s); if (!f.ok) { step(s, 'upload', '', false, f.err); return { error: f.err } }
    const files = arr(a && a.files).map(str).filter(Boolean)
    if (!files.length) return { error: 'files 必填:要上传的文件绝对路径(数组)' }
    const path = require('path'); const fs = require('fs')
    // ★根目录也要 realpath:macOS 的 /var 是指向 /private/var 的软链,文件 realpath 过、根没有,
    //   就会把【允许目录里的文件】误判成越界(自测第一次就撞上)。用户的项目目录带软链同理。
    // ★Windows 的路径比较不分大小写(C:\Users 和 c:\users 是同一个),盘符大小写也常不一致。
    //   用大小写敏感的 startsWith 去比,在 Windows 上会把【允许目录里的文件】误判成越界 ——
    //   而我这边全程在 mac 上验的,这类差异量不出来,只能按平台规则改对。
    const ci = process.platform === 'win32'
    const norm = (x) => (ci ? String(x).toLowerCase() : String(x))
    const roots = uploadAllowRoots().map((d) => {
      try { return fs.realpathSync(d) } catch { return path.resolve(d) }
    }).map((d) => norm(d + path.sep))
    const real = []
    for (const fp of files) {
      let rp = ''
      try { rp = fs.realpathSync(path.resolve(fp)) } catch { return { error: '文件不存在:' + fp } }
      if (roots.length && !roots.some((r) => norm(rp + path.sep).startsWith(r))) {
        return { error: '拒绝上传该文件(不在允许目录):' + fp
          + ' —— 只允许 下载/桌面/文档/项目目录 里的文件。这个浏览器带着用户的登录态,'
          + '不能拿它把任意本地文件送进业务系统。要传别处的文件,先让用户把它拷到上面任一目录。' }
      }
      real.push(rp)
    }
    const refRaw = a && a.ref != null ? str(a.ref).trim() : ''
    const refN = refRaw ? (refRaw.match(/^(?:ref[_-]?)?(\d+)$/i) || [])[1] : ''
    const selRaw = a && a.selector != null ? str(a.selector).trim() : ''
    const selRefN = (selRaw.match(/^ref[_-]?(\d+)$/i) || [])[1]
    let sel = refN ? '[data-bh-ref="' + refN + '"]' : selRefN ? '[data-bh-ref="' + selRefN + '"]' : selRaw
    if (!sel) sel = 'input[type=file]'      // 不给就找页面上唯一的那个(el-upload 常把它藏起来)
    const wc = tab.view.webContents
    // 定位:给的可能是包裹层(el-upload 是个 div,真 input 藏在里面)—— 与 type 同一条口径,下潜到真 input
    const found = await wc.executeJavaScript('(function(){var e=null;try{e=document.querySelector('
      + JSON.stringify(sel) + ')}catch(err){return {err:\'选择器不合法\'}}'
      + 'if(!e)return {err:\'找不到 \'+' + JSON.stringify(sel) + '};'
      + 'if(e.tagName!==\'INPUT\'||e.type!==\'file\'){var ins=e.querySelectorAll?e.querySelectorAll(\'input[type=file]\'):[];'
      + 'if(ins.length!==1)return {err:\'这不是文件输入框(<\'+e.tagName.toLowerCase()+\'>,里面有 \'+ins.length+\' 个 file input)\'};'
      + 'e=ins[0]}'
      + 'e.setAttribute(\'data-bh-upload\',\'1\');return {ok:1}})()', true).catch((e) => ({ err: e.message }))
    if (!found || found.err) return { error: str((found && found.err) || '定位失败') }
    if (!tab.dbg) return { error: '这个标签页没有调试器,发不了文件(CDP 不可用)' }
    try {
      const dbg = wc.debugger
      const doc = await dbg.sendCommand('DOM.getDocument')
      const q = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-bh-upload="1"]' })
      if (!q || !q.nodeId) return { error: '拿不到文件框的 CDP 节点' }
      await dbg.sendCommand('DOM.setFileInputFiles', { files: real, nodeId: q.nodeId })
    } catch (e) { step(s, 'upload', sel, false, e.message); return { error: '上传失败:' + e.message } }
    // ★回读:设完要确认框里真的有文件(与 type 同一条教训 —— 不回读就是"报成功、实际没做到")
    const back = await wc.executeJavaScript('(function(){var e=document.querySelector(\'[data-bh-upload="1"]\');'
      + 'if(!e)return {n:-1};e.removeAttribute(\'data-bh-upload\');'
      + 'return {n:e.files?e.files.length:0,names:[].slice.call(e.files||[]).map(function(x){return x.name})}})()', true)
      .catch(() => ({ n: -1 }))
    const n = +(back && back.n) || 0
    step(s, 'upload', sel + ' ← ' + real.map((x) => path.basename(x)).join(','), n > 0, n > 0 ? '' : '文件没进输入框')
    if (n <= 0) return { error: '文件没有进到输入框(回读 files 为空)—— 可能这个组件用的是拖拽区而不是 file input' }
    try { await waitNetIdle(tab, 300, 4000) } catch {}
    return { ok: true, url: curUrl(s), files: arr(back && back.names),
      note: '文件已放进输入框(change 事件已派发)。多数组件此时会自动开始上传;要提交表单的还得再点提交。' }
  }

  // ── 原生弹窗:不许挂死,答案由 Agent 显式决定 ────────────────────────────────
  // 【为什么这是最危险的一个缺口】页面调 window.confirm 会【阻塞渲染进程】等一个原生对话框,
  // 而 Agent 的标签页是后台的(没挂进任何窗口)—— 那个对话框弹不出来也就永远不返回,
  // 整个页面从此冻住,后续每个工具都超时。业务系统满屏"确认删除吗?",踩上是必然的。
  // 原来的包装只是【记一笔然后照样调原生的】,所以完全挡不住。
  // 改法:Agent 自己的标签页里三个弹窗一律【不阻塞】,并且:
  //   · confirm 默认返回 false —— 默认拒绝比默认同意安全得多("确认删除吗?"默认点确定是灾难);
  //   · 要点确定必须 Agent【预先明说】(browser_act{action:'dialog',accept:true}),一次只管一个;
  //   · 出现过什么弹窗全部记下来,read/diag 里能看到 —— 不能让它悄悄发生。
  const DIALOG_JS = '(function(){if(window.__bocom_dlg)return 1;'
    + 'var st={armed:null,seen:[]};window.__bocom_dlg=st;'
    + 'window.alert=function(m){st.seen.push({kind:"alert",text:String(m).slice(0,300)});return undefined};'
    + 'window.confirm=function(m){var a=st.armed;st.armed=null;'
    + 'st.seen.push({kind:"confirm",text:String(m).slice(0,300),answered:a?"确定":"取消"});return !!(a&&a.accept)};'
    + 'window.prompt=function(m,d){var a=st.armed;st.armed=null;'
    + 'st.seen.push({kind:"prompt",text:String(m).slice(0,300),answered:a?(a.text||""):"(取消)"});'
    + 'return a?String(a.text==null?"":a.text):null};'
    + 'window.onbeforeunload=null;return 1})()'
  function armDialogJs(accept, text) {
    return '(function(){if(!window.__bocom_dlg)return 0;window.__bocom_dlg.armed='
      + JSON.stringify({ accept: !!accept, text: str(text) }) + ';return 1})()'
  }
  async function installDialogGuard(tab) {
    const wc = tab.view.webContents
    const go = () => { wc.executeJavaScript(DIALOG_JS, true).catch(() => {}) }
    go()
    if (!tab.__bhDlgWired) { tab.__bhDlgWired = true; wc.on('dom-ready', go) }   // SPA 内导航后要重装
  }
  async function dialogsOf(tab) {
    try { return await tab.view.webContents.executeJavaScript('(window.__bocom_dlg&&window.__bocom_dlg.seen)||[]', true) }
    catch { return [] }
  }

  // ── 原地打转的闸 ──────────────────────────────────────────────────────────
  // 【为什么必须由壳层来拦】"卡住"在真机里的样子是:同一个动作换着选择器试第 4 次、第 5 次,
  // 每次白等 4 秒,一直烧到用户看不下去把它掐掉(2026-08-11 实录:连猜 4 个 nth-of-type)。
  // 模型自己判断不出"我在打转"—— 它每一步都觉得"这次换个写法应该行"。
  // 判据要机械:同一指纹(动作+目标+值)在最近 8 次里出现 3 次,或者连续 5 次全失败。
  // 拦下来【不是干拒】:把试过什么原样列出来,并指出还没试过的手段 —— 目的是换路,不是停摆。
  // LOOP_SAME=2 的含义是【已经试过 2 次就不许试第 3 次】——
  // 第一版写 3,实际要到第 4 次才拦,白放过一次 4 秒等待。边界要按"给它几次机会"来定,不是按计数器写。
  const LOOP_SAME = 2, LOOP_WIN = 8, LOOP_FAILS = 5
  function loopGuard(s, action, sel, value) {
    const fp = action + '|' + str(sel) + '|' + str(value).slice(0, 40)
    const rec = arr(s.recent)
    // ★只数【失败的】重复:重复一个成功的动作是正常的(翻页、切回某个 tab、逐行处理),
    //   把它算成打转就是误伤 —— 自测里一串各不相同且全成功的动作被拦下,就是这么来的。
    //   打转的定义是"同一件事试了又没成",不是"同一件事做了多次"。
    const same = rec.slice(-LOOP_WIN).filter((x) => x.fp === fp && !x.ok).length
    let tailFails = 0
    for (let i = rec.length - 1; i >= 0 && !rec[i].ok; i--) tailFails++
    if (same < LOOP_SAME && tailFails < LOOP_FAILS) return ''
    const tried = [...new Set(rec.slice(-LOOP_WIN).map((x) => x.fp.split('|').slice(0, 2).join(' ')))].slice(0, 6)
    const why = same >= LOOP_SAME
      ? '同一个动作你已经试了 ' + same + ' 次(' + fp.split('|').slice(0, 2).join(' ') + ')'
      : '最近 ' + tailFails + ' 次动作【全部失败】'
    return why + ' —— 这是在原地打转,再试一次也是同样结果。已经试过:' + tried.join(' / ')
      + '。换条路:① browser_read 重新拿 ref(页面变过,旧 ref 必然失效)'
      + ' ② browser_html 看这块的 DOM 结构(比猜选择器快得多)'
      + ' ③ browser_eval 直接查或直接改(结果你自己看得见)'
      + ' ④ browser_see 让视觉模型看一眼(结构对了但"看起来不对"时只有这条路)'
      + ' ⑤ 都试过还不行就【停手】,把"试了什么、卡在哪一步、页面现在什么样"告诉用户 —— '
      + '继续烧只是浪费他的额度,而他看一眼可能三秒就知道原因。'
  }
  function loopNote(s, action, sel, value, okFlag) {
    if (!s.recent) s.recent = []
    s.recent.push({ fp: action + '|' + str(sel) + '|' + str(value).slice(0, 40), ok: !!okFlag })
    if (s.recent.length > 40) s.recent.shift()
  }

  // ── see:看一眼这页(多模态)────────────────────────────────────────────────
  // 【用户 2026-08-12】"要学会用多模态模型解决问题。这个要教会 Agent。"
  // 教法不是"劝主模型去读图"—— 本机主模型根本不支持图片输入,劝它只会白烧一轮。
  // 正确的做法:截图 → 壳层拿去问【视觉模型】→ 把答案当【文字】还给主模型。
  // 于是"看得见"和"想得清"由两个模型分工,主模型不需要自己有视觉能力。
  // 什么时候该用它:read/eval/html 都是结构性的,回答不了"这页看起来对不对"——
  // 布局错位、样式塌了、图表画歪了、弹窗遮住了内容,这些只有看图才知道。
  async function agentSee(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    if (typeof askVision !== 'function') return { error: '本机没装读图通道' }
    const rr = await brShotTab(tab, !!(a && a.full))
    const p = typeof rr === 'string' ? rr : (rr && rr.path)
    if (!p) return { error: '截图失败,没法看' }
    const q = str(a && a.question)
    const r = await askVision(p, q)
    step(s, 'see', q.slice(0, 80) || '(看一眼)', !r.error, r.error || '')
    if (r.error) return { error: r.error }
    return { ok: true, url: curUrl(s), model: r.model, answer: r.answer, shot: p,
      note: '这是【视觉模型】看图之后的文字描述 —— 你自己没读到图。要按它下判断的话,'
        + '涉及具体数值/文案的地方最好再用 browser_eval 核一次(看图会看错,查 DOM 不会)。' }
  }

  // ── cookie 细粒度 ────────────────────────────────────────────────────────
  // 【和 browser_state 的分工】state 是【整份】快照(切身份、测未登录);
  // 这里是【单条】操作:改一个 token 看后端怎么反应、删一个 cookie 测过期跳登录、
  // 看一眼 httpOnly 的值(那个 eval 读不到 —— document.cookie 拿不到 httpOnly)。
  // 反向用例特别需要它:"带一个过期/伪造的 token 请求,期望 401"这类,没有它就没法造场景。
  async function agentCookie(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const f = fenceNow(s); if (!f.ok) return { error: f.err }
    const wc = tab.view.webContents
    const ses = (() => { try { return wc.session } catch { return null } })()
    if (!ses) return { error: '拿不到浏览器 session' }
    const act = str(a && a.action).toLowerCase() || 'list'
    const url = str(a && a.url) || curUrl(s)
    const name = str(a && a.name)

    if (act === 'list' || act === 'get') {
      let cs = []
      try { cs = await ses.cookies.get(name ? { url, name } : { url }) } catch (e) { return { error: '读失败: ' + e.message } }
      step(s, 'cookie', act + ' ' + (name || url), true, '')
      return { ok: true, url,
        cookies: cs.map((c) => ({ name: c.name, value: str(c.value).slice(0, 200), domain: c.domain, path: c.path,
          httpOnly: !!c.httpOnly, secure: !!c.secure, expires: c.expirationDate || null })),
        note: cs.length ? '★httpOnly 的 cookie 只有这条路看得到 —— browser_eval 里的 document.cookie 读不到它们。' : '这个 URL 下没有 cookie。' }
    }
    if (act === 'set') {
      if (!name) return { error: 'set 要给 name' }
      try {
        await ses.cookies.set({ url, name, value: str(a && a.value),
          domain: a && a.domain ? str(a.domain) : undefined, path: a && a.path ? str(a.path) : '/',
          secure: !!(a && a.secure), httpOnly: !!(a && a.httpOnly),
          expirationDate: (a && a.expires) ? +a.expires : undefined })
      } catch (e) { return { error: '写失败: ' + e.message + '(url 与 domain/secure 要自洽:https 的 secure cookie 不能写到 http 的 url 上)' } }
      step(s, 'cookie', 'set ' + name, true, '')
      return { ok: true, name, note: '已写入。★页面里已经加载好的请求不会重发 —— 要生效通常得 navigate 一次或重新触发那个请求。' }
    }
    if (act === 'delete') {
      if (!name) return { error: 'delete 要给 name' }
      try { await ses.cookies.remove(url, name) } catch (e) { return { error: '删失败: ' + e.message } }
      step(s, 'cookie', 'delete ' + name, true, '')
      return { ok: true, name, note: '已删除。测"token 过期后是否跳登录"就用这个,然后 navigate 一次。' }
    }
    return { error: 'action 只能是 list|get|set|delete' }
  }

  // ── 浏览器状态:存 / 复用 / 清空 ──────────────────────────────────────────
  // 【用户 2026-08-12】"还有 session 复用等浏览器状态保持的工具"。
  // 先说清现状,免得做重复功:cookies 走的是同一个 Electron session,【本来就共享且落盘持久】——
  // 所以重开标签、甚至重启应用,多数系统仍是登录态。真正会丢的是两样:
  //   ① localStorage / sessionStorage 里的 token(SPA 常把它放这儿,或者干脆只放内存);
  //   ② "我想换个身份跑" / "我想测未登录的表现" —— 这两件事没有工具就只能手工清浏览器。
  // 所以这里补的是【命名快照】:把当前 origin 的 cookies + localStorage 存成一份,随时切回来。
  // ★默认只存在内存里(壳层进程生命周期内):这些是【登录凭据】,落盘等于把凭据明文写进硬盘。
  //   要跨重启复用得显式 persist:true,并且回执里把这句话说明白 —— 不能让它悄悄发生。
  const stateSnaps = new Map()   // name -> { origin, cookies, local, at }
  function stateFile(name) {
    const path2 = require('path'); const { app } = require('electron')
    return path2.join(app.getPath('userData'), 'browser-state', String(name).replace(/[^\w.-]/g, '') + '.json')
  }
  async function agentState(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const wc = tab.view.webContents
    const act = str(a && a.action).toLowerCase() || 'save'
    const name = str(a && a.name).trim()
    const url = curUrl(s)
    const origin = originOf(url)
    const ses = (() => { try { return wc.session } catch { return null } })()
    if (!ses) return { error: '拿不到浏览器 session' }

    if (act === 'list') {
      const mem = [...stateSnaps.entries()].map(([k, v]) => ({ name: k, origin: v.origin, cookies: v.cookies.length, at: v.at, where: '内存' }))
      let disk = []
      try {
        const fs2 = require('fs'); const path2 = require('path'); const { app } = require('electron')
        const d = path2.join(app.getPath('userData'), 'browser-state')
        disk = fs2.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.replace(/\.json$/, ''), where: '磁盘' }))
      } catch {}
      return { ok: true, snapshots: [...mem, ...disk] }
    }

    if (act === 'clear') {
      // 测"未登录时的表现"必须能清干净 —— 反向用例里这是最常用的一步
      try { await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'] }) } catch (e) { return { error: '清不掉: ' + e.message } }
      try { await wc.executeJavaScript('(function(){try{localStorage.clear();sessionStorage.clear()}catch(e){}return 1})()', true) } catch {}
      step(s, 'state', 'clear', true, '')
      return { ok: true, note: '已清空 cookies 与本地存储(整个浏览器,不只这一页)。刷新页面即可看到未登录状态。' }
    }

    if (!name) return { error: 'save/load 要给 name(这份状态叫什么,如「柜员甲」「admin」)' }

    if (act === 'save') {
      if (!origin) return { error: '当前页没有有效 origin,存不了' }
      let cookies = []
      try { cookies = await ses.cookies.get({}) } catch (e) { return { error: '读 cookies 失败: ' + e.message } }
      let local = {}
      try { local = await wc.executeJavaScript('(function(){var o={};try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k)}}catch(e){}return o})()', true) } catch {}
      const snap = { origin, cookies, local, at: new Date().toISOString() }
      stateSnaps.set(name, snap)
      let persisted = ''
      if (a && a.persist) {
        try {
          const fs2 = require('fs'); const path2 = require('path')
          const fp = stateFile(name)
          fs2.mkdirSync(path2.dirname(fp), { recursive: true })
          fs2.writeFileSync(fp, JSON.stringify(snap), { mode: 0o600 })
          persisted = fp
        } catch (e) { return { error: '落盘失败: ' + e.message } }
      }
      step(s, 'state', 'save ' + name, true, '')
      return { ok: true, name, origin, cookies: cookies.length, localKeys: Object.keys(local).length,
        note: persisted
          ? '已存进内存【并落盘】:' + persisted + ' —— ★这里面是登录凭据的明文,别把它拷给别人;不需要跨重启就别用 persist。'
          : '已存进内存(本次运行内有效,别的会话也能 load)。要跨重启复用就加 persist:true —— 那等于把登录凭据明文写进硬盘,想清楚再用。' }
    }

    if (act === 'load') {
      let snap = stateSnaps.get(name)
      if (!snap) {
        try { const fs2 = require('fs'); snap = JSON.parse(fs2.readFileSync(stateFile(name), 'utf8')) } catch {}
      }
      if (!snap) return { error: '没有叫「' + name + '」的状态快照(用 action:"list" 看有哪些)' }
      let n = 0
      for (const c of arr(snap.cookies)) {
        try {
          await ses.cookies.set({
            url: (c.secure ? 'https://' : 'http://') + String(c.domain || '').replace(/^\./, '') + (c.path || '/'),
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: !!c.secure, httpOnly: !!c.httpOnly, expirationDate: c.expirationDate,
          })
          n++
        } catch { /* 单条失败不影响其余(域名/协议对不上的老 cookie 很常见)*/ }
      }
      try {
        await wc.executeJavaScript('(function(){var o=' + JSON.stringify(snap.local || {}) + ';'
          + 'try{for(var k in o)localStorage.setItem(k,o[k])}catch(e){}return 1})()', true)
      } catch {}
      step(s, 'state', 'load ' + name, true, '')
      return { ok: true, name, cookies: n, total: arr(snap.cookies).length, origin: snap.origin,
        note: '已恢复。localStorage 是写进【当前页】的 origin 的 —— 如果快照来自别的站点,先 navigate 过去再 load。'
          + '恢复完通常要刷新一次页面才生效(browser_act{action:"navigate"} 到当前地址即可)。' }
    }
    return { error: 'action 只能是 save|load|clear|list' }
  }

  // ── 把跑通的流程沉淀成技能 ────────────────────────────────────────────────
  // 【用户 2026-08-12】"试错了很多次跑通了,还是没法在其他会话中复用。要提供流程自主沉淀的能力。"
  // 这件事的关键不是"存下来",是【存成能被现成引擎回放的东西】:
  // 本仓已经有一整套录制技能的回放引擎(选择器自愈 selAlt、参数化、skill_run、断点接管),
  // 所以沉淀只要把会话里那条动作流写成同样形状的录制文件,别的会话直接 skill_run 就能跑。
  // 另造一套"Agent 专用流程"是错的:回放里最难的那些(元素找不到怎么自愈、参数怎么填)全要重写一遍。
  // ★收了会话【还能存】:纯写文件,不需要活标签页。
  // 之前用 live() 拦,于是"报告里催它沉淀 → 它照着调 → 被自己的工具拒了"—— 催了也白催。
  // 真实顺序就是先 close 拿报告再想起沉淀,所以这里给一段墓碑期。
  const SAVE_GRACE_MS = 10 * 60000
  function agentSaveFlow(a) {
    const id0 = str(a && a.sessionId)
    const s = sessions.get(id0) || live(id0)
    if (!s) return { error: '会话不存在' }
    if (s.closed && nowMs() - (s.closedAt || 0) > SAVE_GRACE_MS) {
      return { error: '这个会话收掉超过 ' + Math.round(SAVE_GRACE_MS / 60000) + ' 分钟了,流程没留住。'
        + '下次跑通后【先 browser_save_flow 再 browser_close】,或者收完立刻存。' }
    }
    const name = str(a && a.name).trim()
    if (!name) return { error: 'name 必填:一句话说清这个流程干什么(别人在技能库里就靠它认出来)' }
    const acts = arr(s.flow).filter((e) => e && e.act !== 'navigate')
    if (!acts.length) return { error: '这个会话还没有任何【会改变页面状态】的成功动作(只有读页/截图),没什么可沉淀的' }
    // ★认领:如果收会话时已经自动存过,就【覆盖同一条】,不许一条流程在库里躺两份
    const id = s.autoId || ('agent-' + nowMs().toString(36))
    // 覆盖时要把"跑通过几次/什么时候第一次跑通"带过来 —— 认领一次就把 runs 清零的话,
    // 召回排序(跑得多的优先)当场失效,而这条恰恰是刚被人认领、最值得推的那一条。
    let prev = null; try { prev = readRec ? readRec(id) : null } catch {}
    const rec = {
      id,
      title: name.slice(0, 60),
      description: str(a && a.description).slice(0, 400) || s.purpose,
      startUrl: (arr(s.flow)[0] || {}).url || curUrl(s),
      skill: true, auto: false,
      createdBy: 'agent',
      createdAt: (prev && prev.createdAt) || new Date().toISOString(),
      runs: (prev && +prev.runs) || 1,
      events: arr(s.flow),
      params: [],
    }
    try { saveRec(rec) } catch (e) { return { error: '存不下来: ' + e.message } }
    s.savedFlow = true
    if (!s.closed) step(s, 'save_flow', id + ' ' + name, true, '')
    log('[browser-agent] 沉淀流程 ' + id + ' 「' + name + '」共 ' + rec.events.length + ' 步')
    return { ok: true, skillId: id, steps: rec.events.length,
      note: '已存进技能库。别的会话里用 skill_run 跑它(skill_list 能看到),不用再从头试一遍。'
        + (arr(s.flow).some((e) => e.secret) ? ' 其中有密码步:回放时要现场提供,录里没存明文。' : '') }
  }

  // ── eval(仿 CC 的 javascript_tool)──────────────────────────────────────────
  // 【为什么必须有】2026-08-11 真机思考过程里,模型【连着五次】问同一件事:
  //   「内嵌浏览器可执行 JS 吗?工具集里有 headless_eval 但那是 headless。会话组没有 eval。」
  // 它要的就是"让我自己查一下这页到底长什么样"。没有这条路,它只能靠 read 给的扁平清单去猜结构 ——
  // 弹层里 6 个一模一样的数字输入框,它烧了整整六屏推理去拼 nth-of-type,全废,
  // 最后跑去 rg/sed 读前端源码。一个 querySelectorAll('.el-dialog input[type=number]').length
  // 就能结束的事。缺一件工具的代价不是"少一个功能",是模型把 token 全烧在绕路上。
  //
  // 安全口径:与 act 同一道门 —— 现查围栏、只在本会话自己的标签页上跑。
  // 这不是新的信任边界:能 click/type 的地方本来就能改这一页的状态。输出封顶,别把整页 DOM 灌回上下文。
  const EVAL_MAX = 8000
  async function agentEval(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const f = fenceNow(s); if (!f.ok) { step(s, 'eval', '', false, f.err); return { error: f.err } }
    const expr = str(a && a.expr).trim()
    if (!expr) return { error: 'expr 必填:一段 JS 表达式,返回值会 JSON 化回给你(例:document.querySelectorAll(".el-dialog input[type=number]").length)' }
    if (expr.length > 4000) return { error: 'expr 太长(> 4000 字)—— 查结构不需要这么长,先缩小范围' }
    let out = null
    try {
      // 包一层:返回值统一 JSON 化并封顶;抛错原样带回(排查要看它),不当成"没结果"
      out = await tab.view.webContents.executeJavaScript(
        '(function(){try{var __v=(' + expr + ');'
        + 'var __t=typeof __v;'
        + 'if(__v&&__t==="object"&&typeof __v.length==="number"&&!Array.isArray(__v))__v=Array.prototype.slice.call(__v).map(function(x){return x&&x.outerHTML?x.outerHTML.slice(0,300):String(x)});'
        + 'if(__v&&__v.outerHTML)__v=__v.outerHTML.slice(0,2000);'
        + 'var __s;try{__s=JSON.stringify(__v)}catch(e){__s=String(__v)}'
        + 'if(__s===undefined)__s="undefined";'
        + 'return {v:String(__s).slice(0,' + EVAL_MAX + '),n:String(__s).length,t:__t}}'
        + 'catch(e){return {err:String(e&&e.message||e)}}})()', true)
    } catch (e) { out = { err: e.message } }
    const bad = out && out.err
    step(s, 'eval', expr.slice(0, 120), !bad, bad || '')
    if (bad) return { error: 'JS 报错: ' + bad + ' —— 表达式本身的错,不是页面没有这个元素' }
    return { ok: true, url: curUrl(s), type: (out && out.t) || 'undefined', result: (out && out.v) || '',
      truncated: (out && out.n > EVAL_MAX) ? ('结果共 ' + out.n + ' 字,只给了前 ' + EVAL_MAX + ' 字') : '' }
  }

  // ── html(拿 DOM 结构)──────────────────────────────────────────────────────
  // 【为什么单独给】read 给的是扁平的可交互清单,回答不了"这 6 个数字框在结构上怎么区分"。
  // 真机里模型为此想 headless_get_html(那是另一个浏览器、没有登录态),
  // 还退到 rg/sed 去读 .vue 源码 —— 而它要的只是【当前这一页】的一小段 DOM。
  // 默认只给弹层/主体这一层,给了 selector/ref 就给那棵子树:整页 outerHTML 灌回来是上下文自杀。
  const HTML_MAX = 12000
  async function agentHtml(a) {
    const s = live(a && a.sessionId); if (!s) return { error: '会话不存在或已结束(先 browser_open)' }
    const tab = tabOf(s); if (!tab) return { error: '这个会话的标签页已被关掉' }
    const f = fenceNow(s); if (!f.ok) return { error: f.err }
    const refRaw = a && a.ref != null ? str(a.ref).trim() : ''
    const refN = refRaw ? (refRaw.match(/^(?:ref[_-]?)?(\d+)$/i) || [])[1] : ''
    const selRaw = a && a.selector != null ? str(a.selector).trim() : ''
    const selRefN = (selRaw.match(/^ref[_-]?(\d+)$/i) || [])[1]
    const sel = refN ? '[data-bh-ref="' + refN + '"]' : selRefN ? '[data-bh-ref="' + selRefN + '"]' : selRaw
    let out = null
    try {
      out = await tab.view.webContents.executeJavaScript(
        '(function(){var q=' + JSON.stringify(sel) + ';var e=null;'
        + 'if(q){try{e=document.querySelector(q)}catch(err){return {err:"选择器不合法: "+err.message}}if(!e)return {err:"没找到 "+q};}'
        // 不给选择器时:优先给最上层的弹层(它才是当下在操作的东西),没有弹层再给 body
        // ★只认【可见的】弹层:真机自检时抓到一个隐藏的 el-overlay-dialog(aria-label="添加列",内容全空)——
        // 模型会把那当成"当前弹层"然后一路推错。"看着成功、其实拿错了东西"比直接失败坏得多。
        + 'else{var ds=document.querySelectorAll(\'[role="dialog"],.el-dialog,.ant-modal,.modal.show\');'
        + 'for(var di=ds.length-1;di>=0;di--){var d=ds[di];if(d.getClientRects().length&&(d.innerText||"").trim()){e=d;break}}'
        + 'if(!e)e=document.body}'
        + 'var h=e.outerHTML||"";'
        // 把 <svg>/<style>/<script> 的内容掏空:它们能占掉一大半字数,而对定位元素毫无用处
        + 'h=h.replace(/<svg[\\s\\S]*?<\\/svg>/gi,"<svg/>").replace(/<style[\\s\\S]*?<\\/style>/gi,"").replace(/<script[\\s\\S]*?<\\/script>/gi,"");'
        + 'return {h:h.slice(0,' + HTML_MAX + '),n:h.length,tag:(e.tagName||"").toLowerCase(),cls:String(e.className||"").slice(0,120)}})()', true)
    } catch (e) { out = { err: e.message } }
    if (out && out.err) return { error: out.err }
    return { ok: true, url: curUrl(s), root: (out && out.tag) || '', rootClass: (out && out.cls) || '',
      html: (out && out.h) || '',
      truncated: (out && out.n > HTML_MAX) ? ('这段 DOM 共 ' + out.n + ' 字,只给了前 ' + HTML_MAX + ' 字 —— 想细看就给 selector/ref 收窄') : '' }
  }

  /** 本会话标签页上发生过的下载(点"导出"之后唯一能拿来当证据的东西) */
  function downloadsOf(s) {
    const t = tabOf(s)
    return arr(t && t.downloads).map((d) => ({ name: d.name, state: d.state, bytes: d.bytes, path: d.path, url: d.url }))
  }

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
      downloads: downloadsOf(s),   // 点过"导出"之后,这里是唯一能当证据的东西(文件名/状态/字节数/落盘路径)
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
    // ★超时是【壳层定时器到点】,不是"验证没过" —— 判 FAIL 会把一次好端端的会话说成失败
    //   (真机:跑到第 105 步被收掉,报告写 FAIL,而它一条断言都没失败过)。断不出结论就说断不出。
    const verdict = status === 'timeout' ? 'INCONCLUSIVE'
      : status !== 'done' ? 'FAIL'
      : (failed.length || stepFail.length) ? 'FAIL'
      : s.asserts.length ? 'PASS' : 'INCONCLUSIVE'
    s.result = {
      sessionId: s.id, purpose: s.purpose, verdict, status, note: str(note).slice(0, 300),
      durationSec: Math.round((nowMs() - s.startedAt) / 1000),
      steps: s.steps, asserts: s.asserts, shots: s.shots.map((x) => x.path),
      assertPassed: s.asserts.length - failed.length, assertTotal: s.asserts.length,
      failures: [...failed.map((x) => '断言未过:' + x.label + ' —— ' + x.actual), ...stepFail.map((x) => '步骤失败:' + x.kind + ' ' + x.detail + ' —— ' + x.err)].slice(0, 20),
    }
    // ★沉淀待办:在【报告里点名催】,不是靠开场那句"记得存"。
    // 开场提的那句,等它把一个流程试通时早被几十屏工具回执埋掉了 —— 真机上一次都没触发过。
    // 收会话是唯一"这条路刚跑通、还记得怎么走"的时刻,所以催要催在这里,而且要把命令写全能照抄。
    // 试错次数一起报出来:那是不沉淀的【代价】,下一个会话会把这些试错原样再走一遍。
    const flowActs = arr(s.flow).filter((e) => e && e.act !== 'navigate').length
    if (status === 'done' && flowActs >= 2 && !s.savedFlow) {
      const rec = autoSediment(s, verdict)
      if (rec) {
        s.result.sediment = '★这条流程已【自动存进技能库】:' + rec.id + ' 「' + rec.title + '」' + rec.events.length + ' 步'
          + (rec.runs > 1 ? '(这条路第 ' + rec.runs + ' 次跑通,已合并到同一条)' : '')
          + (stepFail.length ? ',路上试错 ' + stepFail.length + ' 次' : '') + '。\n'
          + '别的会话直接 skill_run ' + rec.id + ' 回放,不用再试一遍。\n'
          + '名字是拿你开会话时那句 purpose 凑的 —— 想起个更准的就调 '
          + 'browser_save_flow{sessionId:"' + s.id + '",name:"…"}(覆盖同一条,不会多出一条;收会话后 '
          + Math.round(SAVE_GRACE_MS / 60000) + ' 分钟内有效)。'
      }
    }
    s.closedAt = nowMs()
    const t = tabOf(s)
    if (t) { try { closeTab(t.id) } catch {} }
    log('[browser-agent] 收会话 ' + s.id + ' → ' + verdict + ' (断言 ' + s.result.assertPassed + '/' + s.result.assertTotal + ', 步骤 ' + s.steps.length + ')')
    return s.result
  }
  function agentClose(a) {
    const s = sessions.get(str(a && a.sessionId))
    if (!s) return { error: '会话不存在' }
    if (s.closed) {
      // 存过之后再收一次,不许把那条过期的催促原样喂回去 —— 它会照着再存一遍,技能库里多一条重复的。
      const rep = s.savedFlow && s.result && s.result.sediment ? { ...s.result, sediment: undefined } : s.result
      return { ok: true, report: rep, note: '(已经收过了,返回原报告)' }
    }
    const status = str(a && a.status) === 'failed' ? 'failed' : 'done'
    return { ok: true, report: finish(s, status, str(a && a.note)) }
  }

  /** 关卡/退出时兜底收摊:别把标签页和会话留成孤儿 */
  function dropAll(why) {
    for (const s of [...sessions.values()]) if (!s.closed) finish(s, 'failed', why || '壳层收摊')
    sessions.clear()
  }

  return { __dialogJs: DIALOG_JS, __armDialogJs: armDialogJs, agentOpen, agentRead, agentFind, agentAct, agentEval, agentHtml, agentUpload, agentSaveFlow, agentSee, agentState, agentCookie, agentTabs, agentResize, agentAssert, agentShot, agentDiag, agentClose, anyLive, dropAll, policyCheck, __sessions: sessions }
}
