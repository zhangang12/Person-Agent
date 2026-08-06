// 用例㉔:两个工作流同时跑,工作目录与系统提示词会串台。
//
// 内网实测原话:"两个工作流同时启动会混着用项目路径和提示词"。
//
// 病灶:spawnWorkflow 里 `const dir = S.settings.projectDir || ''` —— 无条件读【全局当前值】,
// 完全无视发起方是哪个 run。而 run.dir 是 createRun 时的快照(每个 run 各一份)。
// 这个 dir 有两个去处,所以串台是"双份"的:
//   ① workflowSystemPrompt(dir, backendDir) —— 烤进系统提示词,工人以为自己在另一个项目里;
//   ② S.cardDir(卡级工作目录)—— session.js 建会话时按它取 dir,工人【真的】在另一个目录里干活。
// 两处同源(都读那一个 dir 变量),所以下面钉 ① 的间接产物 S.cardDir 就等于把两处一起钉住。
//
// ★时序很要紧:必须造出"全局目录已经被切走、而这个 run 还在派它自己的节点"这一刻。
//   写成"切一次全局、派一张卡"的话,全局值恰好等于该 run 的目录,有 bug 也测不出来
//   (本用例第一版就是这么写的,回退验红时纹丝不动)。
//
// 跑法:node scripts/replay/run.mjs 24
import { ok } from '../harness.mjs'

export default {
  name: '㉔双工作流不串台:目录与系统提示词各跟各的 run',
  mode: 'manual',
  async run(world) {
    const S = world.S
    const A = S.settings.projectDir                 // run A 的目录
    const B = A + '-另一个项目'                      // run B 的目录

    const spawn = (tag, runId, dir, node) =>
      world.spawnWorkflow(tag, null, { runId, nodeId: node, title: tag, dir, writeScope: [], contract: [] })
    const dirOf = (r) => String((r && S.cardDir && S.cardDir.get(r.wcId)) || '')

    // ① run A 派第一个节点(此刻全局目录 = A,巧合成立,测不出问题)
    const a1 = spawn('甲-1', 'RA', A, 'n1')
    ok('甲的第一个节点开出来了', !!(a1 && a1.id != null), a1)

    // ② 另一个工作流起来了 / 或用户切了项目 —— 全局目录变成 B
    S.settings.projectDir = B
    const b1 = spawn('乙-1', 'RB', B, 'n1')

    // ③ ★关键:run A 现在派它的【第二个】节点。它的 run.dir 仍然是 A,
    //    但全局已经是 B —— 读全局的实现会在这里把甲的工人扔进乙的目录。
    const a2 = spawn('甲-2', 'RA', A, 'n2')
    ok('甲的第二个节点开出来了', !!(a2 && a2.id != null), a2)
    if (!a1 || a1.id == null || !a2 || a2.id == null || !b1 || b1.id == null) return

    ok('★全局已切到乙之后,甲的新节点仍然落在甲的目录(读全局的实现在这里会拿到乙的目录)',
      dirOf(a2) === A, { got: dirOf(a2), want: A, 全局: S.settings.projectDir })
    ok('  甲的两个节点目录一致(同一个 run 内部不能自己跟自己串)', dirOf(a1) === dirOf(a2), { n1: dirOf(a1), n2: dirOf(a2) })
    ok('  乙的节点落在乙的目录', dirOf(b1) === B, { got: dirOf(b1), want: B })
    ok('★甲乙两个 run 的目录互不相同(串台时它们会一样)', dirOf(a2) !== dirOf(b1), { 甲: dirOf(a2), 乙: dirOf(b1) })

    // 反向:不带 dir 的独立工作流卡(没有 run)照旧用全局当前值 —— 别把这条路径一起改坏了
    const solo = world.spawnWorkflow('独立工作流(无 run)')
    ok('独立工作流卡仍按全局当前目录(没有 run 就该用当前值)',
      !solo || solo.id == null || dirOf(solo) === '' || dirOf(solo) === B, { got: dirOf(solo), 全局: B })

    S.settings.projectDir = A   // 复位,别影响后续用例
  },
}
