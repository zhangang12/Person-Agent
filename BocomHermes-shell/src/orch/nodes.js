'use strict'
// ── 节点与退出闸(契约 §4)· 纯逻辑,零依赖 ─────────────────────────────────
//
// 职责三件:① 把模型给的节点规格变成合法 Node(makeNode / validateNodeSpecs);
//          ② 收官时机判"这片到底算不算干完了"(evalExit);
//          ③ 上面两件事要用的四个判据函数 —— 全部【原样搬自 window.js】,不做任何"顺手改进"。
//
// 【为什么判据要原样搬】这四个函数是实测被咬出来的形状,不是设计出来的:
//   · VERIFY_CMD 的命令口径(npm ci 不算验证、浏览器动作轨也算证据)是一条条踩出来的;
//   · checkContract 的 100 文件 / 3MB / 1MB 三个 cap 是"巨型归属把收官卡死"之后加的;
//   · parseVerdict 的"PASS 必须带 Command run 块"是"没跑就写 PASS"的直接对策;
//   · safeVerifyCmd 的黑名单 + 白名单更是安全边界。
//   ★ safeVerifyCmd 一行都不许删或放宽:命令的作者【仍然是模型】,只是从报告正文换成了 JSON 字段,
//     信任级别一模一样。字段名变了不等于命令变可信了 —— 这里放宽一个字符,就是给模型开了一条 shell。
//
// 【为什么不碰 IO】evalExit 的文件/命令全部走注入的 probe:
//   { statSync(p), readFileSync(p, enc), readdir(p), exec(cmd, opts) }。
//   本模块不引 fs、不引子进程模块(契约 §1,scripts/orch-boundary-check.mjs 会 grep 检查)——
//   这样退出闸能在没有磁盘、没有壳、没有网络的情况下被逐例断言,影子模式也能拿假 probe 量判准率。
//   路径怎么解析(相对 run.dir 还是绝对)归 probe 决定:本模块不知道 cwd,也不该知道。
//
// 【两条新增的判断,都在 validateNodeSpecs 里】
//   ★ writeScope 两两不交:现状(M11)壳层只做单片"归属内/外",从来没有跨片重叠检测 ——
//     两片同时改一个文件,谁后写谁赢,前一片的活被静默吃掉,而两片都回报"完成"。这是新引擎补的洞。
//   ★ 超 maxNodes 是【截断 + truncated=true】,不是判不合法。
//     把"拆得太多"惩罚成"整份方案作废、退回重问、最后完全不拆",是最坏的降级方向:
//     模型判断对了(这活确实要 30 片),代价却由用户承担。截断留下前 N 个,后续 replan 还能继续加。

const KINDS = ['work', 'probe', 'verify', 'check', 'reduce']

// ── 闸门按 kind 收敛(代码强制,不听模型填)──────────────────────────────
// 病灶(内网实测:"排查、勘查的 Agent 都是固定的闸门,没有跟进不同情况设置不同的闸门"):
// 六类闸此前【完全按模型填的值】生效,而 render.js 只是在提示词里"劝"它别乱开。劝不住的后果是死锁:
//   · probe/勘察节点被开了 requireEvidence → 它本来就不该跑构建测试,收官必然判"没有证据",
//     被打回重做,还告诉工人"你没跑构建/测试"—— 而它压根没有可跑的东西,重跑一万次也是这个结果。
//   · verify/check/reduce 同理:只读节点开 evidence、汇总节点开 verifyCmd,都是必死的组合。
// 这里按"这类节点物理上有没有可能满足这道闸"来收敛 —— 不是放松要求,是拿掉【不可能满足的要求】。
// 收敛放在 makeNode(造节点时)而不是 evalExit(判定时):判定时才拿掉,面板上会一直显示一道
// 永远不会被检查的闸,用户和模型都会被这个假信息误导;造节点时拿掉,盘上存的就是真实生效的闸。
function gatesFor(kind, g) {
  const k = str(kind)
  const out = Object.assign({}, g)
  if (k !== 'work') {
    // 只有 work 会改代码 —— 其余四类都是只读/汇总,没有"构建测试证据"这回事
    out.requireEvidence = false
    // verifyCmd 同理:让勘察/核实/汇总节点去跑一条命令当判据,是把它们当 work 用
    out.verifyCmd = ''
  }
  if (k === 'probe') {
    // 勘察的交付【就是回报本身】(上游拿它去拆下一批),不强制落盘产出。
    // noEmpty 保留:一份都没回报的勘察确实等于没干。
    out.artifacts = []
  }
  if (k === 'verify' || k === 'check') {
    // 核实/检查是只读的:不产文件,判据是 VERDICT 而不是产出
    out.artifacts = []
    out.requireVerdict = true
  } else {
    // ★收敛必须【对称】—— 只把该开的开、不把不该有的关掉,等于只修了一半。
    //   VERDICT 是"核实员的判决行"这个体裁独有的东西:work/probe/reduce 交的是产出与回报,
    //   模型给它们开了 requireVerdict,它们交一份完全正常的回报也会判「回报缺 VERDICT 字面量」,
    //   然后打回重做 —— 又一个重跑一万次都过不去的死锁(与 evidence 那条同构)。
    out.requireVerdict = false
  }
  return out
}
const ORIGINS = ['plan', 'replan', 'user', 'resume']
// 未终结 = 还可能往磁盘上写字。写归属两两不交只对这些节点设防:
// 已 verified/failed/skipped 的节点早写完了,新节点覆盖它的归属是合法的(修补/返工本来就该这么干)。
const ALIVE = ['pending', 'queued', 'running', 'settled', 'rejected']

