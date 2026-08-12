// 自测:src/browser-agent.js —— Agent 自主浏览器会话。
// 全部用假 ctx(假标签页/假 execStep/假截图),不起真浏览器、不连 relay:
// 要守的是【围栏】和【机判 verdict】这两处逻辑,它们和真不真浏览器无关,而恰恰是错了最危险的地方。
// 跑法: npm run bragent:test
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const initBrowserAgent = require('../src/browser-agent.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

// ── 假装配:一套能被检查的最小 ctx ─────────────────────────────────────────
function makeCtx(over = {}) {
  const S = { settings: Object.assign({ browserAgent: {} }, over.settings || {}), browser: { tabs: [], activeId: null, seq: 0 } }
  const calls = { newTab: [], newTabOpts: [], closeTab: [], activateTab: [], exec: [], shots: 0, shotTabs: [], createBrowser: 0, ensureBg: 0, visibleCalls: [] }
  // 假标签页:页面状态(url / innerText / 选择器命中数 / console / net)全可编程
  function mkTab(id, url) {
    const page = { url, text: '', selCount: 0 }
    const wc = {
      isDestroyed: () => false,
      debugger: { sendCommand: async (m, p2) => {
        if (m === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (m === 'DOM.querySelector') return { nodeId: 7 }
        if (m === 'DOM.setFileInputFiles') { page.uploaded = (p2 && p2.files) || []; return {} }
        return {}
      } },
      getURL: () => page.url,
      getTitle: () => '标题',
      executeJavaScript: async (code) => {
        // agentEval / agentHtml 的返回形状(先判,它们的代码里也含 innerText/querySelectorAll)
        if (/__bhCan/.test(code) && /scrollTop\+=/.test(code)) {
          if (!page.scrollTarget) return { no: 1 }
          page.wheelSeen = (page.wheelSeen || 0) + 1
          // ★到底了就钳位(真浏览器就是这样)—— 不钳的话"到底"和"滚动了"分不开,断言会假过
          if (!page.atEnd) page.scrollTop = (page.scrollTop || 0) + (+(code.match(/scrollTop\+=(-?\d+)/) || [])[1] || 0)
          return { ok: 1 }
        }
        if (/__bhCan/.test(code)) { return page.scrollTarget ? { pos: page.scrollTop || 0, atEnd: !!page.atEnd, what: page.scrollWhat || 'div.el-table__body' } : null }
        if (/tagName===.SELECT./.test(code)) return !!page.nativeSelect
        if (/el-select-dropdown__item/.test(code)) return page.comboOut !== undefined ? page.comboOut : { ok: 1, picked: page.comboPick || '某项' }
        if (/data-bh-upload/.test(code) && /setAttribute/.test(code)) return page.uploadFind !== undefined ? page.uploadFind : { ok: 1 }
        if (/data-bh-upload/.test(code)) return page.uploadBack !== undefined ? page.uploadBack : { n: 1, names: ['a.xlsx'] }
        if (/__v=/.test(code)) return page.evalOut !== undefined ? page.evalOut : { v: '"ok"', n: 4, t: 'string' }
        if (/outerHTML/.test(code)) return page.htmlOut !== undefined ? page.htmlOut : { h: '<div class="el-dialog">x</div>', n: 30, tag: 'div', cls: 'el-dialog' }
        if (/innerText/.test(code)) return page.text
        if (/querySelectorAll/.test(code)) return page.selCount
        return ''
      },
    }
    return { id, view: { webContents: wc }, console: [], net: [], page, dbg: true, downloads: [] }
  }
  const ctx = {
    S, log: () => {},
    brActive: () => S.browser.tabs.find((t) => t.id === S.browser.activeId) || null,
    createBrowser: () => { calls.createBrowser++ },                 // ★这条会亮出浏览器 —— Agent 不许走
    ensureBrowserBackground: () => { calls.ensureBg++; return true },
    shellBrowserVisible: (on) => { calls.visibleCalls.push(!!on) },
    newTab: (url, opts) => {
      const t = mkTab(++S.browser.seq, url)
      if (S.__failNext) { t.net.push(S.__failNext); S.__failNext = null }   // 模拟主文档请求失败
      S.browser.tabs.push(t)
      calls.newTab.push(url); calls.newTabOpts.push(opts || null)
      if (!(opts && opts.background)) S.browser.activeId = t.id   // 后台标签不当活动标签(真身同义)
      return t
    },
    closeTab: (id) => { calls.closeTab.push(id); const i = S.browser.tabs.findIndex((t) => t.id === id); if (i >= 0) S.browser.tabs.splice(i, 1) },
    activateTab: (id) => { calls.activateTab.push(id); S.browser.activeId = id },
    brScreenshot: async () => { calls.shots++; return '/tmp/shot-' + calls.shots + '.png' },
    brShotTab: async (tab, full) => {
      calls.shots++; calls.shotTabs.push(tab && tab.id)
      // 真身现在回 {path,note,buf};整页超预算时 note 非空。两种形状都要能接(自测也要覆盖对象形态)
      if (over.shotObj) return { path: '/tmp/shot-' + calls.shots + '.png', note: full ? '页面高 40000px,整页会到 114 百万像素(会很慢),只截了顶部 17361px' : '', buf: null }
      return '/tmp/shot-' + calls.shots + '.png'
    },
    execStep: async (wc, ev) => {
      calls.exec.push(ev)
      if (over.execFail) return { ok: false, err: over.execErr || '假失败' }
      if (ev.act === 'navigate') { const t = S.browser.tabs.find((x) => x.view.webContents === wc); if (t) t.page.url = ev.url }
      return { ok: true }
    },
    waitNetIdle: async () => {},
    visionInfo: async () => (over.vision || { ok: false, why: '本机没有能读图的模型' }),
    askVision: async (p2, q) => (over.vision && over.vision.ok
      ? { ok: true, answer: '看到一个表格,第一行状态是「进行中」', model: '视觉模型X' }
      : { error: '本机没有可用的读图模型' }),
    saveRec: (rec) => { calls.saved = rec; return rec.id },
    pageRead: async (tab) => (over.emptyPage
      ? { ok: true, url: tab.page.url, title: '', elements: '', text: '' }
      : { ok: true, url: tab.page.url, title: '标题', elements: 'button 「提交」  → #submit', text: tab.page.text }),
  }
  return { ba: initBrowserAgent(ctx), S, calls, ctx }
}
const tabOf = (S) => S.browser.tabs[S.browser.tabs.length - 1]

console.log('用例1:围栏 —— 缺省不限,但协议红线和留痕不许动')
{
  // 【2026-08-12 用户拍板】"浏览器支持打开 localhost 的 IP 地址,要放开这个控制。现在什么网站都应该可以访问。"
  // 于是缺省围栏改成 off。放开的是【站点】,没放开的是:
  //   ① 只允许 http/https —— file:/data: 是读本地文件的口子,任何模式下都不放行;
  //   ② 每次跨出本机都留痕 —— 权限可以放宽,痕迹不能少,否则出事时查不回来。
  const { ba } = makeCtx()
  ok('本机放行', ba.policyCheck('http://localhost:5199/x').ok && ba.policyCheck('http://127.0.0.1:8080/').ok)
  ok('★★缺省放行任意 http/https(用户拍板:什么网站都应该可以访问)',
    ba.policyCheck('https://uat.example.com/pay').ok && ba.policyCheck('http://any.site/x').ok)
  ok('★★但 file: 任何模式下都不放行(那是读本地文件的口子)', !ba.policyCheck('file:///etc/passwd').ok)
  ok('★  data: 同样不放行', !ba.policyCheck('data:text/html,<b>x').ok)
  ok('  URL 解析不了也拒(不是放行)', !ba.policyCheck('不是个网址').ok)

  const { ba: baL } = makeCtx({ settings: { browserAgent: { fence: 'local' } } })
  ok('fence=local:回到"只本机"', !baL.policyCheck('https://uat.example.com/').ok && baL.policyCheck('http://127.0.0.1/').ok)
  ok('  拒绝时说清当前是哪种围栏、怎么改', /只本机/.test(baL.policyCheck('https://x.com/').err) && /设置/.test(baL.policyCheck('https://x.com/').err))

  const { ba: baW } = makeCtx({ settings: { browserAgent: { fence: 'list', origins: ['https://uat.example.com'] } } })
  ok('fence=list:只放行清单里的', baW.policyCheck('https://uat.example.com/pay').ok && !baW.policyCheck('https://other.com/').ok)
  ok('  清单不外溢到同名前缀域', !baW.policyCheck('https://uat.example.com.evil.cn/').ok)
  ok('  清单不外溢到 http(协议不同 origin 不同)', !baW.policyCheck('http://uat.example.com/').ok)

  const { ba: ba3 } = makeCtx({ settings: { browserAgent: { enabled: false } } })
  ok('总开关关掉后连本机都不放行', !ba3.policyCheck('http://localhost:1/').ok)
}

console.log('用例2:一会话一标签页 —— 绝不共用用户正在看的那个')
{
  const { ba, S, calls } = makeCtx()
  // 先造一个"用户正在看的标签页"
  const userTab = { id: 999, view: { webContents: { isDestroyed: () => false, getURL: () => 'http://用户在看的页面/', executeJavaScript: async () => '' } }, console: [], net: [], page: { url: 'x', text: '', selCount: 0 } }
  S.browser.tabs.push(userTab); S.browser.activeId = 999
  const r = await ba.agentOpen({ url: 'http://localhost:5199/lab.html', purpose: '验组件实验室能开' })
  ok('open 成功', !!r.ok, r)
  ok('★另开了一个标签页(不是接管用户那个)', calls.newTab.length === 1 && S.browser.tabs.length === 2, calls.newTab)
  ok('  会话绑的是新标签页', S.browser.tabs[1].id !== 999)
  const rep = ba.agentClose({ sessionId: r.sessionId, status: 'done' })
  ok('close 后把自己的标签页关掉', calls.closeTab.includes(S.browser.seq), calls.closeTab)
  ok('  用户那个标签页没被动', calls.closeTab.indexOf(999) === -1)
  ok('  报告结构完整', !!rep.report && typeof rep.report.verdict === 'string', rep)
}

console.log('用例3:open 的前置校验')
{
  const { ba } = makeCtx()
  ok('缺 url 拒', !!(await ba.agentOpen({ purpose: 'x' })).error)
  // purpose 不是形式主义:浏览器是用户的,报告和界面都要显示"Agent 现在在干嘛"
  ok('★缺 purpose 拒(用户得知道 Agent 在他浏览器里干什么)', !!(await ba.agentOpen({ url: 'http://localhost:1/' })).error)
  const { ba: baF } = makeCtx({ settings: { browserAgent: { fence: 'local' } } })
  ok('越围栏的 url 在 open 阶段就拒(不会先开标签页再说)', !!(await baF.agentOpen({ url: 'https://evil.example.com/', purpose: 'x' })).error)
}

console.log('用例4:★围栏按【当前页】现查 —— 页面自己跳走了也要拦住(用 fence=local 才有围栏可越)')
{
  const { ba, S } = makeCtx({ settings: { browserAgent: { fence: 'local' } } })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/a.html', purpose: '验跳转' })
  // 模拟页面自己跳到外网(SSO/业务跳转/被挂马),不是 Agent 主动 navigate 的
  tabOf(S).page.url = 'https://生产系统.example.com/转账'
  const act = await ba.agentAct({ sessionId: r.sessionId, action: 'click', selector: '#确认转账' })
  ok('页面跳出围栏后,后续操作被拒', !!act.error, act)
  ok('  拒绝信息说清是"跳出围栏"', /跳出围栏/.test(String(act.error)), act.error)
  // 只在 open 时查一次的实现会在这里放行 —— 那正是最危险的一次点击
  const rep = ba.agentClose({ sessionId: r.sessionId, status: 'done' }).report
  ok('  越界这一步如实记进报告(不是静默吞掉)', rep.steps.some((x) => !x.ok && /围栏/.test(x.err)), rep.steps)
}

console.log('用例5:navigate 按【目标 URL】先判后跳(同样用 fence=local)')
{
  const { ba, calls } = makeCtx({ settings: { browserAgent: { fence: 'local' } } })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验导航围栏' })
  const before = calls.exec.length
  const bad = await ba.agentAct({ sessionId: r.sessionId, action: 'navigate', url: 'https://外网.example.com/' })
  ok('越界导航被拒', !!bad.error)
  ok('★而且根本没执行(先判后跳,不是跳过去再说)', calls.exec.length === before, calls.exec)
  const good = await ba.agentAct({ sessionId: r.sessionId, action: 'navigate', url: 'http://localhost:5199/b.html' })
  ok('围栏内导航正常', !!good.ok && good.url === 'http://localhost:5199/b.html', good)
}

console.log('用例6:断言 —— 六种判据都要真判,别只记流水')
{
  const { ba, S } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验断言' })
  const sid = r.sessionId
  const tab = tabOf(S)
  tab.page.text = '订单提交成功,单号 A123'
  ok('text_present 命中', (await ba.agentAssert({ sessionId: sid, kind: 'text_present', expect: '提交成功' })).pass)
  ok('text_present 未命中判失败', !(await ba.agentAssert({ sessionId: sid, kind: 'text_present', expect: '不存在的文案' })).pass)
  ok('text_absent 反向判', (await ba.agentAssert({ sessionId: sid, kind: 'text_absent', expect: '系统异常' })).pass)
  tab.page.selCount = 2
  ok('selector_exists 命中', (await ba.agentAssert({ sessionId: sid, kind: 'selector_exists', expect: '.row' })).pass)
  tab.page.selCount = 0
  ok('selector_absent 命中', (await ba.agentAssert({ sessionId: sid, kind: 'selector_absent', expect: '.err' })).pass)
  ok('url_matches 命中', (await ba.agentAssert({ sessionId: sid, kind: 'url_matches', expect: 'localhost:5199' })).pass)
  // ★这两条查的是浏览器自己采集的数据,是"页面看着正常但其实报错了"的唯一抓手
  ok('no_console_error:干净时通过', (await ba.agentAssert({ sessionId: sid, kind: 'no_console_error' })).pass)
  tab.console.push({ level: 3, message: 'Uncaught TypeError: x is not a function', source: 'app.js', line: 12 })
  const ce = await ba.agentAssert({ sessionId: sid, kind: 'no_console_error' })
  ok('★no_console_error:有错就判失败(页面可能看着正常)', !ce.pass && /TypeError/.test(ce.actual), ce)
  ok('no_failed_request:干净时通过', (await ba.agentAssert({ sessionId: sid, kind: 'no_failed_request' })).pass)
  tab.net.push({ status: 500, method: 'POST', url: '/api/submit', state: 'done' })
  ok('★no_failed_request:5xx 判失败', !(await ba.agentAssert({ sessionId: sid, kind: 'no_failed_request' })).pass)
  ok('未知断言类型报错(不是静默判过)', !!(await ba.agentAssert({ sessionId: sid, kind: '瞎编的' })).error)
}

console.log('用例7:★verdict 是机判的 —— 调用方说了不算')
{
  // (a) 有断言且全过 → PASS
  {
    const { ba, S } = makeCtx()
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: 'p' })
    tabOf(S).page.text = 'ok'
    await ba.agentAssert({ sessionId: r.sessionId, kind: 'text_present', expect: 'ok' })
    ok('全过 → PASS', ba.agentClose({ sessionId: r.sessionId, status: 'done' }).report.verdict === 'PASS')
  }
  // (b) 一条断言都没做 → INCONCLUSIVE("打开看了一眼"不是验证)
  {
    const { ba } = makeCtx()
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: 'p' })
    const rep = ba.agentClose({ sessionId: r.sessionId, status: 'done' }).report
    ok('★零断言 → INCONCLUSIVE,不是 PASS(打开看了一眼 ≠ 验过了)', rep.verdict === 'INCONCLUSIVE', rep.verdict)
  }
  // (c) 断言失败 → 即便自报 done 也是 FAIL
  {
    const { ba, S } = makeCtx()
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: 'p' })
    tabOf(S).page.text = ''
    await ba.agentAssert({ sessionId: r.sessionId, kind: 'text_present', expect: '成功', label: '应出现成功提示' })
    const rep = ba.agentClose({ sessionId: r.sessionId, status: 'done' }).report
    ok('★断言失败 → FAIL(自报 done 也没用)', rep.verdict === 'FAIL', rep.verdict)
    ok('  失败项写进报告', rep.failures.some((x) => /应出现成功提示/.test(x)), rep.failures)
  }
  // (d) 步骤失败 → FAIL(点不动就是没验成)
  {
    const { ba } = makeCtx({ execFail: true })
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: 'p' })
    await ba.agentAct({ sessionId: r.sessionId, action: 'click', selector: '#go' })
    ok('★步骤失败 → FAIL(哪怕没做断言)', ba.agentClose({ sessionId: r.sessionId, status: 'done' }).report.verdict === 'FAIL')
  }
  // (e) 自报 failed → FAIL
  {
    const { ba, S } = makeCtx()
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: 'p' })
    tabOf(S).page.text = 'ok'
    await ba.agentAssert({ sessionId: r.sessionId, kind: 'text_present', expect: 'ok' })
    ok('自报 failed → FAIL(断言全过也不翻案)', ba.agentClose({ sessionId: r.sessionId, status: 'failed', note: '环境起不来' }).report.verdict === 'FAIL')
  }
}

