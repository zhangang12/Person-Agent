// 用例⑤(浏览器自验证据轨):前端分片的"验没验过"机判。
// 链路:前端分片(写归属 .vue)收官 → shardSettled 机判动作流水:
//   有 browser_* 动作(浏览器自验)→ 不标 unverified、不补派验证棒(浏览器动作轨 = 验证证据);
//   无任何证据(只 echo)→ 标未验证 + 壳层补派【集成验证】,且验证棒 goal 因写归属含前端文件而带【浏览器自验】步骤。
// 断言点:写归属解析(.vue);browser 动作轨注册;unverified 不置位/置位;验证棒 goal 含浏览器自验与截图回报要求。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 05)
import { ok, expectState, waitFor } from '../harness.mjs'

export default {
  name: '⑤浏览器自验:browser 动作算验证证据(不标);前端分片无证据 → 验证棒带浏览器自验步骤',
  mode: 'manual',
  transcript: '05-browser-verify-evidence.jsonl',
  async run(world) {
    // ── 两卡会话先建好(A 收官会连带退休"无引用的 serve",B 后建会落到真 serve 上,沿用用例④的教训) ──
    const orch = world.spawnOrchestrator('编码:登录页实现')
    world.approvePlan(orch.wcId)
    const a = world.spawnWorkflow('[orch:' + orch.tag + '] 分片A:实现登录页\n写归属: src/ui/Login.vue')
    expectState('写归属已解析(前端 .vue)', () => Array.isArray(a.reg.writeScope) && a.reg.writeScope.length === 1 && /Login\.vue$/.test(a.reg.writeScope[0]))
    await world.cardInit(a.wc, { shard: 1, title: '分片A' })
    ok('transcript 推 todowrite(全勾)', world.fake.pushNextSse())
    await waitFor(() => a.reg.todos && a.reg.todos.length === 1, { name: 'wfTodos 未落地(A)' })
    ok('transcript 推 browser_navigate(浏览器自验)', world.fake.pushNextSse())

    const orch2 = world.spawnOrchestrator('编码:注册页实现')
    world.approvePlan(orch2.wcId)
    const b = world.spawnWorkflow('[orch:' + orch2.tag + '] 分片B:实现注册页\n写归属: src/ui/Signup.vue')
    await world.cardInit(b.wc, { shard: 1, title: '分片B' })
    ok('transcript 推 todowrite(全勾)', world.fake.pushNextSse())
    await waitFor(() => b.reg.todos && b.reg.todos.length === 1, { name: 'wfTodos 未落地(B)' })
    ok('transcript 推 bash(echo,非验证)', world.fake.pushNextSse())

    // ── A 收官:有浏览器自验证据 → 不标未验证、不补派 ──
    await world.cardSend(a.wc, '实现登录页')
    expectState('todo 全勾收官:status=done', () => a.reg.status === 'done')
    expectState('浏览器动作轨已注册(actions 含 kind=browser)', () => (a.reg.actions || []).some((x) => x && x.kind === 'browser'))
    expectState('browser 动作算证据:不标 unverified', () => !a.reg.unverified)
    ok('A 的 orchestrator:验证棒不派出', ![...world.S.wfRegistry.values()].some((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch.tag))

    // ── B 收官:前端分片无任何证据 → 标未验证 + 验证棒带浏览器自验步骤 ──
    await world.cardSend(b.wc, '实现注册页')
    expectState('B 无证据:unverified 置位', () => b.reg.unverified === true)
    const verify = [...world.S.wfRegistry.values()].find((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch2.tag)
    ok('壳层自动补派集成验证棒(同 tag)', !!verify, [...world.S.wfRegistry.values()].map((r) => r.goal && r.goal.slice(0, 40)))
    ok('验证棒 goal 含【浏览器自验】步骤(写归属含前端文件)', !!verify && verify.goal.includes('浏览器自验'))
    ok('验证棒 goal 要求截图路径随回报给出', !!verify && verify.goal.includes('自验截图路径'))
    const injects = world.injects(orch2.wcId)
    ok('唤醒报【未验证】', injects.some((i) => (i.p.text || '').includes('未验证')), injects.map((i) => i.p && i.p.text && i.p.text.slice(0, 80)))
  },
}
