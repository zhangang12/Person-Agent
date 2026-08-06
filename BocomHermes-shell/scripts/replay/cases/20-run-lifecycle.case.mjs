// 用例⑳:编排引擎全链 —— 端到端主护栏。
//
// 链路:run_orchestration → 开【面板卡】(不是 LLM 主控卡)→ plan 决策 → awaiting-approval →
//       用户批准(IPC,不是从工具流嗅探)→ 派节点(真 spawnWorkflow,隐藏工人卡)→
//       工人轮末 → 45s 静默落定 → evalExit(按磁盘产出判,不看 todo)→ verified → 每节点必调 replan →
//       replan 说 done → run 收口。
//
// 决策器用注入桩(S.orchDecide):真决策要起会话等模型,replay 里必须确定性喂结果,否则这条链只能靠真跑验。
//
// 特别断言(旧引擎的病灶在新引擎里应当结构上不存在):
//   · 面板卡不发消息(编排不是"跟一个 Agent 聊天")
//   · 批准是显式状态转移,不依赖渲染端嗅 todowrite
//   · 节点收官【不】走 shardSettled、【不】给面板注入中文唤醒
//   · 全局账与一次性标志(verifyOpen/orchVerifyRetry/orchNotified…)一个都不许出现 —— 防倒退哨兵
// 跑法:node scripts/replay/run.mjs 20
import { ok, expectState, waitFor } from '../harness.mjs'

