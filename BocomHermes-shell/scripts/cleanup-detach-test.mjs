// 自测:src/card-cleanup.js(卡关闭清理链)—— 波3 钉出/收回的 detach 语义与全清理语义逐项过:
//   ①全清理:abort/删会话/退休 serve/wf 落 interrupted+存档/wfDequeue/orch 级联/forgetBusy 一项不漏
//   ②done 终态不被覆写 ③detach:会话活着(si.wc 置空、sid 键会话态全留)、wf 不收官、wc 键登记摘净、幂等
//   ④幂等:同一 wcId 重复清理安全 ⑤orch 级联杀分片
// 跑法:npm run cleanup:test(零依赖 ok() 风格;假 oc/log/BrowserWindow 全注入,不碰 electron)
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const makeCardCleanup = require('../src/card-cleanup.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

// ── 装配:每个用例一套全新 S/依赖,互不染指 ──
function makeHarness() {
  const calls = { abort: [], retire: [], archive: [], dequeue: 0, forget: [], dropPerm: [], dropQ: [] }
  const serve = { base: 'http://127.0.0.1:4999' }
  const S = {
    sessionByWc: new Map([[101, 's1']]),
    sessionInfo: new Map([['s1', { wc: { id: 101 }, serve }]]),
    streamBuf: new Map([['s1', 'buf']]),
    sentPrompt: new Map([['s1', 'p']]),
    firstMsgCtx: new Map([['s1', 'c']]),
    cardWcById: new Map([[7, 101]]),
    embedWc: new Set([101]),
    shardWc: new Set([101]),
    shardForceClose: new Set([101]),
    cardDir: new Map([[101, '/proj']]),
    modelByWc: new Map([[101, 'qwen3-coder']]),
    wfCardByWc: new Map(),
    orchByTag: new Map(),
    wfRegistry: new Map(),
    dropPendingPerm: (sid) => calls.dropPerm.push(sid),
    dropPendingQuestion: (sid) => calls.dropQ.push(sid),
    wfArchive: (r) => calls.archive.push(r),
  }
  const oc = {
    abort: (...a) => calls.abort.push(a),
    retireIfOrphan: (...a) => { calls.retire.push(a); return true },
  }
  const timers = new Map([[101, 999]])
  const wins = []
  const BrowserWindow = { getAllWindows: () => wins }
  const cleanup = makeCardCleanup({
    S, oc, log: () => {}, BrowserWindow,
    getShardSettleTimers: () => timers,
    wfDequeue: () => { calls.dequeue++ },
    forgetBusy: (id) => calls.forget.push(id),
  })
  return { S, oc, calls, timers, wins, cleanup, serve }
}

console.log('card-cleanup 自测')

// ── 用例 1:全清理(独立卡窗 closed)────────────────────────────
{
  const { S, calls, timers, cleanup, serve } = makeHarness()
  const wreg = { id: 9, kind: 'chat', status: 'running', at: Date.now() - 5000 }
  S.wfCardByWc.set(101, wreg)
  cleanup(S, 101, null)
  ok('abort 会话', calls.abort.length === 1 && calls.abort[0][0] === serve && calls.abort[0][1] === 's1')
  ok('sessionInfo 删除', !S.sessionInfo.has('s1'))
  ok('streamBuf/sentPrompt/firstMsgCtx 删除', !S.streamBuf.has('s1') && !S.sentPrompt.has('s1') && !S.firstMsgCtx.has('s1'))
  ok('pending 审批/提问清理', calls.dropPerm.join() === 's1' && calls.dropQ.join() === 's1')
  ok('wc 键登记摘净', !S.sessionByWc.has(101) && !S.cardWcById.has(7) && !S.embedWc.has(101) && !S.shardWc.has(101) && !S.shardForceClose.has(101) && !S.cardDir.has(101) && !S.modelByWc.has(101))
  ok('孤儿 serve 退休', calls.retire.length === 1 && calls.retire[0][0] === serve)
  ok('wf 落 interrupted', wreg.status === 'interrupted' && typeof wreg.elapsedMs === 'number')
  ok('wf 存档 + 摘键 + 补位', calls.archive.length === 1 && calls.archive[0] === wreg && !S.wfCardByWc.has(101) && calls.dequeue === 1)
  ok('落定计时清除', !timers.has(101))
  ok('forgetBusy', calls.forget.join() === '101')
}

// ── 用例 2:done 终态不被覆写 ────────────────────────────────
{
  const { S, calls, cleanup } = makeHarness()
  const wreg = { id: 10, kind: 'chat', status: 'done', at: Date.now() - 5000 }
  S.wfCardByWc.set(101, wreg)
  cleanup(S, 101, null)
  ok('done 保持 done', wreg.status === 'done')
  ok('done 也存档', calls.archive.length === 1)
}

// ── 用例 3:detach(钉出/收回降级清理)─────────────────────────
{
  const { S, calls, timers, cleanup } = makeHarness()
  const wreg = { id: 11, kind: 'chat', status: 'running', at: Date.now() - 5000 }
  S.wfCardByWc.set(101, wreg)
  cleanup(S, 101, null, { detach: true })
  const si = S.sessionInfo.get('s1')
  ok('不 abort 会话', calls.abort.length === 0)
  ok('sessionInfo 保留且死 wc 置空', !!si && si.wc === null && !!si.serve)
  ok('sid 键会话态全留(流式续推)', S.streamBuf.has('s1') && S.sentPrompt.has('s1') && S.firstMsgCtx.has('s1'))
  ok('pending 审批/提问不动', calls.dropPerm.length === 0 && calls.dropQ.length === 0)
  ok('serve 不退休', calls.retire.length === 0)
  ok('wf 不收官/不存档/不补位', S.wfCardByWc.has(101) && wreg.status === 'running' && calls.archive.length === 0 && calls.dequeue === 0)
  ok('wc 键登记照样摘净', !S.sessionByWc.has(101) && !S.cardWcById.has(7) && !S.embedWc.has(101) && !S.shardWc.has(101) && !S.cardDir.has(101) && !S.modelByWc.has(101))
  ok('落定计时照样清除', !timers.has(101))
  ok('forgetBusy 照样调用', calls.forget.join() === '101')
}

// ── 用例 4:幂等(双调安全)────────────────────────────────────
{
  const { S, calls, cleanup } = makeHarness()
  const wreg = { id: 12, kind: 'chat', status: 'running', at: Date.now() - 5000 }
  S.wfCardByWc.set(101, wreg)
  cleanup(S, 101, null)
  cleanup(S, 101, null)   // 双通道(session-close + destroyed 兜底)同发场景
  ok('abort 只一次', calls.abort.length === 1)
  ok('存档只一次', calls.archive.length === 1)
  ok('补位只一次', calls.dequeue === 1)
  const h2 = makeHarness()
  h2.cleanup(h2.S, 101, null, { detach: true })
  h2.cleanup(h2.S, 101, null, { detach: true })
  ok('detach 双调安全', h2.calls.abort.length === 0 && h2.calls.archive.length === 0)
}

// ── 用例 5:orch 主控关 → 分片级联杀 ─────────────────────────
{
  const { S, calls, wins, cleanup } = makeHarness()
  const wreg = { id: 20, kind: 'orch', status: 'running', at: Date.now() - 5000 }
  S.wfCardByWc.set(101, wreg)
  S.orchByTag.set('tagX', { id: 20 })
  S.wfRegistry.set('sh1', { parentOrch: 'tagX', wcId: 202 })
  let closed = 0
  wins.push({ isDestroyed: () => false, webContents: { id: 202 }, close: () => { closed++ } })
  cleanup(S, 101, null)
  ok('分片窗被 close', closed === 1)
  ok('分片进销毁白名单', S.shardForceClose.has(202))
  void calls
}

console.log(`\n结果:${pass} 通过,${fail} 失败`)
process.exit(fail ? 1 : 0)
