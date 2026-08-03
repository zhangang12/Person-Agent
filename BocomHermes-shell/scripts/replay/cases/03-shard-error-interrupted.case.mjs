// 用例③:【单工作流】的并发队列与回合报错上抛 —— 与编排无关的通用能力,所以旧引擎删了它照样得守。
// 链路:并发闸=1 → 工作流A 开卡、工作流B 进队列 → A 的 card-send 撞 serve 500 → sendMessage 探针确认未落 →
//   原错上抛(不翻译不吞)→ 关卡收官腾位 → wfDequeue 把 B 补位开出。
// 断言点:queued position;500 原文上抛;请求轨迹(POST 500 → GET 探针);出队补位与日志留痕。
// 跑法:node scripts/replay/run.mjs 03
import { ok, expectSeq, expectState } from '../harness.mjs'

export default {
  name: '③单工作流:并发队列 + 回合报错原文上抛 + 出队补位',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 1 } },   // 并发位压成 1:分片B 必进队列,才能断言"收官即腾位补位"
  transcript: '03-shard-error-interrupted.jsonl',
  async run(world) {
    const a = world.spawnWorkflow('工作流A:勘察认证模块')
    ok('并发闸=1:工作流A 直接开卡', !!(a && a.reg), a)
    const b = world.spawnWorkflow('工作流B:勘察权限模块')
    ok('并发位占满:工作流B 进内存队列(position 1)', !!(b && b.queued === true && b.position === 1), b)

    // 分片A 建会话后发消息 → fake serve 500 → card-send 抛错 → wfTurnError 起 interrupted 落定
    await world.cardInit(a.wc, { title: '工作流A' })
    let sendErr = null
    try { await world.cardSend(a.wc, '【总目标】工作流A:勘察认证模块') } catch (e) { sendErr = e }
    ok('card-send 抛错(500 原文上抛,不翻译不吞)', !!sendErr && /500/.test(sendErr.message), sendErr && sendErr.message)
    expectState('回合报错后仍 running(单工作流没有无人值守落定,等用户处置)', () => a.reg.status === 'running')

    // 关掉 A 的卡 = 收官腾位 → B 补位(出队触发点②)
    const winA = world.windows().find((w) => w.webContents && w.webContents.id === a.reg.wcId)
    if (winA) winA.close()
    expectState('关卡即腾位:wfQueue 已出队清空', () => world.S.wfQueue.length === 0)
    const regB = [...world.S.wfRegistry.values()].find((r) => r.id !== a.reg.id && /工作流B/.test(String(r.goal || '')))
    ok('wfDequeue 补位:工作流B 已开卡', !!regB && regB.status === 'running', regB && { id: regB.id, status: regB.status })
    ok('出队日志留痕(workflow dequeued)', world.logs.some((l) => l.includes('workflow dequeued')))

    // 请求轨迹:POST message 500 → GET message(sendMessage 的 R4 探针 lastUserMatches,探不到才上抛)
    expectSeq('报错路径请求轨迹(POST 500 → GET 探针)', world.fake.requests, [
      { method: 'POST', path: '/session' },
      { method: 'POST', path: /^\/session\/ses_[^/]+\/message$/ },
      { method: 'GET', path: /^\/session\/ses_[^/]+\/message$/ },
    ])
  },
}
