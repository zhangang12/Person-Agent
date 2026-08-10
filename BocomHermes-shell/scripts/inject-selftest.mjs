// 注入脚本检查器自测:npm run inject:test
//
// 【为什么这把尺子自己也要测】它挡的是"注入出去的源码在页面上炸了,而壳层这边一切看着正常"这类错。
// 一旦误报(比如认不出 `…` + `…` 拼接),下一个人第一反应是把它关掉;一旦漏报,
// browser_read 那种"从来没成功过却一直报 ok"的事还会再来一次。
import { extractInjected, swallowedEscapes, placeholderize, cookTemplate, checkInjected } from './inject-check.mjs'

let pass = 0, fail = 0
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''))) }
const kinds = (body) => checkInjected(body).map((b) => b.kind)

console.log('== 必须报:真机咬过的那一处 ==')
{
  // ★夹具必须用 String.raw:检查器吃的是【文件里的原文】(反引号之间那些字符)。
  //   在普通 JS 字符串里写 "\n" 得到的已经是真换行,那就不是原文了 —— 第一版夹具就栽在这儿,
  //   6 格全红,红的是我的夹具不是尺子。
  const real = String.raw`var lines=[];
        return {els:lines.join('\n'),shown:1,total:1};`      // 文件里是单个 \n → 真身
  const good = String.raw`var lines=[];
        return {els:lines.join('\\n'),shown:1,total:1};`     // 文件里是 \\n → 正确写法
  ok('★\\n 被吃成真换行 → 同时报"转义被吞"和"解析不过"',
    kinds(real).includes('escape') && kinds(real).includes('parse'), checkInjected(real))
  ok('  写成 \\\\n 就两条都不报(这才是正确写法)', kinds(good).length === 0, checkInjected(good))

  const sBad = String.raw`var name=''.replace(/\s+/g,' ');`    // 文件里 \s  → 被吞成 /s+/g
  const sBug = String.raw`var name=''.replace(/\\s+/g,' ');`   // 文件里 \\s → 正确
  ok('★\\s 被吃成字面 s → 报(正则静默变样:名字里每串 s 被换成空格)', kinds(sBad).includes('escape'), checkInjected(sBad))
  ok('  \\\\s 不报', kinds(sBug).length === 0, checkInjected(sBug))
  ok('  纯语法错也报(注入串里少个括号)', kinds('function f( {').includes('parse'))
  ok('  只是转义被吞、语法还成立 → 只报 escape 不报 parse(两类要分得开)',
    JSON.stringify(kinds(sBad)) === '["escape"]', checkInjected(sBad))
}

console.log('\n== 一处都不许报:合法写法 ==')
{
  ok('${} 占位在表达式位', kinds('var q=${JSON.stringify(x)}.toLowerCase();').length === 0, checkInjected('var q=${JSON.stringify(x)}.toLowerCase();'))
  ok('${} 占位在三元里', kinds("var s=${a ? 'A' : 'B'};").length === 0)
  ok('${} 占位当数字上限', kinds('if(n>=${MAX})return 1;').length === 0)
  ok('中文字符串照过', kinds("var t='用户名';").length === 0)
  ok('正则里成对写的 \\\\d \\\\w \\\\. 照过', kinds(String.raw`var re=/\\d+\\w\\./g;`).length === 0, checkInjected(String.raw`var re=/\\d+\\w\\./g;`))
  ok('模板串自己的合法转义 \\$ 不算被吞', kinds(String.raw`var b="\$";`).length === 0, checkInjected(String.raw`var b="\$";`))
}

console.log('\n== 抠取:必须认拼接,否则自己造假报 ==')
{
  const src = "wc.executeJavaScript(`(function(){var e=1;`\n  + `return e})()`, true)"
  const got = extractInjected(src)
  ok('★`…` + `…` 拼接要当成一段(只取第一段会得到半截程序 → 假 SyntaxError)',
    got.length === 1 && /return e/.test(got[0].body), got)
  ok('  拼接段合起来能解析', got.length === 1 && checkInjected(got[0].body).length === 0, got[0] && checkInjected(got[0].body))

  const src2 = "wc.executeJavaScript(`(function(){var a=1;return a})()`, true)\nwc.executeJavaScript(`document.title`, true)"
  ok('  两个独立注入点各算一段', extractInjected(src2).length === 2)

  const src3 = "  const RECORDER_JS = `(function(){var x=1;return x})()`\n  wc.executeJavaScript(RECORDER_JS)"
  ok('★也认 const XXX_JS = `…`(录制引擎/取色器都这么写,只盯调用点会把最大的几段整个漏掉)',
    extractInjected(src3).length === 1, extractInjected(src3))

  ok('  行号指到注入点那一行', (() => {
    const s = 'a\nb\nwc.executeJavaScript(`var x=1`, true)'
    return extractInjected(s)[0].line === 3
  })())
}

console.log('\n== 纯函数边界 ==')
{
  ok('swallowedEscapes 先吃掉成对 \\\\', swallowedEscapes(String.raw`a\\sb`).length === 0, swallowedEscapes(String.raw`a\\sb`))
  ok('swallowedEscapes 认出单个的', swallowedEscapes(String.raw`a\sb`).join('') === String.raw`\s`, swallowedEscapes(String.raw`a\sb`))
  ok('★cookTemplate 把 \\n 煮成真换行(这一步是本尺子的关键)', cookTemplate(String.raw`a\nb`) === 'a\nb')
  ok('  cookTemplate 把成对 \\\\n 煮成字面 \\n', cookTemplate(String.raw`a\\nb`) === String.raw`a\nb`)
  ok('  cookTemplate 把 \\s 的反斜杠吞掉(正则因此变样)', cookTemplate(String.raw`/\s+/`) === '/s+/')
  ok('placeholderize 用带括号的 0(不然 0.toLowerCase() 自己就是语法错)', /\(0\)/.test(placeholderize('${x}')))
  ok('空串不报', kinds('').length === 0)
}

console.log(fail ? ('\n❌ inject 自测:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ inject 自测:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
