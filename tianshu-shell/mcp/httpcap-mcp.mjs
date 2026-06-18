// 天枢 · HTTP 抓包 MCP（本地 stdio 服务，零依赖）
// 给 agent 扩能：起一个本地 HTTP 正向代理，捕获经过它的 HTTP 请求/响应，供 agent 查询与分析。
// 只抓 HTTP（内网开发环境无 HTTPS）；遇到 HTTPS(CONNECT) 仅盲隧道放行、不解析。数据不出网（全程本机转发）。
// 用法：被测程序/浏览器把 HTTP 代理指向本代理地址即可。注册见 mcp/README.md。
import http from 'node:http'
import net from 'node:net'

const log = (...a) => process.stderr.write('[httpcap-mcp] ' + a.join(' ') + '\n')
const CAP = 64 * 1024, MAX = 800
let proxy = null, proxyPort = 0, seq = 0
const store = []
const pushRec = (r) => { store.push(r); if (store.length > MAX) store.shift() }
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…(截断)' : s }

function startProxy(port) {
  return new Promise((resolve, reject) => {
    if (proxy) return resolve(proxyPort)
    const srv = http.createServer((creq, cres) => {
      let u; try { u = new URL(creq.url) } catch { cres.writeHead(400); return cres.end('请把本服务当作 HTTP 代理使用（请求行需为绝对 URL）') }
      if (u.protocol !== 'http:') { cres.writeHead(400); return cres.end('只支持 http') }
      const id = ++seq, t0 = Date.now()
      const rec = { id, ts: Date.now(), method: creq.method, url: creq.url, host: u.host, path: u.pathname + u.search, reqHeaders: creq.headers, reqBody: '', status: 0, respHeaders: {}, respBody: '', ms: 0 }
      const rbuf = []; let rlen = 0
      creq.on('data', (c) => { if (rlen < CAP) { rbuf.push(c); rlen += c.length } })
      creq.on('end', () => { rec.reqBody = clip(Buffer.concat(rbuf).toString('utf8'), CAP) })
      const preq = http.request({ host: u.hostname, port: u.port || 80, method: creq.method, path: u.pathname + u.search, headers: creq.headers }, (pres) => {
        rec.status = pres.statusCode; rec.respHeaders = pres.headers
        const pbuf = []; let plen = 0
        pres.on('data', (c) => { if (plen < CAP) { pbuf.push(c); plen += c.length } })
        pres.on('end', () => { rec.respBody = clip(Buffer.concat(pbuf).toString('utf8'), CAP); rec.ms = Date.now() - t0; pushRec(rec) })
        try { cres.writeHead(pres.statusCode || 502, pres.headers) } catch {}
        pres.pipe(cres)
      })
      preq.on('error', (e) => { rec.error = e.message; rec.ms = Date.now() - t0; pushRec(rec); try { cres.writeHead(502) } catch {}; cres.end('proxy error: ' + e.message) })
      creq.pipe(preq)
    })
    // HTTPS：盲隧道放行，不解析（内网开发环境一般用不到）
    srv.on('connect', (req, sock, head) => {
      const m = String(req.url).split(':'); const s = net.connect(+m[1] || 443, m[0], () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); s.write(head); s.pipe(sock); sock.pipe(s) })
      s.on('error', () => sock.destroy()); sock.on('error', () => s.destroy())
    })
    srv.on('error', reject)
    srv.listen(port || 0, '127.0.0.1', () => { proxy = srv; proxyPort = srv.address().port; log('proxy on ' + proxyPort); resolve(proxyPort) })
  })
}
function stopProxy() { if (proxy) { try { proxy.close() } catch {}; proxy = null; proxyPort = 0 } }

const TOOLS = [
  { name: 'httpcap_start', description: '启动本地 HTTP 抓包代理，返回代理地址；把被测程序/浏览器的 HTTP 代理指向它即可开始捕获', inputSchema: { type: 'object', properties: { port: { type: 'number', description: '可选固定端口，省略=自动选空闲口' } } } },
  { name: 'httpcap_list', description: '列出已捕获的 HTTP 请求(最近在前)', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, urlContains: { type: 'string' }, method: { type: 'string' }, status: { type: 'number' } } } },
  { name: 'httpcap_get', description: '查看某条请求的完整详情(请求头/体、响应头/体)', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'httpcap_clear', description: '清空已捕获记录', inputSchema: { type: 'object', properties: {} } },
  { name: 'httpcap_stop', description: '停止代理', inputSchema: { type: 'object', properties: {} } },
  { name: 'httpcap_status', description: '代理状态(是否运行/端口/已捕获数)', inputSchema: { type: 'object', properties: {} } },
]

function filterList(a) {
  let r = store.slice().reverse()
  if (a.method) r = r.filter((x) => (x.method || '').toUpperCase() === String(a.method).toUpperCase())
  if (a.status) r = r.filter((x) => x.status === a.status)
  if (a.urlContains) r = r.filter((x) => (x.url || '').includes(a.urlContains))
  return r.slice(0, a.limit || 50)
}
const hdrs = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n')

async function callTool(name, a) {
  a = a || {}
  if (name === 'httpcap_start') { const p = await startProxy(a.port); return `抓包代理已启动：http://127.0.0.1:${p}\n把被测程序/浏览器的 HTTP 代理设为该地址（如 Java: -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${p}），随后用 httpcap_list 查看。` }
  if (name === 'httpcap_status') return proxy ? `运行中，端口 ${proxyPort}，已捕获 ${store.length} 条` : '未运行（先用 httpcap_start）'
  if (name === 'httpcap_clear') { store.length = 0; return '已清空' }
  if (name === 'httpcap_stop') { stopProxy(); return '已停止代理' }
  if (name === 'httpcap_list') {
    const r = filterList(a)
    if (!r.length) return proxy ? '（暂无捕获。确认被测程序已把 HTTP 代理指向 127.0.0.1:' + proxyPort + '）' : '（代理未启动）'
    return r.map((x) => `#${x.id} ${x.method} ${x.status || '-'} ${x.ms}ms ${x.url}`).join('\n')
  }
  if (name === 'httpcap_get') {
    const x = store.find((e) => e.id === Number(a.id)); if (!x) return '没有这条记录：' + a.id
    return [
      `#${x.id} ${x.method} ${x.url}  → ${x.status} (${x.ms}ms)${x.error ? ' 错误:' + x.error : ''}`,
      '── 请求头 ──', hdrs(x.reqHeaders),
      x.reqBody ? '── 请求体 ──\n' + x.reqBody : '',
      '── 响应头 ──', hdrs(x.respHeaders),
      x.respBody ? '── 响应体 ──\n' + x.respBody : '',
    ].filter(Boolean).join('\n')
  }
  throw new Error('未知工具：' + name)
}

// ---------- MCP stdio 协议 ----------
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'BocomHermes-httpcap', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '工具出错：' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现：' + method } })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle error', e && e.message)) } })
process.on('exit', stopProxy); process.on('SIGTERM', () => { stopProxy(); process.exit(0) }); process.on('SIGINT', () => { stopProxy(); process.exit(0) })
log('ready')
