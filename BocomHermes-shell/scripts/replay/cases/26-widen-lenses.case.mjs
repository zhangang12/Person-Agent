// 用例㉖:★宽度归代码 —— 模型拆不宽,壳层自己按视角铺齐(走真装配路径)
//
// 【病灶】用户实测反复报"拆的分片 Agent 不够多"。查下来是五条独立成因叠在一起,其中最根本的一条:
// 全仓的形状兜底里,汇总节点代码自己造、验收节点自己造、按发现扇出也是代码自己造 ——
// 【唯独宽度只会"再问模型一次"】,问完还是窄就认了。而 CC 那种宽度恰恰是脚本里写死的数组:
// 模型没有"要不要拆"的投票权,只负责填每片内容。弱模型在"多拆一点"上永远倾向少拆,劝不动。
//
// 另外四条(都在 orch-selftest 6r 里逐条钉住,这里只验最终效果):
//   ① 宽度目标写的是 run.concurrency —— 用户 settings.json 里持久化成 4,再大的目标也只要求 4 片;
//   ② 宽度强制被目标措辞把门(白名单关键词),没命中就【整条静默不触发】;
//   ③ 只重问一次,第二次还是窄就认;
//   ⑤ 只在 plan 判一次,replan(尤其勘察跑完那次)完全不管宽度。
//
// 【本用例为什么必须走 replay 而不是只在 orch-selftest 里测】
// 补出来的是【代码造的节点】,它必须能真的走完 validateNodeSpecs → doDispatch → 起一张真工人卡。
// 状态机自测只证明"图里多了几个节点";派不出去的话,面板上仍然只有两片在跑 —— 用户看到的还是"不够多"。
// 单测绿而真机不动,这个仓已经踩过一次(backfillFinal 那道闸 n.sid 恒 null,一次都没执行过)。
//
// 跑法:node scripts/replay/run.mjs 26
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '㉖拆不宽:壳层按视角补齐并真的派出去',
  mode: 'manual',
  settings: { knobs: { wfConcurrency: 4 } },   // ★并发压在 4:宽度不该再跟着这个数走
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch) return

    // 决策桩:plan 【始终】只给一片(模拟弱模型 —— 重问一次也照旧);replan 一律不加节点
    const points = []
    S.orchDecide = async (point, ctx) => {
      points.push(point + (ctx && ctx.event ? ':' + ctx.event : ''))
      if (point === 'plan') {
        return { ok: true, data: {
          needGrounding: false, more: 'no', why: '一片够了',
          nodes: [{ title: '整体排查', goal: '把所有表单从头到尾查一遍', kind: 'work', deps: [],
            writeScope: ['docs/all.md'], contract: [], artifacts: ['docs/all.md'],
            requireEvidence: false, requireVerdict: false, verifyCmd: '' }],
        } }
      }
      return { ok: true, data: { addNodes: [], dropNodes: [], done: false, facts: [], open: [], why: '再看看' } }
    }

    // 目标措辞刻意【不含】原白名单里的任何词("排查"在,但走的是新分类器;关键是并发只有 4)
    const r = S.orch.createRun('看看全站表单有什么问题', {})
    ok('run 起来了', !!(r && r.id), r)
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    const run1 = S.orch.get(r.id)

    // 只给一片 → 先重问一次(这一档确实值得为它多烧一轮:给 0~1 片说明它根本没在拆)
    ok('★只给 1 片 → 壳层重问了一次', points.filter((p) => p.indexOf('plan') === 0).length >= 2, points)

    const lens = run1.nodes.filter((n) => n.lensKey)
    ok('★重问后仍只给 1 片 → 代码自己按视角补齐(修前:第二次还是窄就认了)', lens.length >= 3,
      run1.nodes.map((n) => n.kind + '/' + n.origin + '/' + (n.lensKey || '-')))
    ok('  补出来的片 origin 记 shape(面板看得出是代码补的,不冒充模型的方案)',
      lens.every((n) => n.origin === 'shape'))

    // ①的直接证据:并发是 4,而宽度到了 6 —— 两个数脱钩了
    const heads = run1.nodes.filter((n) => n.kind !== 'reduce' && n.kind !== 'verify' && !n.deps.length)
    ok('★能同时开跑的片数 > 并发旋钮(宽度是任务的属性,并发只管派发节奏)',
      heads.length > 4, { heads: heads.length, concurrency: run1.concurrency })

    // 写归属两两不交,否则会被 validateNodeSpecs 自己挡回去(补宽等于没补)
    const scopes = lens.map((n) => n.writeScope.join('|'))
    ok('  每片各写各的文件(写归属两两不交)', new Set(scopes).size === scopes.length && scopes.every(Boolean), scopes)

    // 汇总必须把补出来的片全挂上,否则那几份文档没人读
    const red = run1.nodes.find((n) => n.kind === 'reduce')
    ok('★补出来的片全部进了汇总 deps(顺序反了这里会漏掉它们)',
      !!red && lens.every((n) => red.deps.indexOf(n.id) >= 0), red && { deps: red.deps, lens: lens.map((n) => n.id) })

    // ── 关键:补出来的节点要真的派得出去(状态机里多几个节点 ≠ 面板上多几片在跑)──
    S.orch.approve(r.id)
    const run2 = S.orch.get(r.id)
    const live = run2.nodes.filter((n) => n.state === 'running' || n.state === 'queued')
    ok('★批准后补出来的片真的被派了(不是只躺在图里)',
      lens.every((n) => {
        const cur = run2.nodes.find((x) => x.id === n.id)
        return cur && (cur.state === 'running' || cur.state === 'queued')
      }), run2.nodes.map((n) => n.id + ':' + n.state))
    ok('  并发闸照常生效:同时 running 的不超过旋钮',
      run2.nodes.filter((n) => n.state === 'running').length <= 4,
      run2.nodes.filter((n) => n.state === 'running').length)
    ok('  其余排队等位(队列在,所以宽度可以大于并发)', live.length > run2.nodes.filter((n) => n.state === 'running').length, live.length)

    const one = run2.nodes.find((n) => n.lensKey && n.cardId)
    ok('★补出来的片绑到了真工人卡', !!one, lens.map((n) => n.id + ':' + n.cardId))
    if (one) {
      const reg = S.wfRegistry.get(String(one.cardId))
      ok('  是隐藏分片卡(复用整套 shard 语义:自动放行/拒答提问/不打扰用户)',
        !!(reg && S.shardWc && S.shardWc.has(reg.wcId)), reg && reg.wcId)
      ok('  写归属结构化下发(代码造的节点走同一条下发路径)',
        !!(reg && Array.isArray(reg.writeScope) && reg.writeScope.length === 1), reg && reg.writeScope)
      ok('★下发正文里写清了"你只负责这一个面"(否则六片会各写各的全景,重复六遍)',
        /只看这一个面/.test(String(one.goal || '')) && /不要因为/.test(String(one.goal || '')),
        String(one.goal || '').slice(0, 120))
    }
  },
}
