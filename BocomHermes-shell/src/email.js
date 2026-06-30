'use strict'
// 极简邮件客户端 —— 零外部依赖,只用 Node 内置 tls/net
//  · IMAP:LOGIN / SELECT / SEARCH / FETCH / LOGOUT(只读,不动服务器状态)
//  · SMTP:EHLO / STARTTLS / AUTH LOGIN / DATA(支持 multipart/alternative + 附件)
//  · MIME 真解析:multipart 拆 boundary、CTE 解码(base64/quoted-printable/8bit)、
//                 charset 真转码(用 Electron 自带 ICU 的 TextDecoder,支持 gb18030/gbk/gb2312)
//  · RFC 2047 主题/From 解码:走同一个 decodeBytes,避免原代码 toString('binary') 中文乱码
const tls = require('tls')
const net = require('net')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const TIMEOUT = 25000
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── 字节解码(charset 真转码)─────────────────────────────────────────────
// Electron 主进程自带完整 ICU,TextDecoder 支持 gb18030/gbk/gb2312/big5/shift_jis/euc-kr…
// 非 Electron 进程(如纯 Node MCP)调用时,不支持的字符集会降级到 utf-8
function hasHighByte(bytes) { for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return true; return false }
function isValidUtf8(bytes) { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false } }
function decodeBytes(bytes, charset) {
  charset = String(charset || '').toLowerCase().replace(/[_\s]/g, '-').trim()
  // 没声明 charset / 声明成 ascii:做嗅探。国内老邮局常发 GB 字节却不声明 charset(或写 us-ascii),
  // 一律当 utf-8 解会整段乱码。纯 ASCII 怎么解都一样;含高位字节就先验证是否合法 UTF-8,不是才退回 GB18030。
  if (!charset || charset === 'us-ascii' || charset === 'ascii') {
    if (!hasHighByte(bytes) || isValidUtf8(bytes)) return bytes.toString('utf8')
    try { return new TextDecoder('gb18030', { fatal: false, ignoreBOM: true }).decode(bytes) }
    catch { return bytes.toString('utf8') }
  }
  if (charset === 'gb2312' || charset === 'gbk') charset = 'gb18030'   // GB18030 是超集
  if (charset === 'iso-8859-1' || charset === 'latin1') return bytes.toString('latin1')
  if (charset === 'utf-8' || charset === 'utf8') {
    // 声明 utf-8 但字节根本不是合法 UTF-8(发信方误标)→ 也退回 GB18030 兜底
    if (hasHighByte(bytes) && !isValidUtf8(bytes)) {
      try { return new TextDecoder('gb18030', { fatal: false, ignoreBOM: true }).decode(bytes) } catch {}
    }
    return bytes.toString('utf8')
  }
  try { return new TextDecoder(charset, { fatal: false, ignoreBOM: true }).decode(bytes) }
  catch {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
    catch { return bytes.toString('utf8') }
  }
}

// ── RFC 2047 解码(=?charset?B/Q?...?=)──────────────────────────────────
// 主题/From 里的编码字。原实现 toString('binary') 把 GB 字节当 latin1 → 乱码
function decodeWords(s) {
  if (!s) return ''
  s = String(s)
  // 整条 header 没有 RFC2047 编码字,却含高位字节 → 国内部分邮局/网关直接塞裸 GB/UTF-8 字节。
  // 此时 s 是 latin1(每字节一字符),还原成 bytes 走 charset 嗅探(decodeBytes 对纯 ASCII 无副作用)。
  if (!/=\?[^?]+\?[BbQq]\?/.test(s) && /[\x80-\xff]/.test(s)) {
    return decodeBytes(Buffer.from(s, 'latin1'), '')
  }
  // 同 charset 的相邻 encoded-word 之间的空白要折叠
  return s
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      try {
        let bytes
        if (enc.toUpperCase() === 'B') bytes = Buffer.from(data, 'base64')
        else {
          // Q-encoding: _ → 空格, =XX → 十六进制字节
          const raw = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)))
          bytes = Buffer.from(raw, 'latin1')
        }
        return decodeBytes(bytes, charset)
      } catch { return data }
    })
}

// ── HTML strip → plain ─────────────────────────────────────────────────
function stripHtml(raw, max) {
  if (!raw) return ''
  const text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return max && text.length > max ? text.slice(0, max) + '…' : text
}

// ── MIME 头解析 ─────────────────────────────────────────────────────────
function parseHeaders(s) {
  if (!s) return {}
  const out = {}
  const lines = s.split(/\r?\n/)
  let cur = null
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += ' ' + line.trim(); continue }
    const m = line.match(/^([!-9;-~]+)\s*:\s?(.*)$/)
    if (m) { cur = m[1].toLowerCase(); out[cur] = m[2] }
  }
  return out
}

function parseHeaderValue(v) {
  if (!v) return { value: '', params: {} }
  const parts = v.split(';')
  const value = parts.shift().trim().toLowerCase()
  const params = {}
  for (const p of parts) {
    const m = p.match(/^\s*([^=]+?)\s*=\s*(.*)\s*$/); if (!m) continue
    let val = m[2].trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    params[m[1].toLowerCase()] = val
  }
  return { value, params }
}

