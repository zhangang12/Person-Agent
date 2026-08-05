'use strict'
// 形状模板 —— DAG 的【骨架】归代码,【内容】归模型。
//
// ── 为什么要有这个模块 ────────────────────────────────────────────────────
// 这套编排的立意是"控制流归代码,判断归模型"。但有一件事一直还留在模型手里:DAG 长什么形状。
// 结果就是实测到的两个症状:
//   · 一直派发单片 —— 规划器给 1~2 个节点就收手,并发位空着(默认能同时跑 4 片);
//   · 交付是散装文档 —— 每片各写各的,没人汇总,拿到手是 N 篇互不知道对方存在的东西。
// 上一轮已经把"三种扇出形态"和"reduce 收尾"写进提示词了,但那只是【改激励】:
// 模型愿意照做才有效,内网弱模型多半不照做。
//
// Claude Code 那种宽度不是模型更聪明 —— 是它的工作流脚本里【写死了扇出】
// (每个维度一个 agent、每条发现一个校验、最后一个 synthesize)。模型只负责填每个 agent 的内容。
// 本模块就是把这件事搬过来:代码保证骨架成立,模型只填内容。
//
// ── 边界(改这个文件前先读)────────────────────────────────────────────────
// ① 纯函数:不碰时钟 / fs / 全局。只吃 run 与 specs,吐新的 specs。
// ② 只【补骨架】,不改模型给的节点:模型自己给了 reduce 就不再补,给够宽度就不重问。
//    代码补位是兜底,不是替模型做主 —— 它给了更好的,以它为准。
// ③ 产出的是 spec,不是 node:一律交回 run.js 走 N.validateNodeSpecs 同一条校验,
//    绝不绕过校验直接塞节点(绕过去就等于凭空多了一条不受不变量约束的入图路径)。
// ④ 补出来的节点 origin 记 'shape',与 plan/replan/user 区分开 —— 面板与验收要看得出"这是代码补的"。
//    (addNodes 原注释写着"没有 auto —— 代码不造节点";这是有意推翻,所以必须留痕。)

function str(x) { return x == null ? '' : String(x) }
function arr(x) { return Array.isArray(x) ? x : [] }
function num(x) { const n = +x; return Number.isFinite(n) ? n : 0 }

// 需要"汇总收尾"的目标类型:探索/调研/成文这一类,产出本身就是文档,散着交等于没交。
// 写代码/改 bug 类不在此列 —— 那种任务的交付是代码,硬塞一份汇总文档是噪音。
const DOC_GOAL_RE = /探索|调研|摸底|盘点|梳理|综述|成文|报告|分析|审计|排查|评估|调查|研究|对比|清单/
// 同上,用于判断"该不该按视角拆宽"。比 DOC_GOAL_RE 略窄:实现类任务拆宽靠按对象,不靠按视角。
const WIDE_GOAL_RE = /探索|调研|摸底|盘点|梳理|综述|报告|分析|审计|排查|评估|调查|研究|对比|清单/

/** 这个目标是不是"产出文档"型 */
function isDocGoal(goal) { return DOC_GOAL_RE.test(str(goal)) }
/** 这个目标是不是"该拆宽"型 */
function isWideGoal(goal) { return WIDE_GOAL_RE.test(str(goal)) }

/** 会产出文件的节点(reduce 要汇总的就是这些) */
function producers(nodes) {
  return arr(nodes).filter((n) => {
    if (!n || str(n.kind) === 'reduce') return false
    const ex = n.exit || {}
    return arr(ex.artifacts).length > 0
  })
}
function hasReduce(nodes) { return arr(nodes).some((n) => n && str(n.kind) === 'reduce') }

/**
 * 该不该补一个 reduce 收尾。
 * 条件三条都要满足:目标是产出文档型 / 已经有 ≥2 片各自产文件 / 全图还没有 reduce。
 * ≥2 才补:只有一片时它自己那份就是最终文档,再套一层汇总是纯浪费。
 */
