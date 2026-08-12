'use strict'
const { exec } = require('child_process')
const os = require('os')
const knowledge = require('./knowledge')
const writescope = require('./writescope')
const spin = require('./spin')   // 空转探测(think-loop):区分"在长考"与"在原地打转"   // 分片写归属硬闸(编码模式):write/edit 越界拒

// 验证证据机判正则(构建/测试命令长什么样):bash 命令流水命中即算"跑过验证"。
// ⚠ window.js 同款保持同步(证据闸 hasVerifyEvidence 用同一份)—— 改这里必须同步改那边,两边逐字一致。
// 口径:npm/pnpm/yarn (run)?(test|build|lint|typecheck|tsc|check|e2e|verify)(npm ci 不算验证:装依赖≠跑验证)、
// pytest/vitest/jest/mvn/mvnw/gradle/gradlew/make、dotnet test|build、go test|build|vet、cargo test|build|check、npx tsc|vue-tsc。
const VERIFY_CMD = /(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|typecheck|tsc|check|e2e|verify)\b|\b(pytest|vitest|jest|mvnw?|gradlew?|make)\b|\bdotnet\s+(test|build)\b|\bgo\s+(test|build|vet)\b|\bcargo\s+(test|build|check)\b|\bnpx\s+(tsc|vue-tsc)\b/i

