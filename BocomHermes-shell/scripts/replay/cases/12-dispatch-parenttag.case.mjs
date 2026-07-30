// 用例⑫(Swarm 借鉴第一批):分片派发结构化 —— parentTag=校验字段(真实存在+规划闸)+机械注入 tag+去重闸。
// 病灶:主控(弱模型)手写 [orch:TAG] 进 goal 文本,写错/幻觉他主控 tag → 回报串台、唤醒错乱(多次实测)。
// 新口径:run_workflow 传 parentTag 参数,壳层校验后机械注入;goal 里手写的一律剥掉以 parentTag 为准;
// 同 tag 下归一化 goal 相同且在跑/排队 → 拒派(弱模型重复派单兜底)。
// 断言:未批拒;批准+parentTag 放行且挂名正确(手写错 tag 被剥);tag 不存在拒;同 goal 再派拒;不同 goal 放行。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 12)
import { ok } from '../harness.mjs'

export default {
  name: '⑫dispatchShard:parentTag 校验+机械注入+去重闸(Swarm 借鉴)',
  mode: 'manual',
  async run(world) {
    const orch = world.spawnOrchestrator('结构化派发测试')
    const tag = orch.tag

    // 1) 方案未批准 → 规划闸拒(parentTag 路径)
    const r1 = world.S.dispatchShard('勘察认证模块', tag)
    ok('未批准:parentTag 拒派(规划闸)', !!(r1 && r1.error && /尚未批准/.test(r1.error)), r1 && r1.error)

    // 2) 批准后放行;goal 里手写的错 tag(zzzz)被剥掉,以 parentTag 机械注入
    world.approvePlan(orch.wcId)
    const r2 = world.S.dispatchShard('[orch:zzzz] 勘察认证模块入口', tag)
    ok('批准+parentTag:放行', !!(r2 && r2.id && !r2.error), r2)
    const regs = [...world.S.wfRegistry.values()]
    ok('分片挂到 parentTag 名下', regs.some((r) => r.parentOrch === tag), regs.map((r) => ({ id: r.id, parentOrch: r.parentOrch })))
    ok('手写错 tag 被剥掉(无 zzzz 名下分片)', !regs.some((r) => r.parentOrch === 'zzzz'))

    // 3) parentTag 不存在 → 拒(不许悬空派发)
    const r3 = world.S.dispatchShard('勘察别的模块', 'nope')
    ok('parentTag 不存在:拒派', !!(r3 && r3.error && /不存在/.test(r3.error)), r3 && r3.error)

    // 4) 同 tag + 归一化 goal 相同(在跑)→ 去重闸拒
    const r4 = world.S.dispatchShard('勘察认证模块入口', tag)
    ok('相同目标再派:去重闸拒', !!(r4 && r4.error && /相同目标/.test(r4.error)), r4 && r4.error)

    // 5) 不同 goal → 放行
    const r5 = world.S.dispatchShard('勘察权限模块入口', tag)
    ok('不同目标:放行', !!(r5 && r5.id && !r5.error), r5 && r5.error)
  },
}
