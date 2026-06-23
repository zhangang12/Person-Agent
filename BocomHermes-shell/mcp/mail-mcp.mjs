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
  { name: 'mail_send', description: '发送一封邮件(text/plain UTF-8)。to 可以是字符串或数组;cc 可选;失败抛错。', inputSchema: { type: 'object', properties: { to: { type: 'string', description: '收件人,多个用逗号分隔' }, subject: { type: 'string' }, text: { type: 'string', description: '邮件正文(text/plain)' }, cc: { type: 'string', description: '可选抄送,多个用逗号' } }, required: ['to', 'subject', 'text'] } },
  { name: 'mail_reply', description: '回复某封刚读的邮件(基于 mail_list 拿到的 subject + from)。会自动加 "Re: " 前缀(若没有)、自动 To 原发件人,你只填 text(回复正文)。', inputSchema: { type: 'object', properties: { originalSubject: { type: 'string', description: '原邮件主题' }, originalFrom: { type: 'string', description: '原邮件发件人(直接传 from 字段,会自动提邮箱地址)' }, text: { type: 'string', description: '回复正文' } }, required: ['originalSubject', 'originalFrom', 'text'] } },
  { name: 'todo_add', description: '加一条待办。urgency 可选 高/中/低(默认中)。可关联邮件:传 mailSubject/mailDate/mailBody 元信息,待办面板能展开看原邮件。', inputSchema: { type: 'object', properties: { text: { type: 'string' }, from: { type: 'string', description: '来源(发件人 / 项目 / 自填)' }, urgency: { type: 'string', enum: ['高', '中', '低'] }, mailSubject: { type: 'string' }, mailDate: { type: 'string' }, mailBody: { type: 'string' } }, required: ['text'] } },
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
      const header = `命中 ${r.totalMatched} 封,本次返回 ${emails.length} 封${r.nextCursor != null ? ` · 下一页 cursor=${r.nextCursor}` : ' · 已到末尾'}:`
      const body = emails.map((e, i) => {
        const att = (e.attachments && e.attachments.length)
          ? `\n  附件: ${e.attachments.map((x) => `${x.filename}(${Math.round(x.size / 1024)}KB)`).join(', ')}` : ''
        return `\n#${i + 1}  ${e.date || ''}  [msgId:${e.messageId || '?'}]\n  发件人: ${e.from}\n  主题: ${e.subject}${att}\n  正文摘要: ${(e.body || '').slice(0, 300).replace(/\s+/g, ' ')}`
      }).join('\n')
      return header + body + '\n\n(提示:要回复某封 → mail_reply 用上面的 msgId;要看全文 → mail_get_full)'
    } catch (e) { return 'mail_list 失败: ' + e.message }
  }
  if (name === 'mail_send') {
    try {
      const tos = String(a.to).split(/[,;]\s*/).filter(Boolean)
      const ccs = a.cc ? String(a.cc).split(/[,;]\s*/).filter(Boolean) : []
      await relayPost('/mail/send', { to: tos, cc: ccs, subject: a.subject, text: a.text })
      return `✓ 已发送 → ${tos.join(', ')}  · 主题: ${a.subject}`
    } catch (e) { return 'mail_send 失败: ' + e.message }
  }
  if (name === 'mail_reply') {
    const to = extractEmail(a.originalFrom)
    if (!to) return '(无法从 originalFrom 提取邮箱地址: ' + a.originalFrom + ')'
    const sub = /^re:/i.test(a.originalSubject || '') ? a.originalSubject : ('Re: ' + (a.originalSubject || ''))
    try { await relayPost('/mail/send', { to, subject: sub, text: a.text }); return `✓ 已回复 → ${to}  · 主题: ${sub}` }
    catch (e) { return 'mail_reply 失败: ' + e.message }
  }
  if (name === 'todo_add') {
    const list = loadTodos()
    if (list.some((t) => t.text === a.text && t.from === (a.from || ''))) return '(已存在同 text+from 的待办,跳过)'
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const todo = {
      id, text: String(a.text || '').slice(0, 200), from: String(a.from || ''),
      urgency: a.urgency || '中', done: false, createdAt: Date.now(),
      source: a.mailSubject ? 'email' : 'agent',
      mailSubject: a.mailSubject ? String(a.mailSubject).slice(0, 200) : '',
      mailDate: a.mailDate ? String(a.mailDate).slice(0, 50) : '',
      mailBody: a.mailBody ? String(a.mailBody).slice(0, 2000) : '',
    }
    list.unshift(todo); saveTodos(list)
    return `✓ 待办已加 (id=${id}) — [${todo.urgency}] ${todo.text}${todo.from ? ' (来自 ' + todo.from + ')' : ''}`
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
