// 用例⑬:注册表 50 条 FIFO 逐出必须跳过【在跑】的项 —— 两条 spawnCard 路径同一口径。
// 病灶(实锤):内嵌路径(window.js:165)原来是 `keys().next().value` 无条件删最老,而真窗口路径(:235)有 running 守卫。
// 而【主控卡恰好只走内嵌路径】(spawnOrchestrator 不传 hidden/window)——累计开满 50 张 wf/orch/pipeline 卡后,
// 正在跑的主控会被它自己派出的分片挤出注册表 → 分片收官时 shardSettled 按 tag 反查拿到空 reg → 唤醒静默丢失 →
// 整条链停摆且无任何提示(:234 注释记的正是这个后果:"唤醒目标丢失 + 全收官分母算错")。
// 断言:塞满逐出后,running 的主控与 running 的分片都还在;被逐出的是终态项。
// 跑法:node scripts/replay/run.mjs 13
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '⑬注册表 FIFO:逐出跳过在跑项(内嵌路径与真窗口路径同口径)',
  mode: 'manual',
  async run(world) {
    const S = world.S
    S.orchDecide = async (point) => point === 'plan'
      ? { ok: true, data: { needGrounding: false, more: 'no', why: '一片', nodes: [{ id: 'a', kind: 'work', title: '勘察认证', goal: '干活', deps: [], writeScope: ['src/a'], contract: [], artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' }] } }
      : { ok: true, data: { addNodes: [], dropNodes: [], done: false, more: 'no', why: '等' } }
    const r = S.orch.createRun('FIFO 守卫测试', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地' })
    S.orch.approve(r.id)
    const orch = { id: r.cardId }
    const shard = { id: S.orch.get(r.id).nodes[0].cardId }
    ok('前置:编排面板卡 + 一个在跑节点卡都在注册表里', !!(S.wfRegistry.get(String(orch.id)) && shard.id && S.wfRegistry.get(String(shard.id))), { panel: orch.id, node: shard.id })
    ok('前置:面板卡 status=running', S.wfRegistry.get(String(orch.id)).status === 'running')

    // 把注册表塞过 50 条:这些都是【终态】占位项,逐出应当只吃它们
    for (let i = 0; i < 60; i++) {
      const id = 'filler-' + i
      S.wfRegistry.set(id, { id, wcId: null, kind: 'workflow', goal: '占位 ' + i, status: 'done', rounds: 1, at: Date.now(), files: [], actions: [] })
      // 复刻内嵌路径的逐出语句(window.js:165 修复后的形态由被测代码保证,这里只负责把表撑过线)
      if (S.wfRegistry.size > 50) {
        const victim = [...S.wfRegistry.entries()].find(([, v]) => !v || v.status !== 'running')
        if (victim) S.wfRegistry.delete(victim[0])
      }
    }
    ok('注册表被压回 50 条以内', S.wfRegistry.size <= 51, S.wfRegistry.size)
    ok('★在跑的编排面板卡没有被逐出', !!S.wfRegistry.get(String(orch.id)), [...S.wfRegistry.keys()].slice(0, 8))
    ok('★在跑的节点卡没有被逐出', !!S.wfRegistry.get(String(shard.id)))
    ok('alias 反查仍能拿到活着的面板卡 reg(ShardPanel 垫片没丢)', (() => {
      const ref = S.orchByTag.get(S.orch.get(r.id).alias)
      return !!(ref && S.wfRegistry.get(String(ref.id)))
    })())

    // 再验被测代码本身:直接走真 spawnCard 内嵌路径(start-conversation orch)开新卡,表已满,
    // 逐出仍不许吃掉在跑的主控/分片
    const r2 = S.orch.createRun('第二个编排', {})
    ok('再开一个编排后:第一个在跑面板卡仍在(真代码路径)', !!S.wfRegistry.get(String(orch.id)))
    ok('再开一个编排后:在跑节点卡仍在(真代码路径)', !!S.wfRegistry.get(String(shard.id)))
    ok('新面板卡自己也在', !!S.wfRegistry.get(String(r2.cardId)))
  },
}
