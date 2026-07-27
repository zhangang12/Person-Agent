// 用例⑦(M3 验证棒定型):前端分片无证据 → 集成验证棒目标文本含 CC 全量要素 + 只读沙箱 + 双模型覆盖。
// 断言点:goal 含 基线五步/分型动作链/对抗探针/FAIL 三查/PARTIAL 限制/测试套件不可全信/只读沙箱/浏览器验证;
//        验证棒 writeScope = [系统临时目录](只读沙箱);settings.modelVision 已配时验证棒整卡跑读图模型。
// 跑法:npm run replay:test(或 node scripts/replay/run.mjs 07)
import { ok, expectState, waitFor } from '../harness.mjs'
import os from 'os'

export default {
  name: '⑦验证棒 M3 定型:CC 全量要素进目标 + 只读沙箱 writeScope=/tmp + 双模型整卡读图模型',
  mode: 'manual',
  transcript: '07-verify-goal-m3.jsonl',
  async run(world) {
    world.S.settings.modelVision = { providerID: 'p1', modelID: 'vision-1', name: 'Vision 模型' }
    const orch = world.spawnOrchestrator('编码:登录页实现')
    world.approvePlan(orch.wcId)
    const a = world.spawnWorkflow('[orch:' + orch.tag + '] 分片A:实现登录页\n写归属: src/ui/Login.vue')
    await world.cardInit(a.wc, { shard: 1, title: '分片A' })
    ok('transcript 推 todowrite(全勾)', world.fake.pushNextSse())
    await waitFor(() => a.reg.todos && a.reg.todos.length === 1, { name: 'wfTodos 未落地' })
    ok('transcript 推 bash(echo,非验证)', world.fake.pushNextSse())

    await world.cardSend(a.wc, '实现登录页')
    expectState('分片无证据:unverified 置位', () => a.reg.unverified === true)
    const v = [...world.S.wfRegistry.values()].find((r) => /集成验证/.test(String(r.goal || '')) && r.parentOrch === orch.tag)
    ok('壳层自动补派集成验证棒', !!v, [...world.S.wfRegistry.values()].map((r) => r.goal && r.goal.slice(0, 40)))
    const g = (v && v.goal) || ''
    for (const kw of ['基线五步', '分型动作链', '对抗探针', 'FAIL 三查', 'PARTIAL 仅限环境限制', '测试套件不可全信', '只读沙箱', '浏览器验证', 'Command run']) {
      ok('验证棒 goal 含「' + kw + '」', g.includes(kw))
    }
    expectState('验证棒只读沙箱:writeScope = [系统临时目录]', () => Array.isArray(v.writeScope) && v.writeScope.length === 1 && v.writeScope[0] === os.tmpdir().replace(/\\/g, '/'))
    ok('双模型:验证棒整卡跑读图模型(modelVision)', v.model && v.model.modelID === 'vision-1', v.model)
  },
}
