// 用例⑮:走【真 relay】的派发语义 —— 世界唯一从 MCP 视角进来的用例。
//
// 为什么值得单开一条:别的用例都从 S.dispatchShard / S.orch 直接进,把 src/mail.js 的三个端点整层绕过去了。
// 而这一层住着对话卡 Agent 能看到的全部真相:自主升格开卡、编排入口回包、成果回取、递归硬禁。
// relay 在 harness 里是真起着的(startMailRelay 无条件执行,app.getPath 被重定向到 world 临时根)。
//
// 只留新引擎之后的口径变化:
//   · parentTag 那套"主控手写标记派分片"没有了 → 显式拒绝并指路(不再静默开出无归属的卡)
//   · /orch/run-orch 回 { id: 面板卡 id, runId }(workflow_result 按卡 id 取)
// 跑法:node scripts/replay/run.mjs 15
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '⑮真 relay:自主升格 / 编排入口 / 成果回取 / parentTag 显式拒绝 / 递归硬禁',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 1 } },   // 压到 1 才测得到 queued 回包拍平
  async run(world) {
    const S = world.S
    S.orchDecide = async () => ({ ok: true, data: { needGrounding: false, nodes: [], more: 'no', why: '不值得拆' } })

    // ① 对话卡自主升格:不带 parentTag → 开一张普通工作流卡。【这条路径一字未变,是本用例的压舱石】
    const r1 = await world.relayPost('/orch/run', { goal: '帮我把认证模块理一遍' })
    ok('自主升格:放行并回卡 id', !!(r1 && r1.ok && r1.id != null && !r1.error), r1)
    ok('★不是分片(没有主控这个概念了)', r1.shard === false, r1)
    const reg1 = S.wfRegistry.get(String(r1.id))
    ok('开的是普通可见工作流卡(不是隐藏工人)', !!reg1 && !reg1.runId && !(S.shardWc && S.shardWc.has(reg1.wcId)), reg1 && { runId: reg1.runId })

    // ② 并发位已满 → 第二个进队列:回包必须【拍平】(不拍平 MCP 文本会打出 id=[object Object])
    const r2 = await world.relayPost('/orch/run', { goal: '再来一个目标' })
    ok('并发满:回包 queued=true', r2 && r2.queued === true, r2)
    ok('★queued 回包已拍平(position 是数字,id 不是对象)',
      typeof r2.position === 'number' && (r2.id === undefined || typeof r2.id !== 'object'), r2)

    // ③ parentTag:显式拒绝并指路 —— 不许静默开出一张没人管的孤儿卡
    const r3 = await world.relayPost('/orch/run', { goal: '干点活', parentTag: 'RUN-abcd' })
    ok('★带 parentTag:显式拒绝', !!(r3 && r3.error), r3)
    ok('★拒绝文案指向编排面板(告诉它该怎么做,不是光说不行)', /编排面板/.test(String(r3.error)), r3.error)

    // ④ 编排入口:回 { id: 面板卡 id, runId }
    const r4 = await world.relayPost('/orch/run-orch', { goal: '摸清这个仓库' })
    ok('run-orch 放行', !!(r4 && r4.ok && !r4.error), r4)
    ok('★回包带面板卡 id 与 runId(workflow_result 按卡 id 取)', r4.id != null && !!r4.runId, r4)
    const run = S.orch.get(r4.runId)
    ok('runId 指向真 run', !!run, r4.runId)
    ok('id 指向它的面板卡', String(run.panelCardId) === String(r4.id), { panelCardId: run.panelCardId, id: r4.id })

    // ⑤ 成果回取:按面板卡 id 取得到
    const r5 = await world.relayPost('/orch/result', { id: String(r4.id) })
    ok('/orch/result 按面板卡 id 取得到', !!(r5 && r5.ok && String(r5.id) === String(r4.id)), r5)

    // ⑥ 递归硬禁仍在(便宜的防线,已知不完备 —— 真正的防线写在节点指令里)
    const alias = run.alias
    const r6 = await world.relayPost('/orch/run-orch', { goal: '[orch:' + alias + '] 想再开一层' })
    ok('递归开编排:硬禁(便宜的防线,已知不完备 —— 真防线在节点指令里)', !!(r6 && r6.error && /再开一层编排/.test(r6.error)), r6)
  },
}
