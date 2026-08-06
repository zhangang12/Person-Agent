// 用例㉗:★发现走工具上报 —— 走真 relay(MCP report_findings 的那条 HTTP 路)
//
// 【病灶】原来发现只能从工人终答正文里的 <发现> 块用正则抠。那是一个【格式约定】,
// 弱模型漏格式是常态;而漏了之后壳层看到的是"这片没查出问题",与"这片真的没问题"
// 【长得一模一样】—— 面板不会说任何话,没人知道这里丢了东西。失败了还看不出来。
//
// 【改法】加一条工具路:工人调 MCP report_findings → relay /orch/findings → 状态机 NODE_FINDINGS。
// 工具的好处不在"更规范",在于【收不下能当场告诉它为什么】:太笼统的退回、别的片报过的说明重复,
// 工人还有机会改。正文那条保留为降级路径。
//
// 本用例走真 mail.js relay(带 token 的本地 HTTP)+ 真 orch 装配,不是直接调状态机 ——
// 中间少接一根线(端点没注册 / S.orch 上没挂 reportFindings / nodeRef 解析错)在单测里全看不出来。
//
// 跑法:node scripts/replay/run.mjs 27
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '㉗发现走工具上报:真 relay → 状态机 → 逐条派新眼睛',
  mode: 'manual',
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    // 目标取实现类:本用例测上报链路,不想被"按视角补宽"的 6 片扰乱节点计数(补宽见 ㉖)
    S.orchDecide = async (point) => {
      if (point === 'plan') {
        return { ok: true, data: { needGrounding: false, more: 'no', why: '一片',
          nodes: [{ title: '查表单', goal: '把表单查一遍', kind: 'work', deps: [],
            writeScope: ['docs/a.md'], contract: [], artifacts: [],
            requireEvidence: false, requireVerdict: false, verifyCmd: '' }] } }
      }
      return { ok: true, data: { addNodes: [], dropNodes: [], done: false, facts: [], open: [], why: '继续' } }
    }

    const r = S.orch.createRun('重构表单校验逻辑', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.approve(r.id)
    const node = S.orch.get(r.id).nodes[0]
    ok('节点派出来了', !!node && !!node.cardId, node && node.id)
    if (!node) return

    // 工人拿到的凭据长什么样 —— 它就是照着指令里那一栏抄的
    const ref = r.id + ':' + node.id
    ok('★指令里给了这串凭据(工人照抄,不用自己拼)', String(node.brief || '').indexOf('【上报凭据】' + ref) >= 0,
      (String(node.brief || '').match(/【上报凭据】.{0,30}/) || [])[0])

    // ── 上报一批:两条真的、一条太笼统 ──
    const rep1 = await world.relayPost('/orch/findings', { nodeRef: ref, findings: [
      { severity: '高', what: '订单金额在 src/order/calc.ts:88 用 float 累加,超 8 位丢精度', evidence: 'src/order/calc.ts:88' },
      { severity: '中', what: '库存扣减没有幂等保护,重复提交会扣两次', evidence: 'src/stock/deduct.ts:31' },
      { severity: '高', what: '不好' },      // 太笼统 → 核不动
    ] })
    ok('★真 relay 收下了(端点注册 + S.orch.reportFindings 都通了)', !!(rep1 && rep1.ok), rep1)
    ok('  收下 2 条', rep1 && rep1.accepted === 2, rep1)
    ok('★退回的条数如实回给工人(它才有机会改具体;静默丢弃就退回老毛病了)', rep1 && rep1.rejected === 1, rep1)

    const n1 = S.orch.get(r.id).nodes.find((n) => n.id === node.id)
    ok('  发现真的记到节点上了', (n1.result.findings || []).length === 2, n1.result.findings)

    // ── 再报一次同一条:去重,并如实告诉它 ──
    const rep2 = await world.relayPost('/orch/findings', { nodeRef: ref, findings: [
      { severity: '高', what: '订单金额在 src/order/calc.ts:88 用 float 累加,超 8 位丢精度。' },
    ] })
    ok('  重复上报被去重', rep2 && rep2.accepted === 0 && rep2.dupes === 1, rep2)

    // ── 脏 ref 不炸、也不记到别人头上 ──
    const bad1 = await world.relayPost('/orch/findings', { nodeRef: 'garbage', findings: [{ what: '这条足够长可以入账' }] })
    ok('★ref 格式不对 → 明确报错(relay 是无身份 HTTP,不能猜)', !!(bad1 && bad1.error), bad1)
    const bad2 = await world.relayPost('/orch/findings', { nodeRef: 'R-不存在:n1', findings: [{ what: '这条足够长可以入账' }] })
    ok('  runId 找不到 → 明确报错,不落到别的 run 头上(两工作流串台刚修过一次)', !!(bad2 && bad2.error), bad2)

    // ── 工人真跑一轮(有终答才过得了 noEmpty)→ 45s 静默落定 → 按【工具报的那两条】逐条派新眼睛 ──
    const reg = S.wfRegistry.get(String(node.cardId))
    const wc = world.wcById(reg.wcId)
    await world.cardInit(wc, { shard: 1, title: '查表单' })
    await world.cardSend(wc, '查完了,细节见 docs/a.md')
    world.fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await waitFor(() => S.orch.get(r.id).nodes.some((n) => n.kind === 'verify'), { name: '没有按发现派出核实节点', timeout: 8000 }).catch(() => null)
    const nAfter = S.orch.get(r.id).nodes.find((n) => n.id === node.id)
    ok('  (诊断)节点收官状态与退出检查', nAfter.state === 'verified',
      { state: nAfter.state, reason: nAfter.reason, report: nAfter.result.exitReport, final: String(nAfter.result.final || '').slice(0, 60), findings: (nAfter.result.findings || []).length })
    const vs = S.orch.get(r.id).nodes.filter((n) => n.kind === 'verify')
    // 高严重度那条开两票(证伪 / 可复现,两条互不重叠的路子),中的一票 → 共 3 个
    ok('★工具报的两条都派了新眼睛去核(高的两票、中的一票)', vs.length === 3, vs.map((n) => n.title))
    ok('  高严重度那条拿到两个【不同视角】(同一个人问两遍等于问一遍)',
      new Set(vs.filter((n) => /订单金额/.test(n.title)).map((n) => n.title.split('·')[1].split(' ')[0])).size === 2,
      vs.map((n) => n.title))
    // ★下面三条都必须先要求 vs 非空 —— every 对空数组恒真,写成 vs.every(...) 就是又一条
    //   "为了错误的理由而通过"的断言(这个仓这一趟已经抓到过五条)。
    ok('  核实节点是只读的(不许边核边改)', vs.length > 0 && vs.every((n) => (n.writeScope || []).length === 0))
    ok('  记下 findingKey(下一片报同一件事时不重复派)', vs.length > 0 && vs.every((n) => !!n.findingKey), vs.map((n) => n.findingKey))
    ok('  挂在源节点后面(sourceNode 记住是谁报的)', vs.length > 0 && vs.every((n) => n.sourceNode === node.id))
  },
}
