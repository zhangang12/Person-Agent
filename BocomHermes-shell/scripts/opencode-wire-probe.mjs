// 全量抓 opencode/bocomcode serve 的报文格式：把一次对话的所有 wire 数据落到文件 + 控制台摘要。
// 抓：① POST /message 完整响应(status/headers/content-type/body) ② /event 每条事件完整 JSON
//     ③ 完成后 GET /session/:id/message 组装结构 ④ session 对象 ⑤ /config/providers 模型列表
// 零依赖，内网直接跑：
//   node scripts/opencode-wire-probe.mjs [port] [项目目录]
// 跑完把控制台摘要贴回来；要更细就把生成的 opencode-wire-dump.txt 发我。
import http from 'node:http'
import fs from 'node:fs'

const PORT = process.argv[2] || '4096'
const DIR = (process.argv[3] || '').replace(/\\/g, '/')
const HOST = '127.0.0.1'
const PROMPT = '用一句话介绍你自己'
const OUT = 'opencode-wire-dump.txt'

fs.writeFileSync(OUT, '')   // 清空
const w = (s) => { try { fs.appendFileSync(OUT, s + '\n') } catch {} }
const log = (s) => { console.log(s); w(s) }
const J = (o) => { try { return JSON.stringify(o) } catch { return String(o) } }
const JP = (o) => { try { return JSON.stringify(o, null, 2) } catch { return String(o) } }

setTimeout(() => { log('\n[硬超时退出]'); process.exit(0) }, 200000).unref()

function call(method, path, body, timeout = 150000) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const d = body ? Buffer.from(JSON.stringify(body)) : null
    const r = http.request({ host: HOST, port: PORT, path, method, headers: { 'content-type': 'application/json', ...(d ? { 'content-length': d.length } : {}) } }, (x) => {
      let b = ''; x.setEncoding('utf8'); x.on('data', (c) => b += c)
      x.on('end', () => resolve({ status: x.statusCode, headers: x.headers, body: b, ms: Date.now() - t0 }))
    })
    r.on('error', (e) => resolve({ status: 'ERR', headers: {}, body: '', err: e.message, ms: Date.now() - t0 }))
    r.setTimeout(timeout, () => { r.destroy(); resolve({ status: 'TIMEOUT', headers: {}, body: '', err: timeout + 'ms', ms: Date.now() - t0 }) })
    if (d) r.write(d); r.end()
  })
}

