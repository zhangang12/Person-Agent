// 单会话卡片(ui/card.html)主脚本的无头自测:提取 <script> 在 vm 里配 DOM 桩真跑。
// 为什么值得有:主脚本没有模块边界,雷全在运行时 —— 这个桩上线当天就抓到两个白屏级故障:
//   ① setBusy(false) 立即执行引用了 150 行后才声明的 runningTools(TDZ,整卡白屏)
//   ② esc 唯一定义在探活抽屉 IIFE 里,主脚本所有 esc() 调用都是 TypeError → 工具日志/模型菜单渲染成空白框
// 用法: npm run card:ui:test
import { createRequire } from 'module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const fs = require('fs'), path = require('path')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(extra).slice(0, 200) : '')) } }

// ── 迷你 DOM 桩 ─────────────────────────────────────────────────────────────
function fakeEl(tag) {
  const store = {
    tagName: String(tag || 'div').toUpperCase(), children: [], innerHTML: '', textContent: '', value: '',
    hidden: false, open: false, disabled: false, className: '', title: '', dataset: {}, style: { setProperty: () => {} },
    parentNode: null, selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  }
  store.classList = {
    _s: new Set(),
    add: (...c) => c.forEach((x) => store.classList._s.add(x)),
    remove: (...c) => c.forEach((x) => store.classList._s.delete(x)),
    toggle: (c, on) => { (on === undefined ? !store.classList._s.has(c) : on) ? store.classList._s.add(c) : store.classList._s.delete(c) },
    contains: (c) => store.classList._s.has(c),
  }
  const el = new Proxy(store, {
    get: (t, k) => {
      if (k in t) return t[k]
      if (k === 'appendChild' || k === 'append') return (...cs) => { cs.forEach((c) => { t.children.push(c); if (c && typeof c === 'object') try { c.parentNode = el } catch {} }); return cs[0] }
      if (k === 'insertBefore') return (c) => { t.children.push(c); if (c && typeof c === 'object') try { c.parentNode = el } catch {} return c }
      if (k === 'remove') return () => { t.parentNode = null }   // 对齐真 DOM:remove 后按 parentNode 判"还挂在树上"即为否
      if (k === 'removeChild') return () => {}
      if (k === 'querySelector') return (sel) => { t._q = t._q || new Map(); if (!t._q.has(sel)) t._q.set(sel, fakeEl('div')); return t._q.get(sel) }   // 真浏览器能查到 innerHTML 写入的节点,桩按 selector 惰性造一个稳定 fake
      if (k === 'closest') return () => null
      if (k === 'querySelectorAll') return () => []
      if (k === 'addEventListener') return (ev, fn) => { t._ls = t._ls || {}; (t._ls[ev] = t._ls[ev] || []).push(fn) }   // 捕获监听器,测试可以 _fire 触发
      if (k === '_fire') return (ev, e) => { for (const fn of ((t._ls || {})[ev] || [])) fn(e) }
      if (k === 'setSelectionRange' || k === 'focus' || k === 'blur' || k === 'scrollIntoView' || k === 'setAttribute') return () => {}
      if (k === 'getBoundingClientRect') return () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
      if (k === 'contains') return () => false
      return undefined
    },
    set: (t, k, v) => { if (k === 'innerHTML') t.children.length = 0; t[k] = v; return true },   // 对齐真 DOM:innerHTML 赋值会替换掉全部子节点(不解析字符串造新节点,但旧节点必须消失)
  })
  return el
}

const byId = new Map()
const created = []   // createElement 顺序记录,断言渲染产物用
const documentStub = {
  getElementById: (id) => { if (!byId.has(id)) byId.set(id, fakeEl('div')) ; return byId.get(id) },
  createElement: (t) => { const e = fakeEl(t); created.push({ tag: String(t), el: e }); return e },
  addEventListener: () => {}, removeEventListener: () => {},
  querySelector: () => fakeEl('div'), querySelectorAll: () => [],
  documentElement: fakeEl('html'), body: fakeEl('body'), title: '',
}
const cbs = {}
const qReplies = [], qRejects = []   // 提问卡应答记录(questionReply/questionReject 桩)
const bocom = new Proxy({}, {
  get: (t, k) => {
    const key = String(k)
    if (/^on[A-Z]/.test(key)) return (f) => { cbs[key] = f }
    if (key === 'getTheme') return () => 'light'
    if (key === 'getSettings') return () => ({})
    if (key === 'getDropPath') return () => ''
    if (key === 'cardInit') return async () => ({ sessionId: 's1', project: 'demo', dir: 'C:/demo', model: null, reattached: false })
    if (key === 'cardSend') return async () => { await new Promise((r) => setTimeout(r, 60)); return '好的,已完成。' }   // 留 60ms 流式窗口:测试在 turn 进行中喂 onStream 事件
    if (key === 'readFileText') return async (p) => ({ ok: true, text: '# 分析手册\n这是 ' + p + ' 的内容' })   // 成果抽屉读文件桩
    if (key === 'questionReply') return async (id, answers) => { qReplies.push([id, answers]); return { ok: true } }
    if (key === 'questionReject') return async (id) => { qRejects.push(id); return { ok: true } }
    if (key === 'listModels') return async () => []
    return async () => null
  },
})
const windowStub = new Proxy({ BocomHermes: bocom, Rich: { renderMarkdown: (s) => String(s == null ? '' : s), wireActions: () => {} }, innerWidth: 800, innerHeight: 600 }, {
  get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true },
})

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'ui', 'card.html'), 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
const main = scripts[scripts.length - 1]

let exported = null, escGlobalHits = 0
// Map Backed 的 localStorage 桩:草稿持久化用例要真存取(getItem 对缺省键仍回 null,行为与原空桩一致)
function lsStore(seed) {
  const m = new Map(seed || [])
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(String(k), String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size }, _m: m }
}
const mainLs = lsStore()
const base = {
  console, setTimeout, setInterval, clearTimeout, clearInterval, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean,
  Map, Set, URLSearchParams, RegExp, Error, Symbol, Proxy, Reflect,
  requestAnimationFrame: (f) => { try { f() } catch {} },
  document: documentStub, window: windowStub, BocomHermes: bocom,
  location: { search: '' }, localStorage: mainLs,
  navigator: { clipboard: { writeText: async () => {} } },
  __export: (o) => { exported = o },
}
const sandbox = new Proxy(base, {
  has: () => true,
  get: (t, k) => {
    if (k in t) return t[k]
    if (k === 'esc') escGlobalHits++   // 词法 esc 缺失才会查到全局 —— 命中即复发
    return undefined
  },
})

console.log('用例1:主脚本立即执行路径(TDZ / 未定义全局 一票否决)')
const tail = '\n;__export({ submit, maybeDrain, pendingInjects, toolEls, sl, turnFn: turn, _setReady: (v) => { cardReady = v }, _setBusy: setBusy, _busy: () => busy, ci: document.getElementById("ci"), _ctx: () => ctxUsedChars, _setCtx: (n) => { ctxUsedChars = n; paintCtxChip() }, ctxChip: document.getElementById("ctxchip"), _saSnaps: () => saSnaps, _turnN: () => turnN })'
let bootErr = null
try { vm.runInNewContext(main + tail, sandbox, { timeout: 8000 }) } catch (e) { bootErr = e }
ok('立即执行不抛(曾抓到 runningTools TDZ 白屏)', !bootErr, bootErr && bootErr.message)
ok('导出内部句柄成功', !!exported)
ok('onStream 已注册', typeof cbs.onStream === 'function')
if (bootErr || !exported || !cbs.onStream) { console.log('\n❌ 启动即失败,后续跳过'); process.exit(1) }
await new Promise((r) => setTimeout(r, 30))   // 让 boot IIFE 的 await 链走完