// deps 可选项:replaceHistoryId(oldId, newId) —— stale 重开时把旧历史条目原地换 id(保留 created/title/model);
// 没给就退化为现状(recordHistory 新增条目)。由 window.js 装配层接线。
module.exports = function initSession(S, { ipcMain, path, fs, shell, oc, log, recordHistory, touchHistory, replaceHistoryId }) {
  // ── 工具规程(壳层级,每个会话首条都注入)──────────────────────────────────
  // ★为什么在这儿而不是写进项目的 AGENTS.md(2026-08-12 用户点出来的设计错误):
  //   这些规矩跟【项目】一点关系都没有 —— 浏览器工具怎么用、卡住怎么办、反向用例怎么写,
  //   换个项目一模一样。写进 AGENTS.md 就是:有 N 个项目要写 N 遍,改一条要改 N 遍,
  //   而且新项目在第一次生成 AGENTS.md 之前完全没有这些规矩。
  //   AGENTS.md 该留的是【这个项目怎么构建/怎么测/入口在哪】那种真·项目知识。
  //   我前几轮把 5 条通用规矩塞进了 AGENTS.md,这里把它们收回壳层。
  // ★注入进首条消息 = 每个项目、每个新会话自动带上,改一处全生效。
  //   代价是每个会话多几百字 —— 值:它省掉的是"模型上来先用 playwright 试一遍"那种整轮浪费。
  function loadToolRules() {
    return '<工具规程>\n'
      + '· 浏览器自动化【一律先用内嵌的 browser_* 工具】。不要用 playwright/puppeteer,也不要用 headless_*:\n'
      + '  那些都是另一个浏览器 —— 没有用户当前的登录态、用户看不见、跑完拿不出报告;内嵌那套三样全有。\n'
      + '  确实做不到再说明原因、征得用户同意后降级。\n'
      + '· ★【项目根 AGENTS.md 由你自己维护】,和写代码一样用 write/edit 改它,没有就建一份。\n'
      + '  搞清楚这个项目怎么登录(账号从哪来、有没有验证码闸门)、地址端口、怎么跑回归、踩过什么坑之后,\n'
      + '  当场写回去 —— serve 每轮自动注入项目根 AGENTS.md,写进去,下一个会话和别人的会话开局就读到;\n'
      + '  不写,下一个人(和下一个你)把你今天试错的半天原样重走。这不是可选的收尾,是这件事的一半。\n'
      + '  按文档自己的结构写,别新造机器专属区块 —— 它是给人和 Agent 一起读的,而且它在 git 里,\n'
      + '  会被 review、写错了能改能回退。开发种子账号可以写(它本来就在仓库的 seed/e2e 脚本里);\n'
      + '  生产 token/密钥只写"从哪里取",不写值 —— 那个一旦 commit 就永久留在 git 历史里。\n'
      + '· ★动手点之前先在【代码里】找答案:登录账号/端口/接口路径/权限规则/有没有验证码闸门,\n'
      + '  这些 UI 上看不出来,但项目里通常直接写着 —— AGENTS.md / README / .env* / seed·fixture 脚本 /\n'
      + '  现成的 e2e 用例。一次 grep 换掉半天试错。browser_open 若扫到线索会直接列在回执里。\n'
      + '· ★页面报"登录失败/操作没反应"时,别在页面上继续猜:先看那次请求的【状态码和响应体】\n'
      + '  (browser_assert{kind:"request_status"} / browser_diag 有 console 与网络记录)。\n'
      + '  真因多在后端(闸门要验证码、账号被锁、CORS、代理没转发),UI 上只看得到一句"密码错误"。\n'
      + '· 定位不到元素:用 browser_read 重新拿 ref(页面变过旧 ref 必失效)/ browser_html 看 DOM 结构 /\n'
      + '  browser_eval 直接查。【不要猜选择器】—— 猜错的代价是点到别的元素上还报成功。\n'
      + '· 同一个动作失败两次就别试第三次:换手段,或者停手把"试了什么、卡在哪、页面什么样"告诉用户。\n'
      + '  继续试只是浪费额度,而用户看一眼可能三秒就知道原因。\n'
      + '· 判断"这页看起来对不对"(布局/样式/图表/弹窗遮挡)用 browser_see:它让视觉模型看图、把结果用文字给你。\n'
      + '  你自己多半读不了图,而 read/eval/html 是结构性的,回答不了这类问题。涉及具体数值再用 eval 核一次。\n'
      + '· ★开工前先看有没有现成的:browser_open 的回执会列出【这个站点已沉淀的流程】,有就先 skill_run 跑它,\n'
      + '  别从零试错一遍 —— 那些是之前真跑通过的,还带选择器自愈。\n'
      + '· 你的操作流程会在 browser_close 时【自动沉淀】进技能库,不用你记着存;同一条路重跑只会合并成一条。\n'
      + '  只有想给它起个更准的名字时才调 browser_save_flow(覆盖同一条)。密码步不存明文。\n'
      + '· 等东西要等【条件】不要等时间:browser_act{action:"wait",until:"hidden",ref:…} 等 loading 消失、\n'
      + '  until:"visible" 等表格出来、urlContains 等跳转完成。盲睡是最常见的假失败来源。\n'
      + '· 页面弹"确认删除吗"这类原生弹窗:默认会被【点取消】(默认同意一次删除就是事故)。\n'
      + '  要点确定就在触发它之前先 browser_act{action:"dialog",accept:true};弹窗实际问了什么,browser_read 回执里能看到。\n'
      + '· 不必每次从登录开始:browser_state{action:"save",name:"…"} 存一份登录态,别的会话 load 就能直接用;\n'
      + '  要测未登录的表现就 action:"clear"。\n'
      + '· canvas/地图/图表【内部】没有 DOM 可选,用 browser_act{action:"point",ref:…,x:…,y:…}(相对元素左上角的偏移);\n'
      + '  拖拽(排序/滑块/看板)用 action:"drag" —— 两者都是合成事件,做完【必须再读一次核结果】,别凭"没报错"当成功。\n'
      + '· 造"带伪造/过期 token"这类反向场景用 browser_cookie(set/delete),改完 navigate 一次才生效;\n'
      + '  httpOnly 的 cookie 只有它看得到 —— browser_eval 里的 document.cookie 读不到。\n'
      + '· 反向用例(故意输错、期望被拦):用 request_status 断言后端确实拒了(如 "/api/x 400"),\n'
      + '  或 no_request 断言前端根本没发出去;同时给 no_failed_request / no_console_error 的 expect 填豁免片段,\n'
      + '  否则预期内的报错会把一条正确的反例判成失败。页面弹红字只能证明前端显示了什么,不能证明后端拒了。\n'
      + '</工具规程>\n\n'
  }

  // ── 个人记忆库 ──────────────────────────────────────────────────────────────
  const memoryFile = path.join(require('electron').app.getPath('userData'), 'memory.md')
  // 注入预算:记忆只增不减,不设上限会把每张卡首条消息的基线越垫越高(128k 口径)。超预算保留【最新】一段(相关性新→旧),截断处明示。
  const MEMORY_INJECT_MAX = 3000
  function loadMemory() {
    try {
      let t = fs.readFileSync(memoryFile, 'utf8').trim()
      if (!t) return ''
      if (t.length > MEMORY_INJECT_MAX) t = '…(早期记忆已省略,完整见 userData/memory.md)\n' + t.slice(-MEMORY_INJECT_MAX)
      return `<个人记忆>\n${t}\n</个人记忆>\n\n`
    } catch { return '' }
  }
  ipcMain.handle('memory-read', () => { try { return fs.readFileSync(memoryFile, 'utf8') } catch { return '' } })
  ipcMain.handle('memory-write', (_e, text) => { try { fs.writeFileSync(memoryFile, text, 'utf8'); return true } catch { return false } })

  // ── 成果抽屉读文件 ──────────────────────────────────────────────────────────
  // 卡片「成果预览」点产出文件 → 读回内容渲染。只放行用户自己的地盘(全局/本卡项目目录、后端目录、userData),
  // 防模型给来的路径任意读盘。判包含用 realpath + path.relative(防 /proj2 蹭 /proj 前缀、防 ../ 逃逸、
  // 防 macOS /tmp→/private/tmp 这类符号链接误判);>512KB 不读 —— 抽屉是预览,不是编辑器。
  const READ_FILE_MAX = 512 * 1024
  const realpathOrSelf = (x) => { try { return fs.realpathSync(x) } catch { return x } }
  ipcMain.handle('read-file-text', (_e, absPath) => {
    try {
      const p0 = String(absPath || '').trim()
      if (!p0) return { ok: false, err: '路径为空' }
      const p = realpathOrSelf(path.resolve(p0))
      const roots = [S.settings.projectDir, S.settings.backendDir]
      if (S.cardDir) for (const d of S.cardDir.values()) roots.push(d)   // 本卡可能单独切过目录(cardDir),与全局 projectDir 不同
      roots.push(require('electron').app.getPath('userData'))
      const inRoot = roots.filter(Boolean).some((r) => {
        const rel = path.relative(realpathOrSelf(path.resolve(String(r))), p)
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
      })
      if (!inRoot) return { ok: false, err: '路径不在项目目录/userData 之内，已拦截' }
      const st = fs.statSync(p)
      if (!st.isFile()) return { ok: false, err: '不是普通文件' }
      if (st.size > READ_FILE_MAX) return { ok: false, err: '文件超过 512KB（实际 ' + Math.round(st.size / 1024) + 'KB），不预览' }
      return { ok: true, text: fs.readFileSync(p, 'utf8') }
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })

  // ── 项目上下文注入 ──────────────────────────────────────────────────────────
  function loadProjectContext(dir) {
    if (!dir) return ''
    // 去重(首轮基线 ~60k 治理):serve 会自动注入项目根的 AGENTS.md(opencode 上游行为)——
    // 有 AGENTS.md 时壳层不再注入 README/CLAUDE(同一份项目文档不缴两遍税);
    // 没有才由壳层兜底注入(弱 serve/fork 可能不注入,别让模型裸奔)。
    let hasAgentsMd = false
    for (const n of ['AGENTS.md', 'agents.md']) { try { if (fs.existsSync(path.join(dir, n))) { hasAgentsMd = true; break } } catch {} }
    const candidates = hasAgentsMd ? [] : ['CLAUDE.md', 'claude.md', 'README.md', 'readme.md', 'README']
    const parts = []
    const seen = new Set()
    for (const name of candidates) {
      try {
        const p = path.join(dir, name)
        const key = p.toLowerCase()   // Windows 大小写不敏感:README.md 与 readme.md 命中同一文件 → 去重,别注入两遍
        if (seen.has(key)) continue
        seen.add(key)
        if (!fs.existsSync(p)) continue
        const content = fs.readFileSync(p, 'utf8').slice(0, 2500)   // 预算收紧:单文件 4000→2500 字符
        parts.push(`## ${name}\n${content.trim()}`)
        if (parts.join('').length > 3500) break   // 预算收紧:合计 5500→3500 字符
      } catch {}
    }
    // 显式锚定工作目录(唯一真相源):外部/global 模式的 serve 常忽略会话级 ?directory=,模型会漂到
    // 其它项目路径(如桌面同级目录)。用强指令把它钉在当前项目 —— 也会传导到它派生的 task 子agent的探索路径。
    // 配了后端仓库(backendDir)时放开只读副仓:跨仓探查可读不可写(写仍只落主仓)—— 脚本仓/后端仓场景的硬通道。
    const backend = S.settings.backendDir || ''
    const anchor = `当前项目工作目录（主仓,唯一可写真相源）：${dir}\n`
      + (backend ? `副仓（只读,跨仓探查允许）：${backend}\n写与改只落主仓;副仓可以 grep/glob/read 读,但【严禁】写、改、删它;其它路径仍不许访问。\n`
                 : `分析、探索、读写代码时一律在此目录内进行;不要访问或分析其它路径下的项目/目录。\n`)
    // 上下文纪律(所有 Agent 同规,随首条背景注入每一张卡):与 workflowSystemPrompt 第 4 条、session.js 硬闸同口径,
    // 数值口径 = knobs.ctxLimitMax(默认 192k,M2.5 实测),生效上限另按 min(serve 上报, 该值) 收口,改数值要三处同步。
    const _ck = Math.round((+(S.settings.knobs && S.settings.knobs.ctxLimitMax) || 192000) / 1000) + 'k'
    const discipline = '<上下文纪律(' + _ck + ')>你的上下文窗口约 ' + _ck + ' tokens,省着用：'
      + '① 按需精读,不通读整个模块——单次 read ≤400 行(带 offset/limit),grep 先收窄路径与类型;深读大片文件用 task 派子 Agent(它有独立 ' + _ck + ')。'
      + '② task / delegate_task 指令只写目标+文件路径+边界+回报格式,【严禁】贴文件原文/大段代码——不是限字数,是禁止把文档内容搬进上下文(塞原文超 2 万字壳层直接拦停该子 Agent);用 delegate_task 必须显式传 load_skills,不需要技能就传 []。'
      + '③ 子 Agent 结论一律落盘成文档,回报只给一句话+路径(字数不限,内容住文档里,谁要用谁去读);要整理结论也派子 Agent 读文档接力归纳,别自己全读。</上下文纪律>\n'
      // 中文思考(P1.5,2026-07-29):serve 内置系统提示与 OMO 注入都是英文,模型的思考过程默认跑成英文(用户实测);
      // 一句中文指令把 reasoning 也拉回中文 —— 思考是用户排查模型问题的主窗口,读英文成本是母语的三倍。
      + '<语言纪律>回答用中文,【思考过程(reasoning)也一律用中文输出】;代码、命令、标识符保持原文。</语言纪律>\n'
      // 弱模型双向纪律(P1.3,2026-07-26,依据 external/claude-code-提示词工程借鉴.md §1.2/§3):不粉饰也不许防御性打折;
      // 委派回报三不(直接用/不偷看/不编造);系统提醒元定义(防把注入提醒误归因于当前文件/工具输出)。
      // 提示词改动纪律:小步单变量、两周观测期,台账见 docs/项目记忆/弱模型行为台账.md
      + '<如实汇报>做成了什么、没做成什么照实说：跑过验证再说"完成"；没法验证就明说"还没验证"；失败贴原始输出，不许粉饰成成功；确认通过的也直说，不要防御性打折扣。</如实汇报>\n'
      + '<委派回报纪律>子 Agent 回报后直接用它的结论；不要偷看子 Agent 的中间过程（会把噪音灌进你的上下文）；它没回报的内容不要编造。</委派回报纪律>\n'
      + '<系统提醒说明>会话中卡片注入的提醒文字是系统侧提醒，与你正在读的文件内容、工具输出无关，按提醒本身行事即可。</系统提醒说明>\n'
      // ★内嵌浏览器常驻告知(2026-08-10):与"技能摘要常驻"同一个道理 —— 模型先得知道有这件东西。
      // 病灶:browser_* 这一组工具从 MCP 到 relay(/browser/*)整条链都是通的,但 session.js 与
      // workflowSystemPrompt 里 browser_open 出现【0 次】——从来没有人告诉过模型它有一个能看见的浏览器。
      // 没被告知的工具,弱模型不会去试;于是"验证前端页面"这类活要么不做,要么退回去读代码猜。
      // ★两套浏览器必须当场分清:选错的后果是"在一个看不见、没登录的浏览器里验了个寂寞",
      //   而它自己看不出区别(headless_* 也会正常返回 HTML)。所以规则写死在这里,不靠它悟。
      + '<内嵌浏览器>项目没跑起来时先 preview_list 看有哪些可启动配置、preview_start 把它跑起来'
      + '(只能跑 launch.json 里用户写好的具名配置),再去验;编译报错/端口占用看 preview_logs。'
      + '你有一个【用户屏幕上看得见的】浏览器,工具名带 browser_ 前缀:'
      + 'browser_open(开页面)/ browser_read(读页,给每个元素一个 [ref_N] 句柄)/ '
      + 'browser_find(一句话找元素→refs,页面元素多时别自己翻清单)/ '
      + 'browser_act(点击/输入/选择/按键/滚动/悬停/导航,定位【优先用 ref】不用拼选择器)/ '
      + 'browser_tabs(多标签:要【对着两个页面看】时用 —— 改前改后/列表页与详情页/两个环境)/ '
      + 'browser_assert(断言页面状态)/ browser_shot(截图)/ browser_resize(切手机/平板/暗色,验响应式)/ '
      + 'browser_diag(控制台与网络:可按关键词筛、可看成功请求、可按 id 取【响应体】—— 接口通了但返回体不对是前端 bug 的大头)/ browser_close。'
      + '它带着用户的登录态,你在里面做的每一步用户都能看到 —— 所以【验证本项目的页面、复现前端问题、走一遍真实流程】一律用这一组,'
      + '它产生的结果才算得上证据。'
      + '另有一个 headless_fetch:另起一次性无头 Chrome 读一个网页、读完就关。'
      + '用它的唯一场景是【读不该碰用户登录态的公网页面】(第三方文档之类)。'
      + '★验本项目的任何东西都不许用它:它照样会返回 HTML,但那是个没登录、和用户看到的不是同一个的页面,验了等于没验。</内嵌浏览器>\n'
    // 技能摘要常驻(P1.4,借鉴 CC skill frontmatter 摘要常驻思想):模型先知道"有哪些技能可用",正文仍按需注入(全文预算见 card-send)
    let skillLines = ''
    try {
      const sks = loadSkills()
      if (sks.length) skillLines = '可用技能（说"用XX技能"即启用，启用后会注入该技能全文）：\n' + sks.map((s) => '- 技能「' + s.name + '」：' + (s.desc || '（无描述）')).join('\n') + '\n'
      if (skillLines.length > 800) skillLines = skillLines.slice(0, 800) + '\n（技能清单过长已截断）\n'
    } catch {}
    const body = parts.length ? ('\n以下是本项目的说明文档,供参考:\n\n' + parts.join('\n\n---\n\n')) : ''
    return `<项目背景>\n${anchor}${discipline}${body}${skillLines}</项目背景>\n\n`
  }

  // 项目级知识库(任务尾蒸馏的落点,src/knowledge.js):按工作目录匹配,新卡首条消息随背景注入。
  // 与【全局】个人记忆 memory.md 分开 —— 系统级事实是项目资产,写全局会污染其它项目。
  // 注入前跑防腐校验 C1-C4(knowledge.auditEntries):死锚点条目隔离不注入、行漂移就近重定位并回写锚点行号、
  // churn 超阈标黄带 [待复核];两级索引按 target(首条消息/goal 片段)做场景命中优先注入。
  // 检查是开卡热路径:文件 mtime/churn 结果在 knowledge.js 进程内缓存,不会每次开卡全量 grep/git。
  const KNOWLEDGE_CHURN_MAX = 300   // C4 阈值兜底默认:自 verified(日期节代理)以来锚点文件累计改动行数;旋钮 settings.knobs.knowledgeChurnMax 优先
  // C4 阈值旋钮化:settings.knobs.knowledgeChurnMax(非正数/缺失回退默认 300)
  function knowledgeChurnMax() {
    const v = +(S.settings && S.settings.knobs && S.settings.knobs.knowledgeChurnMax)
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : KNOWLEDGE_CHURN_MAX
  }
  // 防腐依赖注入工厂:锚点是模型写的相对路径,一律围栏在项目目录内(防越界读盘);读不了的文件/无 git 不炸,对应检查跳过。
  function knowledgeDeps(dir) {
    const inDir = (rel) => {
      try {
        const abs = path.resolve(dir, String(rel || ''))
        const r = path.relative(dir, abs)
        return (r.startsWith('..') || path.isAbsolute(r)) ? null : abs
      } catch { return null }
    }
    return {
      existsFile: (rel) => { const p = inDir(rel); try { return !!p && fs.statSync(p).isFile() } catch { return false } },
      readFile: (rel) => {   // >1MB 不做符号校验(性能),返回 null → 该锚点 unchecked
        const p = inDir(rel); if (!p) return null
        try { if (fs.statSync(p).size > 1024 * 1024) return null; return fs.readFileSync(p, 'utf8') } catch { return null }
      },
      mtimeOf: (rel) => { const p = inDir(rel); try { return p ? fs.statSync(p).mtimeMs : undefined } catch { return undefined } },
      churnOf: (rel, since) => {   // git log --numstat 累计增删行数;非 git 仓库/无 git → null(跳过 C4,不影响注入)
        if (!inDir(rel)) return null
        try {
          const out = require('child_process').execFileSync('git', ['log', '--since=' + since, '--numstat', '--format=', '--', String(rel)], { cwd: dir, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
          let n = 0
          for (const l of out.split('\n')) { const m = l.match(/^(\d+)\s+(\d+)/); if (m) n += (+m[1]) + (+m[2]) }
          return n
        } catch { return null }
      },
    }
  }
  // target = 两级索引的"当前目标文本"。C2 懒构建(本波):card-init 不再现场注入,只在 ctx 里留 KNOWLEDGE_SLOT 占位;
  // 首次 card-send 时用【完整首条用户消息】(重开/压缩续聊再叠加接力摘要 seed)做 target 现场命中拼进 ctx ——
  // 比开卡时的标题片段(前 24 字)命中准得多。target 为空 → 退化为纯新→旧(injectText 内部处理)。
  function loadKnowledge(dir, target) {
    if (!dir) return ''
    try {
      const file = knowledge.fileFor(dir, require('electron').app.getPath('userData'))
      const raw = fs.readFileSync(file, 'utf8')
      const audit = knowledge.auditEntries(raw, knowledgeDeps(dir), { dir, churnMaxLines: knowledgeChurnMax() })
      if (audit.content && audit.content !== raw) {   // C3 行漂移重定位 → 回写知识库文件里的新锚点行号
        try { fs.writeFileSync(file, audit.content); log('knowledge: relocated anchors, rewrote ' + path.basename(file)) } catch {}
      }
      return knowledge.injectText(raw, dir, { target: target || '', audit, maxEntries: 40, maxChars: 4000 })   // 预算收紧:60 条/6000 字 → 40 条/4000 字(场景命中的优先占预算,长尾该舍就舍)
    } catch { return '' }
  }

  // ── 作答技能库(指令型:slash 选中后把方法论指令预置到消息前 → 提升产出质量;区别于录制回放技能)──
  // 存成可编辑的 .md(userData/answer-skills/),内网团队能把自己的规范沉淀进去;首次运行写入内置默认技能。
  const skillsDir = path.join(require('electron').app.getPath('userData'), 'answer-skills')
  const DEFAULT_SKILLS = {
    'frontend-ui': `---
name: 前端UI设计
desc: 让 HTML 文档/页面产出达到可直接汇报交付的水准(自包含、响应式、排版讲究)
---
你现在按【前端UI设计】技能作答。当需求涉及任何页面 / 文档 / 报表 / 看板的 HTML 呈现时,产出必须达到"可直接汇报、交付"的水准,严格遵守:

【产出形态】
- 单文件、自包含:所有 CSS / JS 内联;不引用任何外部 CDN、字体、图片、脚本链接(内网打不开)。要图标用内联 SVG 或 emoji,要图表用内联 <svg> 或纯 CSS,要图片用占位色块或 data URI。
- 直接给【完整可运行】的 HTML(从 <!doctype html> 到 </html>),不要给片段、不要给"你可以这样写"的骨架。

【视觉与排版】(这是质量关键,别偷懒)
- 信息层级分明:标题 / 小标题 / 正文 / 次要信息在字号、字重、颜色上清晰分层;留白充足,不拥挤。
- 版式:正文限定最大宽度(约 720–960px)居中;分区用卡片(圆角、细边框、克制阴影);统一间距刻度(4 / 8 / 12 / 16 / 24)。
- 配色:一套克制的中性色 + 一个主色;正文对比度达 WCAG AA;默认浅色,并用 @media (prefers-color-scheme: dark) 适配深色,两种都不难看。
- 字体:系统字体栈(-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif),中文清晰可读;行高 1.5–1.7。
- 响应式:相对单位 + flex / grid;窄屏不破版;宽内容(表格 / 代码 / 图)各自套 overflow-x:auto 内部滚动,页面本身永不横向滚动。

【结构与内容】
- 语义化标签(header / main / section / article / table / figure / footer),不是一堆 div。
- 表格:有表头、斑马纹或行 hover、数字右对齐、可横向滚动。
- 该有的都要有:标题区 → 概览/结论先行 → 分节正文 → 必要的图表/表格 → 页脚(来源、时间)。内容写实、写全,禁止 Lorem / 占位文字。

【交付前自检】(过一遍再给)
- 浅色 + 深色都好看;窄屏不破版;零外链;标签语义正确;信息层级一眼看懂;浏览器打开即用。

若需求不涉及 HTML 呈现,就正常作答,不必强行套 HTML。`,
    'browser-verify': `---
name: 浏览器自验
desc: 改完前端代码后,用内嵌浏览器真正打开页面验证(加载/报错/截图),不许只凭代码说"能跑"
---
你现在执行【浏览器自验】。目的:验证前端改动真的能在浏览器里跑起来——读过代码不算验证,打开页面才算。严格按步骤来,不许跳步、不许凭感觉下结论。

【步骤】(用 browser_open/read/act/assert/shot/diag/close 这一组,bash 只用于起服务)
0. 先认清用哪套浏览器:browser_open 开的是【内嵌浏览器】——用户真在用的那个,带登录态、他全程看得见、选择器有兜底。
   另有一个 headless_fetch 只用来读公网页面(另起进程、没有登录态、用户看不见),验证一律不用它。
1. 确认前端在跑:任务已给入口 URL 就直接进第 2 步;否则按项目文档(CLAUDE.md/README/package.json scripts)用 bash 起 dev 服务(后台起),等到能访问再继续。起不来 → 如实报告"服务起不来+报错原文"并停止,不要编造验证结果。
2. browser_open(url=入口, purpose="一句话说清这次验什么")。它会另开一个标签页并返回首屏结构(可交互元素带现成选择器)。
   越出围栏会被拒(默认只放行本机)——照它给的指引报告即可,不要绕路去用无头那套冒充。
3. 立刻验两条底线断言(这两条查的是浏览器自己从头采集的控制台与网络,比在页面里手搓收集器可靠得多——
   手搓的监听器装上去时首屏错误早就发生完了,那是漏报的主因):
   browser_assert(kind="no_console_error", label="首屏无 JS 报错")
   browser_assert(kind="no_failed_request", label="首屏无失败请求")
4. 验页面真的渲染出了东西,而不是白屏或错误页:
   browser_assert(kind="text_present", expect="<本次改动必然出现的一段文案>", label="…")
   或 browser_assert(kind="selector_exists", expect="<关键元素选择器>", label="…")
   ★"没报错"不等于"对了":必须至少有一条断言指向【本次改动的具体预期】。
5. 若改动涉及交互(按钮/表单/跳转):browser_read 看清当前页 → browser_act 走一遍关键路径 →
   再断言一次结果(text_present / url_matches / no_console_error)。
6. browser_shot 截图,然后【把图当附件读一遍】再下结论——布局崩没崩、内容对不对,只有看图才知道
   (带图消息会自动切到读图模型)。截图路径作为证据随回报给出。
7. 断言不过时用 browser_diag 拿控制台错误与失败请求的明细,写进报告。
8. browser_close(status="done"|"failed") 收会话出报告。报告里的 VERDICT 是壳层机器算的:
   有断言失败或步骤失败 → FAIL;一条断言都没做 → INCONCLUSIVE(那只是"打开看了一眼",不算验证)。
   把这份报告原样贴进你的回报里——它就是你的命令证据。

【判定】
- 通过:errors 为空 且 failedRes 为空 且 bodyLen > 50(不是白屏)。
- 失败:任一不满足 → 把 errors/failedRes 原文 + 截图路径带回,先修代码,再重新自验一遍;修不好就如实说"没验过,卡在 X",不许说"完成了"。

【纪律】
- 不许用"代码逻辑上看没问题"代替打开页面。
- 截图路径必须随最终回报给出(别人要点开看)。`,
    'req-analysis': `---
name: 需求分析（前后端结合）
desc: 需求/改造类任务：结合前后端两仓代码做影响面与契约分析，产出可确认的落点清单
---
你现在按【需求分析(前后端结合)】技能工作。目标:把需求变成"前后端落点清单",让人确认后再动手。严格按流程,不许跳过预检直接写方案。

【流程】
1. 读需求:逐句拆成功能点与约束(要做什么/不做什么/验收长什么样),不确定就问,不许替用户脑补业务。
2. 双仓勘察(预检只看数字,不通读):主仓(可写)从需求提 2-3 个关键词 grep 出候选模块(文件数、规模);副仓(只读,若有)同法扫另一端(前端需求看后端接口,后端需求看前端调用)。超 20 个文件或 150KB 的活一律拆给 task 子 Agent 分片读,你只收结论。
3. 影响面:对要改的符号(函数/字段/接口)grep 引用点,前后端两侧都列(file:行号);有 git 就顺 git blame 标"该问谁"。
4. 契约对账:前端实际发的请求字段 vs 后端实际期望的字段,逐条对(缺失/类型/必填/枚举/鉴权头),不一致的标出来——这是扯皮的源头,先说清。
5. 产出【需求落点清单】(落盘 docs/<主题>/分析.md):每个功能点给 前端落点 file:行号 / 后端落点 file:行号 / 改动性质(新增/修改/删除);契约差异表;风险分级(高=动契约/动公共模块、中=动多文件、低=局部);验收点(每个功能点"做完长什么样"一句话)。
6. 拿清单找用户确认,确认后才进入开发编排;没确认前一行代码不写。

【纪律】
- 主 Agent 不亲自通读文件:勘察/细读派 task 子 Agent(它读原文、回报结论+路径)。
- 结论与清单一律落盘成文档,回报只给路径+摘要。
- 需求里没有的事实不许编造:写"待确认"并问。`,
    'dev-standards': `---
name: 规范开发（项目规范与手册优先）
desc: 写代码前强制对齐 AGENTS.md/开发手册与既有代码风格，最小变更、模仿邻近实现
---
你现在按【规范开发】技能写代码。铁律:项目规范与手册 > 通用最佳实践 > 你的个人习惯。

【动手前四步(不许省)】
1. 读项目说明书:AGENTS.md(含构建/测试/验证命令)、README、docs/ 下的开发手册/规范。里面有命令与规矩就用它的,不自己发明跑法。
2. 看邻近实现:要改哪块,先读同目录/同层相邻文件——命名、分层、错误格式、组件写法、接口封装方式,照它的样子写,不引入新风格。
3. 先读后改:没读过的文件不许改;要改的文件先读懂它现有的抽象与边界。
4. 查规范清单(对照本技能末尾清单逐条过):分层/错误处理/事务/幂等/三态/参数化 SQL/依赖方向/secrets。

【开发纪律】
- 最小变更:修 bug 不顺手重构,加功能不附带"改进",不新建非必要文件(能改旧文件不新建)。
- 遵循既有约定:路由分层、api 层封装、统一错误格式、设计令牌、提交信息跟随仓库 git log 风格。
- 边界三层:✅ 计划内改动/测试/文档放手做;⚠️ schema 变更/加依赖/动公共模块先问;🚫 secrets/供应商目录/个人配置不碰。
- 注释只写非显然的 WHY,不写 WHAT(好名字已经说了);不为没改的代码补注释/类型。

【收尾自查】逐条确认再交付:
- 后端:路由无业务逻辑、入参有校验、错误统一格式、多表写同事务、写接口幂等、无 N+1。
- 前端:状态单一真相源、无副作用泄漏(订阅/定时器卸载清理)、三态齐全(加载/错误/空)、接口走 api 层。
- SQL:参数化零例外、无 SELECT *、新查询想过索引、无循环查库。
- 通用:配置外置、失败有边界(超时/降级)、关键逻辑落在单元测试层。
- 每项改动都能独立验证、独立回滚;接口/契约变更同步了文档与调用方。`,
    'auto-test': `---
name: 自动化测试（改完必验）
desc: 代码改动后的自主验证：基线构建测试→补最小测试/复现→浏览器/接口实测→证据驱动修复循环
---
你现在执行【自动化测试】。目标:改动真实被验证过,不许"看着对"就交付。按步骤来,每步留证据(命令+输出原文)。

【基线五步(先于一切)】
1. 读 AGENTS.md/README/package.json 拿准确命令(别猜)。
2. 构建:挂 = 直接 FAIL,先修构建。
3. 全量测试:挂 = FAIL,按失败归属修。
4. lint/类型检查(项目有就跑)。
5. 相关代码回归:改动影响面内的测试/调用点单独跑一遍。

【没有现成测试时】(内网老项目常态):
- 给改动写最小验证:/tmp 下写一次性脚本(复现 bug 的输入、调接口、跑关键路径),先亲眼看它挂(证明问题在),修完亲眼看它过;或按项目既有测试模板补一个最小测试文件。
- Bug 修复必须先复现再验证,不许直接宣布修好了。

【分类型实测】
- 前端:起 dev 服务 → browser_open(内嵌浏览器,带登录态、用户看得见) → 立刻 browser_assert 验 no_console_error + no_failed_request
  → 再断一条指向本次改动的预期(text_present/selector_exists;"没报错"不等于"对了") → 有交互就 browser_act 走一遍关键路径再断言
  → browser_shot 截图并把图读一遍 → browser_close 出报告(VERDICT 机判,零断言算 INCONCLUSIVE)。
  别用 headless_fetch 验:它另起进程、没有登录态、用户看不见,验的不是真实环境。
- 后端/接口:curl 调关键接口,校验响应体形状与字段(不只看状态码);异常参数也要测(空/畸形/边界)。
- 库/工具函数:从全新上下文 import 当消费者调公开 API。

【对抗探针 ≥1】从并发(同一请求双发)、边界(0/-1/空串/超长/unicode)、幂等(同一变更发两次)、孤儿(引用不存在的 ID)挑至少一个真实探一把——全是 200 和 test passes 只算 happy path。

【证据与判定】
- 每项检查记录:跑的命令 + 关键输出原文(copy-paste 不转述)。
- 全部通过才说"完成";任何一项不过:带着证据(报错原文+截图路径)回修,修完从失败那步重验,最多 3 轮;3 轮不过就如实报告卡在哪,不许粉饰。
- 测试套件通过只是上下文不是证据——实现者也是 LLM,它写的测试可能是循环论证,你要有自己的检查。`,
    'code-review': `---
name: 代码质量审查（三视角+误报过滤）
desc: 对本次改动做复用/质量/效率三视角审查，只报高置信真问题，附修复建议
---
你现在执行【代码质量审查】。先取变更(git diff;无 git 变更就审最近改动的文件),按下面三视角清单逐条过,然后过滤、定级、输出。

【视角一·复用】
- 新写的函数与已有工具/助手重复?指出该用的现成函数。
- 内联手写(字符串处理/路径处理/环境判断/类型守卫)有现成工具可换?
- 相似模式在邻文件已有实现,该不该复用而不是再写一份?

【视角二·质量】
- 冗余状态:能推导的缓存、能直调的 effect、重复状态。
- 参数膨胀:不改结构只加参。
- 近似复制粘贴:该抽共享抽象的近重复块。
- 泄漏抽象:暴露该封装的内部细节,或破坏既有边界。
- 字符串硬编码(stringly-typed):该用常量/枚举/联合类型的地方用裸字符串。
- 无意义包裹:不加价值的 wrapper 组件/元素。
- 废话注释:解释 WHAT(好名字已说)、复述任务、引用调用方——删;只留非显然 WHY。

【视角三·效率】
- 重复劳动:重复计算/重复读文件/重复调接口/N+1。
- 该并行却串行的独立操作。
- 热路径加活:启动/每请求/每渲染路径上的新阻塞。
- 无变化也通知:轮询/事件里无条件 set/update——加变更检测守卫。
- TOCTOU 预检:先查存在再操作——直接操作并处理错误。
- 无界数据结构与泄漏(监听器/定时器不清理)。
- 过宽操作:要一段读整文件、要一条取全部。

【误报过滤(只报真问题)】
- 置信度 <80% 不报;只是"风格不同"不报;理论上可能但无具体触发路径不报。
- 不报:测试文件本身的问题、文档/md 文件、第三方库版本、资源消耗类(内存/CPU)、缺审计日志、客户端代码缺鉴权(前端不可信是后端的责任)。
- React/Vue 默认不对 XSS 过敏(用了 dangerouslySetInnerHTML / v-html 才查)。

【输出】
- 按严重度分组:高(正确性/数据/安全) → 中(可维护性/契约) → 低(风格)。
- 每条:问题 + 位置(file:行号) + 依据(违反上面哪条) + 修复建议(具体怎么改)。
- 小问题(废话注释/无意义包裹/明显复用)直接顺手修掉;大改列清单给建议,不擅自动大手术。
- 没有真问题就直说"通过,无高置信问题",别凑数。`,
    'sql-quality': `---
name: 高质量 SQL（禁慢 SQL）
desc: 写/改 SQL 与数据访问代码：索引先行、慢 SQL 模式红线、EXPLAIN 验证、上线前实测
---
你现在按【高质量 SQL】技能处理 SQL/数据访问。目标:写出来的 SQL 上线不背慢查询事故。

【设计先行】
- 先想索引再写查询:WHERE/JOIN/ORDER BY 高频列有没有索引;新查询默认先答"走哪个索引"。
- 表结构变更:加列可空或带默认值(向前兼容);破坏变更必须有迁移路径与回滚。
- 数据量估算:这张表会涨到多大?查询触达多少行?超过万级就要想分页/分区方案。

【写法红线(逐条查,违反就重写)】
- 参数化查询零例外——字符串拼 SQL 直接打回(注入风险)。
- 禁 SELECT *:只取需要的列(大宽表尤其)。
- 禁 N+1:批量数据 join/IN 一次取,不在循环里查库;批量更新也分批(单次大事务拆小)。
- 索引列不做功:不对索引列用函数/隐式转换(DATE(col)=、col+0=、类型不匹配的比较)——一上函数索引就废。
- 深分页用键集/游标(WHERE id > ? ORDER BY id LIMIT n),不 OFFSET 几十万。
- NULL 三值逻辑:判断空用 IS [NOT] NULL,不用 =。
- 多行写必须事务;长事务是事故(锁等待/回滚段爆炸)。
- OR 扩索引列要警觉:能用 UNION 拆就别让 OR 把索引拖成全扫。

【验证(上线前必做)】
- 每条新 SQL 先 EXPLAIN(OceanBase 用 EXPLAIN/执行计划):全表扫描(TABLE SCAN/FULL)就是慢 SQL 预备役,除非表确定很小。
- 关注:rows(扫描行数 vs 返回行数差几个量级=白扫)、key(实际走的索引)、分区裁剪(OceanBase 分区表必须命中分区)。
- 有条件就用近线数据量实测一次执行耗时;批量操作先小批试。

【交付格式】
- SQL 代码 + 索引建议(建索引 DDL,如需要) + EXPLAIN 结论(走了哪个索引/扫多少行) + 数据量假设。
- 存量慢 SQL 排查:按上面红线逐条指认(位置 file:行号 + 违反了哪条 + 改法),不泛泛说"加个索引"。`,
  }
  function ensureDefaultSkills() {
    try {
      fs.mkdirSync(skillsDir, { recursive: true })
      for (const [id, body] of Object.entries(DEFAULT_SKILLS)) {
        const p = path.join(skillsDir, id + '.md')
        if (!fs.existsSync(p)) fs.writeFileSync(p, body, 'utf8')   // 只在缺失时写:用户改过的不覆盖
      }
    } catch {}
  }
  function parseSkill(file, text) {
    let name = file.replace(/\.md$/i, ''), desc = '', body = text
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)   // 复用记忆库那套 frontmatter
    if (m) { body = m[2]; const nm = m[1].match(/name:\s*(.+)/); const dm = m[1].match(/desc:\s*(.+)/); if (nm) name = nm[1].trim(); if (dm) desc = dm[1].trim() }
    return { id: file.replace(/\.md$/i, ''), name, desc, body: body.trim() }
  }
  function loadSkills() {
    ensureDefaultSkills()
    const out = []
    try { for (const f of fs.readdirSync(skillsDir)) if (/\.md$/i.test(f)) { try { out.push(parseSkill(f, fs.readFileSync(path.join(skillsDir, f), 'utf8'))) } catch {} } } catch {}
    return out
  }
  ipcMain.handle('skills-list', () => loadSkills().map(({ id, name, desc }) => ({ id, name, desc })))
  ipcMain.handle('skills-open-dir', () => { try { ensureDefaultSkills(); shell.openPath(skillsDir) } catch {} ; return true })

  // 会话没了(关卡/工作流收尾/会话被杀)→ 把它名下【弹了框但没人答】的审批记录一起清掉。
  // pendingPerm 以前唯一的删除点是 permission-reply,于是"弹了审批框但没点就关卡"的记录永远留在 Map 里(无上限,长跑必涨)。
  // 挂在 S 上:window.js(关卡)与 orch.js(工作流收尾)都要用,而 pendingPerm 的所有权在这一层。
  //
  // ★这段注释一直在,函数却从来没落地过 —— card-cleanup.js 那行写的是 `S.dropPendingPerm && S.dropPendingPerm(s)`,
  //   短路后静默跳过;而它唯一的测试自带同名桩,于是永远绿。结果:未答审批既不清也不 reject,serve 侧一直等应答。
  // 两条不变量,都靠"记录自带 serve"来保证(不回头查 sessionInfo):
  //   1. 清理链里 S.sessionInfo.delete(s) 排在本函数【之前】,回查必然拿到 undefined —— 所以 serve 存在 :meta 里随记录走。
  //   2. 必须 reject 而不只是删:serve 侧 permission 在等应答,只删本地记录 = 那一侧永久挂着(等同 R6 的提问挂死)。
  // pendingPerm 双键:requestId → sessionId(字符串),requestId+':meta' → { tool, detail, serve }。
  // 按值筛 sessionId 天然跳过 :meta 条目(它的值是对象),两个键一起删。
  S.dropPendingPerm = (sessionId) => {
    if (!sessionId || !S.pendingPerm) return
    for (const [k, v] of S.pendingPerm) {
      if (v !== sessionId) continue
      const meta = S.pendingPerm.get(k + ':meta')
      S.pendingPerm.delete(k); S.pendingPerm.delete(k + ':meta')
      const serve = meta && meta.serve
      if (serve) { try { oc.replyPermission(serve, sessionId, k, 'reject') } catch {} }
    }
  }

  // 提问版同因清理(R6 提问挂死):会话没了而它的交互提问【弹了卡但没人答】,serve 的 question 工具会一直等应答,
  // 回合挂死(实测 88s 等用户 Esc)。逐个 reject 再删,仿 dropPendingPerm;挂在 S 上供 window.js 关卡清理链调用。
  // pendingQuestion: requestId → { sessionId, v2, serve }(rejectQuestion 内部吞错打日志,fire-and-forget 即可)。
  S.dropPendingQuestion = (sessionId) => {
    if (!sessionId || !S.pendingQuestion) return
    for (const [k, v] of S.pendingQuestion) {
      if (!v || v.sessionId !== sessionId) continue
      S.pendingQuestion.delete(k)
      try { oc.rejectQuestion(v.serve, sessionId, k, v.v2) } catch {}
    }
  }

  // ── 事件路由（所有 serve 共用，按 sessionId 路由到对应卡）─────────────────
  // edit 预检连撞计数(sessionId → 连续未命中次数):分片无人值守,弱模型会拿着同一份错 oldString 反复白撞,
  // 撞一次拒一次它能循环到天荒地老(烧 token 还不出活)—— 连撞 3 次直接熔断本轮(abort),
  // 交分片收官兜底判 interrupted,主控按规程拆小重派;预检通过一次即清零。
  // 普通对话卡不设:用户在场看得见黄牌,撞几次他自己会停/会教,别替人掐回合。
  const editMissStreak = new Map()
  // 出仓写提醒去重(sessionId → 已提醒过):普通卡写项目目录外只提醒一次/会话,不刷屏(onPermission 里用)。
  const outOfProjWarned = new Set()
  // ── 用户可配权限规则(P2.3 壳层轨):settings.permRules {allow:[],deny:[]},语法 `工具名(通配)`(与 CC 同构重写) ──
  // deny 先于一切自动放行(分片卡也生效 = 用户红线不分卡型);allow 只在弹框前拦一次 = 少弹框 UX 层。
  function parsePermRule(rule) {
    const m = String(rule || '').trim().match(/^([A-Za-z0-9_.-]+)\(([\s\S]*)\)$/)
    return m ? { tool: m[1].toLowerCase(), pat: m[2].trim() } : null
  }
  function permGlobRe(pat) {
    return new RegExp('^' + String(pat).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  }
  function matchPermRule(tool, detail, rule) {
    const r = parsePermRule(rule); if (!r || !r.pat) return false
    if (String(tool || '').toLowerCase() !== r.tool) return false
    try { return permGlobRe(r.pat).test(String(detail || '').trim()) } catch { return false }
  }
  function permRulesHit(kind, tool, detail) {
    const rules = (S.settings && S.settings.permRules && S.settings.permRules[kind]) || []
    for (const r of rules) { if (matchPermRule(tool, detail, r)) return String(r) }
    return ''
  }
  // 驱动浏览器的那几个库(只拦【执行】,不拦读代码/查依赖 —— 那是正常排查)
  const BROWSER_LIB_RE = /(^|[\s;&|(`'"])(npx\s+)?(playwright|puppeteer|pyppeteer|selenium|chromedriver|geckodriver)\b|playwright\s+(test|codegen|install)|from\s+playwright|require\(['"]puppeteer/i
  const READONLY_CMD_RE = /^\s*(grep|rg|cat|less|head|tail|ls|find|which|npm\s+ls|pip\s+show|type)\b/i
  S.__onPermission = (a) => onPermission(a)   // 自测入口:这段判断埋在回调里,不挂出来没法断言(函数声明已提升)
  function onPermission({ sessionId, requestId, tool, detail, serve }) {
    const si = S.sessionInfo.get(sessionId)
    if (!si) {
      // 无主兜底(对齐 onQuestion 自动拒答口径):子 Agent 首个事件就是 permission(路由映射尚未学到子→父)或
      // 无头会话(技能精修等壳外会话)—— 不答复 serve 会一直干等,回合永挂。保守 reject;
      // serve 由派发侧透传(opencode.js dispatch),缺席时借任一健康 serve 回(不匹配 404 由 replyPermission 吞错打日志)。
      log('permission ' + requestId + ' 会话无主(子agent路由未学到/无头会话)→ 保守拒绝,防 serve 干等挂死 (tool=' + String(tool || '') + ')')
      try { const sv = serve || (typeof oc.anyHealthyServe === 'function' ? oc.anyHealthyServe() : null); if (sv) oc.replyPermission(sv, sessionId, requestId, 'reject') } catch {}
      return
    }
    // 用户权限规则 deny(先于一切:AUTO_ALLOW/skill_ 短路/分片自动放行/auto 模式全部排在它后面,用户红线不可被任何快捷通道翻过):
    // 命中即拒 + 卡片留痕。曾在 AUTO_ALLOW 之后,read 这类白名单工具的红线(如 read(*.env))永不命中(实测漏网)。
    const permDenyHit = permRulesHit('deny', tool, detail)
    if (permDenyHit) {
      log('权限规则拦截(deny):' + permDenyHit + ' 命中 ' + String(tool) + '(' + String(detail || '').slice(0, 80) + ')')
      try { S.audit && S.audit('permission', '规则拒绝(deny)', { rule: permDenyHit, tool: String(tool || ''), detail: String(detail || '').slice(0, 200) }) } catch {}
      try { if (si.wc && !si.wc.isDestroyed()) si.wc.send('card-note', { text: '权限规则拦截(deny)：' + permDenyHit + ' —— 已拒绝 ' + tool, tone: 'muted' }) } catch {}
      oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return
    }
    // ★浏览器自动化先走内嵌的,别上来就装 playwright(2026-08-12 用户提)。
    // 【为什么要有这道闸,而不是只在 AGENTS.md 写一句】只写在提示词里的规矩,模型忙起来就绕过去了 ——
    // 而这条绕过去的代价很大:playwright/puppeteer 是【另一个浏览器】,没有用户这份登录态(内网系统直接卡登录)、
    // 用户全程看不见它在点什么、还要装一堆依赖,跑完也拿不出可核对的报告。内嵌那套三样全有。
    // 【降级留口】用户的原话是"不行的话再走降级方案":真的试过内嵌、且撞了失败(brStat.fails≥2),就放行。
    // 所以这不是禁令,是【顺序】:先试自家的,试不通再降级。拒绝理由把这层意思说清楚。
    if (String(tool || '') === 'bash' && BROWSER_LIB_RE.test(String(detail || '')) && !READONLY_CMD_RE.test(String(detail || ''))) {
      const st = S.brStat || { opens: 0, fails: 0 }
      if (!(st.opens > 0 && st.fails >= 2)) {
        log('浏览器自动化改走内嵌:拒绝 ' + String(detail || '').slice(0, 80) + ' (内嵌已试 open=' + st.opens + ' 失败=' + st.fails + ')')
        try { if (si.wc && !si.wc.isDestroyed()) si.wc.send('card-note', { text: '已拦截 playwright/puppeteer —— 本机有内嵌浏览器工具(browser_*),带登录态且用户看得见', tone: 'muted' }) } catch {}
        oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return
      }
      log('内嵌浏览器已试过并失败(open=' + st.opens + ' 失败=' + st.fails + '),放行降级方案')
    }
    if (oc.AUTO_ALLOW.has(tool)) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    // 天枢技能工具族(skill_*):回放接管/断点解析的 MCP 工具,引擎侧已有门禁(如 page_act 仅接管期可执行),
    // 不再叠人工审批 —— 否则 Agent 接管每一步都弹批准框,混合执行没法用。MCP 工具名可能带服务前缀,按含 skill_ 匹配。
    if (/(^|[._-])skill_/.test(String(tool || ''))) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    // 多层派发分片卡:无人值守(按主控已批准的方案跑),权限请求自动放行 —— 否则 task 子 Agent/写文档都卡在看不见的批准框上,
    // 子 Agent 永远起不来(实测病灶)。范围限本卡会话,关卡即失效;全程工具日志留痕。
    if (S.shardWc && si.wc && S.shardWc.has(si.wc.id)) {
      // ★升格硬闸:工人节点【不许自己开新卡】。
      // 病灶(第一次真跑实锤):工人手里有 run_workflow / run_orchestration 这两个 MCP 工具,
      // 它一卡住(比如工具结果被上下文治理清掉、看不见自己读到什么)就会拿它们去"派个卡替我读文件",
      // 于是凭空冒出一张可见闪烁卡、脱离编排、无人回收、还占并发位。用户看到的就是"卡自己蹦出来了"。
      // 为什么闸落在这里:relay(/orch/run)是无身份 HTTP,拿不到调用方是谁 —— 而权限层【有身份】
      // (si.wc.id ∈ S.shardWc 就是"我是工人节点"),这是全链唯一能机械分辨的地方。
      // 拒绝理由写清楚,让它回到正路:要拆活儿用 task 子 Agent(有独立上下文,归它自己管)。
      if (/(^|[._-])(run_workflow|run_orchestration)$/i.test(String(tool || ''))) {
        log('工人节点尝试自行升格,已拒绝: ' + String(tool) + ' (wc ' + si.wc.id + ')')
        try { si.wc.send('card-note', { text: '⛔ 编排节点不能自己开新卡(' + String(tool) + ')—— 要拆活儿请用 task 子 Agent;要改计划请在编排面板插话', tone: 'muted' }) } catch {}
        oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return
      }
      // 写归属硬闸(编码模式):分片登记了 writeScope 时,write/edit 的目标文件必须在归属清单内 ——
      // 并行分片写冲突的头号死因就是越界写别的片的文件。
      // 默认归属 = 本仓根目录:没登记写归属(探查类/文档片)也不许写项目目录外 —— serve 的 git 快照 work-tree 锚在本仓,
      // 写到仓外的文件快照追踪不上、git 对仓外路径持续报错,会把 task 子 Agent 创建拖死(实测 subagent 全灭病灶同链);
      // 双仓场景同理:卡目录是哪个仓快照就锚哪个仓,跨仓写两边都对不上(提示词的"副仓只读"弱模型不守,这里收死)。
      // 显式归属(含验证棒的 tmpdir 沙箱)优先于默认归属;serve 目录拿不到时不设闸(没锚点没法判)。
      try {
        const mreg = S.wfCardByWc && S.wfCardByWc.get(si.wc.id)
        const dir = (si.serve && si.serve.dir) || ''
        const declared = mreg && Array.isArray(mreg.writeScope) ? mreg.writeScope : null
        const scope = (declared && declared.length) ? declared : (dir ? [dir] : null)
        if (scope && scope.length && /^(write|edit)(_[a-z]+)*$/i.test(String(tool || ''))
            && !writescope.matchScope(scope, dir || '.', String(detail || ''))) {
          log('write-scope 拦截:分片 ' + (mreg ? mreg.id : '?') + ' 越界写 ' + String(detail || '').slice(0, 80) + ' (归属: ' + scope.join(', ') + ')')
          try { S.audit && S.audit('workflow', '写归属越界拦截', { shard: mreg && mreg.id, path: String(detail || '').slice(0, 200), scope: scope.join(', ') }) } catch {}
          oc.replyPermission(si.serve, sessionId, requestId, 'reject')
          return
        }
        // bash 写文件同一道闸:弱模型常绕到 cat > f / tee / sed -i 写文件(归属闸只管 write/edit = 形同虚设)。
        // 提取命令里的写目标逐个过归属;解析不出的(含 $/`/~ 或 detail 被 200 字截断)宁可放过 —— 提示词层还有"bash 写文件视为越权"的规矩兜底。
        if (scope && scope.length && /^bash(_[a-z]+)*$/i.test(String(tool || ''))) {
          const bad = writescope.bashWriteTargets(String(detail || '')).filter((t) => !writescope.matchScope(scope, dir || '.', t))
          if (bad.length) {
            log('write-scope 拦截:分片 ' + (mreg ? mreg.id : '?') + ' bash 越界写 ' + bad[0] + ' (归属: ' + scope.join(', ') + ')')
            try { S.audit && S.audit('workflow', '写归属越界拦截(bash)', { shard: mreg && mreg.id, path: String(bad[0]).slice(0, 200), scope: scope.join(', ') }) } catch {}
            oc.replyPermission(si.serve, sessionId, requestId, 'reject')
            return
          }
        }
      } catch {}
      // 编辑预检:edit 的 oldString 与文件实际内容对不上 → 不放行白撞,直接拒并回【实际区域】
      // (弱模型凭记忆写 oldString 是 edit 失败的第一死因;拒一次带真内容,下一轮就对了 —— 比放行后失败空转强得多)
      if (/^edit(_[a-z]+)*$/i.test(String(tool || ''))) {
        ;(async () => {
          try {
            const peek = await buildPermPeek(si, sessionId, tool, detail)
            if (peek && peek.miss) {
              const n = (editMissStreak.get(sessionId) || 0) + 1
              editMissStreak.set(sessionId, n)
              if (editMissStreak.size > 200) editMissStreak.delete(editMissStreak.keys().next().value)
              log('edit 预检拦截:oldString 未命中 ' + peek.miss.filePath + ' → 拒并回实际区域 (连撞 ' + n + ')')
              try { S.audit && S.audit('workflow', '编辑预检拦截(oldString 未命中)', { file: peek.miss.filePath, streak: n }) } catch {}
              oc.replyPermission(si.serve, sessionId, requestId, 'reject')
              if (n >= 3) {   // 连撞熔断:撞 3 次还不对 = 它陷入死循环,掐停本轮交收官兜底/主控重派
                log('[harness-editloop] edit 连撞熔断:' + sessionId + ' 连续 ' + n + ' 次未命中 → abort 本轮')
                try { S.audit && S.audit('workflow', '编辑连撞熔断(abort)', { sessionId, streak: n }) } catch {}
                try { await oc.abort(si.serve, sessionId) } catch {}
              }
              return
            }
          } catch {}
          editMissStreak.delete(sessionId)   // 预检通过(或没法检)→ 连撞清零
          oc.replyPermission(si.serve, sessionId, requestId, 'once')
        })()
        return
      }
      oc.replyPermission(si.serve, sessionId, requestId, 'once'); return
    }
    if (!si.wc || si.wc.isDestroyed()) { oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return }
    // 出仓写提醒(普通可见卡,用户在场不硬拦,每会话一次):write/edit/bash 的写目标落在项目目录外 →
    // 卡内灰字 + 审计。serve 的 git 快照只锚本仓:仓外文件不受快照保护,fork 对仓外路径还会持续报错(拖死 task 子 Agent 的病灶同链)。
    // 白名单:系统临时目录 + userData(一次性脚本/壳层自身落盘,提醒没意义)。分片卡在上面的分支已被默认归属硬闸收死,不走这里。
    try {
      const pdir = (si.serve && si.serve.dir) || ''
      if (pdir && !outOfProjWarned.has(sessionId)) {
        const targets = []
        if (/^(write|edit)(_[a-z]+)*$/i.test(String(tool || ''))) targets.push(String(detail || ''))
        else if (/^bash(_[a-z]+)*$/i.test(String(tool || ''))) targets.push(...writescope.bashWriteTargets(String(detail || '')))
        let ud = ''
        try { ud = require('electron').app.getPath('userData') } catch {}
        const safe = [os.tmpdir()]; if (ud) safe.push(ud)
        const bad = targets.filter((t) => t && !writescope.matchScope([pdir], pdir, t) && !writescope.matchScope(safe, pdir, t))
        if (bad.length) {
          outOfProjWarned.add(sessionId)
          if (outOfProjWarned.size > 200) outOfProjWarned.delete(outOfProjWarned.keys().next().value)
          log('出仓写提醒:' + sessionId + ' 目标在项目目录外 ' + bad[0])
          try { S.audit && S.audit('permission', '出仓写提醒', { tool: String(tool || ''), path: String(bad[0]).slice(0, 200), projectDir: pdir }) } catch {}
          try { si.wc.send('card-note', { text: '注意：本次写入目标在项目目录外（' + String(bad[0]).slice(0, 80) + '）——git 快照只覆盖本仓，仓外文件不受保护且可能引发快照持续失败。如非必要请改到项目目录内。', tone: 'muted' }) } catch {}
        }
      }
    } catch {}
    // ── auto 模式:按会话优先(S.permModeByWc,TitleBar chip 一卡一开关),缺省回退全局 settings.permMode ——
    // 位置刻意在 deny 规则之后(红线不可翻)、分片分支之后(分片写归属闸不受影响)、allow 规则之前(语义更宽);
    // edit 同享预检(oldString 未命中照样拒带纠偏)。每次放行记审计 + 卡内一行灰字(用户看得见放了什么,不发批准确认框)。
    const permModeNow = (S.permModeByWc && si.wc && S.permModeByWc.get(si.wc.id)) || S.settings.permMode
    if (permModeNow === 'auto') {
      // ★审计和灰字都挂在【真正的应答点】,不许提到分支之前。原来是:
      //   · 灰字只在同步分支发 —— edit 走异步预检分支后直接 return,把灰字整个跳过了。
      //     于是 auto 卡里 bash/write 一直在刷"已自动放行",唯独真正改文件的 edit 一条不出;
      //     更糟的是预检【拒绝】时也一声不吭,用户既不知道放了什么、也不知道拦了什么。
      //   · 审计写在分支之前且无条件 —— 预检拒绝的那次,审计里却记着"auto 模式放行",是条假阳记录;
      //     而"拦下了"这件事本身零审计(对比分片分支的编辑预检拦截是记审计的)。
      const autoNote = (text) => {
        // 异步分支回来时卡可能已经关了,必须重查 isDestroyed(同步分支也一起走这条,口径统一)
        try { if (si.wc && !si.wc.isDestroyed()) si.wc.send('card-note', { text, tone: 'muted' }) } catch {}
      }
      const autoPass = () => {
        try { S.audit && S.audit('permission', 'auto 模式放行', { tool: String(tool || ''), detail: String(detail || '').slice(0, 200) }) } catch {}
        oc.replyPermission(si.serve, sessionId, requestId, 'once')
        autoNote('auto 模式已自动放行：' + tool + (detail ? ' — ' + String(detail).slice(0, 80) : ''))
      }
      if (/^edit(_[a-z]+)*$/i.test(String(tool || ''))) {
        ;(async () => {
          try {
            const peek = await buildPermPeek(si, sessionId, tool, detail)
            if (peek && peek.miss) {
              log('auto 模式 edit 预检拦截:' + peek.miss.filePath)
              try { S.audit && S.audit('permission', 'auto 模式 edit 预检拦截', { tool: String(tool || ''), path: String(peek.miss.filePath || '').slice(0, 200) }) } catch {}
              oc.replyPermission(si.serve, sessionId, requestId, 'reject')
              autoNote('auto 模式已拦下一次 edit：' + String(peek.miss.filePath || '') + ' —— 待改内容(oldString)在文件里没找到,已拒绝并要求模型重取原文')
              return
            }
          } catch {}
          autoPass()
        })()
        return
      }
      autoPass()
      return
    }
    // 用户权限规则 allow(少弹框 UX 层):命中即放行一次,不再弹批准框(红线在前的 deny 已先判)
    const permAllowHit = permRulesHit('allow', tool, detail)
    if (permAllowHit) { log('权限规则放行(allow):' + permAllowHit + ' 命中 ' + String(tool)); oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    S.pendingPerm.set(requestId, sessionId)
    S.pendingPerm.set(requestId + ':meta', { tool, detail: detail || '', serve: si.serve })   // 供审计留痕(批准/拒绝了什么)+ serve 随记录走,供 dropPendingPerm 关卡时 reject(那时 sessionInfo 已删,回查拿不到)
    // edit/write 类:尽力带 diff 预览 + 编辑预检(批准前看见"要改成什么样";oldString 未命中还要亮黄牌);取不到不挡路,照样弹
    ;(async () => {
      let peek = { diff: '', miss: null }
      try { peek = await buildPermPeek(si, sessionId, tool, detail) } catch {}
      if (!si.wc.isDestroyed()) si.wc.send('permission-request', { requestId, tool, detail: detail || '', diff: peek.diff, miss: peek.miss })
    })()
  }
  // 权限 diff 预览 + 编辑预检:找会话里最后一个未终态的 edit/write 工具 part,
  // ① 用 oldString/newString(或 write 的 content)拼迷你 diff ② 【编码预检】edit 的 oldString 真去文件里对一遍 ——
  // 未命中就给出实际区域(弱模型经常凭记忆写 oldString,放行也是白撞,这是编码成功率的第一环)。
  // 路径与 detail 对不上就放弃(防串台);write 新文件没有 oldString → 不检;读不了文件 → 不检(不挡路)。
  async function buildPermPeek(si, sessionId, tool, detail) {
    const out = { diff: '', miss: null }
    if (!/^(edit|write)(_[a-z]+)*$/i.test(String(tool || ''))) return out
    const msgs = await oc.getRawMessages(si.serve, sessionId)
    const TERM = /complet|success|done|error|fail|cancel|abort/i
    for (let i = msgs.length - 1; i >= 0; i--) {
      const parts = (msgs[i] && msgs[i].parts) || []
      for (const p of parts) {
        if (!p || p.type !== 'tool' || !/^(edit|write)/i.test(String(p.tool || ''))) continue
        const st = String((p.state && p.state.status) || '')
        if (TERM.test(st)) continue
        const inp = (p.state && p.state.input) || {}
        const fpIn = writescope.filePathOf(inp)   // 别名表统一取(fork 换入参名时,预检原来会整段静默跳过)
        if (detail && fpIn && fpIn.length >= 8 && !String(detail).includes(fpIn)) continue
        const oldS = String(inp.oldString || ''), newS = String(inp.newString != null ? inp.newString : (inp.content != null ? inp.content : ''))
        if (!oldS && !newS) return out
        const L = []
        if (oldS) { for (const l of oldS.split('\n').slice(0, 12)) L.push('- ' + l); if (oldS.split('\n').length > 12) L.push('…') }
        if (newS) { for (const l of newS.split('\n').slice(0, 20)) L.push('+ ' + l); if (newS.split('\n').length > 20) L.push('…') }
        out.diff = L.join('\n').slice(0, 4000)
        // 编辑预检:oldString 对不上文件 → 给实际区域(行号标注),让模型拿着真内容重写,别白撞
        if (oldS && fpIn) {
          try {
            const base = path.resolve((si.serve && si.serve.dir) || '.')
            const abs = path.resolve(base, fpIn)
            const rel = path.relative(base, abs)
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {   // 围栏:只读本仓(防止借预检读任意文件)
              const content = fs.readFileSync(abs, 'utf8')
              if (!content.includes(oldS)) {
                const lines = content.split('\n')
                const probe = oldS.split('\n').map((x) => x.trim()).filter(Boolean)[0] || oldS.slice(0, 24)
                const idx = probe ? lines.findIndex((l) => l.includes(probe)) : -1
                let region = ''
                if (idx >= 0) {
                  const from = Math.max(0, idx - 3), to = Math.min(lines.length, idx + 5)
                  region = lines.slice(from, to).map((l, j) => (from + j + 1) + '  ' + l).join('\n')
                }
                out.miss = { filePath: fpIn, probe: probe.slice(0, 60), region }
              }
            }
          } catch {}
        }
        return out
      }
    }
    return out
  }
  // 交互提问路由:serve 的 question 工具需要用户点选回答 —— 弹到对话卡(交互提问卡),应答经 question-reply IPC 回 serve。
  // 只路由到对话卡:管线/监控窗口(sessionInfo 带 tag.scope)、分片隐藏卡(shardWc,无人值守)都没有提问 UI ——
  // 工作流规程虽邀请分片"不确定就问用户",但隐藏卡的提问永远没人点(实测死锁病灶),必须当场拒,让模型按规程自己拿保守方案继续;
  // 会话无主/卡已毁同理 —— 一律自动 reject 兜底(不拒就把回合挂死,实测 88s 等用户 Esc)。子 agent 的提问会路由回父卡(dispatch 已归到根会话)。
  function onQuestion({ sessionId, requestId, questions, v2, serve }) {
    const si = S.sessionInfo.get(sessionId)
    if (!si || !si.wc || si.wc.isDestroyed() || (si.tag && si.tag.scope) || (S.shardWc && si.wc && S.shardWc.has(si.wc.id))) {
      log('question ' + requestId + ' 自动拒答:' + (!si ? '会话无主' : si.wc && si.wc.isDestroyed() ? '卡已毁' : (S.shardWc && si.wc && S.shardWc.has(si.wc.id)) ? '分片隐藏卡(无人值守)' : 'scope 窗口'))
      try { oc.rejectQuestion((si && si.serve) || serve, sessionId, requestId, v2) } catch {}
      return
    }
    log('question ' + requestId + ' → 弹到卡片 (会话 ' + String(sessionId).slice(0, 24) + ', ' + (questions || []).length + ' 问)')
    S.pendingQuestion.set(requestId, { sessionId, v2: !!v2, serve: si.serve || serve })
    si.wc.send('question-request', { requestId, questions: questions || [] })
  }
  // ── 128k 口径硬闸:委派指令(task/delegate_task)塞原文(超 knobs.taskPromptMax,默认 20000 字)的拦停 ──
  // 病灶:主 Agent 把文件原文/大段代码贴进委派指令 → 子 Agent 128k 迅速撑满 → serve 侧静默压缩 → 变笨/写结论挂死。
  // 【精确狙杀,不株连】:只 abort 能解析出子会话ID(taskChild,opencode.js extractChildSessionId)的那个超限调用;
  // 并行 fan-out 的兄弟子 Agent 绝不受牵连。解析不到 ID(老 serve 运行期不带 sessionID)就降级为只警告,
  // 真挂死交给 30min 看门狗 —— 宁可放过,不可错杀(教训:会话级 flag+补扫曾把一整波并行子 Agent 团灭)。
  const condemnedTasks = new Map()   // partID → { chars, max, aborted }(同一 part 多次状态推送只拦一次)
  // 多层派发会话回流:分片(隐藏卡,不开窗)的对话流镜像一份给主控卡(shardRoot=分片注册id),
  // 主控卡把镜像存进分片专属缓冲,点分片进度卡即在主区域渲染该分片的会话 —— 一窗看全部,不另开空间。
  function mirrorToOrch(si, payload) {
    try {
      const mreg = S.wfCardByWc && si.wc && S.wfCardByWc.get(si.wc.id)
      if (!mreg || !mreg.parentOrch || !S.orchByTag) return
      const oref = S.orchByTag.get(mreg.parentOrch)
      const oreg = oref && S.wfRegistry && S.wfRegistry.get(String(oref.id))
      if (!oreg) return
      for (const [, si2] of S.sessionInfo) {
        if (si2.wc && !si2.wc.isDestroyed() && si2.wc.id === oreg.wcId) {
          si2.wc.send('card-stream', Object.assign({}, payload, { shardRoot: mreg.id }))
          return
        }
      }
    } catch {}
  }
  // 内容签名判活(看门狗病灶修复):lastEventAt 以前无条件打点,而轮询补渲染每 1.2s 把【不变的 parts】全量重喂一遍 →
  // 分片回合中段挂死(已产出≥1 part 后静默)时计时永远被刷新,"300s 无事件"判据永不满足,分片永远 running 还占并发位(内网实测)。
  // 改为只在 part 内容真的变化时刷新:签名 = partID|kind|status|文本/输出/入参长度|文本尾(低成本,不哈希全文)。
  // SSE 真实新事件(文本增长/状态迁移/工具出入参变长)必然变签名,照常刷新;不变的重喂不再给看门狗续命。
  function partLivenessSig(ev) {
    const t = typeof ev.text === 'string' ? ev.text : ''
    const o = typeof ev.toolOutput === 'string' ? ev.toolOutput : (ev.toolOutput == null ? '' : String(ev.toolOutput))
    const i = ev.toolInput == null ? '' : (typeof ev.toolInput === 'string' ? ev.toolInput : (() => { try { return JSON.stringify(ev.toolInput) } catch { return '' } })())
    return String(ev.partID || '') + '|' + String(ev.kind || '') + '|' + String(ev.status || '') + '|' + t.length + '|' + o.length + '|' + i.length + '|' + t.slice(-16) + '|' + i.slice(-8)
  }
  function onText({ sessionId, text, role, partID, kind, status, delta, toolInput, toolOutput, toolTitle, toolError, subagent, agentId, agentName, taskChild, taskDesc, taskChars }) {
    const si = S.sessionInfo.get(sessionId); if (!si || !si.wc || si.wc.isDestroyed()) return
    if (role && role !== 'assistant') return
    // 主回合活动探针:分片挂死看门狗(下方 setInterval)据此判静默 —— 只在内容签名变化时打点(见 partLivenessSig)
    si.partSigs = si.partSigs || new Map()
    const sigKey = String(partID || '')
    const sigNow = partLivenessSig({ partID, kind, status, text, toolInput, toolOutput })
    if (si.partSigs.get(sigKey) !== sigNow) {
      if (si.partSigs.size > 500) si.partSigs.clear()   // 防长跑膨胀(清空代价只是多刷一次计时,无害)
      si.partSigs.set(sigKey, sigNow)
      si.lastEventAt = Date.now()
    }
    // ★空转探测:内容签名(上面那段)问的是"字节变没变",而 think-loop 永远在变字节 ——
    //   它不静默,它只是不干活。这里另记一本"有没有在【产出】"的账:工具调用/非空正文算产出,
    //   reasoning 只按段落记指纹用于判自重复。两条同时成立才算打转(见 src/spin.js 的判据说明)。
    //   按【会话】分别记:子 Agent 的事件路由到父卡的 sessionId,但带 agentId —— 各记各的,不互相续命。
    try {
      const spinKey = subagent && agentId ? String(agentId) : '_self'
      si.spin = si.spin || new Map()
      if (!si.spin.has(spinKey)) si.spin.set(spinKey, spin.createSpin())
      si.spin.get(spinKey).note({ kind, text, at: Date.now() })
      if (si.spin.size > 200) si.spin.clear()   // 防长跑膨胀(清空 = 重新观察,不会误杀)
    } catch {}

    const tag = si.tag || null   // 登记方自定义的任务身份(scope/kind/id…)：随 card-stream 下发,窗口可按并发任务分组
    // 诊断:分别确认子agent的【工具】和【文本/思考】是否路由到父卡片(排查"工具没进 🔍 组")
    if (subagent) {
      if (kind === 'tool' && !si._subToolLogged) { si._subToolLogged = true; log('子agent工具已路由: ' + text + '  agent=' + (agentName || '') + ' id=' + (agentId || '')) }
      else if (kind !== 'tool' && !si._subTextLogged) { si._subTextLogged = true; log('子agent文本/思考已路由  agent=' + (agentName || '')) }
    }
    // 工具调用不进文本缓冲,连同 入参/结果/标题/错误 一起原样转发给卡片(渲染成可展开工具日志块)。sub=子agent的工具。
    // 查子Agent:按"上下文单元"(agentId=子agent各自独立窗口;空=主/规划器会话)累计 read 次数 —— 读越多,文件内容越灌满该单元
    // 自己的上下文,撑爆后它回传的摘要/产出会变薄变乱。累计数(readN)带在现有工具事件上,窗口据此在该 Agent 行显示并越界(≥60)标红;
    // 里程碑(60/120/180…)另落一条日志,并标明是【规划器/子任务/汇总】哪一环在读。不新增事件类型、不改其它窗口渲染。
    if (kind === 'tool') {
      let readN = 0
      try {
        if (/^read$/i.test(String(text || '')) && partID) {
          si.readStat = si.readStat || new Map()
          const unit = agentId || '__main__'
          let rs = si.readStat.get(unit); if (!rs) { rs = { parts: new Set(), name: '' }; si.readStat.set(unit, rs) }
          if (agentName) rs.name = agentName
          const fresh = !rs.parts.has(partID); if (fresh) rs.parts.add(partID)
          readN = rs.parts.size
          if (fresh && readN >= 60 && readN % 60 === 0) {
            const phase = tag && tag.scope === 'wf' ? ({ plan: '规划器', reduce: '汇总', work: '子任务', review: '复核', revise: '修订' }[tag.kind] || '工作流会话') : ''
            const who = rs.name ? '子agent「' + rs.name + '」' + (phase ? '(隶属' + phase + ')' : '') : (phase || '本会话Agent')
            log('⚠ 查子Agent:' + who + ' 已读 ' + readN + ' 个文件(sid=' + sessionId + ') —— 读越多越会把该 Agent 的上下文撑爆、产出变薄变乱;宜缩小勘察范围或改用边界清晰的聚焦子任务')
          }
        }
      } catch {}
      // 工作流卡:主 Agent 的 todowrite 清单进成果注册表(存档里能看到任务清单与勾选状态)
      if (!subagent && /^todowrite$/i.test(String(text || '')) && toolInput && S.wfTodos) {
        try { const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput; if (inp && Array.isArray(inp.todos)) S.wfTodos(si.wc.id, inp.todos) } catch {}
      }
      // 128k 口径硬闸:委派指令(task 或 oh-my-openagent delegate_task)超 knobs.taskPromptMax(默认 20000 字,塞原文级别)→
      // 精确狙杀该调用的子会话(taskChild 已知即杀;未知先登记,后续状态推送带来 taskChild 再杀)。不碰任何兄弟子 Agent。
      if (/^(task|delegate_task)$/i.test(String(text || ''))) {
        try {
          const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : (toolInput || {})
          const chars = taskChars || (String(inp.description || '').length + String(inp.prompt || '').length)
          const max = Math.floor(+(S.settings && S.settings.knobs && S.settings.knobs.taskPromptMax)) || 20000
          if (chars > max && partID) {
            let cd = condemnedTasks.get(partID)
            if (!cd) {
              cd = { chars, max, aborted: false }
              condemnedTasks.set(partID, cd)
              if (condemnedTasks.size > 200) condemnedTasks.clear()
              log('[ctx-gate] ⚠ 128k硬闸:委派指令 ' + chars + ' 字超上限 ' + max + '(sid=' + sessionId + ') —— ' + (taskChild ? '精确拦停' : '等待子会话ID'))
              si.wc.send('card-note', { text: '⚠ 委派指令 ' + chars + ' 字超 128k 口径上限 ' + max + '(疑似贴了大段原文) —— ' + (taskChild ? '已拦停该子 Agent' : '将在子会话创建后拦停') + ';主 Agent 应拆小重派(指令≤2000字、只给路径不给原文)', tone: 'muted' })
            }
            if (!cd.aborted && taskChild) {
              cd.aborted = true
              log('128k硬闸:精确拦停超限子会话 ' + taskChild + '(指令 ' + cd.chars + ' 字)')
              ;(async () => { try { await oc.abort(si.serve, taskChild) } catch {} })()
              si.wc.send('card-note', { text: '⛔ 超限子 Agent「' + String(taskDesc || taskChild).slice(0, 40) + '」(指令 ' + cd.chars + ' 字)已被拦停 —— 主 Agent 会收到取消回报,按规程拆小重派', tone: 'muted' })
            }
          }
        } catch {}
      }
      // write/edit 落盘(主 Agent 与子 Agent 都收,只收成功完成的)→ 注册表产出文件清单,进存档与 workflow_result;
      // 升格方拿到路径就能自己读产物,不用问用户。与渲染层成果抽屉同一份信号,各管各的:那边管展示,这边管外传。
      if (/^(write|edit)(_[a-z]+)*$/i.test(String(text || '')) && toolInput && S.wfFiles && !toolError && /complet|success|done/i.test(String(status || ''))) {
        try {
          const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput
          const fp = writescope.filePathOf(inp)   // 别名表见 writescope.TOOL_PATH_KEYS(内网 fork 用 file_path 之类时,原来这里取不到 → 产出清单全空 → 判零产出)
          if (fp) S.wfFiles(si.wc.id, path.isAbsolute(String(fp)) ? String(fp) : path.resolve((si.serve && si.serve.dir) || '.', String(fp)))
        } catch {}
      }
      // T5 编排产物轨道:write/edit 走 wfFiles(上面,现状不动);skill_run 下载文件 / mail_send 发信 / doc_read 读文档
      // 这三类进 S.wfAction(window.js 提供的产物动作轨,没提供就跳过)。MCP 工具名可能带服务前缀,按结尾匹配。
      // 只收成功完成的(mail_send 是真发信,半截状态绝不能上报);write/edit 不在这里,各管各的。
      if (typeof S.wfAction === 'function' && !toolError && /complet|success|done/i.test(String(status || ''))) {
        const tname = String(text || '')
        const inp = (() => { try { return typeof toolInput === 'string' ? JSON.parse(toolInput) : (toolInput || {}) } catch { return {} } })()
        try {
          // skill_run:报告里的「导出/下载文件」行(· 路径)或 downloads 数组 → 每个文件一条产物动作
          if (/(^|[._-])skill_run$/i.test(tname)) {
            const dls = []
            const out = typeof toolOutput === 'string' ? toolOutput : (toolOutput == null ? '' : (() => { try { return JSON.stringify(toolOutput) } catch { return '' } })())
            try { const j = JSON.parse(out); if (j && Array.isArray(j.downloads)) for (const d of j.downloads) dls.push(String(d)) } catch {}
            if (!dls.length && out) {
              const seg = out.split(/导出\/下载文件|下载文件|downloads/i)[1] || ''
              for (const l of seg.split('\n')) { const m = l.match(/^\s*[·\-*]\s*(\S.+?)\s*$/); if (m) dls.push(m[1]) }
            }
            for (const d of dls.slice(0, 20)) S.wfAction(si.wc.id, { kind: 'skill', label: '技能下载：' + path.basename(String(d)), detail: String(d) })
          // mail_send:收件人 + 主题(to 是逗号分隔串,见 mail-mcp 入参)
          } else if (/(^|[._-])mail_send$/i.test(tname)) {
            const to = String(inp.to || '').slice(0, 200), subj = String(inp.subject || '').slice(0, 120)
            if (to || subj) S.wfAction(si.wc.id, { kind: 'mail', label: '发信：' + (subj || '(无主题)'), detail: '收件人 ' + (to || '?') })
          // doc_read:读了哪个文档(路径)
          } else if (/(^|[._-])doc_read$/i.test(tname)) {
            const fp = writescope.filePathOf(inp)
            if (fp) S.wfAction(si.wc.id, { kind: 'doc', label: '读文档：' + path.basename(fp), detail: fp })
          // bash:命令流水(验证证据闸的原料 —— 编码分片"跑没跑过构建/测试"据此机判,不靠模型自觉汇报)
          } else if (/^bash$/i.test(tname)) {
            const cmd = String(inp.command || inp.cmd || '').replace(/\s+/g, ' ').trim()
            if (cmd) S.wfAction(si.wc.id, { kind: 'cmd', label: cmd.slice(0, 120), detail: '' })
            // 证据粘性:cmd 流水在收官时才重扫(截 120 字、只留 50 条),早期构建命令会被挤出 → 误标【未验证】白派验证棒(实测病灶)。
            // 收到 cmd 当场用 VERIFY_CMD(扩充版,与 window.js 同款保持同步)匹配,命中即置注册表 verifyEvidence=true,
            // 收官证据闸先查这个标志再 fallback 重扫流水(window.js 侧另一波接线)。
            if (cmd && VERIFY_CMD.test(cmd)) {
              const vreg = S.wfCardByWc && S.wfCardByWc.get(si.wc.id)
              if (vreg && !vreg.verifyEvidence) { vreg.verifyEvidence = true; log('[harness-verify] 验证证据当场登记:' + cmd.slice(0, 80) + ' (shard ' + vreg.id + ')') }
            }
          // browser_* 浏览器动作(验证证据闸的原料之二:前端"浏览器自验"据此机判 —— 打开过页面/截过图/跑过页面断言才算验过前端)
          } else if (/(^|[._-])browser_(navigate|screenshot|eval|click|type)$/i.test(tname)) {
            const brief = String(inp.url || inp.selector || inp.expression || '').replace(/\s+/g, ' ').slice(0, 80)
            S.wfAction(si.wc.id, { kind: 'browser', label: '浏览器:' + (tname.match(/browser_\w+$/) || [tname])[0] + (brief ? ' ' + brief : ''), detail: String(inp.url || '') })
          }
        } catch {}
      }
      // 上下文工程·读文件字节计量:readN 只数文件个数,但"没读几个文件上下文就没了"的杀手是【字节】(内网实测反馈)。
      // 单次 read 输出 >12k 字 → 提醒分段读(纪律①单次 ≤400 行是软约定,弱模型不守,这里即时纠偏);
      // 会话【按文件去重】累计读字节超 knobs.readWarnMax(默认 100k,≈口径一半) → 提醒后续大文件改派 task 子 Agent。
      // 两条例律与时代同步:重读同一文件不重复计账(取该文件历史最大一次);老内容会被 context-guard 清出上下文,
      // 这里只拦"还在读"的节奏,不喊停(措辞引导式,防弱模型吓得不敢读了开始瞎编)。
      try {
        if (/^read$/i.test(String(text || '')) && !subagent && toolOutput && !toolError) {
          const isWf = S.wfCardByWc && S.wfCardByWc.has(si.wc.id)
          const n = String(toolOutput).length
          const fp = writescope.filePathOf(toolInput)
          si.readMap = si.readMap || new Map()
          si.readMap.set(fp || ('_nopath_' + (si._npSeq = (si._npSeq || 0) + 1)), Math.max(si.readMap.get(fp) || 0, n))
          si.readBytes = [...si.readMap.values()].reduce((a, b) => a + b, 0)
          if (n > 12000 && !si._bigReadWarned) {
            si._bigReadWarned = true
            const tip = '单次 read 读入 ' + n + ' 字 —— 大文件请用 offset/limit 分段精读（单次 ≤400 行），或派 task 子 Agent 深读'
            if (isWf) si.wc.send('card-inject', { text: '(系统提醒:' + tip + '。子 Agent 结论落盘成文档,上下文里只留路径+一句话。)', disp: '上下文提醒:' + tip, origin: 'system' })
            else si.wc.send('card-note', { text: tip, tone: 'muted' })
          }
          const readWarnMax = Math.max(20000, Math.round(+(S.settings.knobs && S.settings.knobs.readWarnMax) || 100000))
          if (si.readBytes > readWarnMax && !si._readBytesWarned) {
            si._readBytesWarned = true
            const ck = Math.round((+(S.settings.knobs && S.settings.knobs.ctxLimitMax) || 192000) / 1000) + 'k'
            const tip2 = '本会话已累计读入约 ' + Math.round(si.readBytes / 1000) + 'k 字文件内容（' + ck + ' 上下文的一半）—— 后续大文件的改造/转换/迁移建议【逐文件派 task 子 Agent】读（它读原文 → 写目标文件 → 只回路径+一句差异），你的上下文留给判断与整合'
            if (isWf) si.wc.send('card-inject', { text: '(系统提醒:' + tip2 + '。)', disp: '上下文提醒:' + tip2, origin: 'system' })
            else si.wc.send('card-note', { text: tip2, tone: 'muted' })
          }
        }
      } catch {}
      const toolPayload = { kind: 'tool', text, partID, status: status || '', input: toolInput, output: toolOutput, title: toolTitle, error: toolError, sub: !!subagent, agentId: agentId || '', agentName: agentName || '', taskChild: taskChild || '', taskDesc: taskDesc || '', readN, sessionId, tag }
      si.wc.send('card-stream', toolPayload); mirrorToOrch(si, toolPayload); return
    }
    if (!subagent && !role && kind !== 'reasoning' && text === S.sentPrompt.get(sessionId)) return   // "回显自己prompt"过滤只对父会话
    let buf = S.streamBuf.get(sessionId); if (!buf) { buf = {}; S.streamBuf.set(sessionId, buf) }
    const prev = buf[partID] || ''
    // delta=true（message.part.delta）始终追加；快照按"是否累积前缀"判断累积/增量
    const full = delta ? (prev + text) : (prev && !text.startsWith(prev) ? prev + text : text)
    buf[partID] = full
    const textPayload = { kind: kind || 'text', text: full, partID, sub: !!subagent, agentId: agentId || '', agentName: agentName || '', sessionId, tag }
    si.wc.send('card-stream', textPayload); mirrorToOrch(si, textPayload)
  }
  S.handlers = { onPermission, onText, onQuestion, onDiffStat: (d) => {
    // session.diff(serve 权威改动账本)→ 写进该会话所属卡片的注册表 entry:改动报告/面板用真增删行,不靠 git diff 估算
    try {
      const si = d && d.sessionId && S.sessionInfo.get(d.sessionId)
      const reg = si && si.wc && S.wfCardByWc && S.wfCardByWc.get(si.wc.id)
      if (reg) reg.diff = { files: d.files || 0, additions: d.additions || 0, deletions: d.deletions || 0, at: Date.now() }
    } catch {}
  } }

  // ── 分片主回合挂死看门狗(无人值守兜底;可见卡有人按 Esc,隐藏卡没有)──────────────────
  // 病灶:回合进行中无任何计时器(45s 落定只在轮末 arm),网关保持连接永不响应 → 分片永远 running+占并发位,
  // 主控永远等不到这片,整链静默卡死(审查实测)。挂死看门狗(子会话 30min 那只)只盯 task 子会话,不盯卡主回合。
  // 判据:分片卡(或主控卡)有回合在飞(turnBusy)且 1800s 无【内容变化】(onText 探针按 partLivenessSig 签名判活,
  // 轮询重喂不变内容不续命 —— 曾因此判据永不满足,挂死分片永远 running)→ oc.abort,
  // 中止后走 aborted/报错通道按 interrupted 收官 —— 宁可误杀可重派,不可静默卡死无人知。
  // 口径:300s→1800s(2026-08-04):内网慢端点 prefill+长 reasoning 常超 5 分钟无 part 变化,5min 把"慢"误杀成"挂死"。
  setInterval(() => {
    try {
      const now = Date.now()
      for (const [sid, si] of S.sessionInfo) {
        if (!turnBusy.has(sid)) continue
        if (!si || !si.wc || si.wc.isDestroyed()) continue
        const unattended = (S.shardWc && S.shardWc.has(si.wc.id)) || (S.wfCardByWc && S.wfCardByWc.get(si.wc.id) && S.wfCardByWc.get(si.wc.id).kind === 'orch')
        if (!unattended) continue   // 可见工作流卡有人看着(渲染端 90s/5min 只报静默时长、不下挂死结论,措辞与本行判死线对齐),不代劳
        const last = si.lastEventAt || 0
        if (now - last < 1800000) continue
        log('[ctx-hang] 挂死看门狗:分片/主控主回合 ' + Math.round((now - last) / 1000) + 's 静默 → 自动中止 (sid=' + sid.slice(0, 18) + ')')
        si.lastEventAt = now   // 本轮只杀一次;abort 没生效的话下个 tick 再杀
        try { oc.abort(si.serve, sid) } catch {}
      }
    } catch {}
  }, 45000)

  // taskChild 提取(与 opencode.js extractChildSessionId 同口径的最小本地版,防跨层依赖):task/delegate_task 工具
  // state 里刨子会话ID —— 128k 硬闸"先登记、后续推送带来 taskChild 再精确补杀"与卡片标子agent组完成都靠它。
  // 轮询通道(pollTurnParts,opencode.js 侧提取)与原始消息通道(这里)两条路都带上;提不到就空串,不兜底不编造。
  function extractTaskChild(st) {
    if (!st || typeof st !== 'object') return ''
    for (const c of [st.sessionID, st.sessionId, st.metadata && (st.metadata.sessionID || st.metadata.sessionId)]) {
      if (typeof c === 'string' && c.startsWith('ses_')) return c
    }
    if (typeof st.output === 'string') { const m = st.output.match(/task_id:\s*(ses_[A-Za-z0-9]+)/); if (m) return m[1] }
    return ''
  }
  // P1:onRawMessages 回调拿到的原始消息列表 → 与 opencode.js pollTurnParts 同构的 part 映射(喂同一个 onText)。
  // partID 必须同构(工具 = (callID||id)+':tool'),否则同一工具调用会被渲染两行,卡片按 partID 幂等去重就失效。
  // 用量摘取(noteUsage)在 oc 侧拉取时已顺手做,这里只管映射。只取最后一个 user 之后的 assistant(当前回合)。
  function mapRawTurnParts(list) {
    const arr = Array.isArray(list) ? list : (list && list.data) || []
    let lastU = -1
    arr.forEach((m, i) => { const r = (m && m.info && m.info.role) || (m && m.role); if (r === 'user') lastU = i })
    const out = []
    for (const m of arr.slice(lastU + 1)) {
      const role = (m && m.info && m.info.role) || (m && m.role)
      if (role !== 'assistant') continue
      const parts = (m && (m.parts || (m.data && m.data.parts) || (m.info && m.info.parts))) || []
      for (const p of Array.isArray(parts) ? parts : []) {
        if (!p || !p.id) continue
        if (p.type === 'text' || p.type === 'reasoning' || p.type === 'thinking') {
          const t = (typeof p.text === 'string' && p.text) || (typeof p.reasoning === 'string' && p.reasoning) || (typeof p.content === 'string' && p.content) || ''
          if (t) out.push({ partID: p.id, kind: p.type === 'text' ? 'text' : 'reasoning', text: t })
        } else if (p.type === 'tool') {
          const st = p.state || {}
          const cid = String(p.callID || p.id || p.partID || p.tool || '')
          out.push({ partID: cid + ':tool', kind: 'tool', text: p.tool || 'tool', status: st.status || '', input: st.input, output: st.output, title: st.title, error: st.error, taskChild: extractTaskChild(st) })
        }
      }
    }
    return out
  }

  // ── 卡死子 Agent 看门狗(判死不判慢,与卡内"绕圈看门狗"互补:那条治主 Agent 反复读同批文件,这条治子 Agent 写结论挂死)──
  // 实测病灶(2026-07-20,两次):子 Agent 探查全做完、写最终结论的 LLM 调用无声挂死(文本空、消息不收尾、serve 无请求级超时),
  // 父卡 task 永 running 拖住整波。判据:父卡在忙 + 子会话静默 > 30min + generationStalled(最后 assistant 未收尾且无工具在跑)
  // → 只中止这个子会话(task 报"Task cancelled",主 Agent 重派或带其余结果综合,实测恢复路径)。有工具在跑/已收尾一律放过:慢≠死。
  // 口径:5min→30min(2026-08-04):内网慢端点长 reasoning 常超 5 分钟无动静,5min 把慢模型误杀。
  const SUB_STALL_MS = 30 * 60 * 1000   // 旋钮候选:生成挂起容忍(网关掉链子常见;30min 无字才基本是真死,慢端点不误伤)
  const SUB_CTX_WARN = Math.round(((+(S.settings.knobs && S.settings.knobs.ctxLimitMax)) > 0 ? +(S.settings.knobs && S.settings.knobs.ctxLimitMax) : 192000) * 0.8)   // 子 Agent 上下文预警线 = 口径 80%(随 knobs.ctxLimitMax,默认 192k):隔离上下文不进卡片水位,这里直接看它的真实用量
  const subCtxWarned = new Set()   // 每个子会话只预警一次
  setInterval(async () => {
    try {
      const busy = new Map()   // serve.base → { serve, roots: Map<根会话sid → wc> } —— 只盯有卡在忙的 serve,空闲零开销
      for (const [sid, si] of S.sessionInfo) {
        if (!si || !si.wc || si.wc.isDestroyed() || !si.serve || !S.isCardBusy || !S.isCardBusy(si.wc.id)) continue
        const b = busy.get(si.serve.base) || { serve: si.serve, roots: new Map() }
        b.roots.set(sid, si.wc); busy.set(si.serve.base, b)
      }
      for (const { serve, roots } of busy.values()) {
        const all = await oc.listSessions(serve)
        for (const [rootSid, wc] of roots) {
          for (const c of all) {
            if (!c || !c.id || c.parentID !== rootSid) continue
            // 128k 口径预警:子 Agent 用量 ≥80% 提醒主 Agent 让它收尾落盘(任务偏大的早期信号,不拦只提醒)
            try {
              const u = oc.getSessionUsage(serve, c.id)
              if (u && u.prompt >= SUB_CTX_WARN && !subCtxWarned.has(c.id)) {
                subCtxWarned.add(c.id)
                if (subCtxWarned.size > 500) subCtxWarned.clear()
                if (!wc.isDestroyed()) wc.send('card-note', { text: '⚠ 子 Agent「' + String(c.title || c.id).slice(0, 40) + '」上下文已用 ' + Math.round(u.prompt / 1000) + 'k/' + Math.round(SUB_CTX_WARN / 0.8 / 1000) + 'k —— 任务偏大,宜让它尽快收尾落盘;下次拆小(指令≤2000字)', tone: 'muted' })
              }
            } catch {}
            const upd = (c.time && c.time.updated) || 0
            // ★这道时间前置闸是 think-loop 逃逸的原因:它一直在写消息,updated 永远新鲜,
            //   于是下面那句 generationStalled(判据本身是对的,tool-part-selftest 明确测过
            //   "reasoning 有、text 空、无工具 → true")【永远没机会跑】。
            //   所以另开一路:探测器判它在原地打转(不产出 + 自重复)就绕过这道时间闸,直接去判生成挂死。
            //   注意这【不是】把判死线调短 —— 长考照旧受 30min 保护,只有"重复同一段"才走这条快路。
            let spinning = false
            try {
              // ★按 rootSid 现取 si —— 这一层是 `for (const {serve,roots} of busy.values())` 里面,
              //   外层那个 `for (const [sid, si] of S.sessionInfo)` 早就结束了,si 在这儿【不在作用域】。
              //   第一版直接写了 si.spin,ReferenceError 被下面的 catch 吞掉,spinning 恒 false ——
              //   看着接上了,其实一次都没生效(自测用例0c 抓到的)。
              const rsi = S.sessionInfo.get(rootSid)
              const sp = rsi && rsi.spin && rsi.spin.get(String(c.id))
              if (sp) spinning = !!sp.verdict(Date.now()).spinning
            } catch {}
            if (!spinning && (!upd || Date.now() - upd < SUB_STALL_MS)) continue   // 有动静又没在打转 → 不判死
            let stalled = false
            // P4 降载:判挂只需最后一条消息。先带 {limit:1} 试拉 —— opencode.js/serve 支持 limit 就省掉全量;
            // 不支持(老版本忽略第三参/返回形状不对)回退现状全量,防御写法,两种都对(generationStalled 只看末尾)。
            try {
              let msgs = null
              try { const r = await oc.getRawMessages(serve, c.id, { limit: 1 }); if (Array.isArray(r)) msgs = r } catch {}
              if (!msgs) { try { msgs = await oc.getRawMessages(serve, c.id) } catch {} }
              stalled = oc.generationStalled(msgs || [])
            } catch {}
            if (!stalled) continue
            log('watchdog: 子会话 ' + c.id + ' (' + (c.title || '') + ') ' + (spinning ? '在原地打转(反复输出同一段思考、零工具零正文)' : '静默 >30min') + ' 且生成挂死 → 自动中止(父卡可重派)')
            try { await oc.abort(serve, c.id) } catch {}
            try { if (!wc.isDestroyed()) wc.send('card-note', { text: '⚠ 子 Agent「' + String(c.title || c.id).slice(0, 40) + '」' + (spinning ? '在原地打转(反复输出同一段思考,既不调工具也不出正文),已自动中止' : '写结论时挂死(30 分钟无进展),已自动中止') + ' —— 主 Agent 会重派或带其余结果继续;若反复发生多半是任务过大触发压缩循环,重派请拆小(指令≤2000字、只给路径)', tone: 'muted' }) } catch {}
          }
        }
      }
    } catch {}
  }, 90000)

  // ── Unified diff 解析 + 直接写文件 ─────────────────────────────────────────
  function parseDiff(text) {
    const files = [], lines = text.split(/\r?\n/)
    let file = null, hunk = null
    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        if (file && file.path) files.push(file)
        file = { path: '', hunks: [] }; hunk = null
      } else if (line.startsWith('+++ ') && !line.includes('\t/dev/null')) {
        const m = line.match(/^\+\+\+\s+(?:[ab]\/)?(.+?)(?:\t.*)?$/)
        if (m) { if (!file) file = { path: '', hunks: [] }; file.path = m[1].trim() }
      } else if (line.startsWith('@@ ') && file) {
        const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
        if (m) { hunk = { oldStart: parseInt(m[1]), oldCount: m[2] !== undefined ? parseInt(m[2]) : 1, lines: [] }; file.hunks.push(hunk) }
      } else if (hunk) {
        if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) hunk.lines.push(line)
        else if (!line.startsWith('\\')) hunk = null  // "\ No newline" 忽略，其余结束当前 hunk
      }
    }
    if (file && file.path) files.push(file)
    return files.filter(f => f.path && !f.path.includes('/dev/null') && f.hunks.length)
  }

  // 按【上下文】定位 hunk 真正该改的位置（容忍行号漂移），而非死信 oldStart —— 避免改错/改乱文件。
  // 从 guess 处向两侧搜索 oldBlock(上下文+删除行) 的精确匹配，再退化到去空白匹配；找不到则该 hunk 跳过（不破坏文件）。
  function findBlock(lines, block, guess) {
    if (!block.length) return Math.max(0, Math.min(guess, lines.length))   // 纯插入
    const max = lines.length - block.length
    if (max < 0) return -1
    const exact = (i) => { for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) return false; return true }
    const loose = (i) => { for (let j = 0; j < block.length; j++) if ((lines[i + j] || '').trim() !== block[j].trim()) return false; return true }
    for (const test of [exact, loose]) {
      for (let d = 0; d <= lines.length; d++) {
        const a = guess + d, b = guess - d
        if (a >= 0 && a <= max && test(a)) return a
        if (d > 0 && b >= 0 && b <= max && test(b)) return b
        if (a > max && b < 0) break
      }
    }
    return -1
  }

  function applyHunksToLines(lines, hunks) {
    let result = [...lines], drift = 0, failed = 0
    for (const hunk of hunks) {
      const oldBlock = [], newLines = []
      for (const ln of hunk.lines) {
        const tag = ln[0], content = ln.slice(1)
        if (tag === '-' || tag === ' ') oldBlock.push(content)
        if (tag === '+' || tag === ' ') newLines.push(content)
      }
      const at = findBlock(result, oldBlock, hunk.oldStart - 1 + drift)
      if (at < 0) { failed++; continue }                       // 定位不到 → 安全跳过该 hunk
      result = [...result.slice(0, at), ...newLines, ...result.slice(at + oldBlock.length)]
      drift += newLines.length - oldBlock.length
    }
    return { result, failed }
  }

  function applyDiffToDisk(baseDir, diffText) {
    const parsed = parseDiff(diffText)
    if (!parsed.length) return [{ file: '(无法解析 diff，请确认格式为 unified diff 含 +++ 文件头)', ok: false, error: '未解析到文件' }]
    return parsed.map(({ path: relPath, hunks }) => {
      let fullPath = relPath
      try {
        if (!path.isAbsolute(relPath) && baseDir) fullPath = path.join(baseDir, relPath)
        let lines = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n').split('\n') : []
        if (lines.length && lines[lines.length - 1] === '') lines.pop()
        const { result, failed } = applyHunksToLines(lines, hunks)
        if (failed === hunks.length) return { file: relPath, ok: false, error: '无法在文件中定位要修改的代码（文件可能已变化，请让 Agent 重新读取后修改）' }
        fs.writeFileSync(fullPath, result.join('\n') + '\n', 'utf8')
        log('apply-diff ' + (failed ? '(部分:' + failed + ' 个 hunk 未匹配) ' : '') + 'ok: ' + fullPath)
        return failed ? { file: relPath, ok: true, warn: failed + ' 处未能匹配，已跳过' } : { file: relPath, ok: true }
      } catch (e) {
        log('apply-diff err ' + fullPath + ': ' + e.message)
        return { file: relPath, ok: false, error: e.message }
      }
    })
  }

  // 在编辑器里打开 文件:行（默认 VS Code；可在 settings.editorCmd 配 IDEA 等）
  function openInEditor(file, line) {
    const tmpl = S.settings.editorCmd || 'code -g "{file}:{line}"'
    const cmd = tmpl.replace(/\{file\}/g, file).replace(/\{line\}/g, String(line || 1))
    exec(cmd, (err) => { if (err) shell.openPath(file).catch(() => {}) })
  }

  // ── 本地转录(C4)────────────────────────────────────────────────────────────
  // 每轮结束把该轮【增量】消息 append 到 userData/transcripts/<sid>.jsonl,每行
  // {role,text,reasoning?,tools?,files?,at}(reasoning 截 500 字;tools/files 是 normalizeMessages 新形状,透传)。
  // 用途:重连时 serve 历史拉不到/为空 → 回退读本地 transcript 拼回放,对话不白丢。
  // 单文件超 2MB 轮转截头(保尾部,截到整行边界不留半行 JSON)。增量游标按消息条数记,与文件行数解耦(轮转不影响游标)。
  const TX_MAX = 2 * 1024 * 1024
  const txDir = () => path.join(require('electron').app.getPath('userData'), 'transcripts')
  const txFile = (sid) => path.join(txDir(), String(sid).replace(/[^\w-]/g, '_') + '.jsonl')
  ipcMain.handle('transcript-path', (e, sid) => { try { return sid ? txFile(sid) : '' } catch { return '' } })   // 交棒逃生舱:上一棒 transcript 落盘路径(随续命消息注入给下一棒)
  const txCount = new Map()   // sid → 已落盘的消息条数(增量游标)
  function appendTranscript(sid, msgs) {
    if (!sid || !Array.isArray(msgs) || !msgs.length) return
    try {
      let n0 = txCount.get(sid) || 0
      if (msgs.length < n0) n0 = 0   // serve 侧历史变短(异常重置)→ 游标归零重记,重复行可接受,卡死不接受
      if (msgs.length <= n0) return
      const lines = []
      for (const m of msgs.slice(n0)) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
        const e = { role: m.role, text: String(m.text || ''), at: Date.now() }
        if (m.reasoning) e.reasoning = String(m.reasoning).slice(0, 500)
        if (Array.isArray(m.tools) && m.tools.length) e.tools = m.tools
        if (Array.isArray(m.files) && m.files.length) e.files = m.files
        lines.push(JSON.stringify(e))
      }
      if (!lines.length) { txCount.set(sid, msgs.length); return }
      fs.mkdirSync(txDir(), { recursive: true })
      const f = txFile(sid)
      fs.appendFileSync(f, lines.join('\n') + '\n', 'utf8')
      txCount.set(sid, msgs.length)
      const st = fs.statSync(f)
      if (st.size > TX_MAX) {   // 轮转截头:保尾部 ~2MB,从第一个换行后切开(别留半行)
        const buf = fs.readFileSync(f, 'utf8')
        const keep = buf.slice(Math.max(0, buf.length - TX_MAX + 65536))
        const nl = keep.indexOf('\n')
        fs.writeFileSync(f, keep.slice(nl >= 0 ? nl + 1 : 0), 'utf8')
        log('transcript rotated (head trimmed): ' + path.basename(f))
      }
    } catch {}
  }
  function readTranscript(sid) {   // 重连回放兜底:解析本地转录,只放行 user/assistant 行
    const out = []
    try {
      for (const l of fs.readFileSync(txFile(sid), 'utf8').split('\n')) {
        if (!l.trim()) continue
        try { const e = JSON.parse(l); if (e && (e.role === 'user' || e.role === 'assistant') && (e.text || e.reasoning)) out.push(e) } catch {}
      }
    } catch {}
    return out
  }

  // ── IPC ─────────────────────────────────────────────────────────────────────
  // per-card 状态(按 webContents 存,比 sessionInfo 长寿 —— 跨 init/reinit 存活):
  //   S.cardDir:  wcId → 本卡绑定的项目目录(不动全局 projectDir)
  //   S.modelByWc: wcId → 本卡选的模型({providerID,modelID,name} | null=serve默认)
  if (!S.cardDir) S.cardDir = new Map()
  if (!S.modelByWc) S.modelByWc = new Map()
  // C2 知识懒构建:card-init/card-reinit 只在注入前缀里留 KNOWLEDGE_SLOT 占位,首次 card-send 才用完整首条消息
  // 做 target 现场命中替进去(见 card-send)。knowledgeSeed: sid → 接力摘要原文(压缩续聊场景 target = 摘要+首条消息)。
  const KNOWLEDGE_SLOT = '<!--KNOWLEDGE_SLOT-->'
  const knowledgeSeed = new Map()
  const turnBusy = new Set()   // 进行中的回合 sid:card-init/reattach 回包带 running,卡片重载后知道"还在跑"
  S.turnBusy = turnBusy   // 挂到 S 上:window.js 从回合状态推导 isCardBusy(不再依赖渲染端上报)直接读这份权威记录。形态:Set<根会话sid>,成员资格即"该会话有回合在飞"(无值对象);加入=card-send 起手,移除=card-send finally/card-reinit 清旧会话。
  // 【本卡实际生效的模型】—— card-init(给界面显示)和 card-send(真发出去)必须过【同一个】函数。
  // ★真机 2026-08-11:标题栏 chip 写着「DeepSeek V4 Pro」,serve 日志里实发 deepseek-v4-flash。
  //   病根是两处各算一遍、链条不同:显示走 si.model || settings.model,发送走
  //   si.model || settings.modelMain || settings.model —— 双模型(M1)加进来时只改了发送那条。
  //   于是用户看到的模型和真在跑的模型是两回事,而且【看不出来】。同一件事不许有两份互不知情的账本。
  function baseModelOf(si) {
    return (si && si.model) || S.settings.modelMain || S.settings.model || null
  }
  // 会话就绪/重建时把 per-card 模型回放进 sessionInfo;返回给 UI 的是"实际生效"的模型
  function replayModel(wcId, sid) {
    const si = S.sessionInfo.get(sid); if (!si) return null
    const mw = S.modelByWc.get(wcId)
    if (mw !== undefined) si.model = mw
    else {
      // 发起时选定的模型(编排页发起/主控分片继承):注册表随卡走,优先级高于历史 —— 新卡还没有历史,老卡以卡内手选(modelByWc)为准
      const reg = S.wfCardByWc && S.wfCardByWc.get(wcId)
      if (reg && reg.model) si.model = reg.model
      else { const h = S.history.find((x) => x.id === sid); if (h && h.model) si.model = h.model }   // 卡坞续接:恢复当初那张卡选的模型
    }
    return baseModelOf(si)
  }
  S.__baseModelOf = baseModelOf   // 自测用:两条路同源这件事要能被断言,不能只靠"我看过了"
  // 【最近用过的对话卡】—— 壳层要把东西摆回"用户正在说话的那张卡"时的兜底线索。
  // ★为什么需要它:首选信号是"回合在飞"(S.turnBusy),那在模型调工具时最准;
  //   但没有回合在飞的时候(用户手点、外部经 relay 调工具)那条线索是空的,
  //   而"图截好了却没人看得见"这种静默失效,恰恰是最难被发现的一类 —— 真机自测就是这么撞上的。
  //   所以再留一条【永远拿得到】的:最后一次真的发过消息的那张卡。
  // 卡片↔会话登记(每次建/换会话都过这里):
  // ①工作流卡把最新会话 id 记进注册表(reg.sid)—— 存档头带会话,关卡后仍能重开【完整会话】而不是只甩一个 md;
  // ②分片会话 id 进 S.shardSids —— recordHistory 硬闸的第二道防线(光靠各调用点传 shard 旗标,漏一个就污染最近会话);
  // ③钉出/收回重挂(波3):工作流会话挪窝(内嵌 guest ↔ 钉出窗)后,注册表项的键还指在旧 wc 上 ——
  //   新 wc 按 sid 把【活着的(running)】注册表项认领回来重新挂键,否则 wfTurnDone/wf-open 全打在死 wcId 上(重挂后工作流断链)。
  //   已终态(done/interrupted)的项不认领:wf-open 有意以普通卡重开完工会话,不复活注册表(window.js wf-open 注释同款语义);
  //   旧 wc 仍是主(sessionByWc 还指它,双绑竞态)不抢。
  function trackWcSession(wcId, sessionId) {
    try {
      let wreg = S.wfCardByWc && S.wfCardByWc.get(wcId)
      if (!wreg && S.wfRegistry) {
        for (const reg of S.wfRegistry.values()) {
          if (!reg || reg.sid !== sessionId || reg.wcId === wcId) continue
          if (reg.status !== 'running') continue
          if (reg.wcId != null && S.sessionByWc.get(reg.wcId) === sessionId) continue   // 旧 wc 仍是主:不抢
          if (S.wfCardByWc && reg.wcId != null) S.wfCardByWc.delete(reg.wcId)
          S.wfCardByWc = S.wfCardByWc || new Map()
          reg.wcId = wcId; S.wfCardByWc.set(wcId, reg)
          wreg = reg
          break
        }
      }
      if (wreg) wreg.sid = sessionId
      if (S.shardWc && S.shardWc.has(wcId)) { S.shardSids = S.shardSids || new Set(); S.shardSids.add(sessionId) }
    } catch {}
  }
  // card-init 回包附带:本卡若是主控(orch)卡 → 它名下分片的快照数组(渲染端另一波灌分片面板用;不是主控/拿不到 → 空数组)。
  // 本卡 tag 反查:wfCardByWc 找到本卡注册项 → orchByTag 里 id 相同的那条 → wfRegistry 里 parentOrch=tag 的项(id/goal/status/at)。
  function shardSnapshot(wcId) {
    const out = []
    try {
      const reg = S.wfCardByWc && S.wfCardByWc.get(wcId)
      if (!reg || !S.orchByTag || !S.wfRegistry) return out
      let tag = ''
      for (const [t, oref] of S.orchByTag) { if (oref && String(oref.id) === String(reg.id)) { tag = t; break } }
      if (!tag) return out
      for (const r of S.wfRegistry.values()) { if (r && r.parentOrch === tag) out.push({ id: r.id, goal: String(r.goal || ''), status: r.status || '', at: r.at || 0 }) }
    } catch {}
    return out
  }
  ipcMain.handle('card-init', async (e, opts) => {
    try {
    const sid = opts && opts.sid
    const wantTitle = (opts && opts.title) || ''
    if (sid) {
      const h = S.history.find((x) => x.id === sid)
      // history 旧 dir 可能已被删/挪走:钉进 cardDir 前做存在性校验,不在 → 回退全局 projectDir 并留日志(否则 serve 起在死目录上)
      let hDir = (h && h.dir) || ''
      if (hDir && !fs.existsSync(hDir)) { log('card-init: history dir gone, fallback to projectDir: ' + hDir); hDir = '' }
      const dir = S.cardDir.get(e.sender.id) || hDir || S.settings.projectDir || ''
      if (hDir && !S.cardDir.has(e.sender.id)) S.cardDir.set(e.sender.id, hDir)   // 钉住历史目录,后续 reinit 不漂回全局
      const serve = await oc.ensureServe(dir, S.handlers, log)
      const proj = dir ? path.basename(dir) : (S.settings.projectDir ? path.basename(S.settings.projectDir) : '未选目录')
      if (await oc.sessionExists(serve, sid)) {   // 会话还在 → 重连 + 回放（已有历史，不注入上下文）
        S.sessionByWc.set(e.sender.id, sid)
        S.sessionInfo.set(sid, { wc: e.sender, serve })
        trackWcSession(e.sender.id, sid)
        const model = replayModel(e.sender.id, sid)
        S.pushServeHealth && S.pushServeHealth(e.sender, serve)
        touchHistory(sid)
        let messages = []; try { messages = await oc.getMessages(serve, sid) } catch {}
        // C4:serve 历史拉不到/为空 → 回退本地转录拼回放(转录条目本就来自 getMessages 归一化,已剥注入前缀)
        if (!messages || !messages.length) {
          const tx = readTranscript(sid)
          if (tx.length) { messages = tx; log('reattach: serve history unavailable, replay local transcript (' + tx.length + ' entries) for ' + sid) }
        }
        txCount.set(sid, (messages || []).length)   // 对齐转录游标:下轮只 append 新增量(防进程重启后整段重记)
        return { sessionId: sid, project: proj, dir, model, reattached: true, messages, running: turnBusy.has(sid), shards: shardSnapshot(e.sender.id) }
      }
      const ns = await oc.createSession(serve, wantTitle || (h && h.title) || 'BocomHermes 对话', dir, S.agentByWc && S.agentByWc.get(e.sender.id))  // 已不在 → 新开一段(带项目目录+卡内预选 Agent)
      if (!ns) throw new Error('create session failed')
      S.sessionByWc.set(e.sender.id, ns)
      S.sessionInfo.set(ns, { wc: e.sender, serve })
      trackWcSession(e.sender.id, ns)
      const model1 = replayModel(e.sender.id, ns)
      S.pushServeHealth && S.pushServeHealth(e.sender, serve)
      // C2:知识不在开卡时注入(标题片段命中差),留 KNOWLEDGE_SLOT 占位,首条发送时用完整消息现场命中(见 card-send)
      const ctx1 = loadToolRules() + loadMemory() + loadProjectContext(dir) + KNOWLEDGE_SLOT; S.firstMsgCtx.set(ns, ctx1)
      // R8 stale 历史:旧条目原地换 id(保留 created/title/model);装配层没给 replaceHistoryId 就退化为新增条目
      if (typeof replaceHistoryId === 'function') { try { replaceHistoryId(sid, ns) } catch { recordHistory(ns, wantTitle || (h && h.title), dir) } }
      else recordHistory(ns, wantTitle || (h && h.title), dir)
      // C4 同款回退:serve 已没有这段会话(进程重启等)→ 本地转录回放旧对话(只读回看,新消息写进新会话)
      let txMsgs = []; try { txMsgs = readTranscript(sid); if (txMsgs.length) log('stale reattach: replay local transcript (' + txMsgs.length + ' entries) for ' + sid) } catch {}
      return { sessionId: ns, project: proj, dir, model: model1, reattached: false, stale: true, running: false, messages: txMsgs, shards: shardSnapshot(e.sender.id) }
    }
    const dir = S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)
    const agent0 = S.agentByWc && S.agentByWc.get(e.sender.id)   // 卡内预选的 Agent(建会话即带,首条消息起就是它)
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话', dir, agent0)
    if (!sessionId) throw new Error('create session failed')
    S.sessionByWc.set(e.sender.id, sessionId)
    S.sessionInfo.set(sessionId, { wc: e.sender, serve })
    trackWcSession(e.sender.id, sessionId)
    const model0 = replayModel(e.sender.id, sessionId)
    S.pushServeHealth && S.pushServeHealth(e.sender, serve)
    const ctx0 = loadToolRules() + loadMemory() + loadProjectContext(dir) + KNOWLEDGE_SLOT; S.firstMsgCtx.set(sessionId, ctx0)   // C2:知识留占位,发送时懒构建
    if (!(opts && opts.shard)) recordHistory(sessionId, wantTitle, dir)   // 分片/索引棒是内部工人,不进历史(对用户只是一条工作流)
    return { sessionId, project: dir ? path.basename(dir) : '未选目录', dir, model: model0, agent: agent0 || null, reattached: false, running: false, shards: shardSnapshot(e.sender.id) }
    } catch (err) {
      // serve 拉起/建会话失败:分片隐藏卡死在这 = 主控永远等不到这片(静默整链卡死,实测)。
      // 这类失败不走 card-send,wfTurnError 三路兜底都到不了 —— 在这里补一刀,让分片按 interrupted 收官上报
      try { if (S.wfTurnError && S.wfCardByWc && S.wfCardByWc.has(e.sender.id)) S.wfTurnError(e.sender.id) } catch {}
      throw new Error(String((err && err.message) || err))   // 换落新 Error:异形错误对象过不了 IPC 克隆,真实原因会被吞
    }
  })

  // 切项目目录后即时重绑本卡:opencode 一个 serve 只认一个 cwd,换项目 = 换 serve + 换会话。
  // opts.dir = 本卡要切到的目录(仅影响本卡,不动全局);不传则用本卡已绑目录/全局默认。
  ipcMain.handle('card-reinit', async (e, opts) => {
    try { if (S.wfTurnStart) S.wfTurnStart(e.sender.id) } catch {}   // 交棒 reinit 可能超 45s(serve 冷启/卡顿):先解除落定计时,别把交棒中的分片误判收官(实测误杀窗口)
    const old = S.sessionByWc.get(e.sender.id)
    let oldServe = null
    if (old) {
      const si = S.sessionInfo.get(old)
      if (si) { oldServe = si.serve; try { oc.abort(si.serve, old) } catch {} }
      S.sessionInfo.delete(old); S.streamBuf.delete(old); S.sentPrompt.delete(old); S.firstMsgCtx.delete(old)
      knowledgeSeed.delete(old); turnBusy.delete(old)
      try { if (S.setCardBusy) S.setCardBusy(e.sender.id, false) } catch {}   // 旧会话已中止:同步转闲,否则交棒后侧栏永远转圈
      S.dropPendingQuestion(old)   // 旧会话已中止:它名下没答的提问逐个 reject,别让 question 工具空等挂死(R6)
    }
    S.sessionByWc.delete(e.sender.id)
    if (opts && opts.dir) S.cardDir.set(e.sender.id, String(opts.dir))
    const dir = (opts && opts.dir) || S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)   // requireDirMatch 默认开:cwd 不符不共享,自起独立 serve
    const agent0 = S.agentByWc && S.agentByWc.get(e.sender.id)
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话', dir, agent0)
    if (!sessionId) throw new Error('create session failed')
    S.sessionByWc.set(e.sender.id, sessionId)
    S.sessionInfo.set(sessionId, { wc: e.sender, serve })
    trackWcSession(e.sender.id, sessionId)
    const model = replayModel(e.sender.id, sessionId)
    S.pushServeHealth && S.pushServeHealth(e.sender, serve)
    // carryCtx=压缩续聊的接力摘要:上一段对话的要点随首条消息带进新会话(用户气泡不显示,回放展示层会剥)
    const carryRaw = opts && typeof opts.carryCtx === 'string' ? opts.carryCtx.trim().slice(0, 20000) : ''
    const carry = carryRaw ? '<上轮对话接力摘要>\n' + carryRaw + '\n</上轮对话接力摘要>\n\n' : ''
    // C2:知识留占位发送时懒构建;续聊场景 target = 接力摘要 + 首条消息(seed 存原文,card-send 拼)
    // 注入顺序铁律(KV-cache):稳定块在前(纪律/项目背景/知识/记忆)且字节恒定,动态内容只许追加尾部(接力摘要 carry → 用户消息)——
    // 前缀逐字节稳定 = 缓存命中(Manus 实测缓存 token 成本≈1/10)。新增任何注入物一律插尾部,不许插队。
    const ctx = loadToolRules() + loadMemory() + loadProjectContext(dir) + KNOWLEDGE_SLOT + carry; S.firstMsgCtx.set(sessionId, ctx)
    if (carryRaw) knowledgeSeed.set(sessionId, carryRaw)
    if (!(opts && opts.shard)) recordHistory(sessionId, 'BocomHermes 对话', dir)   // 分片/索引棒是内部工人,不进历史(对用户只是一条工作流)
    // 旧 serve 若已无任何会话引用且是自起的 → 退休,不留孤儿进程
    if (oldServe && oldServe !== serve) {
      const inUseBases = new Set([...S.sessionInfo.values()].map((si) => si.serve && si.serve.base).filter(Boolean))
      try { if (oc.retireIfOrphan(oldServe, inUseBases)) log('card-reinit: 旧 serve ' + oldServe.base + ' 已退休(无会话引用)') } catch {}
    }
    log('card-reinit → [' + (dir || '(home)') + '] session ' + sessionId)
    return { sessionId, project: dir ? path.basename(dir) : '未选目录', dir, model, running: false }
  })

  ipcMain.handle('card-send', async (e, arg) => {
    const { text, files, skill } = (typeof arg === 'string') ? { text: arg } : (arg || {})   // 兼容老调用(纯字符串)与新 {text, files, skill}
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (!si) throw new Error('session not ready')
    turnBusy.add(sessionId)
    // 回合序号:下面 finally 的尾部补拉要 await 6~12s,这期间完全可能已经开了新回合
    // (严格模式 card-inject、编排派发都会立刻再发一条)。摘 busy 时要认这个号,免得旧回合把新回合的忙态摘掉。
    const myTurn = (si.turnSeq = (si.turnSeq || 0) + 1)
    try { if (S.setCardBusy) S.setCardBusy(e.sender.id, true) } catch {}   // 忙闲上报:Vue 卡不发 card-busy,由主进程回合态代发(侧栏转圈/未读点/托盘/关卡确认闸都靠它)
    si.lastEventAt = Date.now()   // 挂死看门狗起点:回合刚开始还没流事件,别拿"从未有事件"当静默
    try { if (S.wfTurnStart) S.wfTurnStart(e.sender.id) } catch {}   // 分片收官兜底(window.js):新回合开始=还活着,解除 45s 落定计时
    // 首条消息：静默注入项目上下文前缀（用户看到原文，Serve 收到"背景+原文"）
    // C2 知识懒构建:ctx 里的 KNOWLEDGE_SLOT 此刻才替换成知识段 —— target 用【完整首条用户消息】
    // (压缩续聊/重开再叠加接力摘要 seed),比开卡时的标题片段命中准;target 全空 → injectText 退化为新→旧。
    let ctxPrefix = S.firstMsgCtx.get(sessionId) || ''
    if (ctxPrefix) {
      if (ctxPrefix.includes(KNOWLEDGE_SLOT)) {
        const kdir = (si.serve && si.serve.dir) || S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
        const seed = knowledgeSeed.get(sessionId) || ''
        let k = ''; try { k = loadKnowledge(kdir, (seed ? seed + '\n' : '') + String(text || '')) } catch {}
        ctxPrefix = ctxPrefix.replace(KNOWLEDGE_SLOT, k)
      }
      S.firstMsgCtx.delete(sessionId); knowledgeSeed.delete(sessionId)
    }
    if (ctxPrefix) {
      log('inject project context (' + ctxPrefix.length + ' chars) for ' + sessionId)
      // 后台动作可视化:注入了什么背景要让用户在对话里看得见(一行灰字),不能只躺在日志里。按实际注入的成分拼文案,不虚报。
      const seg = []
      if (ctxPrefix.includes('<个人记忆>')) seg.push('个人记忆')
      if (ctxPrefix.includes('<项目背景>')) seg.push('项目背景')
      if (ctxPrefix.includes('<项目知识(')) seg.push(ctxPrefix.includes('场景命中') ? '项目知识（按首条消息命中）' : '项目知识')
      if (ctxPrefix.includes('<上轮对话接力摘要>')) seg.push('接力摘要')
      try { if (!e.sender.isDestroyed()) e.sender.send('card-note', { text: '已随首条消息注入背景：' + (seg.join(' + ') || '项目背景') + '（' + ctxPrefix.length + ' 字）', tone: 'muted' }) } catch {}
    }
    // 作答技能：选中的技能把方法论指令静默预置到用户原文前（用户气泡仍显示原文）
    // 全文预算(P1.4):技能是注入侧最后一个无预算口子,超 4000 字截尾并标注(memory.md 截尾同款)
    let skillPrefix = ''
    if (skill) { const sk = loadSkills().find((s) => s.id === skill); if (sk) { const skBody = sk.body.length > 4000 ? sk.body.slice(0, 4000) + '\n（技能正文过长已截断，完整版见 skills 目录）' : sk.body; skillPrefix = '<作答技能:' + sk.name + '>\n' + skBody + '\n</作答技能>\n\n'; log('inject skill 「' + sk.name + '」(' + skBody.length + ' chars) for ' + sessionId) } }
    const msg = ctxPrefix + skillPrefix + (text || '')
    S.lastChatWc = e.sender.id   // 最近说过话的卡(壳层回推截图等内容的兜底收件人)
    S.sentPrompt.set(sessionId, msg); S.streamBuf.delete(sessionId)   // 存【实际发出的全文】(含注入前缀):回显过滤比对的是 serve 收到的东西 —— 只存原文的话,带前缀的回显漏网,整坨背景提示词会打进对话流
    touchHistory(sessionId)
    let model = baseModelOf(si)   // ★与 card-init 给界面的那个走同一个函数 —— 见 baseModelOf 头上的注释
    // ★排障埋点(2026-08-09):真机上编排的核实卡实际跑在 serve 默认模型上,而不是 run 指定的那个
    //   (勘察卡 139 次 stream 全是 deepseek-v4-flash,核实卡 50 次全是 deepseek-v4-pro,serve 日志实证)。
    //   读代码读不出这个差别 —— 派发链上每一处看着都把模型传下去了。这一整天所有真答案都来自
    //   "把真正发出去的东西打出来"(dumpRaw / session.error payload / [oc] send),不是来自读代码。
    //   ★modelByWc 要区分【未设置】和【显式 null】:card-set-model 选「默认模型」时存的是 null 而不是删 key,
    //     而 replayModel 判的是 `mw !== undefined` —— null 会盖掉 reg.model。这两个状态必须在日志里分得开,
    //     否则就是拿着一个分不清的量去猜(我已经为此猜错过一次)。
    //   只在值得看的时候打:解析成空(那就是 [oc] send 里 "(不指定)" 的来源),或编排节点卡没走 si.model。
    try {
      const _reg = S.wfCardByWc && S.wfCardByWc.get(e.sender.id)
      const msrc = si.model ? 'si.model' : (S.settings.modelMain ? 'settings.modelMain' : (S.settings.model ? 'settings.model' : '(三处全空)'))
      // ★★条件放开(2026-08-09 第二次改):原来只在"解析成空 或 编排卡没走 si.model"时打 ——
      // 而真机现象是核实卡实发 "(不指定)" 却【一条埋点都没有】,于是"模型有值但被拉黑"和
      // "这条送根本不走 card-send"这两种处境被我的埋点混成一个,分不开(我据此推错了一轮)。
      // 我一整天在诊断的正是这个毛病:把证据本身挂在一个判据后面,而判据恰好把真相排除掉了。
      // 编排节点卡数量少(一次几片到几十片),无条件打;普通对话仍只在异常时打,不加噪音。
      if (!model || (_reg && _reg.runId)) {
        const mwHas = !!(S.modelByWc && S.modelByWc.has(e.sender.id))
        log('[model-src] sid=' + String(sessionId).slice(0, 18) + ' 取自=' + msrc
          + ' 结果=' + (model ? (model.providerID + '/' + model.modelID) : '(空 → 由 serve 挑)')
          + ' | si.model=' + JSON.stringify(si.model || null)
          + ' modelByWc=' + (mwHas ? JSON.stringify(S.modelByWc.get(e.sender.id) || null) + '(已设置)' : '(未设置)')
          + ' reg.model=' + JSON.stringify((_reg && _reg.model) || null)
          + ' reg.runId=' + ((_reg && _reg.runId) || '-') + ' reg.nodeId=' + ((_reg && _reg.nodeId) || '-'))
      }
    } catch { /* 埋点绝不许把主流程搞崩 —— 今天已经因为一句裸 log() 让 plan 110ms 转人工过一次 */ }
    const fileArr = Array.isArray(files) ? files : []
    const hasImage = fileArr.some((f) => f && /^image\//.test(f.mime || ''))
    if (hasImage) {
      // 带图消息路由(M1 双模型):优先用显式配置的读图模型;没配回退"清单里找一个 image 模型"(老行为)
      const mv = S.settings.modelVision
      if (mv && mv.modelID) {
        model = { providerID: mv.providerID, modelID: mv.modelID, name: mv.name }
        // ★设置里存的"读图模型"未必真能读图(真机:存着 deepseek-v4-flash,而本机 12 个模型一个都不支持)。
        //   不核一下就路由过去 = 图被静默丢弃,模型对着"没有图"的消息胡答 —— 用户完全看不出发生了什么。
        let visOk = true
        try { const v = S.visionInfo ? await S.visionInfo() : null; if (v && !v.ok) visOk = false }
        catch { /* 查不到就按老行为走,不因为探测失败挡住发送 */ }
        if (!si.wc.isDestroyed()) si.wc.send('card-note', visOk
          ? { text: '检测到图片，本条用读图模型「' + (mv.name || mv.modelID) + '」识别', tone: 'muted' }
          : { text: '⚠ 检测到图片，但设置里的读图模型「' + (mv.name || mv.modelID) + '」其实不支持读图 —— 这张图多半会被丢掉。请在设置里换一个支持图片输入的模型。', tone: 'muted' })
      } else {
        try {
          const models = await oc.listModels(si.serve, {})
          const cur = model && models.find((m) => m.providerID === model.providerID && m.modelID === model.modelID)
          if (!cur || !cur.image) {
            const v = models.find((m) => m.image)
            if (v) { model = { providerID: v.providerID, modelID: v.modelID, name: v.name }; if (!si.wc.isDestroyed()) si.wc.send('card-note', { text: '检测到图片，已临时切到多模态模型「' + v.name + '」识别', tone: 'muted' }) }
          }
        } catch {}
      }
    }
    const onNote = (t) => { try { if (!si.wc.isDestroyed()) si.wc.send('card-note', { text: t, tone: 'muted' }) } catch {} }
    // 轮询补渲染:这台 serve 的 /event 常不推 message 流式事件(工具/子Agent/思考全静默 → 卡片只能等 POST 返回一次性贴,
    // 看着像"单Agent一口气出结果")。发消息期间另挂一个轻量轮询:每 1.2s 拉 message parts 喂给【同一个 onText handler】,
    // 卡片按 partID 幂等渲染 —— 不依赖事件流。与事件流路径重复也只是原地更新(onText/card 按 partID 去重),不重复。
    // P1:给 sendMessage 传 onRawMessages hook(opencode.js 新版:拉到原始消息列表直接回调,不用再轮询全量)——
    // 回调里跑与 pollTurnParts 同构的 part 映射(mapRawTurnParts);hook 生效期间自己的轮询降到 5s 兜底,hook 缺席维持 1.2s。
    const feedParts = (parts) => {
      for (const p of parts || []) {
        if (p.kind === 'tool') onText({ sessionId, role: 'assistant', kind: 'tool', text: p.text, partID: p.partID, status: p.status, toolInput: p.input, toolOutput: p.output, toolTitle: p.title, toolError: p.error, taskChild: p.taskChild || '' })
        else onText({ sessionId, role: 'assistant', kind: p.kind, text: p.text, partID: p.partID })
      }
    }
    let poll = null, hookLive = false
    const startPoll = () => { if (poll) return; poll = setInterval(async () => {
      try {
        const si2 = S.sessionInfo.get(sessionId); if (!si2 || !si2.wc || si2.wc.isDestroyed()) return
        const parts = await oc.pollTurnParts(si2.serve, sessionId); if (!parts) return
        feedParts(parts)
      } catch {}
    }, hookLive ? 5000 : 1200) }
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = null } }
    // ── 子 Agent 实况轮询:这台 serve 的 /event 不推子会话 message 事件(子 Agent 侧边栏曾整波空窗 —— 用户实测"启动几十秒没记录")。
    //    回合期间每 1.5s 轮询【直子会话】(parentID=本会话)的消息 parts,映射后以 subagent 事件喂同一个 onText(渲染层按 partID 幂等去重);
    //    子会话清单每 ~6s 经 listSessions 刷新(新派生的子 Agent 至多晚 6s 进栏,标题晚到也在这里改名)。
    const childSeen = new Map()   // childSid → title(本回合已发现的直子会话)
    let childLastList = 0, childPoll = null
    const pollChildren = async (timeoutMs) => {
      const si2 = S.sessionInfo.get(sessionId); if (!si2 || !si2.wc || si2.wc.isDestroyed()) return
      const now = Date.now()
      if (now - childLastList > 6000) {
        childLastList = now
        const all = await oc.listSessions(si2.serve, timeoutMs)
        for (const c of all || []) {
          if (!c || !c.id || c.parentID !== sessionId) continue
          const t = String(c.title || '')
          if (!childSeen.has(c.id) || (t && childSeen.get(c.id) !== t)) childSeen.set(c.id, t || '子agent')
        }
      }
      for (const [cid, ctitle] of childSeen) {
        let list = null
        try { list = await oc.getRawMessages(si2.serve, cid, { timeoutMs }) } catch {}
        if (!list) continue
        for (const p of mapRawTurnParts(list)) {
          if (p.kind === 'tool') onText({ sessionId, role: 'assistant', kind: 'tool', text: p.text, partID: p.partID, status: p.status, toolInput: p.input, toolOutput: p.output, toolTitle: p.title, toolError: p.error, subagent: true, agentId: cid, agentName: ctitle })
          else onText({ sessionId, role: 'assistant', kind: p.kind, text: p.text, partID: p.partID, subagent: true, agentId: cid, agentName: ctitle })
        }
      }
    }
    // 提问兜底轮询(这台 serve 的 /event 可能不推 question.asked——与流式静默同源,实测 question 工具干等 93s 无选项挂死):
    // 回合期间每 3s 拉 GET /question 待答清单,发现新待答就弹交互提问卡;SSE 若也推了,靠 questionSeen + pendingQuestion 双去重不重复弹。
    const questionSeen = new Set()
    let qPoll = null
    const startQPoll = () => { if (qPoll) return; qPoll = setInterval(async () => {
      try {
        const si2 = S.sessionInfo.get(sessionId); if (!si2 || !si2.wc || si2.wc.isDestroyed()) return
        // ★带 sessionId:GET /question 是整台 serve 的清单,同目录多卡共用一台 serve 是常态。
        //   不过滤就是"谁先轮到谁冒领本卡的 sessionId",而先轮到的若是分片隐藏卡,
        //   onQuestion 会走无人值守分支【当场自动拒答】—— 该弹提问卡的那张卡什么也不弹(见 opencode.listPendingQuestions 注释)。
        const list = typeof oc.listPendingQuestions === 'function' ? await oc.listPendingQuestions(si2.serve, sessionId) : null
        for (const q of (Array.isArray(list) ? list : [])) {
          const rid = q && (q.id ?? q.requestID ?? q.questionID ?? q.requestId)
          if (!rid || questionSeen.has(rid) || S.pendingQuestion.has(rid)) continue
          // 归属证不出来(老 fork 条目不带 sessionID):可见卡宁可多弹一次让人看见,
          // 无人值守卡(分片/scope)绝不认领 —— 认领 = 替别人当场拒答,是不可逆的误伤。
          if (q._unowned && ((S.shardWc && si2.wc && S.shardWc.has(si2.wc.id)) || (si2.tag && si2.tag.scope))) {
            log('question ' + rid + ' 无归属信息且本卡无人值守 → 不认领(交给可见卡)')
            continue
          }
          questionSeen.add(rid)
          log('question ' + rid + ' 经兜底轮询发现 → 弹到卡片' + (q._unowned ? '(条目无 sessionID,按本卡认领)' : ''))
          onQuestion({ sessionId, requestId: rid, questions: Array.isArray(q.questions) ? q.questions : [], v2: false, serve: si2.serve })
        }
      } catch {}
    }, 3000) }
    const stopQPoll = () => { if (qPoll) { clearInterval(qPoll); qPoll = null } }
    const startChildPoll = () => { if (childPoll) return; childPoll = setInterval(() => { pollChildren().catch(() => {}) }, 1500) }
    const stopChildPoll = () => { if (childPoll) { clearInterval(childPoll); childPoll = null } }
    const onRaw = (list) => {   // oc 新版 hook:原始消息列表直达 → 同构映射喂 onText;首火后轮询降 5s
      try {
        if (!hookLive) { hookLive = true; if (poll) { stopPoll(); startPoll() } }
        feedParts(mapRawTurnParts(list))
      } catch {}
    }
    startPoll()
    startQPoll()   // 提问兜底轮询(serve 可能不推 question.asked)
    startChildPoll()   // 子 Agent 实况轮询(/event 不推子会话 message 事件,侧边栏靠它填)
    try {
      // P3.4:knobs.promptAsync truthy → 走 prompt_async 发送通道(POST 立即返回不挂起等回合;fork 无端点 404 自动回落,见 opencode.js)
      const sendOpts = { onRawMessages: onRaw }
      try { if (S.settings && S.settings.knobs && S.settings.knobs.promptAsync) sendOpts.promptAsync = true } catch {}
      // 按消息级 Agent 切换(OMO 兼容):本卡在 TitleBar 选了非默认 agent → 随每条消息带上(schema 认 agent 字段)
      try { const ag = S.agentByWc && si.wc && S.agentByWc.get(si.wc.id); if (ag) sendOpts.agent = ag } catch {}
      const out = await oc.sendMessage(si.serve, sessionId, msg, model, fileArr, onNote, sendOpts)
      si.errStreak = 0   // 成功复位:模型降级路由的连错计数(见 catch)
      // 手动停止标记(opencode.js consumeAbortFlag,按形状防御调用):本轮被用户中止 → 卡内留一行灰字交代截断原因。
      // 标记同时透传给 wfTurnDone(snap.aborted):分片收官兜底据此判 interrupted 而不是 done(曾被中止≠干完)。
      let abortedFlag = false
      try { if (typeof oc.consumeAbortFlag === 'function') { abortedFlag = !!oc.consumeAbortFlag(sessionId); if (abortedFlag) onNote('已手动停止（本轮输出被中止）') } } catch {}
      // 每轮结束拉一次完整消息:本地转录(C4)与工作流终答(wfTurnDone)共用这一次拉取,不多打请求
      let msgs = null
      try { msgs = await oc.getMessages(si.serve, sessionId) } catch {}
      if (msgs) appendTranscript(sessionId, msgs)
      // 工作流卡:每轮终答进成果注册表+存档(升格方 workflow_result 取的就是它)。
      // POST 返回可能只带本轮【最后一条】消息(实测:多波 fan-out 轮的 12k 字结论在中段 text part,返回只剩 317 字收尾)——
      // 改从消息端点取"最后一个 user 之后的全部 assistant 文本"当本轮完整终答,谁长用谁。
      try {
        if (S.wfTurnDone && S.wfCardByWc && S.wfCardByWc.has(e.sender.id)) {
          let full = String(out || '')
          if (msgs) {
            let lastU = -1; msgs.forEach((m, i) => { if (m && m.role === 'user') lastU = i })
            const t = msgs.slice(lastU + 1).filter((m) => m && m.role === 'assistant' && m.text).map((m) => m.text).join('\n').trim()
            if (t.length > full.length) full = t
          }
          S.wfTurnDone(e.sender.id, full, { aborted: abortedFlag })
        }
      } catch {}
      // max_tokens 截断续写(CC query.ts 同款恢复注入):本轮 assistant 的 step-finish reason=length/max_tokens →
      // 注入"直接从断点接着写,剩余拆小"(每会话至多 3 次,断点连续命中防死循环;非截断轮复位计数)。
      // 之前只有轮末催"继续",弱模型从断点续写不精确、常重头再来(调研:CC 撞上限先升 64k 原样重试,仍截断才注入)。
      try {
        if (msgs && msgs.length) {
          const raw = await oc.getRawMessages(si.serve, sessionId)
          const list = Array.isArray(raw) ? raw : (raw && raw.data) || []
          let stopLen = false
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i]
            const role = (m && m.info && m.info.role) || (m && m.role)
            if (role !== 'assistant') continue
            for (const p of (m.parts || (m.data && m.data.parts) || [])) {
              if (p && (p.type === 'step-finish' || p.type === 'finish' || p.type === 'finish-step') && /length|max.?tokens|max.?output/i.test(String(p.reason || (p.state && p.state.reason) || ''))) stopLen = true
            }
            break   // 只看最后一条 assistant
          }
          if (stopLen) {
            si.maxTokResumeN = (si.maxTokResumeN || 0) + 1
            if (si.maxTokResumeN <= 3) {
              log('[ctx-resume] max_tokens 截断续写(' + si.maxTokResumeN + '/3) sid=' + sessionId)
              if (!si.wc.isDestroyed()) si.wc.send('card-inject', { text: '(系统提醒:输出 token 到上限被截断 —— 不要道歉、不要复述前文,直接从被切断的那一点接着写;把剩余工作拆得更小。)', disp: '输出被截断,自动续写(' + si.maxTokResumeN + '/3)', origin: 'system' })
            } else if (!si.wc.isDestroyed()) {
              si.wc.send('card-note', { text: '输出已连续 3 次被 max_tokens 截断 —— 建议手动把任务拆小,或点「重试本轮」', tone: 'muted' })
            }
          } else if (si.maxTokResumeN) si.maxTokResumeN = 0   // 非截断轮复位计数
        }
      } catch {}
      return out
    }
    catch (err) {
      // R7:发送失败把已消费的首条背景塞回 —— 下次重发(同一条消息)仍能完整注入,不丢项目背景/知识
      if (ctxPrefix) { try { S.firstMsgCtx.set(sessionId, ctxPrefix) } catch {} }
      const m = String((err && err.message) || err)
      // 模型降级路由(CC FallbackTriggeredError 同款):同一模型连续出错 ≥2 次且 settings.modelFallback 已配 →
      // 本会话切降级模型(仅切一次防乒乓);重试按钮/自动重试/后续发送都会走降级模型。
      // 配置形态 settings.json: "modelFallback": { "providerID": "...", "modelID": "...", "name": "..." }(内网备模型)。
      try {
        const fb = S.settings.modelFallback
        si.errStreak = (si.errStreak || 0) + 1
        if (fb && fb.modelID && si.errStreak >= 2 && !si._fellBack) {
          si._fellBack = true
          si.model = { providerID: fb.providerID, modelID: fb.modelID, name: fb.name || fb.modelID }
          log('[model-fallback] 主模型连续 ' + si.errStreak + ' 次出错,本会话切降级模型 ' + si.model.name + ' (sid=' + sessionId + ')')
          if (!si.wc.isDestroyed()) si.wc.send('card-note', { text: '主模型连续 ' + si.errStreak + ' 次出错,本会话已切到降级模型「' + si.model.name + '」—— 点「重试本轮」或后续发送将用它', tone: 'muted' })
        }
      } catch {}
      try { if (S.wfTurnError && S.wfCardByWc && S.wfCardByWc.has(e.sender.id)) S.wfTurnError(e.sender.id) } catch {}   // 分片回合报错:wfTurnDone 到不了,也要起收官兜底(window.js),否则 serve 中断一次就永远卡 running
      // 错误码人话化(api 错误形如 "POST /session/... -> 429: ..."):先具体码,再超时,最后连接中断(原文案保留)
      if (/->\s*429\b|rate\s*limit|too many requests/i.test(m)) {
        try { S.noteRateLimit && S.noteRateLimit() } catch {}   // ★并发自适应:撞到限流就让壳层把有效并发上限降一档(不降只会接着撞)
        throw new Error('内网模型限流（HTTP 429），等 30 秒再重试。')
      }
      if (/->\s*401\b|unauthorized/i.test(m))
        throw new Error('模型网关鉴权过期（HTTP 401），请联系管理员。')
      if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed?\s*out|->\s*(408|504)\b/i.test(m))
        throw new Error('模型响应超时，可重试。')
      if (/ECONNREFUSED|ECONNRESET|socket hang up|ENOTFOUND|EPIPE|fetch failed/i.test(m))
        throw new Error('引擎连接中断（serve 可能已退出）。关掉这张卡重开即可（已自动准备重启 serve）。')
      // 未识别的错误必须换落成新 Error 再抛:原始 err 若是非 Error 的异形对象(网关/SDK 错),
      // 过不了 Electron IPC 结构化克隆,渲染端只剩一句 "An object could not be cloned",真实原因被吞(实测)。
      throw new Error(m)
    } finally {
      stopPoll(); stopQPoll(); stopChildPoll()
      // ★turnBusy.delete 不在这里 —— 挪到本 finally 的最末尾。
      //   下面还要 await pollTurnParts(6000) + pollChildren(6000),摘早了这 6~12s 在并发闸眼里就是"这张卡闲着",
      //   于是回合还没真收尾就被补位,注释里那句"防机制性超发"直接失守。
      // P3.3 todo 权威数据源:serve 的 GET /session/:id/todo 比解析 todowrite 工具入参可靠(弱模型参数畸形会漏判)。
      // fire-and-forget:仅 wf 卡打;返回非空数组才覆盖注册表,空/异常一律不动(保留现有工具入参学习兜底);
      // oc 缺该函数(老版本)也可选链安全跳过。全程 try/catch,绝不阻塞回合收尾。
      try {
        if (S.wfTodos && typeof oc.getSessionTodo === 'function' && si.serve && si.wc && S.wfCardByWc && S.wfCardByWc.has(si.wc.id)) {
          oc.getSessionTodo(si.serve, sessionId).then((todos) => {
            try { if (Array.isArray(todos) && todos.length) S.wfTodos(si.wc.id, todos) } catch {}
          }).catch(() => {})
        }
      } catch {}
      // 中止/报错回合工具终态补拉:abort 时 serve 侧 markStopped 后直接收尾,父会话 task 等工具的 cancelled/error 终态
      // 不再推送 → 卡片工具块定格"运行中…"(实测病灶)。与下方 pollChildren 对称:轮末补一次 pollTurnParts 喂 onText 定格终态。
      // 6s 限时:停止途中最忌 serve 堵了无期陪等(停止耗时实测病灶),超时=放弃补拉不挡回合收尾。
      try { const tailParts = await oc.pollTurnParts(si.serve, sessionId, { timeoutMs: 6000 }); if (tailParts) feedParts(tailParts) } catch {}
      // 回合收尾再扫一遍子会话:最后一个 tick 之后落盘的子 Agent 产出/工具终态也补进侧边栏(不留差一口气的终态);同样 6s 限时
      try { await pollChildren(6000) } catch {}
      // ★真正的转闲点:尾部补拉全跑完才摘 busy,并同步上报壳层(3s 宽限打点 + 出队补位 + 侧栏/托盘都挂在那一条出口)。
      //   seq 守卫:上面两次 await 期间若已开了新回合,这一轮不许摘 —— 否则新回合全程被记成空闲。
      if ((si.turnSeq || 0) === myTurn) {
        turnBusy.delete(sessionId)
        try { if (S.setCardBusy) S.setCardBusy(e.sender.id, false) } catch {}
      }
    }
  })

  // 模型选择:列出可用模型 + 设置本卡模型(每个模块各自选)
  // C1:走 oc 缓存版(listModels 第二参 {force};老版本忽略第二参=现状直拉,防御兼容)。force 只在用户显式刷新时用。
  // 本卡无 serve → 不再 ensureServe 白起一个引擎(仅为列模型拉起 serve 纯属浪费),回 { models: [], note } ——
  // 渲染层按 .length 判空,对象形状与空数组同样落空,UI 安然显示"没拿到模型列表"。
  ipcMain.handle('list-models', async (e, opts) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    // 本卡无会话(对话坞/输入框)→ 借任一在跑的健康 serve 列模型(只读 /config/providers,不为它白起引擎)
    const serve = (si && si.serve) || (oc.anyHealthyServe && oc.anyHealthyServe())
    if (!serve || !serve.base) return { models: [], note: '引擎未启动' }
    try { return await oc.listModels(serve, { force: !!(opts && opts.force) }) } catch { return [] }
  })
  ipcMain.handle('card-set-model', (e, model) => {
    const m = (model && model.modelID) ? { providerID: model.providerID, modelID: model.modelID, name: model.name } : null
    S.modelByWc.set(e.sender.id, m)   // 无论会话就绪与否都先记住 —— 卡启动期间的选择不再被静默吞掉
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (si) si.model = m
    // 持久化进历史:卡坞重开这段会话时恢复当初所选
    if (sessionId) { const h = S.history.find((x) => x.id === sessionId); if (h) { h.model = m; try { touchHistory(sessionId) } catch {} } }
    // applied=false → UI 提示"会话就绪后自动生效",不再假报成功
    return { ok: true, applied: !!si, model: m || S.settings.model || null }
  })
  // ── Agent 切换(OMO 兼容):GET /agent 列 primary 非隐藏的 Agent;S.agentByWc 按卡记选择,发卡逐条消息带上 ──
  // 会话级在建会话时也带(createSession 第四参),消息级双保险(opencode 的 agent 是按消息生效的)。
  if (!S.agentByWc) S.agentByWc = new Map()
  ipcMain.handle('list-agents', async (e) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    const serve = (si && si.serve) || (oc.anyHealthyServe && oc.anyHealthyServe())
    if (!serve || !serve.base || typeof oc.listAgents !== 'function') return { agents: [], note: '引擎未启动' }
    const list = await oc.listAgents(serve)
    if (!list) return { agents: [], note: '本 serve 不支持 Agent 清单' }   // 老 serve:UI 隐藏切换入口
    return { agents: list.filter((a) => a.mode === 'primary' && !a.hidden) }
  })
  ipcMain.handle('card-set-agent', (e, name) => {
    const n = String(name || '').trim()
    if (n) S.agentByWc.set(e.sender.id, n); else S.agentByWc.delete(e.sender.id)   // 空 = 回默认(build)
    if (S.agentByWc.size > 200) S.agentByWc.delete(S.agentByWc.keys().next().value)
    try { S.audit && S.audit('session', 'Agent 切换(按会话)', { wcId: e.sender.id, agent: n || 'default' }) } catch {}
    return { ok: true, agent: n || null }
  })

  ipcMain.on('card-abort', (e, reason) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    // ★★留痕(2026-08-09,查了很久才定位):这条 IPC 能把一个正在干活的回合当场掐掉,而它原来【一个字都不记】。
    // 现场:编排的验收片跑到第 9 步被中止,serve 侧只留一条 message=cancel + MessageAbortedError,
    // 壳层日志里什么都没有 —— 我把壳层所有 abort 路径(ctx-hang / editloop / ctx-gate / 压缩 / stop-all)
    // 逐个查完全是 0,因为真凶在【渲染端】的绕圈看门狗,它只发这条不打日志的 IPC。
    // 排除法猜出来的东西不算证据。任何能杀活的路径都必须自报姓名。
    const _reg = S.wfCardByWc && S.wfCardByWc.get(e.sender.id)
    log('[card-abort] 中止本轮 sid=' + String(sessionId || '(无会话)').slice(0, 18)
      + ' 原因=' + (String(reason || '').trim() || '(未标注 —— 调用方应传 reason)')
      + (_reg ? (' | 卡=' + (_reg.runId ? ('编排 ' + _reg.runId + '/' + (_reg.nodeId || '?')) : 'wf') + (_reg.isVerify ? '(验证片)' : '')) : ''))
    if (si) oc.abort(si.serve, sessionId)
  })

  // 权限模式按会话(TitleBar chip 一卡一开关):S.permModeByWc wcId → 'auto'|'default';
  // 缺席回退全局 settings.permMode(设置页已挪走,该值只作新卡初始默认,power user 可改 settings.json)。
  // 关卡清理链(card-cleanup.js)随卡摘除,防泄漏。
  if (!S.permModeByWc) S.permModeByWc = new Map()
  ipcMain.handle('card-perm-mode-set', (e, mode) => {
    const m = mode === 'auto' ? 'auto' : 'default'
    S.permModeByWc.set(e.sender.id, m)
    if (S.permModeByWc.size > 200) S.permModeByWc.delete(S.permModeByWc.keys().next().value)   // 粗粒度防涨
    try { S.audit && S.audit('permission', '权限模式切换(按会话)', { wcId: e.sender.id, mode: m }) } catch {}
    return m
  })
  ipcMain.handle('card-perm-mode-get', (e) => S.permModeByWc.get(e.sender.id) || (S.settings.permMode === 'auto' ? 'auto' : 'default'))

  // read-spill 落盘文件读取(卡片工具块"查看全文"按钮):read-spill 插件把大输出外溢到临时目录后,
  // 卡片渲染的也是被截断的通知,用户想看全文只能经这里 —— 围栏:只许 spill 目录下的 .txt,realpath 防逃逸,≤1MB。
  ipcMain.handle('spill-read', (_e, p) => {
    try {
      const file = String((p && p.file) || '')
      if (!file) return { error: '缺少 file' }
      const spillRoot = process.env.BOCOMHERMES_READ_SPILL_DIR || path.join(os.tmpdir(), 'bocomhermes-read-spill')
      const root = fs.realpathSync.native ? fs.realpathSync.native(spillRoot) : fs.realpathSync(spillRoot)
      const abs = fs.realpathSync(file)
      const rel = path.relative(root, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: '路径越界(只允许 read-spill 临时目录)' }
      const st = fs.statSync(abs)
      if (st.size > 1024 * 1024) return { error: '文件超过 1MB(' + Math.round(st.size / 1024) + 'KB),请用编辑器打开' }
      return { text: fs.readFileSync(abs, 'utf8'), chars: st.size }
    } catch (e) { return { error: e.message } }
  })

  // 卡片上下文用量 chip:取本卡会话最近一次 assistant 调用的真实 token 用量(opencode.js 经 SSE/轮询登记)。
  // 无会话或无数据 → null(卡片静默回落字符估算);tokens=实际进上下文的量(input+cacheRead+cacheWrite),limit 留给后续模型元数据。
  // ── 滚动 session memory(CC 同款):每次交棒的交接单沉淀到 userData/compacts/<sid>.log,
  // 下次压缩直接以它为基座增量合并(摘要不再每次从零重写,弱模型漂移更少、省一次全量总结) ──
  const compactsDir = () => { const d = path.join(require('electron').app.getPath('userData'), 'compacts'); try { fs.mkdirSync(d, { recursive: true }) } catch {}; return d }
  ipcMain.handle('compact-log-append', (_e, { sid, text }) => {
    try {
      const f = path.join(compactsDir(), String(sid || 'unknown').replace(/[^\w-]/g, '_') + '.log')
      fs.appendFileSync(f, '\n\n===== ' + new Date().toISOString() + ' =====\n' + String(text || '').slice(0, 24000))
      return { ok: true, path: f }
    } catch (e) { return { ok: false, err: e.message } }
  })
  ipcMain.handle('compact-log-last', (_e, sid) => {
    try {
      const f = path.join(compactsDir(), String(sid || 'unknown').replace(/[^\w-]/g, '_') + '.log')
      if (!fs.existsSync(f)) return ''
      const t = fs.readFileSync(f, 'utf8')
      const at = t.lastIndexOf('===== ')
      return (at >= 0 ? t.slice(at) : t).replace(/^===== .*?=====\n/, '').trim().slice(0, 24000)
    } catch { return '' }
  })

  ipcMain.handle('card-usage', (e) => {    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (!si) return null
    const u = oc.getSessionUsage(si.serve, sessionId)
    return u ? { tokens: u.prompt, total: u.total, limit: null, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 } : null   // cacheRead/Write 给 chip 算 KV-cache 命中率(Manus:命中率是生产 Agent 第一指标,前缀稳定性没度量=瞎调)
  })

  // 子 Agent 完成态权威查询(卡片侧边栏用):serve 的 task 完成事件常缺 taskChild(尤其 fork),gid 对不上时
  // 子 Agent 一直"运行中"、计时永不封顶(实测)。改为按子会话消息判:最后一条 assistant 有文本且无未完成 tool part = 完成。
  ipcMain.handle('sub-status', async (e, ids) => {
    const out = {}
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (!si) return out
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 24)) {
      try {
        const msgs = await oc.getMessages(si.serve, String(id))
        const last = [...(msgs || [])].reverse().find((m) => m && m.role === 'assistant')
        if (!last) { out[id] = false; continue }
        const toolsRunning = (last.tools || []).some((t) => !/complet|success|done|finish|error|fail|cancel|abort|deny|reject/i.test(String(t.status || '')))
        out[id] = !toolsRunning && !!String(last.text || '').trim()
      } catch { out[id] = false }
    }
    return out
  })

  ipcMain.on('permission-reply', (_e, { requestId, decision }) => {
    const sessionId = S.pendingPerm.get(requestId); const meta = S.pendingPerm.get(requestId + ':meta'); S.pendingPerm.delete(requestId); S.pendingPerm.delete(requestId + ':meta')
    const si = sessionId && S.sessionInfo.get(sessionId)
    const d = decision === 'always' ? 'always' : decision === 'once' ? 'once' : 'reject'
    if (si) oc.replyPermission(si.serve, sessionId, requestId, d)
    // 审计:写/执行类操作的人工批准(工具+目标),reject 也记(留痕拒绝)
    try { S.audit && S.audit('permission', (d === 'reject' ? '拒绝' : '批准' + (d === 'always' ? '(总是)' : '')) + '权限:' + ((meta && meta.tool) || '?'), { decision: d, tool: meta && meta.tool, detail: (meta && meta.detail || '').slice(0, 300), sessionId }) } catch {}
  })

  // 交互提问卡的应答回传:reply=用户点选/自定义的答案(labels 按问题序),reject=拒绝回答(等价 TUI 的 Esc)
  // 【顺序契约·勿改】先 await 送达成功,再摘 pendingQuestion 记录。
  // ★原来是 get 完立刻 delete 再 await,而 replyQuestion 不吞错直接抛(api() 对非 2xx 与连接错都 reject)——
  //   一次网络抖动,记录就没了,requestId 再也查不回来:
  //     ① 提问卡这边已置 sent=true,作答 UI 消失,用户只剩一句"没送达",连重答的入口都没有;
  //     ② 关卡清理链(S.dropPendingQuestion)也找不到它,连"兜底 reject 解放 serve"这条退路一起断掉;
  //     ③ serve 侧的 question 工具继续干等,本轮就挂在那(注释里记录过的 88s 病灶)。
  //   送不到就把记录留着 —— 卡片据此改回可重答态,清理链也还能兜底 reject。
  // sending 标记不能省:delete-first 以前顺带充当了防重入闸(第二次 invoke 拿不到 q 就返回失效),
  // 改成保留记录后,慢请求 + 用户重复点会并发两次 POST。
  ipcMain.handle('question-reply', async (_e, { requestId, answers }) => {
    const q = S.pendingQuestion.get(requestId)
    if (!q) return { ok: false, err: '这个提问已失效(可能已被应答或回合中断)' }
    if (q.sending) return { ok: false, err: '正在送达中,别重复提交' }
    S.pendingQuestion.set(requestId, Object.assign({}, q, { sending: true }))
    try {
      await oc.replyQuestion(q.serve, q.sessionId, requestId, Array.isArray(answers) ? answers : [], q.v2)
      S.pendingQuestion.delete(requestId)   // 送达成功才摘
      try { S.audit && S.audit('question', '回答提问', { requestId, answers: JSON.stringify(answers || []).slice(0, 300), sessionId: q.sessionId }) } catch {}
      return { ok: true }
    } catch (e) {
      S.pendingQuestion.set(requestId, Object.assign({}, q, { sending: false }))   // 留住记录 + 解锁,让卡片能重答
      return { ok: false, err: String((e && e.message) || e), retryable: true }
    }
  })
  // 拒答同理:rejectQuestion 内部吞错(fire-and-forget),这里靠返回值判不了成败,
  // 所以维持"先删",但把删挪到 await 之后 —— 至少 serve 真的收到过一次拒答请求。
  ipcMain.handle('question-reject', async (_e, { requestId }) => {
    const q = S.pendingQuestion.get(requestId)
    if (!q) return { ok: false, err: '这个提问已失效(可能已被应答或回合中断)' }
    try { await oc.rejectQuestion(q.serve, q.sessionId, requestId, q.v2) } catch {}
    S.pendingQuestion.delete(requestId)
    try { S.audit && S.audit('question', '拒绝回答提问', { requestId, sessionId: q.sessionId }) } catch {}
    return { ok: true }
  })

  ipcMain.handle('open-loc', (e, { file, line }) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    const baseDir = (si && si.serve && si.serve.dir) || S.settings.projectDir || ''
    let full = file
    try { if (!path.isAbsolute(file) && baseDir) full = path.join(baseDir, file) } catch {}
    openInEditor(full, line)
  })

  ipcMain.handle('apply-diff', (e, diffText) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    const baseDir = (si && si.serve && si.serve.dir) || S.settings.projectDir || ''
    const res = applyDiffToDisk(baseDir, String(diffText || ''))
    // 审计:写文件(diff 应用),记文件清单与成败,不记文件内容
    try { const okN = res.filter((r) => r.ok).length; S.audit && S.audit('edit', '应用 diff 到 ' + okN + '/' + res.length + ' 文件', { dir: baseDir ? require('path').basename(baseDir) : '', files: res.map((r) => ({ f: r.file, ok: r.ok, warn: r.warn || r.error || '' })).slice(0, 50), sessionId }) } catch {}
    return res
  })
}