function needsReduce(run) {
  const r = run || {}
  if (!isDocGoal(r.goal)) return null
  const nodes = arr(r.nodes)
  if (hasReduce(nodes)) return null
  const ps = producers(nodes)
  if (ps.length < 2) return null
  return ps
}

/** 汇总节点的产出路径:稳定、可预期、不跨 run 撞车 */
function reducePath(run) {
  const id = str((run || {}).id).replace(/[^\w-]/g, '') || 'run'
  return 'docs/汇总报告-' + id + '.md'
}

/**
 * 造一个 reduce 节点的 spec(交回 run.js 走 validateNodeSpecs)。
 * goal 正文就是这份最终文档的质量下限 —— 汇总最容易退化成"把各片摘要拼起来",
 * 那种东西读者自己看原文更快,等于白做一层。所以这里把"汇总该做什么"写死。
 */
function makeReduceSpec(run, targets) {
  const out = reducePath(run)
  const list = arr(targets).map((n) => '  · ' + str(n.title || n.id) + (arr(n.exit && n.exit.artifacts).length ? '(' + arr(n.exit.artifacts).join('、') + ')' : ''))
  return {
    title: '汇总成文',
    kind: 'reduce',
    deps: arr(targets).map((n) => str(n.id)),
    writeScope: [out],
    artifacts: [out],
    contract: [],
    requireEvidence: false,
    requireVerdict: false,
    verifyCmd: '',
    goal: [
      '把前面各片的产出【合成一份】最终文档,落盘到 ' + out + '。',
      '',
      '【要汇总的片】(逐个把它们的产出文件读完再动笔,别只看标题猜内容)',
      list.join('\n'),
      '',
      '【总目标】' + str((run || {}).goal),
      '',
      '【汇总要做的四件事 —— 只做拼接等于白做一层】',
      '  ① 交叉印证:同一件事有多片提到就对齐说法;【互相矛盾的地方必须摊开写清楚】,',
      '     写明哪片说了什么、你判断哪个成立、依据是什么。矛盾被抹平是汇总最坏的失败。',
      '  ② 去重合并:同一个问题在不同片里换了说法的,合成一条,别让读者自己去认。',
      '  ③ 排先后:按重要性/影响面排序,别按各片交回来的顺序堆。读者只读前三条也该拿到最要紧的。',
      '  ④ 补缺口:哪些地方【没人查过】、哪些结论【还没证据】,单列一节如实写出来 —— 不写等于假装查全了。',
      '',
      '【下限】每条结论后面跟证据(文件:行号 / 命令与输出 / 接口与返回)。',
      '  不要写"存在一些问题""建议进一步优化"这类删掉不影响任何人做决定的话。',
      '  原文太长不要整段贴,给路径与行号让人自己去看。',
    ].join('\n'),
  }
}

/**
 * 规划拆得够不够宽。
 * 只对"该拆宽"型目标判;返回 null 表示不用管。
 * 判据刻意只看【能并行的片数】而不是总片数:串成一条链的 5 个节点,并发位照样空着。
 */
function tooNarrow(run, madeNodes) {
  const r = run || {}
  if (!isWideGoal(r.goal)) return null
  const cap = num(r.concurrency) || 4
  if (cap < 2) return null
  const made = arr(madeNodes)
  if (!made.length) return null
  // 勘察片(probe)不算宽度:它本来就是"先看一眼再拆",后面还会被再问一次
  const real = made.filter((n) => n && str(n.kind) !== 'probe')
  if (!real.length) return null
  const rootless = real.filter((n) => !arr(n.deps).length)   // 无依赖 = 第一批就能同时跑的
  if (rootless.length >= cap) return null
  return { cap, made: real.length, parallel: rootless.length }
}

module.exports = { isDocGoal, isWideGoal, producers, hasReduce, needsReduce, makeReduceSpec, reducePath, tooNarrow, DOC_GOAL_RE, WIDE_GOAL_RE }
