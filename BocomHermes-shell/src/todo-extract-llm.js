'use strict'
// 邮件待办语义提取(LLM 复核):只挑两类 —— ①有明确截止时间的待办(ddl) ②会议待办(meeting)。
// 病灶:规则法(meeting-extract)关键词太宽("讨论/沟通/评审"+任意日期即命中),把没有行动要求的邮件全捞出来,
// 建议待办区被淹没(用户实测)。语义理解才能分清"这封邮件到底有没有要我做、什么时候前做"。
// 成本设计:壳层攒批(window.js 20s 或 8 封一冲),多封邮件一次调用 —— 内网模型慢,单封一调太贵;
// 模型只回 JSON 数组,本模块负责解析/校验/防幻觉(msgId 必须在批次内)/时间换算(复用 meeting-extract.resolveWhen)。
// 纯逻辑可单测:askLLM(prompt)→文本 由调用方注入,不连真 serve。
const { resolveWhen } = require('./meeting-extract')

// 便宜预筛:连日期/时间/截止信号都没有的邮件直接弃(省 LLM 调用)——语义提取只复核有信号的。
// 有意放宽(宁可多送候选给模型判,不在规则层误杀):真正的过滤由模型做。
function hasTimeSignal(em) {
  const t = (em.subject || '') + '\n' + String(em.text || em.body || '').slice(0, 2000)
  return /(\d{1,2}\s*[:点时]|\d{1,2}月\d{1,2}|\d{1,2}\/\d{1,2}|今天|明天|后天|周[一二三四五六日天]|星期|礼拜|下周|月底|年末|季度|截止|务必|请于|限期|deadline|due|ddl|会议|例会|邀请|约谈|invite|meeting)/i.test(t)
}

function buildPrompt(batch) {
  const list = batch.map((em) => ({
    msgId: em.messageId,
    from: String(em.from || '').slice(0, 60),
    subject: String(em.subject || '').slice(0, 120),
    date: em.date || '',
    body: String(em.text || em.body || '').replace(/\s+/g, ' ').slice(0, 600),
  }))
  return '你在过滤企业邮件,从下面邮件里只挑两类事项(宁可漏、不可滥):\n'
    + '1. "ddl":有明确截止时间的待办 —— 必须同时有【要做的事】和【明确的截止时间点/日期】(如"周五前提交""7月30日18:00截止""due by Friday")。\n'
    + '2. "meeting":会议待办 —— 有明确会议时间的会议/评审/培训/面试/约谈(有地点或会议链接更好,没有也行)。\n'
    + '【不要挑】:只是讨论/知会/FYI、没有截止或行动要求的;订阅/新闻/系统通知/广告;时间含糊的("近期""尽快""有空聊聊");\n'
    + '  已经过去的事项;签名/页脚/转发链里的时间(如"发送时间:""打印时间")。\n'
    + '邮件列表(JSON):\n' + JSON.stringify(list, null, 1) + '\n'
    + '只输出一个 JSON 数组,每项 {"msgId":"原样照抄","type":"ddl 或 meeting","title":"事项一句话≤40字","at":"时间点原文照抄(如 7月30日18:00 / 周五下午3点),没有就空串","link":"会议链接,没有就空串"}。\n'
    + '一封邮件最多挑 1 项;没有可挑的输出 []。不要输出任何解释、不要用 markdown 代码块。'
}

// 从模型回答里抠 JSON 数组:模型可能包废话/markdown 围栏 → 取第一个 [ 到最后一个 ]。
// 校验:msgId 必须是非空字符串;type 只认 ddl|meeting;title 截 80;同 msgId 只留第一项;整体 cap 20。解析失败 → []。
function parseItems(raw) {
  const s = String(raw || '')
  const i = s.indexOf('['), j = s.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  let arr
  try { arr = JSON.parse(s.slice(i, j + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const seen = new Set()
  const out = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const msgId = String(it.msgId || '')
    if (!msgId || seen.has(msgId)) continue
    const type = String(it.type || '').toLowerCase()
    if (type !== 'ddl' && type !== 'meeting') continue
    seen.add(msgId)
    out.push({ msgId, type, title: String(it.title || '').slice(0, 80), at: String(it.at || '').slice(0, 60), link: String(it.link || '').slice(0, 300) })
    if (out.length >= 20) break
  }
  return out
}

// 主入口:一批邮件 → 一次 LLM 调用 → 校验后的建议项数组。
// 每项:{msgId, kind:'ddl'|'meeting', from, subject, date, text, meetingAt, link}
// meetingAt 由 at 原文经 resolveWhen 换算(基准=邮件日期);解不出为 0(只建议不提醒,人工确认区兜底)。
async function extract(batch, askLLM) {
  const ems = (batch || []).filter((e) => e && e.messageId).slice(0, 12)
  if (!ems.length) return []
  const raw = await askLLM(buildPrompt(ems))
  const items = parseItems(raw)
  const byId = new Map(ems.map((e) => [e.messageId, e]))
  const out = []
  for (const it of items) {
    const em = byId.get(it.msgId)
    if (!em) continue   // 模型编造的 msgId 直接丢(防幻觉)
    out.push({
      msgId: it.msgId, kind: it.type,
      from: em.from || '', subject: em.subject || '', date: em.date || '',
      text: it.title || String(em.subject || '待办').slice(0, 80),
      meetingAt: resolveWhen(it.at, Date.parse(em.date)) || 0,
      link: it.link || '',
    })
  }
  return out
}

module.exports = { hasTimeSignal, buildPrompt, parseItems, extract }
