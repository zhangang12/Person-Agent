// 用例㉚:★挂死计时也要过活探针 —— 长回合被判成"死"(2026-08-08 真机)
//
// 【病灶】真机上 7 片工人里有 4 片在第 15 分钟【整】被挂死计时杀掉。
// 它们正处在同一个长回合里:内网读大仓,一个回合内几十次工具调用,turnBusy 明确说有回合在飞,
// 而挂死计时的判据是"15 分钟内没有新的【回合边界】"—— 长回合根本不产生新回合边界。
// 于是"慢"被判成了"死":4 片带着 998/923/170/98 字的半成品被杀,再重派、再从零读一遍。
//
// 活探针(silentAlive:turnBusy / 卡片忙 / 内容签名在动)早就写好了,却【只挂在静默计时上】——
// doArm 里那句 `if (kind === 'silent')` 就是分水岭。又是"同一件事只做了一半"。
//
// 【为什么不干脆调大 STALL_MS】调大只是把误杀推后,真挂死的也一起等更久。
// 有上限的续命才两头都对:活着就接着跑,真僵死最多 4 轮就收。
//
// 跑法:node scripts/replay/run.mjs 30
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '㉚挂死计时:工人还活着就续命(有上限),真僵死照旧收',
  mode: 'manual',
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    S.orchDecide = async (point) => point === 'plan'
      ? { ok: true, data: { needGrounding: false, more: 'no', why: '一片',
        nodes: [{ title: '干活', goal: '读大仓', kind: 'work', deps: [], writeScope: ['src/a'],
          contract: [], artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' }] } }
      : { ok: true, data: { addNodes: [], dropNodes: [], done: false, facts: [], open: [], why: '继续' } }

    const r = S.orch.createRun('重构订单模块的下单流程', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.approve(r.id)
    const node = S.orch.get(r.id).nodes[0]
    ok('节点派出去了', !!node && node.state === 'running', node && node.state)
    if (!node) return

    const reg = S.wfRegistry.get(String(node.cardId))
    const wc = world.wcById(reg.wcId)
    await world.cardInit(wc, { shard: 1, title: '干活' })

    const STALL = 15 * 60 * 1000
    const nodeNow = () => S.orch.get(r.id).nodes[0]
    const fireStall = () => world.fireTimer((t) => t.ms === STALL && t.type === 'timeout')

    // ── ① 工人明确"有回合在飞" → 挂死到点也不许杀 ──
    const sid = S.sessionByWc && S.sessionByWc.get(reg.wcId)
    ok('拿到工人会话 id(活探针要靠它)', !!sid, sid)
    S.turnBusy = S.turnBusy || new Set()
    S.turnBusy.add(sid)                       // 模拟:一个长回合正在飞(真机就是这个状态)

    ok('(诊断)挂死计时确实注册了', fireStall() === 1)
    await new Promise((res) => setTimeout(res, 60))
    // ★判据看 reason/attempt,不看 state ——被判挂死之后节点会【重派回 running】,
    //   只盯 state 的话杀与没杀长得一模一样(第一版断言就是这么写错的)。
    ok('★挂死到点但有回合在飞 → 不判挂死(修前:第 15 分钟整被杀,半成品全丢)',
      nodeNow().reason !== 'stalled' && num(nodeNow().attempt) <= 1,
      { reason: nodeNow().reason, attempt: nodeNow().attempt })

    // ── ② 续命有上限:用满之后照旧判挂死(真僵死不能永远等) ──
    for (let i = 0; i < 5; i++) { fireStall(); await new Promise((res) => setTimeout(res, 50)) }
    ok('★续命用满 → 照旧判挂死(调大 STALL_MS 只是把误杀推后,有上限才两头都对)',
      nodeNow().reason === 'stalled' || num(nodeNow().attempt) > 1,
      { reason: nodeNow().reason, attempt: nodeNow().attempt, state: nodeNow().state })
    ok('  ★挂死不被闸门结论覆写成 artifact-missing(落定原因 ≠ 盘上有什么)',
      nodeNow().reason !== 'artifact-missing', nodeNow().reason)
    ok('  ★也没白烧补做(卡已经被杀了,注进去没人看)', num(nodeNow().patches) === 0, nodeNow().patches)
  },
}

function num(x) { const n = +x; return Number.isFinite(n) ? n : 0 }
