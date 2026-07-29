// 用例⑩(实锤清单项3 回归):wf-stop-all 与 45s 落定计时的竞态。
// 旧行为:stop-all 直写 interrupted,但不清挂着的 settle 计时器 —— 45s 后旧计时器 fire 把状态覆写回 done;
//   也不唤醒主控、不刷面板(主控死等这片)。
// 新行为:每个 running 分片 → 清 settle 计时 + 标 interrupted + shardSettled 唤醒主控 + pushShardProgress 刷面板。
// 断言点:stop-all 后 status==='interrupted';主控收到「已中断 (1/1)」唤醒(主控被唤醒);
//   该片的 45s 计时器已清;fireTimer(45000) 后状态不被覆写(仍 interrupted);返回计数正确。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 10)
import { ok, expectState, waitFor } from '../harness.mjs'

export default {
  name: '⑩wf-stop-all → interrupted 不被 settle 覆写 + 主控被唤醒 + settle 计时已清',
  mode: 'manual',
  transcript: '10-stop-all-settle-race.jsonl',
  async run(world) {
    const orch = world.spawnOrchestrator('双层拆分:认证勘察')
    world.approvePlan(orch.wcId)
    const shard = world.spawnWorkflow('[orch:' + orch.tag + '] 分片A:勘察认证模块')
    await world.cardInit(shard.wc, { shard: 1, title: '分片A' })
    ok('transcript 推 todowrite(pending)', world.fake.pushNextSse())
    await waitFor(() => shard.reg.todos && shard.reg.todos.length === 1, { name: 'wfTodos 未落地' })

    // 跑一轮:todo 未全勾 → 仍 running,45s 落定计时挂上(竞态的另一方;注意还有常驻 45s interval 看门狗,只认 timeout 型)
    await world.cardSend(shard.wc, '【总目标】分片A:勘察认证模块')
    expectState('分片仍 running 且 settle 计时在挂', () => shard.reg.status === 'running' && world.pendingTimers().some((t) => t.ms === 45000 && t.type === 'timeout'))

    // 用户点【全部停止】:标 interrupted + 清 settle 计时 + 唤醒主控 + 刷面板
    const r = world.handlers['wf-stop-all']({ sender: { id: 0 } })
    ok('stop-all 返回计数(stopped=1)', !!(r && r.stopped === 1), r)
    expectState('分片标 interrupted', () => shard.reg.status === 'interrupted')
    expectState('该片的 45s settle 计时已清(pendingTimers 无 45s timeout)', () => !world.pendingTimers().some((t) => t.ms === 45000 && t.type === 'timeout'))
    const injects = world.injects(orch.wcId)
    ok('主控被唤醒:text 含「已中断 (1/1)」', injects.some((i) => (i.p.text || '').includes('已中断 (1/1)')), injects.map((i) => i.p && i.p.text && i.p.text.slice(0, 60)))
    ok('分片进度面板已推送(shard-progress)', world.shardProgress(orch.wcId).length >= 1)

    // 旧计时器若没清,这一刻会把 interrupted 覆写回 done —— 现在 fire 是空转,状态必须保持
    world.fireTimer(45000)
    expectState('45s 后状态不被覆写(仍 interrupted)', () => shard.reg.status === 'interrupted')
    ok('不误判 done', shard.reg.status !== 'done')
  },
}
