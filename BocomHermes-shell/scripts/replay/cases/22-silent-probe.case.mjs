// 用例㉒:静默到点探活(慢端点不错杀)+ orchSilentSec 旋钮生效。
//
// 病灶(内网实测推断链):轮末静默 45s 一到就 settle → evalExit 按空磁盘判 artifacts/noEmpty 零产出 →
// zero-output 属 HARD_FAIL 不给补做 → attempt++ 开新卡 —— 可慢端点的工人只是【卡在启动 /
// 回合还在网关排队 / 晚答还在落】,活干到一半被错杀,已做的产出全废。
// 修法:doArm 到点先探活(silentAlive),活着就续命一轮;窗口经 knobs.orchSilentSec 可调。
//
// 跑法:node scripts/replay/run.mjs 22
import { ok, waitFor, fireTimer, pendingTimers, sleep } from '../harness.mjs'

export default {
  name: '㉒静默探活:启动中/在飞/内容在动续命,真静才落定 + orchSilentSec 旋钮',
  mode: 'manual',
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    S.orchDecide = async (point) => {
      if (point === 'plan') {
        return { ok: true, data: {
          needGrounding: false, more: 'unknown', why: '一片就够',
          nodes: [{ id: 'a', kind: 'work', title: '慢工', goal: '干活', deps: [],
            writeScope: ['src/a'], contract: [], artifacts: [],
            requireEvidence: false, requireVerdict: false, verifyCmd: '' }],
        } }
      }
      return { ok: true, data: { addNodes: [], dropNodes: [], done: false, more: 'unknown', why: '接着等' } }
    }

    const r = S.orch.createRun('静默探活测试', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地' })
    S.orch.approve(r.id)
    const n0 = () => S.orch.get(r.id).nodes[0]
    await waitFor(() => n0().state === 'running' && n0().cardId, { name: '节点没派出去' })

    // ① 卡在启动(有卡还没绑会话)= 慢 serve 冷启动形态:到点只许续命,不许落定
    fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await sleep(50)
    ok('★卡在启动:45s 到点不落定(修之前 settled→零产出→attempt++)',
      n0().state === 'running' && n0().attempt === 0, n0().state + '/a' + n0().attempt)
    ok('续命计时已重挂(仍是 45s 档)', pendingTimers().some((t) => t.ms === 45000), pendingTimers())

    // ② 会话绑上且有回合在飞 = 网关排队/prefill 慢形态:同样续命
    const wcId = n0().wcId
    S.sessionByWc.set(wcId, 'ses_probe')
    S.turnBusy.add('ses_probe')
    fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await sleep(50)
    ok('★turnBusy 在飞:到点不落定', n0().state === 'running' && n0().attempt === 0, n0().state + '/a' + n0().attempt)
    S.turnBusy.delete('ses_probe')

    // ③ 旋钮生效:orchSilentSec=120 后,续命计时按 120s 档重挂
    S.settings.knobs.orchSilentSec = 120
    // 内容在挂计时 5s 后还在写(未来时戳)= turn end 判早了/晚答还在落;回放墙钟不走,用未来时戳确定性模拟
    S.sessionInfo.set('ses_probe', { lastEventAt: Date.now() + 5000 })
    fireTimer((t) => t.ms === 45000 && t.type === 'timeout')
    await sleep(50)
    ok('★内容在动:到点不落定', n0().state === 'running' && n0().attempt === 0, n0().state + '/a' + n0().attempt)
    ok('★knob=120 后续命按 120s 重挂', pendingTimers().some((t) => t.ms === 120000), pendingTimers())

    // ④ 真静了(不在飞、内容静止超窗):照常落定判罚 —— 探活不赦免真零产出
    S.sessionInfo.get('ses_probe').lastEventAt = Date.now() - 10 * 60 * 1000
    fireTimer((t) => t.ms === 120000 && t.type === 'timeout')
    await waitFor(() => n0().attempt >= 1, { name: '真静后没落定判罚' })
    ok('★真静了照常落定:零产出 attempt++(探活不赦免真零产出)', n0().attempt >= 1, n0().state + '/a' + n0().attempt)
  },
}