console.log('用例2:工具事件渲染(曾抓到 esc 未定义 → 工具块空白框)')
const toolsBefore = created.length
let evErr = null
try { cbs.onStream({ kind: 'tool', text: 'read', partID: 'p1', status: 'running', input: { filePath: 'a.js' }, title: 'a.js' }) } catch (e) { evErr = e }
ok('running 事件不抛', !evErr, evErr && evErr.message)
const tb = exported.toolEls.get('p1')
ok('工具块已建且 innerHTML 渲出内容(非空白框)', tb && /read/.test(tb.innerHTML) && /运行中/.test(tb.innerHTML), tb && tb.innerHTML.slice(0, 80))
ok('esc 全程走词法定义,没查过全局(0 次)', escGlobalHits === 0, escGlobalHits)
ok('默认展开:工具块默认展开入参/结果(用户要看工具在干什么)', tb && tb.open === true, tb && tb.open)
let verboseFireErr = null
try { byId.get('bverbose')._fire('click') } catch (e) { verboseFireErr = e }   // 用户可切回紧凑:只对之后新渲的工具块生效(所见即所得路径 querySelectorAll 被桩置空)
try { cbs.onStream({ kind: 'tool', text: 'read', partID: 'p1b', status: 'running', input: { filePath: 'b.js' }, title: 'b.js' }) } catch (e) { verboseFireErr = e }
const tb2 = exported.toolEls.get('p1b')
ok('切紧凑后新工具块折叠为一行摘要', !verboseFireErr && tb2 && tb2.open === false, (verboseFireErr && verboseFireErr.message) || (tb2 && tb2.open))
evErr = null   // 上面是本用例自己的探针,别污染后续用例共用的 evErr
try { cbs.onStream({ kind: 'tool', text: 'read', partID: 'p1', status: 'completed', input: { filePath: 'a.js' }, title: 'a.js', output: 'x'.repeat(1500) }) } catch (e) { evErr = e }
ok('completed 摘要行带输出量(⎿ N 字)', tb && /⎿ 1\.5k 字/.test(tb.innerHTML), tb && tb.innerHTML.slice(0, 200))
ok('completed 后从状态行登记表注销', ![...(exported.sl && [] || [])].length && /完成/.test(tb.innerHTML))

console.log('用例3:todowrite → 勾选清单(不是 JSON)')
try { cbs.onStream({ kind: 'tool', text: 'todowrite', partID: 'p2', status: 'completed', input: { todos: [ { content: '读代码', status: 'completed' }, { content: '写修复', status: 'in_progress' }, { content: '跑测试', status: 'pending' } ] } }) } catch (e) { evErr = e }
const td = exported.toolEls.get('p2')
ok('todo 事件不抛', !evErr, evErr && evErr.message)
ok('渲染成勾选清单(含 todoline)', td && /todoline/.test(td.innerHTML), td && td.innerHTML.slice(0, 120))
ok('三种状态记号都在(☒/◐/☐)', td && td.innerHTML.includes('☒') && td.innerHTML.includes('◐') && td.innerHTML.includes('☐'))
ok('标题行带进度(任务清单 1/3)', td && /任务清单/.test(td.innerHTML) && /1\/3/.test(td.innerHTML), td && td.innerHTML.slice(0, 120))
ok('一等公民清单卡(todocard,不是可折叠工具行)', td && td.className === 'todocard' && td.hidden === false, td && td.className)

console.log('用例4:reasoning / text / 子agent事件不抛')
let e4 = null
try {
  cbs.onStream({ kind: 'reasoning', text: '想一想', partID: 'r1' })
  cbs.onStream({ kind: 'text', text: '回答片段', partID: 't1' })
  cbs.onStream({ kind: 'tool', text: 'grep', partID: 'p3', status: 'running', sub: true, agentId: 'a1', agentName: '探索者', input: { pattern: 'x' } })
  cbs.onStream({ kind: 'reasoning', text: '子想', partID: 'r2', sub: true, agentId: 'a1' })
  cbs.onStream({ kind: 'text', text: '子产出', partID: 't2', sub: true, agentId: 'a1' })
} catch (e) { e4 = e }
ok('五连事件全不抛', !e4, e4 && e4.message)

console.log('用例5:状态行(Claude Code 的 ✻ 行)')
exported._setBusy(true)
try { cbs.onStream({ kind: 'tool', text: 'bash', partID: 'p5', status: 'running', title: 'npm test' }) } catch {}
const sl = exported.sl
ok('忙 + 工具运行中 → 状态行显示工具名', sl && /bash/.test(sl.innerHTML), sl && sl.innerHTML.slice(0, 120))
ok('状态行带 Esc 提示', sl && /Esc 中断/.test(sl.innerHTML))
exported._setBusy(false)
ok('收尾短显 ✓ 耗时', sl && /✓ 完成 · \d+s/.test(sl.innerHTML), sl && sl.innerHTML)

console.log('用例6:忙时消息排队(Claude Code queueing —— 以前 busy 时 Enter 把字直接吞掉)')
exported._setReady(true); exported._setBusy(true)
exported.ci.value = '排队的问题'
const qBefore = exported.pendingInjects.length
exported.submit()
ok('忙时 submit → 入队而不是被吞', exported.pendingInjects.length === qBefore + 1, exported.pendingInjects.length)
const qi = exported.pendingInjects[exported.pendingInjects.length - 1]
ok('队列项带原文', qi && /排队的问题/.test(qi.text))
ok('气泡立即上屏且标了 queued', qi && qi.el && qi.el.classList.contains('queued'))
ok('输入框已清空(字没丢,进队了)', exported.ci.value === '')
exported._setBusy(false)
exported.maybeDrain()
await new Promise((r) => setTimeout(r, 30))
ok('本轮结束 drain:队列清空、气泡转正', exported.pendingInjects.length === qBefore && !qi.el.classList.contains('queued'))

console.log('用例7:思考链不被结果压缩 —— <think> 混在文本流里也分流进思考块,收尾不覆盖')
{
  // 模拟这个网关的真实形态:思考以 <think> 混在 text 流里(不走 reasoning part);cardSend 桩留 60ms 流式窗口
  exported._setReady(true)
  await new Promise((r) => setTimeout(r, 90))   // 让用例6 排队 drain 的那轮先收尾:turn 的流式态是全局的,重叠会互相踩
  const feedEl = byId.get('feed')
  const base = feedEl.children.length           // 只数本用例之后新增的块,不受前面用例残留干扰
  const reasonsIn = () => feedEl.children.slice(base).filter((c) => c && c.className === 'reason')
  const turnP = exported.turnFn('触发一轮')
  await new Promise((r) => setTimeout(r, 5))
  cbs.onStream({ kind: 'text', text: '<think>我先想想这个问题', partID: 'tx1' })   // 流式中途:未闭合
  await new Promise((r) => setTimeout(r, 30))
  const mid = reasonsIn()
  ok('流式中途未闭合的 <think> 已进思考块(不挤在答案气泡)', mid.length === 1 && /我先想想这个问题/.test(mid[0].querySelector('.body').textContent), mid.length)
  cbs.onStream({ kind: 'text', text: '<think>我先想想这个问题</think>答案第一段', partID: 'tx1' })
  await new Promise((r) => setTimeout(r, 30))
  await turnP   // cardSend 桩返回 '好的,已完成。'(最终正文) → 收尾替换答案气泡
  const after = reasonsIn()
  ok('收尾后思考块仍在对话流里(不被最终正文覆盖掉)', after.length === 1, after.length)
  ok('思考块内容完整保留', after.length === 1 && /我先想想这个问题/.test(after[0].querySelector('.body').textContent))
  ok('思考块答完保持展开(不自动折叠)', after.length === 1 && after[0].open === true)
  // 再跑一轮:新一轮有自己的思考块,上一轮的不被动
  const turn2 = exported.turnFn('再来一轮')
  await new Promise((r) => setTimeout(r, 5))
  cbs.onStream({ kind: 'reasoning', text: '第二轮走标准 reasoning part', partID: 'rz2' })
  await new Promise((r) => setTimeout(r, 30))
  await turn2
  const two = reasonsIn()
  ok('历史每轮各有各的思考块(第一轮的仍在)', two.length === 2, two.length)
  ok('两路来源都接得住(① reasoning part ② 文本内联 <think>)', two.length === 2 && /第二轮走标准/.test(two[1].querySelector('.body').textContent))
}

