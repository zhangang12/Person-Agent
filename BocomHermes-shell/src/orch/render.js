'use strict'
// ══════════════════════════════════════════════════════════════════════════════
// 编排渲染 + 决策提示词(刻意同文件)
//
// 【为什么渲染与提示词必须住在一起】渲染成什么、问什么,是同一件事的两面 —— 拆两个文件必然漂。
// 现状就是活证据:唤醒文案(window.js:822)与主控规程(:554)已经漂成两本账 ——
// 主控按方案里的 M 记账,壳层推给它的分母却含校验棒/索引棒/自动补派的验证棒,两边永远对不上。
//
// 【这里的两条铁律】
//  1. 【数得出来的一律代码算好了喂进去,不许问模型】目录事实(N/字节/顶层分布/两层树/README 首 40 行)、
//     进度计数、预算水位、差异检测、无验证证据清单 —— 全是代码算的。
//     ★旧主控规程里那 181 字纯算术演算(M = max(⌈N/20⌉, ⌈总量/150KB⌉) 加反例)整块从提示词消失:
//       那是"让模型干代码的活"最典型的一处,模型只回答【怎么拆】,不回答【几个文件】。
//  2. 【模型可以决定不管,但不能说没见过】账本缺口、无验证证据的节点清单由代码强制注入 replan 提示词;
//     宣布收口(done:true)时 final.gaps 必须逐条覆盖它们 —— 校验在 schema.js,渲染在这里,缺一不可。
//     配套的反面:末尾明写"什么都不用改就返回空数组,这是合法答案" ——
//     让【我还不知道】和【不用改】成为便宜的合法选项,这是反死板的地基(选项贵,模型就会硬编)。
//
// 【末行三禁】两段决策提示词都以「只输出 JSON、不要调用任何工具、不要解释」收尾 —— 仓内 dbgTriage 生产验证过有效。
// 【composeNodeBrief 的边界】工人卡自己已经带了《动态工作流规程》(todo/子 Agent/落盘/验证纪律/交付自检),
//   brief 【不重复它】,只负责"这一个任务的上下文":总目标 + 本任务 + 上游 facts + 写归属 + 契约 + 产出 + 回报格式。
// ══════════════════════════════════════════════════════════════════════════════
const L = require('./ledger')
const SHAPE = require('./shapes')   // 只取宽度目标:提示词里要人拆几片,得跟壳层实际强制的那个数一致

const STATE_MARK = { pending: '○', queued: '⏸', running: '▶', settled: '⧗', verified: '✓', rejected: '↺', failed: '✗', skipped: '⊘', cancelled: '⊗' }
const TAIL = '只输出 JSON、不要调用任何工具、不要解释'
const CAP_FINAL = 1500        // 回报尾部截断(决策器只需要判断依据,不需要全文)
const CAP_GOAL_LINE = 60      // 节点表里一行的标题宽度

