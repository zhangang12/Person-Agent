// HTTP 抓包 MCP 自测：起一个目标服务 + 通过代理发请求，验证捕获/查询。用法： node mcp/httpcap-selftest.mjs
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

// 目标服务：回显请求体
const target = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, youSent: b })) }) })
await new Promise((r) => target.listen(0, '127.0.0.1', r))
const tport = target.address().port

// MCP 服务（stdio）
const srv = spawn(process.execPath, [path.join(__dirname, 'httpcap-mcp.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''; const waiters = new Map(); let id = 0
srv.stdout.setEncoding('utf8')
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } } })
const req = (method, params, timeout = 15000) => { const myId = ++id; return new Promise((res, rej) => { const to = setTimeout(() => { waiters.delete(myId); rej(new Error('超时 ' + method)) }, timeout); waiters.set(myId, (m) => { clearTimeout(to); res(m) }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n') }) }
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

try {
  const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  ok(init.result?.serverInfo?.name === 'tianshu-httpcap', 'initialize 返回 serverInfo')
  notify('notifications/initialized')
  const list = await req('tools/list')
  ok(list.result?.tools?.some((t) => t.name === 'httpcap_start'), 'tools/list 含 httpcap_start（' + (list.result?.tools?.length || 0) + ' 个）')

  const start = await req('tools/call', { name: 'httpcap_start', arguments: {} })
  const pport = Number((String(start.result?.content?.[0]?.text).match(/127\.0\.0\.1:(\d+)/) || [])[1])
  ok(pport > 0, '代理启动，端口 ' + pport)

  // 通过代理 POST 到目标
  const respBody = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: pport, method: 'POST', path: 'http://127.0.0.1:' + tport + '/api/credit?x=1', headers: { Host: '127.0.0.1:' + tport, 'content-type': 'text/plain' } }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(b)) })
    r.on('error', reject); r.write('PING_BODY'); r.end()
  })
  ok(/"ok":true/.test(respBody), '经代理转发成功(客户端收到响应)')
  await sleep(200)
  const ls = await req('tools/call', { name: 'httpcap_list', arguments: {} })
  const lt = ls.result?.content?.[0]?.text || ''
  ok(/\/api\/credit/.test(lt), 'list 捕获到 /api/credit')
  const cid = Number((lt.match(/#(\d+)/) || [])[1])
  const det = await req('tools/call', { name: 'httpcap_get', arguments: { id: cid } })
  const dt = det.result?.content?.[0]?.text || ''
  ok(/PING_BODY/.test(dt), 'get 含请求体 PING_BODY')
  ok(/"ok":true/.test(dt), 'get 含响应体 ok:true')
  await req('tools/call', { name: 'httpcap_stop', arguments: {} })
} catch (e) { console.error('selftest error:', e.message); fail++ }

console.log(`\n小结：${pass} 通过 / ${fail} 失败`)
try { srv.stdin.end() } catch {}; srv.kill(); target.close()
process.exit(fail ? 1 : 0)
