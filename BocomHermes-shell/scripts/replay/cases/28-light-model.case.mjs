// 用例㉘:轻活模型 —— 核实/检查节点降档,其余节点不动
//
// 【为什么值得做】核实与检查是"一两个回合就完"的活:顺着一条证据走一遍、跑一条命令看结果。
// 而在一次排查里它们往往占一半以上的节点数(每条发现一个核实员,高严重度还两个)——
// 全用主模型是纯浪费,内网上更是直接翻倍墙钟时间。
//
// 【为什么必须是"留空即无变化"】没配第二个模型的人占多数(用户自己的 settings.json 里就只有一个)。
// 这个字段一旦在缺省时改变了任何行为,受益的人是零、受影响的人是全部。所以本用例第一条就钉这个。
//
// 【为什么只给 verify/check】probe 要读代码做判断、reduce 要跨片对齐取舍 —— 那两类降档会真的降质量。
//
// 跑法:node scripts/replay/run.mjs 28
import { ok, waitFor } from '../harness.mjs'

const MAIN = { providerID: 'p', modelID: 'main-model', name: '主模型' }
const LIGHT = { providerID: 'p', modelID: 'light-model', name: '轻活模型' }

export default {
  name: '㉘轻活模型:核实/检查降档,其余不动,留空即无变化',
  mode: 'manual',
  settings: { model: MAIN },
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    // 一个 work + 一个 verify,同一批派出去 —— 只有 kind 不同
    const plan = { needGrounding: false, more: 'no', why: '两片',
      nodes: [
        { title: '干活片', goal: '改点东西', kind: 'work', deps: [], writeScope: ['src/a'], contract: [],
          artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' },
        { title: '核实片', goal: '核一条结论', kind: 'verify', deps: [], writeScope: [], contract: [],
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

    // ── ① 没配轻活模型:两片都拿主模型(缺省行为逐字节不变)──
    S.settings.modelLight = null
    const r1 = S.orch.createRun('重构订单模块的下单流程', {})
    await waitFor(() => S.orch.get(r1.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.approve(r1.id)
    const run1 = S.orch.get(r1.id)
    // ★契约在 2026-08-08 改了:原来这里钉的是 reg.model == null(不覆盖,跟 serve 默认走)。
    //   真机证明"跟 serve 默认走"是个坑 —— serve 挑的是【这个项目上次用过的模型】
    //   (存在 opencode.db 里,应用建会话时带了 ?directory=),而不是设置里选的那个。
    //   结果:设置页写着 DeepSeek V4 Pro,实际跑的是 opencode/deepseek-v4-flash-free,
    //   而那个模型当时返回空消息(0 token、无报错、永不收官),plan 挂了 12 分钟。
    //   现在 createRun 兜到 S.settings.model —— 显式胜过隐式,用户选的模型必须真生效。
    ok('★没配轻活模型 → 两片都拿【设置里那个】主模型(不再靠 serve 自己挑)',
      (modelOf(run1, '核实片') || {}).modelID === MAIN.modelID
        && (modelOf(run1, '干活片') || {}).modelID === MAIN.modelID,
      { 核实: modelOf(run1, '核实片'), 干活: modelOf(run1, '干活片') })

    // ── ② 配上轻活模型:只有核实片降档 ──
    S.settings.modelLight = LIGHT
    const r2 = S.orch.createRun('重构库存模块的扣减流程', {})
    await waitFor(() => S.orch.get(r2.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.approve(r2.id)
    const run2 = S.orch.get(r2.id)
    ok('★核实片用轻活模型', (modelOf(run2, '核实片') || {}).modelID === LIGHT.modelID, modelOf(run2, '核实片'))
    ok('★干活片不受影响,仍是主模型(降档只针对"一两个回合就完"的那类活)',
      (modelOf(run2, '干活片') || {}).modelID === MAIN.modelID, modelOf(run2, '干活片'))

    S.settings.modelLight = null

    // ── ③ 决策链也要拿到设置里的模型(它才是"挂 12 分钟"的现场)──────────────
    // decide.js 传的是 run.model;原来 run.model 恒 null → 决策会话不指定模型 →
    // serve 用项目记住的那个 → 真机上是 flash-free,返回空消息、永不收官。
    const r3 = S.orch.createRun('重构报表模块的导出流程', {})
    ok('★run 自己带上了设置里的模型(决策链取的就是它)',
      (S.orch.get(r3.id).model || {}).modelID === MAIN.modelID, S.orch.get(r3.id).model)
    ok('  显式传 model 的调用方照旧优先(opts.model 不被盖掉)',
      (S.orch.get(S.orch.createRun('重构导入流程', { model: LIGHT }).id).model || {}).modelID === LIGHT.modelID)
  },
}
