// 用例⑥(VERDICT 机判):验证棒回报的壳层拒收与回派(CC verification agent "report gets rejected" 的回归)。
// 链路:【集成验证】分片收官 → 壳层解析 reg.final:
//   A 场景:首棒无 VERDICT → 拒收,自动回派一次(带拒因);回派棒仍无 VERDICT → 标【验证未完成】转人工,不再派。
//   B 场景:VERDICT: PASS 但全文没有 Command run 块(没跑就写 PASS)→ 同样拒收回派。
//   C 场景:VERDICT: PASS + Command run 块 → 放行(不拒收、不回派)。
// 结构注意(沿用用例④教训):先 cardInit 全部三根验证棒(会话都建在 fake serve 上),再逐个收官——
//   否则 A 场景全收官连带退休"无引用的 serve",B/C 场景再起主控会要第二个 fake serve(骨架不支持双监听,实测)。
// 别名绑定 = cardInit 顺序:$s1=A首棒 $s2=B首棒 $s3=C首棒 $s4=A回派棒。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 06)
import { ok, expectState, waitFor } from '../harness.mjs'

export default {
  name: '⑥VERDICT 机判:无 VERDICT/无 Command run 块拒收回派,连撞 2 次转人工,证据齐放行',
  mode: 'manual',
  transcript: '06-verdict-gate.jsonl',
  async run(world) {
    const findVerify = (tag, excludeId) => [...world.S.wfRegistry.values()].filter((r) => r.parentOrch === tag && /集成验证/.test(String(r.goal || '')) && r.id !== excludeId)

    // ── 开局:三个主控 + 三根验证棒全部建好(会话先占住 fake serve) ──
    const orchA = world.spawnOrchestrator('编码:登录改造')
    world.approvePlan(orchA.wcId)
    const a1w = world.spawnWorkflow('[orch:' + orchA.tag + ']【集成验证】在 项目 跑全量构建/测试')
    const orchB = world.spawnOrchestrator('编码:注册改造')
    world.approvePlan(orchB.wcId)
    const b1w = world.spawnWorkflow('[orch:' + orchB.tag + ']【集成验证】在 项目 跑全量构建/测试')
    const orchC = world.spawnOrchestrator('编码:支付改造')
    world.approvePlan(orchC.wcId)
    const c1w = world.spawnWorkflow('[orch:' + orchC.tag + ']【集成验证】在 项目 跑全量构建/测试')
    await world.cardInit(a1w.wc, { shard: 1, title: 'A首棒' })
    await world.cardInit(b1w.wc, { shard: 1, title: 'B首棒' })
    await world.cardInit(c1w.wc, { shard: 1, title: 'C首棒' })
    ok('transcript 推 todowrite ×3(A/B/C 首棒)', world.fake.pushNextSse() && world.fake.pushNextSse() && world.fake.pushNextSse())
    await waitFor(() => a1w.reg.todos && b1w.reg.todos && c1w.reg.todos, { name: 'wfTodos 未落地' })

    // ── A 场景:首棒无 VERDICT → 拒收 + 自动回派 ──
    await world.cardSend(a1w.wc, 'A1定稿')
    expectState('A 首棒收官 status=done', () => a1w.reg.status === 'done')
    expectState('无 VERDICT:verifyRejected 置位', () => a1w.reg.verifyRejected === true)
    const aRetry = findVerify(orchA.tag, a1w.reg.id)
    ok('拒收后自动回派一根验证棒(同 tag)', aRetry.length === 1, [...world.S.wfRegistry.values()].map((r) => r.goal && r.goal.slice(0, 40)))
    ok('回派棒 goal 注明拒收原因(缺 VERDICT 字面量)', aRetry.length === 1 && aRetry[0].goal.includes('回派') && aRetry[0].goal.includes('VERDICT'))
    ok('回派棒 goal 带五件套(Command run 契约)', aRetry.length === 1 && aRetry[0].goal.includes('Command run'))
    ok('唤醒报【验证回报被壳层拒收】', world.injects(orchA.wcId).some((i) => (i.p.text || '').includes('拒收')), world.injects(orchA.wcId).map((i) => i.p && i.p.text && i.p.text.slice(0, 60)))

    // ── A 场景续:回派棒仍无 VERDICT → 验证未完成,不再派 ──
    const a2reg = aRetry[0]
    const a2wc = world.wcById(a2reg.wcId)
    await world.cardInit(a2wc, { shard: 1, title: 'A回派棒' })
    ok('transcript 推 todowrite(A回派棒)', world.fake.pushNextSse())
    await world.cardSend(a2wc, 'A2定稿')
    expectState('回派棒仍无 VERDICT:再次 verifyRejected', () => a2reg.verifyRejected === true)
    expectState('连撞 2 次:orchVerifyRetry 记到 2', () => (world.S.orchVerifyRetry && world.S.orchVerifyRetry.get(orchA.tag)) >= 2)
    ok('唤醒报【验证未完成】转人工', world.injects(orchA.wcId).some((i) => (i.p.text || '').includes('验证未完成')))
    ok('连撞封顶:不再派第三根验证棒', findVerify(orchA.tag, a1w.reg.id).filter((r) => r.id !== a2reg.id).length === 0)

    // ── B 场景:VERDICT: PASS 但无 Command run 块 → 拒收回派 ──
    await world.cardSend(b1w.wc, 'B1定稿')
    expectState('B 首棒 status=done', () => b1w.reg.status === 'done')
    expectState('PASS 无 Command run 块:verifyRejected 置位', () => b1w.reg.verifyRejected === true)
    ok('B 场景同样自动回派', findVerify(orchB.tag, b1w.reg.id).length === 1)

    // ── C 场景:VERDICT: PASS + Command run 块 → 放行 ──
    await world.cardSend(c1w.wc, 'C1定稿')
    expectState('C 首棒 status=done', () => c1w.reg.status === 'done')
    expectState('VERDICT+Command run 块齐全:不拒收', () => !c1w.reg.verifyRejected)
    ok('放行路径:不回派', findVerify(orchC.tag, c1w.reg.id).length === 0)
  },
}
