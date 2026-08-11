// 输入落地自测:npm run type:test
//
// 【为什么必须有】2026-08-11 真机,登录框连填三次每次都回 ✓,值一直是空:
//   13:34:30 type ref_1 → ✓   13:34:37 eval 查 value → 空
//   13:34:40 type ref_1 → ✓   13:34:42 eval 再查     → 还是空
//   13:34:46 type input[type=password] → ✓  value 依然空
// 病灶是 execStep 的 input 分支设完值、派发完事件就 `return 'OK'` ——【从不回读】。
// 两种真实场景都会因此静默失败:
//   ① ref/选择器指到的是【包裹层】(Element-Plus 的 el-input 是个 div,真 input 在里面)。
//      往 div 上设 .value 只是挂了个无用属性,照样报 OK。
//   ② 组件在 updated 钩子里用 modelValue 把 DOM 值同步回去,填进去的当场被冲掉。
// "动作报成功、实际没做到"是最坏的一类回执:模型据此往下走,错在三步之外才爆出来。
//
// 这里用一套【可编程的假 frame】驱动真的 execStep(不起浏览器):注入的 JS 不真跑,
// 而是按它要做的事在假 DOM 上模拟 —— 要守的是"设值 → 回读 → 判定"这条逻辑本身。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const initRecorder = require('../src/recorder.js')

let pass = 0, fail = 0
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''))) }

/** 造一个假 frame:executeJavaScript 收到注入源码后,按"它想干什么"在假 DOM 上演一遍 */
function makeFrame(dom) {
  return {
    executeJavaScript: async (code) => {
      // waitForEl 的可见性探针:返回 2 = 存在且可见
      if (/getBoundingClientRect/.test(code) && /return \(!!\(rc\.width/.test(code)) return dom.target ? 2 : 0
      // 回读那一段
      if (/__bocom_typed/.test(code) && /return String\(/.test(code)) {
        return dom.typed ? String(dom.typed.value == null ? '' : dom.typed.value) : '__GONE__'
      }
      // 设值那一段
      if (/dispatchEvent\(new Event\('input'/.test(code)) {
        let el = dom.target
        if (!el) return 'NF'
        if (!el.isContentEditable && el.tag !== 'input' && el.tag !== 'textarea' && el.tag !== 'select') {
          const ins = el.inner || []
          if (ins.length === 1) el = ins[0]
          else return 'NOTINPUT|' + el.tag + '|' + ins.length
        }
        const v = (code.match(/var v=("(?:[^"\\]|\\.)*")/) || [])[1]
        el.value = v ? JSON.parse(v) : ''
        dom.typed = el
        if (dom.frameworkClears) el.value = ''      // 组件把 DOM 值同步回去
        return 'OK'
      }
      return ''
    },
  }
}

function makeExec(dom) {
  const rec = initRecorder({
    S: { browser: { tabs: [], _takeover: {} }, settings: {} },
    brActive: () => null, session: {}, log: () => {},
    snapshotBad: async () => {}, RECORDER_JS: '', frameFor: () => makeFrame(dom),   // ★同步(真身就是同步的,写成 async 会返回 Promise 把整条路搞哑)
    findElExpr: () => '__el=document.querySelector("x")', anchorExpr: () => '',
    coverageHits: () => [], gitChangedFiles: () => [], resolveBus: new Map(),
    relocateSelectors: () => [], persistHeal: () => {}, takeoverDigest: () => '', pageRead: async () => ({}),
  })
  return rec.execStep
}

const tab = { view: { webContents: {} }, page: {} }

console.log('== 输入必须真的落进框里 ==')
{
  // ① 正常输入框:填了就该成
  const dom = { target: { tag: 'input', value: '', inner: [] } }
  const exec = makeExec(dom)
  const r = await exec(makeFrame(dom), { act: 'input', sel: '#u', selAlt: [], value: 'admin' }, tab, {})
  ok('普通 input:填进去 → ok', !!r.ok, r)
  ok('  值真的在框里', dom.target.value === 'admin', dom.target.value)
}
{
  // ② 组件把值冲回去(el-input 的 modelValue 同步)—— 老代码在这里回 ok,真机就是这一格
  const dom = { target: { tag: 'input', value: '', inner: [] }, frameworkClears: true }
  const exec = makeExec(dom)
  const r = await exec(makeFrame(dom), { act: 'input', sel: '#u', selAlt: [], value: 'admin' }, tab, {})
  ok('★★填了非空、回读却是空 → 判失败(修前这里报 ✓,模型连填三次都以为成了)', !r.ok, r)
  ok('  错误里说清是"没落进去",并给下一步(eval 直接设值 / 先 click 聚焦)',
    /没有落进输入框/.test(String(r.err)) && /browser_eval|click/.test(String(r.err)), r.err)
}
{
  // ③ ref 指到包裹层:里面只有一个 input → 自动下潜(这是无歧义的,比让模型自己猜靠谱)
  const inner = { tag: 'input', value: '', inner: [] }
  const dom = { target: { tag: 'div', value: undefined, inner: [inner] } }
  const exec = makeExec(dom)
  const r = await exec(makeFrame(dom), { act: 'input', sel: '.el-input', selAlt: [], value: 'admin123' }, tab, {})
  ok('★包裹层里只有一个 input → 自动下潜进去填', !!r.ok && inner.value === 'admin123', { r, v: inner.value })
}
{
  // ④ 包裹层里有多个 input → 不许乱猜,要明确报出来
  const dom = { target: { tag: 'div', value: undefined, inner: [{ tag: 'input', value: '' }, { tag: 'input', value: '' }] } }
  const exec = makeExec(dom)
  const r = await exec(makeFrame(dom), { act: 'input', sel: '.wrap', selAlt: [], value: 'x' }, tab, {})
  ok('★包裹层里有多个 input → 报错说清,不许挑一个乱填', !r.ok && /不是输入框/.test(String(r.err)), r)
  ok('  错误里点名 Element-Plus 这种包裹层的形态', /el-input|包裹层/.test(String(r.err)), r.err)
}
{
  // ⑤ 清空(填空串)是合法操作,不能因为"回读是空"判失败
  const dom = { target: { tag: 'input', value: '旧值', inner: [] } }
  const exec = makeExec(dom)
  const r = await exec(makeFrame(dom), { act: 'input', sel: '#u', selAlt: [], value: '' }, tab, {})
  ok('清空输入框(填空串)照旧算成功 —— 判据只针对"填了非空却还是空"', !!r.ok, r)
}

console.log(fail ? ('\n❌ 输入落地:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ 输入落地:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