// RFC 2231 文件名续行/编码(`filename*0*=utf-8''xxx; filename*1*=yyy`)
function rfc2231Name(params) {
  // 优先 filename*=charset''val
  for (const k of Object.keys(params)) {
    if (k === 'filename*' || k === 'name*') {
      const m = params[k].match(/^([^']*)'[^']*'(.*)$/)
      if (m) {
        const cs = m[1] || 'utf-8'
        const raw = m[2].replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        return decodeBytes(Buffer.from(raw, 'latin1'), cs)
      }
    }
  }
  // 拼接续行 filename*0=..; filename*1=..
  const keys = Object.keys(params).filter((k) => /^(filename|name)\*\d+\*?$/.test(k))
                 .sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))
  if (keys.length) {
    let charset = 'utf-8'
    const pieces = keys.map((k) => {
      let v = params[k]
      if (k.endsWith('*')) {
        const m = v.match(/^([^']*)'[^']*'(.*)$/)
        if (m) { charset = m[1] || charset; v = m[2] }
        v = v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      }
      return v
    }).join('')
    return decodeBytes(Buffer.from(pieces, 'latin1'), charset)
  }
  const name = params.filename || params.name
  return name ? decodeWords(name) : ''
}

// ── Content-Transfer-Encoding 解码 → bytes(Buffer)──────────────────────
function decodeQP(s) {
  s = s.replace(/=\r?\n/g, '')          // 软换行
  const out = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x3D /* = */ && i + 2 < s.length) {
      const h = s.substr(i + 1, 2)
      if (/^[0-9A-Fa-f]{2}$/.test(h)) { out.push(parseInt(h, 16)); i += 2; continue }
    }
    out.push(c & 0xFF)
  }
  return Buffer.from(out)
}

function decodeBody(body, cte) {
  const enc = String(cte || '7bit').toLowerCase().trim()
  if (enc === 'base64') return Buffer.from(body.replace(/[\r\n]/g, ''), 'base64')
  if (enc === 'quoted-printable') return decodeQP(body)
  // 7bit / 8bit / binary:body 已经是 latin1 字符串(socket setEncoding 'latin1')
  return Buffer.from(body, 'latin1')
}

// ── multipart 切分 ──────────────────────────────────────────────────────
function splitMultipart(body, boundary) {
  const marker = '--' + boundary
  const out = []
  const parts = body.split(marker)
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]
    if (seg.startsWith('--')) break                           // 闭合 boundary --boundary--
    const trimmed = seg.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    const sep = trimmed.indexOf('\r\n\r\n')
    let header, sb
    if (sep >= 0) { header = trimmed.slice(0, sep); sb = trimmed.slice(sep + 4) }
    else { const sep2 = trimmed.indexOf('\n\n'); if (sep2 >= 0) { header = trimmed.slice(0, sep2); sb = trimmed.slice(sep2 + 2) } else { header = trimmed; sb = '' } }
    out.push({ header, body: sb })
  }
  return out
}

// ── 递归解析 MIME part ──────────────────────────────────────────────────
function parsePart(headers, body) {
  const ct = parseHeaderValue(headers['content-type'] || 'text/plain')
  const cte = (headers['content-transfer-encoding'] || '7bit').toLowerCase().trim()
  const cd = parseHeaderValue(headers['content-disposition'] || '')
  const isAttachment = cd.value === 'attachment' || !!cd.params.filename || !!cd.params['filename*'] || (!!ct.params.name && !ct.value.startsWith('text/'))

  // multipart/* → 递归
  if (ct.value.startsWith('multipart/')) {
    const boundary = ct.params.boundary
    if (!boundary) return { text: '', html: '', attachments: [] }
    const subs = splitMultipart(body, boundary)
    let text = '', html = '', attachments = []
    // alternative 偏好后出现的(html 通常排在 text 后,Outlook 客户端发的也是这样)
    const isAlt = ct.value === 'multipart/alternative'
    for (const p of subs) {
      const sub = parsePart(parseHeaders(p.header), p.body)
      if (isAlt) {
        if (sub.text) text = sub.text
        if (sub.html) html = sub.html
      } else {
        if (!text && sub.text) text = sub.text
        if (!html && sub.html) html = sub.html
      }
      attachments = attachments.concat(sub.attachments || [])
    }
    return { text, html, attachments }
  }

  // 单部分:解 bytes
  const bytes = decodeBody(body, cte)

  // 附件
  if (isAttachment) {
    const filename = rfc2231Name(cd.params) || rfc2231Name(ct.params) || 'unknown.bin'
    return { text: '', html: '', attachments: [{
      filename, mime: ct.value, size: bytes.length, bytes,
      contentId: (headers['content-id'] || '').replace(/[<>]/g, '').trim() || '',
    }] }
  }

  // text/html
  if (ct.value === 'text/html') {
    const html = decodeBytes(bytes, ct.params.charset)
    return { text: '', html, attachments: [] }
  }
  // text/plain (或缺省)
  const text = decodeBytes(bytes, ct.params.charset)
  return { text, html: '', attachments: [] }
}

// ── 顶层解析:raw RFC822 → { from, subject, date, messageId, text, html, attachments }
function parseRfc822(raw) {
  const sep = raw.indexOf('\r\n\r\n')
  let headerStr, bodyStr
  if (sep >= 0) { headerStr = raw.slice(0, sep); bodyStr = raw.slice(sep + 4) }
  else { const sep2 = raw.indexOf('\n\n'); if (sep2 >= 0) { headerStr = raw.slice(0, sep2); bodyStr = raw.slice(sep2 + 2) } else { headerStr = raw; bodyStr = '' } }
  const h = parseHeaders(headerStr)
  const parsed = parsePart(h, bodyStr)
  const from = decodeWords((h.from || '').trim())
  const subject = decodeWords((h.subject || '').trim())
  const date = (h.date || '').trim()
  const messageId = (h['message-id'] || '').replace(/[<>]/g, '').trim()
  const inReplyTo = (h['in-reply-to'] || '').replace(/[<>]/g, '').trim()
  const refs = (h['references'] || '').split(/\s+/).map((s) => s.replace(/[<>]/g, '').trim()).filter(Boolean)
  // 优先 text;没 text 但有 html → 从 html 抽
  const text = parsed.text || stripHtml(parsed.html)
  return {
    from, subject, date, messageId, inReplyTo, references: refs,
    text, html: parsed.html, attachments: parsed.attachments,
  }
}

// ── IMAP 客户端(literal-aware,latin1 字节安全)─────────────────────────
class ImapClient {
  constructor() {
    this._sock = null; this._buf = ''
    this._tagN = 0; this._inLiteral = 0
    this._respStr = ''; this._pending = null
  }

