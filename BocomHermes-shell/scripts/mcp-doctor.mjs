// MCP 体检:npm run mcp:doctor —— 在【出问题的那台机器上】跑,直接给出 not connected 的原因。
//
// 【为什么需要它】not connected 的含义是"那个 stdio 子进程没了/没起来",而 serve 不收 MCP 的 stderr,
// 所以现场什么证据都没有。这个体检器把每一步都做一遍并把结果摊开:
//   ① 磁盘上的 opencode.jsonc 里注册了哪些 BocomHermes-*、命令行是什么
//   ② 那些文件真的存在吗(换过安装目录/解压到别处 → 路径过期 → spawn ENOENT)
//   ③ 命令里的解释器(通常是 node)在 PATH 里吗、版本够不够(我们的 MCP 是 ESM,老 node 直接语法错秒退)
//   ④ ★真的把每个 MCP 拉起来,做一次 initialize 握手 —— 起不来/不应答,当场就看得见
//   ⑤ 如果本机有 serve 在跑:它【实际加载】的那份配置和磁盘上这份一不一样
//      (serve 只在自己启动时读一次;壳层是启动后才补写的 —— 这是最常见的真因)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'

const ok = (s) => '  ✓ ' + s
const bad = (s) => '  ✗ ' + s
const warn = (s) => '  ! ' + s
let problems = 0

function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
function cfgCandidates() {
  const home = os.homedir()
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  return [process.env.OPENCODE_CONFIG, process.env.BOCOMCODE_CONFIG,
    path.join(appData, 'opencode', 'opencode.jsonc'), path.join(appData, 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'), path.join(home, '.config', 'opencode', 'opencode.json'),
  ].filter(Boolean)
}

console.log('== ① 磁盘上的 MCP 注册 ==')
let cfgPath = '', mcp = null
for (const p of cfgCandidates()) {
  if (!fs.existsSync(p)) continue
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
    if (j && j.mcp) { cfgPath = p; mcp = j.mcp; break }
  } catch (e) { console.log(warn(p + ' 解析失败:' + e.message)) }
}
if (!mcp) { console.log(bad('没找到任何带 mcp 段的 opencode 配置 —— 在 BocomHermes 里点一次「注册 MCP」')); problems++ }
else {
  const ours = Object.keys(mcp).filter((k) => /^BocomHermes-/i.test(k))
  console.log(ok('配置文件:' + cfgPath))
  console.log(ours.length ? ok('注册了 ' + ours.length + ' 个:' + ours.join(' ')) : bad('一个 BocomHermes-* 都没注册'))
  if (!ours.length) problems++

  console.log('\n== ② 命令里的文件在不在 ==')
  for (const k of ours) {
    const cmd = mcp[k].command
    const arr = Array.isArray(cmd) ? cmd : String(cmd || '').split(/\s+/)
    const file = arr.find((x) => /\.(mjs|js|cjs)$/.test(String(x)))
    if (!file) { console.log(warn(k + ' 命令里没有脚本路径:' + arr.join(' '))); continue }
    if (fs.existsSync(file)) console.log(ok(k + ' → ' + file))
    else { console.log(bad(k + ' 文件不存在 → ' + file + '(换过安装目录?spawn 会 ENOENT,表现就是 not connected)')); problems++ }
  }

  console.log('\n== ③ 解释器 ==')
  const interp = [...new Set(ours.map((k) => (Array.isArray(mcp[k].command) ? mcp[k].command[0] : String(mcp[k].command || '').split(/\s+/)[0])))]
  for (const it of interp) {
    const r = spawnSync(it, ['--version'], { encoding: 'utf8' })
    if (r.error) { console.log(bad(it + ' 跑不起来:' + r.error.message + '(serve 的 PATH 里可能没有它)')); problems++; continue }
    const v = String(r.stdout || r.stderr || '').trim()
    const major = +(v.match(/v?(\d+)\./) || [])[1] || 0
    if (major && major < 18) { console.log(bad(it + ' 版本太老:' + v + ' —— 我们的 MCP 是 ESM,老版本会直接语法错秒退')); problems++ }
    else console.log(ok(it + ' ' + v))
  }

  console.log('\n== ④ 真的拉起来握一次手(最能说明问题的一步)==')
  for (const k of ours) {
    const arr = Array.isArray(mcp[k].command) ? mcp[k].command : String(mcp[k].command || '').split(/\s+/)
    const r = await handshake(arr[0], arr.slice(1), mcp[k].environment || {})
    if (r.ok) console.log(ok(k + ' 握手成功(' + r.ms + 'ms,' + r.tools + ' 个工具)'))
    else { console.log(bad(k + ' ' + r.why)); problems++ }
  }
}

