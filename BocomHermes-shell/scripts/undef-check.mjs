// 跨作用域引用检查(npm run undef)—— 专治"用了一个这儿看不见的名字"。
//
// 【为什么单独造这把尺子】这一类错已经咬了六次:arr / setDevice / webContentsById / regWcId / num / log。
// 每一次都是 `node --check` 全绿、真跑才炸,而炸的位置往往在【只有异常路径才走到】的那几行
// (拉黑留痕、崩溃兜底、失败重问)—— 正常跑一百遍都碰不到,一碰就是整条回合断在
// 「Error invoking remote method 'card-send': Error: num is not defined」这种与真相毫无关系的话上。
// 单元测试兜不住它:测试只走它自己想到的路径。这必须是【静态】的、对全仓库无条件跑一遍的。
//
// 【判据】按【函数级】作用域链解析(不看块级)。let/const 也当函数级声明处理 ——
// 故意过度声明,宁可漏报也绝不误报:块级泄漏(TDZ、if 里 let 外面用)不报,
// 但"A 函数里的局部帮手,B 函数里去用"和"名字压根不存在"这两类必抓。
//
// 报两类:
//   ① 读一个作用域链上没有的名字 → 必炸(ReferenceError)
//   ② 赋值给一个没声明过的名字 → sloppy 模式下不炸,但那是在偷偷造全局变量,基本都是笔误
'use strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const acorn = require('acorn')

// 必须走 fileURLToPath:仓库路径里有中文,URL.pathname 拿到的是 %E4%B8%AA… 百分号编码,fs 直接 ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 全局白名单:标准 JS + Node + Web(fetch 那套)────────────────────────────
const GLOBALS = new Set(`
Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Function
Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError
Promise Map Set WeakMap WeakSet WeakRef FinalizationRegistry Proxy Reflect Atomics
ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array
Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array
parseInt parseFloat isNaN isFinite encodeURI encodeURIComponent decodeURI decodeURIComponent
escape unescape NaN Infinity undefined globalThis eval Intl structuredClone WebAssembly
require module exports __dirname __filename process Buffer console global
setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask
URL URLSearchParams TextEncoder TextDecoder AbortController AbortSignal
fetch Headers Request Response FormData Blob File ReadableStream WritableStream TransformStream
performance crypto Event EventTarget CustomEvent MessageChannel MessagePort BroadcastChannel
arguments this super navigator WebSocket
`.trim().split(/\s+/))

// 渲染端/preload/注入进页面的代码:额外认浏览器全局。★只按文件名开,不并进主表 ——
// 否则 main.js 里误用 document 就永远查不出来了。
const BROWSER_GLOBALS = new Set(`
window document location localStorage sessionStorage history screen alert confirm prompt
requestAnimationFrame cancelAnimationFrame getComputedStyle MutationObserver ResizeObserver
IntersectionObserver Element HTMLElement Node NodeList DOMParser XMLHttpRequest Image Audio
CSS customElements matchMedia scrollTo getSelection
`.trim().split(/\s+/))
const BROWSER_FILE = /(^|\/)(preload[^/]*\.(js|cjs|mjs)|[^/]*-preload\.(js|cjs|mjs)|stub-preload\.cjs)$/

// 扫哪些文件:真正跑在主进程/子进程里的代码。渲染端(ui-vue)由 vue-tsc 管,不重复。
function collect() {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p)
    }
  }
  walk(path.join(ROOT, 'src'))
  walk(path.join(ROOT, 'mcp'))
  walk(path.join(ROOT, 'scripts'))
  for (const f of ['main.js', 'opencode.js', 'preload.js']) {
    const p = path.join(ROOT, f)
    if (fs.existsSync(p)) out.push(p)
  }
  return out
}

// ── 作用域 ──────────────────────────────────────────────────────────────────
function mkScope(parent) { return { parent, names: new Set() } }
function has(scope, name) { for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true; return false }

/** 从绑定模式里抠出所有名字(解构/默认值/rest);同时把默认值里的表达式交给 cb 当引用处理 */
function bindNames(node, add, refs) {
  if (!node) return
  switch (node.type) {
    case 'Identifier': add(node.name); break
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') bindNames(p.argument, add, refs)
        else { if (p.computed && refs) refs.push(p.key); bindNames(p.value, add, refs) }
      }
      break
    case 'ArrayPattern': for (const el of node.elements) bindNames(el, add, refs); break
    case 'AssignmentPattern': bindNames(node.left, add, refs); if (refs) refs.push(node.right); break
    case 'RestElement': bindNames(node.argument, add, refs); break
    case 'MemberExpression': if (refs) refs.push(node); break   // for (obj.x of …)
    default: break
  }
}

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** 提升:把一个函数体(不含嵌套函数体)里的所有声明先塞进当前作用域 */
function hoist(node, scope) {
  const add = (n) => scope.names.add(n)
  const visit = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) visit(x); return }
    if (typeof n.type !== 'string') return
    if (n.type === 'FunctionDeclaration') { if (n.id) add(n.id.name); return }        // 名字进外层,身体不看
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return
    if (n.type === 'ClassDeclaration') { if (n.id) add(n.id.name); return }
    if (n.type === 'ClassExpression') return
    if (n.type === 'VariableDeclaration') { for (const d of n.declarations) bindNames(d.id, add, null) }
    if (n.type === 'ImportDeclaration') { for (const s of n.specifiers) if (s.local) add(s.local.name); return }
    for (const k of Object.keys(n)) { if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue; visit(n[k]) }
  }
  visit(node)
}