  connect(host, port, secure, allowSelf) {
    return new Promise((resolve, reject) => {
      const sock = secure
        ? tls.connect(+port || 993, host, { rejectUnauthorized: !allowSelf })
        : net.connect(+port || 143, host)
      this._sock = sock
      sock.setEncoding('latin1')              // 8bit 字节安全;后续 Buffer.from(s, 'latin1') 还原
      sock.setTimeout(TIMEOUT)
      sock.on('timeout', () => sock.destroy(new Error('IMAP 连接超时(' + TIMEOUT / 1000 + 's)')))
      sock.on('error', (e) => {
        const p = this._pending; if (p) { this._pending = null; p.reject(e) } else reject(e)
      })
      let greetBuf = '', done = false
      const onGreet = (chunk) => {
        if (done) return
        greetBuf += chunk
        const nl = greetBuf.indexOf('\r\n'); if (nl === -1) return
        done = true; sock.removeListener('data', onGreet)
        const line = greetBuf.slice(0, nl)
        this._buf = greetBuf.slice(nl + 2)
        sock.on('data', (c) => this._onData(c))
        if (/\* (OK|PREAUTH)/.test(line)) resolve()
        else reject(new Error('IMAP greeting 拒绝: ' + line.slice(0, 80)))
      }
      sock.on('data', onGreet)
    })
  }

  _onData(chunk) { this._buf += chunk; this._drain() }

  _drain() {
    for (;;) {
      if (this._inLiteral > 0) {
        if (!this._buf.length) return
        const take = Math.min(this._inLiteral, this._buf.length)
        this._respStr += this._buf.slice(0, take)
        this._buf = this._buf.slice(take)
        this._inLiteral -= take
        continue
      }
      const nl = this._buf.indexOf('\r\n'); if (nl === -1) return
      const line = this._buf.slice(0, nl); this._buf = this._buf.slice(nl + 2)
      const litM = line.match(/\{(\d+)\}$/)
      if (litM) {
        this._inLiteral = parseInt(litM[1])
        // 必须保留行尾 {LEN} 标记:extractMessages 靠它定位 literal 起点与长度。
        // (曾误删 {LEN} → UID FETCH 报文永远匹配不到 → 收件箱一直空)
        this._respStr += line + '\n'
        continue
      }
      this._respStr += line + '\n'
      if (!this._pending) continue
      // IMAP continuation(APPEND literal):服务端发 "+ Ready" 表示可以发数据了
      if (line.startsWith('+') && this._pending.onContinuation) {
        try { this._pending.onContinuation() } catch (e) { const p = this._pending; this._pending = null; p.reject(e) }
        continue
      }
      const tag = this._pending.tag
      if (line.startsWith(tag + ' OK') || line.toLowerCase().startsWith(tag.toLowerCase() + ' ok')) {
        const p = this._pending; this._pending = null
        p.resolve(this._respStr); this._respStr = ''
      } else if (/^(NO|BAD)\s/i.test(line.slice(tag.length + 1))) {
        const p = this._pending; this._pending = null; this._respStr = ''
        p.reject(new Error('IMAP: ' + line.slice(tag.length + 1, tag.length + 120)))
      }
    }
  }

  send(cmd) {
    const tag = 'A' + String(++this._tagN).padStart(3, '0')
    return new Promise((resolve, reject) => {
      this._pending = { tag, resolve, reject }
      this._respStr = ''
      this._sock.write(tag + ' ' + cmd + '\r\n')
    })
  }

  // APPEND 到指定文件夹(用于把发出去的邮件写进 Sent)。mimeStr 必须全 ASCII(buildMime 输出符合)
  sendAppend(folder, mimeStr, flags) {
    const tag = 'A' + String(++this._tagN).padStart(3, '0')
    return new Promise((resolve, reject) => {
      const byteLen = Buffer.byteLength(mimeStr, 'utf8')
      const flagsStr = flags ? ' (' + flags + ')' : ''
      this._pending = {
        tag, resolve, reject,
        onContinuation: () => { this._sock.write(mimeStr + '\r\n') },
      }
      this._respStr = ''
      this._sock.write(`${tag} APPEND "${String(folder).replace(/"/g, '\\"')}"${flagsStr} {${byteLen}}\r\n`)
    })
  }

  quit() { try { this._sock && this._sock.destroy() } catch {} }
}

