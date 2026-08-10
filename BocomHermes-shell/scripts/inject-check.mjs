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
/** 从 i(引号后第一个字符)开始扫到配对的【未转义】引号,返回 {body, next} */
function scanString(src, i, quote) {
  let body = ''
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { body += c + (src[i + 1] || ''); i++; continue }   // 转义对整体带过,别在 \' 上收工
    if (c === quote) return { body, next: i + 1 }
    body += c
  }
  return null
}

export function extractInjected(src) {
  const out = []
  // 三种写法都要认:
  //   ① executeJavaScript(`…`)
  //   ② 本仓库惯例 const XXX_JS = `…`(录制引擎、取色器都这么写,最后由变量传进去 —— 只盯调用点会漏掉最大的几段)
  //   ③ ★单/双引号拼接:executeJavaScript('(function(){…' + '…')
  //      —— 这是我自己刚写 agentEval/agentHtml 用的写法,而第一版尺子只认反引号,
  //      于是新写的注入代码【压根没被检查】。盲点长在自己身上最危险:尺子说"11 段全过",
  //      而那 11 段里不包括我刚加的两段。转义被吞这件事对单引号字符串是一模一样的。
  const re = /(?:executeJavaScript\(\s*|(?:const|let|var)\s+[A-Za-z_$][\w$]*_JS\s*=\s*)(['"`])/g
  let m
  while ((m = re.exec(src))) {
    const first = scanString(src, m.index + m[0].length, m[1])
    if (!first) continue
    let body = first.body
    let i = first.next
    // 往后吃拼接:`+ '…'` 直接接上;`+ JSON.stringify(x) +` 这种【非字符串】的段要换成占位 (0),
    // 不然它被整个跳过后会留下 `var q=;` 这种空洞 —— 那是尺子自己造的假 SyntaxError。
    for (;;) {
      // 允许拼接段之间夹 // 注释行:本仓的注入串里到处都是解释性注释,
      // 不认它就会在注释处断掉、把后面的 })() 整段丢了 —— 然后报一个"函数没闭合"的假错。
      const SKIP = '(?:[\\s\\r\\n]*//[^\\n]*)*[\\s\\r\\n]*'
      const plus = new RegExp('^' + SKIP + '\\+' + SKIP).exec(src.slice(i))
      if (!plus) break
      let k = i + plus[0].length
      const q = src[k]
      if (q === '`' || q === "'" || q === '"') {
        const nxt = scanString(src, k + 1, q)
        if (!nxt) break
        body += nxt.body
        i = nxt.next
        continue
      }
      // 非字符串表达式:平衡括号往前扫,遇到 depth 0 的 + 或参数结束(, / ))就停
      let depth = 0, stop = -1
      for (; k < src.length; k++) {
        const c = src[k]
        if (c === '"' || c === "'" || c === '`') { const sc = scanString(src, k + 1, c); if (!sc) { k = src.length; break } k = sc.next - 1; continue }
        if ('([{'.includes(c)) { depth++; continue }
        if (')]}'.includes(c)) { if (depth === 0) { stop = k; break } depth--; continue }
        if (depth === 0 && (c === '+' || c === ',')) { stop = k; break }
      }
      if (stop < 0) break
      body += '(0)'
      i = stop
      if (src[i] === ',' || src[i] === ')') break   // 参数结束
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, body })
    re.lastIndex = i
  }
  return out
}

/** 被吞掉的单反斜杠(先把正确写法 \\ 成对吃掉,剩下的才是被吞的)
 *  ★转义定界符的那几个不算:\` \$ 是模板串的,\' \" 是单/双引号串的 —— 作者都是有意写的,
 *  而且它们的求值结果就是作者想要的那个字符,不存在"静默变样"。 */
export function swallowedEscapes(body) {
  const stripped = String(body).replace(/\\\\/g, '  ')
  return [...new Set([...stripped.matchAll(/\\([^`$'\"])/gs)].map((x) => (x[1] === '\n' ? '\\<换行>' : '\\' + x[1])))]
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
