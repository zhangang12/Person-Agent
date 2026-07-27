// 用例④(Agent 不验证病症的 harness 回归):验证证据闸 + 自动验证棒。
// 链路:编码分片(带写归属)todo 全勾收官 → shardSettled 机判 bash 命令流水(session.js wfAction 'cmd' 轨):
//   无验证命令(echo 之类)→ reg.unverified=true → 唤醒报【未验证】→ 壳层自动补派【集成验证】分片(run_workflow,同 tag);
//   有验证命令(npm test)→ 不标未验证、不补派。
// 断言点:写归属解析;unverified 置位/不置位;唤醒文案【未验证】;验证棒登记(goal/同 tag/kind);
//   主控收到(壳层验证闸)说明;有证据的 orchestrator 不重复派。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 04)
import { ok, expectState, waitFor } from '../harness.mjs'

export default {
  name: '④验证证据闸:编码分片无验证证据 → 标未验证 + 壳层自动补派集成验证棒(有证据不派)',
  mode: 'manual',
  transcript: '04-verify-gate.jsonl',
  async run(world) {
    // ── 先把两卡会话都建在 fake serve 上(A 收官会连带退休"无引用的 serve",B 后建会落到真 serve 上,实测) ──
    const orch = world.spawnOrchestrator('编码:登录接口实现')
    world.approvePlan(orch.wcId)
    const a = world.spawnWorkflow('[orch:' + orch.tag + '] 分片A:实现登录接口\n写归属: src/auth/login.ts')
    expectState('写归属已解析(编码分片)', () => Array.isArray(a.reg.writeScope) && a.reg.writeScope.length === 1)
    await world.cardInit(a.wc, { shard: 1, title: '分片A' })
    ok('transcript 推 todowrite(全勾)', world.fake.pushNextSse())
    await waitFor(() => a.reg.todos && a.reg.todos.length === 1, { name: 'wfTodos 未落地(A)' })
    ok('transcript 推 bash(echo,非验证命令)', world.fake.pushNextSse())

    const orch2 = world.spawnOrchestrator('编码:注册接口实现')
    world.approvePlan(orch2.wcId)
    const b = world.spawnWorkflow('[orch:' + orch2.tag + '] 分片B:实现注册接口\n写归属: src/auth/signup.ts')
    await world.cardInit(b.wc, { shard: 1, title: '分片B' })
    ok('transcript 推 todowrite(全勾)', world.fake.pushNextSse())
    await waitFor(() => b.reg.todos && b.reg.todos.length === 1, { name: 'wfTodos 未落地(B)' })
    ok('transcript 推 bash(npm test,验证命令)', world.fake.pushNextSse())

    // ── A 收官:无验证证据(echo) → 标未验证 + 自动验证棒(B 会话已在 fake 上,serve 不被退休) ──
    await world.cardSend(a.wc, '实现登录接口')
    expectState('todo 全勾收官:status=done', () => a.reg.status === 'done')
    expectState('无构建/测试证据:unverified 置位', () => a.reg.unverified === true)
    const injects = world.injects(orch.wcId)
    ok('唤醒报【未验证】(别当完成,壳层将补验证棒)', injects.some((i) => (i.p.text || '').includes('未验证')), injects.map((i) => i.p && i.p.text && i.p.text.slice(0, 80)))
    const verify = [...world.S.wfRegistry.values()].find((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch.tag)
    ok('壳层自动补派集成验证棒(同 tag,带 parentOrch)', !!verify, [...world.S.wfRegistry.values()].map((r) => r.goal && r.goal.slice(0, 40)))
    ok('验证棒 goal 指向仓库文档命令跑构建/测试', !!verify && /构建|测试/.test(verify.goal) && /orch:/.test(verify.goal))
    ok('主控卡收到(壳层验证闸)说明消息', injects.some((i) => (i.p.text || '').includes('壳层验证闸')))
    expectState('验证棒登记防循环标记(orchVerifyDone 含本 tag)', () => world.S.orchVerifyDone && world.S.orchVerifyDone.has(orch.tag))

    // ── B 收官:有验证证据(npm test) → 不标未验证、不补派 ──
    await world.cardSend(b.wc, '实现注册接口')
    expectState('有验证证据:status=done 且不标 unverified', () => b.reg.status === 'done' && !b.reg.unverified)
    ok('有证据的 orchestrator:验证棒不派出', ![...world.S.wfRegistry.values()].some((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch2.tag))
  },
}
