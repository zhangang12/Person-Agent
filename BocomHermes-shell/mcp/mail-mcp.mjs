// BocomHermes · 邮件 + 待办 MCP(本地 stdio 服务,零依赖)
// 给 agent 这些能力:读未读邮件 / 发邮件 / 回复邮件 / 加待办 / 列待办 / 完成待办
// 邮件密码 / SMTP/IMAP 配置全从 userData/settings.json 读(用户已在设置面板配过)
// 数据全在本机,完全离线
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const log = (...a) => process.stderr.write('[mail-mcp] ' + a.join(' ') + '\n')

function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
const DATA = userData()
function loadTodos() { try { const a = JSON.parse(fs.readFileSync(path.join(DATA, 'todos.json'), 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
function saveTodos(list) { try { fs.writeFileSync(path.join(DATA, 'todos.json'), JSON.stringify(list, null, 2)) } catch (e) { log('save todos err: ' + e.message) } }
// mail-cache.jsonl 只读(metadata):agent 用 mailMsgId 加 todo 时 lookup 主题/日期/from
function lookupMailCache(messageId) {
  if (!messageId) return null
  const fp = path.join(DATA, 'mail-cache.jsonl')
  if (!fs.existsSync(fp)) return null
  const want = String(messageId).replace(/^<|>$/g, '')
  try {
    const lines = fs.readFileSync(fp, 'utf8').split('\n')
    let found = null
    for (const ln of lines) {
      if (!ln.trim()) continue
      try { const o = JSON.parse(ln); if (o && o.messageId === want) found = o } catch {}
    }
    return found
  } catch { return null }
}

// 邮件 IMAP/SMTP 走主进程的本地 HTTP 中继(主进程有 electron safeStorage 能解密密码;MCP 子进程没有)
function relayCfg() { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'mail-relay.json'), 'utf8')) } catch { return null } }
function relayPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const cfg = relayCfg(); if (!cfg) return reject(new Error('找不到 mail-relay.json — 桌面智能体没在跑,先启动它'))
    const data = JSON.stringify(body || {})
    const req = http.request({ hostname: '127.0.0.1', port: cfg.port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-bocom-tok': cfg.token } }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => buf += c)
      res.on('end', () => { try { const j = JSON.parse(buf || '{}'); j.error ? reject(new Error(j.error)) : resolve(j) } catch (e) { reject(new Error('relay 响应非 JSON: ' + buf.slice(0, 200))) } })
    })
    req.on('error', (e) => reject(new Error('relay 连不上(' + cfg.port + '): ' + e.message)))
    req.write(data); req.end()
  })
}

