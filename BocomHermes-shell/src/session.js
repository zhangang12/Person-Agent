'use strict'
const { exec } = require('child_process')
const knowledge = require('./knowledge')
const writescope = require('./writescope')   // 分片写归属硬闸(编码模式):write/edit 越界拒

// deps 可选项:replaceHistoryId(oldId, newId) —— stale 重开时把旧历史条目原地换 id(保留 created/title/model);
// 没给就退化为现状(recordHistory 新增条目)。由 window.js 装配层接线。
module.exports = function initSession(S, { ipcMain, path, fs, shell, oc, log, recordHistory, touchHistory, replaceHistoryId }) {
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
      // 弱模型双向纪律(P1.3,2026-07-26,依据 external/claude-code-提示词工程借鉴.md §1.2/§3):不粉饰也不许防御性打折;
      // 委派回报三不(直接用/不偷看/不编造);系统提醒元定义(防把注入提醒误归因于当前文件/工具输出)。
      // 提示词改动纪律:小步单变量、两周观测期,台账见 docs/项目记忆/弱模型行为台账.md
      + '<如实汇报>做成了什么、没做成什么照实说：跑过验证再说"完成"；没法验证就明说"还没验证"；失败贴原始输出，不许粉饰成成功；确认通过的也直说，不要防御性打折扣。</如实汇报>\n'
      + '<委派回报纪律>子 Agent 回报后直接用它的结论；不要偷看子 Agent 的中间过程（会把噪音灌进你的上下文）；它没回报的内容不要编造。</委派回报纪律>\n'
      + '<系统提醒说明>会话中卡片注入的提醒文字是系统侧提醒，与你正在读的文件内容、工具输出无关，按提醒本身行事即可。</系统提醒说明>\n'
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

【步骤】(全部用 browser_ 系 MCP 工具,bash 只用于起服务)
1. 确认前端在跑:任务已给入口 URL 就直接进第 2 步;否则按项目文档(CLAUDE.md/README/package.json scripts)用 bash 起 dev 服务(后台起),等到能访问再继续。起不来 → 如实报告"服务起不来+报错原文"并停止,不要编造验证结果。
2. browser_navigate 打开入口 URL,记下页面标题与最终 URL。
3. 装错误收集器并刷新:browser_eval 执行
   window.__errlog=[];addEventListener('error',e=>__errlog.push(String(e.message||e)));addEventListener('unhandledrejection',e=>__errlog.push('Promise:'+String(e.reason)));location.reload();'ok'
4. 等页面加载(bash sleep 3),然后 browser_eval 收集:
   JSON.stringify({errors:window.__errlog||[],failedRes:performance.getEntriesByType('resource').filter(r=>r.responseStatus>=400).map(r=>r.name).slice(0,10),bodyLen:document.body.innerText.trim().length,title:document.title})
5. 若改动涉及交互(按钮/表单/跳转):用 browser_click / browser_type 走一遍关键交互,再按第 4 步收集一次。
6. browser_screenshot 截图,记下返回的图片路径(作为证据随回报给出)。
7. browser_close 关闭浏览器。

【判定】
- 通过:errors 为空 且 failedRes 为空 且 bodyLen > 50(不是白屏)。
- 失败:任一不满足 → 把 errors/failedRes 原文 + 截图路径带回,先修代码,再重新自验一遍;修不好就如实说"没验过,卡在 X",不许说"完成了"。

【纪律】
- 不许用"代码逻辑上看没问题"代替打开页面。
- 截图路径必须随最终回报给出(别人要点开看)。`,
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
  function onPermission({ sessionId, requestId, tool, detail }) {
    const si = S.sessionInfo.get(sessionId); if (!si) return
    if (oc.AUTO_ALLOW.has(tool)) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    // 天枢技能工具族(skill_*):回放接管/断点解析的 MCP 工具,引擎侧已有门禁(如 page_act 仅接管期可执行),
    // 不再叠人工审批 —— 否则 Agent 接管每一步都弹批准框,混合执行没法用。MCP 工具名可能带服务前缀,按含 skill_ 匹配。
    if (/(^|[._-])skill_/.test(String(tool || ''))) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    // 用户权限规则 deny(先于一切自动放行,分片卡同样生效):命中即拒 + 卡片留痕
    const permDenyHit = permRulesHit('deny', tool, detail)
    if (permDenyHit) {
      log('权限规则拦截(deny):' + permDenyHit + ' 命中 ' + String(tool) + '(' + String(detail || '').slice(0, 80) + ')')
      try { S.audit && S.audit('permission', '规则拒绝(deny)', { rule: permDenyHit, tool: String(tool || ''), detail: String(detail || '').slice(0, 200) }) } catch {}
      try { if (si.wc && !si.wc.isDestroyed()) si.wc.send('card-note', { text: '权限规则拦截(deny)：' + permDenyHit + ' —— 已拒绝 ' + tool, tone: 'muted' }) } catch {}
      oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return
    }
    // 多层派发分片卡:无人值守(按主控已批准的方案跑),权限请求自动放行 —— 否则 task 子 Agent/写文档都卡在看不见的批准框上,
    // 子 Agent 永远起不来(实测病灶)。范围限本卡会话,关卡即失效;全程工具日志留痕。
    if (S.shardWc && si.wc && S.shardWc.has(si.wc.id)) {
      // 写归属硬闸(编码模式):分片登记了 writeScope 时,write/edit 的目标文件必须在归属清单内 ——
      // 并行分片写冲突的头号死因就是越界写别的片的文件(探查类分片无归属 → 不设闸)。
      try {
        const mreg = S.wfCardByWc && S.wfCardByWc.get(si.wc.id)
        const scope = mreg && Array.isArray(mreg.writeScope) ? mreg.writeScope : null
        if (scope && scope.length && /^(write|edit)(_[a-z]+)*$/i.test(String(tool || ''))
            && !writescope.matchScope(scope, (si.serve && si.serve.dir) || '.', String(detail || ''))) {
          log('write-scope 拦截:分片 ' + mreg.id + ' 越界写 ' + String(detail || '').slice(0, 80) + ' (归属: ' + scope.join(', ') + ')')
          try { S.audit && S.audit('workflow', '写归属越界拦截', { shard: mreg.id, path: String(detail || '').slice(0, 200), scope: scope.join(', ') }) } catch {}
          oc.replyPermission(si.serve, sessionId, requestId, 'reject')
          return
        }
        // bash 写文件同一道闸:弱模型常绕到 cat > f / tee / sed -i 写文件(归属闸只管 write/edit = 形同虚设)。
        // 提取命令里的写目标逐个过归属;解析不出的(含 $/`/~ 或 detail 被 200 字截断)宁可放过 —— 提示词层还有"bash 写文件视为越权"的规矩兜底。
        if (scope && scope.length && /^bash(_[a-z]+)*$/i.test(String(tool || ''))) {
          const dir = (si.serve && si.serve.dir) || '.'
          const bad = writescope.bashWriteTargets(String(detail || '')).filter((t) => !writescope.matchScope(scope, dir, t))
          if (bad.length) {
            log('write-scope 拦截:分片 ' + mreg.id + ' bash 越界写 ' + bad[0] + ' (归属: ' + scope.join(', ') + ')')
            try { S.audit && S.audit('workflow', '写归属越界拦截(bash)', { shard: mreg.id, path: String(bad[0]).slice(0, 200), scope: scope.join(', ') }) } catch {}
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
    // ── auto 模式(settings.permMode='auto'):写/执行全部自动放行 —— 位置刻意在 deny 规则之后(红线不可翻)、
    // 分片分支之后(分片写归属闸不受影响)、allow 规则之前(语义更宽);edit 同享预检(oldString 未命中照样拒带纠偏)。
    // 每次放行记审计 + 卡内一行灰字(用户看得见放了什么,不发批准确认框)。
    if (S.settings.permMode === 'auto') {
      try { S.audit && S.audit('permission', 'auto 模式放行', { tool: String(tool || ''), detail: String(detail || '').slice(0, 200) }) } catch {}
      if (/^edit(_[a-z]+)*$/i.test(String(tool || ''))) {
        ;(async () => {
          try {
            const peek = await buildPermPeek(si, sessionId, tool, detail)
            if (peek && peek.miss) { log('auto 模式 edit 预检拦截:' + peek.miss.filePath); oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return }
          } catch {}
          oc.replyPermission(si.serve, sessionId, requestId, 'once')
        })()
        return
      }
      oc.replyPermission(si.serve, sessionId, requestId, 'once')
      try { si.wc.send('card-note', { text: 'auto 模式已自动放行：' + tool + (detail ? ' — ' + String(detail).slice(0, 80) : ''), tone: 'muted' }) } catch {}
      return
    }
    // 用户权限规则 allow(少弹框 UX 层):命中即放行一次,不再弹批准框(红线在前的 deny 已先判)
    const permAllowHit = permRulesHit('allow', tool, detail)
    if (permAllowHit) { log('权限规则放行(allow):' + permAllowHit + ' 命中 ' + String(tool)); oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    S.pendingPerm.set(requestId, sessionId)
    S.pendingPerm.set(requestId + ':meta', { tool, detail: detail || '' })   // 供审计留痕(批准/拒绝了什么)
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
        if (detail && inp.filePath && String(inp.filePath).length >= 8 && !String(detail).includes(String(inp.filePath))) continue
        const oldS = String(inp.oldString || ''), newS = String(inp.newString != null ? inp.newString : (inp.content != null ? inp.content : ''))
        if (!oldS && !newS) return out
        const L = []
        if (oldS) { for (const l of oldS.split('\n').slice(0, 12)) L.push('- ' + l); if (oldS.split('\n').length > 12) L.push('…') }
        if (newS) { for (const l of newS.split('\n').slice(0, 20)) L.push('+ ' + l); if (newS.split('\n').length > 20) L.push('…') }
        out.diff = L.join('\n').slice(0, 4000)
        // 编辑预检:oldString 对不上文件 → 给实际区域(行号标注),让模型拿着真内容重写,别白撞
        if (oldS && inp.filePath) {
          try {
            const base = path.resolve((si.serve && si.serve.dir) || '.')
            const abs = path.resolve(base, String(inp.filePath))
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
                out.miss = { filePath: String(inp.filePath), probe: probe.slice(0, 60), region }
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
  // 只路由到对话卡:管线/监控窗口(sessionInfo 带 tag.scope)没有提问 UI,会话无主/卡已毁同理 ——
  // 一律自动 reject 兜底(不拒就把回合挂死,实测 88s 等用户 Esc)。子 agent 的提问会路由回父卡(dispatch 已归到根会话)。
  function onQuestion({ sessionId, requestId, questions, v2, serve }) {
    const si = S.sessionInfo.get(sessionId)
    if (!si || !si.wc || si.wc.isDestroyed() || (si.tag && si.tag.scope)) {
      log('question ' + requestId + ' 自动拒答:' + (!si ? '会话无主' : si.wc && si.wc.isDestroyed() ? '卡已毁' : 'scope 窗口'))
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
  // 真挂死交给 5min 看门狗 —— 宁可放过,不可错杀(教训:会话级 flag+补扫曾把一整波并行子 Agent 团灭)。
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
  function onText({ sessionId, text, role, partID, kind, status, delta, toolInput, toolOutput, toolTitle, toolError, subagent, agentId, agentName, taskChild, taskDesc, taskChars }) {
    const si = S.sessionInfo.get(sessionId); if (!si || !si.wc || si.wc.isDestroyed()) return
    if (role && role !== 'assistant') return
    si.lastEventAt = Date.now()   // 主回合活动探针:分片挂死看门狗(下方 setInterval)据此判静默
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
          const fp = inp && (inp.filePath || inp.path || inp.filename)
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
            const fp = String(inp.path || inp.file || inp.filePath || '')
            if (fp) S.wfAction(si.wc.id, { kind: 'doc', label: '读文档：' + path.basename(fp), detail: fp })
          // bash:命令流水(验证证据闸的原料 —— 编码分片"跑没跑过构建/测试"据此机判,不靠模型自觉汇报)
          } else if (/^bash$/i.test(tname)) {
            const cmd = String(inp.command || inp.cmd || '').replace(/\s+/g, ' ').trim()
            if (cmd) S.wfAction(si.wc.id, { kind: 'cmd', label: cmd.slice(0, 120), detail: '' })
          // browser_* 浏览器动作(验证证据闸的原料之二:前端"浏览器自验"据此机判 —— 打开过页面/截过图/跑过页面断言才算验过前端)
          } else if (/(^|[._-])browser_(navigate|screenshot|eval|click|type)$/i.test(tname)) {
            const brief = String(inp.url || inp.selector || inp.expression || '').replace(/\s+/g, ' ').slice(0, 80)
            S.wfAction(si.wc.id, { kind: 'browser', label: '浏览器:' + (tname.match(/browser_\w+$/) || [tname])[0] + (brief ? ' ' + brief : ''), detail: String(inp.url || '') })
          }
        } catch {}
      }
      // 上下文工程·读文件字节计量:readN 只数文件个数,但"没读几个文件上下文就没了"的杀手是【字节】(内网实测反馈)。
      // 单次 read 输出 >12k 字 → 提醒分段读(纪律①单次 ≤400 行是软约定,弱模型不守,这里即时纠偏);
      // 会话累计读字节 >60k(≈128k 的三成) → 提醒停止亲自深读、改派 task 子 Agent(回报一句话+路径)。
      // 工作流/分片卡走 card-inject(真消息进会话,隐藏卡也收得到),普通卡走 card-note(可见灰字)。每档每会话只提醒一次。
      try {
        if (/^read$/i.test(String(text || '')) && !subagent && toolOutput && !toolError) {
          const isWf = S.wfCardByWc && S.wfCardByWc.has(si.wc.id)
          const n = String(toolOutput).length
          si.readBytes = (si.readBytes || 0) + n
          if (n > 12000 && !si._bigReadWarned) {
            si._bigReadWarned = true
            const tip = '单次 read 读入 ' + n + ' 字 —— 大文件请用 offset/limit 分段精读（单次 ≤400 行），或派 task 子 Agent 深读'
            if (isWf) si.wc.send('card-inject', { text: '(系统提醒:' + tip + '。子 Agent 结论落盘成文档,上下文里只留路径+一句话。)', disp: '上下文提醒:' + tip })
            else si.wc.send('card-note', { text: tip, tone: 'muted' })
          }
          if (si.readBytes > 60000 && !si._readBytesWarned) {
            si._readBytesWarned = true
            const tip2 = '本会话已累计读入 ' + Math.round(si.readBytes / 1000) + 'k 字文件内容（约占 128k 上下文三成）—— 停止亲自深读：改造/转换/迁移类任务应【逐文件派 task 子 Agent】（它读原文 → 写目标文件 → 只回路径+一句差异），源码全文只许进叶子子 Agent 的上下文'
            if (isWf) si.wc.send('card-inject', { text: '(系统提醒:' + tip2 + '。)', disp: '上下文提醒:' + tip2 })
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
  // 主控永远等不到这片,整链静默卡死(审查实测)。挂死看门狗(子会话 5min 那只)只盯 task 子会话,不盯卡主回合。
  // 判据:分片卡(或主控卡)有回合在飞(turnBusy)且 300s 无任何流事件(onText 探针)→ oc.abort,
  // 中止后走 aborted/报错通道按 interrupted 收官 —— 宁可误杀可重派,不可静默卡死无人知。
  setInterval(() => {
    try {
      const now = Date.now()
      for (const [sid, si] of S.sessionInfo) {
        if (!turnBusy.has(sid)) continue
        if (!si || !si.wc || si.wc.isDestroyed()) continue
        const unattended = (S.shardWc && S.shardWc.has(si.wc.id)) || (S.wfCardByWc && S.wfCardByWc.get(si.wc.id) && S.wfCardByWc.get(si.wc.id).kind === 'orch')
        if (!unattended) continue   // 可见工作流卡有人看着(90s/5min 提醒在渲染端),不代劳
        const last = si.lastEventAt || 0
        if (now - last < 300000) continue
        log('[ctx-hang] 挂死看门狗:分片/主控主回合 ' + Math.round((now - last) / 1000) + 's 静默 → 自动中止 (sid=' + sid.slice(0, 18) + ')')
        si.lastEventAt = now   // 本轮只杀一次;abort 没生效的话下个 tick 再杀
        try { oc.abort(si.serve, sid) } catch {}
      }
    } catch {}
  }, 45000)

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
          out.push({ partID: cid + ':tool', kind: 'tool', text: p.tool || 'tool', status: st.status || '', input: st.input, output: st.output, title: st.title, error: st.error })
        }
      }
    }
    return out
  }

  // ── 卡死子 Agent 看门狗(判死不判慢,与卡内"绕圈看门狗"互补:那条治主 Agent 反复读同批文件,这条治子 Agent 写结论挂死)──
  // 实测病灶(2026-07-20,两次):子 Agent 探查全做完、写最终结论的 LLM 调用无声挂死(文本空、消息不收尾、serve 无请求级超时),
  // 父卡 task 永 running 拖住整波。判据:父卡在忙 + 子会话静默 > 5min + generationStalled(最后 assistant 未收尾且无工具在跑)
  // → 只中止这个子会话(task 报"Task cancelled",主 Agent 重派或带其余结果综合,实测恢复路径)。有工具在跑/已收尾一律放过:慢≠死。
  const SUB_STALL_MS = 5 * 60 * 1000   // 旋钮候选:生成挂起容忍(网关掉链子常见,但 5min 无字基本是真死)
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
            if (!upd || Date.now() - upd < SUB_STALL_MS) continue   // 有动静就不判死
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
            log('watchdog: 子会话 ' + c.id + ' (' + (c.title || '') + ') 静默 >5min 且生成挂死 → 自动中止(父卡可重派)')
            try { await oc.abort(serve, c.id) } catch {}
            try { if (!wc.isDestroyed()) wc.send('card-note', { text: '⚠ 子 Agent「' + String(c.title || c.id).slice(0, 40) + '」写结论时挂死(5 分钟无进展),已自动中止 —— 主 Agent 会重派或带其余结果继续;若反复发生多半是任务过大触发压缩循环,重派请拆小(指令≤2000字、只给路径)', tone: 'muted' }) } catch {}
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
    return si.model || S.settings.model || null
  }
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
  ipcMain.handle('card-init', async (e, opts) => {
    try {
    const sid = opts && opts.sid
    const wantTitle = (opts && opts.title) || ''
    if (sid) {
      const h = S.history.find((x) => x.id === sid)
      const dir = S.cardDir.get(e.sender.id) || (h && h.dir) || S.settings.projectDir || ''
      if (h && h.dir && !S.cardDir.has(e.sender.id)) S.cardDir.set(e.sender.id, h.dir)   // 钉住历史目录,后续 reinit 不漂回全局
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
        return { sessionId: sid, project: proj, dir, model, reattached: true, messages, running: turnBusy.has(sid) }
      }
      const ns = await oc.createSession(serve, wantTitle || (h && h.title) || 'BocomHermes 对话', dir)  // 已不在 → 新开一段(带项目目录)
      if (!ns) throw new Error('create session failed')
      S.sessionByWc.set(e.sender.id, ns)
      S.sessionInfo.set(ns, { wc: e.sender, serve })
      trackWcSession(e.sender.id, ns)
      const model1 = replayModel(e.sender.id, ns)
      S.pushServeHealth && S.pushServeHealth(e.sender, serve)
      // C2:知识不在开卡时注入(标题片段命中差),留 KNOWLEDGE_SLOT 占位,首条发送时用完整消息现场命中(见 card-send)
      const ctx1 = loadMemory() + loadProjectContext(dir) + KNOWLEDGE_SLOT; S.firstMsgCtx.set(ns, ctx1)
      // R8 stale 历史:旧条目原地换 id(保留 created/title/model);装配层没给 replaceHistoryId 就退化为新增条目
      if (typeof replaceHistoryId === 'function') { try { replaceHistoryId(sid, ns) } catch { recordHistory(ns, wantTitle || (h && h.title), dir) } }
      else recordHistory(ns, wantTitle || (h && h.title), dir)
      // C4 同款回退:serve 已没有这段会话(进程重启等)→ 本地转录回放旧对话(只读回看,新消息写进新会话)
      let txMsgs = []; try { txMsgs = readTranscript(sid); if (txMsgs.length) log('stale reattach: replay local transcript (' + txMsgs.length + ' entries) for ' + sid) } catch {}
      return { sessionId: ns, project: proj, dir, model: model1, reattached: false, stale: true, running: false, messages: txMsgs }
    }
    const dir = S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话', dir)
    if (!sessionId) throw new Error('create session failed')
    S.sessionByWc.set(e.sender.id, sessionId)
    S.sessionInfo.set(sessionId, { wc: e.sender, serve })
    trackWcSession(e.sender.id, sessionId)
    const model0 = replayModel(e.sender.id, sessionId)
    S.pushServeHealth && S.pushServeHealth(e.sender, serve)
    const ctx0 = loadMemory() + loadProjectContext(dir) + KNOWLEDGE_SLOT; S.firstMsgCtx.set(sessionId, ctx0)   // C2:知识留占位,发送时懒构建
    if (!(opts && opts.shard)) recordHistory(sessionId, wantTitle, dir)   // 分片/索引棒是内部工人,不进历史(对用户只是一条工作流)
    return { sessionId, project: dir ? path.basename(dir) : '未选目录', dir, model: model0, reattached: false, running: false }
    } catch (err) {
      // serve 拉起/建会话失败:分片隐藏卡死在这 = 主控永远等不到这片(静默整链卡死,实测)。
      // 这类失败不走 card-send,wfTurnError 三路兜底都到不了 —— 在这里补一刀,让分片按 interrupted 收官上报
      try { if (S.wfTurnError && S.wfCardByWc && S.wfCardByWc.has(e.sender.id)) S.wfTurnError(e.sender.id) } catch {}
      throw err
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
      S.dropPendingQuestion(old)   // 旧会话已中止:它名下没答的提问逐个 reject,别让 question 工具空等挂死(R6)
    }
    S.sessionByWc.delete(e.sender.id)
    if (opts && opts.dir) S.cardDir.set(e.sender.id, String(opts.dir))
    const dir = (opts && opts.dir) || S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)   // requireDirMatch 默认开:cwd 不符不共享,自起独立 serve
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话', dir)
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
    const ctx = loadMemory() + loadProjectContext(dir) + KNOWLEDGE_SLOT + carry; S.firstMsgCtx.set(sessionId, ctx)
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
    S.sentPrompt.set(sessionId, msg); S.streamBuf.delete(sessionId)   // 存【实际发出的全文】(含注入前缀):回显过滤比对的是 serve 收到的东西 —— 只存原文的话,带前缀的回显漏网,整坨背景提示词会打进对话流
    touchHistory(sessionId)
    let model = si.model || S.settings.modelMain || S.settings.model || null   // 双模型(M1):会话默认走主模型(缺省回全局 model)
    const fileArr = Array.isArray(files) ? files : []
    const hasImage = fileArr.some((f) => f && /^image\//.test(f.mime || ''))
    if (hasImage) {
      // 带图消息路由(M1 双模型):优先用显式配置的读图模型;没配回退"清单里找一个 image 模型"(老行为)
      const mv = S.settings.modelVision
      if (mv && mv.modelID) {
        model = { providerID: mv.providerID, modelID: mv.modelID, name: mv.name }
        if (!si.wc.isDestroyed()) si.wc.send('card-note', { text: '检测到图片，本条用读图模型「' + (mv.name || mv.modelID) + '」识别', tone: 'muted' })
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
        if (p.kind === 'tool') onText({ sessionId, role: 'assistant', kind: 'tool', text: p.text, partID: p.partID, status: p.status, toolInput: p.input, toolOutput: p.output, toolTitle: p.title, toolError: p.error })
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
    const pollChildren = async () => {
      const si2 = S.sessionInfo.get(sessionId); if (!si2 || !si2.wc || si2.wc.isDestroyed()) return
      const now = Date.now()
      if (now - childLastList > 6000) {
        childLastList = now
        const all = await oc.listSessions(si2.serve)
        for (const c of all || []) {
          if (!c || !c.id || c.parentID !== sessionId) continue
          const t = String(c.title || '')
          if (!childSeen.has(c.id) || (t && childSeen.get(c.id) !== t)) childSeen.set(c.id, t || '子agent')
        }
      }
      for (const [cid, ctitle] of childSeen) {
        let list = null
        try { list = await oc.getRawMessages(si2.serve, cid) } catch {}
        if (!list) continue
        for (const p of mapRawTurnParts(list)) {
          if (p.kind === 'tool') onText({ sessionId, role: 'assistant', kind: 'tool', text: p.text, partID: p.partID, status: p.status, toolInput: p.input, toolOutput: p.output, toolTitle: p.title, toolError: p.error, subagent: true, agentId: cid, agentName: ctitle })
          else onText({ sessionId, role: 'assistant', kind: p.kind, text: p.text, partID: p.partID, subagent: true, agentId: cid, agentName: ctitle })
        }
      }
    }
    const startChildPoll = () => { if (childPoll) return; childPoll = setInterval(() => { pollChildren().catch(() => {}) }, 1500) }
    const stopChildPoll = () => { if (childPoll) { clearInterval(childPoll); childPoll = null } }
    const onRaw = (list) => {   // oc 新版 hook:原始消息列表直达 → 同构映射喂 onText;首火后轮询降 5s
      try {
        if (!hookLive) { hookLive = true; if (poll) { stopPoll(); startPoll() } }
        feedParts(mapRawTurnParts(list))
      } catch {}
    }
    startPoll()
    startChildPoll()   // 子 Agent 实况轮询(/event 不推子会话 message 事件,侧边栏靠它填)
    try {
      // P3.4:knobs.promptAsync truthy → 走 prompt_async 发送通道(POST 立即返回不挂起等回合;fork 无端点 404 自动回落,见 opencode.js)
      const sendOpts = { onRawMessages: onRaw }
      try { if (S.settings && S.settings.knobs && S.settings.knobs.promptAsync) sendOpts.promptAsync = true } catch {}
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
              if (!si.wc.isDestroyed()) si.wc.send('card-inject', { text: '(系统提醒:输出 token 到上限被截断 —— 不要道歉、不要复述前文,直接从被切断的那一点接着写;把剩余工作拆得更小。)', disp: '输出被截断,自动续写(' + si.maxTokResumeN + '/3)' })
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
      if (/->\s*429\b|rate\s*limit|too many requests/i.test(m))
        throw new Error('内网模型限流（HTTP 429），等 30 秒再重试。')
      if (/->\s*401\b|unauthorized/i.test(m))
        throw new Error('模型网关鉴权过期（HTTP 401），请联系管理员。')
      if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed?\s*out|->\s*(408|504)\b/i.test(m))
        throw new Error('模型响应超时，可重试。')
      if (/ECONNREFUSED|ECONNRESET|socket hang up|ENOTFOUND|EPIPE|fetch failed/i.test(m))
        throw new Error('引擎连接中断（serve 可能已退出）。关掉这张卡重开即可（已自动准备重启 serve）。')
      throw err
    } finally {
      stopPoll(); stopChildPoll(); turnBusy.delete(sessionId)
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
      // 回合收尾再扫一遍子会话:最后一个 tick 之后落盘的子 Agent 产出/工具终态也补进侧边栏(不留差一口气的终态)
      try { await pollChildren() } catch {}
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

  ipcMain.on('card-abort', (e) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (si) oc.abort(si.serve, sessionId)
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
  ipcMain.handle('question-reply', async (_e, { requestId, answers }) => {
    const q = S.pendingQuestion.get(requestId); S.pendingQuestion.delete(requestId)
    if (!q) return { ok: false, err: '这个提问已失效(可能已被应答或回合中断)' }
    try {
      await oc.replyQuestion(q.serve, q.sessionId, requestId, Array.isArray(answers) ? answers : [], q.v2)
      try { S.audit && S.audit('question', '回答提问', { requestId, answers: JSON.stringify(answers || []).slice(0, 300), sessionId: q.sessionId }) } catch {}
      return { ok: true }
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })
  ipcMain.handle('question-reject', async (_e, { requestId }) => {
    const q = S.pendingQuestion.get(requestId); S.pendingQuestion.delete(requestId)
    if (!q) return { ok: false, err: '这个提问已失效(可能已被应答或回合中断)' }
    try { await oc.rejectQuestion(q.serve, q.sessionId, requestId, q.v2) } catch {}
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