// ── FETCH 响应:抽出每封邮件的 raw RFC822 字符串(latin1)──────────────
// 形如:* N FETCH (UID 123 BODY[] {LEN}
//         ...LEN 字节...
//       )
function extractMessages(resp) {
  const out = []
  let i = 0
  const re = /\* (\d+) FETCH \(([^{]*?)\{(\d+)\}\r?\n/g
  for (;;) {
    re.lastIndex = i
    const m = re.exec(resp); if (!m) break
    const seq = parseInt(m[1], 10)
    const fields = m[2]                  // 可能含 UID 123
    const len = parseInt(m[3], 10)
    const start = m.index + m[0].length
    const raw = resp.slice(start, start + len)
    const uidM = fields.match(/UID\s+(\d+)/i)
    out.push({ seq, uid: uidM ? parseInt(uidM[1]) : null, raw })
    i = start + len
  }
  return out
}

// ── IMAP SEARCH 字符串转义(双引号包裹 + 转义 \" \\)─────────────────────
// 适合纯 ASCII 关键词(邮箱地址、英文主题)。中文关键词需要服务端支持 CHARSET UTF-8 SEARCH,
// 多数 Exchange/邮局支持,这里实现 CHARSET 兜底。
function imapQuote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' }
function needsUtf8Search(s) { return /[^\x00-\x7F]/.test(String(s || '')) }
function imapDate(d) { return `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}` }

// ── 主接口:抓取邮件(支持分页 + 服务端筛选)──────────────────────────
//   opts:{ from?, subject?, days?=1, onlyUnseen?=true, limit?=10, cursor?=0 }
//   返回 { emails, nextCursor, totalMatched }
//   · emails  — 每封含 from/subject/date/messageId/text/html/attachments/uid/body
//   · nextCursor — 还有更多就返回下次该传的 cursor;null 表示已到末尾
//   · totalMatched — SEARCH 命中总数(给 agent 知道还剩多少)
async function fetchUnread(cfg, opts) {
  if (!cfg || !cfg.host || !cfg.user) throw new Error('邮件服务器未配置(host/user 缺失)')
  const pass = decryptPass(cfg.passEncrypted)
  if (!pass) throw new Error('邮件密码未配置')
  opts = opts || {}
  const limit  = Math.max(1, Math.min(+opts.limit  || 10, 30))
  const cursor = Math.max(0, +opts.cursor || 0)
  const days   = Math.max(1, +opts.days   || 1)
  const onlyUnseen = opts.onlyUnseen !== false
  const folder = String(opts.folder || 'INBOX')   // 支持读 Sent/Archive/Drafts 等任意文件夹

  const client = new ImapClient()
  await client.connect(cfg.host, cfg.port || 993, cfg.secure !== false, cfg.allowSelfSigned)
  try {
    await client.send(`LOGIN ${imapQuote(cfg.user)} ${imapQuote(pass)}`)
    await client.send(`SELECT ${imapQuote(folder)}`)

    // 服务端 SEARCH:UID SEARCH 拿稳定 UID,后面 UID FETCH 用
    const crit = []
    if (onlyUnseen) crit.push('UNSEEN')
    const since = new Date(Date.now() - days * 24 * 3600 * 1000)
    crit.push(`SINCE ${imapDate(since)}`)
    if (opts.before) { const bd = new Date(opts.before); if (!isNaN(bd.getTime())) crit.push(`BEFORE ${imapDate(bd)}`) }
    if (opts.from)    crit.push(`FROM ${imapQuote(opts.from)}`)
    if (opts.to)      crit.push(`TO ${imapQuote(opts.to)}`)
    if (opts.subject) crit.push(`SUBJECT ${imapQuote(opts.subject)}`)
    if (opts.body)    crit.push(`BODY ${imapQuote(opts.body)}`)
    const useUtf8 = [opts.from, opts.to, opts.subject, opts.body].some(needsUtf8Search)
    const searchCmd = useUtf8 ? `UID SEARCH CHARSET UTF-8 ${crit.join(' ')}` : `UID SEARCH ${crit.join(' ')}`
    let searchResp
    try { searchResp = await client.send(searchCmd) }
    catch (e) {                                    // 服务端不支持 CHARSET UTF-8 → 降级到 ASCII SEARCH
      if (useUtf8) searchResp = await client.send(`UID SEARCH ${crit.join(' ')}`)
      else throw e
    }
    const uidMatch = searchResp.match(/\* SEARCH([\d\s]*)/i)
    const uids = (uidMatch ? uidMatch[1] : '').trim().split(/\s+/).filter(Boolean).map(Number)
    if (!uids.length) { client.quit(); return { emails: [], nextCursor: null, totalMatched: 0 } }

    // 新邮件在前(UID 大的在前);按 cursor 分页
    const sorted = uids.slice().sort((a, b) => b - a)
    const slice = sorted.slice(cursor, cursor + limit)
    if (!slice.length) { client.quit(); return { emails: [], nextCursor: null, totalMatched: sorted.length } }

    const take = slice.join(',')
    // BODY.PEEK[] 拿全文(含附件);PEEK 不置 \Seen 标记
    const fetchResp = await client.send(`UID FETCH ${take} (UID BODY.PEEK[])`)
    client.quit()

    const msgs = extractMessages(fetchResp)
    // FETCH 响应顺序不一定按请求顺序 → 按 UID 对回我们的 slice 排序
    const byUid = {}
    for (const m of msgs) if (m.uid != null) byUid[m.uid] = m

    const emails = []
    for (const uid of slice) {
      const m = byUid[uid]; if (!m) continue
      try {
        const parsed = parseRfc822(m.raw)
        const summary = (parsed.text || stripHtml(parsed.html)).replace(/\s+/g, ' ').slice(0, 600)
        const attMeta = parsed.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size }))
        emails.push({
          uid, seq: m.seq, folder,                 // folder:跨文件夹寻址(get_full/reply 回查时知道去哪个文件夹)
          from: parsed.from, subject: parsed.subject, date: parsed.date,
          messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references,
          text: parsed.text, html: parsed.html,
          attachments: attMeta,
          _rawAttachments: parsed.attachments,    // 主进程内部用,A3 会写盘
          body: summary, bodySummary: summary,    // 向后兼容老代码的 e.body
        })
      } catch (e) { emails.push({ uid, seq: m.seq, error: '解析失败: ' + e.message }) }
    }
    const nextCursor = sorted.length > cursor + limit ? cursor + limit : null
    return { emails, nextCursor, totalMatched: sorted.length }
  } catch (e) { client.quit(); throw e }
}

// ── IMAP 会话辅助:open/login/select → fn → quit ────────────────────────
async function _withImap(cfg, fn) {
  if (!cfg || !cfg.host || !cfg.user) throw new Error('邮件服务器未配置')
  const pass = decryptPass(cfg.passEncrypted)
  if (!pass) throw new Error('邮件密码未配置')
  const client = new ImapClient()
  await client.connect(cfg.host, cfg.port || 993, cfg.secure !== false, cfg.allowSelfSigned)
  try {
    await client.send(`LOGIN ${imapQuote(cfg.user)} ${imapQuote(pass)}`)
    await client.send('SELECT INBOX')
    return await fn(client)
  } finally { client.quit() }
}

// 一组 messageIds → 对应 INBOX 内的 UIDs(未找到的丢弃)
async function _uidsForMessageIds(client, messageIds) {
  const out = []
  for (const mid of messageIds || []) {
    const stripped = String(mid || '').replace(/^<|>$/g, '')
    if (!stripped) continue
    const wrapped = '<' + stripped + '>'
    const r = await client.send(`UID SEARCH HEADER "Message-ID" ${imapQuote(wrapped)}`)
    const match = r.match(/\* SEARCH([\d\s]*)/i)
    const uids = (match ? match[1] : '').trim().split(/\s+/).filter(Boolean).map(Number)
    for (const u of uids) out.push({ messageId: stripped, uid: u })
  }
  return out
}

