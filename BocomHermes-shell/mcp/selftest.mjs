// 浏览器 MCP 自测：通过 stdio 跑 MCP 协议握手 + 真浏览器导航/取文本/执行JS。
// 用法： node mcp/selftest.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srv = spawn(process.execPath, [path.join(__dirname, 'browser-mcp.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''; const waiters = new Map(); let id = 0
srv.stdout.setEncoding('utf8')
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } } })
const req = (method, params, timeout = 30000) => { const myId = ++id; return new Promise((res, rej) => { const to = setTimeout(() => { waiters.delete(myId); rej(new Error('超时 ' + method)) }, timeout); waiters.set(myId, (m) => { clearTimeout(to); res(m) }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n') }) }
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

try {
  const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  ok(init.result?.serverInfo?.name === 'BocomHermes-browser', 'initialize 返回 serverInfo')
  notify('notifications/initialized')
  const list = await req('tools/list')
  ok(Array.isArray(list.result?.tools) && list.result.tools.some((t) => t.name === 'browser_navigate'), 'tools/list 含 browser_navigate（' + (list.result?.tools?.length || 0) + ' 个工具）')

  const html = 'data:text/html,' + encodeURIComponent('<title>TS-OK</title><body><h1 id=h>HELLO_BOCOMHERMES</h1>')
  const nav = await req('tools/call', { name: 'browser_navigate', arguments: { url: html } }, 60000)
  const navText = nav.result?.content?.[0]?.text || ''
  if (nav.result?.isError) {
    console.log('  ! 浏览器不可用（MCP 协议已通过，运行时需 Edge/Chrome + Node22+）：' + navText.replace(/\n/g, ' '))
  } else {
    ok(/TS-OK/.test(navText), 'navigate 返回标题（' + navText.replace(/\n/g, ' ') + '）')
    const txt = await req('tools/call', { name: 'browser_get_text', arguments: {} }, 20000)
    ok(/HELLO_BOCOMHERMES/.test(txt.result?.content?.[0]?.text || ''), 'get_text 取到正文')
    const ev = await req('tools/call', { name: 'browser_eval', arguments: { expression: 'document.querySelector("#h").id' } }, 20000)
    ok((ev.result?.content?.[0]?.text || '') === 'h', 'eval 返回元素 id')
    await req('tools/call', { name: 'browser_close', arguments: {} }, 10000)
  }
} catch (e) { console.error('selftest error:', e.message); fail++ }

console.log(`\n小结：${pass} 通过 / ${fail} 失败`)
try { srv.stdin.end() } catch {}
srv.kill()
process.exit(fail ? 1 : 0)
