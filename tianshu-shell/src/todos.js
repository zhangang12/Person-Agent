'use strict'

module.exports = function initTodos(S, { ipcMain, app, path, fs, log }) {
  const todosFile = path.join(app.getPath('userData'), 'todos.json')

  function load() { try { const a = JSON.parse(fs.readFileSync(todosFile, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
  function save(list) { try { fs.writeFileSync(todosFile, JSON.stringify(list, null, 2)) } catch (e) { log('todos save err: ' + e.message) } }
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

  ipcMain.handle('todo-list', () => load())

  ipcMain.handle('todo-add', (_e, item) => {
    const list = load()
    // 去重：同 text + from 不重复添加
    if (list.some(t => !t.done && t.text === item.text && t.from === item.from)) return null
    const todo = { id: genId(), text: String(item.text || '').slice(0, 200), from: String(item.from || ''), urgency: item.urgency || '中', done: false, createdAt: Date.now(), source: item.source || 'manual' }
    list.unshift(todo)
    save(list)
    log('todo-add: ' + todo.text.slice(0, 60))
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
