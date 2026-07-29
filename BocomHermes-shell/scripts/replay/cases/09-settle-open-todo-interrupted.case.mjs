// 用例⑨(实锤清单项2① 回归):分片带未完 todo 停轮,45s 落定兜底【不判 done,判 interrupted】。
// 旧行为:arm 时 verdict 定死(done),fire 时明知 todo 有未完项也强判 done —— 主控按"全齐"收口(分片死循环主控却判全齐的病根)。
// 新行为:fire 时按 reg.todos 重算 —— 有未完项 → interrupted;唤醒文案按中断上报,主控据此重派/标注缺口。
// 断言点:轮末仍 running;45s 计时器在挂;落定后 status==='interrupted'(不是 done);
//   主控收到「已中断 (1/1)」唤醒;不误报「已完成」。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 09)
import { ok, expectState, waitFor } from '../harness.mjs'

export default {
  name: '⑨分片带未完 todo 停轮 45s → 落定判 interrupted(不判 done) + 主控按中断唤醒',
  mode: 'manual',
  transcript: '09-settle-open-todo-interrupted.jsonl',
  async run(world) {
    const orch = world.spawnOrchestrator('摸透认证模块')
    world.approvePlan(orch.wcId)
    const shard = world.spawnWorkflow('[orch:' + orch.tag + '] 勘察认证模块入口与调用链')
    await world.cardInit(shard.wc, { shard: 1, title: '勘察认证模块' })
    ok('transcript 推 todowrite(1 completed + 1 pending)', world.fake.pushNextSse())
    await waitFor(() => shard.reg.todos && shard.reg.todos.length === 2, { name: 'wfTodos 未落地' })

    // 跑一轮后停轮:todo 未全勾 → 仍 running,起 45s 落定兜底(arm 时 verdict 口径是 done:有产出、未中止)
    await world.cardSend(shard.wc, '【总目标】勘察认证模块入口与调用链')
    expectState('轮末 todo 未全勾 → status 仍 running', () => shard.reg.status === 'running')
    expectState('45s 落定兜底计时器已挂上', () => world.pendingTimers().some((t) => t.ms === 45000))

    // 45s 无新回合 → fire 时按 todos 重算:有未完项 → 判 interrupted(不判 done)
    world.fireTimer(45000)
    expectState('落定重算:status 判 interrupted(不判 done)', () => shard.reg.status === 'interrupted')
    const injects = world.injects(orch.wcId)
    ok('主控收到唤醒:disp 含「分片 1/1」', injects.some((i) => (i.p.disp || '').includes('分片 1/1')), injects.map((i) => i.p && i.p.disp))
    ok('唤醒按中断上报:text 含「已中断 (1/1)」', injects.some((i) => (i.p.text || '').includes('已中断 (1/1)')), injects.map((i) => i.p && i.p.text && i.p.text.slice(0, 60)))
    ok('不误报完成:text 不含「已完成 (1/1)」', !injects.some((i) => (i.p.text || '').includes('已完成 (1/1)')))
  },
}
