// 用例③(已修真实 bug 的回归):分片回合报错经 wfTurnError 起 interrupted 落定兜底。
// 链路:分片 card-send → serve 500 → sendMessage 探针确认未落 → 原错上抛 → session.js catch 调 wfTurnError →
//   armShardSettle(interrupted) 起 45s 兜底 → 补判 interrupted → shardSettled 唤醒主控(分母含排队片)→ wfDequeue 补位。
// 断言点:card-send 抛错;报错后仍 running(等兜底);45s 计时器在挂;落定后 status==='interrupted';
//   主控唤醒文案「已中断 (1/2)」;wfQueue 出队清空;分片B 被 wfDequeue 补位开出(挂 parentOrch);
//   请求轨迹(POST 500 → GET 探针)。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 03)
import { ok, expectSeq, expectState } from '../harness.mjs'

export default {
  name: '③分片回合报错 → wfTurnError 起 interrupted 落定 → 唤醒主控(分母含排队片) + wfDequeue 补位',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 1 } },   // 并发位压成 1:分片B 必进队列,才能断言"收官即腾位补位"
  transcript: '03-shard-error-interrupted.jsonl',
  async run(world) {
    const orch = world.spawnOrchestrator('双层拆分:认证 + 权限')
    world.approvePlan(orch.wcId)
    const a = world.spawnWorkflow('[orch:' + orch.tag + '] 分片A:勘察认证模块')
    ok('并发闸=1:分片A 直接开卡', !!(a && a.reg), a)
    const b = world.spawnWorkflow('[orch:' + orch.tag + '] 分片B:勘察权限模块')
    ok('并发位占满:分片B 进内存队列(position 1)', !!(b && b.queued === true && b.position === 1), b)
    ok('排队也刷主控进度面板(queued 态可见)', world.shardProgress(orch.wcId).some((s) => (s.p.shards || []).some((x) => x.status === 'queued')))

    // 分片A 建会话后发消息 → fake serve 500 → card-send 抛错 → wfTurnError 起 interrupted 落定
    await world.cardInit(a.wc, { shard: 1, title: '分片A' })
    let sendErr = null
    try { await world.cardSend(a.wc, '【总目标】分片A:勘察认证模块') } catch (e) { sendErr = e }
    ok('card-send 抛错(500 原文上抛,不翻译不吞)', !!sendErr && /500/.test(sendErr.message), sendErr && sendErr.message)
    expectState('回合报错后仍 running(等 45s 落定兜底)', () => a.reg.status === 'running')
    expectState('interrupted 落定兜底计时器已挂上', () => world.pendingTimers().some((t) => t.ms === 45000))

    world.fireTimer(45000)
    expectState('落定兜底:status 补判 interrupted', () => a.reg.status === 'interrupted')
    const injects = world.injects(orch.wcId)
    ok('主控收到唤醒:「已中断 (1/2)」(分母含排队片)', injects.some((i) => (i.p.text || '').includes('已中断 (1/2)') && (i.p.disp || '').includes('分片 1/2')), injects.map((i) => i.p && i.p.disp))
    expectState('收官即腾位:wfQueue 已出队清空', () => world.S.wfQueue.length === 0)
    const regB = [...world.S.wfRegistry.values()].find((r) => r.parentOrch === orch.tag && r.id !== a.reg.id)
    ok('wfDequeue 补位:分片B 已开卡并挂 parentOrch(status running)', !!regB && regB.parentOrch === orch.tag && regB.status === 'running', regB && { id: regB.id, status: regB.status })
    ok('出队日志留痕(workflow dequeued)', world.logs.some((l) => l.includes('workflow dequeued')))

    // 请求轨迹:POST message 500 → GET message(sendMessage 的 R4 探针 lastUserMatches,探不到才上抛)
    expectSeq('报错路径请求轨迹(POST 500 → GET 探针)', world.fake.requests, [
      { method: 'POST', path: '/session' },
      { method: 'POST', path: /^\/session\/ses_[^/]+\/message$/ },
      { method: 'GET', path: /^\/session\/ses_[^/]+\/message$/ },
    ])
  },
}
