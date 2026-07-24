// LSP 冒烟:ELECTRON_RUN_AS_NODE 跑三个 server,发 initialize 等回应
import { spawn } from 'child_process'
const EXE = 'node_modules/electron/dist/electron.exe'
const SERVERS = [
  ['typescript', 'node_modules/typescript-language-server/lib/cli.mjs'],
  ['vue', 'node_modules/@vue/language-server/bin/vue-language-server.js'],
  ['pyright', 'node_modules/pyright/langserver.index.js'],
]
function frame(o) { const s = JSON.stringify(o); return 'Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s }
async function test(name, entry) {
  return new Promise((resolve) => {
    const p = spawn(EXE, [entry, '--stdio'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let buf = Buffer.alloc(0), done = false
    const kill = (ok, why) => { if (done) return; done = true; clearTimeout(timer); try { p.kill() } catch {}; console.log((ok ? '✓' : '✗') + ' ' + name + ': ' + why); resolve(ok) }
    const timer = setTimeout(() => kill(false, '15s 无响应'), 15000)
    p.on('error', (e) => kill(false, 'spawn 失败 ' + e.message))
    p.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (/"capabilities"/.test(buf.toString('utf8'))) kill(true, 'initialize 握手成功')
    })
    p.stderr.on('data', () => {})
    p.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: 'file:///' + process.cwd().replace(/\\/g, '/'), capabilities: {} } }))
  })
}
let okN = 0
for (const [n, e] of SERVERS) if (await test(n, e)) okN++
console.log(okN === SERVERS.length ? '✅ LSP 冒烟全过(' + okN + '/3)' : '❌ 有失败(' + okN + '/3)')
process.exit(okN === SERVERS.length ? 0 : 1)
