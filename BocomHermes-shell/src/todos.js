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
    // mailIdx 在场 → 从 lastBatch 取邮件主题/日期/正文摘要回填(rich.js 解析 TODO 行时透传过来)
    let mailMeta = {}
    if (item.mailIdx && S.mailLastBatch && Array.isArray(S.mailLastBatch.emails)) {
      const idx = parseInt(item.mailIdx) - 1
      const mail = idx >= 0 && idx < S.mailLastBatch.emails.length ? S.mailLastBatch.emails[idx] : null
      if (mail) {
        mailMeta = {
          mailSubject: mail.subject || '',
          mailDate: mail.date || '',
          mailBody: (mail.body || '').slice(0, 2000),
        }
        // from 没填的话用邮件发件人
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
      mailSubject: mailMeta.mailSubject || (item.mailSubject ? String(item.mailSubject).slice(0, 200) : ''),
      mailDate:    mailMeta.mailDate    || (item.mailDate    ? String(item.mailDate).slice(0, 50) : ''),
      mailBody:    mailMeta.mailBody    || (item.mailBody    ? String(item.mailBody).slice(0, 2000) : ''),
    }
    list.unshift(todo)
    save(list)
    log('todo-add: ' + todo.text.slice(0, 60) + (todo.source === 'email' ? ' [来自邮件' + (todo.mailSubject ? ':'+todo.mailSubject.slice(0,30) : '') + ']' : ''))
    return todo
  })

  ipcMain.handle('todo-toggle', (_e, id) => {
    const list = load()
    const t = list.find(x => x.id === id); if (t) { t.done = !t.done; t.updatedAt = Date.now(); save(list) }
    return list
  })

  ipcMain.handle('todo-delete', (_e, id) => {
    const list = load().filter(x => x.id !== id); save(list); return list
  })

  ipcMain.handle('todo-clear-done', () => {
    const list = load().filter(x => !x.done); save(list); return list
  })
}