console.log('用例8:成果预览抽屉 —— write/edit 落盘文件进清单(去重),点开读文件,最终结论随轮更新')
{
  await new Promise((r) => setTimeout(r, 90))   // 等用例7 的第二轮收尾:turn 的流式态是全局的,重叠会互相踩
  const badge = byId.get('bartBadge'), filesEl = byId.get('ad-files')
  // write 工具事件(绝对路径) → 清单 +1,徽标亮出计数
  cbs.onStream({ kind: 'tool', text: 'write', partID: 'pw1', status: 'completed', input: { filePath: 'C:/demo/docs/a.md' } })
  ok('write 事件 → 徽标显示 1', badge.hidden === false && badge.textContent === '1', badge.textContent)
  ok('产出文件清单渲出 1 条', filesEl.children.length === 1, filesEl.children.length)
  // 同一路径换个 partID 再写一次 → 去重,不重复上清单
  cbs.onStream({ kind: 'tool', text: 'write', partID: 'pw2', status: 'completed', input: { filePath: 'C:/demo/docs/a.md' } })
  ok('同路径去重(徽标仍 1)', badge.textContent === '1', badge.textContent)
  // 下划线变体 + JSON 字符串入参(有的 serve 入参给的是字符串) → 也要接住
  cbs.onStream({ kind: 'tool', text: 'write_file', partID: 'pw3', status: 'completed', input: '{"filePath":"C:/demo/docs/b.md"}' })
  ok('write_file + JSON 字符串入参 → 清单 +1(徽标 2)', badge.textContent === '2', badge.textContent)
  // edit + 相对路径 → 按本卡目录(cardInit 桩 dir=C:/demo)拼绝对后也收集
  cbs.onStream({ kind: 'tool', text: 'edit', partID: 'pw4', status: 'completed', input: { filePath: 'README.md' } })
  ok('edit 相对路径也收集(徽标 3)', badge.textContent === '3', badge.textContent)
  // 点第一条 → readFileText 读回,markdown 渲染进下半区;内容区标题是砍了目录前缀的相对路径
  filesEl.children[0]._fire('click')
  await new Promise((r) => setTimeout(r, 30))
  const view = byId.get('ad-viewwrap')
  ok('点文件 → 内容渲染进下半区', /分析手册/.test(view.innerHTML), view.innerHTML.slice(0, 80))
  ok('内容区标题是相对路径(docs/a.md)', byId.get('ad-viewtitle').textContent === 'docs/a.md', byId.get('ad-viewtitle').textContent)
  // 前面用例已跑过多轮 → 最终结论区是最近一轮正文,不是占位提示
  ok('最终结论区=最近一轮正文(非占位)', /好的,已完成。/.test(byId.get('ad-final').innerHTML), byId.get('ad-final').innerHTML.slice(0, 60))
  // 抽屉开合:点「成果」滑出,再点收起。桩不解析 HTML 的 hidden 属性(假元素起手 hidden=false),
  // 先对齐真实初始态(artdraw 标签带 hidden)再点,否则第一次点击走反方向
  const draw = byId.get('artdraw')
  draw.hidden = true
  byId.get('bart')._fire('click')
  ok('点「成果」抽屉滑出', draw.hidden === false)
  byId.get('bart')._fire('click')
  ok('再点收起', draw.hidden === true)
}

console.log('用例9:中文输入法组合态 —— 选字的 Enter 不发送(半截拼音不上屏)')
{
  await new Promise((r) => setTimeout(r, 90))   // 等前面用例的 turn 收尾
  exported._setReady(true); exported._setBusy(true)   // 忙态下发送=入队,队列长度即"是否发送"的探针
  const ci = exported.ci
  const qLen = () => exported.pendingInjects.length
  ci.value = 'nihao'   // 打了一半的拼音
  const base = qLen()
  ci._fire('keydown', { key: 'Enter', isComposing: true, keyCode: 229, shiftKey: false, preventDefault: () => {} })
  ok('组合态 Enter 不触发发送(队列不变)', qLen() === base, qLen())
  ok('输入框内容原样保留', ci.value === 'nihao', ci.value)
  ci.value = '你好'
  ci._fire('keydown', { key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false, preventDefault: () => {} })
  ok('上屏后的 Enter 正常发送(入队)', qLen() === base + 1, qLen())
  // 清掉这条排队消息,别影响后续
  const qi = exported.pendingInjects.pop(); if (qi && qi.el && qi.el.remove) qi.el.remove()
  exported._setBusy(false)
}

console.log('用例10:上下文用量 chip —— 记账增长/阈值变色/低于 5% 隐藏')
{
  const chip = exported.ctxChip
  exported._setCtx(0)
  ok('用量为 0 → chip 隐藏', chip.hidden === true)
  exported._setCtx(Math.round(128000 * 1.6 * 0.5))   // ≈50%
  ok('50% → 显示百分比', chip.hidden === false && /上下文 ~5\d%/.test(chip.textContent), chip.textContent)
  ok('50% 无警示色', !chip.classList.contains('ctxwarn') && !chip.classList.contains('ctxdanger'))
  exported._setCtx(Math.round(128000 * 1.6 * 0.75))
  ok('75% → 警示色', chip.classList.contains('ctxwarn'))
  exported._setCtx(Math.round(128000 * 1.6 * 0.95))
  ok('95% → 红色', chip.classList.contains('ctxdanger') && !chip.classList.contains('ctxwarn'))
  const before = exported._ctx()
  cbs.onStream({ kind: 'tool', text: 'read', partID: 'pctx1', status: 'completed', input: { filePath: 'x' }, output: 'y'.repeat(500) })
  ok('父会话工具完成 → 入账(+' + (exported._ctx() - before) + ' 字)', exported._ctx() > before)
  const again = exported._ctx()
  cbs.onStream({ kind: 'tool', text: 'read', partID: 'pctx1', status: 'completed', input: { filePath: 'x' }, output: 'y'.repeat(500) })
  ok('同 partID 只记一次', exported._ctx() === again)
}

