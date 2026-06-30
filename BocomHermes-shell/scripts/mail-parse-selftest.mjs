// 回归测试:钉住 IMAP _drain ↔ extractMessages 的 literal({LEN})契约。
// 历史 bug:_drain 误删行尾 {LEN} → extractMessages 永远匹配不到 → 收件箱一直空。
// 本测试用真实 email.js 内部件(__test),模拟服务器字节流(latin1)逐块喂入。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const email = require('../src/email.js')
const { ImapClient, extractMessages, parseRfc822 } = email.__test

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

// 造一封真实 RFC822(UTF-8),返回 { mimeUtf8Buf, len }
function makeMail({ from, subject, body }) {
  const mail =
    `From: ${from}\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: Mon, 30 Jun 2026 10:00:00 +0800\r\n` +
    `Message-ID: <${Math.random().toString(36).slice(2)}@bank.com>\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    `${body}\r\n`
  const buf = Buffer.from(mail, 'utf8')
  return { buf, len: buf.length }
}

// 把若干封邮件封装成一段 UID FETCH 服务器响应(Buffer,UTF-8 字节),tag=A001
function buildFetchResponse(mails) {
  const chunks = []
  mails.forEach((m, i) => {
    chunks.push(Buffer.from(`* ${i + 1} FETCH (UID ${100 + i} BODY[] {${m.len}}\r\n`, 'utf8'))
    chunks.push(m.buf)
    chunks.push(Buffer.from(`\r\n)\r\n`, 'utf8'))
  })
  chunks.push(Buffer.from(`A001 OK FETCH completed\r\n`, 'utf8'))
  return Buffer.concat(chunks)
}

// 驱动真实 ImapClient:逐块喂 latin1 字符串,返回 resolve 出来的 _respStr
function drive(respBuf, chunkSize) {
  const c = new ImapClient()
  let out = null, err = null
  c._pending = { tag: 'A001', resolve: (s) => { out = s }, reject: (e) => { err = e } }
  c._respStr = ''
  const latin1 = respBuf.toString('latin1')   // 模拟 sock.setEncoding('latin1')
  const step = chunkSize || latin1.length
  for (let i = 0; i < latin1.length; i += step) c._onData(latin1.slice(i, i + step))
  if (err) throw err
  return out
}

// ── 用例 1:单封邮件,整段一次喂入 ──────────────────────────────────────
;(() => {
  console.log('用例1:单封邮件')
  const m = makeMail({ from: '张三 <zhangsan@bank.com>', subject: '测试邮件主题', body: '这是正文内容。' })
  const resp = drive(buildFetchResponse([m]))
  ok('_respStr 保留 {LEN} 标记(防退化)', /\{\d+\}/.test(resp))
  const msgs = extractMessages(resp)
  ok('抽到 1 封', msgs.length === 1, '实际 ' + msgs.length)
  if (msgs.length) {
    const p = parseRfc822(msgs[0].raw)
    ok('From 中文正确解码', p.from.includes('张三'), p.from)
    ok('Subject 中文正确解码', p.subject === '测试邮件主题', p.subject)
    ok('正文中文正确解码', p.text.includes('这是正文内容'), p.text)
    ok('UID 正确', msgs[0].uid === 100, String(msgs[0].uid))
  }
})()

// ── 用例 2:多封邮件在同一段响应里 ──────────────────────────────────────
;(() => {
  console.log('用例2:三封邮件')
  const mails = [
    makeMail({ from: 'a@bank.com', subject: '第一封', body: 'aaa' }),
    makeMail({ from: 'b@bank.com', subject: '第二封', body: 'bbb' }),
    makeMail({ from: 'c@bank.com', subject: '第三封', body: 'ccc' }),
  ]
  const msgs = extractMessages(drive(buildFetchResponse(mails)))
  ok('抽到 3 封', msgs.length === 3, '实际 ' + msgs.length)
  const subs = msgs.map((x) => parseRfc822(x.raw).subject)
  ok('三封主题齐全', subs.includes('第一封') && subs.includes('第二封') && subs.includes('第三封'), subs.join(','))
})()

// ── 用例 3:literal 跨 chunk 边界(模拟 TCP 分包)──────────────────────────
;(() => {
  console.log('用例3:literal 跨 TCP 分包(逐块 7 字节)')
  const m = makeMail({ from: '李四 <lisi@bank.com>', subject: '跨包测试', body: '正文要足够长以便切成很多小块来模拟网络分包的真实情形。'.repeat(3) })
  const msgs = extractMessages(drive(buildFetchResponse([m]), 7))   // 故意 7 字节一块
  ok('分包后仍抽到 1 封', msgs.length === 1, '实际 ' + msgs.length)
  if (msgs.length) {
    const p = parseRfc822(msgs[0].raw)
    ok('分包后 Subject 完整', p.subject === '跨包测试', p.subject)
    ok('分包后正文完整', p.text.includes('网络分包'), p.text.slice(0, 30))
  }
})()

// ── 用例 4:空 SEARCH 风格响应(无 literal)不被误伤 ─────────────────────
;(() => {
  console.log('用例4:SEARCH 响应(无 literal)')
  const c = new ImapClient()
  let out = null
  c._pending = { tag: 'A001', resolve: (s) => { out = s }, reject: () => {} }
  c._respStr = ''
  c._onData('* SEARCH 5 4 3 2 1\r\nA001 OK SEARCH completed\r\n')
  const m = out.match(/\* SEARCH([\d\s]*)/i)
  const uids = (m ? m[1] : '').trim().split(/\s+/).filter(Boolean).map(Number)
  ok('SEARCH 解析出 5 个 UID', uids.length === 5, uids.join(','))
})()

// ── 用例 5:RFC 2047 编码字头部(真实邮件主流格式)仍正确 ───────────────
;(() => {
  console.log('用例5:RFC 2047 编码字头部')
  const subjB64 = '=?UTF-8?B?' + Buffer.from('季度需求评审通知', 'utf8').toString('base64') + '?='
  const mail = Buffer.from(
    `From: =?UTF-8?B?${Buffer.from('王五', 'utf8').toString('base64')}?= <wangwu@bank.com>\r\n` +
    `Subject: ${subjB64}\r\n` +
    `Message-ID: <rfc2047@bank.com>\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n正文\r\n`, 'utf8')
  const resp = drive(buildFetchResponse([{ buf: mail, len: mail.length }]))
  const msgs = extractMessages(resp)
  ok('抽到 1 封', msgs.length === 1)
  if (msgs.length) {
    const p = parseRfc822(msgs[0].raw)
    ok('RFC2047 Subject 解码', p.subject === '季度需求评审通知', p.subject)
    ok('RFC2047 From 解码', p.from.includes('王五'), p.from)
  }
})()

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
