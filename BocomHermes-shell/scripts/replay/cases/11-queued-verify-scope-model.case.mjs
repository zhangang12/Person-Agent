// 用例⑪(实锤清单项7①②⑧ 回归):并发满时派验证棒排队 → 出队后 writeScope / forceModel(读图模型)不丢。
// 链路:占位长任务占住 1 个并发位(并发=2)→ 分片A1 无验证证据收官 → 壳层自动验证棒(直接开卡:读图模型 +
//   只读沙箱 + isVerify 登记 + goal 带「写归属: <系统临时目录>」行)→ 此时两位占满,再派验证棒【排队】(真队列路径)
//   → 自动验证棒报 PARTIAL 收官 → wfDequeue 出队:forceModel 恢复(整卡读图模型)、isVerify 按 goal 文本补登记、
//   writeScope 由 goal 的「写归属:」行被 parseWriteScope 天然恢复。
// 断言点:自动验证棒 isVerify/model/writeScope/goal 行;第二棒 queued(position 1);
//   出队后 v2:model=读图模型、isVerify=true、writeScope=[系统临时目录]、parentOrch 挂对。
// 说明:队列条目的 forceModel 字段由派出点存储(代码行极薄),用例里手工填上模拟自动派出 —— 被测的真风险在
//   【出队恢复】那一段(wfDequeue → spawnWorkflow(goal, forceModel) → reg.model / isVerify 补登记 / writeScope 恢复)。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 11)
import { ok, expectState, waitFor } from '../harness.mjs'
import os from 'os'

export default {
  name: '⑪并发满时验证棒排队 → 出队恢复 writeScope/forceModel/isVerify(读图模型口径不丢)',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 2 } },
  transcript: '11-queued-verify-scope-model.jsonl',
  async run(world) {
    const tmp = os.tmpdir().replace(/\\/g, '/')
    world.S.settings.modelVision = { providerID: 'p1', modelID: 'vision-1', name: 'Vision 模型' }
    const keep = world.spawnWorkflow('用户的长任务(占位,不收官)')   // 占住并发位 1/2
    ok('占位任务开卡(running)', !!(keep && keep.reg && keep.reg.status === 'running'), keep && keep.reg && keep.reg.status)
    const orch = world.spawnOrchestrator('编码:接口实现')
    world.approvePlan(orch.wcId)

    // 分片A1:无验证证据收官 → 壳层自动验证棒(并发 2/2 未满:占位 1 + A1 收官腾出 → 直接开卡)
    const a1 = world.spawnWorkflow('[orch:' + orch.tag + '] 分片A1:实现接口\n写归属: src/a.ts')
    await world.cardInit(a1.wc, { shard: 1, title: '分片A1' })
    ok('transcript 推 todowrite(全勾)', world.fake.pushNextSse())
    ok('transcript 推 bash(echo,无证据)', world.fake.pushNextSse())
    await waitFor(() => a1.reg.todos, { name: 'wfTodos 未落地' })
    await world.cardSend(a1.wc, '实现接口')
    expectState('A1 无证据:unverified 置位', () => a1.reg.unverified === true)
    const v1 = [...world.S.wfRegistry.values()].find((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch.tag)
    ok('壳层自动补派集成验证棒(直接开卡)', !!v1, [...world.S.wfRegistry.values()].map((r) => r.goal && r.goal.slice(0, 40)))
    expectState('自动验证棒 isVerify 已登记(派出点 markVerify)', () => v1.isVerify === true)
    ok('自动验证棒整卡跑读图模型', v1.model && v1.model.modelID === 'vision-1', v1.model)
    expectState('自动验证棒 writeScope = [系统临时目录]', () => Array.isArray(v1.writeScope) && v1.writeScope.length === 1 && v1.writeScope[0] === tmp)
    ok('验证棒 goal 末尾带「写归属: <临时目录>」行(队列安全)', v1.goal.includes('写归属: ' + tmp), v1.goal.slice(-120))

    // 此刻并发 2/2 占满(占位 + 验证棒):再派一根验证棒 → 真排队
    const goal2 = '[orch:' + orch.tag + ']【集成验证】(回派:复验) 对改动做对抗性验证\n写归属: ' + tmp
    const vq = world.spawnWorkflow(goal2)
    ok('并发满:第二根验证棒进队列(position 1)', !!(vq && vq.queued === true && vq.position === 1), vq)
    expectState('队列条目保留原始 goal(含 [orch:] 标记与写归属行)', () => world.S.wfQueue.length === 1 && String(world.S.wfQueue[0].goal).includes('集成验证') && String(world.S.wfQueue[0].goal).includes('写归属: ' + tmp))
    world.S.wfQueue[0].forceModel = { providerID: 'p1', modelID: 'vision-1', name: 'Vision 模型' }   // 模拟自动派出点存的 forceModel(见用例头说明)

    // 自动验证棒报 PARTIAL(合法:不拒收/不抽查)→ 轮末仍 running(它没维护 todo)→ 45s 落定兜底判 done → 腾位 → wfDequeue 出队
    const v1wc = world.wcById(v1.wcId)
    await world.cardInit(v1wc, { shard: 1, title: '验证棒' })
    await world.cardSend(v1wc, '验证执行')
    expectState('验证棒轮末挂上 45s 落定兜底', () => world.pendingTimers().some((t) => t.ms === 45000 && t.type === 'timeout'))
    world.fireTimer(45000)
    expectState('验证棒落定:status=done 不拒收(PARTIAL 合法)', () => v1.status === 'done' && !v1.verifyRejected)
    expectState('出队:wfQueue 清空', () => world.S.wfQueue.length === 0)
    const v2 = [...world.S.wfRegistry.values()].find((r) => r.parentOrch === orch.tag && r.id !== v1.id && /集成验证/.test(String(r.goal || '')))
    ok('排队验证棒已出队开卡', !!v2, [...world.S.wfRegistry.values()].map((r) => ({ id: r.id, goal: String(r.goal || '').slice(0, 30) })))
    ok('出队恢复 forceModel:v2 整卡跑读图模型', !!(v2 && v2.model && v2.model.modelID === 'vision-1'), v2 && v2.model)
    expectState('出队补登记 isVerify(goal 文本兜底)', () => !!(v2 && v2.isVerify === true))
    expectState('出队恢复 writeScope = [系统临时目录](parseWriteScope 天然恢复)', () => !!(v2 && Array.isArray(v2.writeScope) && v2.writeScope.length === 1 && v2.writeScope[0] === tmp))
    ok('出队日志留痕(workflow dequeued)', world.logs.some((l) => l.includes('workflow dequeued')))
  },
}