console.log('用例7.5:开浏览器不许抢屏 —— 浏览器是对话的辅助能力,不是"一用它对话就没了"')
{
  // 【真机 2026-08-11,用户连着两次"又把我的会话毁掉了"】
  // agentOpen 原来调 createBrowser(),而它在宿主模式下第一句就是 shellBrowserVisible(true) ——
  // 浏览器 chrome + 写死的那张「调试助手」卡一起挂上主窗,把用户正在看的对话【盖掉】,
  // 还在「历史」里凭空多一条「调试助手」。这一格把三条不变量钉死。
  const { ba, S, calls } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验证后台开' })
  ok('★走后台承载,不调 createBrowser(那条会亮出浏览器)', !!r.ok && calls.ensureBg === 1 && calls.createBrowser === 0,
    { ensureBg: calls.ensureBg, createBrowser: calls.createBrowser })
  ok('★开的是【后台标签】(background:true)', !!(calls.newTabOpts[0] && calls.newTabOpts[0].background), calls.newTabOpts)
  ok('★★一次都没有改可见性(shellBrowserVisible 压根不该被调)', calls.visibleCalls.length === 0, calls.visibleCalls)
  ok('  后台标签不当活动标签(用户的视图不受影响)', S.browser.activeId === null, S.browser.activeId)
  ok('  也没抢焦点式地 activateTab', calls.activateTab.length === 0, calls.activateTab)
}

