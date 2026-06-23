'use strict'
// 邮件 metadata 持久缓存:userData/mail-cache.jsonl(append-only,后写覆盖)
// 不缓存正文/html(那个走 IMAP 现拉);只缓存 metadata + UID + 附件计数
//  · load():启动时一次性读全,返回 Map<messageId, meta>
//  · put():每次 mail_list 后调,追加一行
//  · prune():启动时跑一次,丢掉 30 天前的(rewrite jsonl)
//
// 用途:
//  · 跨会话引用某封邮件(todo [msgId:xxx] 重启后仍能查到 subject/date)
//  · 已知 msgId 的 mail_get_full 用缓存的 UID 直接 UID FETCH(跳 HEADER SEARCH 那一跳)
const fs = require('fs')
const path = require('path')

const KEEP_DAYS = 30

function fp(userDataDir) { return path.join(userDataDir, 'mail-cache.jsonl') }

function load(userDataDir) {
  const map = new Map()
  const f = fp(userDataDir)
  if (!fs.existsSync(f)) return map
  try {
    const txt = fs.readFileSync(f, 'utf8')
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      try { const obj = JSON.parse(line); if (obj && obj.messageId) map.set(obj.messageId, obj) } catch {}
    }
  } catch {}
  return map
}

function put(userDataDir, meta) {
  if (!meta || !meta.messageId) return
  const f = fp(userDataDir)
  const entry = {
    messageId: meta.messageId,
    uid: meta.uid || null,
    from: meta.from || '',
    subject: meta.subject || '',
    date: meta.date || '',
    attCount: Array.isArray(meta.attachments) ? meta.attachments.length : 0,
    savedAt: Date.now(),
  }
  try { fs.appendFileSync(f, JSON.stringify(entry) + '\n') } catch {}
}

function prune(userDataDir, days, log) {
  days = days || KEEP_DAYS
  const f = fp(userDataDir)
  if (!fs.existsSync(f)) return 0
  const cutoff = Date.now() - days * 86400000
  const map = load(userDataDir)
  const before = map.size
  const kept = []
  for (const [, v] of map) if (!v.savedAt || v.savedAt >= cutoff) kept.push(v)
  try { fs.writeFileSync(f, kept.length ? kept.map((o) => JSON.stringify(o)).join('\n') + '\n' : '') } catch {}
  const removed = before - kept.length
  if (removed && log) log('mail-cache prune: removed ' + removed + ' entries older than ' + days + 'd')
  return removed
}

module.exports = { load, put, prune, KEEP_DAYS }