console.log('用例11:rich.js —— http 链接渲染成可点外链,文件:行不受影响')
{
  const richSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'ui', 'rich.js'), 'utf8')
  const w = {}
  new Function('window', 'navigator', 'document', richSrc)(w, { clipboard: {} }, { createElement: () => ({ style: {} }) })
  const html = w.Rich.renderMarkdown('详见 https://wiki.bank.com/page?id=3，以及 src/mail.js:42 的实现')
  ok('URL 渲染成 extlink(不含结尾中文逗号)', /<a class="extlink" data-url="https:\/\/wiki\.bank\.com\/page\?id=3"/.test(html), html.slice(0, 200))
  ok('文件:行 仍是 floc 链接', /<a class="floc" data-file="src\/mail\.js" data-line="42"/.test(html))
  ok('围栏代码块自带复制按钮(存量能力,防退化)', /data-act="copy"/.test(w.Rich.renderMarkdown('```js\nconst a=1\n```')))
}

console.log('用例12:内联 task 子Agent fan-out 实时可见(不等完成才显示)')
{
  // 这台 serve 的 task 不建独立子会话 → 主会话 task 工具事件。以前只在完成时渲染,跑的 1-2 分钟空白("不知道在干啥")
  const feedEl = byId.get('feed')
  const before = feedEl.children.length
  // 主 Agent 一条消息里并行派 3 个 task 子Agent,status=running
  cbs.onStream({ kind: 'tool', text: 'task', partID: 'tk1', status: 'running', input: { description: '深挖前端结构', prompt: '...' } })
  cbs.onStream({ kind: 'tool', text: 'task', partID: 'tk2', status: 'running', input: { description: '深挖后端接口数据流', prompt: '...' } })
  cbs.onStream({ kind: 'tool', text: 'task', partID: 'tk3', status: 'running', input: { description: '深挖构建部署配置', prompt: '...' } })
  ok('3 个 task 子Agent运行中就各建了一个可见块(不等完成)', exported.toolEls.has('tk1') && exported.toolEls.has('tk2') && exported.toolEls.has('tk3'))
  const b1 = exported.toolEls.get('tk1')
  ok('块标签是「子Agent」', /子Agent/.test(b1.innerHTML), b1.innerHTML.slice(0, 120))
  ok('块显示 task 的 description(深挖前端结构)', /深挖前端结构/.test(b1.innerHTML))
  ok('运行中状态可见', /运行中/.test(b1.innerHTML))
  // 完成 → 同块原地更新为完成 + 结论
  cbs.onStream({ kind: 'tool', text: 'task', partID: 'tk1', status: 'completed', input: { description: '深挖前端结构' }, output: 'Vue3 + Vite,portal 无单测' })
  ok('完成后同块原地更新(仍是同一块)', exported.toolEls.get('tk1') === b1 && /完成/.test(b1.innerHTML))
  ok('结论(子Agent发现)显示', /Vue3 \+ Vite/.test(b1.innerHTML))
}

console.log('用例12b:子Agent活动进侧边栏(不占主 feed),徽标计数,完成勾掉')
{
  // sub:true 路由事件 → 不再内联进 feed,进 #subdraw 的列表+窗格;主 feed 只有主 Agent 的 task 调用行
  const feedEl = byId.get('feed'), sdList = byId.get('sd-list'), sdPane = byId.get('sd-pane')
  const subDraw = byId.get('subdraw'), bsub = byId.get('bsub'), badge = byId.get('bsubBadge')
  subDraw.hidden = true; bsub.hidden = true; badge.hidden = true   // 桩不解析 HTML 的 hidden 属性,先对齐真实初始态(标签都带 hidden)
  const feedKids = feedEl.children.length
  // 主 Agent 派 task(带 taskChild=真子会话)→ 主 feed 留一行 task 调用
  cbs.onStream({ kind: 'tool', text: 'task', partID: 'tkA', status: 'running', input: { description: '深挖鉴权模块' }, taskChild: 'ses_subA', taskDesc: '深挖鉴权模块' })
  ok('task 调用行照常进主 feed(toolEls 有 tkA)', exported.toolEls.has('tkA'))
  // 子 Agent 的思考/工具事件(sub:true)→ 侧边栏建窗格,主 feed 不多一块
  cbs.onStream({ kind: 'reasoning', partID: 'rA1', text: '先读 auth 目录', sub: true, agentId: 'ses_subA', agentName: '深挖鉴权模块' })
  cbs.onStream({ kind: 'tool', text: 'read', partID: 'call_rdA:tool', status: 'running', input: { filePath: 'src/auth.js' }, sub: true, agentId: 'ses_subA', agentName: '深挖鉴权模块' })
  ok('主 feed 没有内联子 Agent 块(只多了 task 那一行)', feedEl.children.length === feedKids + 1, feedEl.children.length + ' vs ' + (feedKids + 1))
  ok('侧边栏列表 +1 且名字正确', sdList.children.length === 1 && sdList.children[0].querySelector('.si-name').textContent === '深挖鉴权模块', sdList.children.length)
  ok('子 Agent 按钮亮出,徽标=1(在跑)', bsub.hidden === false && badge.hidden === false && badge.textContent === '1', bsub.hidden + '/' + badge.hidden + '/' + badge.textContent)
  ok('抽屉自动滑出(本轮没被手动关过)', subDraw.hidden === false)
  ok('思考进了窗格 sa-reason(不是 feed)', /先读 auth 目录/.test(sdPane.children[0].querySelector('.sa-reason').textContent), sdPane.children[0].querySelector('.sa-reason').textContent.slice(0, 30))
  // task 完成(带 gid)→ 侧边栏项勾掉,徽标归零
  cbs.onStream({ kind: 'tool', text: 'task', partID: 'tkA', status: 'completed', input: { description: '深挖鉴权模块' }, output: 'JWT + 刷新令牌', taskChild: 'ses_subA' })
  ok('完成后徽标归零', badge.hidden === true)
  ok('侧边栏项不再"运行中"(meta 已定格)', !/运行中/.test(sdList.children[0].querySelector('.si-meta').textContent), sdList.children[0].querySelector('.si-meta').textContent)
}

console.log('用例12c:交互提问卡 —— 选项点选自动提交 / 跳过拒绝')
{
  const feedEl = byId.get('feed')
  // 单选单问题:点一个选项即自动提交(answers 按问题序的 labels 数组)
  cbs.onQuestion({ requestId: 'que_t1', questions: [{ header: '确认执行', question: '计划已出,开始执行?', options: [{ label: '批准执行', description: '按计划跑' }, { label: '调整范围', description: '只做一部分' }] }] })
  const box = feedEl.children[feedEl.children.length - 1]
  ok('提问卡挂进 feed(perm qbox)', box && /qbox/.test(box.className || ''), box && box.className)
  const qtEl = created.filter((c) => c.el.className === 'qt').map((c) => c.el).pop()
  ok('问题与头部渲出', qtEl && qtEl.querySelector('.qq').textContent === '计划已出,开始执行?' && qtEl.querySelector('.qh').textContent === '确认执行', qtEl && qtEl.querySelector('.qq').textContent)
  const opts = created.filter((c) => c.el.className === 'qopt').map((c) => c.el)
  ok('两个选项都渲出', opts.length === 2 && opts[0].querySelector('.ql').textContent === '批准执行' && opts[1].querySelector('.ql').textContent === '调整范围', opts.length)
  opts[1]._fire('click')   // 点「调整范围」→ 单选点够即自动提交
  await new Promise((r) => setTimeout(r, 30))
  ok('点选后自动提交(questionReply 带 answers)', qReplies.length === 1 && qReplies[0][0] === 'que_t1' && JSON.stringify(qReplies[0][1]) === '[["调整范围"]]', JSON.stringify(qReplies))
  ok('答完定格成一行留痕', /已回答:调整范围/.test((box.children[0] && box.children[0].textContent) || ''), box.children[0] && box.children[0].textContent)
  // 拒绝路径:再弹一张,点「跳过」→ questionReject
  cbs.onQuestion({ requestId: 'que_t2', questions: [{ question: '要继续吗', options: [{ label: '继续', description: '' }] }] })
  const box2 = feedEl.children[feedEl.children.length - 1]
  const skip = created.filter((c) => /qskip/.test(c.el.className || '')).map((c) => c.el).pop()
  skip._fire('click')
  await new Promise((r) => setTimeout(r, 30))
  ok('跳过 → questionReject', qRejects.length === 1 && qRejects[0] === 'que_t2', JSON.stringify(qRejects))
  ok('定格"已跳过"', /已跳过/.test((box2.children[0] && box2.children[0].textContent) || ''), box2.children[0] && box2.children[0].textContent)
}