console.log('\n== ⑤ 正在跑的 serve 手里是哪一份 ==')
const port = await findServe()
if (!port) console.log(warn('本机没探到 opencode serve(没在跑就没这个问题)'))
else {
  const live = await getJson('http://127.0.0.1:' + port + '/config')
  const lm = (live && (live.mcp || (live.config && live.config.mcp))) || null
  if (!lm) console.log(warn('serve :' + port + ' 不认 /config 端点,比不了'))
  else {
    const lours = Object.keys(lm).filter((k) => /^BocomHermes-/i.test(k))
    if (!lours.length) {
      console.log(bad('★serve :' + port + ' 手里【一个 BocomHermes-* 都没有】—— 它在配置写好之前就启动了。'))
      console.log('     这一轮里所有内嵌浏览器/邮件/编排工具都会报 not connected,而且不会自愈。')
      console.log('     唯一有效的动作:重启 serve。')
      problems++
    } else {
      const diff = lours.filter((k) => String((Array.isArray(lm[k].command) ? lm[k].command.join(' ') : lm[k].command) || '')
        !== String((mcp && mcp[k] && (Array.isArray(mcp[k].command) ? mcp[k].command.join(' ') : mcp[k].command)) || ''))
      if (diff.length) {
        console.log(bad('★serve 手里的命令和磁盘上的不一样(' + diff.join(' ') + ')—— serve 只在启动时读一次配置。'))
        for (const k of diff.slice(0, 3)) {
          console.log('     serve: ' + JSON.stringify(lm[k].command))
          console.log('     磁盘 : ' + JSON.stringify(mcp[k].command))
        }
        console.log('     唯一有效的动作:重启 serve。')
        problems++
      } else console.log(ok('serve :' + port + ' 手里的 ' + lours.length + ' 个与磁盘一致'))
    }
  }
}

console.log('\n== ⑥ MCP 自己的死因日志 ==')
{
  const dir = userData()
  const logs = (() => { try { return fs.readdirSync(dir).filter((f) => /^mcp-.*\.log$/.test(f)) } catch { return [] } })()
  if (!logs.length) console.log(warn('还没有 mcp-*.log(这些日志是本次改动才加的,重启一次 serve 让 MCP 重新拉起来就有了)'))
  for (const f of logs) {
    const txt = (() => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return '' } })()
    const hits = txt.split('\n').filter((l) => /uncaughtException|unhandledRejection|exit code=[1-9]/.test(l))
    // write EPIPE 单独看:本体检器握完手会 kill 子进程,那会在对端留下一条 EPIPE —— 是本工具的噪音。
    // 但它同时也是【真实的失联机制】:serve 掉线后 MCP 再往 stdout 写就是 EPIPE,
    // 没有兜底的话进程当场死,之后永久 not connected。所以照样打出来,只是不计进问题数。
    const epipe = hits.filter((l) => /EPIPE/.test(l))
    const real = hits.filter((l) => !/EPIPE/.test(l))
    if (real.length) { console.log(bad(f + ' 有 ' + real.length + ' 条异常,最近一条:' + real[real.length - 1].slice(0, 200))); problems++ }
    else if (epipe.length) console.log(warn(f + ' 有 ' + epipe.length + ' 条 write EPIPE(刚跑过本体检的话属正常;否则说明 serve 掉过线)'))
    else console.log(ok(f + ' 无异常'))
  }
}

console.log(problems ? ('\n❌ 体检:' + problems + ' 处问题(上面每条都写了怎么办)') : '\n✅ 体检:没发现问题')
process.exit(problems ? 1 : 0)

// ── 工具 ──────────────────────────────────────────────────────────────────
function handshake(cmd, args, env) {
  return new Promise((res) => {
    const t0 = Date.now()
    let p
    try { p = spawn(cmd, args, { env: { ...process.env, ...env } }) }
    catch (e) { return res({ ok: false, why: '起不来:' + e.message }) }
    let out = '', err = '', done = false
    const fin = (r) => { if (done) return; done = true; try { p.kill() } catch {}; res(r) }
    p.on('error', (e) => fin({ ok: false, why: '起不来:' + e.message + '(命令:' + cmd + ')' }))
    // 子进程被 kill 之后还往它 stdin 写就是 EPIPE —— 体检器自己不能因此崩(第一次跑就栽在这)
    p.stdin.on('error', () => {})
    const send = (o) => { try { if (!done && p.stdin.writable) p.stdin.write(JSON.stringify(o) + '\n') } catch {} }
    p.stdout.on('data', (d) => {
      out += d
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j && j.id === 1) {
            // 握手成功,再问一次工具表
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
          }
          if (j && j.id === 2) fin({ ok: true, ms: Date.now() - t0, tools: ((j.result && j.result.tools) || []).length })
        } catch { /* 半行,等下一块 */ }
      }
    })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => fin({ ok: false, why: '进程退出 code=' + code + (err ? ';stderr:' + err.trim().slice(-300) : '(stderr 是空的)') }))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-doctor', version: '1' } } })
    setTimeout(() => fin({ ok: false, why: '10 秒内没完成握手(起得太慢或压根没应答);stderr:' + (err.trim().slice(-200) || '(空)') }), 10000)
  })
}
function getJson(url) {
  return new Promise((res) => {
    const req = http.get(url, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)) } catch { res(null) } }) })
    req.on('error', () => res(null)); req.setTimeout(3000, () => { try { req.destroy() } catch {}; res(null) })
  })
}
async function findServe() {
  for (const p of [4096, 4097, 4098, 5173]) {
    const j = await getJson('http://127.0.0.1:' + p + '/config')
    if (j) return p
  }
  return 0
}
