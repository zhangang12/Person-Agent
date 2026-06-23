'use strict'
// 极简邮件客户端 —— 零外部依赖,只用 Node 内置 tls/net
//  · IMAP:LOGIN / SELECT / SEARCH / FETCH / LOGOUT(只读,不动服务器状态)
//  · SMTP:EHLO / STARTTLS / AUTH LOGIN / DATA(支持 multipart/alternative + 附件)
//  · MIME 真解析:multipart 拆 boundary、CTE 解码(base64/quoted-printable/8bit)、
//                 charset 真转码(用 Electron 自带 ICU 的 TextDecoder,支持 gb18030/gbk/gb2312)
//  · RFC 2047 主题/From 解码:走同一个 decodeBytes,避免原代码 toString('binary') 中文乱码
const tls = require('tls')
const net = require('net')

const TIMEOUT = 25000
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── 字节解码(charset 真转码)─────────────────────────────────────────────
// Electron 主进程自带完整 ICU,TextDecoder 支持 gb18030/gbk/gb2312/big5/shift_jis/euc-kr…
// 非 Electron 进程(如纯 Node MCP)调用时,不支持的字符集会降级到 utf-8
function decodeBytes(bytes, charset) {
  charset = String(charset || 'utf-8').toLowerCase().replace(/[_\s]/g, '-').trim()
  if (charset === 'gb2312' || charset === 'gbk') charset = 'gb18030'   // GB18030 是超集
  if (charset === 'us-ascii' || charset === 'ascii') charset = 'utf-8'
  if (charset === 'iso-8859-1' || charset === 'latin1') return bytes.toString('latin1')
  if (charset === 'utf-8' || charset === 'utf8') return bytes.toString('utf8')
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
  // 同 charset 的相邻 encoded-word 之间的空白要折叠
  return String(s)
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
        this._respStr += line.slice(0, -litM[0].length) + '\n'
        continue
      }
      this._respStr += line + '\n'
      if (!this._pending) continue
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

