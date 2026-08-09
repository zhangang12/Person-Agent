// 用例㉛:★编排在跑时,relay 不许开新卡 —— "卡自己蹦出来了"的最后一道闸
//
// 【现场】真机 2026-08-09。汇总片的子 Agent 说了一句
//   "This merge task is hitting tool JSON parsing limits. Let me delegate it to a sub-agent with a clean context window."
// 然后调 MCP 的 run_workflow,凭空开出一张可见工作流卡(侧栏「工作流 · 将 4 组上游分片正文整合…」),
// 那张卡自己卡在"请点开始执行"等人批,而汇总片一直轮询 workflow_result 等它 ——
// 落定失败 → 烧掉一次 attempt → 依赖它的验收片被撤 → 重规划拆两片 → 额度耗尽。用户第一句话是「GG,怎么自己开出来一个卡?」
//
// 【为什么原有的闸拦不住】session.js 里写着"★升格硬闸:工人节点【不许自己开新卡】",正则也确实匹配
// BocomHermes-orch_run_workflow —— 但它落在【权限层】,而 serve 对子 Agent 的 MCP 调用不问权限:
// 日志里那句"工人节点尝试自行升格,已拒绝"一次都没出现过。有身份的那一层不在调用路径上。
//
// 【为什么不给 MCP 加身份】实测排除:一台 serve 只起一份 orch-mcp 进程(ps 实数 = 1),
// 配置是 opencode.jsonc 一份文件、启动时读一次,没有"每卡一份 MCP 配置";工具参数由模型自己填,
// 也塞不进只有真调用方知道的凭据。这一层永远不知道调用方是谁。
//
// 【所以闸退到 relay】relay 不知道"谁"在调,但壳层知道"此刻有没有编排在跑"。
// 编排跑着时开新工作流的正常路径是面板,不是 relay:人不受影响,工人被挡住。
//
// 跑法:node scripts/replay/run.mjs 31
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '㉛编排在跑时 relay 不许开新卡(工人自行升格的最后一道闸)',
  mode: 'manual',
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    // ── ① 没有编排在跑:这条路照旧通(不许把正常能力一起拦掉)──
    const before = await world.relayPost('/orch/run', { goal: '把这份文档整理一下' })
    ok('★没有编排在跑 → relay 开卡照旧允许(闸不许扩大到无编排的场景)',
      !!(before && (before.ok || before.id)), before)

    // ── ② 起一个编排,让它进入"在跑"──
    S.orchDecide = async (point) => point === 'plan'
      ? { ok: true, data: { needGrounding: false, more: 'no', why: '一片',
        nodes: [{ title: '干活', goal: '读大仓', kind: 'work', deps: [], writeScope: ['src/a'], contract: [],
          artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' }] } }
      : { ok: true, data: { addNodes: [], dropNodes: [], done: false, facts: [], open: [], why: '继续' } }
    const r = S.orch.createRun('分析仓库收货的所有逻辑', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })

    // ── ③★编排在跑(哪怕只是等批准)→ 一律拒,并把正路写清楚 ──
    const during = await world.relayPost('/orch/run', { goal: '将 4 组上游分片正文整合进当前汇总文档' })
    ok('★★编排在跑 → relay 开卡被拒(修前:工人一句话就能凭空开出一张无人回收的卡)',
      !!(during && during.error) && !during.ok, during)
    ok('  回执点名 task 子 Agent 是正路(干拒不给出路 = 它下一轮还会再试)',
      /task 子 Agent/.test(String((during && during.error) || '')), during && during.error)
    ok('  回执告诉用户本人怎么开(别把人也一起挡死)',
      /面板/.test(String((during && during.error) || '')), during && during.error)

    // ── ④ 另一条入口 /orch/run-orch(再开一层编排)同样要拦 ──
    const during2 = await world.relayPost('/orch/run-orch', { goal: '把整个仓库再编排一遍' })
    ok('★/orch/run-orch 同样被拦(两条入口都得堵,堵一条等于没堵)',
      !!(during2 && during2.error) && !during2.ok, during2)

    // ── ⑤ 编排收了之后要放行(闸是"在跑期间",不是永久关门)──
    S.orch.abort(r.id)
    await waitFor(() => ['cancelled', 'done', 'failed'].indexOf(S.orch.get(r.id).phase) >= 0, { name: '没收掉', timeout: 8000 })
    const after = await world.relayPost('/orch/run', { goal: '编排结束后再整理一下' })
    ok('★编排收口后 → 这条路重新放行(不是永久关门)',
      !!(after && (after.ok || after.id)), after)
  },
}
