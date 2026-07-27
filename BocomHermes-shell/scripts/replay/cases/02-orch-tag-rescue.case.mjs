// 用例②(已修真实 bug 的回归):[orch:TAG] 不在 goal 最前时,parseOrchTag 全文二次扫描兜底。
// 链路:主控派分片的 goal 被弱模型写歪(标记不在行首、全角【】/全角冒号)→ 行首正则落空 →
//   二次扫描命中且 tag 真实存在于 orchByTag → 照样登记 reg.parentOrch(否则分片收官无人唤醒,整链卡死)。
// 断言点:parentOrch 正确登记;rescued 日志留痕;goal 剥掉标记;分片进度聚合推主控;
//   负面对照——tag 形状在但主控不存在时不兜底(防误吞用户文本同形字符串)。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 02)
import { ok } from '../harness.mjs'

export default {
  name: '②[orch:TAG] 不在 goal 最前(全角【】:) → parseOrchTag 二次扫描兜底登记 parentOrch',
  mode: 'manual',
  async run(world) {
    const orch = world.spawnOrchestrator('给登录模块补文档')
    // 弱模型写歪形态:标记不在行首,且是全角【】与全角冒号(行首正则 ^\[orch: 必落空)
    const goal = '把登录模块文档补齐\n\n【orch：' + orch.tag + '】\n顺带核对权限边界'
    const shard = world.spawnWorkflow(goal)
    ok('二次扫描兜底:parentOrch 正确登记', !!(shard.reg && shard.reg.parentOrch === orch.tag), shard.reg && shard.reg.parentOrch)
    ok('兜底日志留痕(orch tag rescued)', world.logs.some((l) => l.includes('orch tag rescued')), world.logs.filter((l) => l.includes('orch')))
    ok('goal 剥掉标记(展示/注入不再带 tag)', !!(shard.reg && !/orch/i.test(shard.reg.goal)), shard.reg && shard.reg.goal)
    ok('分片进度聚合推给主控(登记即推)', world.shardProgress(orch.wcId).some((s) => (s.p.shards || []).some((x) => x.id === shard.reg.id)))

    // 负面对照:tag 形状在,但 orchByTag 里没有这个 tag → 不认(防误吞用户文本里的同形字符串)
    const stray = world.spawnWorkflow('用户文本里聊到 【orch：NOPE】 但这不是真标记')
    ok('tag 不存在 → 不兜底(按普通工作流开卡,无 parentOrch)', !!(stray.reg && !stray.reg.parentOrch), stray.reg && stray.reg.parentOrch)
    ok('rescued 日志无新增(仅第一次真兜底)', world.logs.filter((l) => l.includes('orch tag rescued')).length === 1)
  },
}
