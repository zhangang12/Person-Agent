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

    // ── ① 长回合【内容一直在动】→ 挂死到点也不许杀 ──
    // ★2026-08-08 第二次改:第一版只往 turnBusy 里塞了个 sid 就当"活着",而㉚ 描述的现场是
    //   "内网读大仓,一个回合内几十次工具调用" —— 那种片 lastEventAt 是【一直在动】的。
    //   只模拟 turnBusy 等于测了一个和㉚ 无关的场景,还正好把"冻住"一并放过(见下面 ②)。
    const sid = S.sessionByWc && S.sessionByWc.get(reg.wcId)
    ok('拿到工人会话 id(活探针要靠它)', !!sid, sid)
    S.turnBusy = S.turnBusy || new Set()
    S.turnBusy.add(sid)                       // 回合在飞
    const si = S.sessionInfo && S.sessionInfo.get(sid)
    ok('拿到会话册(内容签名要写在这)', !!si)
    // 内容签名往前推:真实判据是"挂计时之后还在写"(last > armedAt + 2000),而本用例 60ms 就跑完,
    // 等不出真的 2 秒 —— 用未来时间戳代表"这一轮之后内容又动过",语义等价。
    const moving = () => { if (si) si.lastEventAt = Date.now() + 5000 }
    moving()

    ok('(诊断)挂死计时确实注册了', fireStall() === 1)
    await new Promise((res) => setTimeout(res, 60))
    // ★判据看 reason/attempt,不看 state ——被判挂死之后节点会【重派回 running】,
    //   只盯 state 的话杀与没杀长得一模一样(第一版断言就是这么写错的)。
    ok('★挂死到点但内容还在动 → 不判挂死(修前:第 15 分钟整被杀,半成品全丢)',
      nodeNow().reason !== 'stalled' && num(nodeNow().attempt) <= 1,
      { reason: nodeNow().reason, attempt: nodeNow().attempt })

    // ── ②★回合开着但内容【一个字节都不动】= 冻住,不许当活着(2026-08-08 真机:12 片核实) ──
    // 现场:12 个核实会话在 serve 自己的 session.updated 里 25~28 分钟零变化,而 turnBusy 一路报
    // "有回合在飞" → 每片被续命到 3/3、拖满 60 分钟才收,收完各重做一次,重做又立刻撞同一面墙。
    // 病根是信号选错:turnBusy 起手入册、回合结束才移除,回合永不结束它就永远 true —— 它分不清
    // "在干活"和"冻住了"。挂死档必须只认内容真的动过(静默档秒级,盖住网关排队仍是对的)。
    if (si) si.lastEventAt = Date.now() - 60000   // 冻住:内容停在挂计时【之前】
    fireStall()
    await new Promise((res) => setTimeout(res, 60))
    ok('★★回合开着但内容不动 → 当场判挂死,不许续命到 60 分钟',
      nodeNow().reason === 'stalled' || num(nodeNow().attempt) > 1,
      { reason: nodeNow().reason, attempt: nodeNow().attempt })
    moving()                                   // 复原:下面 ③ 还要测"活着时续命有上限"

    // ── ③ 续命有上限:活着也不能永远等(用满之后照旧判挂死) ──
    for (let i = 0; i < 5; i++) { moving(); fireStall(); await new Promise((res) => setTimeout(res, 50)) }
    ok('★续命用满 → 照旧判挂死(调大 STALL_MS 只是把误杀推后,有上限才两头都对)',
      nodeNow().reason === 'stalled' || num(nodeNow().attempt) > 1,
      { reason: nodeNow().reason, attempt: nodeNow().attempt, state: nodeNow().state })
    ok('  ★挂死不被闸门结论覆写成 artifact-missing(落定原因 ≠ 盘上有什么)',
      nodeNow().reason !== 'artifact-missing', nodeNow().reason)
    ok('  ★也没白烧补做(卡已经被杀了,注进去没人看)', num(nodeNow().patches) === 0, nodeNow().patches)
  },
}

function num(x) { const n = +x; return Number.isFinite(n) ? n : 0 }
