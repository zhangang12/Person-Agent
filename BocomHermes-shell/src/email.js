'use strict'
// 极简 IMAP 只读客户端 —— 零外部依赖，使用 Node.js 内置 tls/net
// 只实现邮件摘要所需的命令：LOGIN / SELECT / SEARCH / FETCH / LOGOUT
const tls = require('tls')
const net = require('net')

const TIMEOUT = 25000
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── IMAP 连接（命令队列 + literal 处理）──────────────────────────────────────
class ImapClient {
  constructor() {
    this._sock = null
    this._buf = ''
    this._tagN = 0
    this._inLiteral = 0   // 剩余需读的 literal 字节数
    this._respStr = ''    // 当前命令的累积响应文本
    this._pending = null  // { tag, resolve, reject }
  }

  connect(host, port, secure, allowSelf) {
    return new Promise((resolve, reject) => {
      const sock = secure
        ? tls.connect(+port || 993, host, { rejectUnauthorized: !allowSelf })
        : net.connect(+port || 143, host)
      this._sock = sock
      sock.setEncoding('utf8')
      sock.setTimeout(TIMEOUT)
      sock.on('timeout', () => sock.destroy(new Error('IMAP 连接超时（' + TIMEOUT / 1000 + 's）')))
      sock.on('error', (e) => {
        const p = this._pending; if (p) { this._pending = null; p.reject(e) }
        else reject(e)
      })
      // 等待 greeting（首行）
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
      // literal 标记：行尾 {NNN}
      const litM = line.match(/\{(\d+)\}$/)
      if (litM) {
        this._inLiteral = parseInt(litM[1])
        this._respStr += line.slice(0, -litM[0].length) + '\n'
        continue
      }
      this._respStr += line + '\n'
      if (!this._pending) continue
      const tag = this._pending.tag
      if (line.startsWith(tag + ' OK') || line.toLowerCase().startsWith(tag + ' ok')) {
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

// ── RFC 2047 解码（=?charset?B/Q?...?=）───────────────────────────────────
function decodeWords(s) {
  if (!s) return ''
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    try {
      const cs = charset.toLowerCase()
      if (enc.toUpperCase() === 'B') {
        const buf = Buffer.from(data, 'base64')
        return cs.includes('gb') ? buf.toString('binary') : buf.toString('utf8')
      } else {
        const raw = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)))
        return cs.includes('gb') ? Buffer.from(raw, 'binary').toString('binary') : raw
      }
    } catch { return data }
  })
}

// ── HTML strip + 截断 ──────────────────────────────────────────────────────
function extractText(raw, max) {
  const text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

// ── 解析 FETCH 响应，提取邮件列表 ──────────────────────────────────────────
function parseEmails(resp) {
  const emails = []
  // 按 "* N FETCH" 分割，slice(1) 跳过第一个空元素
  const blocks = resp.split(/\* \d+ FETCH /).slice(1)
  for (const block of blocks) {
    try {
      // Header block（BODY[HEADER...] 到下一个 BODY[TEXT] 或行末）
      const hMatch = block.match(/BODY\[HEADER[^\]]*\][^\n]*\n([\s\S]*?)(?=\n BODY\[TEXT|\nA\d{3} |\n\)$)/i)
      // Body text block（BODY[TEXT] 之后）
      const bMatch = block.match(/BODY\[TEXT\][^\n]*\n([\s\S]*?)(?=\n\)\n|\nA\d{3} |\n$)/i)
      const hRaw = hMatch ? hMatch[1] : ''
      const bRaw = bMatch ? bMatch[1] : ''
      const from    = decodeWords((hRaw.match(/^From:\s*(.+)/mi) || [])[1] || '').trim()
      const subject = decodeWords((hRaw.match(/^Subject:\s*(.+)/mi) || [])[1] || '').trim()
      const date    = ((hRaw.match(/^Date:\s*(.+)/mi) || [])[1] || '').trim()
      const body    = extractText(bRaw, 600)
      if (from || subject) emails.push({ from, subject, date, body })
    } catch {}
  }
  return emails
}

// ── 格式化为 LLM Prompt ────────────────────────────────────────────────────
function formatEmailPrompt(emails) {
  if (!emails.length) return ''
  const lines = emails.map((e, i) =>
    `### 邮件 ${i + 1}\n发件人：${e.from}\n主题：${e.subject}\n时间：${e.date}\n正文摘录：\n${e.body || '（无正文）'}`
  ).join('\n\n---\n\n')
  return `<未读邮件（共 ${emails.length} 封）>\n${lines}\n</未读邮件>\n\n` +
    `请完成以下任务：\n` +
    `1. 对每封邮件用 1-2 句话摘要（发件人 · 主题 · 核心内容）\n` +
    `2. 提取需要我跟进的事项，每条严格用以下格式输出（便于系统识别）：\n` +
    `   TODO: [高/中/低] [来自：发件人姓名] 具体要做的事\n` +
    `3. 最后给一个今日建议优先级排序\n`
}

// ── 密码加解密（Electron safeStorage）──────────────────────────────────────
function encryptPass(plain) {
  try {
    const { safeStorage } = require('electron')
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64')
  } catch {}
  return plain   // 降级：明文（不推荐，日志里不会打印）
}
function decryptPass(stored) {
  if (!stored) return ''
  try {
    const { safeStorage } = require('electron')
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {}
  return stored
}

// ── 主接口：拉取未读邮件 ───────────────────────────────────────────────────
async function fetchUnread(cfg) {
  if (!cfg || !cfg.host || !cfg.user) throw new Error('邮件服务器未配置（host/user 缺失）')
  const pass = decryptPass(cfg.passEncrypted)
  if (!pass) throw new Error('邮件密码未配置')

  const client = new ImapClient()
  await client.connect(cfg.host, cfg.port || 993, cfg.secure !== false, cfg.allowSelfSigned)

  try {
    // LOGIN（用引号包裹，转义引号）
    await client.send(`LOGIN "${cfg.user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`)
    await client.send('SELECT INBOX')

    // SEARCH UNSEEN SINCE 昨天（取最近 1 天未读）
    const since = new Date(Date.now() - 24 * 3600 * 1000)
    const dateStr = `${since.getDate()}-${MONTHS[since.getMonth()]}-${since.getFullYear()}`
    const searchResp = await client.send(`SEARCH UNSEEN SINCE ${dateStr}`)

    const seqMatch = searchResp.match(/SEARCH([\d\s]*)/)
    const seqs = (seqMatch ? seqMatch[1] : '').trim().split(/\s+/).filter(Boolean)
    if (!seqs.length) { client.quit(); return [] }

    // 最多 30 封最新的
    const take = seqs.slice(-30).join(',')
    const fetchResp = await client.send(
      `FETCH ${take} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.800>)`
    )
    client.quit()
    return parseEmails(fetchResp)
  } catch (e) {
    client.quit(); throw e
  }
}

// ── 极简 SMTP 客户端 ─────────────────────────────────────────────────────
// 零外部依赖,Node 内置 net/tls。支持:
//   · 端口 465 (implicit TLS) 直 tls.connect
//   · 端口 587/25 (STARTTLS) net.connect → EHLO → STARTTLS → 升级 TLS → EHLO → AUTH
//   · AUTH LOGIN (base64 user/pass);text/plain UTF-8 邮件
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
          // 升级 TLS,复用原 socket
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

module.exports = { fetchUnread, formatEmailPrompt, encryptPass, decryptPass, sendMail }
