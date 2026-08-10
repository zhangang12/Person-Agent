// dev server 生命周期自测:npm run preview:test
//
// 【为什么要真起一个进程】前四刀的浏览器工具全是"代码接通 + 纯逻辑断言",没有一条在真环境跑过 ——
// 而我在那几刀里两次用了【不存在的函数】(arr / setDevice),语法检查照样绿,要到真跑才炸。
// 这一刀就用一个真的 http 服务走完 启动 → 等就绪 → 读日志 → 停止,把那类错挡住。
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const initPreview = require('../src/preview.js')
const { readLaunch, filterLines } = initPreview.__pure

let pass = 0, fail = 0
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 夹具:一个真的最小 http 服务 + launch.json ──────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-preview-'))
const PORT = 34517
fs.writeFileSync(path.join(dir, 'server.js'),
  'const http=require("http");console.log("booting…");'
  + 'http.createServer((q,s)=>{s.end("hi")}).listen(' + PORT + ',()=>console.log("ready on ' + PORT + '"));'
  + 'setTimeout(()=>console.error("Error: something broke"),300);')
fs.mkdirSync(path.join(dir, '.bocom'))
fs.writeFileSync(path.join(dir, '.bocom', 'launch.json'), JSON.stringify({
  version: '0.0.1',
  configurations: [{ name: 'web', runtimeExecutable: process.execPath, runtimeArgs: ['server.js'], port: PORT, url: 'http://localhost:' + PORT }],
}))

console.log('== launch.json 解析 ==')
{
  const r = readLaunch(dir)
  ok('★读到 .bocom/launch.json', !r.error && r.configs.length === 1, r.error || r.configs)
  ok('  字段规整正确', r.configs[0].name === 'web' && r.configs[0].port === PORT && r.configs[0].args.length === 1)
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-pv2-'))
  fs.mkdirSync(path.join(d2, '.claude'))
  fs.writeFileSync(path.join(d2, '.claude', 'launch.json'), '// 带行注释(CC 示例里就有,用户照抄不该整个失败)\n{"configurations":[{"name":"x","runtimeExecutable":"npm"}]}')
  ok('★也认 .claude/launch.json,且容忍行注释', (readLaunch(d2).configs || []).length === 1, readLaunch(d2))
  ok('  没有配置文件 → 明确说去哪儿建,不是"未知错误"',
    /launch\.json/.test(readLaunch(os.tmpdir()).error || ''), readLaunch(os.tmpdir()).error)
  ok('  坏 JSON → 指名哪个文件 + 原因', (() => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-pv3-'))
    fs.mkdirSync(path.join(d3, '.bocom')); fs.writeFileSync(path.join(d3, '.bocom', 'launch.json'), '{ 坏 }')
    const e = readLaunch(d3).error || ''
    return /launch\.json/.test(e) && /解析失败/.test(e)
  })())
}

console.log('\n== 日志筛选 ==')
{
  const lines = [{ text: 'booting…' }, { text: 'ready on 3000' }, { text: 'Error: EADDRINUSE' }, { text: 'compiled with 1 warning' }]
  ok('★level=error 只留像错误的行(编译报错/端口占用是最常查的)',
    filterLines(lines, { level: 'error' }).shown.length === 1, filterLines(lines, { level: 'error' }).shown)
  ok('  search 按关键词', filterLines(lines, { search: 'ready' }).shown.length === 1)
  ok('  lines 限量,并如实回报命中数(不说的话"最近 N 行"会被当成全部)', (() => {
    const many = Array.from({ length: 50 }, (_, i) => ({ text: 'line' + i }))
    const r = filterLines(many, { lines: 5 })
    return r.shown.length === 5 && r.matched === 50 && r.total === 50
  })())
}

// ── 真跑一遍闭环 ────────────────────────────────────────────────────────────
console.log('\n== 真进程:启动 → 就绪 → 日志 → 停止 ==')
const S = { settings: { projectDir: dir } }
const pv = initPreview({ S, log: () => {} })

ok('★不给 name 直接拒(不接受任意命令 —— 这是安全边界)',
  /不接受任意命令/.test((await pv.start({})).error || ''), (await pv.start({})).error)
ok('  配置名不存在 → 列出现有的,不是干拒',
  /web/.test((await pv.start({ name: '不存在' })).error || ''), (await pv.start({ name: '不存在' })).error)

const r1 = await pv.start({ name: 'web' })
ok('★★真起来了,而且等到端口就绪才返回', !!r1.ok && r1.port === PORT, r1)
ok('  回执带 serverId 与地址(后续 logs/stop/browser_open 都要它)', !!r1.serverId && /34517/.test(r1.url || ''), r1)

const r2 = await pv.start({ name: 'web' })
ok('★同名再起 → 复用,不重复 spawn(重复只会撞端口,而那条错对模型毫无指导意义)',
  !!r2.reused && r2.serverId === r1.serverId, r2)

await sleep(500)   // 等那条 stderr 落进缓冲
const lg = pv.logs({ serverId: r1.serverId })
ok('★stdout 收得到', (lg.lines || []).some((l) => /ready on/.test(l)), (lg.lines || []).slice(0, 4))
ok('★stderr 收得到并标 [err](很多框架把编译错误只往 stderr 写)',
  (lg.lines || []).some((l) => /^\[err\]/.test(l) && /something broke/.test(l)), (lg.lines || []).slice(-3))
ok('  level=error 能把那条挑出来',
  (pv.logs({ serverId: r1.serverId, level: 'error' }).lines || []).length >= 1)
ok('  serverId 不存在 → 说清去哪儿看', /preview_list/.test(pv.logs({ serverId: 'nope' }).error || ''))

ok('  list 里能看到它在跑', (pv.list() || []).some((x) => x.serverId === r1.serverId && x.running))
ok('★停得掉', !!pv.stop({ serverId: r1.serverId }).ok)
await sleep(800)
ok('  停完 running=false(不是还挂着占端口)', (pv.list() || []).every((x) => !x.running), pv.list())

pv.killAll()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(fail ? ('\n❌ preview:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ preview:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
