// 用例㉜:★从历史重开编排 —— 存档要能按需读回内存
//
// 【现场】用户 2026-08-10:"动态工作流如果是历史会话的话,是没法续接工作流的"。
// 查下来是两处叠在一起:
//   ① wf-open 重开历史卡时【有意】按普通卡开(window.js 注释原文:"重开=回看全程+继续聊,
//      不复活规划闸/看门狗/交棒…要原样复活 wf 特性需重建注册表项,复杂度不值")。
//      这个取舍对普通工作流卡成立,对【编排面板卡】完全不成立:它"有会话但永不发消息",
//      当普通卡重开等于什么都没有 —— 没有节点表、没有留痕、没有续跑,而 runOfSender 靠 reg.runId 反查,
//      普通卡没这个字段,run-* 那一排 IPC 全部落空。
//   ② 就算认出是编排,run 也未必在内存里:restore() 只在【启动时】读【非终态】的。
//      已经 done/cancelled 的、以及启动之后才归档的,永远够不到 —— 面板打开就是空的。
//
// 本用例钉②(可在重放世界里逐例断言);①的存档头 runId 往返(写 `· run:<id>` / 解析回来)
// 目前只有代码走查,没有自动断言 —— 它跨 wf-list 的磁盘扫描,重放世界不覆盖那条路。
//
// 跑法:node scripts/replay/run.mjs 32
import { ok, waitFor } from '../harness.mjs'

export default {
  name: '㉜历史编排:终态存档也能按需读回内存(不然面板打开是空的)',
  mode: 'manual',
  async run(world) {
    const S = world.S
    ok('引擎已装配', !!S.orch)
    if (!S.orch || typeof S.orch.load !== 'function') { ok('★orch.load 存在(按需读回存档的入口)', false); return }

    S.orchDecide = async (point) => point === 'plan'
      ? { ok: true, data: { needGrounding: false, more: 'no', why: '一片',
        nodes: [{ title: '干活', goal: '读大仓', kind: 'work', deps: [], writeScope: ['src/a'], contract: [],
          artifacts: [], requireEvidence: false, requireVerdict: false, verifyCmd: '' }] } }
      : { ok: true, data: { addNodes: [], dropNodes: [], done: false, facts: [], open: [], why: '继续' } }

    const r = S.orch.createRun('分析仓库收货的所有逻辑', {})
    await waitFor(() => S.orch.get(r.id).phase === 'awaiting-approval', { name: 'plan 没落地', timeout: 8000 })
    S.orch.abort(r.id)          // 变成终态(cancelled)—— restore() 永远不会读它
    await waitFor(() => ['cancelled', 'done', 'failed'].indexOf(S.orch.get(r.id).phase) >= 0, { name: '没收掉', timeout: 8000 })
    const phaseWas = S.orch.get(r.id).phase

    ok('  已是终态(restore 按定义不会读它)', ['cancelled', 'done', 'failed'].indexOf(phaseWas) >= 0, phaseWas)

    // ★必须造一条【只在磁盘上、从没进过内存】的存档,才算真测到那条路。
    //   第一版我直接 load(r.id) —— 它命中的是内存里那份,抽掉读盘逻辑照样绿:断言是空的。
    //   (这正是今天反复踩的坑:被测的那条分支根本没被走到。)
    const onDisk = JSON.parse(JSON.stringify(S.orch.get(r.id)))
    onDisk.id = 'R-only-on-disk'
    S.orch.__journal.save(onDisk); S.orch.__journal.flush(onDisk.id)
    ok('  (前置)已造出一条只在磁盘上的存档', !!S.orch.__journal.load(onDisk.id))
    ok('  它确实不在内存里(不然下面又是空断言)', S.orch.get(onDisk.id) == null, S.orch.get(onDisk.id))

    const back = S.orch.load(onDisk.id)
    ok('★★只在磁盘上的终态存档能按需读回(修前:没有这个入口,面板打开就是空的)',
      !!back && back.id === onDisk.id, back && back.id)
    ok('  读回来【不改 phase】—— 它就是终态,只读回看,不许被顺手改成可跑',
      back && back.phase === phaseWas, back && back.phase)
    ok('  读回来之后 snapshot 拿得到(面板要靠它渲染节点表与留痕)',
      !!S.orch.snapshot(onDisk.id) && (S.orch.snapshot(onDisk.id).nodes || []).length >= 1,
      S.orch.snapshot(onDisk.id) && (S.orch.snapshot(onDisk.id).nodes || []).length)
    ok('  已在内存的直接返回同一个对象(不重复读盘、不覆盖运行时状态)', S.orch.load(onDisk.id) === back)
    ok('  不存在的 id 返回 null(不许凭空造一个空 run 出来)', S.orch.load('R-不存在') === null)
  },
}
