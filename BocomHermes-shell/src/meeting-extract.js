'use strict'
// 规则法会议信息抽取:中文日期时间 + 会议关键词/会议链接。
// 有意保守:解析不出可信时间就 meetingAt=0(只给建议不给提醒时间),人工确认区兜底误报。
const KW   = /(会议|例会|评审|复盘|周会|晨会|培训|面试|路演|宣讲|讨论|碰头|沟通|约.{0,8}[点时]|meeting|invite|calendar)/i
const LINK = /(https?:\/\/[^\s"'<>]*(?:meeting\.tencent\.com|voovmeeting\.com|zoom\.(?:us|com\.cn)\/j|vc\.feishu\.cn|meetings\.feishu\.cn|teams\.microsoft\.com|webex\.com)[^\s"'<>]*)/i
const DATE = /((?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]|(\d{1,2})[/](\d{1,2})|今天|明天|后天|(?:下?周|星期|礼拜)([一二三四五六日天]))/
const TIME = /(上午|下午|早上|中午|晚上)?\s*(\d{1,2})\s*[:点时]\s*(\d{2}|半)?/
const CN_D = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

// dm=DATE 的 match,tm=TIME 的 match,base=收信时间;返回 ms 时间戳或 0
function resolveDateTime(dm, tm, base) {
  const b = base && !isNaN(+base) ? new Date(+base) : new Date()
  let d = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  if (dm[3] && dm[4]) d = new Date(dm[2] ? +dm[2] : b.getFullYear(), +dm[3] - 1, +dm[4])
  else if (dm[5] && dm[6]) d = new Date(b.getFullYear(), +dm[5] - 1, +dm[6])
  else if (dm[1] === '明天') d.setDate(d.getDate() + 1)
  else if (dm[1] === '后天') d.setDate(d.getDate() + 2)
  else if (dm[7] != null) {
    const tgt = CN_D[dm[7]]
    let diff = (tgt - b.getDay() + 7) % 7
    if (/下周/.test(dm[1])) diff += diff === 0 ? 7 : (b.getDay() > tgt ? 0 : 7)
    else if (diff === 0) diff = 7   // "周三"在周三当天说 → 下周三(当天的会通常写"今天")
    d.setDate(d.getDate() + diff)
  } else if (dm[1] !== '今天') return 0
  let h = 0, mi = 0
  if (tm) {
    h = +tm[2] % 24
    mi = tm[3] === '半' ? 30 : (+tm[3] || 0)
    if (/(下午|晚上)/.test(tm[1] || '') && h < 12) h += 12
  }
  d.setHours(h, mi, 0, 0)
  if (!dm[2] && d.getTime() < +b - 86400000) d.setFullYear(d.getFullYear() + 1)   // 无年份跨年兜底
  return d.getTime()
}

// em: {subject,text,body,date} → {meetingAt,link,snippet} 或 null
function extractMeeting(em) {
  const txt = (em.subject || '') + '\n' + String(em.text || em.body || '').slice(0, 3000)
  const link = (txt.match(LINK) || [])[1] || ''
  if (!KW.test(txt) && !link) return null
  const dm = txt.match(DATE)
  if (!dm && !link) return null
  const tm = txt.match(TIME)
  const meetingAt = dm ? resolveDateTime(dm, tm, Date.parse(em.date)) : 0
  if (!meetingAt && !link) return null
  return { meetingAt, link, snippet: ((dm ? dm[0] : '') + (tm ? ' ' + tm[0] : '')).trim() }
}

module.exports = { extractMeeting }
