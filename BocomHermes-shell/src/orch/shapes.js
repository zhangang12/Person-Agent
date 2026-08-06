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

// ── 目标分型:一个分类器,不是两张关键词表 ──────────────────────────────────
// 【为什么推翻原来的两张正则表】原来是 DOC_GOAL_RE / WIDE_GOAL_RE 两张【白名单】关键词表:
// 命中才强制。实测的后果是【静默漏判】—— 目标写成「看看订单模块有什么问题」「帮我把这块理清楚」,
// 一个关键词都不命中,于是拆宽强制、汇总收尾【整条都不触发】,而且不吭一声。
// 用户报的"拆的分片不够多",这是其中一条独立成因。
//
// 【改成黑名单:默认拆宽,除非明显是单点实现】依据是两边的代价不对称 ——
//   · 对窄目标误判成宽:代价是【重问一次】,而且重问话术明说"理由是硬事实就原样再说一遍,壳层会认";
//   · 对宽目标漏判成窄:代价是整件事只派 1~2 片、没人汇总,而且【没有任何信号】说明这里少判了。
// 一个吵一次,一个静默失败。所以默认站在"拆宽"这一边。
//
// 三型:
//   impl   = 单点实现/修改(交付是代码,硬塞视角节点与汇总文档都是噪音)→ 不铺宽、不汇总
//   audit  = 排查/审查/测试/评估(找问题)  → 按"容易出问题的维度"铺宽
//   survey = 探索/调研/梳理/需求分析(摸清楚)→ 按"要摸清的面"铺宽
const NARROW_RE = new RegExp([
  '^(修复|修一下|修个|改一下|改个|删掉|删除|去掉|重命名|加一个|添加一个|新增一个|升级|回滚|还原)',
  '把.{1,24}(改成|换成|挪到|改为)',
  '(修复|解决)一下?.{0,20}(bug|BUG|报错|异常|问题)$',
].join('|'))
const AUDIT_RE = /排查|审查|审计|评估|检查|测试|验证|复核|找出?问题|有什么问题|有没有问题|漏洞|风险点|回归/
// ★分析 / 报告 这两个词是重写分类器时【漏掉的】(老的 DOC_GOAL_RE 里本来有)。
// 真机第二轮的目标原文就是「分析当前这个项目」—— 8 个字,一个关键词都不命中,
// 掉进长度兜底判成 impl:不铺视角、不补汇总。这次是模型自己给了 reduce 才没露馅。
const SURVEY_RE = /探索|调研|摸底|摸清|盘点|梳理|理清|搞清|综述|成文|调查|研究|对比|清单|分析|报告|需求分析|技术方案|现状/
const IMPL_RE = /实现|开发|重构|迁移|迁到|迁往|接入|联调|上线|打包|部署|写一个|做一个|改造|升级到/

// 兜底(什么关键词都没命中)时的最短长度。"就问一句""看下这个"这类一句话请求不该被铺成 6 片 ——
// 兜底的含义是【我认不出这是什么】,而认不出来的一句话,更可能是随口一问而不是一个调研项目。
// 明写了关键词的短目标不受此限:「排查订单模块」6 个字,照样按 audit 铺。
const FALLBACK_MIN_LEN = 12

/** 目标分型 → 'impl' | 'audit' | 'survey' */
function goalShape(goal) {
  const g = str(goal).trim()
  if (!g) return 'impl'                       // 空目标不造任何骨架(它连拆都还没拆)
  if (NARROW_RE.test(g)) return 'impl'        // 明写着单点改动 → 交付是代码
  // 白名单在前、IMPL 在后:「重构后排查一遍」「迁移前先摸清依赖」这类复合目标,
  // 真正的活是排查/摸清,实现只是背景 —— 按后者拆会拆成 0 片。
  if (AUDIT_RE.test(g)) return 'audit'
  // ★"实现/开发/重构…"【开头】的一律按实现算,即使句子里还有"分析"这类词 ——
  //   「实现数据分析模块」的主谓是"实现",分析只是名词的一部分;而「重构后梳理一遍」这种
  //   把实现放在时间状语里的写法,主谓在后面。中文里这条位置规律比关键词本身更可靠。
  if (IMPL_RE.test(g) && IMPL_RE.test(g.slice(0, 4))) return 'impl'
  if (SURVEY_RE.test(g)) return 'survey'
  if (IMPL_RE.test(g)) return 'impl'
  // ★关键词全没命中才走长度兜底,且兜底站在拆宽这边(见上面的代价不对称)。
  //   明写了关键词的短目标不受长度限制 —— 「排查订单模块」6 个字照样铺。
  return g.length >= FALLBACK_MIN_LEN ? 'survey' : 'impl'
}

