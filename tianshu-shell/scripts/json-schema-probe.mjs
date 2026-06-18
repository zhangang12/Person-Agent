// 天枢 · 结构化输出(json_schema)支持探针
// 目的：确认 bocomcode / opencode 的 POST /session/:id/message 是否支持「强制结构化输出」，
//      以及到底吃哪种字段形状（不同版本不一样）。动态编排的 Planner 想稳定吐"任务图"就靠它。
// 用法： node scripts/json-schema-probe.mjs [baseURL]   （默认 http://127.0.0.1:4096）
//   内网先起一个 serve：  bocomcode serve --port 4096 --hostname 127.0.0.1
//   然后另开一个窗口跑本脚本，把整段输出贴回来即可。
// 零依赖：仅用 Node 内置 fetch（Node 18+）。会真实调用模型若干次（用的是极短提示）。

const BASE = process.argv[2] || 'http://127.0.0.1:4096'
const isHTML = (t) => /<!doctype html>/i.test(t || '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 目标 schema：要求输出 { tasks: [ {id, goal}, ... ] }
const schema = {
  type: 'object', additionalProperties: false,
  properties: { tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, goal: { type: 'string' } }, required: ['id', 'goal'] } } },
  required: ['tasks'],
}
// 故意不在提示里要求 JSON —— 这样只有"格式被真正强制"时才会冒出 JSON，能区分"支持 vs 被忽略"
const PROMPT = '用一句话介绍你自己。'

// 候选字段形状（哪种被接受、哪种 400，报错本身就会暴露正确字段名）
const VARIANTS = [
  ['A. format:{type:json_schema, schema}', (p) => ({ parts: p, format: { type: 'json_schema', schema } })],
  ['B. format:{type:json_schema, json_schema:{name,schema}}', (p) => ({ parts: p, format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema } } })],
  ['C. format:{type:json, schema}', (p) => ({ parts: p, format: { type: 'json', schema } })],
  ['D. format:"json" (字符串)', (p) => ({ parts: p, format: 'json' })],
  ['E. response_format (OpenAI 透传)', (p) => ({ parts: p, response_format: { type: 'json_schema', json_schema: { name: 'plan', schema } } })],
]

async function api(method, path, body, ms = 180000) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ms),
  })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, text, json }
}
// 递归捞出所有 {type:'text', text} 片段（响应外壳各版本不一，深搜最稳），并剔除回显的用户提示
function extractText(j, exclude) {
  const out = []
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) return o.forEach(walk)
    if (o.type === 'text' && typeof o.text === 'string') out.push(o.text)
    for (const k in o) walk(o[k])
  }
  walk(j)
  return out.map((s) => s.trim()).filter((s) => s && s !== exclude).join('\n').trim()
}
function tryJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim()
  try { return JSON.parse(t) } catch {}
  const brace = t.match(/\{[\s\S]*\}/); if (brace) { try { return JSON.parse(brace[0]) } catch {} }
  return null
}
// 发消息 + 同时听 /event 把流式回复收回来（format 请求的结果走流，不在 POST 响应里）
async function runWithStream(sid, body, ms = 30000) {
  const ac = new AbortController()
  const buf = {}
  let last = Date.now()
  const loop = (async () => {
    let res; try { res = await fetch(BASE + '/event', { signal: ac.signal }) } catch { return }
    if (!res.ok || !res.body) return
    const reader = res.body.getReader(); const dec = new TextDecoder(); let acc = ''
    for (;;) {
      let c; try { c = await reader.read() } catch { break }
      if (c.done) break
      acc += dec.decode(c.value, { stream: true })
      let i
      while ((i = acc.indexOf('\n\n')) !== -1) {
        const raw = acc.slice(0, i); acc = acc.slice(i + 2)
        const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
        if (!data) continue
        let ev; try { ev = JSON.parse(data) } catch { continue }
        const p = ev.properties || ev.data || ev; const type = ev.type || ''
        if (type.includes('part')) {
          const part = p.part || p
          if (part && part.type === 'text' && typeof part.text === 'string') {
            const ssid = p.sessionID || p.sessionId || part.sessionID
            if (!ssid || ssid === sid) { buf[part.id || part.partID || 'x'] = part.text; last = Date.now() }
          }
        }
      }
    }
  })()
  await sleep(350)
  let postStatus = 0, postText = ''
  try { const r = await api('POST', `/session/${sid}/message`, body); postStatus = r.status; postText = r.text } catch (e) { postStatus = -1; postText = String(e.message) }
  const fin = async () => { ac.abort(); await loop.catch(() => {}) }
  // 非 2xx（如 400 字段被拒）→ 不用等流，立刻返回
  if (postStatus < 200 || postStatus >= 300) { await fin(); return { postStatus, postText, streamed: '' } }
  const postAt = Date.now()
  while (Date.now() - postAt < ms) {
    await sleep(300)
    const got = Object.values(buf).join('\n').trim()
    if (got && Date.now() - last > 3000) break              // 收到文本后静默 3s = 这轮答完
    if (!got && Date.now() - postAt > 8000) break            // POST 后 8s 没任何流事件 = 无输出/不支持，别空等 40s
  }
  await fin()
  return { postStatus, postText, streamed: Object.values(buf).filter((t) => t.trim() !== PROMPT).join('\n').trim() }
}
const safeJson = (t) => { try { return JSON.parse(t) } catch { return null } }
const sidOf = (j) => j && (j.id || (j.data && j.data.id) || (j.info && j.info.id))
async function newSession(title) { try { return sidOf((await api('POST', '/session', { title })).json) } catch { return null } }
async function del(sid) { try { await api('DELETE', `/session/${sid}`) } catch {} }
const snip = (s, n = 240) => (s || '').replace(/\s+/g, ' ').slice(0, n)