console.log('用例12d:输入草稿持久化 —— 输入即存 / 发送即清 / 续接恢复')
{
  // 主上下文(boot 已完成,cardInit 桩 sessionId=s1)
  const lsM = mainLs._m
  exported.ci.value = '写了一半的话'
  exported.ci._fire('input')
  ok('输入即按会话存草稿(cardDraft:s1)', lsM.has('cardDraft:s1') && JSON.parse(lsM.get('cardDraft:s1')).v === '写了一半的话', lsM.get('cardDraft:s1'))
  await exported.turnFn('发出去')
  ok('发送即清草稿', !lsM.has('cardDraft:s1'), lsM.get('cardDraft:s1'))
  exported.ci.value = ''   // 别污染后续用例
  // 续接恢复:?sid=s1 启动 + 预置草稿 + reattached=true → 输入框应拿回草稿
  const byId4 = new Map(), created4 = [], cbs4 = {}
  const doc4 = {
    getElementById: (id) => {
      if (id === 'planBar' || id === 'memPop') { const hit = created4.find((c) => c.el.id === id && c.el.parentNode); return hit ? hit.el : null }
      if (!byId4.has(id)) byId4.set(id, fakeEl('div')); return byId4.get(id)
    },
    createElement: (t) => { const e = fakeEl(t); created4.push({ tag: String(t), el: e }); return e },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => fakeEl('div'), querySelectorAll: () => [],
    documentElement: fakeEl('html'), body: fakeEl('body'), title: '',
  }
  const bocom4 = new Proxy({}, {
    get: (t, k) => {
      const key = String(k)
      if (/^on[A-Z]/.test(key)) return (f) => { cbs4[key] = f }
      if (key === 'getTheme') return () => 'light'
      if (key === 'getSettings') return () => ({})
      if (key === 'getDropPath') return () => ''
      if (key === 'cardInit') return async () => ({ sessionId: 's1', project: 'demo', dir: 'C:/demo', model: null, reattached: true, messages: [] })
      if (key === 'listModels') return async () => []
      return async () => null
    },
  })
  const win4 = new Proxy({ BocomHermes: bocom4, Rich: { renderMarkdown: (s) => String(s == null ? '' : s), wireActions: () => {} }, innerWidth: 800, innerHeight: 600 }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true } })
  let exp4 = null
  const base4 = {
    console, setTimeout, setInterval, clearTimeout, clearInterval, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean,
    Map, Set, URLSearchParams, RegExp, Error, Symbol, Proxy, Reflect,
    requestAnimationFrame: (f) => { try { f() } catch {} },
    document: doc4, window: win4, BocomHermes: bocom4,
    location: { search: '?sid=s1&title=' + encodeURIComponent('续接对话') },
    localStorage: lsStore([['cardDraft:s1', JSON.stringify({ t: Date.now(), v: '没发出去的草稿' })]]),
    navigator: { clipboard: { writeText: async () => {} } },
    __export: (o) => { exp4 = o },
  }
  const sb4 = new Proxy(base4, { has: () => true, get: (t, k) => (k in t ? t[k] : undefined) })
  const tail4 = '\n;__export({ ci: document.getElementById("ci") })'
  let err4 = null
  try { vm.runInNewContext(main + tail4, sb4, { timeout: 8000 }) } catch (e) { err4 = e }
  ok('sid 续接启动不抛', !err4, err4 && err4.message)
  await new Promise((r) => setTimeout(r, 120))
  ok('续接后草稿恢复到输入框', exp4 && exp4.ci.value === '没发出去的草稿', exp4 && exp4.ci.value)
}