// ★ 原样搬自 src/window.js:656(VERIFY_CMD)—— 口径一个字不改:
// npm/pnpm/yarn test|build|lint|typecheck|tsc、npm run test|build|check|e2e|verify(npm ci 不算 —— 装依赖不是验证)、
// pytest/vitest/jest/mvn(w)/gradle(w)/make、dotnet test|build、go test|build|vet、cargo test|build|check、npx tsc|vue-tsc|vitest|jest。
const VERIFY_CMD = /(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|typecheck|tsc)\b|npm\s+run\s+(test|build|check|e2e|verify)\b|\b(pytest|vitest|jest|mvnw?|gradlew?|make)\b|\bdotnet\s+(test|build)\b|\bgo\s+(test|build|vet)\b|\bcargo\s+(test|build|check)\b|\bnpx\s+(tsc|vue-tsc|vitest|jest)\b/i
// ★ 原样搬自 src/window.js:720-721(VERDICT 机判)
const VERDICT_RE = /VERDICT:\s*(PASS|FAIL|PARTIAL)\b/
const CMD_RUN_RE = /Command run\s*[:：]/i
// ★ 原样搬自 src/window.js:756-757(抽查重放的安全过滤)——三段缺一不可:
//   ① 行尾括号注释剥离(中英文):「npm test (14 passed)」→「npm test」
//   ② shell 元字符黑名单:报告/JSON 里的文本不能直接进 shell
//   ③ 只读命令白名单:curl 不在里面(打网络不算只读自验)
const PAREN_TAIL_RE = /\s*[（(][^()（）]*[)）]\s*$/
const SHELL_META_RE = /[&|;<>`$()]/
const SAFE_CMD_RE = /^(npm (test|run (build|test|lint|typecheck))|pnpm test|yarn test|pytest|mvn( | -q )(test|compile)|gradle test|go test|npx (vitest|jest))/
// ★ 原样搬自 src/window.js:635-639(契约核对的三个 cap)——防巨型归属把收官卡死
const CAP_FILES = 100
const CAP_TOTAL = 3 * 1024 * 1024
const CAP_ONE = 1024 * 1024
// 退出闸跑命令的参数,原样搬自 src/window.js:760(maxBuffer 8MB:全量测试输出常超 1MB 默认值)
const EXEC_OPTS = { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }

// ── 小工具(不引任何模块)────────────────────────────────────────────────────
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function str(v) { return String(v === null || v === undefined ? '' : v) }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d }
function arr(v) { return Array.isArray(v) ? v : [] }
function strArr(v) {
  if (v === null || v === undefined || v === '') return []
  const list = Array.isArray(v) ? v : [v]
  const out = []
  for (const x of list) { const s = str(isObj(x) ? (x.path || x.text || x.id || '') : x).trim(); if (s && out.indexOf(s) < 0) out.push(s) }
  return out
}
function first() { for (let i = 0; i < arguments.length; i++) { const v = arguments[i]; if (v !== undefined && v !== null) return v } return undefined }

// ── 路径工具:契约 §1 不许引 path,只好手写(逻辑与 writescope.js 的 matchScope 同口径)──
function normSlash(p) { return str(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') }
function isAbsPath(p) { return /^\//.test(p) || /^[A-Za-z]:\//.test(p) }
function resolveRel(p) {
  const segs = []
  for (const s of normSlash(p).split('/')) {
    if (!s || s === '.') continue
    if (s === '..') { if (!segs.length) return null; segs.pop(); continue }   // 跳出根 = 越界
    segs.push(s)
  }
  return segs.join('/')
}
// 写归属项 → 相对 dir 的归一路径;越界返回 { err }
function scopeRel(dir, p) {
  const raw = normSlash(p)
  if (!raw) return { err: '是空路径' }
  if (isAbsPath(raw)) {
    const base = normSlash(dir)
    if (!base) return { err: '是绝对路径,而当前 run 没有工作目录可比对 —— 请写相对工作目录的路径' }
    // 盘符/大小写:Windows 天然不敏感;posix 上同名不同壳的目录同时存在的概率可忽略,这里统一小写比对
    const a = raw.toLowerCase(), b = base.toLowerCase()
    if (a === b) return { rel: '.' }
    if (a.indexOf(b + '/') === 0) return { rel: raw.slice(base.length + 1) }
    return { err: '在工作目录之外(' + base + ')—— 节点只能写工作目录内的文件' }
  }
  const rel = resolveRel(raw)
  if (rel === null) return { err: '用 .. 跳出了工作目录 —— 节点只能写工作目录内的文件' }
  return { rel: rel || '.' }
}
// 两个归属是否相交:相等 / 一个是另一个的目录前缀 / 任一方是整仓('.')
function scopeOverlap(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a === '.' || b === '.') return true
  return (a + '/').indexOf(b + '/') === 0 || (b + '/').indexOf(a + '/') === 0
}
function joinPath(a, b) { return normSlash(a) + '/' + str(b) }

// ── 判据①:验证证据闸 ← src/window.js:657-662 原样 ────────────────────────
// 无证据 ≠ 判失败(那是 exit.requireEvidence 的事),它只回答"跑没跑过构建/测试"。
// 两轨都算证据:bash 命令流水(kind:'cmd')命中 VERIFY_CMD,或浏览器动作轨(kind:'browser',前端自验)。
// 入参兼容:契约签名传动作流水数组;传整个 reg/node 对象时沿用原体的粘性位优先(session.js 波次当场置位)。
function hasVerifyEvidence(actions) {
  const reg = Array.isArray(actions) ? null : (isObj(actions) ? actions : null)
  if (reg && reg.verifyEvidence) return true
  const acts = Array.isArray(actions) ? actions : (reg ? arr(first(reg.actions, reg.result && reg.result.actions, [])) : [])
  return acts.some((a) => a && ((a.kind === 'cmd' && VERIFY_CMD.test(str(a.label))) || a.kind === 'browser'))
}

// ── 判据②:契约缺口核对 ← src/window.js:626-650 原样(去掉 fs,文本由调用方给)──
// 判法是最土的 text.includes(sig):不做正则、不做语义匹配 —— 原体就是这样,改"聪明"了会引进新的假阴性,
// 而这个函数的价值恰恰在于"绝不放过缺斤短两"。texts 可以是字符串数组,也可以是单个大字符串。
// 三个 cap 与原体同值:100 个文件 / 累计 3MB / 单文件 1MB 以上跳过(读不到的跳过,宁可漏检不挡路)。
function checkContract(sigs, texts) {
  const list = strArr(sigs)
  if (!list.length) return []
  let text = '', files = 0
  const src = (texts === null || texts === undefined) ? [] : (Array.isArray(texts) ? texts : [texts])
  for (const t of src) {
    if (files >= CAP_FILES || text.length >= CAP_TOTAL) break
    const s = str(isObj(t) ? (t.text || t.content || '') : t)
    if (s.length > CAP_ONE) continue
    text += '\n' + s
    files++
  }
  return list.filter((sig) => sig && text.indexOf(sig) < 0)
}

// ── 判据③:VERDICT 机判 ← src/window.js:718-721 原样 ──────────────────────
// 无 VERDICT 字面量 → 拒;VERDICT: PASS 但全文没有 Command run 块(没跑就写 PASS)→ 拒。
// FAIL / PARTIAL 是【合法结果】不拒 —— 验证棒报 FAIL 是它干活干对了,该怎么办是模型在 replan 里的决定,
// 代码不在这儿替它把 FAIL 变成"节点失败"(旧引擎那套自动回派/修复循环正是要被消掉的越权)。
function parseVerdict(final) {
  const rep = str(final)
  const vm = rep.match(VERDICT_RE)
  const rejectWhy = !vm ? '回报缺 VERDICT 字面量'
    : (vm[1] === 'PASS' && !CMD_RUN_RE.test(rep) ? 'VERDICT: PASS 但全文没有 Command run 块(没跑就写 PASS)' : '')
  return { verdict: vm ? vm[1] : '', rejectWhy }
}

// ── 判据④:命令安全过滤 ← src/window.js:756-757 原样 ──────────────────────
// 顺序不能换:先剥行尾括号注释,再过黑名单,最后过白名单。
// (顺序换了会放行「npm test $(rm -rf /)」这类:剥注释会把 (rm -rf /) 剥掉只剩 $,黑名单再拦 $ ——
//  两步都在、且是这个顺序,才拦得住。)
// 拿不到安全命令返回 ''(调用方按【跳过】处理,不是判失败)。
function safeVerifyCmd(cmd) {
  const c = str(cmd).trim().replace(PAREN_TAIL_RE, '').trim()
  if (!c) return ''
  if (SHELL_META_RE.test(c)) return ''
  if (!SAFE_CMD_RE.test(c)) return ''
  return c
}

// ── makeNode ─────────────────────────────────────────────────────────────
// 校验 + 补默认 → Node(形状严格照契约 §2,不多不少)。非法字段【抛 Error】,调用方转成 invalid。
// id 必须由外部给(ctx.id 或 ctx.mkId):模块自己造 id = 引入随机/计数器,replay 就重放不出同一个 run。
function makeNode(spec, ctx) {
  const s = isObj(spec) ? spec : {}
  const c = isObj(ctx) ? ctx : {}
  const goal = str(s.goal).trim()
  if (!goal) throw new Error('节点缺 goal(完整指令正文)')
  const kind = str(first(s.kind, 'work')).trim() || 'work'
  if (KINDS.indexOf(kind) < 0) throw new Error('节点 kind 非法:「' + kind + '」,只能是 ' + KINDS.join(' / '))
  const origin = str(first(c.origin, s.origin, 'plan')).trim()
  if (ORIGINS.indexOf(origin) < 0) throw new Error('节点 origin 非法:「' + origin + '」,只能是 ' + ORIGINS.join(' / ') + '(没有 auto —— 代码不造节点)')
  const id = str(first(c.id, '')) || (typeof c.mkId === 'function' ? str(c.mkId('n')) : '')
  if (!id) throw new Error('makeNode 需要 ctx.id 或 ctx.mkId:节点 id 不许由本模块生成(replay 要能重放出同一串 id)')
  const exitIn = isObj(s.exit) ? s.exit : {}
  return {
    id,
    wave: num(first(c.wave, s.wave), 1),
    origin,
    kind,
    // 这条 verify 是在核【哪一片报的发现】。按发现扇出的去重靠它 ——
    // 丢了的话节点每重跑一次就会把同一批发现再派一遍校验(预算按节点数算,几轮就烧穿)。
    sourceNode: str(first(s.sourceNode, '')),
    // 这一片是代码按【哪个视角】铺的(shapes.LENS_SETS 的 key)。补宽的去重靠它 ——
    // 丢了的话每次补宽都会把同一批视角再铺一遍(和 sourceNode 同构的坑,那次是重跑重复派校验)。
    lensKey: str(first(s.lensKey, '')),
    // goal 不截断(契约 §2):截了就写不下一个现编角色;title 缺了从 goal 截 20 字当 UI 标签
    title: str(first(s.title, '')).trim() || goal.slice(0, 20),
    goal,
    brief: str(s.brief),                       // 代码稍后用 composeNodeBrief 填,这里只留位
    deps: strArr(s.deps),
    writeScope: strArr(s.writeScope),
    // 契约签名闸只对【会写代码的节点】成立:它的判法是"去写归属文件里搜这些签名",
    // 而 probe/verify/check 根本没有写归属(verify 的写归属还被 doDispatch 强制成了临时目录),
    // 搜无可搜 → 必然判"契约缺口" → 打回重做 → 再搜无可搜。同 gatesFor 一个道理:
    // 拿掉的是【物理上不可能满足的要求】,不是放松标准。
    contract: (kind === 'work' || kind === 'reduce') ? strArr(s.contract) : [],
    exit: gatesFor(kind, {
      artifacts: strArr(first(s.artifacts, exitIn.artifacts, [])),
      requireEvidence: first(s.requireEvidence, exitIn.requireEvidence) === true,
      requireVerdict: first(s.requireVerdict, exitIn.requireVerdict) === true,
      verifyCmd: str(first(s.verifyCmd, exitIn.verifyCmd, '')).trim(),
      noEmpty: first(s.noEmpty, exitIn.noEmpty) === false ? false : true,
    }),
    state: 'pending',
    attempt: 0,
    // maxAttempts 默认 2 不是 1:闸13(45s 静默即落定)消不掉,一个卡死但仍有心跳的工人会被判 settled、
    // 拿半成品过 exit、大概率 rejected —— 这一次 attempt 是被环境烧掉的,不该算在模型头上(设计 §1.5 取舍1)
    maxAttempts: Math.max(1, num(first(s.maxAttempts, 2), 2)),
    // 补做次数(与 attempt 分开记):退出闸不过时,只差一截的先【原卡补做】——
    // 代码都写完了只是没跑 npm test,却新开一张卡把整片重做一遍,既贵又可能把上一轮做对的部分改坏。
    // 补做用同一张卡同一个会话(上下文还在,它知道自己刚干了什么),补不动才升级成重做。
    patches: 0,
    maxPatches: Math.max(0, num(first(s.maxPatches, 2), 2)),
    cardId: null, wcId: null, sid: null,
    queuedAt: 0, startedAt: 0, lastTurnAt: 0, settledAt: 0,   // 一个时间戳只承担一件事
    result: { final: '', files: [], rounds: 0, aborted: false, exitReport: [], verdict: '', cmdExit: null, contractMiss: [], unverified: false },
    reason: '',
    droppedReason: '',
  }
}

// ── validateNodeSpecs ────────────────────────────────────────────────────
// specs:模型给的节点规格数组(plan.nodes / replan.addNodes,已过 schema.coerce)
// run  :用来取 dir / budget / 已有节点(deps 解析与写归属互斥都要看它)
// ctx  :{ mkId, wave, origin, at } —— id 与波次由调用方给
// → { nodes, errors, truncated }
//   errors 用中文且可直接拼进重问话术(与 schema.validate 同一口径);
//   truncated 只表示"超预算被截断",【不进 errors】—— 它不是模型的错,不该触发重问。
function validateNodeSpecs(specs, run, ctx) {
  const errors = []
  const R = isObj(run) ? run : {}
  const C = isObj(ctx) ? ctx : {}
  const budget = isObj(R.budget) ? R.budget : {}
  const existing = arr(R.nodes)
  const maxNodes = num(budget.maxNodes, 24)
  const spawned = num(budget.spawned, existing.length)
  const room = Math.max(0, maxNodes - spawned)
  const list = Array.isArray(specs) ? specs : (isObj(specs) ? [specs] : [])

  // ★ 超预算 = 截断,不是判不合法
  let truncated = false
  let keep = list
  if (list.length > room) { keep = list.slice(0, room); truncated = true }

  // id 预分配:deps 要按它解析。没注入 mkId 时按已有节点数顺推(确定性的,不读时钟不摇随机,仍可重放)
  const taken = new Set(existing.map((n) => str(n && n.id)).filter(Boolean))
  let seq = existing.length
  const nextId = () => {
    if (typeof C.mkId === 'function') { const v = str(C.mkId('n')); if (v && !taken.has(v)) return v }
    let id
    do { id = 'n' + (++seq) } while (taken.has(id))
    return id
  }

  const recs = []
  keep.forEach((raw, i) => {
    const s = isObj(raw) ? raw : {}
    const title = str(s.title).trim()
    const rec = { spec: s, id: nextId(), bad: false, scope: [], label: '第 ' + (i + 1) + ' 个节点' + (title ? '「' + title.slice(0, 20) + '」' : '') }
    taken.add(rec.id)
    recs.push(rec)
  })

  // ① 逐项:基本形状 + 写归属必须落在 dir 内
  for (const r of recs) {
    const s = r.spec
    if (!str(s.goal).trim()) { r.bad = true; errors.push(r.label + ' 缺 goal —— 每个节点都要有完整的指令正文(不限长度)') }
    const kind = str(first(s.kind, 'work')).trim() || 'work'
    if (KINDS.indexOf(kind) < 0) { r.bad = true; errors.push(r.label + ' 的 kind 是「' + kind + '」,只能填 ' + KINDS.join(' / ') + ' 之一') }
    for (const p of strArr(s.writeScope)) {
      const rr = scopeRel(R.dir, p)
      if (rr.err) { r.bad = true; errors.push(r.label + ' 的写归属「' + str(p) + '」' + rr.err); continue }
      if (r.scope.indexOf(rr.rel) < 0) r.scope.push(rr.rel)
    }
  }

  // ② deps 解析:可以写已有节点 id、本批里的节点标题、本批序号(1 起)、或规格里自带的临时 id
  const alias = new Map()
  for (const r of recs) {
    const s = r.spec
    for (const k of [s.id, s.key, s.name, s.ref]) { const t = str(k).trim().toLowerCase(); if (t && !alias.has(t)) alias.set(t, r.id) }
    const t = str(s.title).trim().toLowerCase()
    if (t && !alias.has(t)) alias.set(t, r.id)
  }
  const existIds = new Set(existing.map((n) => str(n && n.id)))
  for (const r of recs) {
    const out = []
    for (const d of strArr(r.spec.deps)) {
      const key = str(d).trim()
      const low = key.toLowerCase()
      let hit = ''
      if (existIds.has(key)) hit = key
      else if (recs.some((x) => x.id === key)) hit = key
      else if (alias.has(low)) hit = alias.get(low)
      else if (/^\d+$/.test(key)) { const idx = parseInt(key, 10); if (idx >= 1 && idx <= recs.length) hit = recs[idx - 1].id }
      if (!hit) { r.bad = true; errors.push(r.label + ' 的 deps 里「' + key + '」找不到对应节点 —— 依赖只能写已有节点的 id,或本次给出的节点标题'); continue }
      if (hit === r.id) { r.bad = true; errors.push(r.label + ' 依赖了自己 —— deps 里去掉它'); continue }
      if (out.indexOf(hit) < 0) out.push(hit)
    }
    r.deps = out
  }

  // ③ 环检测:有环 = readyNodes 永远为空 = 整个 run 静默死等(没有任何超时能救它),必须当场拦
  const depsOf = new Map()
  for (const n of existing) depsOf.set(str(n && n.id), strArr(n && n.deps))
  for (const r of recs) depsOf.set(r.id, r.deps || [])
  const mark = new Map()
  const walk = (id, trail) => {
    if (mark.get(id) === 2) return null
    if (mark.get(id) === 1) return trail.slice(trail.indexOf(id)).concat(id)
    mark.set(id, 1)
    for (const d of (depsOf.get(id) || [])) {
      const cyc = walk(d, trail.concat(id))
      if (cyc) return cyc
    }
    mark.set(id, 2)
    return null
  }
  for (const r of recs) {
    if (r.bad) continue
    const cyc = walk(r.id, [])
    if (cyc) { r.bad = true; errors.push('依赖成环:' + cyc.join(' → ') + ' —— 这样谁都不会就绪,把其中一条依赖去掉') }
  }

  // ④ ★写归属两两不交(新增,消 M11):本批之间 + 与仍在跑/待跑的老节点之间。
  //   空归属不参与(探查/验证类节点不写文件,与谁都不冲突,口径与 writescope.js 的"归属为空 = 不设闸"一致)。
  const alive = []
  for (const n of existing) {
    if (!isObj(n) || ALIVE.indexOf(str(n.state)) < 0) continue
    const rels = []
    for (const p of strArr(n.writeScope)) { const rr = scopeRel(R.dir, p); if (rr.rel && rels.indexOf(rr.rel) < 0) rels.push(rr.rel) }
    if (rels.length) alive.push({ id: str(n.id), title: str(n.title), scope: rels })
  }
  for (let i = 0; i < recs.length; i++) {
    const a = recs[i]
    if (a.bad || !a.scope.length) continue
    for (let j = i + 1; j < recs.length; j++) {
      const b = recs[j]
      if (b.bad || !b.scope.length) continue
      for (const x of a.scope) for (const y of b.scope) {
        if (!scopeOverlap(x, y)) continue
        b.bad = true
        errors.push(a.label + ' 与 ' + b.label + ' 的写归属重叠(' + x + ' ↔ ' + y + ')—— 两片不许共享可写文件:把共用的文件归其中一片独占,另一片改成只读引用')
      }
    }
    for (const o of alive) {
      for (const x of a.scope) for (const y of o.scope) {
        if (!scopeOverlap(x, y)) continue
        a.bad = true
        errors.push(a.label + ' 的写归属与还没跑完的节点 ' + o.id + (o.title ? '「' + o.title.slice(0, 20) + '」' : '') + ' 重叠(' + x + ' ↔ ' + y + ')—— 换一个不冲突的归属,或先撤掉那个节点')
      }
    }
  }

  // ⑤ 成型
  const nodes = []
  for (const r of recs) {
    if (r.bad) continue
    try {
      nodes.push(makeNode({
        title: r.spec.title, goal: r.spec.goal, kind: r.spec.kind, deps: r.deps,
        writeScope: strArr(r.spec.writeScope), contract: strArr(r.spec.contract),
        artifacts: first(r.spec.artifacts, r.spec.exit && r.spec.exit.artifacts, []),
        requireEvidence: first(r.spec.requireEvidence, r.spec.exit && r.spec.exit.requireEvidence),
        requireVerdict: first(r.spec.requireVerdict, r.spec.exit && r.spec.exit.requireVerdict),
        verifyCmd: first(r.spec.verifyCmd, r.spec.exit && r.spec.exit.verifyCmd, ''),
        noEmpty: first(r.spec.noEmpty, r.spec.exit && r.spec.exit.noEmpty),
        maxAttempts: r.spec.maxAttempts,
        sourceNode: r.spec.sourceNode,
        lensKey: r.spec.lensKey,
      }, { id: r.id, wave: first(C.wave, R.wave, 1), origin: first(C.origin, 'plan'), at: num(C.at, 0) }))
    } catch (e) {
      errors.push(r.label + ' ' + str(e && e.message ? e.message : e))
    }
  }
  return { nodes, errors, truncated }
}

// ── evalExit ─────────────────────────────────────────────────────────────
// 按 node.exit 逐条查,任一不过 → pass=false。所有 IO 走注入的 probe。
// report 每项 { kind, ok, detail }(kind: artifacts|noEmpty|contract|evidence|verdict|cmd);
// 查不了的项(没注入 probe.exec / 命令过不了安全过滤 / 环境性失败)标 skipped:true 且 ok:true ——
// ★ 查不了 ≠ 没通过:把"壳层自己没能力查"算成节点失败,等于按环境噪音惩罚工人,重跑一次还是同样结果。
function collectTexts(scope, probe) {
  const texts = []
  let files = 0, total = 0
  const eat = (fp) => {
    if (files >= CAP_FILES || total >= CAP_TOTAL) return
    try {
      const st = probe.statSync(fp)
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        const names = (typeof probe.readdir === 'function' ? probe.readdir(fp) : []) || []
        for (const name of names) eat(joinPath(fp, name))       // 浅递归,与 window.js:638 同形
        return
      }
      if (st && num(st.size, 0) > CAP_ONE) return
      const t = str(probe.readFileSync(fp, 'utf8'))
      texts.push(t); files++; total += t.length
    } catch (e) {}                                              // 读不到的跳过:宁可漏检不挡路(原体同款)
  }
  if (typeof probe.statSync !== 'function' || typeof probe.readFileSync !== 'function') return texts
  for (const s of strArr(scope)) eat(s)
  return texts
}

// exec 的返回形状不强求:数字退出码、{code}/{status}/{exitCode}、或抛异常,都认
function execCode(r, thrown) {
  const e = thrown || (isObj(r) ? first(r.err, r.error, null) : null)
  const code = typeof r === 'number' ? r : (isObj(r) ? num(first(r.code, r.status, r.exitCode), null) : null)
  const msg = str(e && (e.message || e.code) ? (e.message || e.code) : (e || ''))
  // 环境性失败(超时/缓冲区爆/命令不存在)不算"没通过",与 window.js:763 同口径
  const envFail = !!(e && (e.killed || e.code === 'ENOBUFS' || e.code === 127)) || code === 127 || /ENOBUFS|maxBuffer|timed?\s*out/i.test(msg)
  return { code: (code === null || code === undefined) ? (e ? 1 : 0) : code, envFail, msg }
}

// 「像不像一个代码签名」:签名是标识符(函数名/类名/接口名/端点),不是一句话。
// 判据保守 —— 只滤掉明显不是的,宁可漏过不可错杀:太长 / 含中文标点或中文字符 / 含空格且不是 HTTP 端点。
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*$/i
function looksLikeSignature(x) {
  const t = str(x).trim()
  if (!t || t.length > 80) return false
  if (ENDPOINT_RE.test(t)) return true
  if (CJK_RE.test(t)) return false          // 中文/中文标点 → 是描述不是标识符
  if (/\s/.test(t)) return false            // 含空格 → 是句子不是标识符
  return true
}

function evalExit(node, probe) {
  const n = isObj(node) ? node : {}
  const p = isObj(probe) ? probe : {}
  const exit = isObj(n.exit) ? n.exit : {}
  const res = isObj(n.result) ? n.result : {}
  const report = []
  const add = (kind, ok, detail, skipped) => {
    const it = { kind, ok: !!ok, detail: str(detail) }
    if (skipped) it.skipped = true
    report.push(it)
    return it
  }

  // 产出对不上时,把【这一轮实际写了什么】一起说出来。
  // ★原来失败只报一句"docs/x.md 不存在" —— 节点被打回重跑,模型不知道自己错在哪,
  //   十有八九原样再写一遍同一个别的名字,于是"跑 1~2 次才过"。而绝大多数这类失败根本不是没干活:
  //   要么写在了别的路径(声明 docs/需求分析报告.md、实际写 docs/需求分析.md),
  //   要么落在了子目录里。同名不同径的情况单独点破,模型一眼就知道该改声明还是改文件名。
  //   注:files 只记到"壳层观察到的 write/edit 工具调用",慢端点丢事件时可能是空的 —— 空就不硬说,只提示没观察到。
  const baseOf = (x) => str(x).replace(/\\/g, '/').split('/').pop()
  function wroteHint(want) {
    const wrote = strArr(res.files)
    if (!wrote.length) return '(本轮没观察到任何 write/edit 落盘 —— 可能真没写,也可能是慢端点把工具事件丢了)'
    const same = wrote.filter((f) => baseOf(f) === baseOf(want))
    if (same.length) return '(但本轮写了同名不同径的文件:' + same.slice(0, 3).join('、') + ' —— 要么改声明要么改落盘路径)'
    return '(本轮实际写了:' + wrote.slice(0, 5).join('、') + (wrote.length > 5 ? ' 等 ' + wrote.length + ' 个' : '') + ')'
  }

  // ① artifacts:必须存在且非空(0 字节的文件是"创建了但没写"的典型形态,不算产出)
  for (const a of strArr(exit.artifacts)) {
    if (typeof p.statSync !== 'function') { add('artifacts', true, a + ':未注入 probe.statSync,跳过', true); continue }
    let st = null, err = ''
    try { st = p.statSync(a) } catch (e) { err = str(e && e.message ? e.message : e) }
    if (!st) { add('artifacts', false, a + ' 不存在' + (err ? '(' + err.slice(0, 80) + ')' : '') + wroteHint(a)); continue }
    if (typeof st.isDirectory === 'function' && st.isDirectory()) {
      const names = (typeof p.readdir === 'function' ? (function () { try { return p.readdir(a) } catch (e) { return null } })() : null)
      if (names === null) { add('artifacts', true, a + ':是目录,没法查空(未注入 probe.readdir),跳过', true); continue }
      add('artifacts', names.length > 0, a + ' 是空目录'.replace('是空目录', names.length > 0 ? ('(目录,' + names.length + ' 项)') : ' 是空目录'))
      continue
    }
    const size = num(st.size, 0)
    add('artifacts', size > 0, a + (size > 0 ? '(' + size + ' 字节)' : ' 是空文件(0 字节)' + wroteHint(a)))
  }

  // ①b reduce 实质性闸:汇总节点的产出必须【真的引用了被汇总的那些片】。
  // 只查存在+非空挡不住"汇总"退化成两段话 —— 而这正是最容易发生的:模型没读上游产出,
  // 照着标题编一篇通顺的空文,artifacts 与 noEmpty 全过。
  // 判据刻意选"有没有提到上游的产出路径"而不是字数:字数能凑,引用不能 ——
  // 没读过就写不出那些路径。要求提到 ≥2 个(只提 1 个说明它只看了一片,不算汇总)。
  // upstreamArtifacts 由调用方(index.js)从 deps 节点上采好塞进 probe,run.js 不读盘。
  if (str(n.kind) === 'reduce' && strArr(exit.artifacts).length) {
    const ups = strArr(p.upstreamArtifacts)
    if (typeof p.readText !== 'function') add('substance', true, '未注入 probe.readText,跳过', true)
    else if (ups.length < 2) add('substance', true, '上游产出不足 2 个,实质性闸不适用,跳过', true)
    else {
      let txt = ''
      try { txt = str(p.readText(strArr(exit.artifacts)[0])) } catch (e) { txt = '' }
      const baseOf2 = (x) => str(x).replace(/\\/g, '/').split('/').pop()
      const cited = ups.filter((u) => txt.includes(u) || (baseOf2(u) && txt.includes(baseOf2(u))))
      add('substance', cited.length >= 2,
        cited.length >= 2
          ? '汇总引用了 ' + cited.length + '/' + ups.length + ' 个上游产出'
          : '汇总只引用了 ' + cited.length + '/' + ups.length + ' 个上游产出(没读上游就写不出这些路径 —— 大概率是照标题编的空文,请逐个读完再写)')
    }
  }

  // ② noEmpty:零产出 = 网关静默 / 空答耗尽的典型形态,不能叫完成
  // ★判据必须包含【磁盘】。原来只看 res.final 与 res.files,而这两份都是"观察来的":
  //   · final 挂在回合正常收尾上,回合报错/超时就是空的(4243cb5 已补了回 serve 拉原文的回填);
  //   · files 只来自壳层偷看 write/edit 工具事件(认 filePath|path|filename),
  //     内网 fork 换个入参名、或慢端点丢了事件,落盘就全隐形。
  //   于是出现"每轮都有文档生成,却判零产出"。磁盘上真有非空产出,那就definitionally不是零产出 ——
  //   声明的 artifacts 存在且非空即可作数(上面 ① 已经逐个 stat 过,这里直接复用它的结论,不重复读盘)。
  if (exit.noEmpty !== false) {
    const hasFinal = !!str(res.final).trim()
    const hasFiles = arr(res.files).length > 0
    const artOk = report.some((x) => x.kind === 'artifacts' && x.ok && !x.skipped)   // 磁盘实证:声明产出确实在且非空
    const why = hasFinal ? '有回报' : hasFiles ? '有文件产出' : artOk ? '声明产出已在磁盘上(终答/工具事件没收到,但活确实干了)' : ''
    add('noEmpty', hasFinal || hasFiles || artOk, why || '既没有终答、也没有文件产出、声明产出在磁盘上也找不到(零产出)')
  }

  // ③ contract:签名要在写归属文件里找得到
  //   ★先滤掉"不像签名"的条目。实测踩中:模型把【验收要求】填进了 contract ——
  //     ['按功能维度（非技术分层）组织内容', '覆盖仓库中所有功能模块。格式：每个模块给出目录路径', …],
  //     而这道闸是拿它去产出文件里做【子串搜索】,于是永远搜不到 → 文件明明写出来了(5284 字节)
  //     还是被判死 → 补做 2 次 → 重做 → 循环。签名是标识符:没有空格、没有中文标点、不会有一整句话。
  //     滤掉不代表放过 —— 报告里如实标出来,让模型下一轮知道自己填错了字段。
  let contractMiss = []
  const allSigs = strArr(n.contract)
  const sigs = allSigs.filter(looksLikeSignature)
  const junk = allSigs.filter((x) => !looksLikeSignature(x))
  if (junk.length) add('contract', true, 'contract 里有 ' + junk.length + ' 条不像代码签名的条目(疑似把验收要求写进了该字段),已跳过:' + junk.map((x) => str(x).slice(0, 24)).join(' / '), true)
  if (sigs.length) {
    const scope = strArr(n.writeScope)
    if (!scope.length) add('contract', true, '本节点没有写归属,契约核对跳过', true)      // 与原体 :631 早退同口径
    else {
      contractMiss = checkContract(sigs, collectTexts(scope, p))
      add('contract', contractMiss.length === 0, contractMiss.length ? ('缺 ' + contractMiss.join(', ')) : ('签名齐 ' + sigs.length + '/' + sigs.length))
    }
  }

  // ④ evidence:跑没跑过构建/测试
  const acts = arr(first(res.actions, n.actions, (typeof p.actions === 'function' ? p.actions(n) : null), []))
  const hasEv = hasVerifyEvidence(acts.length ? acts : n)
  // unverified 是【信息位】不是判据:render 的"无验证证据的节点清单"靠它,done:true 的硬校验也靠它。
  // 没有写归属的节点(探查/收口)不进这个统计 —— 原体给验证棒与索引棒开的豁免,在新引擎里等价于这一条。
  // 【不写任何文件的节点不进证据闸】—— 不是替模型翻案,是这道闸对它【无解】:
  // 纯勘察/读文档类节点没有可构建可测试的东西,requireEvidence 一开就必然不过 → 打回补做 →
  // 工人收到"你没跑构建/测试"却压根没有可跑的东西 → 补做次数烧完 → failed。这是个不可能赢的循环。
  // (第一次真跑就踩中:模型给 4 个勘察节点全开了 requireEvidence。提示词已同步改,这里是代码侧的兜底。)
  // 判据用 writeScope 而不是 kind:它就是 session.js 写归属硬闸的口径 —— 写不了文件 = 改不了代码。
  // 「有没有代码可构建可测试」:光看"有没有写归属"不够 —— 只写 .md 的文档节点也有写归属,
  // 但它同样没有可跑的构建/测试(实测:一个只产出 docs/结构速览.md 的节点被要求给构建证据,死循环)。
  const codeNode = strArr(n.writeScope).some((w) => !/\.(md|markdown|txt|rst|adoc|csv|json5?|ya?ml)$/i.test(str(w).trim()))
  const unverified = (exit.requireEvidence && codeNode) ? !hasEv : (codeNode && !hasEv)
  if (exit.requireEvidence) {
    if (codeNode) add('evidence', hasEv, hasEv ? '有构建/测试执行证据' : '没有任何构建/测试执行证据(本节点声明了 requireEvidence)')
    else add('evidence', true, '本节点没有写归属(不写任何文件),没有可跑的构建/测试 —— 证据闸不适用,跳过', true)
  }

  // ⑤ verdict:要 VERDICT 字面量,且 PASS 必须带 Command run 块
  const pv = parseVerdict(res.final)
  if (exit.requireVerdict) add('verdict', !pv.rejectWhy, pv.rejectWhy || ('VERDICT: ' + pv.verdict))

  // ⑥ verifyCmd:退出码即判据
  let cmdExit = null
  const rawCmd = str(exit.verifyCmd).trim()
  if (rawCmd) {
    const safe = safeVerifyCmd(rawCmd)
    if (!safe) add('cmd', true, '命令没通过安全过滤,跳过:' + rawCmd.slice(0, 60), true)
    else if (typeof p.exec !== 'function') add('cmd', true, '未注入 probe.exec,跳过:' + safe, true)
    else {
      let r = null, thrown = null
      const opts = { cwd: first(n.dir, p.cwd, undefined), timeout: EXEC_OPTS.timeout, maxBuffer: EXEC_OPTS.maxBuffer, windowsHide: true }
      try { r = p.exec(safe, opts) } catch (e) { thrown = e }
      const ec = execCode(r, thrown)
      if (ec.envFail) add('cmd', true, '「' + safe + '」环境性失败,跳过:' + ec.msg.slice(0, 80), true)
      else { cmdExit = ec.code; add('cmd', ec.code === 0, '「' + safe + '」退出码 ' + ec.code) }
    }
  }

  return {
    pass: report.every((x) => x.ok),
    report,
    contractMiss,
    unverified,
    verdict: pv.verdict,
    cmdExit,
  }
}

module.exports = {
  makeNode,
  validateNodeSpecs,
  evalExit,
  hasVerifyEvidence,
  checkContract,
  parseVerdict,
  safeVerifyCmd,
  VERIFY_CMD,
  KINDS,
}

// ── 最小验证(独立可跑)──────────────────────────────────────────────────────
// 整段贴进 node REPL,或存成文件后 node 它;全绿打印 nodes ok。
//
// const N = require('./src/orch/nodes.js')
// const assert = require('assert')
// // ① 四个判据原样:VERIFY_CMD / 契约 / VERDICT / 安全过滤
// assert.strictEqual(N.hasVerifyEvidence([{ kind: 'cmd', label: 'npm ci' }]), false)          // 装依赖不是验证
// assert.strictEqual(N.hasVerifyEvidence([{ kind: 'cmd', label: 'npm run build' }]), true)
// assert.strictEqual(N.hasVerifyEvidence([{ kind: 'browser', label: 'navigate' }]), true)     // 前端自验也算
// assert.deepStrictEqual(N.checkContract(['createOrder', 'createPayment'], ['function createOrder(){}']), ['createPayment'])
// assert.deepStrictEqual(N.parseVerdict('VERDICT: PASS\n没跑就写'), { verdict: 'PASS', rejectWhy: 'VERDICT: PASS 但全文没有 Command run 块(没跑就写 PASS)' })
// assert.strictEqual(N.parseVerdict('VERDICT: FAIL\n随便').rejectWhy, '')                      // FAIL 是合法结果
// assert.strictEqual(N.safeVerifyCmd('npm test (14 passed)'), 'npm test')                     // 剥括号注释
// assert.strictEqual(N.safeVerifyCmd('npm test $(rm -rf /)'), '')                             // 元字符黑名单
// assert.strictEqual(N.safeVerifyCmd('curl http://x'), '')                                    // 不在白名单
// // ② writeScope 两两不交 + 超预算截断(截断不进 errors)
// const run = { dir: '/repo', wave: 1, nodes: [], budget: { maxNodes: 2, spawned: 0 } }
// const r1 = N.validateNodeSpecs([
//   { title: 'A', goal: 'a', writeScope: ['src/order'] },
//   { title: 'B', goal: 'b', writeScope: ['src/order/api.ts'] },
//   { title: 'C', goal: 'c' },
// ], run, { origin: 'plan' })
// assert.strictEqual(r1.truncated, true)                       // 3 个规格,预算只剩 2 → 截断
// assert.strictEqual(r1.nodes.length, 1)                       // B 与 A 归属重叠被拦
// assert.ok(/重叠/.test(r1.errors.join(';')))
// // ③ deps 按标题解析 + 越界归属被拦 + 环被拦
// const r2 = N.validateNodeSpecs([
//   { title: '契约', goal: '出契约', kind: 'probe' },
//   { title: '迁移', goal: '按契约迁移', deps: ['契约'], writeScope: ['../外面'] },
// ], { dir: '/repo', nodes: [], budget: { maxNodes: 9, spawned: 0 } }, { origin: 'plan' })
// assert.strictEqual(r2.nodes.length, 1)
// assert.ok(/跳出了工作目录/.test(r2.errors.join(';')))
// // ④ evalExit 全走注入 probe
// const probe = {
//   statSync: (p) => (p === 'docs/a.md' ? { size: 12, isDirectory: () => false } : (p === 'src/pay.ts' ? { size: 30, isDirectory: () => false } : null)),
//   readFileSync: () => 'export function createPayment(){}',
//   readdir: () => [],
//   exec: () => 0,
// }
// const node = N.makeNode({ goal: '迁移 pay', writeScope: ['src/pay.ts'], contract: ['createPayment', 'refund'], artifacts: ['docs/a.md'], verifyCmd: 'npm test' }, { id: 'n1' })
// node.result.final = 'done'
// const ex = N.evalExit(node, probe)
// assert.strictEqual(ex.pass, false)
// assert.deepStrictEqual(ex.contractMiss, ['refund'])
// assert.strictEqual(ex.cmdExit, 0)
// assert.strictEqual(ex.unverified, true)                      // 有写归属却没有验证证据 → 信息位置起
// console.log('nodes ok')
