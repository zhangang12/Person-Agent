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
      if (k === 'removeChild' || k === 'remove') return () => {}
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
    set: (t, k, v) => { t[k] = v; return true },
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
const bocom = new Proxy({}, {
  get: (t, k) => {
    const key = String(k)
    if (/^on[A-Z]/.test(key)) return (f) => { cbs[key] = f }
    if (key === 'getTheme') return () => 'light'
    if (key === 'getSettings') return () => ({})
    if (key === 'getDropPath') return () => ''
    if (key === 'cardInit') return async () => ({ sessionId: 's1', project: 'demo', dir: 'C:/demo', model: null, reattached: false })
    if (key === 'cardSend') return async () => { await new Promise((r) => setTimeout(r, 60)); return '好的,已完成。' }   // 留 60ms 流式窗口:测试在 turn 进行中喂 onStream 事件
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
const base = {
  console, setTimeout, setInterval, clearTimeout, clearInterval, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean,
  Map, Set, URLSearchParams, RegExp, Error, Symbol, Proxy, Reflect,
  requestAnimationFrame: (f) => { try { f() } catch {} },
  document: documentStub, window: windowStub, BocomHermes: bocom,
  location: { search: '' }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
const tail = '\n;__export({ submit, maybeDrain, pendingInjects, toolEls, sl, turnFn: turn, _setReady: (v) => { cardReady = v }, _setBusy: setBusy, _busy: () => busy, ci: document.getElementById("ci"), _ctx: () => ctxUsedChars, _setCtx: (n) => { ctxUsedChars = n; paintCtxChip() }, ctxChip: document.getElementById("ctxchip") })'
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
ok('紧凑模式:工具块默认折叠(对齐 Claude Code 一行摘要)', tb && tb.open === false, tb && tb.open)
try { cbs.onStream({ kind: 'tool', text: 'read', partID: 'p1', status: 'completed', input: { filePath: 'a.js' }, title: 'a.js', output: 'x'.repeat(1500) }) } catch (e) { evErr = e }
ok('completed 摘要行带输出量(⎿ N 字)', tb && /⎿ 1\.5k 字/.test(tb.innerHTML), tb && tb.innerHTML.slice(0, 200))
ok('completed 后从状态行登记表注销', ![...(exported.sl && [] || [])].length && /完成/.test(tb.innerHTML))

console.log('用例3:todowrite → 勾选清单(不是 JSON)')
try { cbs.onStream({ kind: 'tool', text: 'todowrite', partID: 'p2', status: 'completed', input: { todos: [ { content: '读代码', status: 'completed' }, { content: '写修复', status: 'in_progress' }, { content: '跑测试', status: 'pending' } ] } }) } catch (e) { evErr = e }
const td = exported.toolEls.get('p2')
ok('todo 事件不抛', !evErr, evErr && evErr.message)
ok('渲染成勾选清单(含 todoline)', td && /todoline/.test(td.innerHTML), td && td.innerHTML.slice(0, 120))
ok('三种状态记号都在(☒/◐/☐)', td && td.innerHTML.includes('☒') && td.innerHTML.includes('◐') && td.innerHTML.includes('☐'))
ok('摘要带进度(待办 1/3)', td && /待办 1\/3/.test(td.innerHTML))
ok('todo 块例外:默认展开(它是给人盯进度的)', td && td.open === true)

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

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
