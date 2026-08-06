// 用例㉕:零产出回填的 sid 解析 —— 那道"最后责任点"真机上一次都没跑过。
//
// 背景:4243cb5 加了 backfillFinal —— evalExit 判零产出【之前】回 serve 拉一次会话原文,
// 拉到就回填,不冤枉慢模型。声称修好了内网的 "zero-output 误报"。
//
// 病灶:它的第一行是 `if (!n.sid || ...) return ''`,而 n.sid 在生产里【恒为 null】——
// 唯一能写它的事件是 NODE_DISPATCHED,而它的唯一生产发射点 doDispatch 只带 {nodeId, cardId, wcId},
// 没有 sid(派卡那一刻卡还没绑会话)。只有 orch-selftest 手写事件时才会带,所以单测一直是绿的。
// 净效果:这道闸真机上从没执行过,4243cb5 声称修好的东西实际从未生效。
//
// 隔壁 silentAlive 早就发现了同一件事并从 S.sessionByWc(wcId → sid)补上,
// 但【只补了它自己那一处】—— 又是"同一件事两份账本、其中一份是空的"。
// 现在收敛成 sidOf(n) 一份。
//
// 本用例走真 window.js + 真 orch,只把 oc.getMessages 换成可观测的桩:
// 只要 backfillFinal 真的跑了,它必然会拿【正确的 sid】去调 getMessages。
//
// 跑法:node scripts/replay/run.mjs 25
import { ok, waitFor, fireTimer } from '../harness.mjs'

export default {
  name: '㉕零产出回填:sid 从 wcId 现解(n.sid 生产恒 null)',
  mode: 'manual',
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    const asked = []                       // backfillFinal 拿什么 sid 去 serve 拉原文
    const orig = world.oc.getMessages
    world.oc.getMessages = async (serve, sid) => { asked.push(String(sid || '')); return [] }

    // 派一个节点:模型只给一片,它落盘什么都不写 → 收官时必然走到"判零产出"这一步
    S.orchDecide = async (point) => {
      if (point === 'plan') {
        return { ok: true, data: { needGrounding: false, more: 'no', why: '一片',
          nodes: [{ title: '甲', goal: '干活', kind: 'work', deps: [],
            writeScope: ['src/a.ts'], contract: [], artifacts: [],
            requireEvidence: false, requireVerdict: false, verifyCmd: '' }] } }
      }
      return { ok: true, data: { addNodes: [], dropNodes: [], done: true, final: { summary: '完', deliverables: [], gaps: [] } } }
    }

    const r = await world.relayPost('/orch/run-orch', { goal: '探索并成文:随便查点什么' })
    ok('run 起来了', !!(r && r.ok), r)
    if (!r || !r.ok) { world.oc.getMessages = orig; return }

    S.orch.approve(r.runId)                // 过规划闸,让它真派卡
    const node = await waitFor(() => {
      const run = S.orch.get(r.runId)
      const n = run && (run.nodes || [])[0]
      return n && n.wcId != null ? n : null
    }, 8000, '节点派出并绑上 wcId')
    ok('节点派出来了,拿到 wcId', !!node && node.wcId != null, node && { id: node.id, wcId: node.wcId, sid: node.sid })
    if (!node) { world.oc.getMessages = orig; return }
    // 工人卡的会话是渲染端 card-init 时才建的(真机同理)—— 建完 S.sessionByWc 才有这一格
    const wc = world.wcById(node.wcId)
    if (wc) await world.cardInit(wc, { title: '甲' })

    // ★这就是病灶的现场:事件里从来没带过 sid,所以 n.sid 恒 null;
    //   真正知道会话号的是 S.sessionByWc(card-init 建完会话才写)。
    ok('★n.sid 确实是空的(生产恒 null —— 这正是那道闸失效的原因)', !node.sid, node.sid)
    const realSid = S.sessionByWc && S.sessionByWc.get(node.wcId)
    ok('  而 S.sessionByWc 里有真的会话号', !!realSid, realSid)

    // 让它走完一轮(终答为空)→ 静默落定 → evalExit → 判零产出前应当先回填
    fireTimer((t) => t.ms === 45000 && t.type === 'timeout')   // 45s 静默 → 落定 → evalExit → 判零产出前先回填
    await waitFor(() => asked.length > 0, 8000, 'backfillFinal 真的去 serve 拉了原文').catch(() => null)

    ok('★回填真的执行了(修前:n.sid 恒 null → 第一行就 return,一次都没跑过)', asked.length > 0, asked)
    if (asked.length) {
      ok('★而且用的是从 wcId 现解出来的真 sid', asked.includes(String(realSid)), { asked, realSid })
    }
    world.oc.getMessages = orig
  },
}
