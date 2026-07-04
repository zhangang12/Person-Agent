'use strict'
// HTTP 抓包核心(GUI 版,与 mcp/httpcap-mcp.mjs 同源逻辑):本地 HTTP 正向代理,
// 捕获经过的请求/响应供面板查看。只抓 HTTP;HTTPS(CONNECT) 盲隧道放行不解析。
// 用法:把被测程序(柜面客户端/curl/浏览器)的 HTTP 代理指向返回的地址。数据不出网(全程本机转发)。
const http = require('http')
const net = require('net')

module.exports = function initHttpcap({ log }) {
  const CAP = 64 * 1024, MAX = 800
  let proxy = null, proxyPort = 0, seq = 0, onAdd = null
  const store = []
  const pushRec = (r) => { store.push(r); if (store.length > MAX) store.shift(); try { onAdd && onAdd(summarize(r)) } catch {} }
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…(截断)' : s }
  const summarize = (r) => ({ id: r.id, ts: r.ts, method: r.method, host: r.host, path: r.path, status: r.status, ms: r.ms, error: r.error || '' })

  function start(port) {
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
      // HTTPS:盲隧道放行,不解析(内网开发环境一般用不到;明确不做 MITM)
      srv.on('connect', (req, sock, head) => {
        const m = String(req.url).split(':'); const s = net.connect(+m[1] || 443, m[0], () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); s.write(head); s.pipe(sock); sock.pipe(s) })
        s.on('error', () => sock.destroy()); sock.on('error', () => s.destroy())
      })
      srv.on('error', reject)
      srv.listen(port || 0, '127.0.0.1', () => { proxy = srv; proxyPort = srv.address().port; log('httpcap proxy on :' + proxyPort); resolve(proxyPort) })
    })
  }
  function stop() { if (proxy) { try { proxy.close() } catch {}; proxy = null; proxyPort = 0; log('httpcap proxy stopped') } }
  function status() { return { running: !!proxy, port: proxyPort, captured: store.length } }
  function list(a) {
    a = a || {}
    let r = store.slice().reverse()
    if (a.method) r = r.filter((x) => (x.method || '').toUpperCase() === String(a.method).toUpperCase())
    if (a.status) r = r.filter((x) => x.status === +a.status)
    if (a.urlContains) { const k = String(a.urlContains).toLowerCase(); r = r.filter((x) => (x.url || '').toLowerCase().includes(k)) }
    return r.slice(0, Math.min(+a.limit || 200, 500)).map(summarize)
  }
  function get(id) { return store.find((x) => x.id === +id) || null }
  function clear() { store.length = 0 }
  function setOnAdd(fn) { onAdd = fn }

  return { start, stop, status, list, get, clear, setOnAdd }
}
