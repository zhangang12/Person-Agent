// 注入脚本检查(npm run inject)—— 把每一段 executeJavaScript 的源码真的解析一遍。
//
// 【为什么要造这把尺子】2026-08-11 真机:browser_read 从写下那天起【一次都没成功过】。
// 病根在 src/window.js 注入串里的一行 `lines.join('\n')` —— 它写在 Node 的模板串里,
// 而模板串会把 \n 吃成【真换行】,于是页面拿到的是一条断行的字符串字面量:
//     return {els:lines.join('
//     '),shown:n,total:total};
// → SyntaxError。而外层 catch 把它塞进 els='(采集失败: …)' 还照样 ok:true,
// 模型只当"这页没有可交互元素",接着自己猜 CSS selector;控制台里那两条 SyntaxError
// 它归因给了 Vite。整条 ref 句柄链路(read → find → act(ref))就这么空转着。
//
// node --check 看不进模板串里(那对它只是一个字符串);ref:test 那 33 格测的是 ref 解析的纯逻辑,
// 从来没测过【注入出去的那段源码本身】。所以必须单独把注入串抠出来、当 JS 解析。
//
// 报两类:
//   ① 注入的源码解析不过 → 页面上必抛 SyntaxError,那段注入等于没写
//   ② 单个反斜杠被模板串吞掉(\s → s、\n → 真换行、\d \w \. 同理)→ 正则/字符串静默变样
'use strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const acorn = require('acorn')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 抠出一个文件里所有 executeJavaScript(`…`) 的模板串体(含 ${} 占位)
 *  ★必须认【拼接】:真机里有 `…` + `…` + `…` 这种写法,只取第一段会得到半截程序,
 *  于是这把尺子自己报出一个假的 SyntaxError —— 一把会误报的尺子等于没有尺子。 */
export function extractInjected(src) {
  const out = []
  // 两种写法都要认:① 直接 executeJavaScript(`…`) ② 本仓库惯例 const XXX_JS = `…`(录制引擎、取色器都是这么写的,
  //   最后由变量传进 executeJavaScript —— 只盯调用点会把最大的几段整个漏掉)
  const re = /(?:executeJavaScript\(\s*|(?:const|let|var)\s+[A-Za-z_$][\w$]*_JS\s*=\s*)`/g
  let m
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    const end = src.indexOf('`', i)      // 注入串里不含反引号(含了这把尺子会漏,值得的取舍)
    if (end < 0) continue
    let body = src.slice(i, end)
    i = end + 1
    // 往后吃 `+ '…'` / `+ "…"` / `+ \`…\`` 拼上来的段
    for (;;) {
      const rest = src.slice(i)
      const j = /^[\s\r\n]*\+[\s\r\n]*(['"`])/.exec(rest)
      if (!j) break
      const quote = j[1]
      const from = i + j[0].length
      const to = src.indexOf(quote, from)
      if (to < 0) break
      body += src.slice(from, to)
      i = to + 1
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, body })
    re.lastIndex = i
  }
  return out
}

/** 模板串里被吞掉的单反斜杠(先把正确写法 \\ 成对吃掉,剩下的才是被吞的)
 *  \` 和 \$ 不算 —— 那两个是模板串自己的合法转义,作者是有意写的。 */
export function swallowedEscapes(body) {
  const stripped = String(body).replace(/\\\\/g, '  ')
  return [...new Set([...stripped.matchAll(/\\([^`$])/gs)].map((x) => (x[1] === '\n' ? '\\<换行>' : '\\' + x[1])))]
}

/** ${…} 占位换成一个合法的 JS 值,好让整段能当源码解析 */
export function placeholderize(body) {
  // 占位可能出现在表达式位(?:'A':'B')、字符串拼接里、甚至语句位;统一换成【带括号的】0 ——
  // 裸 0 会让 `${JSON.stringify(q)}.toLowerCase()` 变成 0.toLowerCase(),那本身就是语法错(假报)
  return String(body).replace(/\$\{[^}]*\}/g, '(0)')
}

/** 按模板串的规则把源文本"煮"一遍 —— 这才是【页面真正收到】的那段源码。
 *  ★这一步是本检查器的关键:文件里写的 `lines.join('\n')` 原文能解析,
 *  但页面收到的是把 \n 换成真换行之后的样子,那才是 SyntaxError 的现场。
 *  只解析原文 = 永远查不出这个 bug。 */
export function cookTemplate(raw) {
  const s = String(raw)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue }
    const c = s[++i]
    if (c === undefined) { out += '\\'; break }
    if (c === '\n') continue                                  // 行接续:整个吃掉
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\\': '\\' }
    if (c in simple) { out += simple[c]; continue }
    if (c === 'x') { out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16) || 0); i += 2; continue }
    if (c === 'u') {
      if (s[i + 1] === '{') { const j = s.indexOf('}', i); out += String.fromCodePoint(parseInt(s.slice(i + 2, j), 16) || 0); i = j; continue }
      out += String.fromCharCode(parseInt(s.substr(i + 1, 4), 16) || 0); i += 4; continue
    }
    out += c                                                  // 其余(\s \d \w \. \` \$ …)反斜杠被吞,只留字符
  }
  return out
}

/** 检查一段注入串:返回问题数组 */
export function checkInjected(body) {
  const bad = []
  const sw = swallowedEscapes(body)
  if (sw.length) bad.push({ kind: 'escape', msg: '单反斜杠被模板串吞掉 → ' + sw.join(' ') + '(要写 \\\\)' })
  const code = cookTemplate(placeholderize(body))
  try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }) }
  catch (e) { bad.push({ kind: 'parse', msg: '注入的源码解析不过(页面上必抛 SyntaxError):' + e.message }) }
  return bad
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p)
    }
  }
  walk(path.join(ROOT, 'src'))
  for (const f of ['main.js', 'preload.js']) { const p = path.join(ROOT, f); if (fs.existsSync(p)) files.push(p) }

  let n = 0, bad = 0
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const inj of extractInjected(src)) {
      n++
      const probs = checkInjected(inj.body)
      if (!probs.length) continue
      bad++
      console.log('\n  ' + path.relative(ROOT, f) + ':' + inj.line)
      for (const p of probs) console.log('    ' + p.msg)
    }
  }
  if (!bad) { console.log('✅ inject:' + n + " 段 executeJavaScript 注入源码,解析全过、无被吞转义"); process.exit(0) }
  console.log('\n❌ inject:' + n + ' 段里 ' + bad + ' 段有问题')
  process.exit(1)
}
