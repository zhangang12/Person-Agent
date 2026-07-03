'use strict'

module.exports = function initTodos(S, { ipcMain, app, path, fs, log }) {
  const todosFile = path.join(app.getPath('userData'), 'todos.json')

  function load() { try { const a = JSON.parse(fs.readFileSync(todosFile, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
  function save(list) { try { fs.writeFileSync(todosFile, JSON.stringify(list, null, 2)) } catch (e) { log('todos save err: ' + e.message) } }
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

  ipcMain.handle('todo-list', () => load())

  ipcMain.handle('todo-add', (_e, item) => {
    const list = load()
    // 去重:同 text + from 不重复(已 done 的也算重复 → 避免反复加同样的事)
    if (list.some(t => t.text === item.text && t.from === item.from)) return null
    // 回填邮件 metadata 优先顺序:
    //  1) mailMsgId(跨会话稳定)→ 先 mailLastBatch(有正文),否则 mailCache(仅 metadata)
    //  2) mailIdx(本会话序号,老格式)→ mailLastBatch
    //  3) 调用方显式传入的 mailSubject / mailDate / mailBody
    let mailMeta = {}, resolvedMsgId = ''
    if (item.mailMsgId) {
      resolvedMsgId = String(item.mailMsgId).replace(/^<|>$/g, '')
      const m1 = S.mailLastBatch && Array.isArray(S.mailLastBatch.emails)
        ? S.mailLastBatch.emails.find(e => e.messageId === resolvedMsgId) : null
      if (m1) {
        mailMeta = { mailSubject: m1.subject || '', mailDate: m1.date || '', mailBody: (m1.body || '').slice(0, 2000) }
        if (!item.from) item.from = m1.from || ''
      } else if (S.mailCache && S.mailCache.has(resolvedMsgId)) {
        const c = S.mailCache.get(resolvedMsgId)
        mailMeta = { mailSubject: c.subject || '', mailDate: c.date || '', mailBody: '' }
        if (!item.from) item.from = c.from || ''
      }
    }
    if (!mailMeta.mailSubject && item.mailIdx && S.mailLastBatch && Array.isArray(S.mailLastBatch.emails)) {
      const idx = parseInt(item.mailIdx) - 1
      const mail = idx >= 0 && idx < S.mailLastBatch.emails.length ? S.mailLastBatch.emails[idx] : null
      if (mail) {
        mailMeta = { mailSubject: mail.subject || '', mailDate: mail.date || '', mailBody: (mail.body || '').slice(0, 2000) }
        if (!resolvedMsgId) resolvedMsgId = mail.messageId || ''
        if (!item.from) item.from = mail.from || ''
      }
    }
    const todo = {
      id: genId(),
      text: String(item.text || '').slice(0, 200),
      from: String(item.from || ''),
      urgency: item.urgency || '中',
      done: false,
      createdAt: Date.now(),
      source: item.source || 'manual',
      remindAt: Number(item.remindAt) || 0,   // 到点提醒时间戳(ms),0=不提醒
      remindedAt: 0,                          // 已弹提醒时间戳,防重复
      mailMsgId:   resolvedMsgId || (item.mailMsgId ? String(item.mailMsgId).replace(/^<|>$/g, '') : ''),
      mailSubject: mailMeta.mailSubject || (item.mailSubject ? String(item.mailSubject).slice(0, 200) : ''),
      mailDate:    mailMeta.mailDate    || (item.mailDate    ? String(item.mailDate).slice(0, 50) : ''),
      mailBody:    mailMeta.mailBody    || (item.mailBody    ? String(item.mailBody).slice(0, 2000) : ''),
    }
    list.unshift(todo)
    save(list)
    log('todo-add: ' + todo.text.slice(0, 60) + (todo.source === 'email' ? ' [来自邮件' + (todo.mailSubject ? ':' + todo.mailSubject.slice(0,30) : '') + (todo.mailMsgId ? ' msgId=' + todo.mailMsgId.slice(0,30) : '') + ']' : '') + (todo.remindAt ? ' ⏰' + new Date(todo.remindAt).toLocaleString('zh-CN') : ''))
    return todo
  })

  ipcMain.handle('todo-toggle', (_e, id) => {
    const list = load()
    const t = list.find(x => x.id === id); if (t) { t.done = !t.done; t.updatedAt = Date.now(); save(list) }
    return list
  })

  // 改文本/提醒时间;改 remindAt 时清 remindedAt 让提醒重新生效
  ipcMain.handle('todo-update', (_e, { id, patch }) => {
    const list = load()
    const t = list.find(x => x.id === id); if (!t) return null
    if (patch && patch.remindAt !== undefined) { t.remindAt = Number(patch.remindAt) || 0; t.remindedAt = 0 }
    if (patch && patch.text !== undefined) t.text = String(patch.text).slice(0, 200)
    t.updatedAt = Date.now(); save(list)
    return t
  })

  ipcMain.handle('todo-delete', (_e, id) => {
    const list = load().filter(x => x.id !== id); save(list); return list
  })

  ipcMain.handle('todo-clear-done', () => {
    const list = load().filter(x => !x.done); save(list); return list
  })

  // ── 建议待办(从邮件自动识别的会议,人工确认后才进正式待办)────────────────
  // 三态:pending(待确认) / accepted / dismissed;按 msgId 去重,一封邮件只建议一次
  const suggestFile = path.join(app.getPath('userData'), 'todo-suggest.json')
  function loadSug() { try { const a = JSON.parse(fs.readFileSync(suggestFile, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
  function saveSug(l) { try { fs.writeFileSync(suggestFile, JSON.stringify(l, null, 2)) } catch (e) { log('suggest save err: ' + e.message) } }
  function addSuggestion(s) {   // s:{msgId,from,subject,date,text,meetingAt,link}
    if (!s || !s.msgId) return null
    const list = loadSug()
    if (list.some(x => x.msgId === s.msgId)) return null
    const sug = { id: genId(), status: 'pending', createdAt: Date.now(), ...s }
    list.unshift(sug); saveSug(list.slice(0, 100))
    log('todo-suggest: ' + (sug.text || '').slice(0, 60) + (sug.meetingAt ? ' @' + new Date(sug.meetingAt).toLocaleString('zh-CN') : ''))
    return sug
  }
  ipcMain.handle('todo-suggest-list', () => loadSug().filter(s => s.status === 'pending'))
  ipcMain.handle('todo-suggest-dismiss', (_e, id) => { const l = loadSug(); const s = l.find(x => x.id === id); if (s) { s.status = 'dismissed'; saveSug(l) } return true })
  // accept:renderer 先调 todo-add({text,source:'email',mailMsgId,remindAt}) 再调本接口标记
  ipcMain.handle('todo-suggest-accept', (_e, id) => { const l = loadSug(); const s = l.find(x => x.id === id); if (s) { s.status = 'accepted'; saveSug(l) } return true })

  return { load, save, addSuggestion }
}
