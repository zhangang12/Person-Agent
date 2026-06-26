// BocomHermes · 按请求切模型(方案B)探针 —— 多模态线的命门
// 目的：确认 bocomcode/opencode 的 POST /session/:id/message 能不能【按单次请求】把模型切到指定模型(如 Qwen 多模态)，
//      以及到底吃哪种字段形状(不同版本不一样)。需求分析里"图走 Qwen、文字走 MiniMax"全靠它。
// 用法： node scripts/model-route-probe.mjs [baseURL] [目标modelID关键词]
//   默认 baseURL=http://127.0.0.1:4096，目标关键词=qwen
//   内网先起 serve： bocomcode serve --port 4096 --hostname 127.0.0.1
//   然后另开窗口跑本脚本，把整段输出贴回来。
// 零依赖：仅 Node 内置 fetch(Node 18+)。会真实调用模型几次(极短提示)。

const BASE = process.argv[2] || 'http://127.0.0.1:4096'
const WANT = (process.argv[3] || 'qwen').toLowerCase()
const isHTML = (t) => /<!doctype html>/i.test(t || '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const snip = (s, n = 200) => (s || '').replace(/\s+/g, ' ').slice(0, n)

const PROMPT = '你是哪个大模型？只回模型名称，不要别的。'

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
const safeJson = (t) => { try { return JSON.parse(t) } catch { return null } }
const sidOf = (j) => j && (j.id || (j.data && j.data.id) || (j.info && j.info.id))
async function newSession(title) { try { return sidOf((await api('POST', '/session', { title })).json) } catch { return null } }
async function del(sid) { try { await api('DELETE', `/session/${sid}`) } catch {} }

// 深搜：捞所有 {type:'text', text} 片段
function extractText(j, exclude) {
  const out = []
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (o.type === 'text' && typeof o.text === 'string') out.push(o.text); for (const k in o) walk(o[k]) }
  walk(j); return out.map((s) => s.trim()).filter((s) => s && s !== exclude).join('\n').trim()
}
// 深搜：捞所有像"模型标识"的值(键名含 model/provider 的字符串)——serve 回报用了哪个模型，这是最硬的判据
function captureModels(j) {
  const out = new Set()
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) return o.forEach(walk)
    for (const k in o) {
      const v = o[k]
      if (typeof v === 'string' && /^(modelid|model|providerid|provider)$/i.test(k) && v && v.length < 80) out.add(k + '=' + v)
      else walk(v)
    }
  }
  walk(j); return [...out]
}

// 发消息 + 听 /event：收回流式文本，并把事件里出现的"模型标识"一并捞出
async function runCapture(sid, body, ms = 30000) {
  const ac = new AbortController()
  const buf = {}; const models = new Set(); let last = Date.now()
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
        captureModels(ev).forEach((m) => models.add(m))
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
  captureModels(safeJson(postText)).forEach((m) => models.add(m))
  const fin = async () => { ac.abort(); await loop.catch(() => {}) }
  if (postStatus < 200 || postStatus >= 300) { await fin(); return { postStatus, postText, streamed: '', models: [...models] } }
  const postAt = Date.now()
  while (Date.now() - postAt < ms) {
    await sleep(300)
    const got = Object.values(buf).join('\n').trim()
    if (got && Date.now() - last > 3000) break
    if (!got && Date.now() - postAt > 8000) break
  }
  await fin()
  return { postStatus, postText, streamed: Object.values(buf).filter((t) => t.trim() !== PROMPT).join('\n').trim(), models: [...models] }
}

// 从 /provider 解析出可用 {providerID, modelID, full}
function parseModels(j) {
  const list = []
  const provs = (j && (j.all || j.providers || (Array.isArray(j) ? j : null))) || []
  for (const pr of provs) {
    const pid = pr.id || pr.providerID || pr.name || '?'
    const ms = pr.models || pr.model || {}
    if (Array.isArray(ms)) for (const m of ms) { const mid = m.id || m.modelID || m.name; if (mid) list.push({ providerID: pid, modelID: mid, full: pid + '/' + mid }) }
    else for (const mid in ms) list.push({ providerID: pid, modelID: mid, full: pid + '/' + mid })
  }
  return list
}