console.log('用例7.6:ref 句柄要在【真模块】里也认(ref:test 那份是镜像,会漂)')
{
  // 【真机 2026-08-11】browser_read 回「[ref_58] textbox "…"」,模型写 selector:"ref_58",
  // 而 agentAct 原来只认独立的 ref 参数 → ref_58 当 CSS 选择器丢给 querySelector,必然找不到,
  // 然后它连猜 4 个 .el-dialog .frow:nth-of-type(3) 这种选择器,每次白等 4 秒。
  // ref:test 里那份解析是【手抄的镜像】,抄本对了不代表真身对 —— 这一格走真模块。
  const { ba, S, calls } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验 ref' })
  await ba.agentAct({ sessionId: r.sessionId, action: 'type', selector: 'ref_58', value: 'x' })
  ok('★★selector:"ref_58" 在真模块里也解析成 data-bh-ref 选择器',
    calls.exec[calls.exec.length - 1].sel === '[data-bh-ref="58"]', calls.exec[calls.exec.length - 1])
  await ba.agentAct({ sessionId: r.sessionId, action: 'click', ref: 'ref_7' })
  ok('  ref 参数照旧', calls.exec[calls.exec.length - 1].sel === '[data-bh-ref="7"]', calls.exec[calls.exec.length - 1])
  await ba.agentAct({ sessionId: r.sessionId, action: 'click', selector: '#submit' })
  ok('  正常选择器不被误认', calls.exec[calls.exec.length - 1].sel === '#submit', calls.exec[calls.exec.length - 1])
  await ba.agentAct({ sessionId: r.sessionId, action: 'click', selector: '__text__:a|refresh' })
  ok('  含 ref 字样的文本选择器也不被误认', calls.exec[calls.exec.length - 1].sel === '__text__:a|refresh', calls.exec[calls.exec.length - 1])
  S.browser.tabs.length && ba.agentClose({ sessionId: r.sessionId, status: 'done' })
}