// ── 主接口:抓取未读邮件 ────────────────────────────────────────────────
// 返回 [{from, subject, date, messageId, inReplyTo, references, text, html, attachments, uid, body, bodySummary}]
//  · body  = text(原全文)
//  · bodySummary = 前 600 字摘要(向后兼容老代码的 e.body)
// 注:A1 阶段限 10 封最新未读以控制 BODY.PEEK[] 全文拉取的内网带宽。A2-a 加分页/过滤参数。
async function fetchUnread(cfg, opts) {
  if (!cfg || !cfg.host || !cfg.user) throw new Error('邮件服务器未配置(host/user 缺失)')
  const pass = decryptPass(cfg.passEncrypted)
  if (!pass) throw new Error('邮件密码未配置')
  opts = opts || {}
  const limit = Math.max(1, Math.min(+opts.limit || 10, 30))
  const days = Math.max(1, +opts.days || 1)

  const client = new ImapClient()
  await client.connect(cfg.host, cfg.port || 993, cfg.secure !== false, cfg.allowSelfSigned)
  try {
    await client.send(`LOGIN "${cfg.user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`)
    await client.send('SELECT INBOX')

    const since = new Date(Date.now() - days * 24 * 3600 * 1000)
    const dateStr = `${since.getDate()}-${MONTHS[since.getMonth()]}-${since.getFullYear()}`
    const searchResp = await client.send(`SEARCH UNSEEN SINCE ${dateStr}`)
    const seqMatch = searchResp.match(/\* SEARCH([\d\s]*)/i)
    const seqs = (seqMatch ? seqMatch[1] : '').trim().split(/\s+/).filter(Boolean)
    if (!seqs.length) { client.quit(); return [] }

    const take = seqs.slice(-limit).join(',')
    // BODY.PEEK[] 拿全文(含附件);PEEK 不置 \Seen 标记
    const fetchResp = await client.send(`FETCH ${take} (UID BODY.PEEK[])`)
    client.quit()

    const msgs = extractMessages(fetchResp)
    const emails = []
    for (const m of msgs) {
      try {
        const parsed = parseRfc822(m.raw)
        const summary = (parsed.text || stripHtml(parsed.html)).replace(/\s+/g, ' ').slice(0, 600)
        // attachments 字段对 prompt 友好:不暴露 bytes,只 metadata
        const attMeta = parsed.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size }))
        emails.push({
          uid: m.uid, seq: m.seq,
          from: parsed.from, subject: parsed.subject, date: parsed.date,
          messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references,
          text: parsed.text, html: parsed.html,
          attachments: attMeta,
          _rawAttachments: parsed.attachments,        // 主进程内部用,A3 会写盘;不要传出
          body: summary, bodySummary: summary,        // 向后兼容老代码的 e.body
        })
      } catch (e) {
        emails.push({ uid: m.uid, seq: m.seq, error: '解析失败: ' + e.message })
      }
    }
    return emails
  } catch (e) { client.quit(); throw e }
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
function encryptPass(plain) {
  try {
    const { safeStorage } = require('electron')
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64')
  } catch {}
  return plain
}
function decryptPass(stored) {
  if (!stored) return ''
  try {
    const { safeStorage } = require('electron')
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {}
  return stored
}

// ── 极简 SMTP(A1 保持原样,A5 升级 multipart/alternative + 附件)──────
function smtpSend(cfg, msg) {
  return new Promise((resolve, reject) => {
    const host = cfg.host, port = +cfg.port || 587
    const user = cfg.user, pass = decryptPass(cfg.passEncrypted)
    if (!host || !user) return reject(new Error('SMTP 未配置(host/user 缺失)'))
    if (!pass) return reject(new Error('SMTP 密码未配置'))
    const useTLS = !!cfg.secure
    const tlsOpts = { rejectUnauthorized: !cfg.allowSelfSigned, host }
    let sock, buf = '', onResp = null, finished = false
    const timer = setTimeout(() => done(new Error('SMTP 超时(30s)')), 30000)
    function done(err) {
      if (finished) return; finished = true
      try { sock && sock.destroy() } catch {}
      clearTimeout(timer)
      err ? reject(err) : resolve(true)
    }
    function write(line) { try { sock.write(line + '\r\n') } catch (e) { done(e) } }
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
        write('EHLO localhost'); await expectCode('250')
        if (!useTLS && port !== 25) {
          write('STARTTLS'); await expectCode('220')
          sock.removeAllListeners('data'); sock.removeAllListeners('error')
          sock = tls.connect({ ...tlsOpts, socket: sock })
          buf = ''; onResp = null; attach(sock)
          await new Promise((r, rj) => { sock.once('secureConnect', r); sock.once('error', rj) })
          write('EHLO localhost'); await expectCode('250')
        }
        write('AUTH LOGIN'); await expectCode('334')
        write(Buffer.from(user).toString('base64')); await expectCode('334')
        write(Buffer.from(pass).toString('base64')); await expectCode('235')
        const from = msg.from || user
        const tos = Array.isArray(msg.to) ? msg.to : [msg.to]
        write('MAIL FROM:<' + from + '>'); await expectCode('250')
        for (const to of tos) { write('RCPT TO:<' + to + '>'); await expectCode('250') }
        write('DATA'); await expectCode('354')
        const headers = []
        headers.push('From: ' + from)
        headers.push('To: ' + tos.join(', '))
        if (msg.cc) headers.push('Cc: ' + (Array.isArray(msg.cc) ? msg.cc.join(', ') : msg.cc))
        headers.push('Subject: =?UTF-8?B?' + Buffer.from(String(msg.subject || '')).toString('base64') + '?=')
        headers.push('Date: ' + new Date().toUTCString())
        headers.push('MIME-Version: 1.0')
        headers.push('Content-Type: text/plain; charset=UTF-8')
        headers.push('Content-Transfer-Encoding: 8bit')
        if (msg.inReplyTo) headers.push('In-Reply-To: ' + msg.inReplyTo)
        const text = String(msg.text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
        write(headers.join('\r\n') + '\r\n\r\n' + text + '\r\n.')
        await expectCode('250')
        write('QUIT')
        setTimeout(() => done(null), 100)
      } catch (e) { done(e) }
    })()
  })
}

async function sendMail(cfg, msg) {
  if (!msg || !msg.to || !msg.subject) throw new Error('需要 to + subject')
  await smtpSend(cfg, msg)
  return { ok: true, to: msg.to, subject: msg.subject, at: Date.now() }
}

module.exports = {
  fetchUnread, formatEmailPrompt, encryptPass, decryptPass, sendMail,
  // 暴露解析工具给后续阶段(A2-b mail_get_full、A3 附件保存、A5 reply 拼 quote)用
  parseRfc822, decodeBytes, decodeWords, stripHtml,
}