console.log('用例12e:活视图 —— 实时结构图(目标/todo/子Agent/产出),全幅切换')
{
  const lv = byId.get('liveview'), bl = byId.get('blive')
  // 喂数据:主 Agent todowrite + 子 Agent 活动 + 落盘文件
  cbs.onStream({ kind: 'tool', text: 'todowrite', partID: 'lv_td', status: 'completed', input: { todos: [{ content: '勘察边界', status: 'completed' }, { content: '并行深读', status: 'in_progress' }, { content: '综合产出', status: 'pending' }] } })
  cbs.onStream({ kind: 'tool', text: 'task', partID: 'lv_tk', status: 'running', input: { description: '深读支付模块' }, taskChild: 'ses_lvA', taskDesc: '深读支付模块' })
  cbs.onStream({ kind: 'reasoning', partID: 'lv_r1', text: '先看入口', sub: true, agentId: 'ses_lvA', agentName: '深读支付模块' })
  cbs.onStream({ kind: 'tool', text: 'write', partID: 'lv_w1', status: 'completed', input: { filePath: 'C:/demo/docs/pay.md' } })
  bl._fire('click')   // 开活视图
  const mw = byId.get('midwrap')   // midwrap 是 lvToggle 里才首次 getElementById 的,点击后才注册进桩
  ok('全幅切换(liveview 出,midwrap 隐)', lv.hidden === false && mw.hidden === true, lv.hidden + '/' + mw.hidden)
  const html = lv.innerHTML
  ok('目标与主 Agent 状态渲出', /主 Agent/.test(html) && /第 \d+ 轮/.test(html), html.slice(0, 160))
  ok('计划进度 1/3 + 进度条 33%', /1\/3/.test(html) && /width:33%/.test(html), html.match(/lv-n">[^<]*</))
  ok('todo 三种记号都在(☒/◐/☐)', html.includes('☒') && html.includes('◐') && html.includes('☐'))
  ok('子 Agent 节点在(运行中+名字+data-aid)', /lv-node run/.test(html) && /深读支付模块/.test(html) && /data-aid="ses_lvA"/.test(html))
  ok('产出文件行在(docs/pay.md)', /docs\/pay\.md/.test(html))
  bl._fire('click')   // 再点返回
  ok('再点返回(liveview 隐,midwrap 出)', lv.hidden === true && mw.hidden === false)
}

console.log('用例13:工作流卡(wf=1) —— 规划先行 / 自动批准 / todo 提醒 / 自动压缩续航')
{
  // 第二个独立上下文按 wf=1 启动。动态 id(planBar/memPop)对齐真 DOM:不存在返回 null,挂上可查,remove 后消失
  const byId2 = new Map(), created2 = [], cbs2 = {}, sends = [], permReplies = [], reinits = []
  let sendReply = '这是计划:1) 勘察 2) 并行深挖(等待批准)'
  const doc2 = {
    getElementById: (id) => {
      if (id === 'planBar' || id === 'memPop') { const hit = created2.find((c) => c.el.id === id && c.el.parentNode); return hit ? hit.el : null }
      if (!byId2.has(id)) byId2.set(id, fakeEl('div')); return byId2.get(id)
    },
    createElement: (t) => { const e = fakeEl(t); created2.push({ tag: String(t), el: e }); return e },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => fakeEl('div'), querySelectorAll: () => [],
    documentElement: fakeEl('html'), body: fakeEl('body'), title: '',
  }
  const bocom2 = new Proxy({}, {
    get: (t, k) => {
      const key = String(k)
      if (/^on[A-Z]/.test(key)) return (f) => { cbs2[key] = f }
      if (key === 'getTheme') return () => 'light'
      if (key === 'getSettings') return () => ({})
      if (key === 'getDropPath') return () => ''
      if (key === 'cardInit') return async () => ({ sessionId: 'w1', project: 'demo', dir: 'C:/demo', model: null, reattached: false })
      if (key === 'cardReinit') return async (opts) => { reinits.push(opts || {}); return { sessionId: 'w' + (reinits.length + 1), project: 'demo', dir: 'C:/demo', model: null } }
      if (key === 'cardSend') return async (text) => { sends.push(String(text == null ? '' : text)); await new Promise((r) => setTimeout(r, 20)); return sendReply }
      if (key === 'permissionReply') return (id, d) => { permReplies.push([id, d]) }
      if (key === 'listModels') return async () => []
      return async () => null
    },
  })
  const win2 = new Proxy({ BocomHermes: bocom2, Rich: { renderMarkdown: (s) => String(s == null ? '' : s), wireActions: () => {} }, innerWidth: 800, innerHeight: 600 }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true } })
  let exp2 = null
  const base2 = {
    console, setTimeout, setInterval, clearTimeout, clearInterval, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean,
    Map, Set, URLSearchParams, RegExp, Error, Symbol, Proxy, Reflect,
    requestAnimationFrame: (f) => { try { f() } catch {} },
    document: doc2, window: win2, BocomHermes: bocom2,
    location: { search: '?wf=1&title=' + encodeURIComponent('工作流 · 测') + '&msg=' + encodeURIComponent('总目标X') },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    __export: (o) => { exp2 = o },
  }
  const sb2 = new Proxy(base2, { has: () => true, get: (t, k) => (k in t ? t[k] : undefined) })
  const tail2 = '\n;__export({ pendingInjects, turnFn: turn, _planPending: () => planPending, _autoN: () => autoCompactN, _busy: () => busy, _setCtx: (n) => { ctxUsedChars = n }, _todoLast: () => wfTodoLastTurn, _turnN: () => turnN })'
  let err2 = null
  try { vm.runInNewContext(main + tail2, sb2, { timeout: 8000 }) } catch (e) { err2 = e }
  ok('wf=1 启动不抛', !err2, err2 && err2.message)
  await new Promise((r) => setTimeout(r, 140))   // 等 boot IIFE:cardInit + 首轮(规划轮)走完
  ok('首轮(规划轮)已自动发出总目标', sends.length === 1 && /总目标X/.test(sends[0]), sends.length + ':' + String(sends[0] || '').slice(0, 40))
  const planBar = () => created2.find((c) => c.el.id === 'planBar' && c.el.parentNode)
  ok('规划轮结束后挂出计划批准条', !!planBar())
  ok('批准前 planPending=true', exp2._planPending() === true)
  // 自动批准:wf 卡按钮可见,开启后权限请求短路放行(不再弹人工确认)
  const bauto = byId2.get('bauto')
  ok('自动批准按钮已显示(hidden=false)', bauto.hidden === false)
  bauto._fire('click')
  cbs2.onPermission({ requestId: 'r9', tool: 'write', detail: 'docs/a.md' })
  ok('开启后权限请求自动放行(replyPermission once)', permReplies.length === 1 && permReplies[0][0] === 'r9' && permReplies[0][1] === 'once', JSON.stringify(permReplies))
  // 点【开始执行】→ planPending=false,批准消息自动发出
  const goBtn = created2.filter((c) => c.tag === 'button').map((c) => c.el).find((e) => e.textContent === '开始执行')
  ok('计划条上有【开始执行】按钮', !!goBtn)
  sendReply = '开始执行:已完成第一步。'
  goBtn._fire('click')
  ok('点击后 planPending=false', exp2._planPending() === false)
  await new Promise((r) => setTimeout(r, 80))
  ok('批准消息已自动发出(计划已批准)', sends.length === 2 && /计划已批准/.test(sends[1]), sends.length)
  // todo 提醒兜底:todowrite 打点后连着 3 轮没更新 → 第 3 轮消息尾部附系统提醒
  cbs2.onStream({ kind: 'tool', text: 'todowrite', partID: 'td1', status: 'completed', input: { todos: [{ content: '步骤A', status: 'in_progress' }] } })
  ok('todowrite 事件打点(lastTurn=当前轮)', exp2._todoLast() === exp2._turnN(), exp2._todoLast() + '/' + exp2._turnN())
  await exp2.turnFn('推进一步')
  await exp2.turnFn('再推进一步')
  sendReply = '继续推进。'
  await exp2.turnFn('继续')
  const lastSendTxt = sends[sends.length - 1]
  ok('连着 3 轮未更新 todo → 消息尾部自动附系统提醒', /系统提醒:todo 清单已多轮未更新/.test(lastSendTxt), lastSendTxt.slice(-90))
  // 自动压缩续航:用量 ≥80% → 轮末自动压缩(摘要轮 → cardReinit 带接力摘要 → 自动继续执行)
  const feed2 = byId2.get('feed')
  feed2.querySelectorAll = (sel) => sel === '.msg.ai' ? feed2.children.filter((c) => String(c && c.className || '').includes('ai') && !String(c && c.className || '').includes('err')) : []
  exp2._setCtx(Math.round(128000 * 1.6 * 0.85))   // ≈85% 用量
  sendReply = '接力摘要:总目标X;todo:步骤A(in_progress);已确认结论…'
  await exp2.turnFn('随便一轮')
  await new Promise((r) => setTimeout(r, 220))    // 摘要轮 + reinit + 续跑轮
  ok('自动压缩已触发(autoCompactN=1)', exp2._autoN() === 1, exp2._autoN())
  ok('压缩走了 cardReinit 且带接力摘要(carryCtx)', reinits.length === 1 && /接力摘要/.test(String(reinits[0].carryCtx || '')), JSON.stringify(reinits).slice(0, 140))
  const cont = sends[sends.length - 1]
  ok('压缩后自动续跑(接力续执行消息已发出)', /接力摘要已随本消息注入/.test(cont), cont.slice(0, 60))
}

