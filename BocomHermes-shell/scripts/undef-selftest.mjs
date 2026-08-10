// 跨作用域引用检查器自测:npm run undef:test
//
// 【为什么这把尺子自己也要测】它是要长期挡门的 —— 一旦误报,下一个人第一反应是把它关掉;
// 一旦漏报,它就变成一张"我们查过了"的假条,比没有更糟。
// 所以两头都要钉死:① 真实咬过我的那两处必须报出来 ② 合法但看着像的写法一处都不许报。

import { scanSource } from './undef-check.mjs'

let pass = 0, fail = 0
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''))) }
const scan = (src, gl) => scanSource(src, 't.js', 'script', gl || null)
const names = (src, gl) => scan(src, gl).map((b) => b.name + ':' + b.kind)

console.log('== 必须报:真实咬过我的两处 ==')
{
  // ① opencode.js:650 —— num 只是 normalizeUsage 里的局部帮手,sendMessage 里看不见。
  //    真机后果:「回合中断: Error invoking remote method 'card-send': Error: num is not defined」
  const bug1 = `
function normalizeUsage(src) { const num = (v) => (+v > 0 ? +v : 0); return num(src.a) }
function sendMessage(info, model) { if (model) log('at=' + new Date(num(model.at) || 0)) }
function log(s) { return s }
`
  ok('★A 函数的局部帮手,B 函数里用 → 报', names(bug1).includes('num:read'), names(bug1))

  // ② window.js:1195 —— 函数没有 bundleId 这个形参,函数体里却直接读它。
  //    `bundleId || 兜底` 也救不了:读未声明的名字是 ReferenceError,不会走到 ||
  const bug2 = `
function runDebugFlow({ cardWc, serve, summary }) { const S = {}; return 'id=' + (bundleId || S.last || '') }
`
  ok('★形参里没有的名字,函数体里读 → 报(|| 兜底救不了,那是 ReferenceError)',
    names(bug2).includes('bundleId:read'), names(bug2))

  ok('  压根不存在的名字(setDevice / webContentsById 那一类)→ 报',
    names('function f(){ return setDevice(1) }').includes('setDevice:read'))
  ok('  赋值给未声明的名字(在偷偷造全局)→ 也报',
    names('function f(){ leaked = 1 }').includes('leaked:assign'))
  ok('  兄弟作用域:块里 let、另一个函数里用 → 报',
    names('function a(){ const h = 1; return h }\nfunction b(){ return h }').includes('h:read'))
}

console.log('\n== 一处都不许报:合法但看着像的写法 ==')
const clean = [
  ['提升:函数声明写在使用之后', 'function a(){ return b() }\nfunction b(){ return 1 }'],
  ['提升:var 声明在使用之后', 'function a(){ x = 1; var x; return x }'],
  ['闭包:内层用外层的名字', 'function a(){ const v = 1; return () => v }'],
  ['解构形参 + 默认值', 'function a({ x, y = 2, ...rest }, [p, q] = []) { return x + y + p + q + rest.z }'],
  ['解构声明 + 重命名 + 嵌套', 'const { a: { b: c }, d = 1 } = {}; console.log(c, d)'],
  ['catch 形参', 'try { null } catch (e) { console.log(e.message) }'],
  ['可选 catch(无形参)', 'try { null } catch { console.log(1) }'],
  ['typeof 未声明的名字是合法的(特性探测)', 'if (typeof WeirdGlobal === "undefined") { console.log(1) }'],
  ['属性名不是引用', 'const o = { num: 1, log: 2 }; console.log(o.num, o.log)'],
  ['计算属性里的名字【是】引用(但这里声明过)', 'const k = "a"; const o = { [k]: 1 }; console.log(o)'],
  ['简写属性【是】引用(声明过就不该报)', 'const num = 1; const o = { num }; console.log(o)'],
  ['label 不是引用', 'outer: for (const x of []) { if (x) continue outer; else break outer }'],
  ['for-of / for-in 的声明', 'for (const x of []) console.log(x)\nfor (const k in {}) console.log(k)'],
  ['class:方法名、字段名、静态块', 'class A { static all = []; #p = 1; m(){ return this.#p } static { A.all.push(1) } }\nconsole.log(new A().m())'],
  ['class 表达式能引用自己', 'const C = class Self { m(){ return Self } }; console.log(C)'],
  ['函数表达式能引用自己(具名 FE)', 'const f = function me(n){ return n ? me(n - 1) : 0 }; console.log(f(3))'],
  ['getter/setter 与简写方法', 'const o = { get a(){ return 1 }, set a(v){ this._v = v }, m(){ return 2 } }; console.log(o)'],
  ['可选链 / 空值合并 / 逻辑赋值', 'let a = null; a ??= {}; console.log(a?.b?.c ?? 1)'],
  ['模板串里的表达式', 'const n = 1; console.log(`v=${n} ${String(n)}`)'],
  ['Node 全局', 'module.exports = { d: __dirname, p: process.pid, b: Buffer.from("x"), r: require("fs") }'],
  ['import 绑定(module)', null],
]
for (const [name, src] of clean) {
  if (src === null) continue
  const r = names(src)
  ok(name, r.length === 0, r)
}
{
  const r = scanSource('import fs from "node:fs"\nimport { join as j } from "node:path"\nexport const p = j(fs.name, "x")', 't.mjs', 'module').map((b) => b.name)
  ok('import 绑定(module):默认/具名/重命名都算声明', r.length === 0, r)
}
{
  const r = scanSource('const brSetDevice = 1; window.x = brSetDevice; console.log(location.href)', 'preload.js', 'script', new Set(['window', 'location'])).map((b) => b.name)
  ok('preload/注入类文件:额外认浏览器全局(按文件名开,不并进主表)', r.length === 0, r)
}
{
  // 主表【不认】浏览器全局:main.js 里误用 document 必须还能查出来 —— 这是分表的全部意义
  const r = names('function f(){ return document.title }')
  ok('★主进程文件里用 document → 仍然报(浏览器全局没并进主表)', r.includes('document:read'), r)
}

console.log('\n== 解析失败要如实报,不许静悄悄跳过 ==')
{
  const r = scan('function f( {')
  ok('语法错 → 报 parse,而不是"没问题"', r.length === 1 && r[0].kind === 'parse', r)
}

console.log(fail ? ('\n❌ undef:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ undef 自测:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
