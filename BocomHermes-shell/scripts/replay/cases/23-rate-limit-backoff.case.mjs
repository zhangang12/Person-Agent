// 用例㉓:并发上限的 429 自适应退避。
//
// 背景:编排按视角扇出之后,4 个并发位会被排队堵住,所以缺省从 4 提到了 8。
// 但提上限【必须】配退避 —— 原来壳层见到 429 只是把它翻译成一句人话给用户看
// (session.js 的错误码人话化),既不重试也不降速。并发翻倍 = 429 概率一起翻倍,
// 而内网端点一旦开始限流,后面每一片都在撞同一堵墙。
//
// 策略:见到 429 就把【有效上限】对半砍,每 2 分钟恢复一档,最低不低于 1。
// 刻意做成"探上去、撞到就退"而不是"一直保守":慢端点的吞吐本来就只能靠试出来,
// 一开始就压到 2 是把没撞墙的场景一起罚了。
//
// 跑法:node scripts/replay/run.mjs 23
import { ok } from '../harness.mjs'

export default {
  name: '㉓并发上限:撞 429 自动降档,过了恢复窗自动还回来',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 8 } },
  async run(world) {
    const S = world.S

    ok('S.noteRateLimit 已挂载(session.js 撞到 429 时回调它)', typeof S.noteRateLimit === 'function')
    ok('S.wfConcurrency 已挂载', typeof S.wfConcurrency === 'function')
    if (typeof S.noteRateLimit !== 'function' || typeof S.wfConcurrency !== 'function') return

    ok('没撞墙时用满配置值(8)', S.wfConcurrency() === 8, S.wfConcurrency())

    // 撞一次 → 对半
    S.noteRateLimit()
    ok('★撞一次 429 → 有效上限对半砍到 4', S.wfConcurrency() === 4, S.wfConcurrency())

    // 5s 内的连撞只算一档:一波并发同时撞墙会连报好几条,不能一口气砍到底
    S.noteRateLimit(); S.noteRateLimit(); S.noteRateLimit()
    ok('★5s 内连撞只降一档(一波并发会同时报好几条,不能一口气砍到 1)', S.wfConcurrency() === 4, S.wfConcurrency())

    // 把上一次撞墙时间往前推 6s,让下一次撞墙能再降一档
    S.__rlBackdate ? S.__rlBackdate(6000) : null
    if (typeof S.__rlBackdate === 'function') {
      S.noteRateLimit()
      ok('隔开 5s 后再撞 → 再降一档(8→4→2)', S.wfConcurrency() === 2, S.wfConcurrency())
      // 过一个恢复窗(2 分钟)→ 还一档
      S.__rlBackdate(2 * 60 * 1000)
      ok('★过一个恢复窗自动还一档(2→4)', S.wfConcurrency() === 4, S.wfConcurrency())
      S.__rlBackdate(10 * 60 * 1000)
      ok('★长时间不撞墙,完全恢复到满配置(不留永久惩罚)', S.wfConcurrency() === 8, S.wfConcurrency())
    }

    ok('★最低不低于 1(降到底也不能把并发闸锁死)', (() => {
      for (let i = 0; i < 12; i++) { S.noteRateLimit(); if (typeof S.__rlBackdate === 'function') S.__rlBackdate(6000) }
      return S.wfConcurrency() >= 1
    })(), S.wfConcurrency())
  },
}
