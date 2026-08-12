// 【dev server 生命周期】仿 Claude Code 的 preview_start / preview_logs / preview_stop。
//
// 【为什么需要】"跑起来再验"整块是缺的:Agent 能读代码、能开浏览器,但项目没跑起来时它只能读代码猜,
// 而前端问题恰恰是"跑起来才看得见"的那一类。CC 那套的关键不是"能起进程",是把
// 【起服务 → 等就绪 → 打开页面 → 看日志 → 停】做成一条闭环,失败的每一步都说得出原因。
//
// ★安全边界(与 CC 同):模型只能启动 launch.json 里【用户写好】的【具名】配置,
//   不能传任意命令。给出 command 参数就等于开了一个远程执行接口 —— 这条不许放宽。
//   配置文件是用户的资产,模型只能引用不能写(本模块不提供写入)。
//
// 配置(项目目录下,两处都认,前者优先 —— 很多仓库已经有 .claude/launch.json 了):
//   .bocom/launch.json  /  .claude/launch.json
//   { "version": "0.0.1", "configurations": [
//       { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run","dev"], "port": 5173, "url": "http://localhost:5173" } ] }
'use strict'
const { spawn } = require('child_process')
const net = require('net')
const path = require('path')
const fs = require('fs')

const MAX_LINES = 500          // 日志环形缓冲:够查一次问题,不至于把内存吃掉
const READY_TIMEOUT = 60000    // 等端口就绪的上限:超了就把日志原样交出来,让人看见它卡在哪
const KILL_GRACE = 3000        // SIGTERM 后的宽限,超时再 SIGKILL

function str(x) { return x == null ? '' : String(x) }
function num(x, d) { const n = +x; return Number.isFinite(n) ? n : d }

/** 读并规整 launch.json。返回 { configs: [...], from: '路径' } 或 { error }。 */
function readLaunch(dir) {
  const cands = [path.join(str(dir), '.bocom', 'launch.json'), path.join(str(dir), '.claude', 'launch.json')]
  for (const p of cands) {
    let raw = null
    try { raw = fs.readFileSync(p, 'utf8') } catch { continue }
    let j = null
    // 容忍 jsonc 的行注释:CC 的示例里就有,用户照抄过来不该因为一条注释就整个失败
    try { j = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) } catch (e) { return { error: p + ' 解析失败(不是合法 JSON):' + e.message } }
    const list = Array.isArray(j && j.configurations) ? j.configurations : []
    const configs = list.filter((c) => c && str(c.name)).map((c) => ({
      name: str(c.name),
      exec: str(c.runtimeExecutable),
      args: Array.isArray(c.runtimeArgs) ? c.runtimeArgs.map(str) : [],
      port: num(c.port, 0),
      url: str(c.url),
      cwd: str(c.cwd),
    }))
    return { configs, from: p }
  }
  return { error: '没找到 launch.json', configs: [], suggest: suggestLaunch(dir) }
}

/** 没有 launch.json 时,按项目里实际有什么【推一份出来】。
 *  ★为什么只推不写:模型能启动的必须是【用户写好的具名配置】—— 让它自己写配置再启动,
 *  等于绕开这道边界拿到任意命令执行。所以这里只把该写的内容摆出来,由用户存一次。
 *  ★为什么必须推:原来的报错只有一句"去建一个",既没说建在哪、也没说里面写什么 ——
 *  用户和模型都卡在这一步(真机就是这么卡的)。报错要能让人下一步就动手。 */