async function main() {
  console.log('== json_schema 结构化输出探针 ==')
  console.log('target:', BASE)
  // 健康 + 版本
  try {
    const h = await api('GET', '/global/health')
    if (h.status !== 200) { console.log('✗ serve 没起来 (status ' + h.status + ')'); process.exit(2) }
    console.log('serve version:', (h.json && h.json.version) || '?', '\n')
  } catch (e) { console.log('✗ 连不上 serve：' + e.message + '\n先跑： bocomcode serve --port 4096'); process.exit(2) }

  // 0) 基线：不带 format，确认正常是自由文本（不是 JSON）
  let baseIsProse = null
  const cs = await newSession('probe-control')
  if (cs) {
    const r = await runWithStream(cs, { parts: [{ type: 'text', text: PROMPT }] })
    const t = r.streamed || extractText(safeJson(r.postText), PROMPT)
    baseIsProse = !tryJson(t)
    console.log('0) 基线(无 format)  POST=' + r.postStatus + '  ' + (baseIsProse ? '自由文本(符合预期)' : '本来就吐JSON?'))
    console.log('   ↳ ' + snip(t, 160) + '\n')
    await del(cs)
  }

  // A~E：逐个形状试
  const rows = []
  for (const [name, mk] of VARIANTS) {
    const sid = await newSession('probe-' + name.slice(0, 1))
    if (!sid) { rows.push([name, 'no-session', '', false, false]); continue }
    const r = await runWithStream(sid, mk([{ type: 'text', text: PROMPT }]))
    if (isHTML(r.postText)) { rows.push([name, 'HTML', '端点返回网页', false, false]); await del(sid); continue }
    if (r.postStatus === 400) { rows.push([name, '400', snip(r.postText), false, false]); await del(sid); continue }
    if (r.postStatus < 200 || r.postStatus >= 300) { rows.push([name, String(r.postStatus), snip(r.postText), false, false]); await del(sid); continue }
    const t = r.streamed || extractText(safeJson(r.postText), PROMPT)
    const parsed = tryJson(t)
    const matches = !!(parsed && Array.isArray(parsed.tasks))
    rows.push([name, t ? '200' : '200·空', t ? snip(t, 200) : '(字段被接受，但模型未产出任何文本——多半该模型/通道不支持强制结构化输出)', !!parsed, matches])
    await del(sid)
  }

  console.log('各字段形状结果：')
  for (const [name, status, detail, parsed, matches] of rows) {
    const mark = matches ? '✅强制JSON'
      : status === '400' ? '⛔400(字段被拒)'
      : status === '200·空' ? '⚠️字段被接受·模型无输出'
      : parsed ? '◐JSON但不合schema'
      : '○被忽略/自由文本'
    console.log(`\n  [${status}] ${name}  → ${mark}`)
    if (detail) console.log('     ↳ ' + detail)
  }

  // 判定
  const ok = rows.find((x) => x[4])
  const partial = rows.find((x) => x[3])
  const accepted = rows.find((x) => String(x[1]).startsWith('200'))   // 字段被接受(含 200·空)
  console.log('\n—— 判定 ——')
  if (ok) console.log('✅ 端到端支持结构化输出。可用形状：「' + ok[0] + '」。动态编排 Planner 直接用它即可。')
  else if (partial) console.log('◐ 模型会吐 JSON 但未严格按 schema —— 可用，但需「容错解析 + 失败重试」兜底。')
  else if (accepted) console.log('△ 字段形状「' + accepted[0] + '」被接受(其余 400)，但该模型这次未真正产出结构化输出。\n   多半是当前模型/通道不支持强制结构化输出。→ 先用「提示要求只输出 JSON + 容错解析 + 重试」兜底；换内网模型再跑本探针，看是否更好。')
  else console.log('○ 未观察到强制结构化输出（字段被拒或无效）。→ 用「提示要求只输出 JSON + 容错解析 + 重试」兜底，动态编排照样能做。')
  console.log('（把以上整段贴回来，我据此定 Planner 的取数方式。）')
  process.exit(0)
}
main().catch((e) => { console.error('probe error:', e); process.exit(2) })
