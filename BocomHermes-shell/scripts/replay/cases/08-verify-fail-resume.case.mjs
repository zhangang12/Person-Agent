// 用例⑧(M4 修复循环):验证棒 FAIL → 保留待复验 → 修复分片收官喂复验 → 同棒复验 PASS → 清账。
// 链路:分片A 无证据 → 自动验证棒 → 验证棒报 FAIL(带 Command run 块) → verifyOpen 保留 + 唤醒报【验证未达标(第 1 轮)】
//   → 修复分片C 收官 → 壳层喂验证棒"复验" → 验证棒二轮报 PASS → verifyOpen/verifyRounds 清账,不拒收。
// 结构注意(沿用用例⑥教训):分片 A/B 先 cardInit(会话都建在 fake serve 上),再逐个收官。
// 别名绑定 = cardInit 顺序:$s1=分片A $s2=分片B $s3=验证棒 $s4=修复分片C。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 08)
import { ok, expectState, waitFor } from '../harness.mjs'

export default {
  name: '⑧FAIL 复验循环:验证棒 FAIL 保留 → 修复收官喂复验 → 同棒复验 PASS 清账',
  mode: 'manual',
  transcript: '08-verify-fail-resume.jsonl',
  async run(world) {
    // ── 开局:主控 + 两个编码分片 + 一张保活卡(不收官,防全片齐时 serve 退休、后派的验证棒落去真 serve —— 沿用用例⑥教训) ──
    const orch = world.spawnOrchestrator('编码:登录改造')
    world.approvePlan(orch.wcId)
    const a = world.spawnWorkflow('[orch:' + orch.tag + '] 分片A:实现登录接口\n写归属: src/a.ts')
    const b = world.spawnWorkflow('[orch:' + orch.tag + '] 分片B:实现注册接口\n写归属: src/b.ts')
    const keep = world.spawnWorkflow('保活任务(本用例不收官)')
    await world.cardInit(a.wc, { shard: 1, title: '分片A' })
    await world.cardInit(b.wc, { shard: 1, title: '分片B' })
    await world.cardInit(keep.wc, { title: '保活' })
    ok('transcript 推 todowrite(A)', world.fake.pushNextSse())
    ok('transcript 推 bash A(echo,无证据)', world.fake.pushNextSse())
    ok('transcript 推 todowrite(B)', world.fake.pushNextSse())
    ok('transcript 推 bash B(npm test,有证据)', world.fake.pushNextSse())
    await waitFor(() => a.reg.todos && b.reg.todos, { name: 'wfTodos 未落地' })

    // ── A/B 收官:A 无证据 → 全片齐 → 自动验证棒 ──
    await world.cardSend(a.wc, '实现A')
    expectState('A 无证据:unverified 置位', () => a.reg.unverified === true)
    await world.cardSend(b.wc, '实现B')
    const v = [...world.S.wfRegistry.values()].find((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch.tag)
    ok('全片齐后自动补派集成验证棒', !!v, [...world.S.wfRegistry.values()].map((r) => r.goal && r.goal.slice(0, 40)))
    const vwc = world.wcById(v.wcId)
    await world.cardInit(vwc, { shard: 1, title: '验证棒' })
    ok('transcript 推 todowrite(验证棒)', world.fake.pushNextSse())

    // ── 验证棒报 FAIL(带 Command run 块,不触发格式拒收) → 保留待复验 ──
    await world.cardSend(vwc, 'V1定稿')
    expectState('验证棒收官 status=done', () => v.status === 'done')
    expectState('FAIL 不是格式拒收:verifyRejected 不置位', () => !v.verifyRejected)
    expectState('FAIL 保留待复验:verifyOpen 登记本 tag', () => !!(world.S.verifyOpen && world.S.verifyOpen.has(orch.tag)))
    expectState('循环计数到 1:verifyRounds=1', () => (world.S.verifyRounds && world.S.verifyRounds.get(orch.tag)) === 1)
    ok('唤醒报【验证未达标(第 1 轮)】', world.injects(orch.wcId).some((i) => (i.p.text || '').includes('验证未达标')), world.injects(orch.wcId).map((i) => i.p && i.p.text && i.p.text.slice(0, 60)))

    // ── 修复分片C 收官 → 壳层喂验证棒"复验" ──
    const c = world.spawnWorkflow('[orch:' + orch.tag + '] 分片C:修复空密码未拦截\n写归属: src/a.ts')
    await world.cardInit(c.wc, { shard: 1, title: '修复C' })
    ok('transcript 推 todowrite(C)', world.fake.pushNextSse())
    ok('transcript 推 bash C(npm test)', world.fake.pushNextSse())
    await waitFor(() => c.reg.todos, { name: 'wfTodos 未落地(C)' })
    await world.cardSend(c.wc, '修复C')
    expectState('修复分片收官 status=done', () => c.reg.status === 'done')
    ok('验证棒收到【复验】注入', world.injects(v.wcId).some((i) => (i.p.text || '').includes('复验')), world.injects(v.wcId).map((i) => i.p && i.p.text && i.p.text.slice(0, 60)))

    // ── 验证棒二轮报 PASS → 清账,不拒收、不再派 ──
    await world.cardSend(vwc, 'V2定稿')
    expectState('复验 PASS:不拒收', () => !v.verifyRejected)
    expectState('PASS 后清账:verifyOpen/verifyRounds 删除', () => !(world.S.verifyOpen && world.S.verifyOpen.has(orch.tag)) && !(world.S.verifyRounds && world.S.verifyRounds.has(orch.tag)))
    ok('PASS 后不再派新验证棒', [...world.S.wfRegistry.values()].filter((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch.tag).length === 1)
  },
}