const TOOLS = [
  { name: 'mail_list', description: '抓取邮件清单(默认最近 1 天未读,一次最多返回 10 封摘要)。每封含 from/subject/date/messageId/attachments(metadata)/body(前 600 字摘要)。长邮件全文用 mail_get_full(messageId)。', inputSchema: { type: 'object', properties: {
    from:       { type: 'string', description: '发件人邮箱或名字关键词(IMAP 服务端 FROM 筛选)' },
    subject:    { type: 'string', description: '主题关键词(IMAP 服务端 SUBJECT 筛选)' },
    days:       { type: 'number', description: '回看多少天(默认 1,信贷场景同事一般当天处理;查上周设 7)' },
    onlyUnseen: { type: 'boolean', description: '默认 true 只看未读;设 false 看所有(配合 from/subject 找历史邮件)' },
    limit:      { type: 'number', description: '本次返回多少封,默认 10,最大 30。一次性塞太多会撑爆 128K 上下文' },
    cursor:     { type: 'number', description: '分页游标。第一次不传;之后传上次返回的 nextCursor 继续翻页' },
  } } },
  { name: 'mail_send', description: '发送一封邮件(默认 multipart/alternative:text + 自动生成 html)。要保留格式发 → 传 html 字段直接发 HTML;附件传本地路径不要传 base64(base64 会撑爆 128K 上下文)。失败抛错。', inputSchema: { type: 'object', properties: {
    to:      { type: 'string', description: '收件人,多个用逗号分隔' },
    subject: { type: 'string' },
    text:    { type: 'string', description: '纯文本正文(plain 段)。没传 html 时,html 段自动用此文本生成(\\n→<br>+escape)' },
    html:    { type: 'string', description: '可选 HTML 正文。传了就直接用,不再从 text 自动生成。Outlook 会显示 HTML 段;纯文本客户端 fallback 显示 text 段' },
    cc:      { type: 'string', description: '可选抄送,多个用逗号' },
    bcc:     { type: 'string', description: '可选密抄,多个用逗号(不在收件人头里)' },
    attachments: { type: 'array', description: '附件列表(本地文件路径,主进程读盘 base64 编码)', items: { type: 'object', properties: {
      path:     { type: 'string', description: '本地文件绝对路径' },
      filename: { type: 'string', description: '可选,显示给收件人的文件名,默认取 basename(path)' },
      mime:     { type: 'string', description: '可选,默认按扩展名猜' },
    }, required: ['path'] } },
  }, required: ['to', 'subject'] } },
  { name: 'mail_get_full', description: '取某封邮件的完整正文(可分段读)。先 mail_list 拿 [msgId:xxx],再用本工具按需取全文。短邮件(<8KB)一次性给完,长邮件返回 hasMore=true,你按 nextOffset 继续取。', inputSchema: { type: 'object', properties: {
    messageId: { type: 'string', description: 'mail_list 输出里 [msgId:xxx] 的 xxx' },
    part:      { type: 'string', enum: ['text', 'html'], description: 'text=纯文本(默认,适合读内容);html=原始 HTML 源码(只在你要回复时取,mail_reply 会自动 quote 这段)' },
    offset:    { type: 'number', description: '从第几个字符开始,默认 0' },
    limit:     { type: 'number', description: '本次取多少字符,默认 8000,最大 50000。返回有 hasMore + nextOffset 让你翻下一段' },
  }, required: ['messageId'] } },
  { name: 'mail_get_attachment_text', description: '读某封邮件某个附件的文本内容(已自动提取:PDF/Word/Excel/CSV/TXT/HTML/JSON/XML;Excel 转 CSV)。支持分段。> 3MB 或非文本格式的附件无文本可读,会返回 extractError 提示。', inputSchema: { type: 'object', properties: {
    messageId: { type: 'string', description: 'mail_list 输出里 [msgId:xxx] 的 xxx' },
    filename:  { type: 'string', description: 'mail_list 或 mail_get_full 输出的附件文件名(原名,会自动 sanitize)' },
    offset:    { type: 'number', description: '从第几个字符开始,默认 0' },
    limit:     { type: 'number', description: '本次取多少字符,默认 8000,最大 50000' },
  }, required: ['messageId', 'filename'] } },
  { name: 'mail_reply', description: '回复某封邮件 — 主进程自动:① To 原发件人 ② 主题加 Re: 前缀 ③ In-Reply-To/References 头(Outlook 归并对话串)④ **HTML quote 原邮件(必带原文格式,Outlook 风格 blockquote)** ⑤ multipart/alternative 双段。你只填 messageId + text(或 html);要带附件传 attachments 路径。', inputSchema: { type: 'object', properties: {
    messageId:   { type: 'string', description: 'mail_list 输出里 [msgId:xxx] 的 xxx — 原邮件 Message-ID' },
    text:        { type: 'string', description: '你的回复正文(纯文本)。系统自动生成 HTML 版并 quote 原邮件' },
    html:        { type: 'string', description: '可选,显式 HTML 回复(传了就直接用,不再从 text 转;系统仍会在下面 quote 原邮件 HTML)' },
    cc:          { type: 'string', description: '可选抄送,多个用逗号' },
    bcc:         { type: 'string', description: '可选密抄,多个用逗号' },
    attachments: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, filename: { type: 'string' }, mime: { type: 'string' } }, required: ['path'] } },
  }, required: ['messageId'] } },
  { name: 'mail_mark_read', description: '把一批邮件标已读(IMAP +Flags \\Seen)。处理完一封别忘了标,下次 mail_list 才不会重复返回。', inputSchema: { type: 'object', properties: {
    messageIds: { type: 'array', items: { type: 'string' }, description: 'mail_list 里 [msgId:xxx] 的 xxx 列表;一次最多 30 个' },
  }, required: ['messageIds'] } },
  { name: 'mail_archive', description: '把一批邮件归档(MOVE 到指定文件夹,默认 Archive;MOVE 不支持时 COPY+DEL+EXPUNGE)。不可逆,先想清楚。', inputSchema: { type: 'object', properties: {
    messageIds: { type: 'array', items: { type: 'string' }, description: 'mail_list 里 [msgId:xxx] 的 xxx 列表' },
    folder:     { type: 'string', description: '目标文件夹,默认 "Archive"。常见: Archive / 已归档 / [Gmail]/All Mail。' },
  }, required: ['messageIds'] } },
  { name: 'todo_add', description: '加一条待办。urgency 可选 高/中/低(默认中)。关联邮件:传 mailMsgId(推荐,跨会话稳定;从 mail_list 的 [msgId:xxx] 抠出)→ 自动回填主题/日期/正文。或显式传 mailSubject/mailDate/mailBody。', inputSchema: { type: 'object', properties: { text: { type: 'string' }, from: { type: 'string', description: '来源(发件人 / 项目 / 自填)' }, urgency: { type: 'string', enum: ['高', '中', '低'] }, mailMsgId: { type: 'string', description: '关联邮件的 Message-ID(从 mail_list 输出抠);系统会自动回填邮件主题/日期/正文' }, mailSubject: { type: 'string' }, mailDate: { type: 'string' }, mailBody: { type: 'string' } }, required: ['text'] } },
  { name: 'todo_list', description: '列出所有待办(未完成在前)。可按 onlyPending 过滤。', inputSchema: { type: 'object', properties: { onlyPending: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'todo_complete', description: '把某条待办标为完成。传 id(从 todo_list 返回)。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
]

// 从 "name <email>" 或 "email" 抽出邮箱
function extractEmail(s) {
  const m = String(s || '').match(/<([^>]+)>/); if (m) return m[1].trim()
  const m2 = String(s || '').match(/[\w.\-+]+@[\w.\-]+\.\w+/); return m2 ? m2[0] : String(s || '').trim()
}

async function callTool(name, a) {
  a = a || {}
  if (name === 'mail_list') {
    try {
      const r = await relayPost('/mail/list', {
        from: a.from, subject: a.subject, days: a.days,
        onlyUnseen: a.onlyUnseen, limit: a.limit, cursor: a.cursor,
      })
      const emails = r.emails || []
      if (!emails.length) return '(无邮件命中)'
      // 查 todos.json 命中过的 mailMsgId → 标 ✓已建todo,让 agent 跳过不重复处理
      const todoMsgIds = new Set()
      for (const t of loadTodos()) if (t.mailMsgId) todoMsgIds.add(t.mailMsgId)
      const header = `命中 ${r.totalMatched} 封,本次返回 ${emails.length} 封${r.nextCursor != null ? ` · 下一页 cursor=${r.nextCursor}` : ' · 已到末尾'}:`
      const body = emails.map((e, i) => {
        const att = (e.attachments && e.attachments.length)
          ? `\n  附件: ${e.attachments.map((x) => `${x.filename}(${Math.round(x.size / 1024)}KB${x.hasText ? `,可读 ${x.textLen}字` : x.extractError ? ',✗' + x.extractError : ''})`).join(', ')}` : ''
        const processed = e.messageId && todoMsgIds.has(e.messageId) ? '  ✓已建todo' : ''
        return `\n#${i + 1}  ${e.date || ''}  [msgId:${e.messageId || '?'}]${processed}\n  发件人: ${e.from}\n  主题: ${e.subject}${att}\n  正文摘要: ${(e.body || '').slice(0, 300).replace(/\s+/g, ' ')}`
      }).join('\n')
      return header + body + '\n\n(提示:回复 → mail_reply 用 msgId;看全文 → mail_get_full;读附件 → mail_get_attachment_text;✓已建todo 的别重复处理)'
    } catch (e) { return 'mail_list 失败: ' + e.message }
  }
  if (name === 'mail_get_attachment_text') {
    try {
      const r = await relayPost('/mail/attachment', { messageId: a.messageId, filename: a.filename, offset: a.offset, limit: a.limit })
      const head = `[附件「${a.filename}」 ${r.content.length} / ${r.totalLen} 字 · 来源=${r.source === 'extracted' ? '抽取的文本' : '原始文本文件'}${r.hasMore ? ` · 继续传 offset=${r.nextOffset}` : ' · 已完整'}]\n──────────\n`
      return head + r.content
    } catch (e) { return 'mail_get_attachment_text 失败: ' + e.message }
  }
  if (name === 'mail_get_full') {
    try {
      const r = await relayPost('/mail/get', { messageId: a.messageId, part: a.part || 'text', offset: a.offset, limit: a.limit })
      const partLabel = a.part === 'html' ? 'HTML' : '文本'
      const head = `${r.from || '?'}  ·  ${r.subject || ''}  ·  ${r.date || ''}\n[${partLabel}  ${r.content.length} / ${r.totalLen} 字${r.hasMore ? `,继续传 offset=${r.nextOffset}` : ',已完整'}]\n──────────\n`
      const attLine = (r.attachments && r.attachments.length)
        ? `\n──────────\n附件:\n${r.attachments.map((x) => `  · ${x.filename}(${Math.round(x.size / 1024)}KB,${x.mime})${x.hasText ? ` [可读 ${x.textLen}字]` : x.extractError ? ` [✗ ${x.extractError}]` : ''}`).join('\n')}\n(用 mail_get_attachment_text 读)`
        : ''
      return head + r.content + attLine
    } catch (e) { return 'mail_get_full 失败: ' + e.message }
  }
  if (name === 'mail_send') {
    try {
      const tos = String(a.to).split(/[,;]\s*/).filter(Boolean)
      const ccs = a.cc  ? String(a.cc ).split(/[,;]\s*/).filter(Boolean) : []
      const bccs= a.bcc ? String(a.bcc).split(/[,;]\s*/).filter(Boolean) : []
      const atts = Array.isArray(a.attachments) ? a.attachments : []
      await relayPost('/mail/send', { to: tos, cc: ccs, bcc: bccs, subject: a.subject, text: a.text, html: a.html, attachments: atts })
      const attStr = atts.length ? ` · 附件 ${atts.length} 个` : ''
      const htmlStr = a.html ? ' [HTML]' : ''
      return `✓ 已发送 → ${tos.join(', ')}${ccs.length ? ' (cc ' + ccs.length + ')' : ''}${bccs.length ? ' (bcc ' + bccs.length + ')' : ''}  · 主题: ${a.subject}${attStr}${htmlStr}`
    } catch (e) { return 'mail_send 失败: ' + e.message }
  }
  if (name === 'mail_reply') {
    if (!a.messageId) return '(messageId 必填)'
    if (!a.text && !a.html) return '(text 或 html 至少传一个)'
    const ccs = a.cc  ? String(a.cc ).split(/[,;]\s*/).filter(Boolean) : []
    const bccs= a.bcc ? String(a.bcc).split(/[,;]\s*/).filter(Boolean) : []
    try {
      const r = await relayPost('/mail/reply', {
        messageId: a.messageId, text: a.text, html: a.html,
        cc: ccs, bcc: bccs, attachments: Array.isArray(a.attachments) ? a.attachments : [],
      })
      return `✓ 已回复 → ${r.to}  · 主题: ${r.subject}  · 自动 HTML quote 原邮件 (来自 ${r.quotedFrom})`
    } catch (e) { return 'mail_reply 失败: ' + e.message }
  }
  if (name === 'mail_mark_read') {
    try {
      const ids = Array.isArray(a.messageIds) ? a.messageIds : []
      if (!ids.length) return '(messageIds 为空)'
      const r = await relayPost('/mail/markRead', { messageIds: ids.slice(0, 30) })
      return `✓ 已标已读 ${r.marked.length} 封${r.notFound && r.notFound.length ? ` · 未找到 ${r.notFound.length} 封(可能已归档或不在 INBOX)` : ''}`
    } catch (e) { return 'mail_mark_read 失败: ' + e.message }
  }
  if (name === 'mail_archive') {
    try {
      const ids = Array.isArray(a.messageIds) ? a.messageIds : []
      if (!ids.length) return '(messageIds 为空)'
      const r = await relayPost('/mail/archive', { messageIds: ids.slice(0, 30), folder: a.folder })
      return `✓ 已归档 ${r.moved.length} 封 → ${r.folder}${r.notFound && r.notFound.length ? ` · 未找到 ${r.notFound.length} 封` : ''}`
    } catch (e) { return 'mail_archive 失败: ' + e.message }
  }
  if (name === 'todo_add') {
    const list = loadTodos()
    // mailMsgId → 查 mail-cache 补全 subject/date/from(MCP 子进程没正文,只能填 metadata)
    let cached = null, msgId = a.mailMsgId ? String(a.mailMsgId).replace(/^<|>$/g, '') : ''
    if (msgId && !a.mailSubject) cached = lookupMailCache(msgId)
    if (cached) {
      if (!a.from) a.from = cached.from || ''
      if (!a.mailSubject) a.mailSubject = cached.subject || ''
      if (!a.mailDate) a.mailDate = cached.date || ''
    }
    if (list.some((t) => t.text === a.text && t.from === (a.from || ''))) return '(已存在同 text+from 的待办,跳过)'
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const todo = {
      id, text: String(a.text || '').slice(0, 200), from: String(a.from || ''),
      urgency: a.urgency || '中', done: false, createdAt: Date.now(),
      source: (a.mailSubject || msgId) ? 'email' : 'agent',
      mailMsgId: msgId,
      mailSubject: a.mailSubject ? String(a.mailSubject).slice(0, 200) : '',
      mailDate: a.mailDate ? String(a.mailDate).slice(0, 50) : '',
      mailBody: a.mailBody ? String(a.mailBody).slice(0, 2000) : '',
    }
    list.unshift(todo); saveTodos(list)
    return `✓ 待办已加 (id=${id}) — [${todo.urgency}] ${todo.text}${todo.from ? ' (来自 ' + todo.from + ')' : ''}${todo.mailMsgId ? ' [📧 msgId=' + todo.mailMsgId.slice(0, 30) + ']' : ''}`
  }
  if (name === 'todo_list') {
    let list = loadTodos()
    if (a.onlyPending) list = list.filter((t) => !t.done)
    list = list.slice(0, +a.limit || 50)
    if (!list.length) return '(暂无待办)'
    return list.map((t) => `  ${t.done ? '✓' : '○'} [${t.urgency || '中'}] ${t.text}${t.from ? '  · 来自 ' + t.from : ''}${t.mailSubject ? '  · 📧「' + t.mailSubject.slice(0, 40) + '」' : ''}  (id=${t.id})`).join('\n')
  }
  if (name === 'todo_complete') {
    const list = loadTodos(); const t = list.find((x) => x.id === a.id)
    if (!t) return '(找不到待办 id=' + a.id + ')'
    t.done = true; t.updatedAt = Date.now(); saveTodos(list)
    return `✓ 已完成: ${t.text}`
  }
  throw new Error('未知工具: ' + name)
}

// ── MCP stdio 协议 ──
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'bocomhermes-mail', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '工具出错: ' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现: ' + method } })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle err: ' + e.message)) } })
log('ready · userData=' + DATA)
