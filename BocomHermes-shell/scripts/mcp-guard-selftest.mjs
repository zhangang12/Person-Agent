// MCP 活命兜底自测:npm run mcpguard:test
//
// 【为什么有这个】2026-08-12 内网反复报 MCP "not connected"。它的含义是
// 【那个 stdio 子进程没了】—— 而 serve 不会重新拉起它,于是这一整轮里那组工具全部失效。
// 查下来九个 MCP 服务:零个装崩溃兜底、零个写文件日志(log 走 stderr,serve 并不收)。
// 于是一次未处理的 Promise rejection 就能杀掉整个进程(Node ≥15 的默认行为),
// 而且【死因不留任何痕迹】—— 你只看得到一句 not connected。
//
// 这里起【真子进程】验两件事:①装了兜底就不死 ②不装就真的会死(对照组不做,这条断言等于没说)
// 以及 ③九个 MCP 入口都挂上了。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''))) }

function runNode(code, env) {
  return new Promise((res) => {
    const f = path.join(os.tmpdir(), 'bh-guard-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.mjs')
    fs.writeFileSync(f, code)
    const p = spawn(process.execPath, [f], { cwd: ROOT, env: { ...process.env, ...(env || {}) } })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code2) => { try { fs.unlinkSync(f) } catch {}; res({ code: code2, out, err }) })
  })
}

const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-guardud-'))

console.log('== MCP 活命兜底 ==')
{
  // ① 装了兜底:未处理拒绝 + 未捕获异常都不许把进程带走
  const r = await runNode(
    "import { installGuard } from '" + path.join(ROOT, 'mcp', '_guard.mjs').replace(/\\/g, '/') + "'\n"
    + "installGuard('guardtest')\n"
    + "Promise.reject(new Error('故意的未处理拒绝'))\n"
    + "setTimeout(() => { throw new Error('故意的未捕获异常') }, 30)\n"
    + "setTimeout(() => { console.error('STILL_ALIVE'); process.exit(0) }, 300)\n",
    { BOCOMHERMES_USERDATA: UD })
  ok('★★装了兜底:未处理拒绝 + 未捕获异常都吞下,进程活着', /STILL_ALIVE/.test(r.err) && r.code === 0, { code: r.code, err: r.err.slice(-200) })
  ok('  两类异常都记下来了', /unhandledRejection/.test(r.err) && /uncaughtException/.test(r.err), r.err.slice(0, 200))

  // ② 对照组:不装兜底就真的会死 —— 不做这一格,上面那条断言等于没说
  const r2 = await runNode(
    "Promise.reject(new Error('故意的未处理拒绝'))\n"
    + "setTimeout(() => { console.error('STILL_ALIVE') }, 300)\n")
  ok('★对照:不装兜底,一次未处理拒绝就把进程杀了(退出码非 0、活不到 300ms)',
    r2.code !== 0 && !/STILL_ALIVE/.test(r2.err), { code: r2.code, err: r2.err.slice(-120) })

  // ③ 死因要落盘 —— serve 不收 MCP 的 stderr,不写文件就等于没有证据
  const lf = path.join(UD, 'mcp-guardtest.log')
  const txt = fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8') : ''
  ok('★死因带堆栈落进 userData/mcp-<name>.log(serve 不收 stderr,不落盘就等于没证据)',
    /unhandledRejection/.test(txt) && /故意的未处理拒绝/.test(txt), txt.slice(0, 200))
  ok('  开头记了 node 版本/pid/cwd(版本不对是内网最常见的启动失败因)', /node=v/.test(txt) && /pid=/.test(txt), txt.slice(0, 120))
  ok('  退出也记一行(能分清"崩了"和"父进程收走了")', /exit code=/.test(txt), txt.slice(-120))
}

console.log('\n== 九个 MCP 入口都要挂上 ==')
{
  const names = ['browser', 'db', 'doc', 'git', 'httpcap', 'lsp', 'mail', 'orch', 'repro']
  const missing = names.filter((n) => {
    const f = path.join(ROOT, 'mcp', n + '-mcp.mjs')
    if (!fs.existsSync(f)) return true
    const s = fs.readFileSync(f, 'utf8')
    return !(/_guard\.mjs/.test(s) && /installGuard\(/.test(s))
  })
  ok('★每一个都装了(漏一个,那一组工具就还会整组消失)', missing.length === 0, missing)
}

try { fs.rmSync(UD, { recursive: true, force: true }) } catch {}
console.log(fail ? ('\n❌ MCP 兜底:' + pass + ' passed, ' + fail + ' failed') : ('\n✅ MCP 兜底:全部通过  ' + pass + ' passed, 0 failed'))
process.exit(fail ? 1 : 0)
