'use strict'
// 发件箱(发信安全闸门)—— agent 自主发信不再"即发即出",先进队列延迟 N 秒,
// 期间用户可在发件箱面板「撤销」(软撤回)或「立即发送」。hold=0 等价旧的即时发送。
//   · 防误发:agent 发错对象/错内容,有一个窗口能拦下
//   · 防丢:状态持久化到 userData/outbox.json,崩溃重启不丢"待发";"发送中"崩溃则标 unknown 不自动重发(防重复发)
//   · 顺带:定时发送(sendAt 设未来时刻)
module.exports = function initOutbox({ file, fs, log, send, broadcast, notify }) {
  let items = []
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(a)) items = a } catch {}
  // 重启清理:'sending' 中途崩溃 → 结果未知,不自动重发(可能已发出),交给用户判断
  for (const it of items) if (it.status === 'sending') { it.status = 'unknown'; it.ts = Date.now(); it.error = '应用在发送过程中退出,结果未知,请到"已发送"核实是否已发出' }

  function save() { try { fs.writeFileSync(file, JSON.stringify(items.slice(-50))) } catch (e) { log && log('outbox save err: ' + e.message) } }
  function prune() { // 只保留最近 50 条;待发/发送中/未知(需用户处理)始终留,sent/canceled/failed 超 24h 的清掉
    const cut = Date.now() - 24 * 3600 * 1000
    const keep = (it) => it.status === 'pending' || it.status === 'sending' || it.status === 'unknown' || (it.ts || 0) > cut
    items = items.filter(keep).slice(-50)
  }
  function emit() { try { broadcast && broadcast() } catch {} }

  async function fire(it) {
    if (it.status !== 'pending') return
    it.status = 'sending'; save(); emit()
    try {
      const res = await send(it)               // 真正走 SMTP(由 window.js 注入)
      it.status = 'sent'; it.sentAt = Date.now(); it.ts = Date.now()
      if (res && res.info) it.info = res.info
    } catch (e) {
      it.status = 'failed'; it.error = (e && e.message) || '发送失败'; it.ts = Date.now()
      log && log('outbox 发送失败: ' + it.error)
      try { notify && notify('邮件发送失败', (it.meta && it.meta.subject ? '「' + it.meta.subject + '」 ' : '') + it.error) } catch {}
    }
    save(); emit()
  }

  // 每秒一次:到点的 pending 触发发送
  const timer = setInterval(() => {
    const now = Date.now()
    for (const it of items) if (it.status === 'pending' && it.sendAt <= now) fire(it)
  }, 1000)
  if (timer.unref) timer.unref()

  return {
    // o: { kind, msg, meta, holdSeconds }
    enqueue(o) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const hold = Math.max(0, Math.min(+o.holdSeconds || 0, 3600))
      const now = Date.now()
      const it = { id, kind: o.kind, msg: o.msg, meta: o.meta || {}, holdSeconds: hold,
        createdAt: now, ts: now, sendAt: now + hold * 1000, status: 'pending' }
      items.push(it); prune(); save(); emit()
      if (hold === 0) fire(it)                  // 立即发:不等下一个 tick
      return { id, sendAt: it.sendAt, holdSeconds: hold }
    },
    cancel(id) {
      const it = items.find((x) => x.id === id)
      if (!it) return { ok: false, error: '找不到该发件项' }
      if (it.status !== 'pending') return { ok: false, error: '已' + ({ sending: '在发送中', sent: '发出', canceled: '撤销', failed: '失败', unknown: '处于未知状态' }[it.status] || it.status) + ',无法撤销' }
      it.status = 'canceled'; it.ts = Date.now(); save(); emit()
      return { ok: true }
    },
    sendNow(id) {
      const it = items.find((x) => x.id === id)
      if (!it) return { ok: false, error: '找不到该发件项' }
      if (it.status !== 'pending') return { ok: false, error: '不是待发状态,无法立即发送' }
      it.sendAt = Date.now(); fire(it)
      return { ok: true }
    },
    list() {
      prune()
      return items.slice().reverse().map((it) => ({
        id: it.id, kind: it.kind, status: it.status, error: it.error || null,
        sendAt: it.sendAt, createdAt: it.createdAt, holdSeconds: it.holdSeconds,
        to: it.meta.to || '', subject: it.meta.subject || '', attCount: it.meta.attCount || 0,
      }))
    },
    pendingCount() { return items.filter((it) => it.status === 'pending').length },
  }
}
