// BocomHermes · serve 兼容自检
// 把它指向 bocomcode 或公网 opencode 的 serve，检查BocomHermes 依赖的 API 特性是否齐备/一致。
// 用法： node scripts/compat-check.mjs [baseURL]   （默认 http://127.0.0.1:4096）
// 在内网对着 bocomcode 跑一遍、在外网对着 opencode 跑一遍，对比两份报告即可发现差异。
// 零依赖：仅用 Node 内置 fetch（Node 18+）。

const BASE = process.argv[2] || 'http://127.0.0.1:4096'
const results = []
const push = (s, n, d) => results.push([s, n, d || ''])
const PASS = (n, d) => push('PASS', n, d)
const WARN = (n, d) => push('WARN', n, d)
const FAIL = (n, d) => push('FAIL', n, d)
const isHTML = (t) => /<!doctype html>/i.test(t || '')

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, text, json }
}

async function main() {
  console.log('== BocomHermes serve 兼容自检 ==')
  console.log('target:', BASE, '\n')

  // 1) 健康 + 版本
  try {
    const r = await api('GET', '/global/health')
    if (r.status === 200 && r.json) PASS('GET /global/health', 'version=' + (r.json.version || '?'))
    else FAIL('GET /global/health', 'status=' + r.status)
  } catch (e) { FAIL('GET /global/health', e.message + '（serve 没起来？后续跳过）'); return dump() }

  // 2) provider / 模型已配
  try {
    const r = await api('GET', '/provider')
    const all = r.json && (r.json.all || r.json)
    const n = Array.isArray(all) ? all.length : (all && typeof all === 'object' ? Object.keys(all).length : 0)
    n ? PASS('GET /provider', n + ' 个 provider 可见') : WARN('GET /provider', '看不到 provider（模型可能没配）')
  } catch { WARN('GET /provider', '不可用') }

  // 3) 建会话（+ directory 参数）
  let sid = null
  try {
    const r = await api('POST', '/session', { title: 'compat-check', directory: process.cwd() })
    sid = r.json && (r.json.id || (r.json.data && r.json.data.id) || (r.json.info && r.json.info.id))
    if (sid) {
      PASS('POST /session', 'id=' + String(sid).slice(0, 14) + '…')
      const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '')
      const sent = process.cwd()
      const dir = r.json.directory || (r.json.data && r.json.data.directory)
      if (!dir) WARN('session.directory 参数', '响应未回显 directory')
      else if (norm(dir) === norm(sent)) PASS('session.directory 参数', '按传入目录生效：' + dir)
      else WARN('session.directory 参数', `传入 ${sent} 但回显 ${dir}（serve 用自身 cwd；BocomHermes 以"按目录建独立 serve"规避，不阻塞）`)
    } else FAIL('POST /session', 'status=' + r.status + '，无 id 字段')
  } catch (e) { FAIL('POST /session', e.message) }

  // 4) 发消息主入口（空体应 400，且不是网页）
  if (sid) {
    const r = await api('POST', `/session/${sid}/message`, {})
    if (isHTML(r.text)) FAIL('POST /session/:id/message', '返回网页（端点不存在）')
    else if (r.status === 400) PASS('POST /session/:id/message', '存在（空体 400，符合预期）')
    else WARN('POST /session/:id/message', 'status=' + r.status + '（确认这是发消息主入口）')
  }

  // 5) 中止
  if (sid) {
    try {
      const r = await api('POST', `/session/${sid}/abort`)
      isHTML(r.text) ? FAIL('POST /session/:id/abort', '网页（不存在）') : PASS('POST /session/:id/abort', 'status=' + r.status)
    } catch (e) { WARN('POST /session/:id/abort', e.message) }
  }

  // 6) 权限端点 + body 字段
  try {
    const probe = async (p) => !isHTML((await api('POST', p, { reply: 'reject' })).text)
    const hasNew = await probe('/permission/__d__/reply')
    const hasOld = await probe('/session/__d__/permissions/__d__')
    if (hasNew) PASS('权限端点 /permission/:id/reply', '存在（新）')
    else if (hasOld) WARN('权限端点', '仅旧端点 /session/:id/permissions/:id')
    else FAIL('权限端点', '两种都不存在 —— 写/执行授权会卡死')
    const bad = await api('POST', '/permission/__d__/reply', { response: 'reject' })
    if (bad.text && /\breply\b/.test(bad.text)) PASS('权限 body 字段', '应为 { reply: once|always|reject }')
    else WARN('权限 body 字段', '无法确认，请人工核对字段名与取值')
  } catch (e) { FAIL('权限端点', e.message) }

  // 7) SSE 事件流（流式 + 权限都依赖它）
  try {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 4000)
    const res = await fetch(BASE + '/event', { signal: ac.signal })
    if (!res.ok || !res.body) { FAIL('SSE /event', 'status=' + res.status); }
    else {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let got = ''
      for (let i = 0; i < 4; i++) { const { value, done } = await reader.read(); if (done) break; got += dec.decode(value, { stream: true }); if (got.includes('data:')) break }
      ac.abort()
      got.includes('data:') ? PASS('SSE /event', '可连接并收到事件') : WARN('SSE /event', '连上但首段未见事件')
    }
    clearTimeout(to)
  } catch (e) { FAIL('SSE /event', e.message) }

  if (sid) { try { await api('DELETE', `/session/${sid}`) } catch {} }
  dump()
}

function dump() {
  console.log('\n结果：')
  for (const [s, n, d] of results) {
    const mark = s === 'PASS' ? '✓' : s === 'WARN' ? '!' : '✗'
    console.log(`  ${mark} [${s}] ${n}${d ? ' — ' + d : ''}`)
  }
  const c = (s) => results.filter((r) => r[0] === s).length
  console.log(`\n小结：${c('PASS')} 通过 / ${c('WARN')} 警告 / ${c('FAIL')} 失败`)
  if (c('FAIL')) console.log('→ 有 FAIL：bocomcode 缺关键特性，BocomHermes 会在该处不正常 —— 需 bocomcode 侧补齐到与公网 opencode 一致。')
  else if (c('WARN')) console.log('→ 有 WARN：建议人工核对，多数不致命（BocomHermes 已对部分差异做防御）。')
  else console.log('→ 全通过：与BocomHermes 所需的 opencode serve 特性一致。')
  process.exit(c('FAIL') ? 1 : 0)
}

main().catch((e) => { console.error('checker error:', e); process.exit(2) })
