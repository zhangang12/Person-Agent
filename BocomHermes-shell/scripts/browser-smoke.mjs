// 内嵌浏览器端到端冒烟:npm run smoke:browser [起始URL]
//
// 【为什么要有这个】到这一步为止,所有性能数与"真的能用"的结论都是我在 macOS 上量的。
// 用户的内网是 Windows —— 平台差异我这边【量不出来】,只能按平台规则把代码写对,
// 然后把验证搬到那台机器上做。这个脚本就是那次验证:它走真 relay、真浏览器、真 CDP,
// 把每一步的耗时和判据打印出来。在 Windows 上跑一遍,输出发回来就知道差在哪。
//
// 前提:BocomHermes 正在运行(它才有 relay);默认拿 launch.json 里第一个配置的 url,
// 没有就用 http://127.0.0.1:5173/ —— 也可以命令行给一个。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

let pass = 0, fail = 0, warn = 0
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + String(typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 220) : ''))) }
const note = (n) => { warn++; console.log('  ! ' + n) }

function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
let cfg = null
try { cfg = JSON.parse(fs.readFileSync(path.join(userData(), 'mail-relay.json'), 'utf8')) } catch {}
if (!cfg) { console.log('✗ 找不到 mail-relay.json —— BocomHermes 没在跑。先启动它再跑本脚本。'); process.exit(1) }