// ── 批量标已读 ─────────────────────────────────────────────────────────
async function markRead(cfg, messageIds) {
  return _withImap(cfg, async (client) => {
    const found = await _uidsForMessageIds(client, messageIds)
    if (!found.length) return { marked: [], notFound: messageIds || [] }
    const uids = found.map((f) => f.uid).join(',')
    await client.send(`UID STORE ${uids} +FLAGS (\\Seen)`)
    const markedIds = found.map((f) => f.messageId)
    return { marked: markedIds, notFound: (messageIds || []).filter((m) => !markedIds.includes(String(m).replace(/^<|>$/g, ''))) }
  })
}

// ── 批量归档(移动到指定文件夹,默认 "Archive";支持 MOVE 不行就 COPY+\Deleted+EXPUNGE)─
async function archiveMessages(cfg, messageIds, folder) {
  const target = folder || 'Archive'
  return _withImap(cfg, async (client) => {
    const found = await _uidsForMessageIds(client, messageIds)
    if (!found.length) return { moved: [], notFound: messageIds || [] }
    const uids = found.map((f) => f.uid).join(',')
    try { await client.send(`UID MOVE ${uids} ${imapQuote(target)}`) }
    catch (e) {                                  // 不支持 MOVE → 退化到 COPY+DEL+EXPUNGE
      try { await client.send(`UID COPY ${uids} ${imapQuote(target)}`) }
      catch (e2) { throw new Error('归档失败,文件夹 "' + target + '" 可能不存在: ' + e2.message) }
      await client.send(`UID STORE ${uids} +FLAGS (\\Deleted)`)
      try { await client.send(`UID EXPUNGE ${uids}`) }
      catch { await client.send('EXPUNGE') }    // 服务端不支持 UID EXPUNGE,退化全库 EXPUNGE
    }
    const movedIds = found.map((f) => f.messageId)
    return { moved: movedIds, folder: target, notFound: (messageIds || []).filter((m) => !movedIds.includes(String(m).replace(/^<|>$/g, ''))) }
  })
}

// ── 列出服务器上的文件夹(IMAP LIST)──────────────────────────────────────
// 返回 [{ name, selectable, flags }]。给 agent 选目标文件夹 / 校验文件夹名用
async function listFolders(cfg) {
  if (!cfg || !cfg.host || !cfg.user) throw new Error('邮件服务器未配置')
  const pass = decryptPass(cfg.passEncrypted)
  if (!pass) throw new Error('邮件密码未配置')
  const client = new ImapClient()
  await client.connect(cfg.host, cfg.port || 993, cfg.secure !== false, cfg.allowSelfSigned)
  try {
    await client.send(`LOGIN ${imapQuote(cfg.user)} ${imapQuote(pass)}`)
    const resp = await client.send('LIST "" "*"')
    // 形如:* LIST (\HasNoChildren) "/" "INBOX"   或   * LIST (\Noselect) "/" "[Gmail]"
    const re = /^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/gm
    const out = []; const seen = new Set(); let m
    while ((m = re.exec(resp))) {
      const flags = (m[1] || '').trim()
      const name = (m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3]) || ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push({ name, selectable: !/\\Noselect/i.test(flags), flags })
    }
    return out
  } finally { client.quit() }
}

// ── APPEND 一封刚发出去的邮件到 IMAP Sent 文件夹 ────────────────────────
async function appendToSent(cfg, folder, mimeStr) {
  return _withImap(cfg, async (client) => {
    await client.sendAppend(folder || 'Sent', mimeStr, '\\Seen')
  })
}

// ── 按 Message-ID 抓单封邮件(给 mail_get_full / mail_reply 兜底用)──────
// 缓存没命中时走这个;在 INBOX 里搜 HEADER "Message-ID" "<msgid>"
async function fetchByMessageId(cfg, messageId, folder) {
  if (!messageId) throw new Error('messageId 为空')
  if (!cfg || !cfg.host || !cfg.user) throw new Error('邮件服务器未配置')
  const pass = decryptPass(cfg.passEncrypted)
  if (!pass) throw new Error('邮件密码未配置')
  folder = String(folder || 'INBOX')
  const client = new ImapClient()
  await client.connect(cfg.host, cfg.port || 993, cfg.secure !== false, cfg.allowSelfSigned)
  try {
    await client.send(`LOGIN ${imapQuote(cfg.user)} ${imapQuote(pass)}`)
    await client.send(`SELECT ${imapQuote(folder)}`)
    const mid = '<' + String(messageId).replace(/^<|>$/g, '') + '>'
    const searchResp = await client.send(`UID SEARCH HEADER "Message-ID" ${imapQuote(mid)}`)
    const uidMatch = searchResp.match(/\* SEARCH([\d\s]*)/i)
    const uids = (uidMatch ? uidMatch[1] : '').trim().split(/\s+/).filter(Boolean)
    if (!uids.length) { client.quit(); return null }
    const uid = uids[uids.length - 1]
    const fetchResp = await client.send(`UID FETCH ${uid} (UID BODY.PEEK[])`)
    client.quit()
    const msgs = extractMessages(fetchResp)
    if (!msgs.length) return null
    const parsed = parseRfc822(msgs[0].raw)
    return {
      uid: +uid, folder,
      from: parsed.from, subject: parsed.subject, date: parsed.date,
      messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references,
      text: parsed.text, html: parsed.html,
      attachments: parsed.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size })),
      _rawAttachments: parsed.attachments,
    }
  } catch (e) { client.quit(); throw e }
}

