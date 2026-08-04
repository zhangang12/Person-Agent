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
  const calls = { newTab: [], closeTab: [], activateTab: [], exec: [], shots: 0, createBrowser: 0 }
  // 假标签页:页面状态(url / innerText / 选择器命中数 / console / net)全可编程
  function mkTab(id, url) {
    const page = { url, text: '', selCount: 0 }
    const wc = {
      isDestroyed: () => false,
      getURL: () => page.url,
      getTitle: () => '标题',
      executeJavaScript: async (code) => {
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
    createBrowser: () => { calls.createBrowser++ },
    newTab: (url) => {
      const t = mkTab(++S.browser.seq, url)
      S.browser.tabs.push(t); S.browser.activeId = t.id
      calls.newTab.push(url)
      return t
    },
    closeTab: (id) => { calls.closeTab.push(id); const i = S.browser.tabs.findIndex((t) => t.id === id); if (i >= 0) S.browser.tabs.splice(i, 1) },
    activateTab: (id) => { calls.activateTab.push(id); S.browser.activeId = id },
    brScreenshot: async () => { calls.shots++; return '/tmp/shot-' + calls.shots + '.png' },
    execStep: async (wc, ev) => {
      calls.exec.push(ev)
      if (over.execFail) return { ok: false, err: '假失败' }
      if (ev.act === 'navigate') { const t = S.browser.tabs.find((x) => x.view.webContents === wc); if (t) t.page.url = ev.url }
      return { ok: true }
    },
    waitNetIdle: async () => {},
    pageRead: async (tab) => ({ ok: true, url: tab.page.url, title: '标题', elements: 'button 「提交」  → #submit', text: tab.page.text }),
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

console.log('用例8:会话生命周期 —— 超时/并发/重复收/取证')
{
  const { ba, S, calls } = makeCtx()
  // 并发上限:每个会话占一个可见标签页,不能无限开
  const rs = []
  for (let i = 0; i < 4; i++) rs.push(await ba.agentOpen({ url: 'http://localhost:5199/' + i, purpose: 'p' + i }))
  ok('并发上限 3(第 4 个被拒)', rs.slice(0, 3).every((r) => r.ok) && !!rs[3].error, rs[3])
  // 截图:必须切到本会话的标签页再截,否则截的是用户当下在看的页面
  S.browser.activeId = rs[0] && 1 ? S.browser.tabs[2].id : null
  const shot = await ba.agentShot({ sessionId: rs[0].sessionId })
  ok('★截图前切到本会话标签页(不然截的是别人的页面)', !!shot.ok && calls.activateTab[calls.activateTab.length - 1] === S.browser.tabs.find((t) => t.page.url === 'http://localhost:5199/0').id, calls.activateTab)
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
  ok('超时后操作被拒', !!act.error)
  ok('  超时会话自动收成 FAIL 报告(不是留着当僵尸)', s.closed === true && s.result.verdict === 'FAIL', s.result && s.result.verdict)
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
