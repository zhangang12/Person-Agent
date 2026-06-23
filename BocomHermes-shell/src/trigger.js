'use strict'

module.exports = function initTrigger(S, { path, fs, app, log, spawnEmailCard, Notification }) {
  const stateFile = path.join(app.getPath('userData'), 'trigger-state.json')
  // 自动摘要"真失败"(连不上 IMAP 等)时弹桌面通知 —— 否则用户以为"今天没邮件",其实是拉挂了
  const BENIGN = /没有邮件|已整理过|IMAP 未配置/
  function notifyFail(msg) {
    try { if (Notification && Notification.isSupported()) new Notification({ title: 'BocomHermes · 邮件自动摘要失败', body: msg.slice(0, 160) }).show() } catch {}
  }

  function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return {} } }
  function saveState(s) { try { fs.writeFileSync(stateFile, JSON.stringify(s)) } catch {} }

  // 防漏:成功(或良性"没新邮件")才标记今天已跑;真失败不标记 + 退避重试,耗尽后靠 30 分钟轮询窗兜底
  let running = false, retryTimer = null, retryCount = 0
  const MAX_RETRY = 3
  function markRanToday() {
    const s = loadState(); s.emailLastDate = new Date().toDateString(); saveState(s)
    retryCount = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  }
  function scheduleRetry() {
    if (retryCount >= MAX_RETRY) { log('trigger: 重试已达上限，等下个轮询窗再试'); retryCount = 0; return }
    const delay = Math.min(30000 * Math.pow(4, retryCount), 8 * 60 * 1000)   // 30s → 2min → 8min
    retryCount++
    log('trigger: ' + Math.round(delay / 1000) + 's 后重试邮件摘要（第 ' + retryCount + '/' + MAX_RETRY + ' 次）')
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => runEmailSummary('retry'), delay)
  }

  async function runEmailSummary(source) {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) {
      log('trigger: IMAP 未配置，跳过邮件摘要')
      return
    }
    if (running) { log('trigger: 已在拉取中，跳过本次（' + source + '）'); return }   // 防轮询与重试并发重复拉
    running = true
    log('trigger: 开始拉取邮件摘要（触发源：' + source + '）')
    try {
      await spawnEmailCard()
      markRanToday()                              // 修复：旧逻辑"先标记今天已跑、再拉取"，一旦拉取失败当天就永久漏拉
    } catch (e) {
      if (BENIGN.test(e.message || '')) {         // 良性（没新邮件/已整理过）= 确实跑过了 → 标记，不重试
        log('trigger: ' + e.message)
        markRanToday()
      } else {                                    // 真失败 → 不标记 today，退避重试
        log('trigger: 邮件摘要失败: ' + e.message)
        notifyFail(e.message || '未知错误')
        scheduleRetry()
      }
    } finally {
      running = false
    }
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