// ── IMAP IDLE 实时监听(新邮件准实时提醒)─────────────────────────────────
// 长连接挂在 SELECT INBOX 上,服务器有新邮件即推 `* N EXISTS`。检测到 EXISTS 增长 → onNew(增量)。
// 自管理:每 25 分钟主动重连(绕开服务器 29 分钟 IDLE 上限)+ 断线退避重连。best-effort —
// 重连间隙漏掉的由 30 分钟轮询 / 每日摘要兜底,不追求一封不漏。
function createIdleWatcher(cfg, { onNew, log } = {}) {
  const logp = (m) => { try { log && log('[idle] ' + m) } catch {} }
  if (!cfg || !cfg.host || !cfg.user) { logp('IMAP 未配置,IDLE 不启动'); return { stop() {} } }
  const pass = decryptPass(cfg.passEncrypted)
  let stopped = false, sock = null, buf = '', state = 'greet', lastExists = null
  let renewTimer = null, reconnectTimer = null

  function cleanup() {
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null }
    try { if (sock) { sock.removeAllListeners(); sock.destroy() } } catch {}
    sock = null; buf = ''; state = 'greet'
  }
  function reconnect(ms) {
    if (stopped || reconnectTimer) return
    cleanup()
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, ms || 8000)
    if (reconnectTimer.unref) reconnectTimer.unref()
  }
  function startIdle() {
    state = 'idle'; try { sock.write('A3 IDLE\r\n') } catch (e) { return reconnect() }
    if (renewTimer) clearTimeout(renewTimer)
    renewTimer = setTimeout(() => { logp('renew'); reconnect(100) }, 25 * 60 * 1000)   // 重连刷新 IDLE
    if (renewTimer.unref) renewTimer.unref()
  }
  function onLine(line) {
    const ex = line.match(/^\* (\d+) EXISTS/i)
    if (state === 'greet') {
      if (/^\* (OK|PREAUTH)/.test(line)) { state = 'auth'; sock.write('A1 LOGIN ' + imapQuote(cfg.user) + ' ' + imapQuote(pass) + '\r\n') }
      else { logp('greeting 拒绝: ' + line.slice(0, 60)); reconnect(30000) }
    } else if (state === 'auth') {
      if (/^A1 OK/i.test(line)) { state = 'select'; sock.write('A2 SELECT INBOX\r\n') }
      else if (/^A1 (NO|BAD)/i.test(line)) { logp('登录失败,停止 IDLE(检查账号密码): ' + line.slice(0, 80)); stop() }   // 凭据错就别死循环重连
    } else if (state === 'select') {
      if (ex) lastExists = +ex[1]
      if (/^A2 OK/i.test(line)) { logp('IDLE 就绪,INBOX=' + lastExists); startIdle() }
      else if (/^A2 (NO|BAD)/i.test(line)) { logp('SELECT 失败'); reconnect(30000) }
    } else if (state === 'idle') {
      if (line[0] === '+') return                               // "+ idling" 续行
      if (ex) {
        const n = +ex[1]
        if (lastExists != null && n > lastExists) { logp('新邮件 ' + lastExists + '→' + n); try { onNew && onNew(n - lastExists) } catch (e) { logp('onNew err ' + e.message) } }
        lastExists = n
      }
      // 其它未请求响应(EXPUNGE/FETCH/“* OK Still here”)忽略
    }
  }
  function connect() {
    if (stopped) return
    if (!pass) { logp('密码未配置,IDLE 不启动'); return }
    cleanup()
    try {
      sock = cfg.secure !== false
        ? tls.connect(+cfg.port || 993, cfg.host, { rejectUnauthorized: !cfg.allowSelfSigned })
        : net.connect(+cfg.port || 143, cfg.host)
    } catch (e) { logp('connect 异常: ' + e.message); return reconnect(15000) }
    sock.setEncoding('latin1')
    sock.on('error', (e) => { logp('socket err: ' + e.message); reconnect(15000) })
    sock.on('close', () => { if (!stopped) reconnect(8000) })
    sock.on('data', (c) => {
      buf += c; let nl
      while ((nl = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 2); try { onLine(line) } catch (e) { logp('onLine err: ' + e.message) } }
    })
    state = 'greet'
  }
  function stop() { stopped = true; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null } cleanup() }

  connect()
  return { stop }
}

// ── 格式化为 LLM Prompt(向后兼容)─────────────────────────────────────
function formatEmailPrompt(emails) {
  if (!emails.length) return ''
  const lines = emails.map((e, i) => {
    const att = (e.attachments && e.attachments.length)
      ? `\n附件:${e.attachments.map((a) => `${a.filename}(${a.mime}, ${Math.round(a.size / 1024)}KB)`).join(', ')}`
      : ''
    return `### 邮件 ${i + 1}\n发件人:${e.from}\n主题:${e.subject}\n时间:${e.date}${att}\n正文摘录:\n${e.body || e.bodySummary || '(无正文)'}`
  }).join('\n\n---\n\n')
  return `<未读邮件(共 ${emails.length} 封)>\n${lines}\n</未读邮件>\n\n` +
    `请完成以下任务:\n` +
    `1. 对每封邮件用 1-2 句话摘要(发件人 · 主题 · 核心内容)\n` +
    `2. 提取需要我跟进的事项,每条严格用以下格式输出(便于系统识别):\n` +
    `   TODO: [高/中/低] [来自:发件人姓名] 具体要做的事\n` +
    `3. 最后给一个今日建议优先级排序\n`
}

