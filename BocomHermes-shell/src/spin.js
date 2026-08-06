'use strict'
// 空转探测(think-loop):区分【在长考】与【在原地打转】。纯逻辑,不碰时钟/IO,可单测。
//
// ── 为什么现有的闸全都抓不到 ────────────────────────────────────────────────
// 全仓所有"还活着吗"的判据问的都是【字节有没有变】:
//   · session.js 的内容签名 partLivenessSig 里有 t.length 与 t.slice(-16) —— reasoning 每涨一段必变;
//   · 子 Agent 看门狗的前置闸是 `Date.now() - c.time.updated < 30min → continue` —— 它一直在写消息,
//     updated 永远新鲜,于是后面那句 generationStalled(判据本身是对的,tool-part-selftest 明确测过
//     "reasoning 有、text 空、无工具 → true")【永远没机会跑】。
// 而 think-loop 恰恰是永远在变字节 —— 它不静默,它只是不干活。所以三条闸一致把空转认成"在长考"。
// 4243cb5 把各处判死线从 5min 放宽到 30min/2h 是刻意的("判死不判慢"),但它放宽的是【静默】口径,
// think-loop 根本不静默 —— 这是判据【维度缺失】,不是刻意容忍。
//
// ── 判据:两条同时成立才算空转 ──────────────────────────────────────────────
// ① 不产出:窗口内零工具调用、零非空文本 —— 只有 reasoning 在涨。
// ② 自重复:reasoning 在【重复同一段内容】。
// 缺任何一条都不判:
//   · 只有 ① = 一个模型在长考,正是"判死不判慢"要保护的场景,绝不能杀;
//   · 只有 ② = 它一边重复一边还在调工具/出正文,说明确实在推进,重复只是啰嗦。
// 用户实测的原话是"循环输出同一个 think"—— ② 正是这句话里那个"同一个"。
//
// ── 为什么重复要按段落判而不是整段比 ────────────────────────────────────────
// 流式 reasoning 是不断追加的,整段永远不相等。真正在打转时,是【同一个段落】被反复重新吐出来。
// 所以按段落切、归一化(压空白、去序号、截长)、算轻量指纹,再数重复次数。

/** 归一化一个段落:压空白、剥常见的序号/项目符号前缀、截断 —— 让"同一段又说了一遍"能对上 */
function normSeg(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/^[\s>*\-•·—]+/, '')
    .replace(/^第\s*\d+\s*[步条点项]\s*[.、)）:：]?\s*/, '')   // 第 2 步: / 第3条、
    .replace(/^\d+\s*[.、)）:：]\s*/, '')                        // 1. / 2)
    .trim()
    .slice(0, 240)
}

/** 轻量指纹(不引 crypto:本模块要能在任何上下文里跑,也不值得为几十字节算 sha) */
function fp(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36) + ':' + s.length
}

const DEFAULTS = {
  idleMs: 5 * 60 * 1000,   // 多久没有任何"产出"(工具/正文)就开始怀疑。比 30min 短很多 —— 有 ② 兜着,不怕误杀
  minLen: 24,              // 太短的段落不参与判重(“好的。”“继续。”这种到处都是)
  minRepeat: 3,            // 同一段重复几次算打转
  windowSegs: 40,          // 条数窗口:防长跑膨胀
  windowMs: 10 * 60 * 1000, // ★时间窗口:判的是"此刻在不在打转"。只按条数老化不够 ——
                            //   短段落会被 minLen 丢掉、不占位,于是新内容再多也挤不走老的重复,
                            //   "二十分钟前重复过三次"会被一直算成现在还在打转(自测用例8 抓到的)。
}

/**
 * 造一个探测器。每个会话(或子 Agent)一个。
 * 用法:
 *   const d = createSpin()
 *   d.note({ kind: 'reasoning', text: '…', at })   // 每来一段就喂
 *   d.note({ kind: 'tool', at })                    // 有工具调用 = 在干活
 *   d.verdict(at) → { spinning, idleMs, repeats, sample }
 */
function createSpin(opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {})
  let lastProductiveAt = 0      // 最近一次【真产出】(工具调用 / 非空正文)
  let startedAt = 0
  const segs = []               // 最近若干段 reasoning 的指纹
  const counts = new Map()      // 指纹 → 次数(只统计窗口内的)

  function drop(e) {
    const c = (counts.get(e.f) || 0) - 1
    if (c <= 0) counts.delete(e.f); else counts.set(e.f, c)
  }
  /** 老化:条数超窗 或 太久以前的,都出局 */
  function age(now) {
    while (segs.length > cfg.windowSegs) drop(segs.shift())
    while (segs.length && (now - segs[0].at) > cfg.windowMs) drop(segs.shift())
  }
  function pushSeg(f, at) {
    segs.push({ f, at })
    counts.set(f, (counts.get(f) || 0) + 1)
    age(at)
  }

  return {
    /** 喂一个事件。kind: reasoning | text | tool(其余一律忽略) */
    note(ev) {
      const e = ev || {}
      const at = +e.at || 0
      if (!startedAt) startedAt = at
      const kind = String(e.kind || '')
      if (kind === 'tool') { lastProductiveAt = at; return }
      const txt = String(e.text == null ? '' : e.text)
      if (kind === 'text') {
        // 空文本不算产出:网关会先开一个空的 text part 占位,认它等于给空转发续命
        if (txt.trim()) lastProductiveAt = at
        return
      }
      if (kind !== 'reasoning') return
      // 流式 reasoning 是【累积】的,所以只取新增的尾巴按段切;调用方喂全量或增量都能用
      for (const raw of txt.split(/\n{2,}|\n(?=[-*•·\d])/)) {
        const n = normSeg(raw)
        if (n.length >= cfg.minLen) pushSeg(fp(n), at)
      }
    },
    /** 现在算不算空转 */
    verdict(now) {
      const at = +now || 0
      age(at)                     // 先把过期的踢出去再数:判的是"此刻",不是"历史上曾经"
      const base = lastProductiveAt || startedAt
      const idle = base ? at - base : 0
      let repeats = 0
      for (const c of counts.values()) if (c > repeats) repeats = c
      const spinning = idle >= cfg.idleMs && repeats >= cfg.minRepeat
      return { spinning, idleMs: idle, repeats, segs: segs.length }
    },
    /** 回合重开时复位(新一轮重新计) */
    reset() { lastProductiveAt = 0; startedAt = 0; segs.length = 0; counts.clear() },
    /** 只读快照(排障用) */
    peek() { return { lastProductiveAt, startedAt, segs: segs.length, distinct: counts.size } },
  }
}

module.exports = { createSpin, normSeg, fp, DEFAULTS }
