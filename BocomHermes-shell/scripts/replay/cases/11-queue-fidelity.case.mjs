// 用例⑪(改写):全局队列条目保真 —— 与编排无关的通用能力。
//
// 旧版测的是"验证棒排队 → 出队按 goal 文本补登记 isVerify / parseWriteScope 恢复写归属",
// 那套"把状态编码进自然语言 goal 再 parse 回来"已随旧引擎删除(编排节点根本不进全局队列)。
// 留下来要守的是队列本身的通用契约:出队重走 spawnWorkflow、goal 一字不改、forceModel 随队列走。
// 跑法:node scripts/replay/run.mjs 11
import { ok, expectState } from '../harness.mjs'

export default {
  name: '⑪全局队列条目保真:goal 原样 + forceModel 随队列走 + 出队重走 spawnWorkflow',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 1 } },
  async run(world) {
    const S = world.S
    const GOAL_B = '工作流B:目标里带各种字符 —— 冒号、【括号】、换行\n第二行也要一字不差'
    const MODEL = { providerID: 'vision', modelID: 'vl-max', name: '读图模型' }

    const a = world.spawnWorkflow('工作流A:先占住唯一的并发位')
    ok('并发闸=1:A 直接开卡', !!(a && a.reg), a)

    // 排队项:goal 与 forceModel 都要原样存进队列
    const b = S.spawnWorkflowForTest
      ? S.spawnWorkflowForTest(GOAL_B, MODEL)
      : world.handlers['spawn-workflow']({ sender: { id: 0 } }, GOAL_B)
    ok('并发位满:B 进队列', !!(b && b.queued === true), b)
    expectState('队列里存的是【原始 goal】,一字未改', () => String(S.wfQueue[0].goal) === GOAL_B)

    // 手工把 forceModel 塞进队列项(生产里由派出方带,这里只验"出队时它没丢")
    S.wfQueue[0].forceModel = MODEL
    const qGoal = S.wfQueue[0].goal

    // 关掉 A → 出队补位
    const winA = world.windows().find((w) => w.webContents && w.webContents.id === a.reg.wcId)
    if (winA) winA.close()
    expectState('出队后队列清空', () => S.wfQueue.length === 0)

    const regB = [...S.wfRegistry.values()].find((r) => r.id !== a.reg.id && String(r.goal || '').includes('目标里带各种字符'))
    ok('★出队重走 spawnWorkflow:B 真的开出来了', !!regB, [...S.wfRegistry.values()].map((r) => String(r.goal).slice(0, 24)))
    ok('★forceModel 随队列走(不丢双模型口径)', !!(regB && regB.model && regB.model.modelID === 'vl-max'), regB && regB.model)
    ok('goal 原样进卡(换行与全角括号都在)', String(regB.goal).includes('第二行也要一字不差'), String(regB.goal).slice(0, 60))
    ok('出队日志留痕', world.logs.some((l) => l.includes('workflow dequeued')), world.logs.filter((l) => l.includes('dequeue')).slice(0, 3))
    ok('队列项不带编排身份(编排节点根本不进全局队列)', !regB.runId && !regB.nodeId, { runId: regB.runId, nodeId: regB.nodeId })
  },
}
