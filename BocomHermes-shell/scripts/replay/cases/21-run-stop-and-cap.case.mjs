// 用例㉑:新引擎的两个【真跑才会炸】的接线 bug —— 都在删掉旧引擎之前必须钉死。
//
// ① 全局并发满时,节点会被判死(不是排队)
//    tick 先把节点置 running 并挂好 45s 静默计时,doDispatch 才撞上全局并发闸拿不到卡 →
//    节点 running 却没有工人卡 → 45s 落定 → 零产出 → zero-output 属 HARD_FAIL 不给补做 →
//    attempt++,两次就 failed。修法:tick 派发前先问全局余量(index.js 注入 capHint)。
//
// ② 用户点【全部停止】停不掉编排
//    wf-stop-all 清的是 shardSettleTimers,而 run 的计时器在 orch/index.js 的 timers(键 runId:nodeId:silent),
//    清不到;shardSettled 又对 runId 早退 → 引擎完全不知情 → 45s 后照常落定、零产出、重派。
//    净效果:用户点了停止,编排接着跑。修法:stop-all 命中 reg.runId 时转调 S.orch.abort。
//
// 跑法:node scripts/replay/run.mjs 21
import { ok, expectState, waitFor, fireTimer } from '../harness.mjs'

export default {
  name: '㉑新引擎接线:全局并发满不判死 + 全部停止真的停得掉',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 2 } },   // 并发压到 2,才撞得到全局闸
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    // 保活卡:同时也把全局并发位吃掉一个(wfConcurrency=2,它占 1,只剩 1 个位)
    const keep = world.spawnWorkflow('保活任务(本用例不收官,顺带占一个并发位)')
    await world.cardInit(keep.wc, { title: '保活' })

    S.orchDecide = async (point) => {
      if (point === 'plan') {
        return { ok: true, data: {
          needGrounding: false, more: 'unknown', why: '拆三片',
          nodes: ['a', 'b', 'c'].map((id) => ({
            id, kind: 'work', title: '节点' + id, goal: '干活' + id, deps: [],
            writeScope: ['src/' + id], contract: [], artifacts: [],
            requireEvidence: false, requireVerdict: false, verifyCmd: '',
          })),
        } }
      }
      return { ok: true, data: { addNodes: [], dropNodes: [], done: false, more: 'unknown', why: '接着等' } }
    }

    // 目标取实现类：本用例测并发闸与「全部停止」，补宽出来的片会把节点计数冲掉(见 ㈖)
    const r = S.orch.createRun('重构调度与停止逻辑', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地' })
    S.orch.approve(r.id)

    // ── ① 全局并发满:只许派到全局余量,其余停 queued ──
    const run1 = S.orch.get(r.id)
    const running = run1.nodes.filter((n) => n.state === 'running')
    const queued = run1.nodes.filter((n) => n.state === 'queued')
    ok('★全局只剩 1 个位:只派了 1 个节点', running.length === 1, run1.nodes.map((n) => n.id + ':' + n.state))
    ok('★其余节点停在 queued(不是 running)', queued.length === 2, run1.nodes.map((n) => n.id + ':' + n.state))
    ok('★queued 的节点没有工人卡也不该有', queued.every((n) => !n.cardId), queued.map((n) => n.cardId))

    // 关键回归:45s 到点时,【从没被派出去过】的节点不许被罚。
    // 修之前它们也是 running + 挂着静默计时,45s 一到全部 settled → noEmpty 不过 → attempt++ → 两次判死。
    // (真派出去了但本用例没喂内容的那个节点,45s 后零产出 attempt++ 是【正确行为】,不在断言范围内)
    const neverDispatched = queued.map((n) => n.id)
    fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await new Promise((res) => setTimeout(res, 50))
    const run2 = S.orch.get(r.id)
    const punished = run2.nodes.filter((n) => neverDispatched.includes(n.id) && (n.attempt > 0 || n.state === 'failed'))
    ok('★45s 到点:从没派出去的节点没有被罚(修之前这几个全灭)', punished.length === 0,
      run2.nodes.map((n) => n.id + ':' + n.state + '/a' + n.attempt))
    ok('从没派出去的节点也没挂过静默计时(挂了就会被误判)',
      run2.nodes.filter((n) => neverDispatched.includes(n.id)).every((n) => !n.startedAt),
      run2.nodes.filter((n) => neverDispatched.includes(n.id)).map((n) => n.id + ':startedAt=' + n.startedAt))

    // ── ② 全部停止:必须真的把 run 停掉 ──
    const before = S.orch.get(r.id).phase
    ok('停止前 run 还在跑', before === 'executing', before)
    world.handlers['wf-stop-all']({ sender: { id: 0 } })
    const run3 = S.orch.get(r.id)
    ok('★【全部停止】把 run 打到终态(修之前引擎完全不知情)', run3.phase === 'cancelled', run3.phase)
    ok('★在跑/排队的节点全部离开活动态', !run3.nodes.some((n) => ['running', 'queued', 'pending'].includes(n.state)),
      run3.nodes.map((n) => n.id + ':' + n.state))

    // 停完再打 45s:终态 run 必须吸收掉一切迟到事件,不许"停了又活过来"
    const seqBefore = run3.seq
    fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await new Promise((res) => setTimeout(res, 50))
    const run4 = S.orch.get(r.id)
    ok('★停止后迟到的计时器不产生任何副作用(终态吸收)', run4.phase === 'cancelled' && run4.seq === seqBefore,
      { phase: run4.phase, seq: run4.seq, was: seqBefore })
    ok('停止后不再派新卡', !run4.nodes.some((n) => n.state === 'running'), run4.nodes.map((n) => n.state))
  },
}
