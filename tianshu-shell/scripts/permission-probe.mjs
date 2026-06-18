// 天枢 · 权限字段「真往返」确认（增强版）
// 一次触发多种工具（列目录/写文件/删文件），对每个权限请求都应答；
// 用 {reply:"once"} 应答，若不被接受自动改试 {response}，直接判定 bocomcode 认哪个字段/端点。
// 用法： node scripts/permission-probe.mjs [baseURL]   （默认 http://127.0.0.1:4096）
// 注意：会真的调用一次内网模型（数据不出门、成本极小），并可能在 serve 工作目录留下临时文件。

const BASE = process.argv[2] || 'http://127.0.0.1:4096'
const isHTML = (t) => /<!doctype html>/i.test(t || '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, body, signal) {
  const res = await fetch(BASE + path, {
    method, signal,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, text, json }
}
function extractText(msg) {
  const info = msg?.info ?? msg?.data?.info ?? msg
  const parts = msg?.parts ?? msg?.data?.parts ?? info?.parts ?? []
  return Array.isArray(parts) ? parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : ''
}
const ids = (ev) => {
  const p = ev.properties ?? ev.data ?? ev
  return {
    sessionId: p.sessionID ?? p.sessionId ?? p.session_id,
    requestId: p.requestID ?? p.id ?? p.permissionID ?? p.permissionId,
    tool: (typeof p.permission === 'string' && p.permission) || (typeof p.tool === 'string' && p.tool) || (p.tool && p.tool.name) || p.type || p.title || '?',
  }
}
function permPath(style, sessionId, requestId) {
  return style === 'old' ? `/session/${sessionId}/permissions/${requestId}` : `/permission/${requestId}/reply`
}

let firstEvent = null
let verdict = null        // { style, field, status } | { failed, tried }
let permCount = 0

async function detectAndReply(sessionId, requestId) {
  const combos = [['new', 'reply'], ['new', 'response'], ['old', 'reply'], ['old', 'response']]
  const tried = []
  for (const [style, field] of combos) {
    const r = await api('POST', permPath(style, sessionId, requestId), { [field]: 'once' })
    if (isHTML(r.text)) { tried.push({ style, field, note: 'SPA/端点不存在' }); continue }
    tried.push({ style, field, status: r.status })
    if (r.status >= 200 && r.status < 300) return { style, field, status: r.status }
  }
  return { failed: true, tried }
}

async function runEvents(onEvent, signal) {
  const res = await fetch(BASE + '/event', { signal })
  if (!res.ok || !res.body) throw new Error('/event ' + res.status)
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
  for (;;) {
    const { value, done } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
      if (!data) continue
      let ev; try { ev = JSON.parse(data) } catch { continue }
      await onEvent(ev)
    }
  }
}

async function main() {
  console.log('== 天枢 权限字段真往返确认（增强版）==')
  console.log('target:', BASE, '\n')
  try { const h = await api('GET', '/global/health'); console.log('serve version:', h.json?.version || '?') }
  catch (e) { console.log('✗ serve 不可达：', e.message); process.exit(2) }

  const s = await api('POST', '/session', { title: 'perm-probe' })
  const sid = s.json?.id || s.json?.data?.id
  if (!sid) { console.log('✗ 建会话失败'); process.exit(2) }

  const evAC = new AbortController()
  const sse = runEvents(async (ev) => {
    const type = ev?.type || ''
    if (!type.includes('permission') || type.includes('replied') || type.includes('response')) return
    const { sessionId, requestId } = ids(ev)
    if (!requestId) return
    permCount++
    if (!firstEvent) {
      firstEvent = ev
      console.log('\n→ 首个权限事件 type=' + type)
      console.log('  原始：', JSON.stringify(ev).slice(0, 320))
      verdict = await detectAndReply(sessionId || sid, requestId)
      if (!verdict.failed) console.log('  应答接受：{' + verdict.field + ':"once"} @ ' + (verdict.style === 'old' ? '旧端点' : '新端点'))
    } else if (verdict && !verdict.failed) {
      // 后续权限：用已确认的字段/端点直接放行，让任务跑完
      await api('POST', permPath(verdict.style, sessionId || sid, requestId), { [verdict.field]: 'once' }).catch(() => {})
    }
  }, evAC.signal).catch(() => {})

  await sleep(900)

  const prompt = '请依次用工具实际执行（必须真的调用工具，不要凭空回答）：'
    + '1) 列出当前工作目录下的文件；'
    + '2) 在当前目录创建文件 BocomHermes-probe.tmp，写入 ok；'
    + '3) 删除 BocomHermes-probe.tmp。完成后只回复 DONE。'
  console.log('发送触发指令（列目录/写/删），等待权限往返…（最多 120s）')
  let finalText = '', sendErr = null
  try {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 120000)
    const r = await api('POST', `/session/${sid}/message`, { parts: [{ type: 'text', text: prompt }] }, ac.signal)
    clearTimeout(to); finalText = extractText(r.json)
  } catch (e) { sendErr = e.message }

  evAC.abort(); try { await sse } catch {}
  try { await api('DELETE', `/session/${sid}`) } catch {}

  console.log('\n===== 结论 =====')
  console.log('收到权限事件数：', permCount)
  if (!firstEvent) {
    console.log('! 整个任务未触发任何权限事件 —— 该 serve 对这些工具默认放行（无需授权）。')
    console.log('  → 这种配置下天枢的权限应答路径用不到，字段问题不会发生；任务执行：' + (finalText.includes('DONE') ? '成功' : '未确认'))
    console.log('  → 若 bocomcode 实际是"要授权"的配置，请确保它配置了 ask，再重跑本探针。')
  } else if (verdict && !verdict.failed) {
    console.log('✓ 权限事件名：' + firstEvent.type)
    const f = ids(firstEvent)
    console.log('✓ 事件字段：sessionID/requestID/tool 解析 = ' + f.sessionId + ' / ' + f.requestId + ' / ' + f.tool)
    console.log('✓ 应答被接受：端点=' + (verdict.style === 'old' ? '/session/:id/permissions/:id（旧）' : '/permission/:id/reply（新）')
      + '  body 字段 = { ' + verdict.field + ': "once" }  status=' + verdict.status)
    if (verdict.field !== 'reply' || verdict.style !== 'new') {
      console.log('  ⚠ 与天枢默认（新端点 + reply 字段）不同！需在 opencode.js 的 replyPermission 调整为上面这套。把本段贴我即可。')
    } else {
      console.log('  ✓ 与天枢默认完全一致（新端点 + reply 字段）——无需改任何代码。')
    }
    console.log('端到端：' + (finalText.includes('DONE') ? '✓ 权限放行后任务跑完（彻底确认）' : '! 应答已被接受，但未见 DONE（可能模型表述不同，不影响字段结论）'))
  } else {
    console.log('✗ 抓到权限事件但应答都不被接受。尝试记录：')
    for (const t of (verdict?.tried || [])) console.log('   ', JSON.stringify(t))
    console.log('  → 把上面这段贴给我，我据此在天枢侧改字段/端点。')
  }
  if (sendErr) console.log('（发送阶段：' + sendErr + '）')
  process.exit(0)
}
main().catch((e) => { console.error('probe error:', e); process.exit(2) })