function str(x) { return x === null || x === undefined ? '' : String(x) }
function num(x) { const n = +x; return Number.isFinite(n) ? n : 0 }
function arr(x) { return Array.isArray(x) ? x : [] }
function clip(s, cap) { const t = str(s); return t.length > cap ? t.slice(0, cap) + '…' : t }
function oneLine(s, cap) { return clip(str(s).replace(/\s+/g, ' ').trim(), cap) }
function tail(s, cap) { const t = str(s).trim(); return t.length > cap ? '…' + t.slice(t.length - cap) : t }
function kb(bytes) {
  const b = num(bytes)
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB'
  if (b >= 1024) return Math.round(b / 1024) + ' KB'
  return b + ' B'
}
// 路径归一(不 require path:本文件禁碰任何 IO 侧模块,而且这里只做字符串比对)
function norm(p) { return str(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') }
// 归属比对前必须先把路径拉到【同一坐标系】:writeScope 是相对路径(模型按仓根写),
// 而 node.result.files 是【绝对路径】(session.js 的 wfFiles 会 resolve 成绝对再记)。
// 直接前缀比 → 绝对路径永远不以相对归属开头 → 每个文件都被报成"在归属外"(实测:模型为此专门写了
// 一整条 gap 去解释一个不存在的问题,白烧决策预算)。这里按 run.dir 剥前缀,纯字符串,不碰 path 模块。
function relTo(dir, file) {
  const d = norm(dir), f = norm(file)
  if (!d) return f
  if (f === d) return ''
  return f.indexOf(d + '/') === 0 ? f.slice(d.length + 1) : f
}
function inScope(scope, file) {
  const f = norm(file)
  if (!arr(scope).length) return true
  return arr(scope).some((s) => { const x = norm(s); return x && (f === x || f.indexOf(x + '/') === 0) })
}
function block(lines) { return arr(lines).filter((x) => str(x) !== '').join('\n') }
function bullets(items, cap, prefix) {
  return arr(items).slice(0, cap).map((x) => (prefix || '  · ') + oneLine(x, 200)).join('\n')
}
function nodeById(run, id) { return arr(run && run.nodes).find((n) => n.id === str(id)) || null }

// ── renderPlan ───────────────────────────────────────────────────────
// facts = index.js 算好的目录事实 { n, bytes, tops:[{path,n,bytes}|string], tree, readmeHead }
// ★这些数字全部由代码算 —— 提示词里【没有】任何"你自己估量级""按公式算片数"的演算
// event='too-narrow' 表示这是壳层【打回重问】的一次:上一版几乎没拆(能同时开跑的不到 2 片)。
// 重问必须带硬约束,不然模型多半原样再给一遍(它上次就是这么想的)。
function renderPlan(run, facts, event) {
  const r = run || {}
  const f = facts || {}
  const b = r.budget || {}
  const left = Math.max(0, num(b.maxNodes) - num(b.spawned))
  const tops = arr(f.tops).map((x) => (x && typeof x === 'object')
    ? norm(x.path) + '(' + num(x.n) + ' 个, ' + kb(x.bytes) + ')'
    : str(x)).join(' · ')
  const open = arr(r.ledger && r.ledger.open).map((o) => str(o && o.text ? o.text : o)).filter(Boolean)
  return block([
    '你是【编排规划器】。只做一件事:把总目标拆成可并行、各自可交付的节点。你不写代码、不读文件、不调任何工具。',
    '',
    '【总目标】',
    str(r.goal),
    '',
    '【工作目录】' + str(r.dir) + (r.backendDir ? '\n【副仓(只读,可探查不可改)】' + str(r.backendDir) : ''),
    '',
    '【目录事实 —— 壳层实测,不用你估,也不用你算】',
    '  候选文件 ' + num(f.n) + ' 个 · 总量 ' + kb(f.bytes),
    tops ? '  顶层分布: ' + tops : '',
    f.tree ? '  两层目录树:\n' + indent(clip(f.tree, 2400)) : '',
    f.readmeHead ? '  README 首 40 行:\n' + indent(clip(f.readmeHead, 2400)) : '',
    '',
    open.length ? '【已知未决】\n' + bullets(open, 12) + '\n' : '',
    '【预算】还能开 ' + left + ' 个节点(上限 ' + num(b.maxNodes) + ')。本次不限批量 —— 只给出你【现在有把握定义清楚的】那些,其余写进 open。',
    // ★这个数不是并发旋钮。宽度是【任务有几个面】,并发只是派发节奏(超了进队列排着,活照样做完)——
    //   原来这里写的是 run.concurrency,于是用户把旋钮调成 4,再大的目标也只被要求拆 4 片。
    widthLine(r),
    '  串行一片一片做出来的东西不会比并行的更深,只是更慢:每片自带独立上下文,分头深挖再汇总,',
    '  比一片从头啃到尾读得更细,也不容易让早期发现在中途被上下文挤掉。',
    '',
    '【三种扇出形态 —— 拆不宽的时候照这个想】',
    '  ① 按对象扇出:一个模块 / 一个页面 / 一条业务线 各一片。最直观,但只有对象之间真的互相独立时才对。',
    '  ② 按视角扇出:【同一片材料,每片换一个检查维度】—— 比如同一套表单,一片只查必填校验、一片只查数字精度、',
    '     一片只查重复提交、一片只查下拉与自由文本。这类节点是【只读】的(writeScope 留空),不受"两两不交"约束,',
    '     可以放心重叠:它们看的是同一批文件,找的是不同的东西。',
    '     ★这是最容易漏的一种。一个人从头看到尾只会发现一类问题,四个视角并行才扫得干净。',
    '  ③ 按发现扇出:上一批已经产出 N 条待核实的结论,就开 N 个廉价的 kind:"verify" 节点各核一条。',
    '     核实必须用【新眼睛】—— 让原片自己核自己等于自己给自己打分。这类节点通常一两个回合就完。',
    '  三种可以叠:先按对象铺一层,跑完按视角补一层,最后按发现核一层。不必一次拆完 —— 每片收官你都会被再问一次。',
    '',
    (str(event) === 'plan-invalid' && arr(b.lastInvalid).length)
      ? '【★上一版被壳层判为不合法 —— 这是重问】\n'
        + '  校验器逐条报的错:\n' + bullets(arr(b.lastInvalid), 3) + '\n'
        + '  请【只针对这些点】改,其余照旧;仍然只输出一个 JSON,第一个字符就是 {、最后一个字符就是 }。\n'
        + '  ★把思考放在 JSON 【之前】并用 <think></think> 包起来,或者干脆不写 —— 思考里如果出现花括号,\n'
        + '  壳层可能把它当成你的答案(这是真实发生过的误判)。'
      : '',
    str(event) === 'too-narrow'
      ? '【★这是打回重问 —— 上一版被壳层退回了】\n'
        + '  上一版要么一个节点都没给(判定"不值得拆"),要么只给了一片 —— 这不像是拆过。\n'
        + '  ★如果你上一版的理由是【硬事实】(比如目标里的东西根本不在这个工作目录),那就原样再说一遍,壳层会认;\n'
        + '  但如果只是觉得"一个节点也能干完",那多半是判断失误 —— 按下面重拆。\n'
        + '  这一版请按上面【三种扇出形态】重拆,重点是②按视角:同一批材料,每片换一个检查维度,\n'
        + '  writeScope 全部留空(只读,可重叠)。先铺够能并行的第一批,细节不确定的写进 open,不要串成一条依赖链。'
      : '',
    '【本次要决定】把这个目标拆成哪些节点。',
    '  · 你现在不确定内部长什么样的部分【不要硬拆】:写进 open,或先给一个 kind:"probe" 的勘察节点 —— 它跑完你会被再问一次,那时再拆。',
    '  · 每个节点必须能【独立交付】;writeScope【两两不交】(两个节点不许写同一个文件;共用的文件归一个节点独占,别的节点只读引用)。',
    '    ★这条只约束【要写文件】的节点。只读节点(勘察 / 排查 / 按视角扫描)writeScope 留空,不受此约束 ——',
    '    别因为"它们都要看同一批文件"就不敢并行拆:看同一批文件不冲突,写同一个文件才冲突。',
    '  · 先后关系一律写进 deps(填被依赖节点的 title、或本次数组里的序号从 1 起、或已存在节点的 id),不要靠数组顺序暗示。',
    '  · 验证做不做、怎么做【由你定】:requireEvidence / requireVerdict / verifyCmd 是你的开关 —— 壳层不会替你加验证节点,你不要求就没有。',
    '    但【别乱开】:requireEvidence 只给「改了代码」的节点开。勘察类、写文档类节点开了它,收官时必然因「没有构建/测试证据」被打回。',
    '  · 单个节点就能干完 → 直接给 1 个节点;根本不值得拆 → nodes:[] 且 more:"no"(这是合法答案,不是失败)。',
    '    但下这个结论前先对着上面三种形态过一遍:探索 / 排查 / 成文类目标上,"一个节点就能干完"通常是判断失误 ——',
    '    不是任务真的小,是没想到可以按视角拆。',
    '  · 还会有后续但现在说不清 → more:"unknown",别硬凑。',
    '',
    '【输出格式】',
    planSchemaText(),
    '',
    TAIL,
  ])
}

// 宽度那一行。★口径必须与 shapes.widthTarget 同源 —— 提示词要几片、壳层强制几片,
// 两边各写一个数就是"同一件事两份账本",而这正是本仓反复踩过的那类错。
function widthLine(r) {
  const want = SHAPE.widthTarget(r)
  if (want < 2) return '【宽度】这个目标看着是单点实现类 —— 该拆就拆,不该拆就给 1 片,不用凑数。'
  const set = SHAPE.lensSetFor(r.goal) || []
  return '【宽度】这类目标通常有 ' + want + ' 个面要看,请至少给出 ' + want + ' 片【能同时开跑】的(deps 留空)。\n'
    + '  拆不够的话壳层会【自己按视角补齐】—— 补出来的是通用视角(' + set.slice(0, 3).map((l) => l.name).join('、') + '…),\n'
    + '  远不如你按这个项目的实际情况拆得贴切。所以这一版就拆够,别留给代码兜底。\n'
    + '  注意:这不是并发上限。开得比同时能跑的多没关系 —— 多出来的进队列排着,活照样做完。'
}

function planSchemaText() {
  return block([
    '{',
    '  "needGrounding": false,',
    '  "nodes": [{',
    '    "title": "≤20字",',
    '    "goal": "给工人的完整指令正文,不限长(它看不到本次对话)",',
    '    "kind": "work|probe|verify|check|reduce",',
    '    "deps": [], "writeScope": ["src/order"], "contract": ["createOrder"],',
    '    "artifacts": ["docs/order.md"],',
    '    "requireEvidence": false, "requireVerdict": false, "verifyCmd": ""',
    '  }],',
    '  "more": "no|unknown",',
    '  "open": ["还说不清的点"],',
    '  "why": "一句话理由"',
    '}',
    '字段说明:kind 五选一,选错会连累闸的判定 ——',
    '  work   = 干活(改代码 / 写文档 / 做实现),默认用它;',
    '  probe  = 勘察(只读,摸清内部长什么样)。它跑完你会被再问一次,那时再拆;',
    '  verify = 核实(只读,拿【新眼睛】复核别人的结论)。配 requireVerdict,回报要带 VERDICT 行;',
    '  check  = 轻量检查(只读,跑一条命令 / 看一个点就完),比 verify 更短;',
    '  reduce = 汇总蒸馏:把前面若干片的产出【合成一份】最终文档。deps 填要汇总的那些片,artifacts 填最终文档路径。',
    '    ★探索 / 调研 / 成文类目标【必须】留一个 reduce 收尾,否则你交出去的是 N 篇各写各的散装文档 ——',
    '    每片只看得见自己那一角;交叉印证、去重、排先后、把互相矛盾的地方摊开说清楚,只有汇总那一步做得了。',
    '  needGrounding=true 表示"我得先看代码才能拆",此时请把要勘察的内容写成一个 kind:"probe" 节点;',
    '  contract=该节点必须实现的【代码签名】(函数名/类名/接口名/HTTP 端点),壳层会去写归属文件里逐个搜字符串。',
    '    【别把验收要求写进来】——「按功能维度组织内容」这种是句子不是签名,搜不到,写文档类节点直接留空 []。',
    '  artifacts=该节点必须落盘的文件(壳层会核对存在且非空);',
    '  requireEvidence=收官必须有【构建/测试的执行证据】——【只给改了代码的节点开】。',
    '    纯勘察 / 读文档 / 写文档 / 出结论的节点【一律 false】:它们本来就不该跑构建测试,开了必然过不了闸,',
    '    会被打回重做、还告诉工人「你没跑构建/测试」,而它压根没有可跑的东西。',
    '  requireVerdict=回报必须带 VERDICT 行(给 kind:"verify" 的验证节点用);',
    '  verifyCmd=壳层替你跑的一条命令,退出码即判据(不需要就留空串)。',
  ])
}

// ── renderReplan ─────────────────────────────────────────────────────
// ev = 本次触发事件 { event:'node-settled'|'node-failed'|'frontier'|'user-note'|'user-reject'|'user-answer'|'restart', nodeId, at }
// ★契约 §7 列的每一项都必须在:少一项,就等于允许模型说"我没看见"
function renderReplan(run, ev) {
  const r = run || {}
  const e = ev || {}
  const b = r.budget || {}
  const nodes = arr(r.nodes)
  const c = counts(nodes)
  const evNode = nodeById(r, e.nodeId)
  const lastDecAt = lastDecisionAt(r)
  const unverified = nodes.filter((n) => n.result && n.result.unverified && n.state !== 'skipped' && n.state !== 'cancelled')
  const gaps = arr(r.ledger && r.ledger.gaps).map((g) => str(g && (g.text || g.detail) ? (g.text || g.detail) : g)).filter(Boolean)
  const open = arr(r.ledger && r.ledger.open).map((o) => str(o && o.text ? o.text : o)).filter(Boolean)
  const notes = arr(r.userNotes).filter((n) => !n.consumedBy).map((n) => n.text)
  const newFacts = arr(r.ledger && r.ledger.facts).filter((x) => num(x.at) > lastDecAt)
  return block([
    '你是【编排决策器】。看完下面这份【壳层实测的现场】,决定下一步。你不写代码、不读文件、不调任何工具。',
    '',
    '【总目标】',
    str(r.goal),
    '',
    '【进度】共 ' + c.total + ' 个节点 | 已验 ' + c.verified + ' · 在跑 ' + c.running + ' · 排队 ' + c.queued + ' · 待派 ' + c.pending
      + ' · 失败 ' + c.failed + ' · 跳过 ' + c.skipped + ' | 第 ' + num(r.wave) + ' 波',
    '【预算】决策 ' + num(b.spentDecides) + '/' + num(b.maxDecides) + ' · 节点 ' + num(b.spawned) + '/' + num(b.maxNodes)
      + (num(b.invalidStreak) ? ' · 连续不合法 ' + num(b.invalidStreak) : ''),
    '【账本规模】' + ledgerSize(r),
    '',
    renderEvent(r, e, evNode),
    '',
    '【差异检测 —— 代码算出来的,不是任何人自述】',
    renderDiff(r, evNode, newFacts) || '  · (无)',
    '',
    '【节点表】(一行一条)',
    nodes.length ? nodes.map((n) => nodeLine(n)).join('\n') : '  (还没有节点)',
    '',
    '【账本 · 未决】' + (open.length ? '\n' + bullets(open, 15) : ' (无)'),
    '【账本 · 缺口】' + (gaps.length ? '\n' + bullets(gaps, 15) : ' (无)'),
    '【无验证证据的节点】' + (unverified.length
      ? '\n' + unverified.map((n) => '  · ' + n.id + '「' + oneLine(n.title, 40) + '」—— 没有构建/测试的执行证据').join('\n')
      : ' (无)'),
    '【用户插话(未消费)】' + (notes.length ? '\n' + bullets(notes, 8) : ' (无)'),
    r.ask && r.ask.question ? '【你上次问用户的问题】' + oneLine(r.ask.question, 200) : '',
    '',
    '【本次要决定】下一步怎么走:加节点 / 撤掉还没开跑的节点 / 宣布收口 / 要求先勘察 / 问用户。',
    '  · 只有【还没开跑】(待派/排队)的节点能撤;在跑的撤不掉,别往 dropNodes 里放。',
    '  · 失败的节点想再来一次,就把它【拆得更小】重新加进 addNodes —— 原样重派一次不会有不同结果。',
    '  · 拿不准就先给一个 kind:"probe" 的勘察节点,或写进 open;【不确定不是错】,硬编才是。',
    '  · 觉得够了就 done:true 并给 final ——【硬要求】final.gaps 必须逐条覆盖上面【账本 · 缺口】与【无验证证据的节点】里的每一条:',
    '    你可以判定"这条不影响交付"并写明理由,但【不能不提】;漏一条壳层会驳回重问。',
    '  · ★什么都不用改就返回空数组(addNodes:[] dropNodes:[] done:false)—— 这是合法答案,不是失职。',
    '    但"没什么可加的"和"没想到能加什么"是两回事。刚有片收官时,先把这三条过一遍再决定:',
    '      ① 它的产出里有没有【没人核实过】的结论?→ 每条开一个廉价的 kind:"verify" 节点(新眼睛,一两个回合)。',
    '      ② 它只从一个角度看了这批材料吗?→ 换个检查维度再铺一层只读节点(writeScope 留空,可与它重叠)。',
    '      ③ 已经有 ≥2 片各写各的文档了吗?→ 该加 kind:"reduce" 收尾了,否则最终交付就是一堆散装文档。',
    '    少拆不会更稳,只会更慢也更浅 —— 这类目标通常有 ' + (SHAPE.widthTarget(r) || (num(r.concurrency) || 4)) + ' 个面要看,'
      + '当前能同时开跑的只有 ' + SHAPE.parallelHeads(nodes).length + ' 片。',
    '',
    '【输出格式】',
    replanSchemaText(),
    '',
    TAIL,
  ])
}

function replanSchemaText() {
  return block([
    '{',
    '  "needGrounding": false,',
    '  "addNodes": [ /* 字段同规划节点:title/goal/kind/deps/writeScope/contract/artifacts/requireEvidence/requireVerdict/verifyCmd */ ],',
    '  "dropNodes": [{ "id": "n5", "why": "为什么撤" }],',
    '  "done": false,',
    '  "askUser": null,',
    '  "facts": [{ "text": "这一程查明的事实", "anchors": ["src/a.ts:12"] }],',
    '  "open": ["新冒出来的未决"],',
    '  "more": "no|unknown",',
    '  "why": "一句话理由(必填,会留痕给用户看)",',
    '  "final": null',
    '}',
    '字段说明:askUser 形如 { "question":"…", "options":["A","B"] };',
    '  done:true 时 final 必填 { "summary":"…", "deliverables":["路径"], "gaps":["逐条覆盖上面的缺口与无证据节点"] }。',
  ])
}

function counts(nodes) {
  const c = { total: nodes.length, verified: 0, running: 0, queued: 0, pending: 0, failed: 0, skipped: 0, settled: 0, cancelled: 0 }
  for (const n of nodes) if (c[n.state] !== undefined) c[n.state] += 1
  return c
}
function ledgerSize(r) {
  try {
    const s = L.size(r.ledger || {})
    if (s && typeof s === 'object') return '事实 ' + num(s.facts) + ' · 未决 ' + num(s.open) + ' · 缺口 ' + num(s.gaps)
    if (typeof s === 'number') return '条目 ' + s
  } catch (err) { /* 账本形状变了不该拖垮渲染 */ }
  const lg = r.ledger || {}
  return '事实 ' + arr(lg.facts).length + ' · 未决 ' + arr(lg.open).length + ' · 缺口 ' + arr(lg.gaps).length
}
function lastDecisionAt(r) {
  const ds = arr(r.decisions)
  return ds.length ? num(ds[ds.length - 1].at) : 0
}

// 本次事件 + 原因 + exitReport + 产出 + 报告尾部
function renderEvent(r, e, n) {
  const kind = str(e.event) || 'frontier'
  const head = {
    'node-settled': '一个节点通过了退出检查',
    'node-failed': '一个节点最终失败',
    'frontier': '没有在跑的节点了,前沿空了',
    'user-note': '用户插话了',
    'user-reject': '用户打回了方案',
    'user-answer': '用户回答了你的问题',
    'restart': '壳层重启后续接',
  }[kind] || kind
  const lines = ['【本次事件】' + head + '(' + kind + ')']
  if (!n) {
    if (kind === 'frontier') lines.push('  没有节点在跑、也没有可派的节点了。是收口、还是继续加节点,由你判断 —— 壳层不会替你决定。')
    return block(lines)
  }
  lines.push('  节点 ' + n.id + '「' + oneLine(n.title, 40) + '」' + stateCn(n.state) + '(attempt ' + num(n.attempt) + '/' + num(n.maxAttempts) + ' · 第 ' + num(n.wave) + ' 波)')
  if (n.reason) lines.push('  原因: ' + n.reason)
  const rep = arr(n.result && n.result.exitReport)
  if (rep.length) lines.push('  退出检查: ' + rep.map((x) => str(x.kind) + (x.ok ? ' ✓' : ' ✗') + (x.detail ? '(' + oneLine(x.detail, 60) + ')' : '')).join(' / '))
  const files = arr(n.result && n.result.files)
  if (files.length) lines.push('  它的产出: ' + files.slice(0, 12).map(norm).join(', ') + (files.length > 12 ? ' 等 ' + files.length + ' 个' : ''))
  if (n.result && n.result.verdict) lines.push('  VERDICT: ' + n.result.verdict)
  if (n.result && n.result.cmdExit !== null && n.result.cmdExit !== undefined) lines.push('  验证命令退出码: ' + n.result.cmdExit)
  const fin = str(n.result && n.result.final)
  if (fin) lines.push('  报告尾 ' + CAP_FINAL + ' 字:\n' + indent(tail(fin, CAP_FINAL)))
  return block(lines)
}

// 差异检测:声明写归属 vs 实际写了什么 / 契约缺哪个 / 自上次决策后新增的事实
// ★这三项都是代码比对出来的 —— 模型自述"我写完了"不算数
function renderDiff(r, evNode, newFacts) {
  const out = []
  const scan = evNode ? [evNode] : arr(r.nodes).filter((n) => n.state === 'verified' || n.state === 'failed')
  for (const n of scan.slice(0, 6)) {
    // 一律折成相对 run.dir 的路径再比、再显示:既修掉误报,也让节点表短得能看
    const files = arr(n.result && n.result.files).map((f) => relTo(r.dir, f))
    const scope = arr(n.writeScope).map((x) => relTo(r.dir, x))
    if (scope.length) {
      const out1 = files.filter((f) => !inScope(scope, f))
      out.push('  · ' + n.id + ' 声明写归属 ' + scope.join(', ') + ',实际写了 ' + (files.length ? files.slice(0, 8).join(', ') : '(什么都没写)')
        // 措辞如实:result.files 只记【写成功】的文件,所以出现在这儿就说明没被拦住 ——
        // 原文案写"壳层硬闸已拦"是假的,会让模型以为有个被挡下的越权动作要处理
        + (out1.length ? ' ← 其中 ' + out1.join(', ') + ' 落在归属外(写归属声明与实际产出对不上,注意是不是拆错了边界)' : ''))
    } else if (files.length) {
      out.push('  · ' + n.id + ' 未声明写归属,实际写了 ' + files.slice(0, 8).join(', '))
    }
    const miss = arr(n.result && n.result.contractMiss)
    if (miss.length) out.push('  · ' + n.id + ' 契约签名在归属文件里没找到: ' + miss.join(', '))
    else if (arr(n.contract).length && n.state === 'verified') out.push('  · ' + n.id + ' 契约 ' + arr(n.contract).length + '/' + arr(n.contract).length + ' 项已核对到')
  }
  for (const f of newFacts.slice(0, 10)) {
    out.push('  · 自上次决策后新增事实: ' + oneLine(f.text, 160) + (arr(f.anchors).length ? ' [' + arr(f.anchors).slice(0, 3).join(' ') + ']' : '') + (f.src ? '(来自 ' + f.src + ')' : ''))
  }
  return out.join('\n')
}

function nodeLine(n) {
  const mark = STATE_MARK[n.state] || '?'
  const files = arr(n.result && n.result.files)
  const bits = []
  if (files.length) bits.push('→ ' + files.slice(0, 3).map(norm).join(', ') + (files.length > 3 ? ' 等 ' + files.length + ' 个' : ''))
  if (arr(n.contract).length) bits.push('契约 ' + (arr(n.contract).length - arr(n.result && n.result.contractMiss).length) + '/' + arr(n.contract).length)
  if (n.result && n.result.unverified) bits.push('未验证')
  if (num(n.attempt) > 1) bits.push('第 ' + n.attempt + ' 次')
  if (n.reason) bits.push(n.reason)
  if (n.droppedReason) bits.push(n.droppedReason)
  if (arr(n.deps).length) bits.push('等 ' + arr(n.deps).join('/'))
  return '  ' + n.id + ' ' + (str(n.kind) || 'work') + ' ' + mark + ' ' + oneLine(n.title, CAP_GOAL_LINE) + (bits.length ? ' (' + bits.join(' · ') + ')' : '')
}

function stateCn(s) {
  return { pending: '待派', queued: '排队中', running: '在跑', settled: '已落定待判', verified: '已通过', rejected: '被拒回', failed: '失败', skipped: '已跳过', cancelled: '已取消' }[s] || str(s)
}
function indent(s) { return str(s).split('\n').map((x) => '    ' + x).join('\n') }

// ── composeNodeBrief ─────────────────────────────────────────────────
// 给工人的下发文本。工人卡自带《动态工作流规程》(todo / 子 Agent / 落盘 / 128k 纪律 / 交付自检),
// 这里【不重复它】,只给"这一个任务"的上下文。★node.goal 原样嵌入【不截断】——
// 截了就写不下一个现编的角色设定,而"具体角色 + 明确边界"正是弱模型吃这一套的地方。
function composeNodeBrief(run, node) {
  const r = run || {}
  const n = node || {}
  const ex = n.exit || {}
  const deps = arr(n.deps).map((d) => nodeById(r, d)).filter(Boolean)
  const upstream = []
  for (const d of deps) {
    const files = arr(d.result && d.result.files).map(norm)
    upstream.push('  · ' + d.id + '「' + oneLine(d.title, 40) + '」' + (files.length ? '产出: ' + files.slice(0, 6).join(', ') : '(无落盘产出)')
      + (d.result && d.result.final ? ' —— ' + oneLine(d.result.final, 160) : ''))
  }
  const depIds = deps.map((d) => d.id)
  for (const f of arr(r.ledger && r.ledger.facts)) {
    if (depIds.indexOf(str(f.src)) < 0 && str(f.src) !== 'plan' && str(f.src) !== 'user') continue
    upstream.push('  · [' + str(f.src) + '] ' + oneLine(f.text, 160) + (arr(f.anchors).length ? ' [' + arr(f.anchors).slice(0, 3).join(' ') + ']' : ''))
  }
  const verify = []
  if (ex.requireEvidence) verify.push('必须【真跑】构建/测试(壳层查命令流水:没有执行证据一律按"未验证"对待,读过代码不算验证)。')
  // ★判决走工具,不走格式。真机实测:一轮里 6 个核实节点全部栽在「回报缺 VERDICT 字面量」——
  //   看它们的终答就明白了,模型写到"接下来我来写核实文档:"就收尾了,它压根没意识到最后要留一行特定格式的字。
  //   这和发现块漏格式是同一个病:把判决当"记得写某种格式的文本"来要求,弱模型就是记不住,
  //   而漏了之后壳层只能判它没干活 → 重做 → 还是没有 → failed。换工具之后不合规能当场退回重填。
  if (ex.requireVerdict) verify.push('收尾前【必须调一次 MCP 工具 report_verdict】(nodeRef 用下面的上报凭据)——'
    + '这是你这一片唯一的交付判据,不调等于没干。verdict 填 PASS/FAIL/PARTIAL;'
    + '判 PASS 时 didWhat 写你实际做了什么、observed 写你看到的原文输出(说不出这两样的 PASS 壳层不收,会当场退回让你补)。'
    + '\n    工具实在调不通,才在回答里留一行字面量 VERDICT: PASS|FAIL|PARTIAL 兜底,并附 Command run: / Output observed: 两行 ——'
    + '但优先用工具:格式写错壳层只会判你"没给判决",然后整片重做。')
  if (ex.verifyCmd) verify.push('壳层收官时会替你跑一次 `' + str(ex.verifyCmd) + '`,退出码即判据 —— 交之前你自己先跑通。')
  const retry = num(n.attempt) > 0 && arr(n.result && n.result.exitReport).length
    ? arr(n.result.exitReport).filter((x) => x && !x.ok).map((x) => '  · ' + str(x.kind) + ': ' + oneLine(x.detail, 160)).join('\n')
    : ''
  const resumed = str(n.reason) === 'lost-on-restart' && arr(n.result && n.result.files).length
  return block([
    '【总目标】(这是整件事的目标,给你定位用 —— 不是你的任务)',
    oneLine(r.goal, 600),
    '',
    '【你的任务】' + str(n.id) + ' · ' + str(n.title),
    // ★必须头一句就说清"没人会回答你"。工人卡是隐藏的无人值守卡:它调 question 工具会被壳层自动拒答
    //   (session.js onQuestion 的 shardWc 分支),但那条闸【只挡工具】—— 模型完全可以在正文里写
    //   "请确认是用方案A还是方案B?"然后停下等人,没有任何东西拦得住,那一轮就这么空转掉了
    //   (内网实测:分片 Agent 还会问问题)。所以要在指令里断掉它这个念头,并给出替代动作。
    '【你是无人值守工人 —— 没有人会回答你】',
    '  这张卡是隐藏的,不会有人看着它。你提问【不会有人回答】,调 question 工具会被壳层当场拒掉。',
    '  遇到不确定:自己按最合理的方式做决定,把【你做了什么假设、为什么这么选】写进回报的"分歧/遗留"一栏。',
    '  假设写清楚了,判断错了也有人能纠正;停下来等人,这一轮就白跑了。',
    '  只有一种情况可以停:非越界不可能完成(比如要写的文件在写归属之外)—— 那就说明理由并停止,别绕道。',
    '',
    str(n.goal),                                   // ★原样,不截断
    '',
    upstream.length ? '【上游已查明】(别重复劳动,也别推翻它们;要用就直接读这些文件)\n' + upstream.slice(0, 12).join('\n') + '\n' : '',
    arr(n.writeScope).length
      ? '【写归属 · 硬约束】你【只能】写这些路径:' + arr(n.writeScope).map(norm).join(', ')
        + '\n  壳层硬闸:归属外的 write/edit 与 bash 写文件(重定向/tee/sed -i)都会被直接拒。'
        + '\n  非越界不可能完成 → 停下来说明理由,别绕道。'
      : '【写归属】未设(探查类任务):不要改动项目文件。',
    arr(n.contract).length
      ? '【契约签名 · 必须交付】' + arr(n.contract).join(', ')
        + '\n  收官时壳层会拿这些签名去你的归属文件里逐个核对,缺一个就算【契约缺口】—— 不是"看上去做完了"就算完。'
      : '',
    arr(ex.artifacts).length
      ? '【产出路径 · 必须真落盘且非空】' + arr(ex.artifacts).map(norm).join(', ')
      : '【产出】结论与细节一律落盘成文档,不要只写在回答里。',
    // 文档质量下限:弱模型给"写成文档"这四个字,交回来的往往是一页提纲。把"什么算合格"写死。
    '【产出文档的下限 —— 达不到等于没做】',
    '  · 写【你查到的事实】,不是写你打算怎么查:每条结论后面跟证据(文件:行号 / 命令与它的输出 / 接口与它的返回),',
    '    没有证据的话要么去查实,要么标成"待核实",不要混在结论里。',
    '  · 写清楚【具体是什么】,不要写"存在一些问题""建议进一步优化"这类空话 —— 这种句子删掉不影响任何人做决定,',
    '    就说明它本来就不该写。能落到"哪个文件的哪一段、现在是什么样、应该是什么样"才算数。',
    '  · 反例照写:试过但不成立的路子、被排除的猜想,各附一句为什么 —— 下一棒不用再走一遍。',
    '  · 长度服从内容:查到多少写多少。凑字数和只写提纲一样没用。',
    verify.length ? '【验证要求】\n' + verify.map((v) => '  · ' + v).join('\n') : '',
    retry ? '\n【上轮未通过 —— 这一轮就是来修这些的】\n' + retry : '',
    resumed ? '\n【壳层续接】上次运行被中断,磁盘上已有你的产出:' + arr(n.result.files).slice(0, 8).map(norm).join(', ') + ' —— 接着做,别重来。' : '',
    '',
    // ★上报凭据:结构化上报走 MCP 工具,工具要靠它认出"你是哪条编排的哪一片"。
    //   带 runId 是必须的 —— 节点 id 是 run 内序号(n1/n2…),两个工作流同时跑时只认 nodeId 会记错人。
    '【上报凭据】' + str(r.id) + ':' + str(n.id) + '  ← 调 report_findings 时把这一整串原样填进 nodeRef',
    '',
    '【回报格式】做完只回这几样,别贴大段原文(上游只吃索引):',
    '  ① 一句话结论;② 落盘文件路径清单;③ 分歧 / 遗留(没有就写"无")。',
    '',
    '【发现要走工具上报,不要只写在回答里】',
    '  只要你这一片查出了【需要别人复核的具体结论】,收尾前调一次 MCP 工具 report_findings:',
    '    nodeRef = 上面那串上报凭据;findings = [{ severity:"高/中/低", what:"一句话说清是什么问题", evidence:"文件:行号 或 命令 或 接口" }]',
    '  壳层会【逐条派新眼睛去核】,核过的才进最终交付。所以写具体 ——',
    '  "订单金额在 src/order/calc.ts:88 用 float 累加,超 8 位丢精度"是一条;"代码质量有待提高"不是(核不动)。',
    '  条数服从事实:查到几条报几条,没查到就【不要调】这个工具,不用凑数。',
    '  ★工具会回你"收下几条、退回几条、为什么"—— 被退回的说明太笼统,改具体了可以再报一次。',
    '',
    '  (工具实在调不通,就在回答末尾按下面这个块补一遍,壳层会降级解析 —— 但优先用工具:',
    '   格式写错壳层只会看到"这片什么都没查出来",而你并不会收到任何提示。)',
    '<发现>',
    'F| 严重度(高/中/低) | 一句话说清是什么问题 | 证据(文件:行号 或 命令 或 接口)',
    '</发现>',
  ])
}

// ── projectSnapshot ──────────────────────────────────────────────────
// ★run.js 里有一份同源实现 —— 边界表禁止 run/render 互 require,所以各留一份;改一处必须改另一处
function projectSnapshot(run) {
  const r = run || {}
  const nodes = arr(r.nodes)
  const c = counts(nodes)
  return {
    id: r.id, goal: r.goal, phase: r.phase, alias: r.alias,
    counts: { total: c.total, verified: c.verified, running: c.running, queued: c.queued, pending: c.pending, failed: c.failed, skipped: c.skipped },
    wave: r.wave, budget: r.budget,
    nodes: nodes.map((n) => ({
      id: n.id, title: n.title, kind: n.kind, state: n.state, attempt: n.attempt, wave: n.wave,
      cardId: n.cardId, reason: n.reason, files: arr(n.result && n.result.files),
    })),
    decisions: arr(r.decisions).map((d) => ({ at: d.at, point: d.point, why: d.why, invalid: d.invalid })),
    pendingDecision: r.pendingDecision, ask: r.ask || null,
    result: r.result, notes: arr(r.userNotes),
  }
}

module.exports = { renderPlan, renderReplan, composeNodeBrief, projectSnapshot }
