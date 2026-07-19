// 【邮件子系统】收发/发件箱安全闸门/IMAP IDLE/本地中继/mail-cache/待办-邮件闭环/DB 只读中继。
// 从 window.js 整块搬来(行 24-458),做成 initMail(ctx) 工厂——只搬不改,init 时序 100% 不变。
// ctx 注入外部模块(email/attachments/...)+ window.js 内后定义但已提升的 function(createMailCenter 等)。
// 对外回传 3 个被 window.js 外部调用点用到的函数:effectiveSmtp/effectiveOb/startIdleWatcher。
'use strict'
const knowledge = require('./knowledge')
module.exports = function initMail(ctx) {
  const { S, app, path, fs, shell, ipcMain, log, oc, Notification, email, attachments, mailCache, emailSummarySeen, db, initOutbox, openOutbox, sendOrbState, createMailCenter, openMailView, spawnCard, spawnWorkflow, maybeSuggestMeeting, skillList, skillRun, skillRunBatch, skillPageRead, skillPageAct, skillTakeoverDone } = ctx
  // 解析"有效的" SMTP 配置:sameAsImap=true 时用户名/密码从 IMAP 取(host/port/secure 仍从 SMTP 取)
  function effectiveSmtp(S) {
    const sm = S.settings.smtp || {}
    if (!sm.host) return null
    const out = { host: sm.host, port: sm.port || 587, secure: !!sm.secure, allowSelfSigned: !!sm.allowSelfSigned, from: sm.from || '' }
    const im = S.settings.imap || {}
    if (sm.sameAsImap !== false && !sm.user) { out.user = im.user; out.passEncrypted = im.passEncrypted }
    else { out.user = sm.user; out.passEncrypted = sm.passEncrypted }
    if (!out.user || !out.passEncrypted) return null
    if (!out.from) out.from = out.user
    return out
  }
  S.effectiveSmtp = () => effectiveSmtp(S)   // 供其它模块/MCP 用

  // OceanBase 连接配置(密码 safeStorage 解密);DB 连接走主进程(MCP 子进程没法解密)
  function effectiveOb() {
    const ob = S.settings.ob || {}
    if (!ob.host || !ob.user || !ob.passEncrypted) return null
    return { host: ob.host, port: ob.port || 3306, user: ob.user, password: email.decryptPass(ob.passEncrypted), database: ob.database || '' }
  }
  S.effectiveOb = effectiveOb

  // ── 发件箱(发信安全闸门)──────────────────────────────────────────────────
  function notifyMail(title, body, onClick) {
    try {
      if (Notification && Notification.isSupported()) {
        const n = new Notification({ title: 'BocomHermes · ' + title, body: String(body || '').slice(0, 160) })
        if (onClick) n.on('click', () => { try { onClick() } catch {} })
        n.show()
      }
    } catch {}
  }
  function broadcastOutbox() {
    try { if (S.outboxWin && !S.outboxWin.isDestroyed()) S.outboxWin.webContents.send('outbox-updated') } catch {}
  }
  // 真正发送一条队列项:走已解密的 SMTP,成功后异步 APPEND 到 Sent
  async function sendQueued(it) {
    const cfg = S.effectiveSmtp(); if (!cfg) throw new Error('SMTP 未配置')
    const res = await email.sendMail(cfg, it.msg)
    // 审计:发信(收件人/主题,不记正文/附件内容)
    try { const m = it.msg || {}; S.audit && S.audit('mail', '发送邮件', { to: Array.isArray(m.to) ? m.to.join(', ') : m.to, subject: m.subject || '', kind: it.kind, att: (m.attachments || []).length }) } catch {}
    const imap = S.settings.imap
    if (imap && imap.host && res.mime) {
      email.appendToSent(imap, imap.sentFolder || 'Sent', res.mime).catch((e) => log('APPEND Sent err: ' + e.message))
    }
    return res
  }
  S.outbox = initOutbox({
    file: path.join(app.getPath('userData'), 'outbox.json'),
    fs, log, send: sendQueued, broadcast: broadcastOutbox, notify: notifyMail,
  })
  function outboxHold() { const h = S.settings.outboxHoldSeconds; return h == null ? 15 : Math.max(0, Math.min(+h || 0, 3600)) }
  // 入队后:若有延迟窗,弹出发件箱面板让用户能看到倒计时并可撤销
  function afterEnqueue(hold) { if (hold > 0 && typeof openOutbox === 'function') { try { openOutbox() } catch {} } else broadcastOutbox() }

  // ── IMAP IDLE 实时新邮件提醒 ──────────────────────────────────────────────
  // 新邮件到达 → 桌面通知(点击=整理摘要)。默认开,可在设置关。重连/退避由 watcher 自管理。
  function startIdleWatcher() {
    try { if (S.idleWatcher) { S.idleWatcher.stop(); S.idleWatcher = null } } catch {}
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return
    if (S.settings.imapIdleEnabled === false) { log('idle: 已在设置中关闭,不启动'); return }
    S.idleWatcher = email.createIdleWatcher(imap, {
      log,
      onNew: (n) => {
        try { S.syncMailCache && S.syncMailCache({ full: false }) } catch {}   // 新邮件即时拉进本地缓存(下次进收件箱就有,不用等 5 分钟定时)
        // 球绿色脉冲 + 通知;点击通知=打开邮件中心(收件箱默认只看未读 → 新邮件自然置顶)
        try { sendOrbState && sendOrbState('done') } catch {}
        notifyMail('新邮件', (n > 1 ? n + ' 封新邮件到达' : '有新邮件到达') + ' — 点击打开邮件中心',
          () => { try { createMailCenter() } catch (e) { log('idle open center err: ' + e.message) } })
      },
    })
    log('idle: IMAP IDLE 实时监听已启动')
  }

  // 本地 HTTP 中继:MCP 子进程没法用 electron safeStorage 解密 IMAP/SMTP 密码 → 主进程开个
  // 127.0.0.1 localhost http server,MCP 通过 HTTP 调,主进程用已解密的 cfg 跑 IMAP/SMTP。
  // token 防本机其它进程蹭用(写在 userData/mail-relay.json,只有 Agent + 自家 MCP 看得到)
  const http = require('http')
  // 防数据外泄:发信附件只允许来自 下载/桌面/文档/项目目录/邮件附件缓存,且 ≤25MB(否则 agent 可被诱导把任意文件当附件发出)
  function checkAttachments(atts) {
    if (!Array.isArray(atts) || !atts.length) return
    const MAX = 25 * 1024 * 1024
    const allow = [app.getPath('downloads'), app.getPath('desktop'), app.getPath('documents'),
      path.join(app.getPath('userData'), 'mail-att'), S.settings.projectDir, S.settings.backendDir]
      .filter(Boolean).map((d) => path.resolve(d) + path.sep)
    for (const att of atts) {
      let p; try { p = fs.realpathSync(path.resolve(String(att.path || ''))) } catch { throw new Error('附件不存在: ' + att.path) }
      if (!allow.some((base) => (p + path.sep).startsWith(base))) throw new Error('拒绝发送该附件(不在允许目录,防外泄): ' + att.path + ' — 只允许 下载/桌面/文档/项目目录/邮件缓存 里的文件')
      let sz = 0; try { sz = fs.statSync(p).size } catch {}
      if (sz > MAX) throw new Error('附件过大(>25MB),拒绝发送: ' + att.path)
    }
  }
  // 收件人格式兜底校验(MCP 层已校验,这里二次防线)
  const RCPT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  function badRecipients(arr) { return (arr || []).filter((s) => { const e = (String(s).match(/<([^>]+)>/) || [])[1] || s; return !RCPT_RE.test(String(e).trim()) }) }
  function startMailRelay() {
    const token = require('crypto').randomBytes(16).toString('hex')
    const srv = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.headers['x-bocom-tok'] !== token) { res.writeHead(401).end(); return }
      let body = ''
      req.on('data', (c) => body += c)
      req.on('end', async () => {
        let a = {}; try { a = body ? JSON.parse(body) : {} } catch {}
        const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
        try {
          if (req.url === '/mail/list') {
            const imap = S.settings.imap
            if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return reply({ error: 'IMAP 未配置' })
            // 透传 agent 的筛选/分页参数:from / subject / days / onlyUnseen / limit / cursor
            const r = await email.fetchUnread(imap, a || {})
            // 附件落盘 + 文本化(strip _rawAttachments bytes,attachments[] 改为带 hasText 的 meta)
            try { await attachments.saveAttachments(r.emails, app.getPath('userData'), log) } catch (e) { log('saveAttachments err: ' + e.message) }
            // 持久化每封邮件 metadata 到 mail-cache.jsonl(跨会话 msgId → uid 寻址)
            for (const em of r.emails) {
              if (!em.messageId) continue
              mailCache.put(app.getPath('userData'), em)
              S.mailCache.set(em.messageId, { messageId: em.messageId, uid: em.uid, folder: em.folder || 'INBOX', from: em.from, subject: em.subject, date: em.date, attCount: (em.attachments || []).length, savedAt: Date.now() })
            }
            // 缓存最近一次结果,给 todo 回填邮件元信息用 / mail_get_full 快速命中
            S.mailLastBatch = { ts: Date.now(), emails: r.emails }
            return reply({ ok: true, emails: r.emails, nextCursor: r.nextCursor, totalMatched: r.totalMatched })
          }
          if (req.url === '/mail/folders') {
            const imap = S.settings.imap
            if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return reply({ error: 'IMAP 未配置' })
            try { const folders = await email.listFolders(imap); return reply({ ok: true, folders }) }
            catch (e) { return reply({ error: e.message }) }
          }
          if (req.url === '/mail/send') {
            const cfg = S.effectiveSmtp(); if (!cfg) return reply({ error: 'SMTP 未配置' })
            const allRcpt = [...(Array.isArray(a.to) ? a.to : [a.to]), ...(a.cc || []), ...(a.bcc || [])].filter(Boolean)
            const bad = badRecipients(allRcpt); if (bad.length) return reply({ error: '收件人格式不对,拒绝发送: ' + bad.join(', ') })
            try { checkAttachments(a.attachments) } catch (e) { return reply({ error: e.message }) }
            // 不再即时发出:进发件箱队列,延迟窗内用户可撤销(软撤回)/立即发送
            const hold = outboxHold()
            const msg = {
              to: a.to, cc: a.cc, bcc: a.bcc,
              subject: a.subject, text: a.text, html: a.html,
              attachments: a.attachments,
              inReplyTo: a.inReplyTo, references: a.references,
            }
            const toStr = (Array.isArray(a.to) ? a.to : [a.to]).filter(Boolean).join(', ')
            const q = S.outbox.enqueue({ kind: 'send', msg, holdSeconds: hold,
              meta: { to: toStr, subject: a.subject || '(无主题)', attCount: (a.attachments || []).length } })
            afterEnqueue(hold)
            return reply({ ok: true, queued: true, id: q.id, sendAt: q.sendAt, holdSeconds: hold })
          }
          if (req.url === '/mail/get') {
            // 取某封邮件全文(分段)。先查 mailLastBatch 缓存,没命中再走 IMAP HEADER 搜
            const imap = S.settings.imap
            if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return reply({ error: 'IMAP 未配置' })
            const msgId = String(a.messageId || '').replace(/^<|>$/g, '')
            if (!msgId) return reply({ error: 'messageId 必填' })
            let mail = null
            const batch = S.mailLastBatch && Array.isArray(S.mailLastBatch.emails) ? S.mailLastBatch.emails : []
            mail = batch.find((e) => e.messageId === msgId) || null
            if (!mail) {
              try {
                const cached = S.mailCache && S.mailCache.get(msgId)
                const fld = a.folder || (cached && cached.folder) || 'INBOX'   // 跨文件夹:去这封邮件所在文件夹找
                mail = await email.fetchByMessageId(imap, msgId, fld)
                if (mail) { try { await attachments.saveAttachments([mail], app.getPath('userData'), log) } catch (e) { log('saveAtts err: ' + e.message) } }
              } catch (e) { return reply({ error: 'IMAP 兜底搜失败: ' + e.message }) }
            }
            if (!mail) return reply({ error: '找不到 msgId=' + msgId + '(可能已归档或不在 INBOX)' })
            const part = a.part === 'html' ? (mail.html || '') : (mail.text || '')
            const offset = Math.max(0, +a.offset || 0)
            const limit  = Math.max(1, Math.min(+a.limit || 8000, 50000))
            const content = part.slice(offset, offset + limit)
            return reply({
              ok: true, content,
              totalLen: part.length, hasMore: offset + limit < part.length,
              nextOffset: offset + limit < part.length ? offset + limit : null,
              from: mail.from, subject: mail.subject, date: mail.date,
              hasHtml: !!(mail.html && mail.html.length), hasText: !!(mail.text && mail.text.length),
              attachments: mail.attachments || [],
            })
          }
          if (req.url === '/mail/reply') {
            // 回复邮件:必带原文 HTML 格式引用(Outlook 风格 blockquote),硬约束
            const imap = S.settings.imap
            const cfg = S.effectiveSmtp(); if (!cfg) return reply({ error: 'SMTP 未配置' })
            const msgId = String(a.messageId || '').replace(/^<|>$/g, '')
            if (!msgId) return reply({ error: 'messageId 必填' })
            if (!a.text && !a.html) return reply({ error: '回复正文 text 或 html 至少传一个' })
            // 取原邮件:先内存 batch,否则 IMAP fetch by Message-ID
            let orig = null
            const batch = S.mailLastBatch && Array.isArray(S.mailLastBatch.emails) ? S.mailLastBatch.emails : []
            orig = batch.find((e) => e.messageId === msgId) || null
            if (!orig) {
              const cached = S.mailCache && S.mailCache.get(msgId)
              const fld = a.folder || (cached && cached.folder) || 'INBOX'
              try { orig = await email.fetchByMessageId(imap, msgId, fld) } catch (e) { return reply({ error: '取原邮件失败: ' + e.message }) }
            }
            if (!orig) return reply({ error: '找不到原邮件 msgId=' + msgId })
            try { checkAttachments(a.attachments) } catch (e) { return reply({ error: e.message }) }
            // 抽 To(从原 from)
            const fromAddr = (orig.from.match(/<([^>]+)>/) || [])[1] || (orig.from.match(/[\w.\-+]+@[\w.\-]+\.\w+/) || [])[0] || orig.from
            // Subject:Re: 前缀去重
            const subject = /^re:/i.test(orig.subject || '') ? orig.subject : ('Re: ' + (orig.subject || ''))
            // References:沿用原 references,末尾追加原 messageId
            const refs = Array.isArray(orig.references) ? orig.references.slice() : []
            if (msgId && !refs.includes(msgId)) refs.push(msgId)
            // 拼回复 text:agent 文 + 引用块
            const replyText = String(a.text || email.stripHtml(a.html || ''))
            const quoteHead = `\r\n\r\n--- 原邮件 ---\r\n发件人: ${orig.from}\r\n时间: ${orig.date}\r\n主题: ${orig.subject}\r\n`
            const origText = orig.text || email.stripHtml(orig.html || '')
            const quotedText = origText.split('\n').map((l) => '> ' + l).join('\n')
            const finalText = replyText + quoteHead + '\r\n' + quotedText
            // 拼回复 html:agent html(优先)或 textToHtml(text) + Outlook 风格头 + blockquote 包原 html
            const replyHtml = a.html ? String(a.html) : email.textToHtml(String(a.text || ''))
            // 原邮件 HTML 段:有就用,没就把原 text 包 <pre> 当 html(保留换行)
            const origHtmlBlock = orig.html
              ? orig.html
              : '<pre style="white-space:pre-wrap;font-family:Calibri,sans-serif">' + String(origText || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>'
            const finalHtml = replyHtml +
              '<br><br><div style="border-top:1px solid #ccc;padding-top:6px;margin-top:6px;color:#666;font-size:12px;font-family:Calibri,sans-serif">' +
                '<b>发件人:</b> ' + String(orig.from || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '<br>' +
                '<b>发送时间:</b> ' + String(orig.date || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '<br>' +
                '<b>主题:</b> ' + String(orig.subject || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '<br>' +
              '</div>' +
              '<blockquote style="margin:0 0 0 .8ex;border-left:2px #1a73e8 solid;padding-left:1ex">' +
                origHtmlBlock +
              '</blockquote>'
            // 进发件箱队列(回复也走安全闸门),原邮件已在此刻取好并拼进 msg
            const hold = outboxHold()
            const msg = {
              to: fromAddr, cc: a.cc, bcc: a.bcc,
              subject, text: finalText, html: finalHtml,
              attachments: a.attachments, inReplyTo: msgId, references: refs,
            }
            const q = S.outbox.enqueue({ kind: 'reply', msg, holdSeconds: hold,
              meta: { to: fromAddr, subject, attCount: (a.attachments || []).length } })
            afterEnqueue(hold)
            return reply({ ok: true, queued: true, id: q.id, sendAt: q.sendAt, holdSeconds: hold, to: fromAddr, subject, quotedFrom: orig.from })
          }
          if (req.url === '/mail/markRead') {
            const imap = S.settings.imap
            if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return reply({ error: 'IMAP 未配置' })
            const ids = Array.isArray(a.messageIds) ? a.messageIds : (a.messageId ? [a.messageId] : [])
            if (!ids.length) return reply({ error: 'messageIds 必填' })
            try { const r = await email.markRead(imap, ids); return reply({ ok: true, ...r }) }
            catch (e) { return reply({ error: e.message }) }
          }
          if (req.url === '/mail/archive') {
            const imap = S.settings.imap
            if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return reply({ error: 'IMAP 未配置' })
            const ids = Array.isArray(a.messageIds) ? a.messageIds : (a.messageId ? [a.messageId] : [])
            if (!ids.length) return reply({ error: 'messageIds 必填' })
            const folder = a.folder || (imap.archiveFolder) || 'Archive'
            try { const r = await email.archiveMessages(imap, ids, folder); return reply({ ok: true, ...r }) }
            catch (e) { return reply({ error: e.message }) }
          }
          if (req.url === '/mail/attachment') {
            try {
              const r = attachments.readAttachmentText(app.getPath('userData'), a.messageId, a.filename, a.offset, a.limit)
              return reply({ ok: true, ...r })
            } catch (e) { return reply({ error: e.message, code: e.code || null }) }
          }
          // ── OceanBase 只读(全部经 effectiveOb 解密;只读守卫在 db.js)─────────
          if (req.url.startsWith('/db/')) {
            const cfg = effectiveOb(); if (!cfg) return reply({ error: 'OceanBase 未配置(设置面板填 host/端口/user@租户#集群/密码/库)' })
            try {
              if (req.url === '/db/tables') return reply({ ok: true, rows: await db.tables(cfg, a.keyword) })
              if (req.url === '/db/schema') return reply({ ok: true, schema: await db.schema(cfg, a.table) })
              if (req.url === '/db/grep')   return reply({ ok: true, rows: await db.columnsGrep(cfg, a.keyword) })
              if (req.url === '/db/sample') return reply({ ok: true, rows: await db.sample(cfg, a.table, a.limit, a.where) })
              if (req.url === '/db/query')  return reply({ ok: true, rows: await db.query(cfg, a.sql) })
              if (req.url === '/db/ping')   return reply({ ok: true, ...(await db.ping(cfg)) })
            } catch (e) { return reply({ error: e.message }) }
          }
          // ── 拖入文档按需读取:opencode 调 read_document → 这里用客户端解析器抽文本(支持分段)──
          if (req.url === '/doc/read') {
            const r = await attachments.extractLocalFile(String(a.path || ''))
            if (!r.ok) return reply({ error: r.error })
            const text = r.text || ''
            const off = Math.max(0, +a.offset || 0), lim = Math.max(1, Math.min(+a.limit || 20000, 100000))
            return reply({ ok: true, total: text.length, content: text.slice(off, off + lim), hasMore: off + lim < text.length, nextOffset: off + lim < text.length ? off + lim : null })
          }
          // ── 自主升格:对话卡 Agent 判断任务复杂 → 调 run_workflow → 拉起动态编排(带新大脑 + 人审闸)──
          if (req.url === '/orch/run') {
            const goal = String(a.goal || '').trim()
            if (!goal) return reply({ error: '缺少 goal' })
            try { const id = spawnWorkflow(goal); return reply({ ok: true, id }) }
            catch (e) { return reply({ error: e.message }) }
          }
          // 工作流成果回取:不再一次性 —— Agent 拿 id 查状态/取成果全文(注册表 + 存档),继续在对话里用
          if (req.url === '/orch/result') {
            const regs = S.wfRegistry ? [...S.wfRegistry.values()] : []
            const id = String(a.id == null ? '' : a.id).trim()
            const w = id ? regs.find((r) => String(r.id) === id) : regs[regs.length - 1]   // 不带 id = 最近一个
            if (w) {
              // busy=卡当前是否有回合在跑(window.js S.isCardBusy):升格方据此区分"干活中"与"空闲(等批准/等插话)"
              if (w.status === 'running') return reply({ ok: true, id: w.id, status: 'running', round: w.round, goal: w.goal, busy: S.isCardBusy ? !!S.isCardBusy(w.wcId) : undefined, files: w.files || [], final: String(w.final || '').slice(0, 14000) })   // 新路径快照式:进行中也带最新一轮成果(没有则空)
              let full = w.final || ''
              try { if (w.archive) full = fs.readFileSync(w.archive, 'utf8') } catch {}
              return reply({ ok: true, id: w.id, status: w.status, goal: w.goal, rounds: w.rounds, elapsedMs: w.elapsedMs, archive: w.archive || '', files: w.files || [], final: String(full).slice(0, 14000) })
            }
            // 注册表是内存的(重启即空)→ 兜底翻存档目录:文件名嵌 id(时间戳_id_目标.md),带 id 精确找,不带取最新
            try {
              const dirW = path.join(app.getPath('userData'), 'workflows')
              const files = fs.readdirSync(dirW).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}_\d+_.+\.md$/.test(f))
                .map((f) => ({ f, p: path.join(dirW, f), m: fs.statSync(path.join(dirW, f)).mtimeMs }))
                .sort((x, y) => y.m - x.m)
              const hit = id ? files.find((x) => x.f.split('_')[1] === id) : files[0]
              if (hit) {
                const full = fs.readFileSync(hit.p, 'utf8')
                const goal = ((full.match(/^# 工作流:(.*)$/m) || [])[1] || '').trim()
                const prodSec = (full.match(/## 产出文件\n([\s\S]*?)(\n## |$)/) || [])[1] || ''   // 产出文件清单也从存档解析带回(旧存档没这节 → 空数组)
                const prodFiles = prodSec.split('\n').map((l) => l.replace(/^- /, '').trim()).filter((l) => l && l !== '(无)')
                return reply({ ok: true, id: hit.f.split('_')[1], status: 'archived', goal, archive: hit.p, files: prodFiles, final: full.slice(0, 14000) })
              }
            } catch {}
            return reply({ error: id ? ('没有 id=' + id + ' 的工作流(现有: ' + regs.map((r) => r.id).join(',') + ')') : '还没有任何工作流记录' })
          }
          // ── 任务尾蒸馏写入:Agent 调 memory_add(orch-mcp)→ 追加进本项目知识库(按 dir 分库、去重),下次开卡自动注入 ──
          if (req.url === '/orch/memory-add') {
            const dir = String(a.dir || '').trim()
            const raw = Array.isArray(a.entries) ? a.entries : [{ text: a.text, anchors: a.anchors, scene: a.scene, confidence: a.confidence }]
            const clean = raw.map((e) => ({
              text: String((e && e.text) || '').slice(0, 500),
              anchors: Array.isArray(e && e.anchors) ? e.anchors.slice(0, 6) : [],
              scene: String((e && e.scene) || '').slice(0, 80),
              confidence: e && e.confidence,
            })).filter((e) => e.text.trim()).slice(0, 20)
            if (!dir) return reply({ error: '缺少 dir(项目目录)' })
            if (!clean.length) return reply({ error: '没有可写条目(text 为空)' })
            try {
              const f = knowledge.fileFor(dir, app.getPath('userData'))
              fs.mkdirSync(path.dirname(f), { recursive: true })
              let old = ''; try { old = fs.readFileSync(f, 'utf8') } catch {}
              const r = knowledge.appendEntries(old, clean)
              fs.writeFileSync(f, r.content)
              try { S.audit && S.audit('knowledge', '蒸馏写入项目知识库', { dir, added: r.added, dupes: r.dupes }) } catch {}
              return reply({ ok: true, added: r.added, dupes: r.dupes, file: f })
            } catch (e) { return reply({ error: e.message }) }
          }
          // ── 浏览器技能(SKILL):录制一次 → 存成命名技能 → agent 按名字带参回放 ──
          // 执行统一走 GUI 主进程的强回放引擎(selAlt fallback + 登录态恢复 + 红框可视化),
          // browser-mcp 只是发现+调度面 —— 不在它自己的 headless 浏览器里重造弱引擎。
          if (req.url === '/skill/list') return reply({ ok: true, skills: skillList() })
          if (req.url === '/skill/run') {
            try { return reply(await skillRun(a)) } catch (e) { return reply({ error: e.message }) }
          }
          // Phase 5·数据集批跑:dataset 每行={参数label:值}=独立回放一遍,汇总 PASS/FAIL(上限 200 行)
          if (req.url === '/skill/run-batch') {
            try { return reply(await skillRunBatch(a)) } catch (e) { return reply({ error: e.message }) }
          }
          // 混合执行·Agent 接管:读页(任何时候)/ 执行一步(仅接管期)/ 接管收口
          if (req.url === '/skill/page-read') {
            try { return reply(await skillPageRead()) } catch (e) { return reply({ error: e.message }) }
          }
          if (req.url === '/skill/page-act') {
            try { return reply(await skillPageAct(a)) } catch (e) { return reply({ error: e.message }) }
          }
          if (req.url === '/skill/takeover-done') {
            try { return reply(skillTakeoverDone(a)) } catch (e) { return reply({ error: e.message }) }
          }
          return reply({ error: 'unknown ' + req.url })
        } catch (e) { reply({ error: e.message }) }
      })
    })
    srv.on('error', (e) => log('mail relay error: ' + e.message))
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      const fp = path.join(app.getPath('userData'), 'mail-relay.json')
      try { fs.writeFileSync(fp, JSON.stringify({ port, token })) ; log('mail relay on :' + port) } catch (e) { log('mail-relay.json save err: ' + e.message) }
    })
  }
  startMailRelay()
  // 保活心跳每拍刷完 → 把各 serve 的探活状态推给绑在它上面的会话窗(状态灯)
  function pushServeHealth(wc, serve) {
    if (!wc || wc.isDestroyed() || !serve) return
    try { wc.send('serve-health', { healthy: serve.healthy !== false, port: serve.port || null, at: serve.healthyAt || Date.now() }) } catch {}
  }
  S.pushServeHealth = pushServeHealth   // 供 session.js 建会话时立即推一次
  oc.onKeepAlive((results, probes) => {
    if (!S.sessionInfo) return
    for (const si of S.sessionInfo.values()) {
      if (!si || !si.wc || si.wc.isDestroyed() || !si.serve) continue
      pushServeHealth(si.wc, si.serve)
      const probe = (probes || []).find((p) => p.port === si.serve.port)   // 推本卡 serve 的探活报文给日志面板
      if (probe) { try { si.wc.send('serve-probe', probe) } catch {} }
    }
  })
  // 探活日志:取本卡 serve 的历史(开面板时拉)
  ipcMain.handle('get-probe-log', (e) => {
    const sid = S.sessionByWc.get(e.sender.id); if (!sid) return []
    const si = S.sessionInfo.get(sid)
    return (si && si.serve && si.serve.probeLog) ? si.serve.probeLog : []
  })
  // 立即探活:当场 GET 一次 /global/health,记进日志并回传
  ipcMain.handle('probe-now', async (e) => {
    const sid = S.sessionByWc.get(e.sender.id); if (!sid) return null
    const si = S.sessionInfo.get(sid); if (!si || !si.serve || !si.serve.base) return null
    const r = await oc.probeOnce(si.serve.base)
    const entry = { base: si.serve.base, port: si.serve.port, healthy: r.healthy, status: r.status, body: r.body, ms: r.ms, at: Date.now() }
    si.serve.healthy = r.healthy; si.serve.healthyAt = entry.at
    si.serve.probeLog = si.serve.probeLog || []; si.serve.probeLog.push(entry); if (si.serve.probeLog.length > 50) si.serve.probeLog.shift()
    pushServeHealth(si.wc, si.serve)
    return entry
  })
  setTimeout(() => { try { startIdleWatcher() } catch (e) { log('idle start err: ' + e.message) } }, 3000)   // 稍延后启动 IDLE,避开启动繁忙期
  // 启动时清理 30 天前的附件目录(异步执行不阻塞主流程)
  try { attachments.cleanupOld(app.getPath('userData'), log) } catch (e) { log('att cleanup err: ' + e.message) }
  // 加载 mail-cache(metadata 持久化,跨会话引用 msgId)+ 启动时 prune 30 天前
  S.mailCache = mailCache.load(app.getPath('userData'))
  try { mailCache.prune(app.getPath('userData'), null, log) } catch (e) { log('mail-cache prune err: ' + e.message) }

  // ── 本地邮箱同步(存量一次拉满 + 定时/新邮件拉增量;UI 读本地缓存,不再每次进窗口全量重拉)──
  let mailSyncing = false, lastSyncAt = 0
  async function syncMailCache(opts) {
    opts = opts || {}
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return { synced: 0, error: 'IMAP 未配置' }
    if (mailSyncing) return { synced: 0, skipped: true }
    mailSyncing = true
    const userData = app.getPath('userData')
    const full = !!opts.full
    const days = full ? 30 : 2         // 存量:近 30 天拉满;增量:近 2 天(够覆盖两次同步间隔)
    const maxPages = full ? 6 : 1      // 存量最多翻 6 页(≈360 封),增量一页够
    let added = 0
    try {
      let cursor = 0
      for (let page = 0; page < maxPages; page++) {
        const r = await email.fetchUnread(imap, { onlyUnseen: false, days, limit: 60, cursor, folder: 'INBOX' })
        for (const em of (r.emails || [])) {
          if (em.error || !em.messageId) continue
          const isNew = !S.mailCache.has(em.messageId)
          S.mailCache.set(em.messageId, { messageId: em.messageId, uid: em.uid, folder: em.folder || 'INBOX', from: em.from, subject: em.subject, date: em.date, attCount: (em.attachments || []).length, savedAt: Date.now() })
          if (isNew) { mailCache.put(userData, em); added++; try { maybeSuggestMeeting(em) } catch {} }   // 磁盘只追加新的(不重复 append 撑大 jsonl);会议识别只对新邮件
        }
        if (r.nextCursor == null) break
        cursor = r.nextCursor
      }
      lastSyncAt = Date.now()
      if (added || full) log('mail-sync ' + (full ? '存量' : '增量') + ': +' + added + ' 新, 本地共 ' + S.mailCache.size + ' 封')
      return { synced: added, total: S.mailCache.size, at: lastSyncAt }
    } catch (e) { log('mail-sync err: ' + e.message); return { synced: added, error: e.message } }
    finally { mailSyncing = false }
  }
  // 启动:缓存空→拉存量;之后每 5 分钟拉增量。IDLE 新邮件也会即时触发一次增量(见 onNew)
  setTimeout(() => { syncMailCache({ full: S.mailCache.size === 0 }).catch(() => {}) }, 5000)
  setInterval(() => { syncMailCache({ full: false }).catch(() => {}) }, 5 * 60 * 1000)
  S.syncMailCache = syncMailCache   // 供 IDLE onNew / 手动同步调用
  // 启动时 prune "已整理"集合 30 天前的条目
  try { emailSummarySeen.prune(app.getPath('userData'), null, log) } catch (e) { log('email-seen prune err: ' + e.message) }

  // cid: 内联图片 → data:URI(Foxmail 式内嵌图还原):用 _rawAttachments 里带 Content-ID 的图替换 html 引用
  function inlineCids(html, rawAtts) {
    if (!html || !/cid:/i.test(html) || !Array.isArray(rawAtts) || !rawAtts.length) return html
    const map = new Map(); let budget = 8 * 1024 * 1024   // 总量 8MB 上限,防 srcdoc 爆炸
    for (const a of rawAtts) {
      if (!a || !a.contentId || !a.bytes || !/^image\//i.test(a.mime || '')) continue
      if (a.bytes.length > budget) continue
      budget -= a.bytes.length
      map.set(a.contentId, 'data:' + a.mime + ';base64,' + a.bytes.toString('base64'))
    }
    if (!map.size) return html
    const dec = (s) => { try { return decodeURIComponent(s) } catch { return s } }
    return html.replace(/(["'(])cid:([^"')\s>]+)/gi, (m, pre, id) => {
      const uri = map.get(id) || map.get(dec(id))
      return uri ? pre + uri : m
    })
  }
  // 待办 → 邮件闭环：按 msgId 取原邮件（先内存批次，再 IMAP 兜底搜）
  async function loadMailByMsgId(msgId) {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) return { error: 'IMAP 未配置' }
    const id = String(msgId || '').replace(/^<|>$/g, ''); if (!id) return { error: 'msgId 为空' }
    let mail = (S.mailLastBatch && Array.isArray(S.mailLastBatch.emails) ? S.mailLastBatch.emails : []).find((e) => e.messageId === id) || null
    if (!mail) { const cached = S.mailCache && S.mailCache.get(id); try { mail = await email.fetchByMessageId(imap, id, cached && cached.folder) } catch (e) { return { error: e.message } } }
    if (!mail) return { error: '找不到原邮件（可能已归档或不在收件箱）' }
    const rawHtml = String(mail.html || '').slice(0, 400000)   // 截断必须在 cid 替换之前,否则会切断 base64
    return { ok: true, id, from: mail.from, subject: mail.subject, date: mail.date,
      text: mail.text || email.stripHtml(mail.html || ''),
      html: inlineCids(rawHtml, mail._rawAttachments || []), hasHtml: !!(mail.html && mail.html.length) }
  }
  ipcMain.handle('mail-get-full', async (_e, msgId) => {
    const r = await loadMailByMsgId(msgId)
    return r.error ? r : { ok: true, from: r.from, subject: r.subject, date: r.date, text: String(r.text).slice(0, 20000) }
  })
  ipcMain.handle('mail-reply-card', async (_e, arg) => {
    const r = await loadMailByMsgId(arg && arg.msgId)
    if (r.error) return r
    const prompt = `请帮我回复这封邮件。**先把回复草稿写出来给我看,我确认后你再调用 mail_reply 工具发送(messageId=${r.id})**,在我说"发"之前不要真发。\n\n## 原邮件\n发件人:${r.from}\n时间:${r.date}\n主题:${r.subject}\n正文:\n${String(r.text).slice(0, 4000)}`
    spawnCard('回复 · ' + String(r.subject || '邮件').slice(0, 18), null, prompt, '起草回复:' + String(r.subject || '').slice(0, 40))
    return { ok: true }
  })
  // HTML 邮件查看器:返回完整正文(text + html),viewer 用沙箱 iframe 渲染
  ipcMain.handle('mail-view-data', async (_e, msgId) => {
    const r = await loadMailByMsgId(msgId)
    return r.error ? r : { ok: true, from: r.from, subject: r.subject, date: r.date,
      text: String(r.text || '').slice(0, 50000), html: String(r.html || ''), hasHtml: r.hasHtml }   // html 已在 loadMailByMsgId 里先截断再 cid 内联,这里不能再切(会切断 base64)
  })
  // 邮件正文里的链接 → 系统默认浏览器;协议白名单,禁 file:/javascript: 等
  ipcMain.handle('open-external-url', (_e, url) => {
    const u = String(url || '')
    if (!/^(https?:|mailto:)/i.test(u)) return { ok: false, error: '非法协议' }
    shell.openExternal(u).catch(() => {})
    return { ok: true }
  })
  ipcMain.handle('open-mail-view', (_e, msgId) => openMailView(msgId))
  ipcMain.handle('open-mail-center', (_e, tab) => createMailCenter(tab))
  ipcMain.handle('mail-mark-read', async (_e, msgIds) => {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    return await email.markRead(imap, Array.isArray(msgIds) ? msgIds : [msgIds])
  })
  ipcMain.handle('mail-archive', async (_e, msgIds) => {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    return await email.archiveMessages(imap, Array.isArray(msgIds) ? msgIds : [msgIds], imap.archiveFolder || 'Archive')
  })
  // 邮件中心收件箱列表：复用 fetchUnread，只回摘要字段（不带正文/附件二进制）
  ipcMain.handle('mail-list', async (_e, opts) => {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置（去「设置」填写收件服务器）')
    const o = opts || {}
    // 只看未读 / 显式 live(如今日摘要要正文预览):走实时拉取(本地缓存不含已读状态与正文)
    if (o.onlyUnseen === true || o.live === true) {
      const r = await email.fetchUnread(imap, {
        onlyUnseen: o.onlyUnseen === true,
        days: Math.max(1, Math.min(+o.days || 30, 90)),
        limit: Math.max(1, Math.min(+o.limit || 50, 100)),
        cursor: Math.max(0, +o.cursor || 0),
        folder: o.folder || 'INBOX',
      })
      for (const e of (r.emails || [])) { if (!e.error) maybeSuggestMeeting(e) }
      return {
        ok: true, totalMatched: r.totalMatched || 0, nextCursor: r.nextCursor != null ? r.nextCursor : null,
        emails: (r.emails || []).filter((e) => !e.error).map((e) => ({
          from: e.from || '', subject: e.subject || '', date: e.date || '',
          messageId: e.messageId || '', attachments: (e.attachments || []).length,
          preview: (e.bodySummary || e.body || '').replace(/\s+/g, ' ').slice(0, 300),
        })),
      }
    }
    // 默认:读本地缓存(秒开、全量);缓存空→先拉存量,否则后台拉增量(不阻塞 UI)。这就是"一次拉存量 + 定时拉增量 + 读本地"
    if (!S.mailCache || S.mailCache.size === 0) await syncMailCache({ full: true })
    else syncMailCache({ full: false }).catch(() => {})
    const folder = o.folder || 'INBOX'
    const all = [...S.mailCache.values()].filter((m) => (m.folder || 'INBOX') === folder)
      .sort((a, b) => (b.uid || 0) - (a.uid || 0) || (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))   // UID 倒序(新在前),同 UID 退回日期
    const cursor = Math.max(0, +o.cursor || 0), limit = Math.max(1, Math.min(+o.limit || 80, 200))
    const page = all.slice(cursor, cursor + limit)
    return {
      ok: true, cached: true, syncedAt: lastSyncAt,
      totalMatched: all.length,
      nextCursor: all.length > cursor + limit ? cursor + limit : null,
      emails: page.map((m) => ({ from: m.from || '', subject: m.subject || '', date: m.date || '', messageId: m.messageId || '', attachments: m.attCount || 0, preview: '' })),
    }
  })
  return { effectiveSmtp, effectiveOb, startIdleWatcher }
}