console.log('用例7.7:"找不到元素"的回执要指出下一步,不能让它接着猜')
{
  const { ba } = makeCtx({ execFail: true, execErr: 'selector(+alt) not found (waited 4000ms)' })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验回执' })
  const act = await ba.agentAct({ sessionId: r.sessionId, action: 'type', selector: 'ref_58', value: 'x' })
  ok('★回执里点名"重新 browser_read"(真机它收到裸报错后连猜 4 个选择器,每次白等 4 秒)',
    /browser_read/.test(String(act.error)), act.error)
  ok('  并且明说旧 ref 会失效(弹层/新页面之后)', /失效/.test(String(act.error)), act.error)
  ok('  也给出视口外的处理(scroll 再读)', /scroll/.test(String(act.error)), act.error)
  ok('  原始技术报错照旧保留(排查要看它)', /not found/.test(String(act.error)), act.error)
}

console.log('用例7.8:eval / html —— 模型在真机思考里连问了五次"会话组有没有 eval"')
{
  // 【真机 2026-08-11 思考过程原文】「实际上内嵌浏览器可执行 JS 吗?工具集里 BocomHermes-browser
  // 有 headless_eval 但那是 headless。会话组没有 eval。」—— 它要的就是"让我自己查一下这页长什么样"。
  // 没有这条路,它只能拿 read 的扁平清单猜结构:弹层里 6 个一样的数字输入框,它烧了六屏推理拼
  // nth-of-type 全废,最后跑去 rg/sed 读 .vue 源码。缺一件工具的代价不是少一个功能,
  // 是模型把 token 全烧在绕路上。
  // 用 fence=local 才有"跳出围栏"可言(缺省 off 是放行任意站点)
  const { ba, S } = makeCtx({ settings: { browserAgent: { fence: 'local' } } })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验 eval/html' })
  const sid = r.sessionId
  ok('★eval 能跑并回结果 + 类型', (() => { const p = tabOf(S).page; p.evalOut = { v: '6', n: 1, t: 'number' }; return true })())
  const e1 = await ba.agentEval({ sessionId: sid, expr: 'document.querySelectorAll("input").length' })
  ok('  结果与类型都带回', !!e1.ok && e1.result === '6' && e1.type === 'number', e1)
  ok('  缺 expr → 明确说要什么,并给一个例子', /必填/.test(String((await ba.agentEval({ sessionId: sid })).error)), (await ba.agentEval({ sessionId: sid })).error)
  ok('  expr 过长拒(查结构不需要那么长)', !!(await ba.agentEval({ sessionId: sid, expr: 'x'.repeat(4001) })).error)
  tabOf(S).page.evalOut = { err: 'x is not defined' }
  const e2 = await ba.agentEval({ sessionId: sid, expr: 'x' })
  ok('★JS 自己报错要说清"是表达式的错,不是页面没这个元素"(两种处境的下一步完全不同)',
    /表达式本身的错/.test(String(e2.error)), e2.error)
  tabOf(S).page.evalOut = { v: '"' + 'y'.repeat(9000) + '"', n: 9002, t: 'string' }
  const e3 = await ba.agentEval({ sessionId: sid, expr: 'big' })
  ok('  输出超上限要如实回报(不说的话它会把截断当全部)', !!e3.truncated, e3.truncated)

  const h1 = await ba.agentHtml({ sessionId: sid })
  ok('★html 不给选择器 → 给最上层弹层(那才是当下在操作的东西)', !!h1.ok && h1.rootClass === 'el-dialog', h1)
  tabOf(S).page.htmlOut = { err: '没找到 [data-bh-ref="58"]' }
  ok('  html 也认 selector:"ref_58"(与 act 同口径)', /data-bh-ref="58"/.test(String((await ba.agentHtml({ sessionId: sid, selector: 'ref_58' })).error)))
  // 围栏:页面跳出去之后这两条也必须拒(它们能读到页面全部内容)
  tabOf(S).page.url = 'https://生产系统.example.com/x'
  ok('★★跳出围栏后 eval 被拒(它能读走整页内容,不能比 act 松)', /跳出围栏/.test(String((await ba.agentEval({ sessionId: sid, expr: '1' })).error)))
  ok('★★跳出围栏后 html 同样被拒', /跳出围栏/.test(String((await ba.agentHtml({ sessionId: sid })).error)))
}

console.log('用例7.9:打开失败必须报错,不许回 ok —— 用户看到的是一张白图')
{
  // 【真机 2026-08-11,用户原话"截图毁了"】dev server 没在跑(5173 上是【另一个项目】、还只监听 IPv6),
  // 主文档 ERR_CONNECTION_REFUSED,而 open 照样回 ok:true(只是 elements/text 空)。
  // 模型接着截图 → 一张全白的图 → 对用户说"已启动并截图"。
  // 用户看到白图,真因在三层之外。"打开失败"和"页面是空的"必须在第一步就分开。
  const { ba, S, calls } = makeCtx()
  const url = 'http://127.0.0.1:5173/overview'
  // 让这次 open 的主文档请求落一条 failed(与真身 tab.net 同形状)
  // 开之前先埋好"下一次建的标签要带一条失败的主文档请求"
  S.__failNext = { state: 'failed', url, failText: 'net::ERR_CONNECTION_REFUSED' }
  const r = await ba.agentOpen({ url, purpose: '验打开失败' })
  ok('★★连接被拒 → 报错,不是 ok(回 ok 的后果就是那张白图)', !!r.error && !r.ok, r)
  ok('  错误里带上真因原文(ERR_CONNECTION_REFUSED)', /CONNECTION_REFUSED/.test(String(r.error)), r.error)
  ok('★  并点出 127.0.0.1 与 localhost 不是一回事(真机就是栽在 IPv6-only 上)',
    /localhost/.test(String(r.error)) && /IPv6|::1/.test(String(r.error)), r.error)
  ok('  失败的标签页要收掉,不留孤儿', calls.closeTab.length === 1, calls.closeTab)
  ok('  会话也不许留(留着后续每个工具都对着一个死会话报错)',
    !!(await ba.agentRead({ sessionId: String(r.sessionId || 'x') })).error)

  // 打开成功但页面是空壳 → 不报错,但要明确警告
  const h2 = makeCtx({ emptyPage: true })
  const r2 = await h2.ba.agentOpen({ url: 'http://127.0.0.1:5173/', purpose: '验空壳' })
  ok('★页面打开了但一个元素/几乎一个字都没有 → 给 warning(别让它把空页当"这页就是没东西")',
    !!r2.ok && /没挂载完|不是你以为的那个项目/.test(String(r2.warning || '')), r2.warning)
  ok('  warning 指出下一步是先 eval 看一眼,别急着截图', /browser_eval/.test(String(r2.warning || '')), r2.warning)
}

