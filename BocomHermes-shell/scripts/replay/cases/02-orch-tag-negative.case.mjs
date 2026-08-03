// 用例②(改写):goal 文本里的 [orch:TAG] 【不再】有任何效力 —— 负面守卫。
//
// 旧引擎拿这个文本标记当父子外键,于是长出一整套:机械注入、剥手写、全角救援、单命中兜底。
// 新引擎的节点身份走 opts 结构化下发,文本标记彻底无效。
// 但"无效"必须是【真无效】,不能是"解析不到就当没有":留着旧的文本分支的话,
// 用户或模型的 goal 里一旦出现这种字样,就会开出一张隐藏、权限自动放行、没人收官的孤儿卡 ——
// 静默烧钱,界面上完全看不见。这条用例就守这个洞。
// 跑法:node scripts/replay/run.mjs 02
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '②[orch:TAG] 文本标记不再产生分片(负面守卫)',
  mode: 'manual',
  // 并发余量给足:前面 4 张负面守卫卡会占位,不给余量的话对照组节点会停在 queued
  // (那其实是 capHint 在正确工作 —— 但这条用例不是测它的)
  settings: { knobs: { wfConcurrency: 12 } },
  async run(world) {
    const S = world.S
    // 先起一个真 run,拿到它真实存在的 alias —— 最刁钻的情形:文本里写的是【真的存在】的标记
    S.orchDecide = async () => ({ ok: true, data: { needGrounding: false, nodes: [], more: 'no', why: '不值得拆' } })
    const r = S.orch.createRun('拿一个真实存在的 alias', {})
    const alias = S.orch.get(r.id).alias
    ok('前置:拿到真实 alias', !!alias, alias)

    for (const [label, goal] of [
      ['行首半角', '[orch:' + alias + '] 干点活'],
      ['全角+全角冒号', '【orch：' + alias + '】干点活'],
      ['非行首', '先干点活 [orch:' + alias + '] 再说'],
      ['不存在的 tag', '[orch:zzzz] 干点活'],
    ]) {
      const w = world.spawnWorkflow(goal)
      const reg = w.reg
      ok(label + ':开的是【普通可见工作流卡】不是隐藏工人', !!(reg && !reg.parentOrch), { label, parentOrch: reg && reg.parentOrch })
      ok(label + ':不进无人值守白名单(权限不自动放行)', !(S.shardWc && S.shardWc.has(reg.wcId)), label)
      ok(label + ':没有 runId(不归任何编排管)', !reg.runId, { label, runId: reg.runId })
    }

    // 反向:真正的编排节点必须是隐藏工人 —— 证明"隐藏卡"这条路还在,只是不再由文本触发
    S.orchDecide = async (point) => point === 'plan'
      ? { ok: true, data: { needGrounding: false, more: 'no', why: '一片', nodes: [{ id: 'a', kind: 'work', title: '甲', goal: '干甲', deps: [], writeScope: ['src/a'], contract: [], artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' }] } }
      : { ok: true, data: { addNodes: [], dropNodes: [], done: false, more: 'no', why: '等' } }
    const r2 = S.orch.createRun('真编排', {})
    await waitFor(() => S.orch.get(r2.id).phase === 'awaiting-approval', { name: 'plan 没落地' })
    S.orch.approve(r2.id)
    const node = S.orch.get(r2.id).nodes[0]
    const nreg = node && node.cardId ? S.wfRegistry.get(String(node.cardId)) : null
    ok('★对照:真编排节点仍是隐藏无人值守工人(结构化下发,不靠文本)',
      !!(nreg && nreg.runId && S.shardWc && S.shardWc.has(nreg.wcId)),
      { state: node && node.state, cardId: node && node.cardId, runId: nreg && nreg.runId, inShardWc: !!(nreg && S.shardWc && S.shardWc.has(nreg.wcId)) })
  },
}
