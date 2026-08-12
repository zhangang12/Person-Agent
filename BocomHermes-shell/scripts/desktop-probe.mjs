// 桌面客户端可自动化性探测:node scripts/desktop-probe.mjs [进程名关键字]
//
// 【这个脚本回答一个问题】那个柜面客户端,我们能不能像驱动内嵌浏览器一样驱动它?
// 三条路的工作量差十倍,所以先判定、别先动手:
//   路A【最好】客户端内嵌的是可调试的浏览器内核(CEF / WebView2 / Electron)
//        → 能 attach 上 CDP,拿 DOM、精确点、可断言 —— 现有那 13 个 browser_* 工具几乎能整套复用。
//   路B【Flex/SWF】SWF 内部没有 DOM,CDP 也看不进去。
//        → 只有两种可能:① 页面暴露了 ExternalInterface(AS↔JS 桥),从宿主页 JS 调进去(可行且干净)
//                       ② 否则只能像素级:截图 + 坐标点击(脆,但对 Flex 往往是唯一解)
//   路C【原生控件】Win32/WPF/Java Swing → 走 Windows UI Automation(无障碍树),
//        能拿控件树、能点能填,比 OCR 可靠得多,但要另配一个辅助进程。
//
// 本脚本只做【只读探测】:列进程、看加载了哪些内核 DLL、扫远程调试端口。不点任何东西。
import { execSync } from 'node:child_process'
import http from 'node:http'

const KEY = (process.argv[2] || '').toLowerCase()
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' } }
const isWin = process.platform === 'win32'

console.log('== 平台 ==')
console.log('  ' + process.platform + ' / node ' + process.version + (isWin ? '' : '  ⚠ 柜面客户端一般在 Windows,这脚本要在【那台机器】上跑才有意义'))

console.log('\n== ① 进程与命令行(找那个客户端)==')
let procs = []
if (isWin) {
  const out = sh('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"')
  try { procs = JSON.parse(out || '[]'); if (!Array.isArray(procs)) procs = [procs] } catch {}
  procs = procs.map((p) => ({ pid: p.ProcessId, name: String(p.Name || ''), cmd: String(p.CommandLine || '') }))
} else {
  procs = sh('ps -axo pid=,comm=,args=').split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/)
    return m ? { pid: +m[1], name: m[2].split('/').pop(), cmd: m[3] } : null
  }).filter(Boolean)
}
const hit = procs.filter((p) => !KEY || (p.name + ' ' + p.cmd).toLowerCase().includes(KEY))
if (KEY && !hit.length) console.log('  ! 没找到含「' + KEY + '」的进程 —— 先把客户端打开,或换个关键字(不带参数会列出所有可疑的)')
const suspects = (KEY ? hit : procs).filter((p) => /cef|webview2|electron|chrome|flash|java|\.exe$/i.test(p.name) || /--remote-debugging|libcef|msedgewebview/i.test(p.cmd))
for (const p of suspects.slice(0, 25)) console.log('  · [' + p.pid + '] ' + p.name + '  ' + p.cmd.slice(0, 150))
if (!suspects.length) console.log('  (没列出可疑进程;带上关键字再跑,例:node scripts/desktop-probe.mjs 柜面)')

console.log('\n== ② 已经开着远程调试端口吗(路A 最快的判定)==')
const ports = [9222, 9223, 9229, 8888, 9333, 1337, 8315]
let found = 0
for (const port of ports) {
  const v = await getJson('http://127.0.0.1:' + port + '/json/version')
  if (v) {
    found++
    console.log('  ✓ :' + port + ' 有调试端点 → ' + JSON.stringify(v).slice(0, 160))
    const pages = await getJson('http://127.0.0.1:' + port + '/json/list') || await getJson('http://127.0.0.1:' + port + '/json')
    for (const pg of (Array.isArray(pages) ? pages : []).slice(0, 6)) console.log('      页面:' + String(pg.title || '').slice(0, 40) + ' — ' + String(pg.url || '').slice(0, 90))
  }
}
if (!found) console.log('  ✗ 常见端口上都没有 —— 不代表不行,多半只是【没开】(见下面"怎么开")')

if (isWin) {
  console.log('\n== ③ 客户端加载了哪种浏览器内核(决定走哪条路)==')
  const pids = (KEY ? hit : suspects).slice(0, 6).map((p) => p.pid)
  for (const pid of pids) {
    const mods = sh('powershell -NoProfile -Command "(Get-Process -Id ' + pid + ').Modules | Select-Object -ExpandProperty ModuleName"')
    const has = (re) => new RegExp(re, 'i').test(mods)
    const kinds = []
    if (has('libcef')) kinds.push('CEF(Chromium 内嵌)→ 路A,可开远程调试')
    if (has('WebView2Loader|msedgewebview')) kinds.push('WebView2(Edge 内嵌)→ 路A,可开远程调试')
    if (has('electron|node\\.dll')) kinds.push('Electron → 路A')
    if (has('Flash|pepflashplayer|NPSWF')) kinds.push('★Flash/Flex → 路B(SWF 里没有 DOM)')
    if (has('mshtml|ieframe')) kinds.push('IE 内核(WebBrowser 控件)→ 只能走 COM/IUIAutomation,路C')
    if (has('jvm|awt|jawt')) kinds.push('Java(Swing/AWT)→ 路C(UI Automation / Java Access Bridge)')
    if (has('PresentationCore|wpfgfx')) kinds.push('WPF → 路C(UI Automation,支持得最好)')
    console.log('  [' + pid + '] ' + (kinds.length ? kinds.join(' ; ') : '没认出内核(可能是纯 Win32,走路C)'))
  }
} else {
  console.log('\n== ③ 内核识别:只能在 Windows 上做(要读进程加载的 DLL)==')
}

console.log(`
== 结论怎么读 ==
· ②里有端点,或③里认出 CEF/WebView2/Electron  → 路A。现有 browser_* 工具几乎整套能复用:
    CEF        启动参数加  --remote-debugging-port=9222
    WebView2   环境变量    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
    Electron   启动参数加  --remote-debugging-port=9222
  ★这一步要客户端厂商/运维同意改启动参数。改不了的话路A 就断了,直接看路C。
· ③里出现 Flash/Flex → 路B。先问一件事:那些 Flex 页面有没有 ExternalInterface 桥
  (页面 JS 里能不能调到 AS 的方法)。有 → 从宿主页 JS 调,干净可靠;没有 → 只剩像素级。
· 其余(IE 内核 / Java / WPF / 纯 Win32)→ 路C,Windows UI Automation。

== 不管走哪条,这三条先定下来再动手 ==
1) 只读优先:先只做 截图/读控件树/读 DOM。柜面客户端带着柜员的真实权限,
   一次误点可能是一笔真交易 —— 写操作(点击/输入)必须逐次人工确认,不许自动放行。
2) 围栏按【系统+页面】白名单,和浏览器那套同一条口径:默认谁都不许碰,逐个加白。
3) 全程留痕:每一次调用记一行(谁、在哪个页面、做了什么、回了什么)。
   我们在浏览器那条路上吃过的亏就是这条 —— 没有留痕时,"它到底干了什么"完全查不出来。
`)

function getJson(url) {
  return new Promise((res) => {
    const req = http.get(url, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)) } catch { res(null) } }) })
    req.on('error', () => res(null))
    req.setTimeout(1200, () => { try { req.destroy() } catch {}; res(null) })
  })
}