console.log('用例7.10:截图回执要说实话 ——「你自己能不能看这张图」')
{
  // 【用户 2026-08-12】"只有主模型不会识图,感觉会走很多偏路"。查实:这台 serve 12 个模型
  // input 全空、attachment 全 None,一个都不能读图;而 settings.modelVision 存着一个同样不能读图的
  // deepseek-v4-flash —— 空架子。回执以前写着"要看就把它当附件读一遍",模型照做,拿回
  // 「image omitted: could not be resized below the image size limit」白烧一轮,然后改去翻数据库、
  // 翻后端源码找答案(真机就是这么走偏的)。说不了就说不了,并且把还能用的路指出来。
  {
    const { ba } = makeCtx({ vision: { ok: false, why: '本机没有能读图的模型' } })
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验回执' })
    const sh = await ba.agentShot({ sessionId: r.sessionId })
    ok('★★没有读图模型 → 明说"你看不了",不要它去 read 那个 png',
      sh.youCanSeeIt === false && /看不了/.test(String(sh.note)) && /别去 read/.test(String(sh.note)), sh.note)
    ok('  并且指出还能用的三条路(read/eval/html 给的是文字)',
      /browser_read/.test(String(sh.note)) && /browser_eval/.test(String(sh.note)) && /browser_html/.test(String(sh.note)), sh.note)
    ok('  带上具体原因,便于用户去设置里改', /本机没有能读图的模型/.test(String(sh.note)), sh.note)
  }
  {
    const { ba } = makeCtx({ vision: { ok: true, why: '' } })
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验回执' })
    const sh = await ba.agentShot({ sessionId: r.sessionId })
    ok('★配了真能读图的模型 → 才说"读一遍"', sh.youCanSeeIt === true && /当附件读一遍/.test(String(sh.note)), sh.note)
    ok('  这时不许再说"你看不了"', !/看不了/.test(String(sh.note)), sh.note)
  }
}

console.log('用例7.11:组件库下拉一次做完(el-select 不是原生 select)')
{
  const { ba, S } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验下拉' })
  const p = tabOf(S).page
  p.nativeSelect = false; p.comboPick = '进行中'
  const r1 = await ba.agentAct({ sessionId: r.sessionId, action: 'select', selector: '.el-select', text: '进行中' })
  ok('★★非原生下拉:一次调用里点开+按文本选中(原来要 点→read→点 三次往返)',
    !!r1.ok && r1.picked === '进行中', r1)
  ok('  不给 text 就明说要什么', /要给 text/.test(String((await ba.agentAct({ sessionId: r.sessionId, action: 'select', selector: '.el-select' })).error)))
  p.comboOut = { err: '浮层里没有匹配的选项', options: ['待开始', '已完成'] }
  const r2 = await ba.agentAct({ sessionId: r.sessionId, action: 'select', selector: '.el-select', text: '不存在' })
  ok('★找不到时把【浮层里实际有哪些项】带回来(比一句"没找到"有用得多,真因常是文案对不上)',
    /待开始/.test(String(r2.error)) && /已完成/.test(String(r2.error)), r2.error)
  p.nativeSelect = true; p.comboOut = undefined
  const r3 = await ba.agentAct({ sessionId: r.sessionId, action: 'select', selector: 'select#s', value: 'a' })
  ok('  原生 <select> 照旧走原生那条路(不许把老路踩坏)', !!r3.ok && r3.picked === undefined, r3)
}

console.log('用例7.12:文件上传(业务系统"上传附件"整类流程靠它)')
{
  const { ba, S } = makeCtx({ settings: { projectDir: '/tmp' } })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验上传' })
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')
  const pathm = await import('node:path')
  const dir = fs2.mkdtempSync(pathm.join(os2.tmpdir(), 'bh-up-'))
  const good = pathm.join(dir, 'a.xlsx'); fs2.writeFileSync(good, 'x')
  const { ba: ba2, S: S2 } = makeCtx({ settings: { projectDir: dir } })
  const r2 = await ba2.agentOpen({ url: 'http://localhost:5199/', purpose: '验上传' })
  const up = await ba2.agentUpload({ sessionId: r2.sessionId, files: [good], selector: 'input[type=file]' })
  ok('★★允许目录里的文件能放进去', !!up.ok && tabOf(S2).page.uploaded[0] === fs2.realpathSync(good), up)
  ok('  回执带文件名', (up.files || []).includes('a.xlsx'), up)
  ok('  缺 files 明确拒', /files 必填/.test(String((await ba2.agentUpload({ sessionId: r2.sessionId })).error)))
  ok('  文件不存在明确拒', /不存在/.test(String((await ba2.agentUpload({ sessionId: r2.sessionId, files: ['/nope/x.txt'] })).error)))
  const bad = await ba2.agentUpload({ sessionId: r2.sessionId, files: ['/etc/hosts'] })
  ok('★★白名单外的文件坚决拒(浏览器带着用户的登录态,不能拿它把任意本地文件送进业务系统)',
    /拒绝上传/.test(String(bad.error)) && /登录态/.test(String(bad.error)), bad.error)
  ok('  并且告诉用户怎么办(拷到允许目录),不是干拒', /拷到/.test(String(bad.error)), bad.error)
  // 回读:文件没进去要判失败,不许假成功(与 type 同一条教训)
  tabOf(S2).page.uploadBack = { n: 0, names: [] }
  const nf = await ba2.agentUpload({ sessionId: r2.sessionId, files: [good] })
  ok('★放完要回读:文件没进去就判失败(不许"报成功、实际没做到")', !!nf.error && /没有进到输入框/.test(String(nf.error)), nf)
  try { fs2.rmSync(dir, { recursive: true, force: true }) } catch {}
  void r; void S
}

console.log('用例7.13:下载留痕 ——「点了导出」不等于「导出成功」')
{
  const { ba, S } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验导出' })
  const t = tabOf(S)
  const d1 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'download_ok', label: '导出' })
  ok('★一次下载都没有 → 断言不过,并说清"点了导出但浏览器没收到文件"',
    !d1.pass && /一次下载都没发生/.test(String(d1.actual)), d1.actual)
  t.downloads = [{ name: '采购单.xlsx', state: 'completed', bytes: 20480, path: '/tmp/采购单.xlsx', url: 'http://x/export' }]
  const d2 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'download_ok', expect: '.xlsx', label: '导出' })
  ok('★★真的落盘且字节非 0 → 过,并把文件名/大小/路径写进报告', !!d2.pass && /20480B/.test(String(d2.actual)) && /\/tmp\//.test(String(d2.actual)), d2.actual)
  t.downloads = [{ name: 'x.csv', state: 'interrupted', bytes: 0, path: '', url: '' }]
  const d3 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'download_ok', label: '导出' })
  ok('  下载中断/0 字节 → 不过(这才是"导出坏了"的样子)', !d3.pass && /interrupted/.test(String(d3.actual)), d3.actual)
  t.downloads = [{ name: 'other.pdf', state: 'completed', bytes: 99, path: '/tmp/o.pdf', url: '' }]
  const d4 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'download_ok', expect: '.xlsx', label: '导出' })
  ok('  文件名对不上也不算过(别拿别的下载冒领)', !d4.pass && /没有匹配/.test(String(d4.actual)), d4.actual)
  const dg = await ba.agentDiag({ sessionId: r.sessionId })
  ok('  diag 里能看到下载清单(排查时不用另开工具)', Array.isArray(dg.downloads) && dg.downloads.length === 1, dg.downloads)
}

