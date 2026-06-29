// 诊断"无文本输出"：发一句话，把原始响应（含 session 创建、状态、body 长度、前 2000 字）完整打出来，
// 再模拟 extractText。防挂死：/event 抓取 unref + 全程兜底 process.exit。
// 零依赖，内网直接跑：
//   node scripts/text-output-probe.mjs [port] [项目目录]
//   例：node scripts/text-output-probe.mjs 4096 D:/code/yourproject
// 把整段输出贴回来。
import http from 'node:http'

const PORT = process.argv[2] || '4096'
const DIR = (process.argv[3] || '').replace(/\\/g, '/')
const HOST = '127.0.0.1'
const line = (s) => console.log(s)

// 硬保险：到时间强制退出，绝不卡住
setTimeout(() => { line('\n[硬超时退出]'); process.exit(0) }, 200000).unref()

function call(method, path, body, timeout = 150000) {
  return new Promise((resolve) => {
    const d = body ? Buffer.from(JSON.stringify(body)) : null
    const r = http.request({ host: HOST, port: PORT, path, method, headers: { 'content-type': 'application/json', ...(d ? { 'content-length': d.length } : {}) } }, (x) => {
      let b = ''; x.setEncoding('utf8'); x.on('data', (c) => b += c); x.on('end', () => resolve({ status: x.statusCode, body: b, headers: x.headers }))
    })
    r.on('error', (e) => resolve({ status: 'ERR', body: '', err: e.message }))
    r.setTimeout(timeout, () => { r.destroy(); resolve({ status: 'TIMEOUT', body: '', err: timeout + 'ms 没返回' }) })
    if (d) r.write(d); r.end()
  })
}

function tapEvents(store, ms) {
  const req = http.get({ host: HOST, port: PORT, path: '/event' }, (res) => {
    let buf = ''; res.setEncoding('utf8')
    res.on('data', (c) => {
      buf += c; let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
        if (!data) continue
        let ev; try { ev = JSON.parse(data) } catch { continue }
        const type = ev && ev.type || ''
        if (!/part|message|error/.test(type)) continue
        const p = ev.properties || ev.data || ev
        const part = p.part || p
        store.push({ type, partType: part && part.type, partKeys: part ? Object.keys(part) : [], textSample: typeof (part && part.text) === 'string' ? part.text.slice(0, 30) : (typeof p.delta === 'string' ? 'Δ:' + p.delta.slice(0, 20) : null) })
      }
    })
  })
  req.on('error', () => {})
  req.on('socket', (s) => { try { s.unref() } catch {} })   // ← 关键：不让这个长连接挡住进程退出
  setTimeout(() => { try { req.destroy() } catch {} }, ms)
  return req
}

function extractText(msg) {
  const i = msg?.info ?? msg?.data?.info ?? msg
  const parts = msg?.parts ?? msg?.data?.parts ?? i?.parts ?? []
  if (Array.isArray(parts)) return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim()
  return typeof msg === 'string' ? msg : ''
}

;(async () => {
  line('=== 探针 :' + PORT + (DIR ? ' dir=' + DIR : '') + ' ===')
  const h = await call('GET', '/global/health', null, 5000)
  line('health: ' + h.status + (h.err ? ' (' + h.err + ')' : ''))
  if (String(h.status)[0] !== '2') { line('serve 不在 :' + PORT + '，换端口重试'); process.exit(0) }

  const q = DIR ? ('?directory=' + encodeURIComponent(DIR)) : ''
  const s = await call('POST', '/session' + q, { title: 'text-probe' }, 20000)
  line('\n--- 建会话: status=' + s.status + ' len=' + s.body.length)
  line('  body: ' + s.body.slice(0, 300))
  let sid; try { sid = JSON.parse(s.body).id } catch {}
  if (!sid) { line('没拿到 session id，停'); process.exit(0) }
  line('  session: ' + sid)

  const evStore = []
  tapEvents(evStore, 120000)
  await new Promise((r) => setTimeout(r, 300))

  line('\n发消息(等模型，最多 150 秒)…')
  const m = await call('POST', '/session/' + sid + '/message', { parts: [{ type: 'text', text: '只回复两个字：你好' }] }, 150000)

  line('\n--- 消息响应: status=' + m.status + (m.err ? ' (' + m.err + ')' : '') + ' · content-type=' + (m.headers && m.headers['content-type'] || '?') + ' · body 长度=' + m.body.length)
  line('--- body 原始(前 2000 字):')
  line(m.body.slice(0, 2000) || '(空)')

  let resp; try { resp = JSON.parse(m.body) } catch (e) { resp = null; line('\n[body 不是合法 JSON：' + e.message + ']') }
  if (resp) {
    const info = resp.info || resp.data?.info || {}
    line('\n--- model: ' + (info.modelID || '?') + '/' + (info.providerID || '?') + ' · finish: ' + (info.finish || '?'))
    if (info.error || resp.error) line('--- error: ' + JSON.stringify(info.error || resp.error).slice(0, 300))
    const parts = resp.parts || resp.data?.parts || info.parts || []
    line('--- 最终 parts (' + parts.length + '):')
    parts.forEach((p, i) => line('  [' + i + '] type=' + p.type + ' keys=' + Object.keys(p).join(',') + ' text=' + (typeof p.text === 'string' ? JSON.stringify(p.text.slice(0, 40)) : '(无)')))
    const ex = extractText(resp)
    line('--- extractText: ' + JSON.stringify(ex) + '  → ' + (ex ? '✅ 有文本' : '❌ 空，这就是"无文本输出"'))
  }

  await new Promise((r) => setTimeout(r, 500))
  line('\n--- /event part 事件样本 (' + evStore.length + ' 条):')
  const seen = new Set()
  for (const e of evStore) { const k = e.type + '|' + e.partType; if (seen.has(k)) continue; seen.add(k); line('  type=' + e.type + ' partType=' + e.partType + ' keys=[' + e.partKeys.join(',') + ']' + (e.textSample ? ' ' + e.textSample : '')) }
  process.exit(0)
})()
