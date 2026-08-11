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
      getURL: () => page.url,
      getTitle: () => '标题',
      executeJavaScript: async (code) => {
        // agentEval / agentHtml 的返回形状(先判,它们的代码里也含 innerText/querySelectorAll)
        if (/__v=/.test(code)) return page.evalOut !== undefined ? page.evalOut : { v: '"ok"', n: 4, t: 'string' }
        if (/outerHTML/.test(code)) return page.htmlOut !== undefined ? page.htmlOut : { h: '<div class="el-dialog">x</div>', n: 30, tag: 'div', cls: 'el-dialog' }
        if (/innerText/.test(code)) return page.text
        if (/querySelectorAll/.test(code)) return page.selCount
        return ''
      },
    }
    return { id, view: { webContents: wc }, console: [], net: [], page }
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
    brShotTab: async (tab) => { calls.shots++; calls.shotTabs.push(tab && tab.id); return '/tmp/shot-' + calls.shots + '.png' },
    execStep: async (wc, ev) => {
      calls.exec.push(ev)
      if (over.execFail) return { ok: false, err: over.execErr || '假失败' }
      if (ev.act === 'navigate') { const t = S.browser.tabs.find((x) => x.view.webContents === wc); if (t) t.page.url = ev.url }
      return { ok: true }
    },
    waitNetIdle: async () => {},
    visionInfo: async () => (over.vision || { ok: false, why: '本机没有能读图的模型' }),
    pageRead: async (tab) => (over.emptyPage
      ? { ok: true, url: tab.page.url, title: '', elements: '', text: '' }
      : { ok: true, url: tab.page.url, title: '标题', elements: 'button 「提交」  → #submit', text: tab.page.text }),
  }
  return { ba: initBrowserAgent(ctx), S, calls, ctx }
}
const tabOf = (S) => S.browser.tabs[S.browser.tabs.length - 1]

console.log('用例1:围栏 —— 默认只放行本机,其他站点要用户显式加白')
{
  const { ba } = makeCtx()
  ok('本机 http 放行', ba.policyCheck('http://localhost:5199/x').ok)
  ok('127.0.0.1 放行', ba.policyCheck('http://127.0.0.1:8080/').ok)
  const r = ba.policyCheck('https://uat.example.com/pay')
  ok('外部站点默认拒', !r.ok)
  // 拒绝必须给出【怎么开通】,不能只说不行 —— 否则用户和 Agent 都卡在这不知道下一步
  ok('  拒绝信息带开通指引(设置路径 + 具体 origin)', /设置/.test(r.err) && /https:\/\/uat\.example\.com/.test(r.err), r.err)
  ok('非 http/https 拒(file/data 等一律不碰)', !ba.policyCheck('file:///etc/passwd').ok)
  ok('URL 解析不了也拒(不是放行)', !ba.policyCheck('不是个网址').ok)

  const { ba: ba2 } = makeCtx({ settings: { browserAgent: { origins: ['https://uat.example.com'] } } })
  ok('加白后同 origin 放行', ba2.policyCheck('https://uat.example.com/pay').ok)
  ok('  加白只对该 origin 生效,不外溢到同名前缀域', !ba2.policyCheck('https://uat.example.com.evil.cn/').ok)
  ok('  加白不外溢到 http(协议不同 origin 不同)', !ba2.policyCheck('http://uat.example.com/').ok)

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
  ok('越围栏的 url 在 open 阶段就拒(不会先开标签页再说)', !!(await ba.agentOpen({ url: 'https://evil.example.com/', purpose: 'x' })).error)
}

console.log('用例4:★围栏按【当前页】现查 —— 页面自己跳走了也要拦住')
{
  const { ba, S } = makeCtx()
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

console.log('用例5:navigate 按【目标 URL】先判后跳')
{
  const { ba, calls } = makeCtx()
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
  const { ba, S } = makeCtx()
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