function suggestLaunch(dir) {
  const d = str(dir)
  if (!d) return null
  const cfgs = []
  const seen = new Set()
  const addNode = (rel) => {
    const pj = path.join(d, rel, 'package.json')
    let j = null
    try { j = JSON.parse(fs.readFileSync(pj, 'utf8')) } catch { return }
    const sc = (j && j.scripts) || {}
    const name = ['dev', 'start', 'serve'].find((k) => sc[k])
    if (!name) return
    // 端口:脚本里显式写了就用它;vite 默认 5173,其余按 3000 猜(用户可改)
    const m = String(sc[name]).match(/--port[= ](\d+)/)
    const isVite = /vite/.test(String(sc[name]))
    const port = m ? +m[1] : (isVite ? 5173 : 3000)
    const key = rel || '.'
    if (seen.has(key)) return
    seen.add(key)
    cfgs.push({ name: rel ? rel.replace(/[\\/]/g, '-') : 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', name],
      cwd: rel || undefined, port, url: 'http://127.0.0.1:' + port })
  }
  const addPy = (rel) => {
    const base = path.join(d, rel)
    let files = []
    try { files = fs.readdirSync(base) } catch { return }
    // ★必须有【真入口文件】才推:只看到一个叫 app 的目录就推 uvicorn 是误报
    //   (真机第一版就把 desktop/ 推成了 desktop-uvicorn —— 那目录里根本没有 python 服务)
    const has = (rel2) => { try { return fs.existsSync(path.join(base, rel2)) } catch { return false } }
    if (files.includes('manage.py')) {
      cfgs.push({ name: (rel || 'api') + '-django', runtimeExecutable: 'python3', runtimeArgs: ['manage.py', 'runserver', '0.0.0.0:8000'], cwd: rel || undefined, port: 8000, url: 'http://127.0.0.1:8000' })
    } else if (has(path.join('app', 'main.py')) || has('main.py')) {
      const mod = has(path.join('app', 'main.py')) ? 'app.main:app' : 'main:app'
      cfgs.push({ name: (rel || 'api') + '-uvicorn', runtimeExecutable: 'python3', runtimeArgs: ['-m', 'uvicorn', mod, '--reload', '--port', '8000'], cwd: rel || undefined, port: 8000, url: 'http://127.0.0.1:8000',
        note: '入口 ' + mod + ' 按你的实际变量名核一眼(FastAPI 里那个 app = FastAPI())' })
    }
  }
  let subs = []
  try { subs = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^(node_modules|\.|dist|build)/.test(e.name)).map((e) => e.name) } catch {}
  addNode('')
  addPy('')
  for (const sub of subs.slice(0, 12)) { addNode(sub); addPy(sub) }
  if (!cfgs.length) return null
  return {
    path: path.join(d, '.bocom', 'launch.json'),
    json: JSON.stringify({ version: '0.0.1', configurations: cfgs }, null, 2),
    why: '按项目里实际有的 package.json / python 入口推出来的,端口按脚本里写的或常见默认值 —— 存之前核一眼',
  }
}

/** 端口通了没:轮询 connect,通了即就绪。比"等日志里出现某句话"稳 —— 每个框架那句话都不一样。 */
function waitPort(port, timeoutMs, alive) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (typeof alive === 'function' && !alive()) return resolve({ ok: false, why: 'exited' })   // 进程先死了就别再等
      if (Date.now() - t0 > timeoutMs) return resolve({ ok: false, why: 'timeout' })
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve({ ok: true, ms: Date.now() - t0 }) })
      sock.on('error', () => { sock.destroy(); setTimeout(tick, 300) })
      sock.setTimeout(1000, () => { sock.destroy(); setTimeout(tick, 300) })
    }
    tick()
  })
}

/** 日志筛选(纯函数,便于断言):level='error' 只留看着像错误的行;search 按子串。 */
const ERR_RE = /\b(error|err!|failed|failure|exception|cannot|not found|refused|EADDRINUSE|ENOENT|Traceback|panic)\b/i
function filterLines(lines, opts) {
  const o = opts || {}
  let out = Array.isArray(lines) ? lines.slice() : []
  if (str(o.level).toLowerCase() === 'error') out = out.filter((l) => ERR_RE.test(str(l.text)))
  const q = str(o.search).trim().toLowerCase()
  if (q) out = out.filter((l) => str(l.text).toLowerCase().indexOf(q) >= 0)
  const n = Math.min(Math.max(num(o.lines, 80), 1), MAX_LINES)
  return { shown: out.slice(-n), matched: out.length, total: (lines || []).length }
}