/** 这个目标是不是"产出文档"型(该有 reduce 收尾) */
function isDocGoal(goal) { return goalShape(goal) !== 'impl' }
/** 这个目标是不是"该拆宽"型 */
function isWideGoal(goal) { return goalShape(goal) !== 'impl' }

// 会产出文件的节点(reduce 要汇总的就是这些)。
// 【为什么不能只看声明的 artifacts】真机实测 2026-08-07:规划器把 4 个勘察片全给成 kind:'probe',
// 而 gatesFor 对 probe 强制 artifacts=[](勘察的交付就是回报本身,不该硬要求落盘)。
// 于是这四片【落了盘也不算产出】—— needsReduce 数到 0 个 producer 不补汇总,
// extendReduceDeps 也接不上它们,那几份文档没有任何人读。
// 所以判据改成"声明了产出 或 实际写了文件",两者取其一。
// verify/check 排除掉:它们按设计是只读的,而 doDispatch 会把没写归属的 verify 关进临时目录 ——
// 那里的临时文件会混进 result.files,认它们当产出就会把一堆 /tmp 路径塞进汇总的 deps。
const NON_PRODUCER = ['reduce', 'verify', 'check']
function producers(nodes) {
  return arr(nodes).filter((n) => {
    if (!n || NON_PRODUCER.indexOf(str(n.kind)) >= 0) return false
    if (arr((n.exit || {}).artifacts).length > 0) return true
    return arr(n.result && n.result.files).length > 0
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

// ── 宽度:目标该有几个面,不是机器能同时跑几片 ──────────────────────────────
// 【原来错在哪】宽度目标写的是 run.concurrency(并发旋钮)。这把两件不相干的事绑死了:
//   并发只决定【派发节奏】—— 超了就进队列排着,活照样做完;
//   宽度决定【覆盖面】—— 4 片各啃 1/4,和 6 片各盯一个面,后者每片更聚焦、也更深。
// 绑死的后果:用户 settings.json 里 wfConcurrency 持久化成 4(默认改成 8 也盖不掉它),
// 于是无论目标多大,壳层永远只要求 4 片能并行 —— 队列明明就在那儿,却没人用。
// 现在:宽度 = 视角清单的长度(任务的属性),并发只管派发。
//
// 【视角清单为什么写死在代码里】这正是 CC 与"求模型多拆一点"的分水岭:
// CC 的宽度是脚本里的数组(DIMENSIONS.map(...)),模型【没有"要不要拆"的投票权】,只负责填每片内容。
// 弱模型在"要不要多拆"上永远倾向于少拆(少拆看起来更稳),靠提示词劝是劝不动的 —— 实测重问一次也照旧。
const LENS_SETS = {
  audit: [
    { key: 'api', name: '接口与边界', ask: '对外接口/函数的入参校验:必填、类型、长度、范围、非法值;错误码与提示是否一致、是否泄露内部信息。' },
    { key: 'data', name: '数据与精度', ask: '金额/数量的精度与舍入、时间与时区、编码、空值与默认值、单位换算 —— 这一类错了不会报错,只会算错。' },
    { key: 'fail', name: '异常与回滚', ask: '失败路径:异常吞掉没有、事务边界在哪、部分成功怎么补偿、重试会不会放大伤害。' },
    { key: 'race', name: '并发与幂等', ask: '重复提交、并发写同一条记录、超时重试、唯一约束与锁 —— 只跑一遍看不出来的那一类。' },
    { key: 'auth', name: '权限与可见性', ask: '鉴权在哪一层、能不能越权取到别人的数据、批量接口的数据范围是不是也过滤了。' },
    { key: 'env', name: '配置与环境', ask: '硬编码、环境差异(本地/测试/生产)、开关与降级、依赖版本与外部服务不可用时的行为。' },
  ],
  survey: [
    { key: 'flow', name: '入口与主流程', ask: '从哪些入口进来、主干怎么走、关键分叉在哪 —— 画得出一条能跟着读代码的主线。' },
    { key: 'model', name: '数据模型与存储', ask: '有哪些表/实体、关键字段与含义、它们之间的关系、一条记录的生命周期。' },
    { key: 'dep', name: '外部依赖与集成', ask: '调了谁、被谁调、用什么协议、对方挂了会怎样、有没有重试与超时。' },
    { key: 'env', name: '配置与运行环境', ask: '怎么起起来、依赖哪些配置与外部服务、各环境的差异在哪。' },
    { key: 'debt', name: '演进痕迹与遗留', ask: '废弃代码、TODO/FIXME、注释里写的坑、明显是临时方案的地方 —— 这些是后来人最容易踩的。' },
    { key: 'risk', name: '风险与未决', ask: '哪些地方没有测试、哪些逻辑没人说得清、哪些改动会牵连一大片。' },
  ],
}

/** 这个目标该铺哪套视角(impl 型不铺:实现类拆宽靠按对象,硬造视角是噪音) */
function lensSetFor(goal) { return LENS_SETS[goalShape(goal)] || null }

/** 宽度目标:任务该有几个面。0 表示这类目标不强制宽度 */
function widthTarget(run) {
  const set = lensSetFor((run || {}).goal)
  return set ? set.length : 0
}

/** 第一批就能同时开跑的节点(无依赖,或依赖已全部终结)。勘察片不算宽度 —— 它本来就是"先看一眼再拆" */
function parallelHeads(nodes) {
  const all = arr(nodes)
  const settled = new Set(all.filter((n) => n && (str(n.state) === 'verified' || str(n.state) === 'skipped')).map((n) => str(n.id)))
  return all.filter((n) => {
    if (!n || str(n.kind) === 'probe') return false
    const st = str(n.state || 'pending')
    if (['pending', 'queued', 'running'].indexOf(st) < 0) return false
    return !arr(n.deps).some((d) => !settled.has(str(d)))
  })
}

// 重问的下限:能并行的片数【少于 2】才值得为它多烧一轮规划。
// 【为什么不是"没达标就重问"】代码补宽落地之后,重问的边际价值只剩"模型自己拆的视角更贴这个项目";
// 而它的代价是每条 run 都多一轮决策 —— 内网一轮就是好几分钟,还挡着人审那一步。
// 所以分工改成:给了 0~1 片 = 它根本没在拆 → 值得问一次(真机上撞到的正是这一档);
//               给了 2 片以上但不够宽 → 代码直接补齐,不再商量。
const REASK_FLOOR = 2

/**
 * 规划拆得够不够宽(用于【重问模型一次】,不是补宽的判据)。
 * 返回 null 表示不用管。判据只看【能并行的片数】而不是总片数:串成一条链的 5 个节点,并发位照样空着。
 */
function tooNarrow(run, madeNodes) {
  const r = run || {}
  const want = widthTarget(r)
  if (want < 2) return null
  const made = arr(madeNodes)
  if (!made.length) return null
  const real = made.filter((n) => n && str(n.kind) !== 'probe')
  if (!real.length) return null
  const rootless = real.filter((n) => !arr(n.deps).length)   // 无依赖 = 第一批就能同时跑的
  if (rootless.length >= Math.min(want, REASK_FLOOR)) return null
  return { cap: want, made: real.length, parallel: rootless.length }
}

/** 这条 run 已经铺过哪些视角(按 lensKey 记,重跑/多次补宽不重复铺) */
function lensesUsed(run) {
  const out = new Set()
  for (const n of arr((run || {}).nodes)) if (n && str(n.lensKey)) out.add(str(n.lensKey))
  return out
}

/**
 * 该不该由【代码】补宽,补哪几个视角。
 * 与 tooNarrow 的分工:tooNarrow 是"再问模型一次"(它更懂这个项目,先给它机会);
 * 本函数是问完还是不够时的兜底 —— 代码直接铺,不再商量。
 * room = 预算还能开几个节点(调用方算好传进来,本模块不碰 run.budget 的记账口径)。
 */
function needsWiden(run, room) {
  const r = run || {}
  const set = lensSetFor(r.goal)
  if (!set) return null
  const want = set.length
  const have = parallelHeads(r.nodes).length
  if (have >= want) return null
  const free = Math.max(0, num(room))
  if (free <= 0) return null
  const used = lensesUsed(r)
  const missing = set.filter((l) => !used.has(l.key)).slice(0, Math.min(want - have, free))
  if (!missing.length) return null
  return { lenses: missing, want, have, shape: goalShape(r.goal) }
}

/** 视角节点的产出路径:一个视角一份文档 —— 各写各的文件,写归属天然两两不交 */
function lensPath(run, lens) {
  const id = str((run || {}).id).replace(/[^\w-]/g, '') || 'run'
  return 'docs/视角-' + str(lens.key) + '-' + id + '.md'
}

/**
 * 一个视角 → 一个节点 spec。
 * 【为什么让它落盘而不是只回报】下游的 reduce 有一道 substance 闸,要求汇总真的引用了 ≥2 份上游产出;
 * 视角节点不落盘的话汇总无从引用,那道闸必然过不去(自己给自己造死锁,和 gatesFor 修过的是同一类错)。
 */
function makeLensSpec(run, lens, shape) {
  const out = lensPath(run, lens)
  const isAudit = str(shape) === 'audit'
  return {
    title: (isAudit ? '查·' : '摸·') + str(lens.name),
    kind: 'work',
    lensKey: str(lens.key),
    deps: [],
    writeScope: [out],
    artifacts: [out],
    contract: [],
    requireEvidence: false,     // 只读代码 + 写一份文档,没有可跑的构建/测试
    requireVerdict: false,
    verifyCmd: '',
    goal: [
      '你负责【一个视角】,只看这一个面,看透它。把结论落盘到 ' + out + '。',
      '',
      '【总目标】' + str((run || {}).goal),
      '',
      '【你这一片的视角:' + str(lens.name) + '】',
      '  ' + str(lens.ask),
      '',
      '【怎么干】',
      '  · 同一批代码会有别的片同时在看,但【他们找的是别的东西】。你只管你这个面,',
      '    不要因为"这个地方好像也有问题"就跑去写别人的面 —— 那会两边都写一半。',
      '  · 从这个视角出发【自己去找入口】:搜关键字、跟调用链、读表结构,不要等别人给你清单。',
      '  · ' + (isAudit
        ? '找到问题要能落到"哪个文件哪一段、现在是什么行为、应该是什么行为、什么条件下会出事"。'
        : '摸清楚要能落到"哪个文件哪一段负责什么、和谁交互、边界在哪"。'),
      '  · 这个面【确实没什么可说的】也是合格结论 —— 但要写清楚你查了哪些地方才得出这个结论,',
      '    空手回来和查过之后确认没问题,是两回事。',
    ].join('\n'),
  }
}

/**
 * 验收节点(C+D 合一):对汇总产出做【新眼睛】复核。
 * 为什么合成一个:"这份文档够不够格"和"对照总目标还漏了什么"是同一个审阅者的活,
 * 拆两片只是多烧一倍 token,而且两份意见还得再有人合。
 * 为什么必须是【另一片】:让写汇总的自己评自己 = 自己给自己打分,这套编排在验证棒那边早有定论。
 */
function makeAuditSpec(run, reduceNode) {
  const target = arr(reduceNode.exit && reduceNode.exit.artifacts)[0] || reducePath(run)
  return {
    title: '验收汇总',
    kind: 'verify',
    deps: [str(reduceNode.id)],
    writeScope: [],            // 只读:验收员不许边验边改(又当裁判又当运动员)
    artifacts: [],
    contract: [],
    requireEvidence: false,
    requireVerdict: true,      // 回报必须带 VERDICT 行,壳层机判
    verifyCmd: '',
    goal: [
      '你是【验收员】。逐字读完 ' + target + ',对照下面的总目标审它。你不改任何文件,只出结论。',
      '',
      '【总目标】' + str((run || {}).goal),
      '',
      '【第一问:这份文档够不够格】',
      '  · 结论有没有证据?挑 3 条最关键的结论,回到它给的出处(文件:行号 / 命令 / 接口)【实际核一遍】——',
      '    对不上的逐条列出来。核不动也要说明为什么核不动,不许跳过。',
      '  · 有没有大段空话?"存在一些问题""建议进一步优化"这类删掉不影响任何人做决定的句子,点名列出。',
      '  · 是不是只把各片摘要拼了一遍?判据:各片之间【有没有交叉印证与取舍】。只有罗列没有比较 = 没做汇总。',
      '',
      '【第二问:对照总目标还漏了什么】',
      '  · 总目标里哪些方面【一个字都没提到】?逐条列出来。',
      '  · 哪些结论【没有任何人核实过】?列出来。',
      '  · 各片之间有没有互相矛盾却被抹平的地方?找出来。',
      '  ★这一问是你的主要价值。找不到漏洞不是本事,是没找 —— 一份覆盖了几十个文件的汇总不可能没有缺口。',
      '',
      '【收尾】调一次 MCP 工具 report_verdict 给出判决(PASS / FAIL)。',
      '  两问里只要有【实质性】问题就判 FAIL,并在回答里把待补清单写清楚(哪一条、缺什么、去哪儿补)。',
      '  措辞含糊的 PASS 等同于没验 —— 判 PASS 时 didWhat 要说清你实际核了哪 3 条、observed 写核的结果。',
    ].join('\n'),
  }
}

/** 该不该给汇总补一个验收(有 reduce、且还没人验它) */
function needsAudit(run) {
  const nodes = arr((run || {}).nodes)
  const red = nodes.find((n) => n && str(n.kind) === 'reduce')
  if (!red) return null
  const audited = nodes.some((n) => n && str(n.kind) === 'verify' && arr(n.deps).indexOf(str(red.id)) >= 0)
  return audited ? null : red
}

// ── 按发现扇出(CC 的 Verify 那一层)────────────────────────────────────────
// 工人在回报里给出 <发现> 块,壳层逐条派【新眼睛】去核。
// 为什么必须是新眼睛:让查出这条的人自己复核,等于问他"你确定吗"—— 他当然确定。
// 为什么由代码扇出而不是让 replan 去加:replan 每次只看得到一段摘要,漏一条不会有人发现;
// 代码按条扇出才有"每条都被核过"这个可验证的性质。
const FIND_RE = /<发现>([\s\S]*?)<\/发现>/
const MAX_FINDINGS = 8   // 单片上限:再多说明这片本身该拆,不是该派 30 个校验(也防模型凑数烧预算)

/** 从工人终答里解析发现清单。解析不出来就返回空数组 —— 宁可不扇出,不可扇出一堆噪音 */
function parseFindings(text) {
  const m = FIND_RE.exec(str(text))
  if (!m) return []
  const out = []
  for (const raw of str(m[1]).split('\n')) {
    const line = raw.trim()
    if (!line || !/^F\s*\|/.test(line)) continue
    const cols = line.replace(/^F\s*\|/, '').split('|').map((x) => x.trim())
    const sev = cols[0] || ''
    const what = cols[1] || ''
    const ev = cols.slice(2).join(' | ').trim()
    if (!what) continue                       // 没说清是什么问题的,核不动,丢掉
    if (what.length < 6) continue             // "有问题"这种也丢
    out.push({ sev: /高|high/i.test(sev) ? '高' : /低|low/i.test(sev) ? '低' : '中', what: what.slice(0, 200), ev: ev.slice(0, 200) })
    if (out.length >= MAX_FINDINGS) break
  }
  return out
}

/** 这一片的发现有没有已经派过校验(按 sourceNode 记,重跑不重复派) */
function findingsVerified(run, nodeId) {
  return arr((run || {}).nodes).some((n) => n && str(n.kind) === 'verify' && str(n.sourceNode) === str(nodeId))
}

// ── 结构化上报(工人调 MCP 工具 report_findings 走这条)────────────────────
// 【为什么要有这条,正则那条还不够】parseFindings 认的是终答正文里的 <发现> 块 —— 一个【格式约定】。
// 弱模型漏格式是常态,而漏了之后壳层看到的是"这片没查出问题",与"这片真的没问题"【长得一模一样】:
// 静默失败,面板上什么都不会说。工具调用不一样 —— 参数不合规当场就能退回让它重填,
// 而且弱模型对"调一个工具"的遵从度本来就远高于"按格式写一段文本"。
// 正则那条保留为【降级路径】:工具没调时才用。两条不并存 —— 结构化有货就只认结构化。
const SEV_HI = /高|high|critical|blocker|严重/i
const SEV_LO = /低|low|minor|trivial|轻/i
function sevOf(s) { const t = str(s); return SEV_HI.test(t) ? '高' : SEV_LO.test(t) ? '低' : '中' }

/** 结构化上报进来的发现 → 归一成与 parseFindings 完全相同的形状(下游只认一种形状) */
function normFindings(list) {
  const out = []
  for (const raw of arr(list)) {
    const f = (raw && typeof raw === 'object') ? raw : { what: raw }
    const what = str(first(f.what, f.title, f.summary, f.desc, '')).trim()
    if (what.length < 6) continue                 // "有问题"这种核不动,丢掉(与正则那条同口径)
    out.push({
      sev: sevOf(first(f.sev, f.severity, '')),
      what: what.slice(0, 200),
      ev: str(first(f.ev, f.evidence, f.anchor, '')).slice(0, 200),
    })
    if (out.length >= MAX_FINDINGS) break
  }
  return out
}
function first(...xs) { for (const x of xs) if (x !== undefined && x !== null && x !== '') return x; return '' }

// 去重键:同一件事换个说法不该被核两遍。归一化压掉空白/标点/常见修饰词,再取前若干字符。
// 【为什么不做语义去重】那要再烧一次模型调用,而这里的目标只是挡住"两片查到同一处、说法几乎一样"
// 这种最常见的重复 —— 挡不住的漏网到核实那一层也只是多花一个廉价节点,代价对称。
const DEDUP_STRIP = /[\s,,。.、;;::""''「」()()【】\[\]!!??~~-]/g
function findingKey(f) {
  const t = str((f && (f.what || f)) || '')
    .replace(/^(疑似|可能|存在|发现|建议|需要|应该)/, '')
    .replace(DEDUP_STRIP, '')
    .toLowerCase()
  return t.slice(0, 40)
}

/**
 * 跨片去重:这条说法已经在账上了就不再收(两片查到同一件事 → 只核一次)。
 * 【两个来源都要看,少看一个就成了两本账】
 *   · verify 节点上的 findingKey —— 已经派人去核的;
 *   · 各节点 result.findings —— 已经上报、但还没到收官扇出那一步的。
 * 真机实测漏的正是后者:上报的瞬间还没有任何 verify 节点,于是同一条报两次都被判成"新的",
 * 工具回给工人的 accepted 计数是假的(说收下了,实际入账时又被节点内去重吃掉)。
 */
function dedupeFindings(run, list, exceptNodeId) {
  const skip = str(exceptNodeId)
  const seen = new Set()
  for (const n of arr((run || {}).nodes)) {
    if (!n) continue
    if (str(n.findingKey)) seen.add(str(n.findingKey))
    // ★收官扇出时要把【源节点自己那批】排除在外 —— 否则会把正要扇出的那些当成"已经在账上",
    //   一条都派不出去(第一版就是这么写的,真机集成用例当场抓到:上报全收下了,却没派出一个核实员)。
    //   上报时不传 exceptNodeId,于是同一条报两次会被认出来 —— 两个调用点的差别只在这一个参数。
    if (skip && str(n.id) === skip) continue
    for (const f of arr(n.result && n.result.findings)) { const k = findingKey(f); if (k) seen.add(k) }
  }
  const out = []
  for (const f of arr(list)) {
    const k = findingKey(f)
    if (!k || seen.has(k)) continue
    seen.add(k)                                    // 同一批里自己也可能重复(模型换个说法又写一遍)
    out.push(f)
  }
  return out
}

// ── 核实的两个视角 ────────────────────────────────────────────────────────
// 【为什么同一条要两个人核,而不是一个人核两遍】一个核实员只会沿着一条思路走到底:
// 他要么在"证据对不对"上打转,要么在"能不能复现"上打转,两种漏法完全不同。
// 换成两个人、各给一条【互不重叠的路子】,才是真的两票 —— 同一个人问两遍等于问一遍。
// 只给【高】严重度开两票:低严重度多花一个节点不值,而预算是硬的(maxNodes)。
const VERIFY_LENSES = [
  { key: 'refute', name: '证伪', how: [
    '  · 你的默认立场是【这条是错的】。先努力证伪,证伪不掉才算它成立 ——',
    '    提出这条的人已经说服过自己一次了,你再顺着他想一遍没有任何信息量。',
    '  · 顺着它给的证据【自己走一遍】:打开那个文件那一行 / 跑那条命令 / 调那个接口,亲眼看结果。',
    '  · 证据对不上、或它压根没给证据 → 你自己去找;找不到就判 FAIL,别替它圆。',
  ] },
  { key: 'repro', name: '可复现', how: [
    '  · 你只回答一个问题:【这件事在什么条件下真的会发生】。',
    '    写出触发条件(什么输入 / 什么时序 / 什么配置),能跑就跑一遍给出实际输出。',
    '  · 条件写不出来、或写出来之后发现现实中走不到那条路(有上游校验挡着、那段代码是死代码、',
    '    配置默认关着)→ 判 FAIL 并说明是哪一种。【描述成立但现实中触发不到】是最常见的假阳性。',
    '  · 顺带看一眼影响面:真发生了会伤到什么,比它说的严重度更大还是更小。',
  ] },
]

/** 一条发现该派几个核实员(高 → 两个不同视角;其余 → 一个)。room 不够就降到 1 */
function verifyLensesFor(f, room) {
  const two = str(f && f.sev) === '高' && num(room) >= 2
  return two ? VERIFY_LENSES : [VERIFY_LENSES[0]]
}

/** 一条发现 → 一个廉价的 verify 节点 spec。lens 缺省用【证伪】那个视角 */
function makeFindingVerifySpec(run, srcNode, f, idx, lens) {
  const L = lens || VERIFY_LENSES[0]
  return {
    title: '核实#' + (idx + 1) + '·' + str(L.name) + ' ' + str(f.what).slice(0, 10),
    kind: 'verify',
    deps: [str(srcNode.id)],
    writeScope: [],          // 只读:核实的人不许顺手改(又当裁判又当运动员)
    artifacts: [],
    contract: [],
    requireEvidence: false,
    requireVerdict: true,
    verifyCmd: '',
    sourceNode: str(srcNode.id),
    findingKey: findingKey(f),      // 跨片去重靠它:同一件事被两片查到,只核一次
    goal: [
      '你是【核实员 · ' + str(L.name) + '视角】,只核一条,核完就走。不要顺手做别的,也不要改任何文件。',
      '',
      '【要核的这一条】(来自「' + str(srcNode.title || srcNode.id) + '」)',
      '  严重度:' + str(f.sev),
      '  说法:' + str(f.what),
      '  它给的证据:' + (str(f.ev) || '(没给)'),
      '',
      '【怎么核 —— 只走你这一条路子】',
      arr(L.how).join('\n'),
      '  ★这一条可能还有另一个人从别的角度在核。你【不要】替他把那个角度也想一遍 ——',
      '    两个人各走各的路才是两票;你顺带把他的活也干了,就退化成一票了。',
      '',
      '【收尾】调一次 MCP 工具 report_verdict 给出判决(PASS=这条成立 / FAIL=不成立或证据不足 / PARTIAL=部分成立)。',
      '  判 PASS 要同时写清 didWhat(你实际做了什么来核它)与 observed(你看到了什么原文/输出)——',
      '  没做过就说没做过,不许写成做过的样子。调完工具再简单回一句结论即可。',
    ].join('\n'),
  }
}

module.exports = {
  parseFindings, findingsVerified, makeFindingVerifySpec, MAX_FINDINGS,
  makeAuditSpec, needsAudit,
  goalShape, isDocGoal, isWideGoal,
  producers, hasReduce, needsReduce, makeReduceSpec, reducePath,
  tooNarrow, widthTarget, parallelHeads, lensSetFor, lensesUsed, needsWiden, makeLensSpec, lensPath, LENS_SETS,
  normFindings, findingKey, dedupeFindings, sevOf, verifyLensesFor, VERIFY_LENSES,
}
