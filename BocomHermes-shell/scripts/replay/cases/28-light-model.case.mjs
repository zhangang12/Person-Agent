// 用例㉘:★一件事情,一个模型干 —— 整个 run 不许出现第二个模型
//
// 【这条用例原来是反的】它曾经断言"核实/检查降档到 modelLight"(提交 28572fc「轻活模型分档」)。
// 出发点是省钱:核实片"一两个回合就完",却常占一半以上的节点数,全用主模型确实是浪费。
// 2026-08-08 用户拍板推翻,理由两条,第二条是真机付出一整天代价才看清的:
//
//   ① 上下文连续性:同一件事被两个模型分着干,后半段读前半段的产出,口径与结论粒度对不齐。
//
//   ② 替身死了没有人知道。真机现场:modelLight = opencode/mimo-v2.5-free 被上游限流
//      (serve 自己的日志里 39 条 stream 全部 "Rate limit exceeded",+1.9 秒就被拒),
//      16 片核实全军覆没;而面板 chip 上写的一直是用户选的 DeepSeek V4 Flash ——
//      那个模型当天 26 条请求一次没失败。用户看到的是"闸门大面积爆红",
//      真相是【一个他从没选过的模型】在替他干活、并且死了。
//      省钱的代价是把故障藏进了一个用户完全看不见的维度:他没法怀疑一个他不知道存在的东西。
//
// 【所以这条用例现在钉的是"不许分档"】要省钱就换整个 run 的模型,
// 不许一次编排里跑出两个模型 —— 这是设计约束,不是实现细节。
//
// 跑法:node scripts/replay/run.mjs 28
import { ok, waitFor } from '../harness.mjs'

const MAIN = { providerID: 'p', modelID: 'main-model', name: '主模型' }

export default {
  name: '㉘一件事一个模型:所有 kind 都跟 run 的模型,不许分档',
  mode: 'manual',
  settings: { model: MAIN },
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    // 四类节点同一批派出去 —— 只有 kind 不同,模型必须一模一样
    const plan = { needGrounding: false, more: 'no', why: '四片',
      nodes: [
        { title: '干活片', goal: '改点东西', kind: 'work', deps: [], writeScope: ['src/a'], contract: [],
          artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' },
        { title: '勘察片', goal: '先摸一遍', kind: 'probe', deps: [], writeScope: [], contract: [],
          artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' },
        { title: '核实片', goal: '核一条结论', kind: 'verify', deps: [], writeScope: [], contract: [],
          artifacts: [], requireEvidence: false, requireVerdict: true, verifyCmd: '' },
        { title: '检查片', goal: '查一遍', kind: 'check', deps: [], writeScope: [], contract: [],
          artifacts: [], requireEvidence: false, requireVerdict: true, verifyCmd: '' },
      ] }
    S.orchDecide = async (point) => point === 'plan'
      ? { ok: true, data: plan }
      : { ok: true, data: { addNodes: [], dropNodes: [], done: false, facts: [], open: [], why: '继续' } }

    const modelOf = (run, title) => {
      const n = run.nodes.find((x) => x.title === title)
      if (!n || !n.cardId) return null
      const reg = S.wfRegistry.get(String(n.cardId))
      return reg ? reg.model || null : null
    }
    const KINDS = ['干活片', '勘察片', '核实片', '检查片']

    // ★先把废弃设置项塞回去:后面两格【同时】证明"不许分档"和"旧设置项不留后门"。
    //   (原来这里另起了第三个 run 单测后门,结果前两个 run 的 12 张卡把并发位占满,
    //    第三批根本没派出去、cardId 全空 —— 断言看着红,其实测了个寂寞。用例本身的坑,不是代码。)
    S.settings.modelLight = { providerID: 'z', modelID: 'light-model', name: '轻活模型' }

    // ── ① run 没指定模型:四类【全都】不带覆盖,跟全局默认走(仍然是同一个模型)──
    // reg.model = null 的含义是"不覆盖,跟全局默认走",卡建会话时再解析成 S.settings.model。
    // 分档若还在,核实/检查这里会拿到 light-model 而不是 null —— 所以这一格就是后门检测。
    const r1 = S.orch.createRun('重构订单模块的下单流程', {})
    await waitFor(() => S.orch.get(r1.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.approve(r1.id)
    const run1 = S.orch.get(r1.id)
    for (const t of KINDS) ok('★' + t + ' 不带模型覆盖(settings 里就摆着 modelLight,分档若还在这里必红)',
      modelOf(run1, t) == null, modelOf(run1, t))

    // ── ②★run 指定了模型:四类【全都】用它,一个都不许被换掉 ──
    // 这一条就是防回归的本体:任何人再按 kind 分档,这里立刻红。
    const PINNED = { providerID: 'q', modelID: 'run-model', name: '本次编排的模型' }
    const r2 = S.orch.createRun('重构库存模块的扣减流程', { model: PINNED })
    await waitFor(() => S.orch.get(r2.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.approve(r2.id)
    const run2 = S.orch.get(r2.id)
    const got = KINDS.map((t) => (modelOf(run2, t) || {}).modelID || null)
    ok('★四类节点全部用 run 的模型(修前:核实/检查会被换成 modelLight)',
      got.every((m) => m === PINNED.modelID), KINDS.map((t, i) => t + '=' + got[i]).join(' '))
    ok('★整个 run 只出现【一个】模型 —— 这是设计约束,不是实现细节',
      new Set(got).size === 1, [...new Set(got)])

    ok('★没有任何一片拿到 modelLight —— 设置项已废,不留后门',
      !got.includes('light-model') && KINDS.every((t) => ((modelOf(run1, t) || {}).modelID || null) !== 'light-model'))
    S.settings.modelLight = null
  },
}