console.log('用例14:工作流卡首轮即实质执行 → 批准闸自动跳过(不让用户批一个已完成的计划)')
{
  // 复刻真实事故:弱模型没守"首轮只规划",第一轮就边干边交 —— todo 出现 completed 项,轮末绝不能再弹批准条
  const byId3 = new Map(), created3 = [], cbs3 = {}, sends3 = []
  const doc3 = {
    getElementById: (id) => {
      if (id === 'planBar' || id === 'memPop') { const hit = created3.find((c) => c.el.id === id && c.el.parentNode); return hit ? hit.el : null }
      if (!byId3.has(id)) byId3.set(id, fakeEl('div')); return byId3.get(id)
    },
    createElement: (t) => { const e = fakeEl(t); created3.push({ tag: String(t), el: e }); return e },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => fakeEl('div'), querySelectorAll: () => [],
    documentElement: fakeEl('html'), body: fakeEl('body'), title: '',
  }
  const bocom3 = new Proxy({}, {
    get: (t, k) => {
      const key = String(k)
      if (/^on[A-Z]/.test(key)) return (f) => { cbs3[key] = f }
      if (key === 'getTheme') return () => 'light'
      if (key === 'getSettings') return () => ({})
      if (key === 'getDropPath') return () => ''
      if (key === 'cardInit') return async () => ({ sessionId: 'w9', project: 'demo', dir: 'C:/demo', model: null, reattached: false })
      if (key === 'cardSend') return async (text) => { sends3.push(String(text == null ? '' : text)); await new Promise((r) => setTimeout(r, 40)); return '这是完整分析结论(首轮直接交付,不是计划)。' }
      if (key === 'listModels') return async () => []
      return async () => null
    },
  })
  const win3 = new Proxy({ BocomHermes: bocom3, Rich: { renderMarkdown: (s) => String(s == null ? '' : s), wireActions: () => {} }, innerWidth: 800, innerHeight: 600 }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true } })
  let exp3 = null
  const base3 = {
    console, setTimeout, setInterval, clearTimeout, clearInterval, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean,
    Map, Set, URLSearchParams, RegExp, Error, Symbol, Proxy, Reflect,
    requestAnimationFrame: (f) => { try { f() } catch {} },
    document: doc3, window: win3, BocomHermes: bocom3,
    location: { search: '?wf=1&title=' + encodeURIComponent('工作流 · 测') + '&msg=' + encodeURIComponent('总目标Y') },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    __export: (o) => { exp3 = o },
  }
  const sb3 = new Proxy(base3, { has: () => true, get: (t, k) => (k in t ? t[k] : undefined) })
  const tail3 = '\n;__export({ _planPending: () => planPending })'
  let err3 = null
  try { vm.runInNewContext(main + tail3, sb3, { timeout: 8000 }) } catch (e) { err3 = e }
  ok('wf=1 启动不抛(用例14)', !err3, err3 && err3.message)
  // 首轮进行中(cardSend 40ms 回包窗口内):todo 已标 completed = 模型在实打实执行,不是只出计划
  cbs3.onStream({ kind: 'tool', text: 'todowrite', partID: 'te1', status: 'completed', input: { todos: [{ content: '读 README', status: 'completed' }, { content: '出分析', status: 'in_progress' }] } })
  await new Promise((r) => setTimeout(r, 180))   // 等首轮(交付轮)走完 → 轮末 maybeShowPlanBar 应跳过
  ok('首轮发出总目标(用例14)', sends3.length === 1 && /总目标Y/.test(sends3[0]), sends3.length)
  ok('出现实质执行信号 → 不挂计划批准条', !created3.find((c) => c.el.id === 'planBar' && c.el.parentNode))
  ok('批准闸已永久撤掉(planPending=false)', exp3 && exp3._planPending() === false)
}

// ── 用例15-17 共用:wf=1 工作流卡沙盒(旋钮可配)—— 与用例13/14 同构,抽出只为少抄三遍 ──
function mkWfCtx(knobs, reply) {
  const byId = new Map(), created = [], cbs = {}, sends = []
  const doc = {
    getElementById: (id) => {
      if (id === 'planBar' || id === 'memPop' || id === 'wdBanner') { const hit = created.find((c) => c.el.id === id && c.el.parentNode); return hit ? hit.el : null }
      if (!byId.has(id)) byId.set(id, fakeEl('div')); return byId.get(id)
    },
    createElement: (t) => { const e = fakeEl(t); created.push({ tag: String(t), el: e }); return e },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => fakeEl('div'), querySelectorAll: () => [],
    documentElement: fakeEl('html'), body: fakeEl('body'), title: '',
  }
  const bocom = new Proxy({}, {
    get: (t, k) => {
      const key = String(k)
      if (/^on[A-Z]/.test(key)) return (f) => { cbs[key] = f }
      if (key === 'getTheme') return () => 'light'
      if (key === 'getSettings') return () => ({ knobs: knobs || {} })
      if (key === 'getDropPath') return () => ''
      if (key === 'cardInit') return async () => ({ sessionId: 'wfk', project: 'demo', dir: 'C:/demo', model: null, reattached: false })
      if (key === 'cardSend') return async (text) => { sends.push(String(text == null ? '' : text)); await new Promise((r) => setTimeout(r, 20)); return typeof reply === 'function' ? reply() : reply }
      if (key === 'listModels') return async () => []
      return async () => null
    },
  })
  const win = new Proxy({ BocomHermes: bocom, Rich: { renderMarkdown: (s) => String(s == null ? '' : s), wireActions: () => {} }, innerWidth: 800, innerHeight: 600 }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true } })
  let exp = null
  const base = {
    console, setTimeout, setInterval, clearTimeout, clearInterval, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean,
    Map, Set, URLSearchParams, RegExp, Error, Symbol, Proxy, Reflect,
    requestAnimationFrame: (f) => { try { f() } catch {} },
    document: doc, window: win, BocomHermes: bocom,
    location: { search: '?wf=1&title=' + encodeURIComponent('工作流 · 测') + '&msg=' + encodeURIComponent('总目标Z') },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    __export: (o) => { exp = o },
  }
  const sb = new Proxy(base, { has: () => true, get: (t, k) => (k in t ? t[k] : undefined) })
  const tail = '\n;__export({ pendingInjects, turnFn: turn, _planPending: () => planPending, _busy: () => busy, _wd: () => ({ warned: wdWarned, esc: wdEscLoops, hist: wdRounds.map((r) => r.turn) }), _turnN: () => turnN })'
  let bootErr = null
  try { vm.runInNewContext(main + tail, sb, { timeout: 8000 }) } catch (e) { bootErr = e }
  return { exp, cbs, sends, created, byId, bootErr }
}

console.log('用例15:批准闸超时自动开跑(knobs.approvalTimeoutMin>0)—— 倒计时文案 / 到期注入同款批准消息 / 计时器不二次注入')
{
  const c = mkWfCtx({ approvalTimeoutMin: 0.004 }, '这是计划:1) 勘察 2) 执行(等待批准)')   // 0.004min≈240ms
  ok('wf=1 启动不抛(用例15)', !c.bootErr, c.bootErr && c.bootErr.message)
  await new Promise((r) => setTimeout(r, 140))   // boot + 规划轮
  const bar = () => c.created.find((x) => x.el.id === 'planBar' && x.el.parentNode)
  ok('计划批准条挂出(用例15)', !!bar())
  const cd = c.created.map((x) => x.el).find((e) => e.className === 'planauto')
  ok('按钮旁显示倒计时(…后自动开跑)', cd && /后自动开跑/.test(cd.textContent), cd && cd.textContent)
  await new Promise((r) => setTimeout(r, 340))   // 等倒计时到期
  ok('到期自动注入与手动完全相同的批准消息', c.sends.length === 2 && /计划已批准,开始执行。按 todo 清单推进/.test(c.sends[1]), c.sends.length + ':' + String(c.sends[1] || '').slice(0, 40))
  const n2 = c.sends.length
  await new Promise((r) => setTimeout(r, 320))   // 再等一个多周期:计时器必须已清,不得二次注入
  ok('计时器已清理(批准只发生一次)', c.sends.length === n2, c.sends.length)
  ok('批准后计划条已撤', !bar())
}

