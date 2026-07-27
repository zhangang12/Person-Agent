// 用例①(已修真实 bug 的回归):分片 todo 没全勾时,45s 落定兜底判 done 并唤醒主控。
// 链路:分片轮末 wfTurnDone → todo 未全勾 status 仍 running → armShardSettle 起 45s 兜底 →
//   无新回合(没人再 card-send)→ 补判 done → shardSettled → 主控卡 card-inject「分片 N/M」唤醒 → wfDequeue。
// 断言点:轮末不误判 done;45s 计时器在挂;落定后 reg.status==='done';主控收到含「分片 1/1」「已完成 (1/1)」
//   的 card-inject;shard-progress 面板同步;fake serve 请求轨迹(建会话→发消息→收尾取消息)。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 01)
import { ok, expectSeq, expectState, waitFor } from '../harness.mjs'

export default {
  name: '①分片落定兜底:todo 未全勾 → 轮末仍 running → 45s 无新回合补判 done → 唤醒主控(N/M)',
  mode: 'manual',
  async run(world) {
    // 1) 主控卡 + 用户点【开始执行】(规划闸壳层状态位)
    const orch = world.spawnOrchestrator('摸透认证与权限两个模块')
    ok('主控卡登记:kind=orch 且规划闸初始未批', !!(orch.reg && orch.reg.kind === 'orch' && orch.reg.planApproved === false), orch.reg && { kind: orch.reg.kind, planApproved: orch.reg.planApproved })
    world.approvePlan(orch.wcId)
    expectState('wf-plan-approved 上报 → planApproved=true', () => orch.reg.planApproved === true)

    // 2) 主控派一个分片(goal 行首带 [orch:TAG])
    const shard = world.spawnWorkflow('[orch:' + orch.tag + '] 勘察认证模块入口与调用链')
    ok('分片登记:parentOrch 挂到主控 tag', !!(shard.reg && shard.reg.parentOrch === orch.tag), shard.reg && shard.reg.parentOrch)
    ok('分片是隐藏卡(spawnCard show:false)', !!(shard.wc && world.windows().find((w) => w.webContents === shard.wc).opts.show === false))

    // 3) 分片卡建会话(模拟隐藏窗加载后 card-init;生产路径同形,opts.shard 跳过进历史)
    const init = await world.cardInit(shard.wc, { shard: 1, title: '勘察认证模块' })
    ok('分片会话建成(fake serve 发证)', /^ses_/.test(init.sessionId), init.sessionId)
    expectState('分片会话登记进 shardSids(内部工人不进最近会话)', () => !!(world.S.shardSids && world.S.shardSids.has(init.sessionId)))

    // 4) SSE 推 todowrite(1 条 pending)→ onText → wfTodos 进注册表
    ok('transcript 有待推的 sse 行', world.fake.pushNextSse())
    await waitFor(() => shard.reg.todos && shard.reg.todos.length === 2, { name: 'wfTodos 未落地(SSE 链路断)' })
    ok('todowrite 经 SSE→onText→wfTodos 进注册表(含 1 条 pending)', shard.reg.todos.some((t) => /pending/.test(String(t.status))), shard.reg.todos)

    // 5) 分片跑一轮(POST 快速路径返终答)→ wfTurnDone:todo 未全勾 → 仍 running,起 45s 落定兜底
    await world.cardSend(shard.wc, '【总目标】勘察认证模块入口与调用链')
    expectState('轮末 todo 未全勾 → status 仍 running(不误判 done)', () => shard.reg.status === 'running')
    expectState('45s 落定兜底计时器已挂上', () => world.pendingTimers().some((t) => t.ms === 45000))

    // 6) 45s 无新回合 → 兜底补判 done → shardSettled 唤醒主控
    world.fireTimer(45000)
    expectState('落定兜底:status 补判 done', () => shard.reg.status === 'done')
    const injects = world.injects(orch.wcId)
    ok('主控收到 card-inject 唤醒(N/M)', injects.length >= 1, injects.map((i) => i.p && i.p.disp))
    ok('唤醒文案:disp 含「分片 1/1」', injects.some((i) => (i.p.disp || '').includes('分片 1/1')), injects.map((i) => i.p.disp))
    ok('唤醒文案:text 含「已完成 (1/1)」+ workflow_result 指引', injects.some((i) => (i.p.text || '').includes('已完成 (1/1)') && (i.p.text || '').includes('workflow_result')))
    ok('分片进度面板同步推送(shard-progress)', world.shardProgress(orch.wcId).length >= 1)

    // 7) 请求轨迹(子序列匹配,建会话→发消息→收尾取消息;探活/children/todo 等杂讯自动跳过)
    expectSeq('fake serve 请求轨迹(建会话→发消息→取消息)', world.fake.requests, [
      { method: 'POST', path: '/session' },
      { method: 'POST', path: /^\/session\/ses_[^/]+\/message$/ },
      { method: 'GET', path: /^\/session\/ses_[^/]+\/message$/ },
    ])
  },
}