export default {
  name: '⑳新引擎全链:plan → 批准 → 派节点 → 落定 → evalExit → replan → done',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 4 } },
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch, '装配失败见日志 [orch]')
    if (!S.orch) return

    // ── 决策桩:第 1 次(plan)给两个节点;之后(replan)第一次说"还有",第二次说 done ──
    const asked = []
    let replanN = 0
    S.orchDecide = async (point, ctx) => {
      asked.push({ point, event: ctx.event, nodeId: ctx.nodeId })
      if (point === 'plan') {
        ok('plan 决策拿到了【代码算好的】目录事实(不让模型估量级)', !!(ctx.survey && typeof ctx.survey.n === 'number'), ctx.survey && Object.keys(ctx.survey))
        return { ok: true, data: {
          needGrounding: false, more: 'unknown', why: '拆两片先跑',
          nodes: [
            { id: 'a', kind: 'work', title: '勘察认证', goal: '读认证模块并写 docs/a.md', deps: [], writeScope: ['src/a'], contract: [], artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' },
            { id: 'b', kind: 'work', title: '勘察订单', goal: '读订单模块并写 docs/b.md', deps: [], writeScope: ['src/b'], contract: [], artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' },
          ],
        } }
      }
      replanN++
      if (replanN >= 2) return { ok: true, data: { addNodes: [], dropNodes: [], done: true, more: 'no', why: '够了', final: { summary: '两片都拿到了结论', deliverables: ['docs/a.md'], gaps: [] } } }
      return { ok: true, data: { addNodes: [], dropNodes: [], done: false, more: 'unknown', why: '再等等另一片' } }
    }

    // 保活卡:harness 的 fake serve 只能听一个端口,全收官会连带退休"无引用的 serve",
    // 之后再开卡就会去起第二个端口而抛错。留一张永不收官的卡把 serve 钉住(沿用用例⑥⑧的纪律)
    const keep = world.spawnWorkflow('保活任务(本用例不收官)')
    await world.cardInit(keep.wc, { title: '保活' })

    // ── 起 run ──
    // ★目标刻意是【实现类】(goalShape → impl):本用例测的是全链相位，不是形状。
    //   survey/audit 型目标会触发「按视角补宽」(㈖ 专测)，那 6 片会把本用例的节点计数与收口全冲掉。
    const r = S.orch.createRun('重构认证与订单两个模块', {})
    ok('createRun 返回 runId + 面板卡 id', !!(r && r.id && r.cardId), r)
    const run0 = S.orch.get(r.id)
    ok('面板卡进了 wfRegistry(mirrorToOrch / 级联杀 / 卡坞都依赖它)', !!S.wfRegistry.get(String(r.cardId)))
    ok('面板卡 reg 带 runId(双轨分流判据)', (S.wfRegistry.get(String(r.cardId)) || {}).runId === r.id)
    ok('面板卡登记进 orchByTag(ShardPanel 兼容垫片)', !!S.orchByTag.get(run0.alias))

    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 决策没落地' })
    const run1 = S.orch.get(r.id)
    ok('plan 后进 awaiting-approval(人审闸是显式 phase)', run1.phase === 'awaiting-approval', run1.phase)
    ok('两个节点入图', run1.nodes.length === 2, run1.nodes.map((n) => n.id + ':' + n.state))
    ok('★批准前一个工人卡都没派', run1.nodes.every((n) => n.state === 'pending'), run1.nodes.map((n) => n.state))
    ok('★面板卡全程没发过消息(编排不是跟 Agent 聊天)', world.sentTo(run1.panelWcId).every((x) => x.ch !== 'card-inject'), world.sentTo(run1.panelWcId).map((x) => x.ch))

    // ── 批准:显式 IPC,不依赖"渲染端嗅到 todowrite" ──
    S.orch.approve(r.id)
    const run2 = S.orch.get(r.id)
    ok('批准 → executing', run2.phase === 'executing', run2.phase)
    const dispatched = run2.nodes.filter((n) => n.state === 'running' || n.state === 'queued')
    ok('★批准后节点被派出去了', dispatched.length === 2, run2.nodes.map((n) => n.id + ':' + n.state))
    ok('节点绑到了真工人卡', run2.nodes.every((n) => !!n.cardId), run2.nodes.map((n) => n.cardId))

    const nA = run2.nodes[0]
    const regA = S.wfRegistry.get(String(nA.cardId))
    ok('工人卡是隐藏分片卡(复用整套 shard 语义)', !!(S.shardWc && S.shardWc.has(regA.wcId)))
    ok('★写归属结构化下发,不再从 goal 文本 parse', JSON.stringify(regA.writeScope) === JSON.stringify(['src/a']), regA.writeScope)
    ok('工人 reg 带 runId + nodeId(回流路由)', regA.runId === r.id && regA.nodeId === nA.id, { runId: regA.runId, nodeId: regA.nodeId })

    // ── 工人跑一轮 → 轮末 → 45s 静默落定 → evalExit ──
    const wcA = world.wcById(regA.wcId)
    await world.cardInit(wcA, { shard: 1, title: '节点A' })
    await world.cardSend(wcA, '干活A')
    expectState('轮末后节点仍在跑(轮末 ≠ 完成,不看 todo)', () => S.orch.get(r.id).nodes[0].state === 'running')
    world.fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await waitFor(() => ['verified', 'failed'].includes(S.orch.get(r.id).nodes[0].state), { name: '节点 A 没有落定', timeout: 3000 })
    const nA2 = S.orch.get(r.id).nodes[0]
    ok('★节点 A 过退出检查 → verified(判据是磁盘产出与退出码,不是 todo 全勾)', nA2.state === 'verified', { state: nA2.state, report: nA2.result.exitReport })
    ok('★每个节点收官都问一次模型(反死板核心)', asked.some((x) => x.point === 'replan' && x.event === 'node-settled'), asked)

    // ── 第二片收官 → replan 说 done → 收口 ──
    const nB = S.orch.get(r.id).nodes[1]
    const regB = S.wfRegistry.get(String(nB.cardId))
    const wcB = world.wcById(regB.wcId)
    await world.cardInit(wcB, { shard: 1, title: '节点B' })
    await world.cardSend(wcB, '干活B')
    world.fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await waitFor(() => S.orch.get(r.id).phase === 'done', { name: 'run 没有收口', timeout: 6000 })
    const fin = S.orch.get(r.id)
    ok('replan 说 done → run 收口', fin.phase === 'done', fin.phase)
    ok('收口带成果摘要', !!(fin.result && fin.result.summary), fin.result)

    // ── 结构性守卫:旧引擎那套"全局账 + 一次性标志 + 中文唤醒"不许以任何形式回来 ──
    // (旧引擎已删,这几条现在是防倒退的哨兵:哪天有人为了图快又加一个全局 Map 或一次性标志,这里会红)
    for (const acct of ['verifyOpen', 'verifyRounds', 'orchVerifyRetry', 'orchVerifyDone', 'orchIndexNudgeArmed', 'orchProgressAt']) {
      ok('★没有全局账 S.' + acct + '(编排状态只住 run 对象)', !(S[acct] && S[acct].size), S[acct] && [...S[acct].keys()])
    }
    ok('★没有任何 reg 带一次性标志 orchNotified(幂等靠状态守卫,不靠标志位)',
      ![...S.wfRegistry.values()].some((x) => x.orchNotified !== undefined),
      [...S.wfRegistry.values()].filter((x) => x.orchNotified !== undefined).map((x) => x.id))
    ok('★面板卡从头到尾没收到中文唤醒消息(编排不是跟 Agent 聊天)', world.injects(fin.panelWcId).length === 0, world.injects(fin.panelWcId).map((i) => i.p && i.p.disp))

    // ── 落盘:重启续接的前提 ──
    S.orch.__journal.flush(r.id)
    const saved = S.orch.__journal.load(r.id)
    ok('run 已落盘(重启续接的前提)', !!(saved && saved.id === r.id && saved.nodes.length === 2), saved && saved.phase)
    ok('落盘里有决策留痕(用户能看它为什么这么决定)', Array.isArray(saved.decisions) && saved.decisions.length >= 2, saved && saved.decisions && saved.decisions.length)
  },
}
