'use strict'

module.exports = function initTrigger(S, { path, fs, app, log, spawnEmailCard, createMailCenter, Notification }) {
  const stateFile = path.join(app.getPath('userData'), 'trigger-state.json')

  function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return {} } }
  function saveState(s) { try { fs.writeFileSync(stateFile, JSON.stringify(s)) } catch {} }

  function markRanToday() { const s = loadState(); s.emailLastDate = new Date().toDateString(); saveState(s) }

  // 晨间不再自动弹摘要卡(交互统一到邮件中心)：到点弹一条桌面通知，点击打开邮件中心，
  // 用户在中心点「今日摘要」按需让 AI 整理。每个工作日只提醒一次。
  function runEmailSummary(source) {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) { log('trigger: IMAP 未配置，跳过晨间提醒'); return }
    log('trigger: 晨间邮件提醒（触发源：' + source + '）')
    try {
      if (Notification && Notification.isSupported()) {
        const n = new Notification({ title: 'BocomHermes · 今日邮件', body: '点击打开邮件中心，整理今天的邮件' })
        n.on('click', () => { try { createMailCenter && createMailCenter() } catch (e) { log('trigger: open center err: ' + e.message) } })
        n.show()
      }
    } catch (e) { log('trigger: 晨间提醒失败: ' + e.message) }
    markRanToday()
  }

  function shouldRunToday() {
    const now = new Date()
    const day = now.getDay()           // 0=周日 6=周六
    if (day === 0 || day === 6) return false
    const hour = now.getHours()
    const schedHour = (S.settings.imap && S.settings.imap.scheduleHour != null)
      ? S.settings.imap.scheduleHour : 9
    if (hour < schedHour || hour > 20) return false
    const state = loadState()
    return state.emailLastDate !== now.toDateString()
  }

  // 启动 5 秒后检查：今天还没跑过 → 补跑
  setTimeout(() => { if (shouldRunToday()) runEmailSummary('startup') }, 5000)

  // 每 30 分钟轮询一次（命中时间窗且今天未跑过）
  setInterval(() => { if (shouldRunToday()) runEmailSummary('interval') }, 30 * 60 * 1000)

  log('trigger: 邮件摘要调度器已初始化')

  // 返回手动触发接口（供 IPC 调用）
  return { runEmailSummary }
}
