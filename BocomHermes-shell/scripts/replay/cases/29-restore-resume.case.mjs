// 用例㉙:重启续跑走一遍真存档(落盘 → 读回 → suspended → 续跑)
//
// 【为什么补这一条】状态机那侧的续接语义早就测了(orch-selftest 的 RS 驱动:verified 复核、
// running 按磁盘产出说话、不惩罚崩溃)。但【存档本身】那一段一直没人走过:
//   · run 到底能不能完整 JSON 往返(clone 保证它可序列化,但"能序列化"≠"读回来还是那个图");
//   · restore() 读回后有没有真的置 suspended、有没有把终态的滤掉;
//   · 读回来的那份能不能接着续跑。
// 这个仓刚踩过一次"单测全绿而真机一次没执行过"(backfillFinal 的 n.sid 恒 null),
// 存档路径正是同一类风险:平时不走,真要用的时候(内网跑一半崩了)才发现读不回来。
//
// 跑法:node scripts/replay/run.mjs 29
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '㉙重启续跑:存档往返 + restore 置挂起 + 续跑接得上',
  mode: 'manual',
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!(S.orch && S.orch.__journal))
    if (!S.orch || !S.orch.__journal) return

    S.orchDecide = async (point) => point === 'plan'
      ? { ok: true, data: { needGrounding: false, more: 'no', why: '两片',
        nodes: [1, 2].map((i) => ({ title: '片' + i, goal: '干活 ' + i, kind: 'work', deps: [],
          writeScope: ['src/m' + i], contract: [], artifacts: [],
          requireEvidence: false, requireVerdict: false, verifyCmd: '' })) } }
      : { ok: true, data: { addNodes: [], dropNodes: [], done: false, facts: [], open: [], why: '继续' } }

    const r = S.orch.createRun('重构订单与库存两个模块', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.approve(r.id)
    const before = S.orch.get(r.id)
    ok('派出去了', before.phase === 'executing' && before.nodes.length === 2, before.nodes.map((n) => n.id + ':' + n.state))

    // ── 存档:防抖攒批,这里显式 flush(退出前 window.js 走的是 dispose → flushAll)──
    const wrote = S.orch.__journal.flush(r.id)
    ok('★run 落盘了', wrote !== false, wrote)
    const disk = S.orch.__journal.load(r.id)
    ok('★读得回来,而且是同一个图(能序列化 ≠ 读回来还是那个图)',
      !!disk && disk.id === r.id && (disk.nodes || []).length === before.nodes.length,
      disk && { id: disk.id, nodes: (disk.nodes || []).length })
    if (disk) {
      const a = before.nodes[0], b = (disk.nodes || [])[0]
      ok('  节点上的关键字段一个不少(写归属/闸门/结果槽)',
        !!b && b.id === a.id && JSON.stringify(b.writeScope) === JSON.stringify(a.writeScope)
          && !!b.exit && !!b.result, b && Object.keys(b).length)
      ok('  brief 也在(续跑重派时要用它,丢了就得重新 compose)', !!(b && b.brief), b && String(b.brief || '').length)
    }

    // ── 模拟重启:restore() 从磁盘读回全部非终态 run,一律置 suspended ──
    const n = S.orch.restore()
    ok('★restore 认领了这条 run', n >= 1, n)
    const after = S.orch.get(r.id)
    ok('★读回来是 suspended,不自动开跑(内网重启常伴随 serve 变更,自动重跑=重复烧钱)',
      after.phase === 'suspended', after.phase)
    ok('  节点没被重置(续跑要靠磁盘产出说话,不是从头再来)',
      after.nodes.length === 2, after.nodes.map((x) => x.id + ':' + x.state))

    // ── 续跑:接得上 ──
    S.orch.resume(r.id)
    const back = S.orch.get(r.id)
    ok('★续跑 → 回到 executing', back.phase === 'executing', back.phase)
    ok('  用掉一次续接免罚额度(上限 1,防重启循环白烧预算)',
      back.budget.resumeCredit === 0, back.budget.resumeCredit)

    // ── 终态的不该被 restore 认领(否则每次开机都把历史 run 拉回来挂着)──
    S.orch.abort(r.id)
    S.orch.__journal.flush(r.id)
    const n2 = S.orch.restore()
    ok('★终态 run 不再被认领', S.orch.get(r.id).phase === 'cancelled', { n2, phase: S.orch.get(r.id).phase })
  },
}