function post(route, body) {
  return new Promise((res) => {
    const data = JSON.stringify(body || {})
    const t0 = Date.now()
    const req = http.request({ hostname: '127.0.0.1', port: cfg.port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-bocom-tok': cfg.token } },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { let j = null; try { j = JSON.parse(b || '{}') } catch { j = { error: '非 JSON: ' + b.slice(0, 120) } } j.__ms = Date.now() - t0; res(j) }) })
    req.on('error', (e) => res({ error: 'relay 连不上:' + e.message, __ms: Date.now() - t0 }))
    req.setTimeout(240000, () => { try { req.destroy() } catch {}; res({ error: '本脚本等超时(240s)', __ms: Date.now() - t0 }) })
    req.write(data); req.end()
  })
}
const pngSize = (fp) => { try { const d = fs.readFileSync(fp).subarray(0, 33); return { w: d.readUInt32BE(16), h: d.readUInt32BE(20), bytes: fs.statSync(fp).size } } catch { return null } }

console.log('== 环境 ==')
console.log('  平台 ' + process.platform + ' / node ' + process.version + ' / relay :' + cfg.port)

// 起始 URL:命令行 > launch.json 第一个 > 默认
let URL0 = process.argv[2] || ''
if (!URL0) {
  const c = await post('/preview/configs', {})
  const first = (c.configs || [])[0]
  if (first && first.url) { URL0 = first.url; console.log('  用 launch.json 里的「' + first.name + '」→ ' + URL0) }
}
if (!URL0) URL0 = 'http://127.0.0.1:5173/'
console.log('  起始 URL ' + URL0)

console.log('\n== ① 开会话(后台标签,不许抢屏)==')
const op = await post('/browser/open', { url: URL0, purpose: '平台冒烟:验内嵌浏览器在本机能不能用' })
ok('open 成功(' + op.__ms + 'ms)', !!op.ok, op.error || op)
if (!op.ok) { console.log('\n❌ 起始页都打不开,后面不用测了。多半是那个端口上没有服务 —— 报错原文见上。'); process.exit(1) }
const S = op.sessionId
if (op.warning) note('open 带了警告:' + String(op.warning).slice(0, 120))

console.log('\n== ② 读页(ref 句柄链路)==')
const rd = await post('/browser/read', { sessionId: S })
ok('read 成功(' + rd.__ms + 'ms)', !!rd.ok, rd.error)
const refs = (String(rd.elements || '').match(/\[ref_\d+\]/g) || []).length
ok('★拿到 ref 句柄(' + refs + ' 个)—— 这是 act/find 的地基', refs > 0, String(rd.elements || '').slice(0, 160))
if (rd.elemError) ok('  元素采集没报错', false, rd.elemError)

console.log('\n== ③ eval(查结构的能力)==')
// ★要数字就直接要数字:上一版让 eval 返回 JSON.stringify(...),回执里是【转义过的】\"n\":146,
//   正则里的 "n": 根本不连续 —— 断言恒假,而页面其实好好的。自己给自己造了一次假失败。
const ev = await post('/browser/eval', { sessionId: S, expr: 'document.querySelectorAll("*").length' })
ok('eval 成功(' + ev.__ms + 'ms)', !!ev.ok, ev.error)
const nodeN0 = +String(ev.result || 0) || 0
if (nodeN0 >= 10) ok('  页面真渲染出来了(' + nodeN0 + ' 个节点)', true)
else note('目标页只有 ' + nodeN0 + ' 个节点 —— 它本身就是空页面,不是浏览器的问题。换个真实页面再跑。')

console.log('\n== ④ 截图:尺寸 / 空白 / 耗时(平台差异最可能在这)==')
for (const [label, body] of [['可视区', {}], ['整页', { full: true }]]) {
  const sh = await post('/browser/shot', { sessionId: S, ...body })
  if (!sh.ok) { ok(label + '截图', false, sh.error); continue }
  const sz = pngSize(sh.path)
  const mp = sz ? (sz.w * sz.h) / 1e6 : 0
  const kbmp = sz && mp ? Math.round(sz.bytes / 1024 / mp) : 0
  console.log('  · ' + label + ' ' + sh.__ms + 'ms  ' + (sz ? sz.w + '×' + sz.h + ' ' + Math.round(sz.bytes / 1024) + 'KB (' + kbmp + 'KB/百万像素)' : '(读不到 PNG)'))
  ok('  ' + label + ':宽度正常(≥600px,不是手机断点)', !!sz && sz.w >= 600, sz)
  ok('★ ' + label + ':不是空白图(≥10KB/百万像素)', kbmp >= 10, { kbmp, hint: '全白图约 4;正常页面 100 以上' })
  if (sh.__ms > 5000) note(label + '截图 ' + sh.__ms + 'ms —— 偏慢,把这行发回来')
  if (sh.warning) note(String(sh.warning).slice(0, 140))
  if (sh.truncated) console.log('    (' + String(sh.truncated).slice(0, 90) + ')')
}

console.log('\n== ⑤ 上传白名单(Windows 大小写/盘符差异最容易在这翻车)==')
{
  const dl = process.platform === 'win32' ? path.join(os.homedir(), 'Downloads') : path.join(os.homedir(), 'Downloads')
  const f = path.join(dl, 'bocom-smoke-' + Date.now() + '.txt')
  let wrote = false
  try { fs.writeFileSync(f, 'smoke'); wrote = true } catch (e) { note('写不进下载目录,跳过这一格:' + e.message) }
  if (wrote) {
    const up = await post('/browser/upload', { sessionId: S, files: [f], selector: 'input[type=file]' })
    // 页面上多半没有 file input —— 那也没关系:我们要区分的是"被白名单拒了"还是"页面没有文件框"
    const rejected = /拒绝上传/.test(String(up.error || ''))
    ok('★下载目录里的文件【没有】被白名单误拒(Windows 大小写差异会导致误拒)', !rejected, up.error)
    if (!rejected && up.error) console.log('    (这一页没有文件输入框,属正常:' + String(up.error).slice(0, 70) + ')')
    try { fs.unlinkSync(f) } catch {}
  }
}

console.log('\n== ⑥ 收会话 ==')
const cl = await post('/browser/close', { sessionId: S, status: 'done', note: '平台冒烟' })
ok('close 出报告(' + cl.__ms + 'ms)', !!cl.ok, cl.error)

console.log('\n' + (fail ? '❌ 冒烟:' + pass + ' 过 / ' + fail + ' 失败' + (warn ? ' / ' + warn + ' 条提示' : '')
  : '✅ 冒烟:全部通过(' + pass + ' 项' + (warn ? ',' + warn + ' 条提示' : '') + ')'))
console.log('把上面【整段输出】发回来 —— 尤其是④的耗时和 KB/百万像素,那是平台差异最直接的证据。')
process.exit(fail ? 1 : 0)