console.log('用例7.14:反向用例(故意输错、期望被拦)—— 正例能跑不等于反例能跑')
{
  // 【用户 2026-08-12 问"现在是不是完全可以正常跑测试案例了(正反案例,人写的)"】
  // 查下来正例基本够了,反例会【反着错】:
  //   一条正确的反向用例(提交空表单 → 期望 400 + 页面提示)会被 no_failed_request 判成失败,
  //   而 AGENTS.md 还让它每次都验这一条 —— 用例写对了、结论是错的,这比不支持更坏。
  //   而且"后端到底拒没拒"当时压根没有断言能表达(页面弹红字只能证明前端显示了什么)。
  const { ba, S } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验反向用例' })
  const t = tabOf(S)
  t.net = [{ url: 'http://x/api/purchase', status: 400, state: 'complete' }, { url: 'http://x/api/list', status: 200, state: 'complete' }]
  t.console = [{ level: 3, message: 'POST /api/purchase 400 (Bad Request)' }]

  const a1 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'no_failed_request', label: '无失败请求' })
  ok('不豁免时:预期内的 400 照旧算失败(老行为不变)', !a1.pass, a1.actual)
  const a2 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'no_failed_request', expect: '400', label: '除预期外无失败' })
  ok('★★反例豁免:expect 给状态码/片段后,预期内的失败不再拖垮用例', !!a2.pass && /已豁免/.test(String(a2.actual)), a2.actual)
  const a3 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'no_console_error', expect: 'Bad Request', label: '除预期外无报错' })
  ok('  控制台同样能豁免(反例里页面本来就会报这个错)', !!a3.pass && /已豁免/.test(String(a3.actual)), a3.actual)

  const b1 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'request_status', expect: '/api/purchase 400', label: '后端拒了脏数据' })
  ok('★★request_status:断言后端【确实】返回 400(页面弹红字只能证明前端显示了什么)', !!b1.pass && /400/.test(String(b1.actual)), b1.actual)
  const b2 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'request_status', expect: '/api/purchase 200', label: '错的期望' })
  ok('  期望对不上要说清实际是多少', !b2.pass && /状态码是 400/.test(String(b2.actual)), b2.actual)
  const b3 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'request_status', expect: '/api/nope 400', label: '没这个请求' })
  ok('  压根没这个请求要单独说(可能前端没发出去/路径写错)', !b3.pass && /没有】匹配/.test(String(b3.actual)), b3.actual)
  ok('  expect 形状不对要明确拒', /形如/.test(String((await ba.agentAssert({ sessionId: r.sessionId, kind: 'request_status', expect: '/api/x' })).error)))

  const c1 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'no_request', expect: '/api/submit', label: '前端拦住了' })
  ok('★no_request:断言这个接口【没有】被调用(必填为空时前端就该拦住)', !!c1.pass && /前端拦住了/.test(String(c1.actual)), c1.actual)
  const c2 = await ba.agentAssert({ sessionId: r.sessionId, kind: 'no_request', expect: '/api/purchase', label: '本不该发' })
  ok('  真发出去了就要判失败并指出是哪条', !c2.pass && /不该发出去却发了/.test(String(c2.actual)), c2.actual)
  ok('  缺 expect 明确拒', /要给 url 片段/.test(String((await ba.agentAssert({ sessionId: r.sessionId, kind: 'no_request' })).error)))
  ok('  未知判据的提示里带上新增的这几种', /request_status/.test(String((await ba.agentAssert({ sessionId: r.sessionId, kind: '瞎写' })).error)))
}

console.log('用例7.15:整页截图有像素预算 —— 截断了要如实说')
{
  // 【2026-08-12 内网 MCP error -32001】客户端等超时。根因:整页截图没有成本上限 ——
  // 老代码高度上限 30000 CSS px,后台标签又是 2 倍分辨率 → 最坏 1.7 亿像素(裸位图约 680MB),
  // Chromium 编码 + base64 传回 + 主进程再解码缩放全在主线程,慢机器上几十秒到几分钟,
  // 期间 relay 连别的请求都答不了。现在封顶到 2500 万像素、整页出 1 倍图;
  // 而封顶就意味着【截断】—— 不说的话模型会把"顶部一屏"当成整页,后面的内容当成不存在。
  const { ba } = makeCtx({ shotObj: true })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验截断回报' })
  const s1 = await ba.agentShot({ sessionId: r.sessionId, full: true })
  ok('★★整页超预算被截断 → 回执里如实说', !!s1.ok && /只截了顶部/.test(String(s1.truncated || '')), s1)
  ok('  并给下一步(scroll 后再截一张)', /scroll/.test(String(s1.truncated || '')), s1.truncated)
  const s2 = await ba.agentShot({ sessionId: r.sessionId })
  ok('  没截断就不加噪音', !s2.truncated, s2)
}

console.log('用例7.16:滚轮 —— 内层容器才是真正要滚的那个')
{
  // 【用户 2026-08-12 问"是不是还没有鼠标滚轮的能力"】原来只有 window.scrollBy:
  //   ① 内层滚动容器(表格体 / el-scrollbar / 弹层 / 侧栏)一动不动 —— 业务系统里真正带滚动条的就是它们;
  //   ② 依赖 wheel 事件的组件(虚拟滚动、无限加载、自定义滚动条、地图缩放)收不到任何信号。
  // ★真机实测还查出一件事:后台标签【收不到真实输入事件】(sendInputEvent 的 wheel 监听器计数为 0),
  //   所以真正干活的是"合成 wheel 事件 + 直接滚",真实事件只是标签在前台时的锦上添花。
  const { ba, S } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验滚轮' })
  const p = tabOf(S).page
  p.scrollTarget = true; p.scrollTop = 0; p.scrollWhat = 'div.el-table__body'
  const w1 = await ba.agentAct({ sessionId: r.sessionId, action: 'wheel', selector: '.el-table', direction: 'down', amount: 500 })
  ok('★★滚的是内层容器,不是整页', !!w1.ok && w1.moved === 500 && /el-table__body/.test(String(w1.target)), w1)
  ok('★派发了 wheel 事件(虚拟滚动/无限加载只认它)', (p.wheelSeen || 0) > 0, p.wheelSeen)
  ok('  回执说清滚的是谁、滚了多少', /已滚动 500px/.test(String(w1.scrolled)) && /el-table__body/.test(String(w1.scrolled)), w1.scrolled)

  p.atEnd = true
  const w2 = await ba.agentAct({ sessionId: r.sessionId, action: 'wheel', selector: '.el-table', direction: 'down', amount: 500 })
  ok('★"已经到底"和"滚不动"要分得开(前者是正常结束,后者是找错了地方)',
    !!w2.ok && w2.atEnd === true && /到底/.test(String(w2.scrolled)), w2)

  p.scrollTarget = false
  const w3 = await ba.agentAct({ sessionId: r.sessionId, action: 'wheel', selector: '.nope', direction: 'down' })
  ok('★压根没有可滚容器 → 报错并指路(别让它以为滚过了)',
    !!w3.error && /没有可滚动的容器/.test(String(w3.error)) && /内层容器/.test(String(w3.error)), w3)

  // scroll + ref 的老语义(滚到元素)不许被改坏
  p.scrollTarget = true
  const sc = await ba.agentAct({ sessionId: r.sessionId, action: 'scroll', selector: '#x' })
  ok('  scroll+ref 仍是"滚到那个元素"(老语义不动)', !!sc.ok && /滚到元素/.test(String(sc.scrolled)), sc)
}

