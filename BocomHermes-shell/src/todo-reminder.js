'use strict'
// 待办提醒调度器:每 30s 扫一遍 todos.json,到期未提醒的弹系统通知。
// 点通知:有邮件来源开原文窗口,否则开邮件中心待办 tab。先落盘 remindedAt 再弹(弹失败也不轰炸)。
module.exports = function initTodoReminder(S, { log, Notification, BrowserWindow, todosApi, createMailCenter, openMailView }) {
  const TICK = 30 * 1000
  function check() {
    const now = Date.now()
    const list = todosApi.load()
    let dirty = false
    for (const t of list) {
      if (t.done || !t.remindAt || t.remindedAt || t.remindAt > now) continue
      t.remindedAt = now; dirty = true
      try {
        if (Notification && Notification.isSupported()) {
          const n = new Notification({
            title: '⏰ 待办提醒',
            body: String(t.text || '').slice(0, 120) + (t.mailSubject ? '\n📧 ' + t.mailSubject.slice(0, 60) : ''),
          })
          n.on('click', () => {
            try { t.mailMsgId ? openMailView(t.mailMsgId) : createMailCenter('todos') }
            catch (e) { log('reminder click err: ' + e.message) }
          })
          n.show()
          log('todo-reminder fired: ' + String(t.text || '').slice(0, 40))
        }
      } catch (e) { log('todo-reminder err: ' + e.message) }
    }
    if (dirty) {
      todosApi.save(list)
      for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('todos-updated') } catch {} }
    }
  }
  setInterval(check, TICK)
  setTimeout(check, 8000)   // 启动补检:关机期间错过的到期提醒补弹一次(UI 侧会标红"已过期")
  log('todo-reminder: 提醒调度器已初始化(30s tick)')
}