console.log('用例16:批准闸倒计时「取消自动」—— 拆引信后到期不自动批准,手动批准照常')
{
  const c = mkWfCtx({ approvalTimeoutMin: 0.03 }, '这是计划(等待批准)')   // ≈1.8s,留出点击窗口
  ok('wf=1 启动不抛(用例16)', !c.bootErr, c.bootErr && c.bootErr.message)
  await new Promise((r) => setTimeout(r, 140))
  const cx = c.created.map((x) => x.el).find((e) => e.className === 'planautox')
  ok('按钮旁有「取消自动」小链', !!cx)
  cx._fire('click')
  await new Promise((r) => setTimeout(r, 2000))   // 超过原倒计时:不得自动批准
  ok('取消自动后到期不自动批准', !c.sends.some((s) => /计划已批准/.test(s)), JSON.stringify(c.sends.map((s) => s.slice(0, 20))))
  const go = c.created.map((x) => x.el).find((e) => e.textContent === '开始执行')
  ok('取消后手动【开始执行】仍在', !!go)
  go._fire('click')
  await new Promise((r) => setTimeout(r, 80))
  ok('手动批准照常开跑', c.sends.some((s) => /计划已批准,开始执行/.test(s)))
}

console.log('用例17:进展型看门狗 —— 连续 N 轮读同一批文件先注入提醒,提醒后再绕 M 轮升级横幅(不自动杀)')
{
  const c = mkWfCtx({}, '推进中')   // 默认旋钮:N=3 / 重合 0.7 / M=2
  ok('wf=1 启动不抛(用例17)', !c.bootErr, c.bootErr && c.bootErr.message)
  await new Promise((r) => setTimeout(r, 140))   // boot 规划轮(turn1,无读文件)
  const readTurn = async (tag) => {
    const p = c.exp.turnFn('第' + tag + '轮')
    await new Promise((r) => setTimeout(r, 5))
    c.cbs.onStream({ kind: 'tool', text: 'read', partID: 'rda' + tag, status: 'completed', input: { filePath: 'src/a.js' }, output: 'aa' })
    c.cbs.onStream({ kind: 'tool', text: 'read', partID: 'rdb' + tag, status: 'completed', input: { filePath: 'src/b.js' }, output: 'bb' })
    await p
  }
  await readTurn(2); await readTurn(3)
  ok('两轮同文件还不触发(不足 N=3)', c.exp._wd().warned === false)
  await readTurn(4)
  await new Promise((r) => setTimeout(r, 80))   // 提醒注入 → 提醒轮(turn5,无读文件)自动跑完
  ok('连续 3 轮同文件且无 todo 进展 → 注入绕圈提醒', c.sends.filter((s) => /系统提醒:检测到你可能在绕圈/.test(s)).length === 1, JSON.stringify(c.sends.map((s) => s.slice(0, 26))))
  ok('第一级只提醒,没挂横幅', !c.created.find((x) => x.el.id === 'wdBanner' && x.el.parentNode))
  await readTurn(6)   // turn5 是提醒应答轮(无读文件);turn6 又读同一批 → esc=1
  ok('提醒后再绕 1 轮,仍未到升级线(M=2)', !c.created.find((x) => x.el.id === 'wdBanner' && x.el.parentNode))
  await readTurn(7)   // esc=2 → 升级
  const banner = c.created.find((x) => x.el.id === 'wdBanner' && x.el.parentNode)
  ok('提醒后再绕 M=2 轮 → 挂醒目横幅(仍不自动杀)', !!banner)
  ok('横幅带【中止本轮】快捷按钮', banner && banner.el.children.some((ch) => /中止本轮/.test(ch.textContent || '')), banner && banner.el.children.map((ch) => ch.textContent).join('|'))
  const sendsBefore = c.sends.length
  ok('绕圈提醒全程只注入过一次(没有每轮唠叨)', c.sends.filter((s) => /系统提醒:检测到你可能在绕圈/.test(s)).length === 1 && sendsBefore >= 1)
  // 纠偏路径①:todo 勾选进展 → 看门狗复位,再绕同文件也重新从第一级算起
  const pt = c.exp.turnFn('勾选进展轮')
  await new Promise((r) => setTimeout(r, 5))
  c.cbs.onStream({ kind: 'tool', text: 'todowrite', partID: 'tdw1', status: 'completed', input: { todos: [{ content: '步骤A', status: 'completed' }] } })
  await pt
  ok('todo 勾选进展后看门狗复位', c.exp._wd().warned === false, JSON.stringify(c.exp._wd()))
}

console.log('用例18:子 Agent 跨轮回看 —— 轮末拍快照 / 下拉切历史轮 / 内存上限 20 轮')
{
  // 主上下文(用例1 的)接着跑:一轮里派个子 Agent → 下一轮开局它进快照
  const t1 = exported.turnFn('快照轮')
  await new Promise((r) => setTimeout(r, 5))
  cbs.onStream({ kind: 'tool', text: 'read', partID: 'snapR1:tool', status: 'completed', input: { filePath: 'src/x.js' }, sub: true, agentId: 'ses_snapA', agentName: '快照探索者' })
  await t1
  const t2 = exported.turnFn('触发快照')
  await t2
  const snaps = exported._saSnaps()
  ok('上一轮的子 Agent 活动已拍成快照', snaps.length >= 1 && snaps[snaps.length - 1].items.some((it) => it.name === '快照探索者'), JSON.stringify(snaps.map((s) => s.items.map((i) => i.name))))
  const snapIt = snaps[snaps.length - 1].items.find((it) => it.name === '快照探索者')
  ok('快照带工具计数与读文件数', snapIt && snapIt.count === 1 && snapIt.reads === 1, JSON.stringify(snapIt))
  const sel = byId.get('sdRound')
  ok('有历史轮后下拉亮出(含"第 N 轮")', sel.hidden === false && sel.children.some((o) => o.value === String(snaps[snaps.length - 1].round)))
  sel.value = String(snaps[snaps.length - 1].round)
  sel._fire('change')
  const sdList = byId.get('sd-list')
  const snapEl = sdList.children.find((el) => String(el.className || '').includes('snap') && /快照探索者/.test(el.innerHTML || ''))
  ok('切到历史轮 → 列表显示只读快照项', !!snapEl, sdList.children.map((el) => el.className))
  ok('历史轮窗格是快照概要入口', /活动概要（快照）/.test(byId.get('sd-pane').innerHTML), byId.get('sd-pane').innerHTML.slice(0, 80))
  snapEl._fire('click')
  ok('点快照项 → 窗格显示概要(计数/耗时/引导看本轮)', /工具调用 1 次/.test(byId.get('sd-pane').innerHTML) && /本轮/.test(byId.get('sd-pane').innerHTML), byId.get('sd-pane').innerHTML.slice(0, 120))
  sel.value = 'cur'; sel._fire('change')
  ok('切回本轮恢复正常', !sdList.children.some((el) => String(el.className || '').includes('snap')))
  // 内存上限:再刷 25 轮(每轮派一个子 Agent)→ 快照最多 20 轮,最老的被丢
  for (let i = 0; i < 25; i++) {
    const p = exported.turnFn('刷轮' + i)
    await new Promise((r) => setTimeout(r, 3))
    cbs.onStream({ kind: 'reasoning', partID: 'srz' + i, text: '想', sub: true, agentId: 'ses_cap' + i, agentName: '上限探针' + i })
    await p
  }
  const snaps2 = exported._saSnaps()
  ok('快照内存上限 20 轮(超出丢最老)', snaps2.length === 20, snaps2.length)
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)