console.log('用例7.17:流程沉淀 —— 试错跑通的东西不能只留在这一个会话里')
{
  // 【用户 2026-08-12】"试错了很多次后跑通了还是没法在其他会话中复用。要提供流程自主沉淀的能力。"
  // 关键不是"存下来",是【存成能被现成引擎回放的东西】:本仓已有录制技能的整套回放
  // (选择器自愈 selAlt、参数化、skill_run、断点接管),所以沉淀只要写成同样形状的录制文件。
  // 另造一套"Agent 专用流程"是错的 —— 回放里最难的那些全要重写一遍。
  const { ba, S, calls } = makeCtx()
  const r = await ba.agentOpen({ url: 'http://localhost:5199/login', purpose: '验沉淀' })
  ok('★还没做过任何改变状态的动作 → 不许沉淀(只有读页/截图没什么可存的)',
    /没有任何/.test(String(ba.agentSaveFlow({ sessionId: r.sessionId, name: 'x' }).error)))
  await ba.agentAct({ sessionId: r.sessionId, action: 'type', selector: '#user', value: 'admin' })
  await ba.agentAct({ sessionId: r.sessionId, action: 'type', selector: 'input[type=password]', value: 'admin123' })
  await ba.agentAct({ sessionId: r.sessionId, action: 'click', selector: '#login' })
  await ba.agentAct({ sessionId: r.sessionId, action: 'scroll', direction: 'down' })   // 辅助动作,不该进流程
  const sv = ba.agentSaveFlow({ sessionId: r.sessionId, name: '登录并进首页', description: '验证用' })
  ok('★★存进技能库', !!sv.ok && !!sv.skillId, sv)
  const rec = calls.saved
  ok('  形状与人工录制一致(skill/events/startUrl)', !!rec.skill && Array.isArray(rec.events) && /login/.test(String(rec.startUrl)), Object.keys(rec || {}))
  ok('★  只收会改变页面状态的动作(scroll 这类辅助动作不进去)',
    rec.events.filter((e) => e.act === 'scroll' || e.act === 'wheel').length === 0, rec.events.map((e) => e.act))
  ok('  首步是 navigate 到起始页(回放要能自己走到那儿)', rec.events[0].act === 'navigate')
  ok('★★密码不落明文(与人工录制同一条口径)', (() => {
    const pw = rec.events.find((e) => e.secret)
    return !!pw && pw.value === undefined
  })(), rec.events)
  ok('  回执告诉它别的会话怎么用', /skill_run/.test(String(sv.note)), sv.note)
}

console.log('用例7.18:多模态 —— 让视觉模型替它看,回来的是文字')
{
  // 【用户 2026-08-12】"要学会用多模态模型解决问题。这个要教会 Agent。"
  // 教法不是"劝主模型去读图"——本机主模型根本不支持图片输入,劝它只会白烧一轮
  // (真机实录:read 那个 png → "image omitted: could not be resized")。
  // 正确做法:截图 → 壳层拿去问视觉模型 → 把答案当【文字】还给主模型。
  {
    const { ba } = makeCtx({ vision: { ok: true } })
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验看图' })
    const see = await ba.agentSee({ sessionId: r.sessionId, question: '第一行状态是什么' })
    ok('★★看图结果以【文字】回来(主模型不需要自己有视觉能力)', !!see.ok && /进行中/.test(String(see.answer)), see)
    ok('  说清这是视觉模型看的、你自己没读到图', /视觉模型/.test(String(see.note)) && /没读到图/.test(String(see.note)), see.note)
    ok('★  提醒涉及数值要再用 eval 核一次(看图会看错)', /browser_eval/.test(String(see.note)), see.note)
  }
  {
    const { ba } = makeCtx({ vision: { ok: false, why: '本机没有能读图的模型' } })
    const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验看图' })
    const see = await ba.agentSee({ sessionId: r.sessionId })
    ok('  没有读图模型时明确报错并指路(不是静默失败)', !!see.error && /读图模型/.test(String(see.error)), see.error)
  }
}

console.log('用例7.19:原地打转要能自己停 —— 卡住时的应对')
{
  // 【真机 2026-08-11 实录】元素找不到时,模型连猜 4 个 .el-dialog .frow:nth-of-type(3) 这种选择器,
  // 每次白等 4 秒,一直烧到用户把它掐掉。模型自己判断不出"我在打转"——
  // 它每一步都觉得"这次换个写法应该行"。所以这道闸必须由壳层来落,而且要拦在【执行之前】:
  // 拦在之后的话那 4 秒等待照样白烧,而那正是最贵的部分。
  const { ba, calls } = makeCtx({ execFail: true, execErr: 'selector(+alt) not found' })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: '验打转' })
  const same = async () => ba.agentAct({ sessionId: r.sessionId, action: 'click', selector: '#same' })
  await same(); await same()
  const before = calls.exec.length
  const r3 = await same()
  ok('★★同一个动作试到第 3 次 → 拦下,不再执行', !!r3.error && calls.exec.length === before, { err: String(r3.error).slice(0, 60), exec: calls.exec.length - before })
  ok('  说清"这是在原地打转,再试也是同样结果"', /原地打转/.test(String(r3.error)), r3.error)
  ok('★  把【已经试过什么】列出来(不然它不知道自己重复了)', /已经试过/.test(String(r3.error)), r3.error)
  ok('★★给出还没试过的手段(read/html/eval/see),不是干拒', (() => {
    const e = String(r3.error)
    return /browser_read/.test(e) && /browser_html/.test(e) && /browser_eval/.test(e) && /browser_see/.test(e)
  })(), r3.error)
  ok('★★最后一条是【停手去问用户】—— 继续烧只是浪费他的额度',
    /停手/.test(String(r3.error)) && /告诉用户/.test(String(r3.error)), String(r3.error).slice(-90))

  // 连续多次失败(即使每次目标不同)也要拦:那同样是卡住,只是换着花样卡
  const { ba: ba2 } = makeCtx({ execFail: true, execErr: 'not found' })
  const r2 = await ba2.agentOpen({ url: 'http://localhost:5199/', purpose: '验连败' })
  for (let i = 0; i < 5; i++) await ba2.agentAct({ sessionId: r2.sessionId, action: 'click', selector: '#s' + i })
  const r4 = await ba2.agentAct({ sessionId: r2.sessionId, action: 'click', selector: '#other' })
  ok('★连续 5 次全失败(每次目标都不同)也拦 —— 换着花样猜同样是卡住',
    !!r4.error && /全部失败/.test(String(r4.error)), String(r4.error).slice(0, 70))

  // 成功一次就该清零:别把正常流程误伤成"打转"
  const { ba: ba3 } = makeCtx()
  const r5 = await ba3.agentOpen({ url: 'http://localhost:5199/', purpose: '验不误伤' })
  for (let i = 0; i < 10; i++) {
    const rr = await ba3.agentAct({ sessionId: r5.sessionId, action: 'click', selector: '#a' + (i % 4) })
    if (rr.error) { ok('★不许误伤正常流程(动作各不相同且都成功)', false, rr.error); break }
    if (i === 9) ok('★不许误伤正常流程(动作各不相同且都成功)', true)
  }
}