module.exports = function initPreview(ctx) {
  const { S, log } = ctx || {}
  const servers = new Map()   // serverId → { id, name, cmd, cwd, port, url, proc, lines[], startedAt, exit }
  let seq = 0

  const pub = (s) => ({ serverId: s.id, name: s.name, cmd: s.cmd, cwd: s.cwd, port: s.port, url: s.url,
    running: !!(s.proc && s.exit == null), exit: s.exit, uptimeSec: Math.round((Date.now() - s.startedAt) / 1000) })

  function push(s, text, stream) {
    for (const line of str(text).split(/\r?\n/)) {
      if (!line.trim()) continue
      s.lines.push({ at: Date.now(), stream, text: line.slice(0, 2000) })
      if (s.lines.length > MAX_LINES) s.lines.shift()
    }
  }

  function list() { return [...servers.values()].map(pub) }

  async function start(a) {
    const dir = str((a && a.dir) || (S && S.settings && S.settings.projectDir))
    if (!dir) return { error: '没有项目目录' }
    const name = str(a && a.name).trim()
    if (!name) return { error: '要启动哪个配置?给 name(用 preview_list 看有哪些);★不接受任意命令 —— 只能跑 launch.json 里写好的' }

    const lj = readLaunch(dir)
    if (lj.error && !(lj.configs || []).length) {
      const sg = lj.suggest
      return { error: lj.error + (sg
        ? '。这是按你项目实际情况推的一份,存成 ' + sg.path + ' 就能用(' + sg.why + '):\n' + sg.json
          + '\n★这份配置必须由【用户】存 —— 让模型自己写配置再启动,等于绕开"只跑用户写好的命令"这条边界。'
        : '(在项目目录下建 .bocom/launch.json 或 .claude/launch.json;项目里没探到 package.json 或 python 入口,得手写)') }
    }
    const cfg = (lj.configs || []).find((c) => c.name === name)
    if (!cfg) return { error: '没有叫「' + name + '」的配置。现有:' + ((lj.configs || []).map((c) => c.name).join(' / ') || '(空)') }

    // 同名已在跑 → 复用(重复 spawn 只会撞端口,而那条错误对模型没有任何指导意义)
    for (const s of servers.values()) if (s.name === name && s.exit == null) return { ok: true, reused: true, ...pub(s) }

    if (!cfg.exec) return { error: '配置「' + name + '」没有 runtimeExecutable(要跑什么命令)' }
    const cwd = cfg.cwd ? path.resolve(dir, cfg.cwd) : dir
    const id = 'srv' + (++seq)
    const s = { id, name, cmd: cfg.exec + ' ' + cfg.args.join(' '), cwd, port: cfg.port,
      url: cfg.url || (cfg.port ? 'http://localhost:' + cfg.port : ''), lines: [], startedAt: Date.now(), exit: null, proc: null }
    try {
      s.proc = spawn(cfg.exec, cfg.args, { cwd, shell: process.platform === 'win32', env: process.env })
    } catch (e) { return { error: '起不来: ' + e.message } }
    servers.set(id, s)
    s.proc.stdout && s.proc.stdout.on('data', (d) => push(s, d.toString(), 'out'))
    s.proc.stderr && s.proc.stderr.on('data', (d) => push(s, d.toString(), 'err'))
    s.proc.on('exit', (code, sig) => { s.exit = { code, sig: str(sig), at: Date.now() }; try { log && log('[preview] ' + name + ' 退出 code=' + code + ' sig=' + sig) } catch {} })
    try { log && log('[preview] 启动 ' + name + ': ' + s.cmd + ' (cwd=' + cwd + ')') } catch {}

    if (!cfg.port) return { ok: true, ...pub(s), note: '配置没写 port —— 无法判断是否就绪,请自己看 preview_logs' }
    const w = await waitPort(cfg.port, READY_TIMEOUT, () => s.exit == null)
    if (!w.ok) {
      // ★失败要把日志【原样】交出来:"起不来"三个字对排查没有任何价值,而原因几乎总在最后几行里
      const tail = filterLines(s.lines, { lines: 25 }).shown.map((l) => l.text)
      return { error: w.why === 'exited'
        ? ('进程已退出(code=' + (s.exit && s.exit.code) + ')—— 没起来')
        : ('等了 ' + (READY_TIMEOUT / 1000) + ' 秒端口 ' + cfg.port + ' 仍未就绪'),
        cmd: s.cmd, cwd, serverId: id, logTail: tail }
    }
    return { ok: true, ...pub(s), readyMs: w.ms }
  }

  function logs(a) {
    const s = servers.get(str(a && a.serverId))
    if (!s) return { error: '没有这个 serverId(用 preview_list 看)' }
    const r = filterLines(s.lines, a)
    return { ok: true, ...pub(s), lines: r.shown.map((l) => (l.stream === 'err' ? '[err] ' : '') + l.text),
      matched: r.matched, total: r.total,
      truncated: r.matched > r.shown.length ? ('命中 ' + r.matched + ' 行,只给了最近 ' + r.shown.length + ' 行') : '' }
  }

  function stop(a) {
    const s = servers.get(str(a && a.serverId))
    if (!s) return { error: '没有这个 serverId(用 preview_list 看)' }
    if (s.exit != null) { servers.delete(s.id); return { ok: true, already: true } }
    try { s.proc.kill('SIGTERM') } catch {}
    setTimeout(() => { try { if (s.exit == null) s.proc.kill('SIGKILL') } catch {} }, KILL_GRACE)
    try { log && log('[preview] 停止 ' + s.name) } catch {}
    return { ok: true, stopping: true, serverId: s.id }
  }

  /** 应用退出时全收 —— 不收就把 dev server 留成僵尸,下次启动直接撞端口 */
  function killAll() {
    for (const s of servers.values()) { try { if (s.exit == null) s.proc.kill('SIGKILL') } catch {} }
    servers.clear()
  }

  function configs(a) {
    const dir = str((a && a.dir) || (S && S.settings && S.settings.projectDir))
    const lj = readLaunch(dir)
    return { ok: true, from: lj.from || '', error: lj.error || '', suggest: lj.suggest || null,
      configs: (lj.configs || []).map((c) => ({ name: c.name, cmd: c.exec + ' ' + c.args.join(' '), port: c.port, url: c.url })) }
  }

  return { start, logs, stop, list, configs, killAll, __test: { readLaunch, filterLines, waitPort } }
}
module.exports.__pure = { readLaunch, filterLines, suggestLaunch }