// 抓 /event：每条事件完整记录（解析后的 JSON）。返回 { events, stop() }
function tapEvents() {
  const events = []
  const t0 = Date.now()
  const req = http.get({ host: HOST, port: PORT, path: '/event' }, (res) => {
    let buf = ''; res.setEncoding('utf8')
    res.on('data', (c) => {
      buf += c; let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
        if (!data) continue
        let ev; try { ev = JSON.parse(data) } catch { events.push({ t: Date.now() - t0, raw: data.slice(0, 500), unparsed: true }); continue }
        events.push({ t: Date.now() - t0, ev })
      }
    })
  })
  req.on('error', () => {})
  req.on('socket', (s) => { try { s.unref() } catch {} })
  return { events, stop: () => { try { req.destroy() } catch {} } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const partTypeOf = (ev) => { const p = ev.properties || ev.data || ev; const part = p.part || p; return part && part.type }

;(async () => {
  log('==================== opencode wire probe ====================')
  log('serve :' + PORT + (DIR ? '  dir=' + DIR : '') + '  @ ' + new Date().toISOString())

  const h = await call('GET', '/global/health', null, 5000)
  log('\n[health] status=' + h.status + ' ms=' + h.ms + ' body=' + h.body.slice(0, 120))
  if (String(h.status)[0] !== '2') { log('serve 不在 :' + PORT + '，换端口'); process.exit(0) }

  // 模型列表（看 providers/models 结构）
  const prov = await call('GET', '/config/providers', null, 10000)
  w('\n[providers raw]\n' + prov.body.slice(0, 4000))
  log('[providers] status=' + prov.status + ' body 长度=' + prov.body.length + '（详见 dump 文件）')

  // 建会话（看 session 对象结构）
  const q = DIR ? ('?directory=' + encodeURIComponent(DIR)) : ''
  const s = await call('POST', '/session' + q, { title: 'wire-probe' }, 20000)
  log('\n[session.create] status=' + s.status + ' ms=' + s.ms)
  log(JP(safeParse(s.body)))
  const sid = (safeParse(s.body) || {}).id
  if (!sid) { log('没拿到 session id，停'); process.exit(0) }

  // 开抓事件
  const tap = tapEvents()
  await sleep(300)

  // 发消息
  log('\n[message.send] prompt=' + J(PROMPT) + '  发送中…')
  const m = await call('POST', '/session/' + sid + '/message', { parts: [{ type: 'text', text: PROMPT }] }, 150000)
  log('[message.resp] status=' + m.status + ' ms=' + m.ms + ' content-type=' + (m.headers['content-type'] || '?') + ' body 长度=' + m.body.length)
  w('\n[message.resp body 完整]\n' + m.body)

  // POST 返回后再多抓一会儿事件（应对非阻塞 serve：内容在 POST 返回后才流完）
  log('[message.resp 后继续抓事件 8 秒，捕获可能的后续流…]')
  await sleep(8000)
  tap.stop()
  const evs = tap.events

  // GET 组装后的消息
  const g = await call('GET', '/session/' + sid + '/message', null, 15000)
  w('\n[GET /message 完整]\n' + g.body)
  log('[GET /message] status=' + g.status + ' body 长度=' + g.body.length)

  // ================= 摘要分析 =================
  log('\n==================== 摘要 ====================')

  // 1) POST body 有没有文本
  const postParsed = safeParse(m.body)
  log('① POST /message body：' + (m.body.length ? '非空(' + m.body.length + '字)' : '【空】') + (postParsed ? ' · 可解析JSON' : (m.body.length ? ' · 非JSON' : '')))
  if (postParsed) log('   POST body 里 parts: ' + summarizeParts(postParsed))

  // 2) 事件类型统计
  const typeCount = {}
  for (const e of evs) { const t = e.ev?.type || (e.unparsed ? '(unparsed)' : '?'); typeCount[t] = (typeCount[t] || 0) + 1 }
  log('② /event 收到 ' + evs.length + ' 条，类型分布：')
  Object.entries(typeCount).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => log('   ' + n + '×  ' + t))

  // 3) 每种 (type|partType) 一个完整样本
  log('③ 每种事件/part 形状各一个完整样本：')
  const seen = new Map()
  for (const e of evs) {
    if (!e.ev) continue
    const key = e.ev.type + '|' + (partTypeOf(e.ev) || '-')
    if (seen.has(key)) continue
    seen.set(key, e.ev)
  }
  for (const [key, ev] of seen) { w('\n--- 样本 ' + key + ' ---\n' + JP(ev)); log('   ' + key + ' （完整样本见 dump 文件）') }

  // 4) 文本到底在哪：part.updated 的 text vs delta
  const textUpd = evs.filter((e) => e.ev && /part/.test(e.ev.type) && partTypeOf(e.ev) === 'text')
  const deltas = evs.filter((e) => e.ev && e.ev.type === 'message.part.delta')
  log('④ 文本载体：')
  log('   text part.updated 事件 ' + textUpd.length + ' 条；其中带非空 .text 的 ' + textUpd.filter((e) => { const p = e.ev.properties || e.ev.data || e.ev; const part = p.part || p; return part && part.text }).length + ' 条')
  log('   message.part.delta 事件 ' + deltas.length + ' 条')
  if (deltas[0]) { const p = deltas[0].ev.properties || deltas[0].ev.data || deltas[0].ev; log('   delta 字段：keys=[' + Object.keys(p).join(',') + '] field=' + J(p.field) + ' delta样本=' + J(String(p.delta || '').slice(0, 30))) }
  // 拼接所有 delta 看是否还原出答案
  const byPart = {}
  for (const e of deltas) { const p = e.ev.properties || e.ev.data || e.ev; const id = p.partID || p.id; if (!id) continue; byPart[id] = (byPart[id] || '') + (p.delta || '') }
  Object.entries(byPart).forEach(([id, txt]) => log('   delta 拼接[' + id + ']: ' + J(txt.slice(0, 80))))

  // 5) GET 组装消息里的文本
  const gParsed = safeParse(g.body)
  if (gParsed) {
    const list = Array.isArray(gParsed) ? gParsed : (gParsed.data || gParsed.messages || [])
    let la = null; for (const mm of list) { const r = mm?.info?.role ?? mm?.role; if (r === 'assistant') la = mm }
    log('⑤ GET /message 最后一条 assistant：' + (la ? summarizeParts(la) : '无') + (la?.info?.finish ? ' · finish=' + la.info.finish : '') + (la?.info?.time?.completed ? ' · completed' : ''))
  }

  log('\n>>> 完整报文已写入: ' + OUT + '  （需要细看就把这个文件发我）')
  process.exit(0)
})()

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }
function summarizeParts(msg) {
  const parts = msg?.parts || msg?.data?.parts || msg?.info?.parts || []
  if (!Array.isArray(parts)) return '(无 parts 数组)'
  return parts.map((p) => p.type + (typeof p.text === 'string' ? '("' + p.text.slice(0, 20).replace(/\n/g, ' ') + '")' : '')).join(', ') || '(空)'
}