console.log('用例8:会话生命周期 —— 超时/并发/重复收/取证')
{
  const { ba, S, calls } = makeCtx()
  // 并发上限:每个会话占一个可见标签页,不能无限开
  const rs = []
  for (let i = 0; i < 4; i++) rs.push(await ba.agentOpen({ url: 'http://localhost:5199/' + i, purpose: 'p' + i }))
  ok('并发上限 3(第 4 个被拒)', rs.slice(0, 3).every((r) => r.ok) && !!rs[3].error, rs[3])
  // 截图:要截【本会话的】标签页,但绝不能为此把它切到前台 —— 那会把用户正在看的页面抢走。
  // ★这一格原来钉的正是【旧的有害行为】("截图前 activateTab 到自己的标签"),
  //   真机后果:用户连着两次"又把我的会话毁掉了"。断言写反了比没有断言更糟 ——
  //   它把错的行为变成了"改不动的契约"。现在钉的是:截对了页面 + 一次都没抢焦点。
  const userTabId = S.browser.tabs[2].id
  S.browser.activeId = userTabId                    // 假装用户正在看第 3 个标签
  const ownTabId = S.browser.tabs.find((t) => t.page.url === 'http://localhost:5199/0').id
  const shot = await ba.agentShot({ sessionId: rs[0].sessionId })
  ok('★截的是本会话自己的标签页(不是用户当下在看的那个)',
    !!shot.ok && calls.shotTabs[calls.shotTabs.length - 1] === ownTabId, { shotTabs: calls.shotTabs, ownTabId })
  ok('★★而且没有把它切到前台 —— 用户的活动标签一动都不许动',
    calls.activateTab.length === 0 && S.browser.activeId === userTabId, { activateTab: calls.activateTab, activeId: S.browser.activeId, userTabId })
  ok('  截图进报告', ba.agentClose({ sessionId: rs[0].sessionId, status: 'done' }).report.shots.length === 1)
  // 重复收:幂等返回原报告,不炸也不重复关标签
  const again = ba.agentClose({ sessionId: rs[0].sessionId, status: 'done' })
  ok('重复 close 幂等(返回原报告)', !!again.ok && again.report.verdict === 'INCONCLUSIVE')
  ok('不存在的会话报错', !!ba.agentClose({ sessionId: '没这个' }).error)
  ok('会话结束后不能再操作', !!(await ba.agentAct({ sessionId: rs[0].sessionId, action: 'click', selector: '#x' })).error)
  // dropAll:关卡/退出兜底,别把标签页和会话留成孤儿
  ba.dropAll('测试收摊')
  ok('dropAll 收干净所有存活会话', ba.__sessions.size === 0)
}

console.log('用例9:超时会话自动失效(时间盒)')
{
  const { ba } = makeCtx({ settings: { browserAgent: { minutes: 1 } } })
  const r = await ba.agentOpen({ url: 'http://localhost:5199/', purpose: 'p' })
  const s = ba.__sessions.get(r.sessionId)
  s.expiresAt = Date.now() - 1   // 手动把它推过期(不睡一分钟)
  const act = await ba.agentAct({ sessionId: r.sessionId, action: 'click', selector: '#x' })
  ok('空闲超时后操作被拒', !!act.error)
  const rep2 = ba.agentClose({ sessionId: r.sessionId }).report || ba.__sessions.get(r.sessionId).result
  ok('★超时判 INCONCLUSIVE,不判 FAIL —— 那是壳层定时器到点,不是"验证没过"',
    (rep2 && rep2.verdict) === 'INCONCLUSIVE', rep2 && rep2.verdict)
  ok('  但会话确实被收掉了(不留僵尸)', (rep2 && rep2.status) === 'timeout', rep2 && rep2.status)
  ok('  说法要分得开:这条是【空闲】超时', /空闲超时/.test(String(rep2 && rep2.note)), rep2 && rep2.note)

  // ★滑动续期:一直在操作就不该被腰斩(真机跑到第 105 步被固定时间盒收掉,还得重开重登录)
  const { ba: ba2 } = makeCtx({ settings: { browserAgent: { minutes: 1 } } })
  const r2 = await ba2.agentOpen({ url: 'http://localhost:5199/', purpose: 'p' })
  const s2 = ba2.__sessions.get(r2.sessionId)
  const exp0 = s2.expiresAt
  s2.expiresAt = Date.now() + 5000               // 假装只剩 5 秒
  await ba2.agentAct({ sessionId: r2.sessionId, action: 'click', selector: '#x' })
  ok('★★每来一次操作就续期(时间盒防的是"开了忘关",不是"正在干活")',
    ba2.__sessions.get(r2.sessionId).expiresAt > Date.now() + 50000, { was: 5000, now: ba2.__sessions.get(r2.sessionId).expiresAt - Date.now() })
  ok('  但绝对上限不许被续期抹掉(跑飞了照样有个头)',
    ba2.__sessions.get(r2.sessionId).hardExpiresAt <= exp0 - 60000 + 60 * 60000 + 1000, s2.hardExpiresAt - exp0)
  const s3 = ba2.__sessions.get(r2.sessionId)
  s3.hardExpiresAt = Date.now() - 1
  const act3 = await ba2.agentAct({ sessionId: r2.sessionId, action: 'click', selector: '#x' })
  ok('★到绝对上限照样收(续期不是无限续)', !!act3.error, act3)
  ok('  这条说法是【总时长】,与空闲超时分得开',
    /总时长/.test(String((ba2.__sessions.get(r2.sessionId).result || {}).note)), (ba2.__sessions.get(r2.sessionId).result || {}).note)
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