// ── 密码加解密(Electron safeStorage)───────────────────────────────────
// 当前环境(OS keychain)能否加密。false → 密码只能明文落盘,UI 必须告警
function encryptionAvailable() {
  try { const { safeStorage } = require('electron'); return !!safeStorage.isEncryptionAvailable() } catch { return false }
}
function encryptPass(plain) {
  try {
    const { safeStorage } = require('electron')
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64')
  } catch {}
  return plain   // 无法加密 → 明文回退(encryptionAvailable() 会让 UI 红字提示用户)
}
function decryptPass(stored) {
  if (!stored) return ''
  try {
    const { safeStorage } = require('electron')
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {}
  return stored
}

// ── SMTP 邮件组装工具 ───────────────────────────────────────────────────
const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// text → 简单 HTML(用户硬约束:发邮件必须有 html 段,Outlook 才显格式)
function textToHtml(t) {
  return '<div style="white-space:pre-wrap;font-family:Calibri,Arial,微软雅黑,sans-serif;font-size:11pt;line-height:1.5">'
    + _esc(t).replace(/\r?\n/g, '<br>')
    + '</div>'
}
// base64 + 76 字节折行(RFC 5322)
function b64lines(buf) {
  const b64 = (Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')).toString('base64')
  return (b64.match(/.{1,76}/g) || ['']).join('\r\n')
}
const _rnd = (n) => crypto.randomBytes(n).toString('hex')

// 编码主题/附件名(RFC 2047):非 ASCII → =?UTF-8?B?xxx?=
function encWord(s) {
  s = String(s || '')
  if (/^[\x00-\x7F]*$/.test(s)) return s
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='
}
// 附件 filename:ASCII 走 filename="x",非 ASCII 走 RFC 2231 filename*=UTF-8''xxx
function fnHeader(name) {
  if (/^[\x00-\x7F]*$/.test(name)) return 'filename="' + name.replace(/"/g, '\\"') + '"'
  return "filename*=UTF-8''" + encodeURIComponent(name)
}

// 组一个 MIME part(text/plain 或 text/html),固定 base64 CTE(8bit 字符安全)
function mimeTextPart(mime, charset, content) {
  return [
    'Content-Type: ' + mime + '; charset=' + charset,
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(content),
  ].join('\r\n')
}
function mimeFilePart(filename, mime, bytes) {
  const nameW = encWord(filename)
  return [
    'Content-Type: ' + mime + '; name="' + nameW + '"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; ' + fnHeader(filename) + (nameW !== filename ? '; ' + 'filename="' + nameW + '"' : ''),
    '',
    b64lines(bytes),
  ].join('\r\n')
}

// 给定 msg 组完整邮件(headers + body)
//   msg: { to, cc, bcc, subject, text, html, attachments:[{path,filename?,mime?}], inReplyTo, references, from, messageId }
//   返回完整 RFC 5322 邮件文本(以 \r\n 分隔,无末尾换行)
function buildMime(msg, fromAddr) {
  const tos = Array.isArray(msg.to) ? msg.to : [msg.to]
  // text + html 至少有一个;两个都没就退化为空字符串
  const text = msg.text != null ? String(msg.text) : (msg.html ? stripHtml(msg.html) : '')
  // 硬约束:即使只传 text 也必须有 html → 自动生成
  const html = msg.html != null ? String(msg.html) : (text ? textToHtml(text) : '')

  // 加载附件(读盘)
  const atts = []
  for (const att of (msg.attachments || [])) {
    try {
      const bytes = fs.readFileSync(att.path)
      atts.push({
        filename: att.filename || path.basename(att.path),
        mime: att.mime || guessMime(att.filename || att.path),
        bytes,
      })
    } catch (e) { throw new Error('读附件失败 ' + att.path + ': ' + e.message) }
  }

  // 通用 headers
  const headers = []
  headers.push('From: ' + fromAddr)
  headers.push('To: ' + tos.join(', '))
  if (msg.cc)  headers.push('Cc: '  + (Array.isArray(msg.cc)  ? msg.cc.join(', ')  : msg.cc))
  // Bcc 不进 headers,只走 RCPT TO(smtpSend 单独处理)
  headers.push('Subject: ' + encWord(msg.subject || ''))
  headers.push('Date: ' + new Date().toUTCString())
  if (msg.messageId) headers.push('Message-ID: <' + String(msg.messageId).replace(/^<|>$/g, '') + '>')
  if (msg.inReplyTo) headers.push('In-Reply-To: <' + String(msg.inReplyTo).replace(/^<|>$/g, '') + '>')
  if (msg.references && msg.references.length) {
    const refs = (Array.isArray(msg.references) ? msg.references : [msg.references])
      .map((r) => '<' + String(r).replace(/^<|>$/g, '') + '>').join(' ')
    headers.push('References: ' + refs)
  }
  headers.push('MIME-Version: 1.0')

  // 双段 alternative(text + html)
  const altB = 'ALT_' + _rnd(8)
  const altBody = [
    '--' + altB,
    mimeTextPart('text/plain', 'UTF-8', text),
    '',
    '--' + altB,
    mimeTextPart('text/html',  'UTF-8', html),
    '',
    '--' + altB + '--',
  ].join('\r\n')

  if (!atts.length) {
    // 无附件:顶层就是 multipart/alternative
    headers.push('Content-Type: multipart/alternative; boundary="' + altB + '"')
    return headers.join('\r\n') + '\r\n\r\n' + altBody
  }

  // 有附件:multipart/mixed 包 alternative + 附件
  const mixB = 'MIX_' + _rnd(8)
  headers.push('Content-Type: multipart/mixed; boundary="' + mixB + '"')
  const parts = [
    '--' + mixB,
    'Content-Type: multipart/alternative; boundary="' + altB + '"',
    '',
    altBody,
    '',
  ]
  for (const a of atts) {
    parts.push('--' + mixB)
    parts.push(mimeFilePart(a.filename, a.mime, a.bytes))
    parts.push('')
  }
  parts.push('--' + mixB + '--')
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')
}

// 极简 MIME 猜测(按扩展名)
function guessMime(name) {
  const ext = path.extname(name || '').toLowerCase()
  const map = {
    '.pdf':'application/pdf', '.doc':'application/msword',
    '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls':'application/vnd.ms-excel',
    '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt':'application/vnd.ms-powerpoint',
    '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip':'application/zip', '.rar':'application/x-rar-compressed',
    '.txt':'text/plain', '.csv':'text/csv', '.html':'text/html', '.json':'application/json',
    '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  }
  return map[ext] || 'application/octet-stream'
}

// ── SMTP:连接 + AUTH + 发送(支持 multipart/alternative + 附件)──────────
//   可选参数 prebuiltMime — 调用方已经构造好 mime 字符串(可复用给 APPEND-Sent 等)
function smtpSend(cfg, msg, prebuiltMime) {
  return new Promise((resolve, reject) => {
    const host = cfg.host, port = +cfg.port || 587
    const user = cfg.user, pass = decryptPass(cfg.passEncrypted)
    if (!host || !user) return reject(new Error('SMTP 未配置(host/user 缺失)'))
    if (!pass) return reject(new Error('SMTP 密码未配置'))
    const useTLS = !!cfg.secure
    const tlsOpts = { rejectUnauthorized: !cfg.allowSelfSigned, host }
    let sock, buf = '', onResp = null, finished = false
    const timer = setTimeout(() => done(new Error('SMTP 超时(60s)')), 60000)    // 大附件给 60s
    function done(err) {
      if (finished) return; finished = true
      try { sock && sock.destroy() } catch {}
      clearTimeout(timer)
      err ? reject(err) : resolve(true)
    }
    function write(line) { try { sock.write(line + '\r\n') } catch (e) { done(e) } }
    function writeRaw(s) { try { sock.write(s) } catch (e) { done(e) } }
    function expectCode(code) {
      return new Promise((res, rej) => {
        onResp = (lines) => {
          for (const ln of lines) {
            const m = ln.match(/^(\d{3})([ -])(.*)$/); if (!m) continue
            if (m[1] !== code) { onResp = null; rej(new Error('SMTP 期望 ' + code + ' 实际 ' + ln.slice(0, 120))); return }
            if (m[2] === ' ') { onResp = null; res(); return }
          }
        }
      })
    }
    // 收集 EHLO 通告的能力集(逐行 250-…,末行 250 空格结束),用于判断是否支持 STARTTLS
    function ehloCaps() {
      return new Promise((res, rej) => {
        const caps = new Set()
        onResp = (lines) => {
          for (const ln of lines) {
            const m = ln.match(/^(\d{3})([ -])(.*)$/); if (!m) continue
            if (m[1] !== '250') { onResp = null; rej(new Error('EHLO 失败: ' + ln.slice(0, 120))); return }
            const cap = (m[3].trim().split(/\s+/)[0] || '').toUpperCase(); if (cap) caps.add(cap)
            if (m[2] === ' ') { onResp = null; res(caps); return }
          }
        }
      })
    }
    function attach(s) {
      s.setEncoding('utf8')
      s.on('data', (c) => {
        buf += c
        const lines = buf.split('\r\n'); buf = lines.pop() || ''
        if (onResp && lines.length) onResp(lines)
      })
      s.on('error', done)
    }
    ;(async () => {
      try {
        sock = useTLS ? tls.connect(port, host, tlsOpts) : net.connect(port, host)
        attach(sock)
        await expectCode('220')
        write('EHLO localhost')
        const caps = await ehloCaps()
        if (!useTLS) {
          // 明文连接:服务器支持 STARTTLS 就强制升级;不支持则拒发,绝不在明文上送账号密码(防内网抓包窃凭据)
          if (caps.has('STARTTLS')) {
            write('STARTTLS'); await expectCode('220')
            sock.removeAllListeners('data'); sock.removeAllListeners('error')
            sock = tls.connect({ ...tlsOpts, socket: sock })
            buf = ''; onResp = null; attach(sock)
            await new Promise((r, rj) => { sock.once('secureConnect', r); sock.once('error', rj) })
            write('EHLO localhost'); await expectCode('250')
          } else {
            throw new Error('SMTP 服务器未通告 STARTTLS,拒绝在明文连接上发送账号密码;请在设置里把 SMTP 改成 TLS(常见 465 端口),或确认服务器支持加密')
          }
        }
        write('AUTH LOGIN'); await expectCode('334')
        write(Buffer.from(user).toString('base64')); await expectCode('334')
        write(Buffer.from(pass).toString('base64')); await expectCode('235')
        const from = msg.from || user
        const tos = Array.isArray(msg.to) ? msg.to : [msg.to]
        const ccs = msg.cc ? (Array.isArray(msg.cc) ? msg.cc : [msg.cc]) : []
        const bccs = msg.bcc ? (Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc]) : []
        write('MAIL FROM:<' + from + '>'); await expectCode('250')
        for (const to of [...tos, ...ccs, ...bccs]) { write('RCPT TO:<' + to + '>'); await expectCode('250') }
        write('DATA'); await expectCode('354')
        // 组邮件(或用调用方传的预构 mime)+ 点行转义 + 末尾 .\r\n
        const mime = prebuiltMime || buildMime(msg, from)
        const dotstuffed = mime.replace(/(\r\n|^)\./g, '$1..')
        writeRaw(dotstuffed + '\r\n.\r\n')
        await expectCode('250')
        write('QUIT')
        setTimeout(() => done(null), 100)
      } catch (e) { done(e) }
    })()
  })
}

async function sendMail(cfg, msg) {
  if (!msg || !msg.to || !msg.subject) throw new Error('需要 to + subject')
  // 先建 mime,SMTP 用它发,同时返回给调用方(给 A5-d APPEND-Sent 复用,免再 build 一次)
  const from = msg.from || cfg.user
  const mime = buildMime(msg, from)
  await smtpSend(cfg, msg, mime)
  return { ok: true, to: msg.to, subject: msg.subject, at: Date.now(), mime, from }
}

module.exports = {
  fetchUnread, fetchByMessageId, listFolders, markRead, archiveMessages, appendToSent,
  createIdleWatcher,
  formatEmailPrompt, encryptPass, decryptPass, encryptionAvailable, sendMail,
  // 暴露解析工具给后续阶段(A2-b mail_get_full、A3 附件保存、A5 reply 拼 quote)用
  parseRfc822, decodeBytes, decodeWords, stripHtml,
  // SMTP/MIME 辅助:A5-c 回复时拼 HTML quote、A5-d APPEND 到 Sent 文件夹用
  buildMime, textToHtml,
  // 内部件,仅供回归测试(mail-parse-selftest)钉住 _drain↔extractMessages 的 literal 契约
  __test: { ImapClient, extractMessages, parseRfc822 },
}