async function main() {
  console.log('== 按请求切模型(方案B)探针 ==')
  console.log('target serve:', BASE, ' 找的目标模型关键词:', WANT)
  try {
    const h = await api('GET', '/global/health')
    if (h.status !== 200) { console.log('✗ serve 没起来 (status ' + h.status + ')'); process.exit(2) }
    console.log('serve version:', (h.json && h.json.version) || '?')
  } catch (e) { console.log('✗ 连不上 serve：' + e.message + '\n先跑： bocomcode serve --port 4096'); process.exit(2) }

  const prov = await api('GET', '/provider')
  const models = parseModels(prov.json)
  if (!models.length) { console.log('✗ /provider 没解析出模型，原文：', snip(prov.text, 300)); process.exit(2) }
  console.log('\n可用模型：'); models.forEach((m) => console.log('  · ' + m.full))
  const target = models.find((m) => m.full.toLowerCase().includes(WANT)) || models[models.length - 1]
  console.log('\n→ 选定目标模型：' + target.full + (target.full.toLowerCase().includes(WANT) ? '' : '（没匹配到关键词，退而取最后一个，多模态可改第二个参数）'))

  // 0) 基线：不带 model，看默认模型回报
  const cs = await newSession('mroute-base')
  const base = cs ? await runCapture(cs, { parts: [{ type: 'text', text: PROMPT }] }) : { models: [], streamed: '' }
  if (cs) await del(cs)
  console.log('\n0) 基线(无 model 字段)  POST=' + base.postStatus)
  console.log('   serve 回报模型：' + (base.models.join(' , ') || '(未暴露 model 元数据)'))
  console.log('   自报：' + snip(base.streamed, 120))

  const VARIANTS = [
    ['A. model:"prov/model" 字符串', (p) => ({ parts: p, model: target.full })],
    ['B. model:{providerID,modelID}', (p) => ({ parts: p, model: { providerID: target.providerID, modelID: target.modelID } })],
    ['C. providerID+modelID 顶层', (p) => ({ parts: p, providerID: target.providerID, modelID: target.modelID })],
    ['D. model:"modelID" 裸', (p) => ({ parts: p, model: target.modelID })],
  ]

  const baseSet = new Set(base.models)
  const rows = []
  for (const [name, mk] of VARIANTS) {
    const sid = await newSession('mroute-' + name.slice(0, 1))
    if (!sid) { rows.push([name, 'no-session', '', false]); continue }
    const r = await runCapture(sid, mk([{ type: 'text', text: PROMPT }]))
    await del(sid)
    if (isHTML(r.postText)) { rows.push([name, 'HTML', '端点返回网页', false]); continue }
    if (r.postStatus < 200 || r.postStatus >= 300) { rows.push([name, String(r.postStatus), snip(r.postText), false]); continue }
    // 切换证据：serve 回报里出现了目标 modelID（基线里没有），或自报名称含目标关键词
    const reportsTarget = r.models.some((m) => m.toLowerCase().includes(target.modelID.toLowerCase()) && !baseSet.has(m))
    const selfTarget = r.streamed.toLowerCase().includes(target.modelID.toLowerCase()) || r.streamed.toLowerCase().includes(WANT)
    const switched = reportsTarget || selfTarget
    rows.push([name, '200', '回报[' + (r.models.join(',') || '无') + '] 自报[' + snip(r.streamed, 60) + ']', switched])
  }

  console.log('\n各字段形状结果：')
  for (const [name, status, detail, switched] of rows) {
    const mark = switched ? '✅切到了目标模型' : status === '200' ? '◐被接受但没看到切换证据' : status === '400' ? '⛔400(字段被拒)' : '○' + status
    console.log(`\n  [${status}] ${name} → ${mark}`)
    if (detail) console.log('     ↳ ' + detail)
  }

  const win = rows.find((x) => x[3])
  const accepted = rows.find((x) => x[1] === '200')
  console.log('\n—— 判定 ——')
  if (win) console.log('✅ 能按请求切模型。可用形状：「' + win[0] + '」。\n   → 需求分析里 Qwen 读图就用它：sendMessage 带上 model=' + target.full + '，引擎其余请求不带(走默认 MiniMax)。')
  else if (accepted) console.log('◐ model 字段被接受(200)但没看到"换了模型"的硬证据(serve 可能没暴露 model 元数据，模型也没自报准)。\n   → 建议：内网用两个明显不同的模型再跑一次(第二参数换成另一个 modelID 关键词)，看自报是否随之变；若仍无证据，退而用"给 Qwen 单独起一个 serve/会话"的办法。')
  else console.log('○ 没有任何形状被接受/生效(多半都 400)。\n   → 按请求切模型这条走不通。多模态改走：给 Qwen 单独配一个 serve(opencode 侧把该目录默认模型设成 Qwen)，图片识别打到那个 serve；或读图工序人工切。')
  console.log('（把以上整段贴回来，我据此定多模态线怎么接。）')
  process.exit(0)
}
main().catch((e) => { console.error('probe error:', e); process.exit(2) })
