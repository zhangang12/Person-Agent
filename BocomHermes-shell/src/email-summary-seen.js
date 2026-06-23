'use strict'
// "已整理"集合:每次 📧 邮件整理按钮拉到的 messageId 都记下,下次同按钮拉到同一封就跳过。
// 仅作用于"邮件整理"按钮路径;agent 通过 mail_list MCP 工具读邮件不受影响。
// 存盘:userData/email-summary-seen.json = { "<msgId>": <markedAtMs>, ... }
// 30 天前的条目启动时清理(和邮件本身的 30 天清理对齐)。
const fs = require('fs')
const path = require('path')

const KEEP_DAYS = 30

function fp(userDataDir) { return path.join(userDataDir, 'email-summary-seen.json') }

function load(userDataDir) {
  try { const obj = JSON.parse(fs.readFileSync(fp(userDataDir), 'utf8')); return obj && typeof obj === 'object' ? obj : {} }
  catch { return {} }
}
function save(userDataDir, data) {
  try { fs.writeFileSync(fp(userDataDir), JSON.stringify(data, null, 2)) } catch {}
}

function markSeen(userDataDir, messageIds) {
  if (!messageIds || !messageIds.length) return
  const data = load(userDataDir)
  const now = Date.now()
  for (const id of messageIds) {
    if (!id) continue
    const stripped = String(id).replace(/^<|>$/g, '')
    data[stripped] = now
  }
  save(userDataDir, data)
}

function isSeenSet(userDataDir) {
  const data = load(userDataDir)
  const s = new Set()
  for (const k of Object.keys(data)) s.add(k)
  return s
}

function prune(userDataDir, days, log) {
  days = days || KEEP_DAYS
  const data = load(userDataDir)
  const cutoff = Date.now() - days * 86400000
  let removed = 0
  for (const id of Object.keys(data)) {
    if (data[id] < cutoff) { delete data[id]; removed++ }
  }
  if (removed) {
    save(userDataDir, data)
    if (log) log('email-summary-seen prune: removed ' + removed + ' entries older than ' + days + 'd')
  }
  return removed
}

module.exports = { load, save, markSeen, isSeenSet, prune, KEEP_DAYS }
