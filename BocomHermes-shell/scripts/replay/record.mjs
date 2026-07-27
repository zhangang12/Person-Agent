// 【L1 golden transcript 录制器】零依赖。连真实 serve(默认 http://127.0.0.1:4096,需已在跑),
// 把 /event SSE 流与指定 API 往返录成 JSONL transcript —— 以后补新用例靠它,不用手写 transcript。
//
// 用法:
//   node scripts/replay/record.mjs --send "帮我摸透认证模块" [--base http://127.0.0.1:4096]
//        [--out scripts/replay/cases/xx.jsonl] [--timeout 90]
//     流程:建会话 → 发一条消息等回合收尾 → 再听 2s 尾巴事件 → 写文件。
//   node scripts/replay/record.mjs --listen 30 --out xx.jsonl
//     纯监听模式:只挂 /event 录事件,30s(或 Ctrl+C)后写文件(录人工在 UI 上操作产生的真实流)。
//
// 产物即回放格式(与 harness 同构):
//   · 每行 {t:相对毫秒, op:'sse'|'respond', ...};
//   · 真实 ses_xxx 自动反向别名化成 $sN(按出现顺序),respond 行的 path 把 ses_xxx 参数化为正则
//     —— 录出来的 transcript 原则上可直接被 fake serve 回放;
//   · respond 行的 json 是全量响应体(可能很大),人工裁剪时留所需字段即可;
//     裁剪要点:删掉与断言无关的事件,保留驱动分支的关键事件(todowrite/权限/子会话/用量…)。
// 录完怎么变成用例:见 harness.mjs 文件头「怎么补新用例」。
import fs from 'fs'
import path from 'path'
import { aliasify, serializeTranscript } from './harness.mjs'

const args = process.argv.slice(2)
const opt = (name, dft) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : dft
}
const BASE = opt('base', 'http://127.0.0.1:4096')
const OUT = opt('out', '')
const SEND = opt('send', '')
const LISTEN_S = +opt('listen', 0) || 0
const TIMEOUT_S = +opt('timeout', 90) || 90

const t0 = Date.now()
const t = () => Date.now() - t0
const lines = []
const sidOrder = []   // 真实 sid 出现顺序 → $sN
const noteSid = (sid) => { if (sid && !sidOrder.includes(sid)) sidOrder.push(sid) }
const push = (line) => { lines.push(line); console.log('  ● rec ' + line.op + ' t=' + line.t + 'ms ' + JSON.stringify(line).slice(0, 140)) }

async function httpJson(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const txt = await res.text()
  let json = null
  try { json = JSON.parse(txt) } catch {}
  return { status: res.status, json, text: txt }
}

async function main() {
  // 探活
  try { await httpJson('GET', '/global/health') } catch { console.error('连不上 serve: ' + BASE + ' —— 先起 opencode/bocomcode serve 或用 --base 指定'); process.exit(1) }
  console.log('录制开始: ' + BASE + (SEND ? ' (发送模式)' : ' (纯监听 ' + LISTEN_S + 's)'))

  // 挂 /event SSE:逐事件记 {t, op:'sse', event}(sid 自动别名化在收尾统一做)
  let stopSse = false
  const sseDone = (async () => {
    try {
      const res = await fetch(BASE + '/event')
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done || stopSse) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
          if (!data) continue
          try {
            const ev = JSON.parse(data)
            const sid = ev && ev.properties && (ev.properties.sessionID || ev.properties.sessionId || (ev.properties.info && ev.properties.info.id))
            noteSid(sid)
            push({ t: t(), op: 'sse', event: ev })
          } catch {}
        }
      }
    } catch (e) { console.log('  (SSE 流结束: ' + e.message + ')') }
  })()

  if (SEND) {
    // 建会话(记 respond:path 参数化、body 留样)
    const cs = await httpJson('POST', '/session', { title: '录制用例' })
    const sid = cs.json && (cs.json.id || (cs.json.info && cs.json.info.id) || (cs.json.data && cs.json.data.id))
    noteSid(sid)
    push({ t: t(), op: 'respond', method: 'POST', path: '^/session$', status: cs.status, json: cs.json || { id: sid }, note: '建会话(回放时 fake serve 自动发证,可删此行)' })
    if (!sid) { console.error('建会话失败: ' + cs.text.slice(0, 200)); process.exit(1) }
    console.log('会话: ' + sid + ' → 别名 $s' + sidOrder.length)
    // 发消息(挂起等回合收尾;记 respond)
    const msgPath = '/session/' + sid + '/message'
    const mr = await Promise.race([
      httpJson('POST', msgPath, { parts: [{ type: 'text', text: SEND }] }),
      new Promise((r) => setTimeout(() => r({ status: 0, json: null, text: '(录制超时)' }), TIMEOUT_S * 1000)),
    ])
    push({ t: t(), op: 'respond', method: 'POST', path: '^/session/ses_[^/]+/message$', status: mr.status, json: mr.json, note: '发消息响应(回放时可用默认行为替代:落 user + 返 assistant 完成消息)' })
    console.log('回合响应: HTTP ' + mr.status + ' (' + t() + 'ms)')
    await new Promise((r) => setTimeout(r, 2000))   // 再听 2s 尾巴事件(收尾/tokens/todo)
  } else {
    await new Promise((r) => setTimeout(r, LISTEN_S * 1000))
  }

  stopSse = true
  await Promise.race([sseDone, new Promise((r) => setTimeout(r, 1500))])

  // 统一反向别名化:全文里的真实 ses_xxx → $sN(按出现顺序)
  const aliased = lines.map((l) => JSON.parse(aliasify(JSON.stringify(l), sidOrder)))
  const header = [
    '# golden transcript 录制产物: ' + new Date().toISOString() + ' base=' + BASE,
    '# 会话别名: ' + sidOrder.map((s, i) => '$s' + (i + 1) + '=' + s).join(' '),
    '# 裁剪要点:删与断言无关的事件/响应;sse 行的 t 是真实毫秒(回放 manual 模式只看顺序不看 t)。',
  ]
  const out = header.join('\n') + '\n' + serializeTranscript(aliased)
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, out, 'utf8')
    console.log('\n已写 ' + OUT + ' (' + aliased.length + ' 行,' + sidOrder.length + ' 个会话别名)')
  } else {
    console.log('\n----- transcript(未指定 --out,直接打印)-----\n' + out)
  }
  process.exit(0)
}

main().catch((e) => { console.error('录制异常:', e); process.exit(1) })
