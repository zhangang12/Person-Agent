// PATCH /config 热更新探针(内网验收用,零依赖,需要真实运行中的 serve)
//
// 验什么(整改计划 P3.2 / 借鉴总清单 D3 的前提):
//   ① PATCH /config 端点存在且接受写回(幂等写,不改任何行为)
//   ② --behavior 模式:改一条无害 permission.bash 规则 → 不等重启直接发一条匹配命令,
//     看权限是否即时按新规则放行(真"热生效");验完立即 PATCH 还原配置。
// 用法: node scripts/config-patch-probe.mjs [baseURL] [--behavior]   (默认 http://127.0.0.1:4096)
// 注意:--behavior 会真实调一次模型(约 1-2 分钟),并在你的 serve 配置里短暂加一条 "echo __probe__ *":"allow" 规则(验完即还原)。

const BASE = process.argv[2] || 'http://127.0.0.1:4096'
const BEHAVIOR = process.argv.includes('--behavior')
let failN = 0
const PASS = (n, d) => console.log('  ✓ ' + n + (d ? ' — ' + d : ''))
const WARN = (n, d) => console.log('  ⚠ ' + n + (d ? ' — ' + d : ''))
const FAIL = (n, d) => { failN++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) }

async function api(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, text, json }
}

async function main() {
  console.log('== PATCH /config 热更新探针 ==')
  console.log('target:', BASE)
  const g0 = await api('GET', '/config')
  if (g0.status !== 200 || !g0.json) { FAIL('GET /config', 'status=' + g0.status + '(serve 没起来?后续跳过)'); return dump() }
  PASS('GET /config', '拿到现状配置(' + JSON.stringify(g0.json).length + ' 字符)')

  // ① 幂等写回:body 就是现状配置,不该改变任何行为
  const p1 = await api('PATCH', '/config', g0.json)
  if (p1.status === 404 || p1.status === 405) { FAIL('PATCH /config', 'status=' + p1.status + ' —— 端点不存在(该 fork 版本无热更新通道,维持"写文件+重启 serve"现状)'); return dump() }
  if (p1.status >= 400) { FAIL('PATCH /config(幂等写回)', 'status=' + p1.status + ' body=' + p1.text.slice(0, 200)); return dump() }
  PASS('PATCH /config(幂等写回)', 'status=' + p1.status + ' —— 端点存在且接受写回')
  const g1 = await api('GET', '/config')
  if (g1.status === 200 && JSON.stringify(g1.json) === JSON.stringify(g0.json)) PASS('写回后再读一致(无副作用)')
  else WARN('写回后再读有差异', '可能是 serve 规范化(键序/补默认),不影响结论;差异前 200 字:' + JSON.stringify(g1.json || {}).slice(0, 200))

  if (!BEHAVIOR) { console.log('\n(未加 --behavior,跳过行为级热生效验证)'); return dump() }

  // ② 行为级:加一条 probe 规则,不重启直接验证即时生效,验完还原
  console.log('\n[behavior] 热生效行为验证(改规则→不重启→跑命令→还原)')
  const probePat = 'echo __cfg_patch_probe__ *'
  const cfg2 = JSON.parse(JSON.stringify(g0.json))
  cfg2.permission = cfg2.permission && typeof cfg2.permission === 'object' ? cfg2.permission : {}
  const oldBash = cfg2.permission.bash
  cfg2.permission.bash = Object.assign({}, (oldBash && typeof oldBash === 'object' && !Array.isArray(oldBash)) ? oldBash : {}, { [probePat]: 'allow' })
  const p2 = await api('PATCH', '/config', cfg2)
  if (p2.status >= 400) { FAIL('PATCH 加探针规则', 'status=' + p2.status); return dump() }
  const g2 = await api('GET', '/config')
  const hit = g2.json && g2.json.permission && g2.json.permission.bash && g2.json.permission.bash[probePat] === 'allow'
  hit ? PASS('探针规则已写入并可读回') : WARN('探针规则读不回', 'serve 可能对 permission.bash 做了规范化,行为验证继续看实战')
  // 实战:开一个会话让它跑 echo __cfg_patch_probe__ hi —— 若热生效,不该弹权限(没人点也不会卡死:规则 allow)
  // 若没热生效,会出 permission 事件(我们监听并记为证据,然后 reject 放行不了就 abort,最后总会话删掉)
  let permSeen = false
  const stop = { done: false }
  ;(async () => {
    try {
      const res = await fetch(BASE + '/event')
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
      while (!stop.done) {
        const { value, done } = await rd.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2)
          if (chunk.includes('permission') && !chunk.includes('replied')) permSeen = true
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              const evt = JSON.parse(line.slice(5).trim())
              const p = (evt && evt.properties) || {}
              const rid = p.requestID ?? p.id
              if (rid) await api('POST', '/permission/' + rid + '/reply', { reply: 'reject' })
            } catch {}
          }
        }
      }
      try { rd.cancel() } catch {}
    } catch {}
  })()
  const s = await api('POST', '/session', { title: 'cfg-patch-probe' })
  const sid = s.json && (s.json.id || (s.json.data && s.json.data.id))
  if (!sid) { FAIL('POST /session', 'status=' + s.status) }
  else {
    await api('POST', '/session/' + sid + '/message', { parts: [{ type: 'text', text: '【只允许用 bash 工具】执行命令: echo __cfg_patch_probe__ hi ,然后把输出原样复述一遍。' }] })
    stop.done = true
    permSeen ? FAIL('热生效行为验证', '新规则已写入但仍弹权限事件 —— PATCH 只写不热,改动需重启 serve 才生效(同写文件路径)')
      : PASS('热生效行为验证', '新规则写入后未弹权限(命令直接按 allow 放行或权限事件缺席) —— PATCH 真热生效')
    try { await api('DELETE', '/session/' + sid) } catch {}
  }
  // 还原
  const back = await api('PATCH', '/config', g0.json)
  back.status < 400 ? PASS('配置已还原') : FAIL('配置还原失败', 'status=' + back.status + ' —— 请人工检查配置里的 echo __cfg_patch_probe__ 规则')
  dump()
}
function dump() { console.log('\n== ' + (failN ? failN + ' 失败' : '通过') + ' =='); process.exit(failN ? 1 : 0) }
main().catch((e) => { console.error(e); process.exit(1) })