export function scanSource(src, file, sourceType, extraGlobals) {
  const bad = []
  const known = (name) => GLOBALS.has(name) || !!(extraGlobals && extraGlobals.has(name))
  let ast
  try {
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, locations: true })
  } catch (e) { return [{ file, line: (e.loc && e.loc.line) || 0, name: '', kind: 'parse', msg: '解析失败:' + e.message }] }

  const report = (id, kind) => {
    bad.push({ file, line: (id.loc && id.loc.start.line) || 0, name: id.name, kind })
  }

  // ref(node, scope):把 node 当"表达式"走,遇到 Identifier 就解析
  const ref = (node, scope) => walk(node, scope, true)

  function walk(node, scope, asExpr) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const x of node) walk(x, scope, asExpr); return }
    if (typeof node.type !== 'string') return

    switch (node.type) {
      case 'Identifier':
        if (!has(scope, node.name) && !known(node.name)) report(node, 'read')
        return
      // typeof x 对【未声明】的名字是合法的(不抛),特性探测就靠这个 —— 不能报
      case 'UnaryExpression':
        if (node.operator === 'typeof' && node.argument.type === 'Identifier') return
        walk(node.argument, scope)
        return
      case 'MemberExpression':
        walk(node.object, scope); if (node.computed) walk(node.property, scope)
        return
      case 'Property':
        if (node.computed) walk(node.key, scope)
        walk(node.value, scope)
        return
      case 'MethodDefinition': case 'PropertyDefinition':
        if (node.computed) walk(node.key, scope)
        walk(node.value, scope)
        return
      case 'VariableDeclarator': {
        // id 已在 hoist 里声明过;只需处理解构里的计算键/默认值,以及 init
        const refs = []
        bindNames(node.id, () => {}, refs)
        for (const r of refs) walk(r, scope)
        walk(node.init, scope)
        return
      }
      case 'AssignmentExpression': {
        if (node.left.type === 'Identifier') {
          if (!has(scope, node.left.name) && !known(node.left.name)) report(node.left, 'assign')
        } else walk(node.left, scope)
        walk(node.right, scope)
        return
      }
      case 'LabeledStatement': walk(node.body, scope); return
      case 'BreakStatement': case 'ContinueStatement': return
      case 'ExportSpecifier': walk(node.local, scope); return
      case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return
      case 'ExportAllDeclaration': case 'ImportDeclaration': return
      case 'MetaProperty': return
      case 'CatchClause': {
        const s = mkScope(scope)
        if (node.param) bindNames(node.param, (n) => s.names.add(n), null)
        hoist(node.body, s)
        walk(node.body, s)
        return
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const s = mkScope(scope)
        if (node.type === 'FunctionExpression' && node.id) s.names.add(node.id.name)
        const refs = []
        for (const p of node.params) bindNames(p, (n) => s.names.add(n), refs)
        for (const r of refs) walk(r, s)
        hoist(node.body, s)
        walk(node.body, s)
        return
      }
      case 'ClassDeclaration': case 'ClassExpression': {
        const s = mkScope(scope)
        if (node.id) s.names.add(node.id.name)
        walk(node.superClass, s)
        walk(node.body, s)
        return
      }
      default: {
        for (const k of Object.keys(node)) {
          if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
          walk(node[k], scope, asExpr)
        }
        return
      }
    }
  }

  const root = mkScope(null)
  hoist(ast, root)
  walk(ast, root)
  return bad
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
// 只在【直接被跑】时扫全仓库。★不能用环境变量当开关:ESM 会先把被 import 的模块整个执行完
// 再跑导入方的语句,自测里那句 process.env.xxx=1 永远来不及生效(第一版就栽在这儿,自测跑出来的是全仓库扫描结果)。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const files = collect()
  let all = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const type = f.endsWith('.mjs') ? 'module' : (/^\s*(import |export )/m.test(src) ? 'module' : 'script')
    const rel = path.relative(ROOT, f)
    all = all.concat(scanSource(src, rel, type, BROWSER_FILE.test(rel) ? BROWSER_GLOBALS : null))
  }
  const byFile = new Map()
  for (const b of all) { if (!byFile.has(b.file)) byFile.set(b.file, []); byFile.get(b.file).push(b) }
  if (!all.length) {
    console.log('✅ undef:' + files.length + ' 个文件,没有跨作用域/未声明引用')
    process.exit(0)
  }
  console.log('❌ undef:' + all.length + ' 处(' + byFile.size + ' 个文件)')
  for (const [f, list] of byFile) {
    console.log('\n  ' + f)
    for (const b of list) {
      const tag = b.kind === 'read' ? '读到看不见的名字(会抛 ReferenceError)'
        : b.kind === 'assign' ? '赋值给未声明的名字(在偷偷造全局)' : b.msg
      console.log('    :' + b.line + '  ' + (b.name ? '`' + b.name + '` — ' : '') + tag)
    }
  }
  process.exit(1)
}
