// MCP 进程的活命兜底 + 死因留痕。每个 MCP 服务开头 import 一次即可。
//
// 【为什么必须有】2026-08-12 内网反复报 MCP "not connected"。
// not connected 的含义是【那个 stdio 子进程没了】—— 而 serve 不会把它重新拉起来,
// 于是这一整轮里那组工具全部失效,直到 serve 重启。查下来九个 MCP 服务:
//   · 零个装 uncaughtException / unhandledRejection 兜底
//   · 零个写文件日志(log 走 stderr,而 serve 并不收它)
// 两件事叠起来的后果是最坏的那种:一次未处理的 Promise rejection 就能杀掉整个进程
// (Node ≥15 的默认行为),而【死因不留任何痕迹】—— 你只看得到一句 not connected。
//
// 所以这里做两件事,一件都不能少:
//   ① 不死:未捕获异常/未处理拒绝一律记下来然后【继续跑】。
//      对一个工具服务来说,"一次调用出错"绝不该等于"这组工具全废" —— 那是不成比例的惩罚。
//   ② 留痕:启动/退出/异常全写进 userData/mcp-<name>.log(带 node 版本、pid、argv)。
//      下次再报 not connected,tail 一下那个文件就知道是谁、什么时候、为什么没的。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function userDataDir() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}

const MAX_BYTES = 2 * 1024 * 1024

export function installGuard(name) {
  const tag = String(name || 'mcp')
  let file = ''
  try {
    const dir = userDataDir()
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    file = path.join(dir, 'mcp-' + tag + '.log')
    try { if (fs.statSync(file).size > MAX_BYTES) fs.writeFileSync(file, '') } catch {}
  } catch { /* 拿不到目录就只走 stderr,绝不因为日志本身把进程搞崩 */ }

  const write = (line) => {
    const s = '[' + new Date().toISOString() + '] ' + line + '\n'
    try { process.stderr.write('[' + tag + '] ' + line + '\n') } catch {}
    if (file) { try { fs.appendFileSync(file, s) } catch {} }
  }

  write('start pid=' + process.pid + ' node=' + process.version + ' cwd=' + process.cwd()
    + ' argv=' + process.argv.slice(1).join(' ').slice(0, 200))

  // ★不退出:一次工具调用里的意外,不该把整组工具带走
  process.on('uncaughtException', (e) => {
    write('★uncaughtException(已吞下,进程继续):' + (e && e.stack ? e.stack : String(e)))
  })
  process.on('unhandledRejection', (e) => {
    write('★unhandledRejection(已吞下,进程继续):' + (e && e.stack ? e.stack : String(e)))
  })
  // stdout 断了(父进程走了)才是真该退的:再写协议只会 EPIPE 刷屏
  process.stdout.on('error', (e) => { write('stdout 断开(' + (e && e.code) + '),退出'); process.exit(0) })
  process.stdin.on('error', (e) => { write('stdin 出错:' + (e && e.message)) })
  process.stdin.on('end', () => { write('stdin 结束(父进程关闭了管道)') })
  process.on('exit', (code) => { write('exit code=' + code) })

  return { log: write, logFile: file }
}
