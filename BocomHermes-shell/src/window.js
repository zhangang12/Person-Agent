'use strict'
const USE_ACRYLIC = false
const { clipboard, session, Notification, desktopCapturer, webContents } = require('electron')
const email = require('./email')
const attachments = require('./attachments')
const mailCache = require('./mail-cache')
const emailSummarySeen = require('./email-summary-seen')
const initOutbox = require('./outbox')
const db = require('./db')
const { extractMeeting } = require('./meeting-extract')
const todoExtractLLM = require('./todo-extract-llm')   // 邮件待办语义提取(攒批 LLM 复核,规则法太宽被弃用)
const { RECORDER_JS, selExpr, findElExpr, anchorExpr, frameFor, safeOrigin, applyParams, applyBaseUrl, JS_LIKE, diffReport, coverageHits, clusterErrs, compactEvents, markHumanGates, upgradeToSkill, skillMd, composePostPipelineGoal, applyRefinePatch, rowToParamValues, relocateSelectors, takeoverDigest, redactRec } = require('./recorder-core')
const initRecorder = require('./recorder')
const initBrowserAgent = require('./browser-agent')   // Agent 自主浏览器会话(端到端验证:自己开、围栏内操作、断言取证、出报告)
const { cdpConsoleLevel, fmtRO, fmtException, resolveFrame } = require('./cdp-format')
const initMail = require('./mail')
const initMcpConfig = require('./mcp-config')
const initLspConfig = require('./lsp-config')   // 内网无外网:随包自带三个 node 系 LSP server,首启自动注册进 opencode 配置
const initPluginInstall = require('./plugin-install')   // read-spill 插件(read/grep 大输出外溢落盘)拷进 opencode 全局插件目录
const initIntranetOptimize = require('./intranet-optimize')   // 内网×弱模型静态优化包:tools 瘦身/permission.bash 通配/agent 收口,写配置+PATCH 热应用
const initAgentMd = require('./agent-md')   // AGENTS.md 生成器:扫清单文件起草"怎么构建/测试/验证",serve 原生注入每个会话
const initBrowser = require('./browser')
const knowledge = require('./knowledge')   // 项目知识库治理 IPC 用(纯逻辑,落盘/审计在本文件)
const writescope = require('./writescope')   // 分片写归属(编码模式):goal 解析 + 范围匹配,session.js 的权限硬闸用
const standards = require('./standards')     // 内置编码规范库(后端/前端/UI·UX/SQL/架构):编码模式全量注入
const makeCardCleanup = require('./card-cleanup')   // 卡关闭清理链工厂(波2 抽出/波3 独立成可测模块)
const { makeOrch } = require('./orch')                // 编排状态机装配层(编排的唯一实现)
const { makeDecider } = require('./orch/decide')      // 决策器:模型在整套编排里唯一出现的地方(plan / replan 两点,默认不限时)

module.exports = function initWindow(S, { ipcMain, app, BrowserWindow, WebContentsView, screen, dialog, Tray, Menu, nativeImage, shell, path, fs, oc, log }) {
  // 纯文件 IO 函数搬进 recorder-core 的 initStore 工厂,这里注入依赖后解构使用
  const { recDir, readRec, saveRec, writeLastRun, skillList, loadAssertions, loadScans, loadReview, gitChangedFiles } = require('./recorder-core').initStore({ app, fs, path, execSync: require('child_process').execSync })
  // 额外窗口引用
  S.mainWin = null   // 桌面主窗口(shell.html)单例,createMainWindow 管理
  S.embedWc = new Set()   // 主窗口内嵌会话卡的 guest webContents id(波2):发卡收口进 shell 的会话都登记在这
  S.pinnedWc = new Set()   // 钉出窗的 wcId(波3):从主窗口钉出的独立迷你卡;钉出卡 closed 分流(detach+收回 vs 正常清理)的判据
  S.cardWcById = new Map()   // 卡 id → wcId(仅真窗口路径登记,关卡清理):波3 钉出 IPC 按卡 id 反查 wcId(回包/钉出窗登记)
  S.browser = { win: null, tabs: [], activeId: null, consoleH: 0, seq: 0, mode: 'standalone', leftW: 0, cardView: null, cardWcId: null, _dragging: false }
  // ── 设置 ────────────────────────────────────────────────────────────────────
  // 阈值旋钮(治理波次):弱模型补偿参数全部进 settings.json 的 knobs 节,可拧松/随模型升级逐档退掉;
  // 此处给默认值并深合并(浅合并会被 settings.json 里缺字段的 knobs 整棵覆盖默认值)。
  const DEFAULT_KNOBS = {
    approvalTimeoutMin: 0,        // 批准闸超时分钟,0=永不
    watchdogRounds: 3,            // 看门狗判定轮数
    watchdogOverlap: 0.7,         // 看门狗绕圈重合度
    watchdogEscalateRounds: 2,    // 看门狗升级轮数
    ctxHandoffPct: 0.55,          // 工作流卡主动交棒水位:≤55% 就交接给下一棒主 Agent(全新 128k),永不触发被动压缩(曾经的 ctxCompactPct 是没人读的死旋钮,已删,勿复活)
    chatHandoffPct: 0.9,          // 普通对话卡高水位自动交棒:≥90% 自动压缩续聊(摘要留顶部);0=关闭,回 90% 提醒纯手动
    autoCompactMax: 20,           // 交棒次数上限:文档接力下棒数不该卡死(每棒都在推 todo);仅兜底病态循环
    todoNudgeRounds: 3,           // todo 停滞提醒轮数
    knowledgeChurnMax: 300,       // 知识 C4 churn 阈值(行)
    wfConcurrency: 8,             // 工作流并发上限(超限排队)。撞 429 会自动对半降档、每 2 分钟恢复一档(见 S.noteRateLimit)
    orchMaxNodes: 40,             // ★编排的【节点预算】:一次编排总共能造几个节点。与 wfConcurrency 是两个不同的旋钮
                                  //   (并发=同时跑几张卡;这个=总量)。原来只有 run.js 一处硬编码 24、没有任何入口能改,
                                  //   而真实编排(6~8 片 work × 每片几条发现各派核实 + 汇总 + 验收 + 归档)轻松过 30 —— 必然撞。
    taskPromptMax: 20000,         // 委派指令(task/delegate_task)硬上限(字符,128k 口径):只拦"贴原文"级病态指令,精确拦停该子会话
    ctxLimitMax: 192000,          // 水位上限硬顶(MiniMax M2.5 实测 192k):生效上限=min(serve 上报 limit.context, 此值) —— serve 报 192k 就用满 192k,报更大(公网 256k/1M)按此收口,防阈值线算到真实上限之外
    promptAsync: 0,               // prompt_async 发送通道（1=开）：POST 不再挂起等回合，R4 类在飞断开问题免疫；内网 fork 无该端点自动回落
    readWarnMax: 100000,          // 读字节提醒线(按文件去重累计,字符):正常编码 3-5 个中等文件不报警;老内容已被 context-guard 清理,这里只拦"还在读"的节奏
    orchDecideTimeoutSec: 0,      // 编排决策(plan/replan)模型响应限时(秒):0=不限时(内网慢模型默认,多慢都等完);>0 时 plan 用该值、replan 取其半保底 60s
    orchSilentSec: 45,            // 编排节点轮末静默判落定窗口(秒):到点先探活(卡在启动/有回合在飞/卡片忙/内容在动则续命一轮,见 orch/index.js doArm),真静才落定;内网慢端点轮间空隙大可放宽到 120+
  }
  const mergeKnobs = (k) => ({ ...DEFAULT_KNOBS, ...((k && typeof k === 'object') ? k : {}) })
  // 弱模型拖尾收口(性能审查⑤):context-guard 插件的 chat.params 钳制读 serve 进程环境——
  // spawn 的 serve 继承本进程 env,这里给默认值(已被显式设置的不覆盖;8192≈一次长答,防 JSON 截断与回合拖沓)
  if (!process.env.BOCOMHERMES_MAX_OUTPUT_TOKENS) process.env.BOCOMHERMES_MAX_OUTPUT_TOKENS = '8192'
  function loadSettings() {
    // 浅色单主题:无论 settings.json 里存的是什么,theme 恒为 'light'(主题机制已锁定)
    try {
      const p = JSON.parse(fs.readFileSync(S.settingsFile, 'utf8'))
      return { ...S.settings, ...p, theme: 'light', knobs: mergeKnobs(p && p.knobs) }
    } catch { return { ...S.settings, theme: 'light', knobs: mergeKnobs(S.settings && S.settings.knobs) } }
  }
  function saveSettings() { try { fs.writeFileSync(S.settingsFile, JSON.stringify(S.settings)) } catch {} }
  // ── 邮件子系统 ──────────────────────────────────────────────────────────────
  // 收发/发件箱安全闸门/IMAP IDLE/本地中继/mail-cache/待办-邮件闭环/DB 只读中继,整块搬进 ./mail 的
  // initMail(ctx) 工厂。ctx 注入外部模块 + 后定义但已提升的 function;回传 3 个外部调用点用到的函数。
  const mail = initMail({ S, app, path, fs, shell, ipcMain, log, oc, Notification, email, attachments, mailCache, emailSummarySeen, db, initOutbox, openOutbox, createMailCenter, openMailView, spawnCard, spawnWorkflow, startOrchRun, maybeSuggestMeeting, skillList, skillRun, skillRunBatch, skillPageRead, skillPageAct, skillTakeoverDone })

  const projName = () => S.settings.projectDir ? path.basename(S.settings.projectDir) : '未选目录'

  function applyProject(dir) {
    S.settings.projectDir = dir
    S.settings.recentDirs = [dir, ...(S.settings.recentDirs || []).filter((d) => d !== dir)].slice(0, 6)
    saveSettings()
    oc.ensureServe(dir, S.handlers, log).catch((e) => log('prewarm failed: ' + e.message))
    try { agentMd.autoEnsure(dir) } catch (e) { log('agent-md auto-ensure err: ' + e.message) }   // 自动把"怎么构建/测试/验证"写进项目 AGENTS.md(人工文件不碰)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('project-changed', projName())
  }

  // ── 历史 ────────────────────────────────────────────────────────────────────
  function saveHistory() { try { fs.writeFileSync(S.historyFile, JSON.stringify(S.history.slice(0, 50))) } catch {} }
  function loadHistory() { try { const a = JSON.parse(fs.readFileSync(S.historyFile, 'utf8')); if (Array.isArray(a)) S.history = a } catch {} }
  // 存档头里有 `- id:… · 会话:<sid> · run:<runId> · 轮次:…` —— 老历史条目没记 runId 时靠它兜底。
  // 只读文件头 2KB(与 wf-list 同口径),不为一次查找把整份存档读进来。
  function runIdBySid(sid) {
    const want = String(sid || ''); if (!want) return ''
    try {
      const dirW = path.join(app.getPath('userData'), 'workflows')
      const files = fs.readdirSync(dirW).filter((f) => f.endsWith('.md'))
        .map((f) => { const p = path.join(dirW, f); let m = 0; try { m = fs.statSync(p).mtimeMs } catch {} ; return { p, m } })
        .sort((a, b) => b.m - a.m).slice(0, 60)
      for (const f of files) {
        let head = ''
        try { const fd = fs.openSync(f.p, 'r'); const buf = Buffer.alloc(2048); const n = fs.readSync(fd, buf, 0, 2048, 0); fs.closeSync(fd); head = buf.toString('utf8', 0, n) } catch { continue }
        if (((head.match(/· 会话:(\S+)/) || [])[1] || '') !== want) continue
        return ((head.match(/· run:(\S+)/) || [])[1] || '')
      }
    } catch {}
    return ''
  }

  function recordHistory(id, title, dir) {
    if (S.shardSids && S.shardSids.has(id)) return   // 分片会话硬闸:内部工人绝不进最近会话(调用点 shard 旗标之外的第二道防线,session.js trackWcSession 登记)
    const t = (title || '对话').replace(/\s+/g, ' ').trim().slice(0, 80)
    // ★编排面板卡的会话要记住它属于哪个 run(2026-08-11:用户点侧栏「会话」里的编排,开出来是空白
    //   "历史消息未能载入" —— 因为面板卡【有会话但永不发消息】,当普通对话开当然什么都没有)。
    //   sid → runId 这层映射原来【任何地方都没存】:注册表重启即空,run.json 里也没有会话 id。
    //   记在历史条目上是最省的:它本来就按 sid 存,重启也在。
    let runId = ''
    try { for (const r of (S.wfRegistry ? S.wfRegistry.values() : [])) if (r && r.sid === id && r.runId) { runId = String(r.runId); break } } catch {}
    const prev = S.history.find((h) => h.id === id)
    if (!runId && prev && prev.runId) runId = String(prev.runId)   // 已经记过就别丢(改名/刷新会重走这里)
    S.history = [{ id, title: t, dir: dir || '', project: dir ? path.basename(dir) : '未选目录', ts: Date.now(), created: Date.now(), ...(runId ? { runId } : {}) }, ...S.history.filter((h) => h.id !== id)].slice(0, 50)
    saveHistory()
  }
  // 历史单条删除(侧栏历史区行内 ✕):只摘索引,serve 侧会话不管(与 clearHistory 同语义,索引 orphan 不影响)
  ipcMain.handle('history-delete', (_e, sid) => {
    const id = String(sid == null ? '' : sid)
    if (!id) return { ok: false }
    const before = S.history.length
    S.history = S.history.filter((h) => h.id !== id)
    if (S.history.length !== before) { saveHistory(); try { S.audit && S.audit('history', '删除历史会话索引', { id: id.slice(0, 40) }) } catch {} }
    return { ok: true }
  })
  // 历史改名(首轮自动命名 / 标题栏内联改名):按 sid 更新索引标题
  ipcMain.handle('history-rename', (_e, arg) => {
    const { sid, title } = arg || {}
    const id = String(sid == null ? '' : sid)
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!id || !t) return { ok: false }
    const h = S.history.find((x) => x.id === id)
    if (!h) return { ok: false, err: 'no such history entry' }
    h.title = t; h.ts = Date.now()
    saveHistory()
    return { ok: true }
  })
  function touchHistory(id) { const h = S.history.find((x) => x.id === id); if (h) { h.ts = Date.now(); saveHistory() } }
  // 会话换 id(引擎侧重建会话等场景):history.json 里把 oldId 条目原地换成 newId,created/title/model 等字段保留
  function replaceHistoryId(oldId, newId) {
    const o = String(oldId == null ? '' : oldId), n = String(newId == null ? '' : newId)
    if (!o || !n || o === n) return false
    const h = S.history.find((x) => x.id === o)
    if (!h) return false
    S.history = S.history.filter((x) => x.id !== n)   // newId 已有条目先摘,防重复
    h.id = n; h.ts = Date.now()
    saveHistory()
    return true
  }

  S.settings = loadSettings()
  loadHistory()

  // ── 窗口工厂 ────────────────────────────────────────────────────────────────
  function baseOpts(extra) {
    const opts = {
      frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, roundedCorners: true,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
      ...extra,
    }
    if (USE_ACRYLIC) { opts.transparent = false; opts.backgroundColor = '#00000000'; opts.backgroundMaterial = 'acrylic' }
    else { opts.transparent = true }
    return opts
  }

  function spawnCard(title, sid, msg, disp, opts) {
    const id = ++S.cardSeq
    // ── 主窗口收口(波2):主窗口活着且未显式要真窗口 → 不开悬浮卡窗,参数转发 shell(shell-spawn)
    //    在主窗口对话视图以 webview 内嵌开卡。opts.window===true 保留真窗口路径(波3 钉出用);
    //    opts.hidden(多层派发分片/索引棒)是无人值守工人不开窗,必须留在真窗口路径(webContents 得独立存活)。
    if (S.mainWin && !S.mainWin.isDestroyed() && !(opts && opts.window) && !(opts && opts.hidden)) {
      // 会话已钉出到独立窗(波3):收口路径不再内嵌重开 —— 同 sid 双绑会把钉出窗打成僵尸(sessionInfo 只认最新绑定),聚焦钉出窗即回
      if (sid && S.pinnedWc && S.pinnedWc.size) {
        for (const pid of S.pinnedWc) {
          if (S.sessionByWc.get(pid) !== sid) continue
          const w0 = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === pid)
          if (w0) { try { if (w0.isMinimized()) w0.restore(); w0.show(); w0.focus() } catch {} ; return id }
        }
      }
      const wfKindE = opts && opts.orch ? 'orch' : opts && opts.wf ? 'workflow' : (opts && opts.pipeline) ? 'pipeline' : ''
      // 工作流注册表同步登记(spawnWorkflow 紧接着按 id 查):wcId 此刻未知先挂 null,
      // webview guest 就绪后由 shell 经 session-bind IPC 回报补齐(顺带把 wfCardByWc 建上)
      if (wfKindE) {
        S.wfRegistry = S.wfRegistry || new Map(); S.wfCardByWc = S.wfCardByWc || new Map()
        const reg = { id: String(id), wcId: null, kind: wfKindE, goal: disp || title || '', status: 'running', round: 0, rounds: 0, at: Date.now(), archive: null, final: '', todos: null, files: [], actions: [], dir: S.settings.projectDir || '', elapsedMs: 0 }
        if (wfKindE === 'orch' && !(opts && opts.run)) reg.planApproved = false   // 规划闸壳层状态位;编排面板卡不吃这条 —— 它的批准是 run.phase
        if (opts && opts.run) reg.runId = String(opts.run)   // 新引擎面板卡
        if (opts && opts.model) reg.model = opts.model   // 发起时选定的模型(编排页):随注册表走,replayModel/session-bind 取;分片继承也读它
        S.wfRegistry.set(reg.id, reg)
        // 50 条 FIFO 逐出跳过在跑项 —— 与真窗口路径(:235)同款守卫。原来这条内嵌路径无条件删最老,
        // 而【编排面板卡恰好只走内嵌路径】(不传 hidden/window):累计开满 50 张 wf/orch/pipeline 卡后,
        // 正在跑的主控会被自己的分片挤掉 → 分片收官时唤醒目标查无 → 整条链静默停摆(:234 注释记的正是这个后果)
        if (S.wfRegistry.size > 50) { const victim = [...S.wfRegistry.entries()].find(([, v]) => !v || v.status !== 'running'); if (victim) S.wfRegistry.delete(victim[0]) }
      }
      // 与真窗口路径的 query 字段一一对应(gox 系"从球长出"锚点对内嵌无意义,不带)
      const p = { id: String(id), title: title || '未命名任务' }
      if (sid) p.sid = sid
      if (msg) p.msg = msg
      if (disp) p.disp = disp
      if (opts && opts.orch) p.orch = '1'
      if (opts && opts.run) p.run = String(opts.run)
      if (wfKindE === 'workflow' || wfKindE === 'orch') p.wf = '1'
      const mw = S.mainWin
      try { if (mw.isMinimized()) mw.restore(); mw.show(); mw.focus() } catch {}
      const send = () => { try { if (!mw.isDestroyed()) mw.webContents.send('shell-spawn', p) } catch (e) { log('shell-spawn send err: ' + e.message) } }
      if (mw.webContents.isLoading()) mw.webContents.once('did-finish-load', send)   // 同 main.js openMainView:加载中等就绪再发,防丢消息
      else send()
      return id   // 返回值契约不变(卡 id):cardFiles 暂存键 / wfRegistry 查询 / spawn-card、start-conversation 回包都靠它
    }
    const col = (id - 1) % 4, row = Math.floor((id - 1) / 4) % 4
    let wx = 160 + col * 56, wy = 90 + row * 50 + col * 18
    // opts.window(波3 钉出)落点:拖出传光标屏幕坐标(卡横心对齐光标、稍上抬,避免遮住落点);缺省居中主屏。
    // 钳进目标显示器工作区(getDisplayNearestPoint:拖到副屏就钳副屏,取不到回退主屏)
    if (opts && opts.window) {
      const hasXY = Number.isFinite(+opts.x) && Number.isFinite(+opts.y)
      let wa = null
      try { if (hasXY && screen.getDisplayNearestPoint) wa = (screen.getDisplayNearestPoint({ x: +opts.x, y: +opts.y }) || {}).workArea } catch {}
      if (!wa) { const p = screen.getPrimaryDisplay(); wa = p.workArea || { x: 0, y: 0, width: p.workAreaSize.width, height: p.workAreaSize.height } }
      wx = hasXY ? Math.round(+opts.x - 340) : Math.round(wa.x + (wa.width - 680) / 2)
      wy = hasXY ? Math.round(+opts.y - 16) : Math.round(wa.y + (wa.height - 860) / 2)
      wx = Math.max(wa.x, Math.min(wa.x + Math.max(0, wa.width - 680), wx))
      wy = Math.max(wa.y, Math.min(wa.y + Math.max(0, wa.height - 860), wy))
    }
    // opts.hidden:隐藏卡(多层派发分片/索引棒)——不开窗,会话回流到主控卡主区域看;权限自动放行,进度聚合到主控卡
    // opts.inactive:不抢焦卡 —— showInactive 亮相,可见但不夺焦
    const hidden = !!(opts && opts.hidden)
    const inactive = !!(opts && opts.inactive)
    const win = new BrowserWindow(baseOpts({
      width: 680, height: 860, minWidth: 480, minHeight: 460, resizable: true,
      alwaysOnTop: false, skipTaskbar: hidden ? true : false, x: wx, y: wy, show: !hidden && !inactive,
    }))
    const wcId = win.webContents.id
    S.cardWcById = S.cardWcById || new Map(); S.cardWcById.set(String(id), wcId)   // 波3:钉出 IPC 按卡 id 反查 wcId(回包/钉出窗登记);关卡清理反查摘除
    const query = { title: title || '未命名任务', id: String(id) }
    if (sid) query.sid = sid
    if (msg) query.msg = msg
    if (disp) query.disp = disp
    // ★验证片身份要下到渲染端:绕圈看门狗按"又在读同一批文件"判死,而【核实/验收就是以重读为职责】——
    // 它必须能豁免自己。真机 2026-08-09:验收片读完汇总文档,再回到文档引用的出处逐条核对
    // (brief 原文:"回到它给的出处…实际核一遍"),看门狗数够次数就把它当绕圈掐了,判决因此永远发不出来。
    // 走 query 而不是另开 IPC:与 shard=1 同一条既有通路,渲染端一处读取,不新增状态同步面。
    if (opts && opts.verify) query.verify = '1'
    if (opts && opts.shard) {
      query.shard = '1'   // 分片卡(多层派发):渲染端据此自动过规划闸(拆分方案用户在主控卡已批,分片不再二次等人)
      S.shardWc = S.shardWc || new Set(); S.shardWc.add(wcId)   // 无人值守权限自动放行(session.js onPermission);关卡清理
      // 用户弹窗查看(shard-pop)后点 X = 收回后台隐藏,不销毁 —— 分片是无人值守工人,误杀=无人值守链断一截;
      // 壳层销毁(主控全齐/主控关卡级联)走 S.shardForceClose 白名单放行;应用退出走 app.isQuitting 放行
      if (hidden) {
        win.on('close', (ev) => {
          if (app.isQuitting || (S.shardForceClose && S.shardForceClose.has(wcId))) return
          ev.preventDefault(); win.hide()
        })
      }
    }
    if (opts && opts.orch) query.orch = '1'   // 主控卡:渲染端据此空答自动重试(长跑无人值守,网关静默不能卡死整条链)
    if (opts && opts.run) query.run = String(opts.run)   // 新引擎:渲染端据此走【编排面板】形态而不是对话流
    // 工作流卡/任务编排卡/主控卡:登记进成果注册表(id=卡id,与 orch-mcp run_workflow 返回给 Agent 的一致),每轮终答由
    // S.wfTurnDone 更新+存档 —— 升格方/用户才取得回成果(以前只有 legacy 引擎写注册表,新路径断链)。
    // kind=workflow 走 wf=1(规划闸/自动批准/主动交棒);kind=pipeline 只登记(编排按描述顺序执行,不要规划闸);
    // kind=orch 多层派发主控卡:同样走 wf=1(规划闸批准拆分方案),但不占并发位(等待期闲置)。
    const wfKind = opts && opts.orch ? 'orch' : opts && opts.wf ? 'workflow' : (opts && opts.pipeline) ? 'pipeline' : ''
    if (wfKind) {
      if (opts.wf || opts.orch) query.wf = '1'
      S.wfRegistry = S.wfRegistry || new Map(); S.wfCardByWc = S.wfCardByWc || new Map()
      const reg = { id: String(id), wcId, kind: wfKind, goal: disp || title || '', status: 'running', round: 0, rounds: 0, at: Date.now(), archive: null, final: '', todos: null, files: [], actions: [], dir: S.settings.projectDir || '', elapsedMs: 0 }
      if (wfKind === 'orch' && !(opts && opts.run)) reg.planApproved = false   // 同上;编排面板卡不吃这条
      if (opts && opts.run) reg.runId = String(opts.run)   // 新引擎面板卡(真窗口路径)
      if (opts && opts.model) reg.model = opts.model   // 发起时选定的模型(编排页):随注册表走,replayModel 取;分片继承也读它
      S.wfRegistry.set(reg.id, reg); S.wfCardByWc.set(wcId, reg)
      // 50 条 FIFO 逐出跳过在跑项:把 running 主控/分片逐出 = 唤醒目标丢失 + 全收官分母算错(宁可暂停逐出)
      if (S.wfRegistry.size > 50) { const victim = [...S.wfRegistry.entries()].find(([, v]) => !v || v.status !== 'running'); if (victim) S.wfRegistry.delete(victim[0]) }
    }
    // cardImpl 双轨(P2a/P2b):默认 Vue 版(ui/dist/chat.html,wf/orch/shard 已于 P2b-3 迁移);
    // settings.json 置 "cardImpl":"legacy" 回退旧页;构建产物缺失(没跑过 ui:build)也自动回退,不留死路。
    const vueChat = path.join(__dirname, '..', 'ui', 'dist', 'chat.html')
    const useVueChat = ((S.settings && S.settings.cardImpl) || 'vue') !== 'legacy' && fs.existsSync(vueChat)
    win.loadFile(useVueChat ? vueChat : path.join(__dirname, '..', 'ui', 'card.html'), { query })
    if (inactive) {   // 不抢焦:加载完 showInactive 亮相(可见但不夺焦点、不闪屏)
      win.webContents.once('did-finish-load', () => { try { if (!win.isDestroyed()) win.showInactive() } catch {} })
    }
    // opts.flash:加载完后闪一下任务栏 + 短暂置顶 + 抢焦点 → 用户一眼能找到新弹的卡
    if (opts && opts.flash) {
      win.webContents.once('did-finish-load', () => {
        try {
          win.show(); win.focus(); win.moveTop()
          win.setAlwaysOnTop(true)
          win.flashFrame(true)
          setTimeout(() => { try { if (!win.isDestroyed()) { win.setAlwaysOnTop(false); win.flashFrame(false) } } catch {} }, 1500)
        } catch {}
      })
    }
    // 清理链抽成公共函数(波2):独立卡/内嵌会话/主窗口关闭同走一条。钉出窗(波3)在此分流:
    // 主窗口活着 → 收回(detach 降级清理,会话不 abort + 通知 shell 按 sid 重建内嵌 webview);
    // 主窗口已关/非钉出窗 → 正常清理链(abort 全链)。pinnedWc 命中即删(一次性,幂等)。
    win.on('closed', () => {
      const wasPinned = !!(S.pinnedWc && S.pinnedWc.delete(wcId))
      if (wasPinned && S.mainWin && !S.mainWin.isDestroyed()) {
        const sid0 = S.sessionByWc.get(wcId)   // detach 前先取 sid(清完就没了)
        cleanupCardContext(S, wcId, win, { detach: true })
        if (sid0) {
          const mw = S.mainWin
          try { if (mw.isMinimized()) mw.restore(); mw.show(); mw.focus() } catch {}
          const send = () => { try { if (!mw.isDestroyed()) mw.webContents.send('session-reattached', { sid: sid0 }) } catch (e) { log('session-reattached send err: ' + e.message) } }
          if (mw.webContents.isLoading()) mw.webContents.once('did-finish-load', send)   // 同 shell-spawn:加载中等就绪再发,防丢消息
          else send()
        }
        return
      }
      cleanupCardContext(S, wcId, win)
    })
    return id
  }

  // ── 卡关闭清理链:独立成 ./card-cleanup(波2 从 closed 内联体抽出;波3 模块化,探针可直测)──────
  // 语义对照与 browser.js:644-664 教训见模块头注释;依赖全部注入,shardSettleTimers 惰性取(装配期尚在 TDZ)。
  // 工人卡被关 → 通知引擎按磁盘产出判收官(card-cleanup 自己零改:它只知道"调一下这个回调")
  const shardSettledRouted = (reg) => {
    if (reg && reg.runId && S.orch) { try { S.orch.onWorkerCardGone(reg) } catch (e) { log('[orch] cardGone 路由失败:' + e.message) } }
  }
  const cleanupCardContext = makeCardCleanup({ S, oc, log, BrowserWindow, getShardSettleTimers: () => shardSettleTimers, wfDequeue, forgetBusy, onNodeCardGone: shardSettledRouted, pushShardProgress,
    // 面板卡被关 = 整个 run 取消(与今天"关主控卡级联杀分片"的语义一致;设计里明确放弃"run 活过面板卡")
    onRunCardGone: (reg) => { try { if (S.orch && reg && reg.runId) S.orch.onPanelCardGone(reg.id) } catch (e) { log('[orch] panelGone 路由失败:' + e.message) } } })
  S.cleanupCardContext = (wcId, opts) => cleanupCardContext(S, wcId, null, opts)   // 挂 S:零依赖探针(scripts/cleanup-detach-test.mjs)与后续波次复用同一入口,别复刻

  // ── 编排引擎装配 ──────────────────────────────────────────────────────────
  // 装配失败不许影响启动:startOrchRun 会显式报错,别的功能(单工作流/pipeline/邮件/技能)照常。
  try {
    const realDecide = makeDecider({ oc, S, log, timeoutOf: (p) => {
      // 决策限时旋钮:knobs.orchDecideTimeoutSec(秒,>0 才限时,replan 取其半保底 60s);缺省/0 = 不限时(内网慢模型多慢都等完,面板上可中止整个 run)
      const sec = +(S.settings.knobs && S.settings.knobs.orchDecideTimeoutSec) || 0
      if (sec > 0) return p === 'plan' ? sec * 1000 : Math.max(60000, Math.floor(sec / 2) * 1000)
      return 0
    } })
    S.orch = makeOrch({
      S, oc, log, app, spawnCard, spawnWorkflow, wcById, BrowserWindow, Notification,
      // 决策器留一个注入缝:S.orchDecide 存在就用它。
      // 这不是"为测试改产品代码"—— replay 里必须能确定性地喂决策结果(真决策要起会话、要等模型),
      // 否则整条编排链只能靠真跑验,那就等于没有回归。生产路径 S.orchDecide 永远是空。
      decide: (point, ctx) => (typeof S.orchDecide === 'function' ? S.orchDecide : realDecide)(point, ctx),
    })
    S.orch.restore()   // 重启恢复:非终态存档读回内存并置 suspended(不自动跑 —— 内网重启常伴随 serve 变更)
  } catch (e) { S.orch = null; log('[orch] 引擎装配失败(自动回退旧主控):' + (e && e.stack || e)) }

  // wcId → webContents(顶层窗或 webview guest 皆可):guest 不在 BrowserWindow.getAllWindows() 里,
  // 主窗口化后工作流/主控卡是内嵌 guest,凡是按 wcId 找窗投递(card-inject / shard-progress)必须走这里
  function wcById(wcId) {
    if (wcId == null) return null
    try { const wc = webContents.fromId(wcId); return (wc && !wc.isDestroyed()) ? wc : null } catch { return null }
  }

  // 「动态工作流」= Claude Code 式:单个【主 Agent】在连续上下文里自己【看清形状 → 规划 → 执行 → 综合】,
  // 用 task 工具并行派子 Agent 分担重活(深读/评审/交叉验证),自己综合成【与任务匹配的产出】(代码/诊断/结论/文档)。
  // 通用化:不再过拟合"探索→写手册"一种形状;旧"独立规划器分轮 + worker 摘要 + reduce 冷拼"引擎(orchestrator.js/src/orch.js/ui/workflow.html)已退役删除。
  // 128k 纪律仍是关键:主 Agent 只装"结论/索引"不装"原料",深读交给有各自 128k 的子 Agent。
  // 实现成一张卡 → 白捡卡片的【上下文用量 chip + 压缩续聊】做 128k 安全网 + 【子 Agent 富容器 + todo 勾选清单】做过程可视化。
  // 跨仓:配了 backendDir 时锚文本放开"主仓可写 + 副仓只读"(与 session.js 项目背景锚同口径),脚本仓/后端仓可探查不可改。
  function workflowSystemPrompt(dir, backendDir) {
    return [
      '<动态工作流规程>',
      '你是一名资深工程师,要独立完成一个需要拆解的复杂目标。自己【看清形状 → 规划 → 执行 → 综合】,你是唯一主导者,不等外部给你分步骤。你手里有一件普通对话没有的利器:task 工具能【一次并行派多个子 Agent】,每个子 Agent 有它自己独立的 ' + ctxK() + ' 上下文,替你并行读大片代码 / 干重活 —— 用好它是这套流程的核心。',
      '',
      '1. 【先看清目标的形状,再定打法】产出随形状走,但【任何形状都必须有落盘交付物】(默认 = MD 文档,见第7条):',
      '   · 研究 / 答疑 → 有据可查的结论报告;· 实现 / 改造 → 可运行的代码改动 + 改动说明;· 排查 → 定位到根因的诊断报告 + 修复;· 探索成文 → 开发手册 / 业务文档。',
      '2. 【定计划并让它可见】非琐碎目标先用 todowrite 列出步骤清单,开工把当前步标 in_progress、做完立刻标 completed(一次只推进一步)—— 既是你自己的进度锚,也让用户看见你在干什么。琐碎目标可略。',
      '3. 【轻量勘察,绝不通读】自己只用 grep/glob + 读几个入口 / 清单摸清"分成哪几块、边界在哪"——单次 read 必须带 offset/limit(每次 ≤400 行),grep 先收窄路径与文件类型,确认"够定位"就停手。你的 ' + ctxK() + ' 很宝贵,【绝不】自己通读整个模块几十上百个文件 —— 那会撑爆你、让综合时变笨。',
      '   【编码/转换/迁移类目标的铁律 —— 源码不进主上下文】改造/转换/迁移/重写类目标(如 FLEX→React、框架迁移、批量重写):你【绝不】亲自通读源文件 —— 逐文件(或小批 ≤3 个)派子 Agent:它读原文 → 写出目标代码文件 → 只回【路径 + 一句差异/风险说明】。源码全文只许在叶子子 Agent 的 ' + ctxK() + ' 里出现一次(读完即转、转完即写、写完只回路径),你只做计划、验收产物与整合;单文件 >2000 行按组件/函数级再拆派。琐碎目标(单文件小改/改几行)反过来:【别派单】自己直接干完 —— 派单的固定开销比活本身还大。',
      '4. 【重活并行下放子 Agent】一块工作满足【彼此独立 + 需深读很多文件 + 能同时干】三条时,用 task 工具【一条消息里一次派多个子 Agent 并行跑】,别一个个串。子 Agent 指令按 ' + ctxK() + ' 口径执行硬纪律:',
      '   · 【指令只写四样:目标、文件路径清单(≤10 个)、边界(只干哪一块)、回报格式】塞原文超 2 万字壳层直接拦停 —— 不是限字数,是禁止把文档内容搬进指令(那是子 Agent 撑爆的第一死因)。',
      '   · 【Brief 质量三要素(CC 委派规程)】每条指令必须答满三个问题:①做什么(可验收的产出形态) ②为什么(这块在总目标里的位置) ③我已查明什么(你已排除的路径/相关文件结论,file:行号)——子 Agent 没看过你的对话,把它当【刚进门的聪明同事】brief;【严禁】"根据你的发现修一下"这类甩锅指令(never delegate understanding:理解是你的,它只拿到判断所需的全部上下文)。查找类任务给精确命令,调查类任务给具体问题。',
      '   · 委派工具首选内建 task;环境里有 oh-my-openagent 时可用 delegate_task(能按 category 选 deep/quick 等专家)—— 它必须显式传 load_skills,不需要技能就传 [],漏传会直接报错废掉这一轮。',
      '   · 【严禁把文件原文 / 大段代码贴进指令】—— 子 Agent 有自己独立的 ' + ctxK() + ',需要读的内容给它路径让它自己读;贴原文既浪费你的上下文,也是子 Agent 撑爆上下文、触发压缩卡死的第一死因。',
      '   · 【一个子 Agent 只干一块可独立交付的事】预计要读 >15 个文件、或单块产出 >1500 字 → 再拆,别塞成一个巨型任务。',
      '   · 结论与细节【一律落盘成文档】,回报只回【一句话 + 文件路径 + file:行号】:字数没有限制,内容住文档里,谁要用谁去读;【严禁】把大段原文 / 整块文档贴回你的上下文;',
      '   这样 N 个子 Agent 各读几百个文件,回到你这只有 N 行索引 ≈ 几百字,离 ' + ctxK() + ' 还远。',
      '5. 【别过度拆解】fan-out 有开销:简单目标、或你自己两三次读就能搞定的,【直接自己做】,别硬拆 N 块派 N 个子 Agent。满足第 4 条那三个"且"才派。',
      '6. 【自己综合成产出】子 Agent 结论回到你的连续上下文,由【你】整合成最终产出,形状随第 1 条(该给代码给可运行改动、该给诊断给根因 + 修复、该给结论给有据结论、该成文写文档)。综合是你的活,不另开 reducer —— 但中间结论多到你也装不下时,把综合也拆出去:派子 Agent 分块读落盘文档、各自归纳成文,你只吃索引(文档接力,可层层套)。',
      '7. 【默认必须落盘产出 MD】工作流【不允许】空手交付 —— 最终成果默认写成 docs/ 下的 MD 文档,回答里只给摘要 + 文件路径 + 关键结论:',
      '   · 报告 / 手册 / 清单类 → 默认 ' + (dir ? dir + '/docs/' : '<模块>/docs/') + '<主题>.md;手册类长文档拆分册到 docs/handbook/<块名>.md,最后你亲自写索引 README(定位 + 闭环 + 各块一段话链接 + 分歧点);',
      '   · 代码改动 → 改动的文件本身就是产出,另写改动说明(改了什么 / 为什么 / 怎么验证;规模小可并入 MD 报告);',
      '   · 只有一句话能答完的极简单目标才可免落盘 —— 免落盘要在回答里明说理由。首次写文件弹权限确认,用户批准即可。',
      '8. 【收尾必验证,不靠信念交差】改了代码就跑测试 / 构建 / 驱动一遍看真过(测试是交付的一部分:关键逻辑必须补/改测试,能跑就跑,没框架就为关键路径写最小验证脚本);下了关键结论就派子 Agent 交叉核实,别自证。一波不够深、或冒出新待挖点就【再派一波】—— 目标是把事做透,不是一遍浅 pass 交差。',
      '   【交付自检 —— 防"看上去完成"】交付前必须输出【要求-证据对照表】:总目标的每个要求点逐项给证据(file:行号 / 命令输出 / 测试通过)—— 给不出证据的项 = 没做完,继续干,不许"看上去做完了"就交。',
      '   【禁标完成的情形】四种情况不许标完成:测试在挂 / 只做了一半 / 有未解决的错误 / 找不到需要的文件或依赖;卡住时保持 in_progress,并新建一条"要解决什么"的任务接着干 —— 不许把阻塞说成做完(CC TodoWrite 诚信条款改写,依据 external/claude-code-提示词工程借鉴.md §4.2)。',
      '   【不确定就问】关键不确定(需求歧义/两种以上合理做法/不可逆操作/数据口径不明)→ 用 question 工具问用户再继续(有应答通道);只有影响产出正确性才问,琐碎自定。交付前自查产出:还没有任何落盘文件 = 没完成,按第 7 条补上 MD 文档再交付。',
      '9. 【规划先行,批准再跑】你的第一轮只做规划:轻量勘察后用 todowrite 列出执行计划,并输出简短拆解思路(怎么拆 / 哪些并行派子 Agent / 预计产出形态)。然后【直接结束这轮回答】等用户批准 —— 批准或调整意见会以新消息进来,界面上有批准按钮。【不要】调用 question / ask 之类的交互提问工具去等批准:批准走卡片上的【开始执行】按钮,提问通道不是为批准设的。第一轮不做实质执行(不写文件、不改代码、不派执行型子 Agent);用户批准后,再按(修订后的)计划开跑。',
      '10. 【收尾必蒸馏】交付前,回顾这一程挖到的真相,用 memory_add 把【关于该系统、三个月后大概率仍成立】的事实写进项目知识库(下次开卡自动注入):每条一句话 + anchors 挂证据(file:行号) + scene 写重用场景。任务进度、本次改了哪些文件【不要】写 —— 只留系统级知识;没有够格的事实就跳过,宁缺勿滥。',
      dir ? ('工作目录(主仓):' + dir + ' —— 核实与改动一律落此仓。' + (backendDir ? '副仓(只读,跨仓探查允许):' + backendDir + ' —— 可 grep/glob/read/db 只读探查,【严禁】写/改/删它;产出与改动只写主仓。' : '一律在此目录内核实与改动,不访问其它项目。')) : '',
      '</动态工作流规程>',
    ].filter(Boolean).join('\n')
  }
  // 工作流并发闸:running 数 ≥ knobs.wfConcurrency 时不直接开卡,进内存队列(S.wfQueue,重启即清);
  // 出队触发点 = ① wfTurnDone 判 done ② 工作流卡关闭(spawnCard closed 回调) ③ wf-delete 删记录。
  S.wfQueue = S.wfQueue || []
  // ── 并发上限 + 429 自适应退避 ────────────────────────────────────────────
  // 缺省从 4 提到 8:编排按视角扇出之后,4 个位子会被排队堵住(实测"派发单片"修好后的下一个瓶颈)。
  // ★但提上限【必须】配退避:内网端点一限流,原来只是把 429 翻译成一句人话(session.js),
  //   既不重试也不降速 —— 并发翻倍等于把 429 的概率一起翻倍。
  //   退避策略:见到 429 就把有效上限对半砍,每 2 分钟恢复一档,最低不低于 1。
  //   刻意做成"探上去、撞到就退"而不是"一直保守":慢端点的吞吐本来就只能靠试出来。
  const RL = { level: 0, at: 0 }        // level=连续降档数;at=最近一次 429 时刻
  const RL_RECOVER_MS = 2 * 60 * 1000
  S.noteRateLimit = () => {
    const now = Date.now()
    if (now - RL.at < 5000) return      // 一波并发同时撞墙会连报好几条,5s 内只降一档
    RL.at = now
    RL.level = Math.min(RL.level + 1, 4)
    log('[并发] 撞到 429 → 有效上限降到 ' + wfConcurrency() + '(降 ' + RL.level + ' 档,每 ' + (RL_RECOVER_MS / 60000) + ' 分钟恢复一档)')
  }
  function rlLevel() {
    if (!RL.level) return 0
    const back = Math.floor((Date.now() - RL.at) / RL_RECOVER_MS)   // 每过一个恢复窗就还一档
    return Math.max(0, RL.level - back)
  }
  function wfConcurrencyBase() {   // 并发上限旋钮:非正整数/缺失回退 8
    const n = Math.floor(+(S.settings.knobs && S.settings.knobs.wfConcurrency))
    return Number.isFinite(n) && n >= 1 ? n : 8
  }
  function wfConcurrency() {
    const lv = rlLevel()
    if (!lv) return wfConcurrencyBase()
    return Math.max(1, Math.floor(wfConcurrencyBase() / Math.pow(2, lv)))
  }
  S.wfConcurrencyBase = wfConcurrencyBase
  S.rlLevel = rlLevel
  // 测试钩子:把"上次撞墙时刻"往前拨,免得回归用例真等 2 分钟(生产代码不调它)
  S.__rlBackdate = (ms) => { RL.at -= Math.max(0, +ms || 0) }
  // 上下文口径标签:纪律/规程文本注入用(数值口径 = knobs.ctxLimitMax,默认 192k;生效上限另按 min(serve 上报, 该值) 收口)
  function ctxK() {
    const n = Math.floor(+(S.settings.knobs && S.settings.knobs.ctxLimitMax))
    return Math.round((Number.isFinite(n) && n > 0 ? n : 192000) / 1000) + 'k'
  }
  function wfRunningCount() {
    // 并发闸分口径(T8):只占【动态工作流】的并发位 —— pipeline/orch 不占位。
    // 且只数【正在干活】的:注册表 status=running 只是"没完结" —— 被中止/卡死但卡还开着的会永远占着位,
    // 把分片憋成串行(实测踩中:中止的旧卡 squat 一个位,4 片只剩 1 位)。真正占资源的是"有回合在跑"(isCardBusy);
    // 空闲等批准/等插话的卡不占位。刚起卡给 15s 启动宽限(会话还没上转,别误判空位导致超发)。
    const now = Date.now()
    return S.wfRegistry ? [...S.wfRegistry.values()].filter((r) => r.status === 'running' && r.kind !== 'pipeline' && r.kind !== 'orch'
      && ((S.isCardBusyLately && S.isCardBusyLately(r.wcId)) || now - (r.at || 0) < 15000)).length : 0   // isCardBusyLately=在跑或 3s 内刚闲(轮间空窗假象,防超发)
  }
  // [orch:TAG] 解析统一出口(以前 window.js 里两份正则拷贝 + mail.js 一份):先认行首前缀,再全文二次扫描兜底
  // (弱模型常写歪:不在最前/全角【】/全角冒号);二次扫描要求 tag 真实存在,防误吞用户文本里的同形字符串
  function parseOrchTag(goal) {
    const raw = String(goal || '')
    const m1 = raw.match(/^\s*\[orch:([A-Za-z0-9-]+)\]\s*/)
    if (m1) return { tag: m1[1], rest: raw.slice(m1[0].length) || raw }
    // 全文兜底:收集所有命形里去重后仍【唯一】的现存 tag 才拯救 —— 多个不同现存 tag 命中时放弃(错配到他主控比不拯救更糟)
    const hits = new Set()
    for (const m of raw.matchAll(/[\[【]\s*orch\s*[:：]\s*([A-Za-z0-9-]+)\s*[\]】]/g)) { if (S.orchByTag && S.orchByTag.has(m[1])) hits.add(m[1]) }
    if (hits.size === 1) {
      const m2 = raw.match(/[\[【]\s*orch\s*[:：]\s*([A-Za-z0-9-]+)\s*[\]】]/)   // 摘除第一个命形(唯一命中,必然就是它)
      return { tag: m2[1], rest: (raw.slice(0, m2.index) + raw.slice(m2.index + m2[0].length)).trim() || raw, rescued: true }
    }
    return { tag: '', rest: raw }
  }
  // relay(/orch/run)的薄壳:只服务【对话卡 Agent 自主升格开一张单工作流卡】这一条路径。
  // parentTag 那套"主控手写 [orch:TAG] 派分片"已随旧引擎删除 —— 编排的节点由状态机按 deps 自动派,
  // 不经这里。带 parentTag 进来一律显式拒绝并指路,别让它静默开出一张没人管的孤儿卡。
  function dispatchShard(goal, parentTag) {
    const g = String(goal || '').trim()
    if (!g) return { error: '缺少 goal' }
    if (parentTag && String(parentTag).trim()) {
      return { error: '编排的节点由编排面板按依赖自动派发 —— 不要用 parentTag 派分片。要加活儿请在编排面板【插话】,或让用户批准新的方案。' }
    }
    return { id: spawnWorkflow(g), shard: false, tag: '' }
  }
  S.dispatchShard = dispatchShard   // relay(mail.js /orch/run)薄壳调用;replay 用例直接驱动
  // 并发闸真值挂 S:编排引擎要拿它算 capHint(状态机只知道 run 内并发,不知道别的卡占了多少位)。
  // 不给这个数,节点会被置成 running 之后才在派发时撞上全局闸 → "running 却没有卡"的死节点。
  S.wfRunningCount = wfRunningCount
  S.wfConcurrency = wfConcurrency
  // opts(新引擎专用,旧路径一律不传 → 行为一字不变):
  //   { runId, nodeId, writeScope[], contract[], isVerify, alias }
  // 老路子把 writeScope/契约/验证棒身份【编码进 goal 文本再 parse 回来】(parseWriteScope/「集成验证」字面),
  // 排队出队还得靠文本二次恢复 —— 任何文案改动都可能静默破坏它。新引擎直接结构化下发,不走文本往返。
  function spawnWorkflow(goal, forceModel, opts) {
    const wo = opts || null
    const raw = String(goal || '').trim() || '未命名工作流'
    // 多层派发:主控卡派出的分片 goal 带 [orch:TAG] 前缀 → 登记父子关联(wfTurnDone 据此唤醒主控),展示与注入都剥掉标记;
    // 排队时保留原始 goal(含标记),出队重走本函数再解析,标记不丢
    // ★goal 文本里的 [orch:TAG] 不再有任何效力(裁-1):旧引擎靠它当父子外键,现在节点身份走 opts 结构化下发。
    // 留着文本分支 = 用户/模型 goal 里一旦出现这种字样,就会开出一张隐藏、权限自动放行、没人收官的孤儿卡。
    const g = raw
    if (wfRunningCount() >= wfConcurrency()) {
      // 新引擎的节点【不进全局队列】:它自己有 state:'queued',下一次 tick 有空位就派 ——
      // 队列项靠 goal 文本恢复 writeScope/isVerify 那套(闸28)对它不适用,别让两套排队机制互相打架
      if (wo && wo.runId) { log('[orch] 并发满,节点 ' + wo.nodeId + ' 留在 run 内排队'); return { ok: true, queued: true, position: 0 } }
      S.wfQueue.push({ goal: raw, at: Date.now(), forceModel: forceModel || null })   // forceModel 随队列走:出队恢复读图模型口径(验证棒排队不丢双模型)
      log('workflow queued (running ' + wfRunningCount() + '/' + wfConcurrency() + ', position ' + S.wfQueue.length + '): ' + g.slice(0, 60))
      return { queued: true, position: S.wfQueue.length }
    }
    // ★工作目录必须跟着【发起方】走,不能读全局当前值。
    //   run.dir 是 createRun 时的快照(每个 run 各一份),而这里原来无条件读 S.settings.projectDir ——
    //   同时跑两个工作流、而用户中途切过目录(或两个 run 本来就在不同目录)时,后开的那张卡会拿到
    //   【另一个 run 的目录】。更糟的是这个 dir 还被烤进 workflowSystemPrompt(dir, …),
    //   于是路径和提示词【一起串台】(用户实测原话:"两个工作流同时启动会混着用项目路径和提示词")。
    //   opts.dir 缺席时才回退全局值(独立工作流卡没有 run,那条路径本来就该用当前目录)。
    const dir = (wo && wo.dir) ? String(wo.dir) : (S.settings.projectDir || '')
    // msg=系统规程+目标(发给 serve);disp=目标(用户气泡只显示目标,规程不露)。返回卡 id,与旧签名兼容。
    // 主控的分片/索引棒 → 隐藏卡:不开窗,会话经 session.js 镜像回流到主控卡主区域(shard 视图);
    // 自动过规划闸 + 权限自动放行(无人值守);进度经 pushShardProgress 聚合进主控卡
    // 分片继承主控的发起模型(编排页选定):整条派发链同一个大脑;排队出队重走本函数时会重新查,注册表还在就丢不了
    // 新引擎节点:同样是隐藏无人值守工人卡(复用整套 shard 语义:自动过闸/权限放行/镜像回流),
    // 只是身份与写归属由 opts 结构化下发,不再从 goal 文本里 parse
    const isRunNode = !!(wo && wo.runId)
    // 展示名与下发文本分开:disp 只用来显示(卡标题 / reg.goal / 分片 chip / 卡坞列表),
    // msg 才是喂给模型的完整 brief。编排节点的 brief 开头恒为"【总目标】…",拿它当展示名的话
    // 每张卡都显示同一段前缀,谁是谁完全分不出来(真跑截图实锤)。
    const disp = (isRunNode && wo.title) ? String(wo.title) : g
    const bdir = (wo && wo.backendDir) ? String(wo.backendDir) : (S.settings.backendDir || '')   // 副仓同理:也是 run 的快照,不能读全局当前值
    const id = spawnCard('工作流 · ' + disp.slice(0, 20), null, workflowSystemPrompt(dir, bdir) + '\n\n【总目标】\n' + g, disp,
      // forceModel 两条分支都要传:队列项一直存着它(wfDequeue 出队时原样透传),但独立工作流分支从来没接过 ——
      // 也就是说"forceModel 随队列走"这个契约在独立工作流上一直是空的(旧代码只在分片分支给 model)
      // verify 一路带到 spawnCard:渲染端的绕圈看门狗要靠它豁免自己(核实/验收以重读文件为职责)
      isRunNode ? { wf: true, shard: true, hidden: true, model: forceModel, verify: !!(wo && wo.isVerify) } : { flash: true, wf: true, model: forceModel })
    // 卡级目录登记:session.js 建会话时按 S.cardDir.get(wcId) 取 dir,不登记就又回到 S.settings.projectDir ——
    // 上面那行只解决了"系统提示词里写的路径",这行才解决"它实际在哪个目录里干活"。两处都要,少一处仍然串。
    if (dir) { try { const wcid = S.cardWcById && S.cardWcById.get(String(id)); if (wcid != null) { S.cardDir = S.cardDir || new Map(); S.cardDir.set(wcid, dir) } } catch {} }
    if (isRunNode) {
      try {
        const reg = S.wfRegistry && S.wfRegistry.get(String(id))
        if (reg) {
          reg.runId = String(wo.runId); reg.nodeId = String(wo.nodeId || '')
          reg.parentOrch = String(wo.alias || '')          // 兼容垫片:ShardPanel / pushShardProgress 仍按它认这一片
          reg.writeScope = Array.isArray(wo.writeScope) ? wo.writeScope.slice() : []
          reg.contract = Array.isArray(wo.contract) ? wo.contract.slice() : []
          if (wo.isVerify) reg.isVerify = true
          if (reg.parentOrch) pushShardProgress(reg.parentOrch)
        }
      } catch (e) { log('[orch] 节点卡登记失败:' + e.message) }
      return { ok: true, id }
    }
    return id
  }
  // ── 多层派发(主控卡):主 Agent 层面就把目标拆成 N 个【互相独立+各自可交付】的分片,每个分片是一张全新工作流卡
  // (全新 128k,内部可再 task 扇出 + 55% 主动交棒),全部完成后派【索引棒】把各分片结论关联成两级索引 README。
  // 不新造引擎:派发=run_workflow、收口=workflow_result、索引棒=最后一次 run_workflow;主控卡极薄(只装清单+状态)。
  // 关联机制:主控规程要求分片 goal 带 [orch:TAG] 前缀(spawnWorkflow 解析登记 reg.parentOrch),
  // wfTurnDone 判分片收官后给主控卡注入进度消息(N/M)把它唤醒 —— 事件驱动,不轮询。
  // 分片进度聚合推送:分片是静默卡不弹窗,进度以卡片形式聚合进主控卡 —— 分片登记/排队/收官都推一次全量状态
  function pushShardProgress(tag) {
    try {
      const oref = S.orchByTag && S.orchByTag.get(tag); if (!oref) return
      const oreg = S.wfRegistry && S.wfRegistry.get(String(oref.id)); if (!oreg) return
      const wc = wcById(oreg.wcId)   // 主控卡可能是内嵌 guest(波2)
      if (!wc) return
      const shards = [...S.wfRegistry.values()].filter((r) => r.parentOrch === tag)
        .map((r) => ({ id: r.id, goal: String(r.goal || '').slice(0, 60), status: r.status, round: r.rounds || 0 }))
      for (const q of (S.wfQueue || [])) {   // 排队中的分片(goal 带 [orch:tag] 前缀,还在等并发位)
        const m = parseOrchTag(q.goal)   // 与 spawnWorkflow 同一份解析(行首前缀+全文兜底),不再两份正则各写各的
        if (m.tag && m.tag === tag) shards.push({ id: '', goal: String(m.rest).slice(0, 60), status: 'queued', round: 0 })
      }
      wc.send('shard-progress', { shards })
    } catch {}
  }
  // ── 编排入口 ────────────────────────────────────────────────────────────────
  // 复杂目标 → 编排 run:代码实测目录量级 → 决策器出节点方案 → 用户在编排面板批准 →
  // 按 deps 并行派工人节点 → 每个节点收官都重新规划 → 收口。状态机在 src/orch/,这里只是入口。
  //
  // 老的"LLM 主控卡"已整体删除:它把编排控制流序列化成中文塞进一张会说话的卡(6.5k 常驻规程),
  // 再指望模型把壳层已经知道的账重记一遍,于是长出十几道兜底闸去纠正它。
  //
  // 失败一律【显式报错】,不静默降级:面板卡落到 legacy 页会把标题当首条消息发给模型,
  // 长出一张会说话的野卡 —— 那比直接报错难查得多。
  function startOrchRun(goal, opts) {
    const g = String(goal || '').trim() || '未命名编排'
    if (!S.orch) return { error: '编排引擎未装配(见日志 [orch]),这次没法起编排' }
    const vueOk = ((S.settings && S.settings.cardImpl) || 'vue') !== 'legacy'
      && fs.existsSync(path.join(__dirname, '..', 'ui', 'dist', 'chat.html'))
    if (!vueOk) return { error: '编排面板需要 Vue 卡片页:请先跑 npm run ui:build,或把 settings.cardImpl 改回 vue' }
    try { return S.orch.createRun(g, opts || {}) }
    catch (e) { log('[orch] 起 run 失败:' + (e && e.stack || e)); return { error: '编排发起失败:' + (e && e.message || e) } }
  }
  // 出队补位:队列非空且有空位 → shift 开下一张并桌面通知。guard 防重入(判 done/关卡/删记录可能同拍连发)。
  let wfDequeuing = false
  function wfDequeue() {
    if (wfDequeuing || !S.wfQueue || !S.wfQueue.length) return
    if (wfRunningCount() >= wfConcurrency()) return
    wfDequeuing = true
    try {
      const next = S.wfQueue.shift()
      if (!next) return
      const id = spawnWorkflow(next.goal, next.forceModel || null)   // 出队恢复发起时的 forceModel(双模型:验证棒的读图模型口径不丢)
      // 排队时验证棒身份挂不上注册表(卡还没开出来):出队重开后按 goal 文本补登记 —— VERDICT 机判/证据闸豁免以 reg.isVerify 为准;
      // 只读沙箱 writeScope 由 goal 里的「写归属:」行被 parseWriteScope 天然恢复(这里只是兜底)
      if (/集成验证/.test(String(next.goal || ''))) {
        try {
          const vreg = (id && typeof id !== 'object') && S.wfRegistry && S.wfRegistry.get(String(id))
          if (vreg) { vreg.isVerify = true; if (!Array.isArray(vreg.writeScope) || !vreg.writeScope.length) vreg.writeScope = [require('os').tmpdir().replace(/\\/g, '/')] }
        } catch {}
      }
      log('workflow dequeued → card ' + JSON.stringify(id) + ': ' + String(next.goal).slice(0, 60))
      if (!/^\s*\[orch:/.test(String(next.goal))) {   // 分片出队不桌面通知(静默卡,进度在主控卡里看)
        try { new Notification({ title: 'BocomHermes · 工作流', body: '排队的工作流已开跑：' + String(next.goal).slice(0, 60) }).show() } catch {}
      }
    } finally { wfDequeuing = false }
  }
  // ── 工作流成果注册表(新路径):session.js 每轮回调,orch-mcp workflow_result / 卡坞据此取成果 ──
  // 每轮终答即最新成果(快照式,不等"全部结束"):升格方随时可取、关窗不丢(存档落盘)。
  // status 语义:running=还有未完 todo(或没用过 todo);done=todo 全勾;interrupted=关卡时还在跑 / 严格模式失败停发。翻转只在轮末重算 ——
  // 升格方拿 workflow_result 据此知道"活干完了",不再死等一个不关卡就永远 running 的工作流。
  // 严格模式(固定步骤链)下一步下发:走 card-inject 进卡片渲染端,让每一步都过 card-send 通道 ——
  // 这样 session.js 每轮终答必回调 wfTurnDone,链条闭环不依赖主进程直发后的回合检测。
  function strictSendNext(reg) {
    const wc = wcById(reg.wcId)   // 严格模式编排卡可能是内嵌 guest(波2)
    if (!wc) return false
    const n = reg.strictIdx   // 下一步下标(0 起;steps[0] 已在开卡首条消息里发掉)
    const step = String(reg.strictSteps[n] || '')
    if (!step) return false
    const text = '<任务编排·严格模式>\n【第 ' + (n + 1) + '/' + reg.strictSteps.length + ' 步】只执行这一步并汇报结果;做完等下一步自动下发,不要提前做后续步骤。若本步失败,明说「失败」及原因。\n</任务编排·严格模式>\n' + step
    try { wc.send('card-inject', { text, disp: '【第 ' + (n + 1) + '/' + reg.strictSteps.length + ' 步】' + step.slice(0, 120), origin: 'system' }); reg.strictIdx++; return true } catch { return false }
  }
  // 分片落定计时器(收官兜底,见 wfTurnDone 末尾):轮末/回合报错后 45s 没开新回合 → 补判收官。
  // S.wfTurnStart 由 session.js 每次 card-send 回调(新回合开始=还活着,解除计时);
  // S.wfTurnError 由 session.js 回合抛错回调(报错路径到不了 wfTurnDone,也得兜底,否则 serve 中断一次就永远卡 running)。
  const shardSettleTimers = new Map()   // wcId → timer
  const wfTurnBusy = new Set()   // wcId:wf 卡在飞回合(主进程自维护,回合 busy 推导的兜底来源 —— Vue 卡不上报 card-busy IPC,session.js turnBusy 挂载前的权威替身);wfTurnStart 加、wfTurnDone/wfTurnError 摘
  S.wfTurnStart = (wcId) => {
    const t = shardSettleTimers.get(wcId); if (t) { clearTimeout(t); shardSettleTimers.delete(wcId) }
    const reg = S.wfCardByWc && S.wfCardByWc.get(wcId)
    if (reg) wfTurnBusy.add(wcId)   // 回合 busy 兜底轨:wfTurnDone/wfTurnError 对称摘除
    // 双轨:run 节点的"又开始跑了"由引擎记(verified→running 在它那里是一行合法转移,不需要复位任何标志)。
    // 这里【不早退】—— 上面的 busy 记账与清计时对两轨都要做
    if (reg && reg.runId && S.orch) { try { S.orch.onWorkerTurnStart(reg) } catch (e) { log('[orch] turnStart 路由失败:' + e.message) } }
  }
  S.wfTurnError = (wcId) => {
    wfTurnBusy.delete(wcId)
    const reg = S.wfCardByWc && S.wfCardByWc.get(wcId)
    if (reg && reg.runId && S.orch) { try { S.orch.onWorkerTurnError(reg) } catch (e) { log('[orch] turnError 路由失败:' + e.message) } ; return }
  }
  S.wfTurnDone = (wcId, finalText, snap) => {
    wfTurnBusy.delete(wcId)   // 回合 busy 兜底轨:与 wfTurnStart 对称摘除
    const reg = S.wfCardByWc && S.wfCardByWc.get(wcId); if (!reg) return
    reg.rounds++; reg.round = reg.rounds
    const t = String(finalText == null ? '' : finalText); if (t.trim()) reg.final = t
    if (snap && snap.aborted) reg.aborted = true   // 本轮被中止(用户点停/中断):注册表+存档留痕
    reg.lastAborted = !!(snap && snap.aborted)   // 每轮覆写(留痕的 reg.aborted 是粘性的):settle 判 interrupted 看【最后一轮】是否被中止 —— 被掐后恢复干完的,别再用旧中止记录误标
    reg.elapsedMs = Date.now() - reg.at
    const open = (reg.todos || []).some((x) => !/complet|cancel/i.test(String(x && x.status || '')))
    const wasDone = reg.status === 'done'
    // ③已 interrupted 的 reg(stop-all 直写/关卡落终态/settle 补判)不按 todos 翻回 running —— 终态不被轮末重算覆写
    if (reg.status !== 'interrupted') reg.status = (reg.todos && reg.todos.length && !open) ? 'done' : 'running'
    // 严格模式推进:步骤未发完时看本轮成败 —— 含失败语义(模型明说失败/无法/放弃)→ 停发并标 interrupted;否则自动下发下一步。
    // 失败判定只在"还有步要发"时做:全部发完后的收尾汇报常带"无失败"之类否定句,误标 interrupted 没意义。
    if (reg.strictSteps && reg.strictSteps.length && !reg.strictFailed) {
      if (reg.strictIdx < reg.strictSteps.length) {
        if (/失败|无法|放弃/.test(t)) { reg.strictFailed = true; reg.status = 'interrupted'; log('strict pipeline interrupted at step ' + reg.strictIdx + '/' + reg.strictSteps.length + ' (card ' + reg.id + ')') }
        else { reg.status = 'running'; try { strictSendNext(reg) } catch (e) { log('strict step send err: ' + e.message) } }   // 步骤未发完强制 running,防提前判 done/误通知
      }
    }
    if (!wasDone && reg.status === 'done' && !reg.parentOrch) {   // 首次全勾:桌面通知一声(长跑工作流用户多半不在跟前);分片不通知(进度聚合在主控卡,弹 N 次通知是骚扰)
      try { new Notification({ title: reg.kind === 'pipeline' ? '任务编排完成' : '工作流完成', body: String(reg.goal).slice(0, 80) }).show() } catch {}
    }
    try { S.wfArchive(reg) } catch (e) { log('wf archive err: ' + e.message) }
    if (reg.parentOrch) pushShardProgress(reg.parentOrch)   // 分片每轮末都刷一次进度面板(轮次/状态即时可见;渲染端已 150ms 合帧)
    // ── 双轨分流点 ──────────────────────────────────────────────────────
    // 位置很讲究:必须在 `reg.status =` 与 pushShardProgress 【之后】——
    //   · reg.status 还得照写:mail.js 的 /orch/result 与 :235 的 FIFO victim 查找都读它,提前 return 会把这两处改坏;
    //   · pushShardProgress 也照发:ShardPanel 靠它显示这一片(兼容垫片)。
    // 只把"怎么收官"这件事让给引擎:它按 exit 判(文件在不在/契约签名/验证证据/退出码),不看 todo 全勾。
    if (reg.runId && S.orch) {
      try { S.orch.onWorkerTurnEnd(reg, snap) } catch (e) { log('[orch] turnEnd 路由失败:' + e.message) }
      if (reg.status === 'done' || reg.status === 'interrupted') wfDequeue()
      return
    }
    // 分片收官兜底:分片无人值守,done 判定靠"todo 全勾",但内网模型常不调用/不收尾 todowrite → 永远卡 running(实测),
    // 主控等不到唤醒整条链卡死。分片没有"用户继续聊"一说,轮末=它停下了:轮末仍 running 就起 45s 落定计时,
    // 期间交棒/自动重试开新回合会经 S.wfTurnStart 解除;真停下才补判,走同一个 shardSettled 通道收官。
    // verdict 三判据:①最后一轮被中止(lastAborted,含看门狗自动中止)→ interrupted;②全程零产出(final 空且无落盘文件,
    // 网关静默/空答耗尽的典型形态)→ interrupted,零产出不能叫完成;③其余 → done。
    const settleNoOutput = !String(reg.final || '').trim() && !(reg.files || []).length
    if (reg.status === 'done' || reg.status === 'interrupted') wfDequeue()   // 判收官(done/interrupted)即腾位补位(出队触发点①);中断也算,系统性失败时不出队=排队片永远卡死
  }
  S.wfTodos = (wcId, todos) => { const reg = S.wfCardByWc && S.wfCardByWc.get(wcId); if (reg && Array.isArray(todos)) reg.todos = todos }
  // write/edit 落盘路径(主 Agent 与子 Agent 都收,session.js 在工具事件里回调)→ 存档+workflow_result 可取出产物位置
  S.wfFiles = (wcId, fp) => { const reg = S.wfCardByWc && S.wfCardByWc.get(wcId); if (reg && fp && !reg.files.includes(fp)) reg.files.push(fp) }
  // 执行动作流水(session.js 在关键工具事件里回调):{kind,label,detail} 追加进注册表(上限 50 条/项),并顺带刷一次存档
  S.wfAction = (wcId, a) => {
    const reg = S.wfCardByWc && S.wfCardByWc.get(wcId); if (!reg || !a) return
    reg.actions = Array.isArray(reg.actions) ? reg.actions : []
    reg.actions.push({ kind: String(a.kind || ''), label: String(a.label || '').slice(0, 120), detail: String(a.detail || '').slice(0, 400), at: Date.now() })
    if (reg.actions.length > 50) reg.actions.splice(0, reg.actions.length - 50)
    try { S.wfArchive(reg) } catch (e) { log('wf archive err: ' + e.message) }
  }
  S.wfArchive = (reg) => {
    if (!reg || !reg.final) return
    if (reg.parentOrch) return   // 分片卡是主控的内部机器:不落磁盘存档(产出在 docs/ 与主控存档里),不污染存档目录与面板列表
    const dirW = path.join(app.getPath('userData'), 'workflows'); fs.mkdirSync(dirW, { recursive: true })
    if (!reg.archive) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
      const slug = String(reg.goal).slice(0, 24).replace(/[\\/:*?"<>|\s]+/g, '_') || 'wf'
      reg.archive = path.join(dirW, stamp + '_' + reg.id + '_' + slug + '.md')
    }
    const todoLines = (reg.todos || []).map((t) => '- [' + (/complet/i.test(String(t && t.status || '')) ? 'x' : ' ') + '] ' + String((t && (t.content || t.text || t.title)) || '')).join('\n')
    const fileLines = (reg.files || []).map((f) => '- ' + f).join('\n')
    // 执行动作流水(时间+label+detail;wf-list 卡坞同源展示)
    const actLines = (reg.actions || []).map((a) => { const d = new Date(a.at || 0); const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); return '- [' + hm + '] ' + (a.kind ? a.kind + ' · ' : '') + a.label + (a.detail ? ' — ' + a.detail : '') }).join('\n')
    fs.writeFileSync(reg.archive, '# ' + (reg.kind === 'pipeline' ? '任务编排' : reg.runId ? '编排' : '工作流') + ':' + reg.goal + '\n\n- id:' + reg.id + ' · 会话:' + (reg.sid || '-') + (reg.runId ? ' · run:' + reg.runId : '') + ' · 轮次:' + reg.rounds + ' · 用时:' + Math.round((reg.elapsedMs || 0) / 1000) + 's · 状态:' + reg.status + (reg.aborted ? ' · 曾被中止' : '') + (reg.diff ? ' · 改动:+' + reg.diff.additions + '/-' + reg.diff.deletions + ' (' + reg.diff.files + ' 文件)' : '') + '\n\n## 任务清单\n' + (todoLines || '(无)') + '\n\n## 产出文件\n' + (fileLines || '(无)') + '\n\n## 执行动作\n' + (actLines || '(无)') + '\n\n## 最终成果(最近一轮回答)\n\n' + reg.final)
  }

  // 邮件 → 建议待办(pending 态,人工确认后才进正式待办)。
  // 语义化口径(2026-07 整改):规则法关键词太宽("讨论/沟通"+任意日期即命中),把没有行动要求的邮件全捞出来(实测病灶)。
  // 现改为:hasTimeSignal 便宜预筛(无日期/截止信号的邮件不送模型)→ 攒批(20s 或 8 封)→ 一次 LLM 调用语义复核
  // (只挑"有明确截止时间的待办"与"会议待办"两类,宁可漏不可滥)→ 产出即广播 UI 刷新。
  // LLM 失败降级:收紧版规则法(必须有会议链接,或主题带明确会议词),宁可少捞不滥捞。
  const todoSuggestQ = { list: [], timer: null, busy: false }
  function maybeSuggestMeeting(em) {
    try {
      if (!em || !em.messageId || !S.todosApi) return
      if (!todoExtractLLM.hasTimeSignal(em)) return
      if (todoSuggestQ.list.some((x) => x.messageId === em.messageId)) return
      todoSuggestQ.list.push(em)
      if (todoSuggestQ.list.length > 40) todoSuggestQ.list.shift()   // 爆量兜底:丢最老(建议区本来就是尽力而为)
      if (todoSuggestQ.busy) return
      if (todoSuggestQ.list.length >= 8) { flushTodoSuggest(); return }
      if (!todoSuggestQ.timer) todoSuggestQ.timer = setTimeout(() => { todoSuggestQ.timer = null; flushTodoSuggest() }, 20000)
    } catch (e) { log('suggest meeting err: ' + e.message) }
  }
  async function askOneShot(prompt) {   // 无头一次性问答(技能精修同款模式):问答短、无需会话上下文
    const serve = await oc.ensureServe(S.settings.projectDir || '', S.handlers, log)
    const sid = await oc.createSession(serve, '邮件待办提取')
    if (!sid) throw new Error('createSession failed')
    return await oc.sendMessage(serve, sid, prompt)
  }
  async function flushTodoSuggest() {
    if (todoSuggestQ.busy) return
    todoSuggestQ.busy = true
    if (todoSuggestQ.timer) { clearTimeout(todoSuggestQ.timer); todoSuggestQ.timer = null }
    const batch = todoSuggestQ.list.splice(0, 12)
    try {
      let items
      try {
        items = await todoExtractLLM.extract(batch, askOneShot)
      } catch (e) {
        // LLM 不可用(serve 没起/模型报错) → 收紧版规则法兜底:只留"有会议链接"或"主题带明确会议词"的,防滥捞
        log('todo llm extract failed, fallback to strict rules: ' + e.message)
        items = []
        for (const em of batch) {
          const mt = extractMeeting(em)
          if (!mt) continue
          if (!mt.link && !/(会议|例会|周会|晨会|邀请|约谈|评审会|meeting|invite)/i.test(em.subject || '')) continue
          items.push({ msgId: em.messageId, kind: 'meeting', from: em.from || '', subject: em.subject || '', date: em.date || '', text: (em.subject || '会议').slice(0, 80) + (mt.snippet ? ' · ' + mt.snippet : ''), meetingAt: mt.meetingAt, link: mt.link })
        }
      }
      let added = 0
      for (const it of items) {
        const sug = S.todosApi.addSuggestion({ msgId: it.msgId, from: it.from, subject: it.subject, date: it.date, kind: it.kind, text: it.text, meetingAt: it.meetingAt, link: it.link })
        if (sug) added++
      }
      if (added) { log('todo-suggest: 语义提取新增 ' + added + ' 条 (批次 ' + batch.length + ' 封)'); for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('todo-suggest-updated') } catch {} } }
    } catch (e) { log('flush todo suggest err: ' + e.message) } finally {
      todoSuggestQ.busy = false
      if (todoSuggestQ.list.length) setTimeout(flushTodoSuggest, 1000)   // 队列还有剩,接着冲
    }
  }

  // ── 邮件整理卡 ─────────────────────────────────────────────────────────────
  // 行为:拉今天+昨天的邮件(不限未读)→ 过滤掉之前 📧 按钮已整理过的 → 喂 agent 摘要
  //       已整理过的 messageId 持久化在 userData/email-summary-seen.json
  async function spawnEmailCard() {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    try {
      log('email: fetching today+yesterday emails (limit 30, onlyUnseen=false)…')
      const r = await email.fetchUnread(imap, { onlyUnseen: false, days: 2, limit: 30 })
      const all = r.emails || []
      if (!all.length) { log('email: no emails in last 2 days'); throw new Error('近 2 天没有邮件') }
      // 过滤已整理过的
      const seen = emailSummarySeen.isSeenSet(app.getPath('userData'))
      const fresh = all.filter((e) => !e.messageId || !seen.has(e.messageId))
      if (!fresh.length) {
        log('email: all ' + all.length + ' emails already summarized — skipping')
        throw new Error('近 2 天的 ' + all.length + ' 封邮件都已整理过,无新邮件需要总结')
      }
      // 仅对要展示的新邮件落附件 + 缓存
      try { await attachments.saveAttachments(fresh, app.getPath('userData'), log) } catch (e) { log('saveAttachments err: ' + e.message) }
      for (const em of fresh) {
        if (!em.messageId) continue
        mailCache.put(app.getPath('userData'), em)
        S.mailCache.set(em.messageId, { messageId: em.messageId, uid: em.uid, folder: em.folder || 'INBOX', from: em.from, subject: em.subject, date: em.date, attCount: (em.attachments || []).length, savedAt: Date.now() })
        maybeSuggestMeeting(em)   // 规则法识别会议 → 建议待办(人工确认后才进正式待办)
      }
      // 内存缓存这次结果,UI 加待办时能回填邮件正文
      S.mailLastBatch = { ts: Date.now(), emails: fresh }
      const prompt = email.formatEmailPrompt(fresh)
      const prompt2 = prompt + '\n\n注意:你提取的 TODO 行,如果对应某封具体邮件,请在 TODO 行后面追加 `[msgId:xxx]`(xxx 是上面邮件的 Message-ID,见输出),系统会自动回填邮件主题/日期/正文摘要进待办,跨会话也能反查到。'
      const skipped = all.length - fresh.length
      const title = '邮件整理 · ' + new Date().toLocaleDateString('zh-CN') + ' · 新 ' + fresh.length + (skipped ? '/已跳 ' + skipped : '')
      // flash:卡片加载完后任务栏闪 + 抢焦点 + 短暂置顶 1.5s → 用户一眼能找到新弹的卡
      spawnCard(title, null, prompt2, null, { flash: true })
      // 标记 seen 放在卡片建好之后:摘要卡若没弹出来,这些邮件不会被误标"已整理"而永久漏掉
      emailSummarySeen.markSeen(app.getPath('userData'), fresh.map((e) => e.messageId).filter(Boolean))
      log('email: summarized ' + fresh.length + ' new of ' + all.length + ' total (skipped ' + skipped + ' already-seen)')
      return fresh.length
    } catch (e) {
      throw e
    }
  }

  function openOutbox() {
    if (S.outboxWin && !S.outboxWin.isDestroyed()) { S.outboxWin.show(); S.outboxWin.focus(); S.outboxWin.webContents.send('outbox-updated'); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const ox = Math.round(width / 2 - 270), oy = 120
    S.outboxWin = new BrowserWindow(baseOpts({ width: 540, height: 640, x: ox, y: oy, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 420, minHeight: 360 }))
    S.outboxWin.loadFile(path.join(__dirname, '..', 'ui', 'outbox.html'))
    S.outboxWin.on('closed', () => { S.outboxWin = null })
  }

  function openAudit() {
    if (S.auditWin && !S.auditWin.isDestroyed()) { S.auditWin.show(); S.auditWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const ax = Math.round(width / 2 - 320), ay = 100
    S.auditWin = new BrowserWindow(baseOpts({ width: 640, height: 720, x: ax, y: ay, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 460, minHeight: 400 }))
    S.auditWin.loadFile(path.join(__dirname, '..', 'ui', 'audit.html'))
    S.auditWin.on('closed', () => { S.auditWin = null })
  }

  // ── 截图即问:全屏抓图 → 透明遮罩框选 → 裁剪 → 开一张带图的对话卡 ──────────────
  // 抓图必须先于遮罩窗出现(否则遮罩自己也进图);遮罩是透明窗,真实桌面透过它可见,只画选框。
  let snipBusy = false
  async function snapAsk() {
    if (snipBusy) return
    if (S.snipWin && !S.snipWin.isDestroyed()) { try { S.snipWin.close() } catch {} return }
    snipBusy = true
    try {
      const disp = screen.getPrimaryDisplay()
      const { width, height } = disp.size
      const sf = disp.scaleFactor || 1
      // 抓主屏全图(按物理像素,拿到高清)
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) } })
      const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0]
      if (!src || src.thumbnail.isEmpty()) { snipBusy = false; return }
      S._snipShot = src.thumbnail        // NativeImage(物理像素),裁剪时用
      S._snipSf = sf
      const win = new BrowserWindow({
        x: disp.bounds.x, y: disp.bounds.y, width, height,
        frame: false, transparent: true, fullscreen: process.platform !== 'darwin', alwaysOnTop: true,
        skipTaskbar: true, resizable: false, movable: false, hasShadow: false, enableLargerThanScreen: true,
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
      })
      S.snipWin = win
      win.setAlwaysOnTop(true, 'screen-saver')
      win.loadFile(path.join(__dirname, '..', 'ui', 'snip.html'))
      win.on('closed', () => { S.snipWin = null; snipBusy = false })
    } catch (e) { log('snapAsk err: ' + e.message); snipBusy = false }
  }
  // 遮罩窗回传 CSS 像素选区 → 按 scaleFactor 换物理像素裁剪 → data URL → 开卡
  ipcMain.handle('snip-crop', (_e, rect) => {
    try {
      const shot = S._snipShot, sf = S._snipSf || 1
      if (S.snipWin && !S.snipWin.isDestroyed()) S.snipWin.close()
      if (!shot || !rect || rect.w < 4 || rect.h < 4) { S._snipShot = null; return { ok: false } }
      const px = { x: Math.round(rect.x * sf), y: Math.round(rect.y * sf), width: Math.round(rect.w * sf), height: Math.round(rect.h * sf) }
      const cropped = shot.crop(px)
      S._snipShot = null
      const url = 'data:image/png;base64,' + cropped.toPNG().toString('base64')
      // 默认问法自动发送(附截图);用户可在卡里继续追问
      const id = spawnCard('截图提问', null, '这是我截的一张屏,请先看图说说你看到了什么/有什么问题,我接着追问。', null, { flash: true })
      S.cardFiles = S.cardFiles || new Map()
      S.cardFiles.set(String(id), [{ mime: 'image/png', url, filename: '截图.png' }])
      return { ok: true }
    } catch (e) { log('snip-crop err: ' + e.message); S._snipShot = null; return { ok: false, error: e.message } }
  })
  ipcMain.on('snip-cancel', () => { S._snipShot = null; if (S.snipWin && !S.snipWin.isDestroyed()) S.snipWin.close() })

  // ── HTTP 抓包 GUI(仅本地 127.0.0.1 转发,不做 HTTPS MITM):抓外部程序(柜面客户端等)的 HTTP 流量 ──
  const httpcap = require('./httpcap')({ log })
  httpcap.setOnAdd((rec) => { try { if (S.httpcapWin && !S.httpcapWin.isDestroyed()) S.httpcapWin.webContents.send('httpcap-add', rec) } catch {} })
  ipcMain.handle('httpcap-start', async (_e, port) => {
    const p = await httpcap.start(port || 0)
    try { S.audit && S.audit('httpcap', '启动抓包代理 127.0.0.1:' + p) } catch {}
    return { ok: true, port: p, addr: '127.0.0.1:' + p }
  })
  ipcMain.handle('httpcap-stop', () => { httpcap.stop(); return { ok: true } })
  ipcMain.handle('httpcap-status', () => httpcap.status())
  ipcMain.handle('httpcap-list', (_e, opts) => httpcap.list(opts || {}))
  ipcMain.handle('httpcap-get', (_e, id) => httpcap.get(id))
  ipcMain.handle('httpcap-clear', () => { httpcap.clear(); return true })
  function openHttpcap() {
    if (S.httpcapWin && !S.httpcapWin.isDestroyed()) { S.httpcapWin.show(); S.httpcapWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const hx = Math.round(width / 2 - 380), hy = 90
    S.httpcapWin = new BrowserWindow(baseOpts({ width: 760, height: 760, x: hx, y: hy, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 540, minHeight: 420 }))
    S.httpcapWin.loadFile(path.join(__dirname, '..', 'ui', 'httpcap.html'))
    S.httpcapWin.on('closed', () => { S.httpcapWin = null })
  }

  function openMailView(msgId) {
    const id = String(msgId || '').replace(/^<|>$/g, ''); if (!id) return
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const mx = Math.round(width / 2 - 380), my = 80
    if (!(S.mailViewWin && !S.mailViewWin.isDestroyed())) {
      S.mailViewWin = new BrowserWindow(baseOpts({ width: 760, height: 800, x: mx, y: my, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 480, minHeight: 400 }))
      S.mailViewWin.on('closed', () => { S.mailViewWin = null })
      // 兜底:邮件窗口内任何弹窗/跳转一律转系统浏览器(防未来 sandbox 配置回归)
      const wc = S.mailViewWin.webContents
      wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' } })
      wc.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}) } })
    } else { S.mailViewWin.show(); S.mailViewWin.focus() }
    S.mailViewWin.loadFile(path.join(__dirname, '..', 'ui', 'mailview.html'), { query: { msgId: id } })
  }

  // 邮件中心：收件箱 + 设置一体（邮件模块的设置归口在此）
  function createMailCenter(tab) {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    const W = Math.min(1280, sw - 60), Hh = Math.min(900, sh - 60)
    const mx = Math.round((sw - W) / 2), my = Math.round((sh - Hh) / 2)
    if (!(S.mailCenterWin && !S.mailCenterWin.isDestroyed())) {
      S.mailCenterWin = new BrowserWindow(baseOpts({ width: W, height: Hh, x: mx, y: my, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 720, minHeight: 520 }))
      S.mailCenterWin.on('closed', () => { S.mailCenterWin = null })
      // 兜底:邮件中心内任何弹窗/跳转一律转系统浏览器(防未来 sandbox 配置回归)
      const wc = S.mailCenterWin.webContents
      wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' } })
      wc.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}) } })
    } else { S.mailCenterWin.show(); S.mailCenterWin.focus() }
    const query = {}
    if (tab) query.tab = tab
    S.mailCenterWin.loadFile(path.join(__dirname, '..', 'ui', 'mailcenter.html'), { query })
  }

  // 「🎬 录制与回放」中心:录制/技能的一级入口(与浏览器/邮件中心同级,进托盘菜单)。
  // 「🎬 录制与回放」= 带 Agent 工作流面板的工作台(方案 B):不再是独立窗,直接进「调试工作台」
  // (左 Agent 卡片 + 右浏览器 + 底部技能条),这样录制/回放时 Agent 的整理/解析/自愈全程可见。
  function createSkillCenter() { createWorkspace('', { skills: true }) }
  // 事件中继:工作台 chrome(宿主模式=主窗上的 chrome 视图;standalone=工作台窗)统一经 chromeSend 推
  function skillsNotify(ch, d) { try { chromeSend(ch, d || {}) } catch {} }

  // ── 面板 / 托盘 ─────────────────────────────────────────────────────────────
  function openSettings() {
    if (S.settingsWin && !S.settingsWin.isDestroyed()) { S.settingsWin.show(); S.settingsWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const sx = Math.round(width / 2 - 280), sy = 120
    S.settingsWin = new BrowserWindow(baseOpts({ width: 560, height: 640, x: sx, y: sy, skipTaskbar: false, alwaysOnTop: true, resizable: true, minWidth: 460, minHeight: 460 }))
    S.settingsWin.loadFile(path.join(__dirname, '..', 'ui', 'settings.html'))
    S.settingsWin.on('closed', () => { S.settingsWin = null })
  }

  function openDock() {
    if (S.dockWin && !S.dockWin.isDestroyed()) { S.dockWin.show(); S.dockWin.focus(); return }
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const W = 700, Hh = 880
    const dx = Math.round(width / 2 - W / 2), dy = 70
    S.dockWin = new BrowserWindow(baseOpts({ width: W, height: Hh, x: dx, y: dy, skipTaskbar: false, alwaysOnTop: false, resizable: true, minWidth: 480, minHeight: 520 }))
    S.dockWin.loadFile(path.join(__dirname, '..', 'ui', 'dock.html'))
    S.dockWin.on('closed', () => { S.dockWin = null })
  }

  // 「桌面主窗口」(主窗口化重构·波1 骨架):shell 页 = 侧栏 + 视图区 + 状态栏,
  // 对话/任务编排/邮件中心/设置以 <webview> 收编为视图(?embed=1 / ?embedded=1 嵌入态)。
  // shell 实现双轨(Vue 迁移 P1):默认 Vue 版(ui/dist/shell.html);settings.json 置
  // "shellImpl":"legacy" 回退原生版(ui/shell.html,保留不删)。设置页无开关,只读配置。
  // chrome 写法照 browser.js 的非透明窗:系统红绿灯(mac hiddenInset)/ Win titleBarOverlay,不走 baseOpts 的透明无边框系。
  function createMainWindow() {
    if (S.mainWin && !S.mainWin.isDestroyed()) { if (S.mainWin.isMinimized()) S.mainWin.restore(); S.mainWin.show(); S.mainWin.focus(); return S.mainWin }
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    const W = Math.min(1280, sw - 40), Hh = Math.min(800, sh - 40)
    S.mainWin = new BrowserWindow({
      width: W, height: Hh, minWidth: 940, minHeight: 600,
      x: Math.round((sw - W) / 2), y: Math.round((sh - Hh) / 2),
      title: 'BocomHermes',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 13, y: 12 },
      // Windows: 系统三键 overlay 融进自绘标题栏(38px),渲染层不自绘窗控
      titleBarOverlay: process.platform === 'win32' ? { color: '#f3f4f7', symbolColor: '#3c4250', height: 38 } : undefined,
      autoHideMenuBar: true,
      backgroundColor: '#f3f4f7',
      // 白屏治理:创建即 show 时,shell 单文件包解析+Vue 挂载+IPC 就绪的几百 ms 里用户盯着 backgroundColor 近白屏。
      // 改为首帧绘制完成(ready-to-show)再亮相 —— 窗口晚出现一点点,但出来就是渲染好的完整界面。
      show: false,
      // webviewTag:四个视图页全部以 <webview> 收编;preload 与全应用同一份(白名单不变)
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
    })
    // 3s 兜底:ready-to-show 异常不发(极端)也不能让窗口永远不亮 —— 白屏可忍,黑盒不可忍
    let mainShown = false
    const showMainOnce = () => { if (mainShown || !S.mainWin || S.mainWin.isDestroyed()) return; mainShown = true; S.mainWin.show() }
    S.mainWin.once('ready-to-show', showMainOnce)
    setTimeout(showMainOnce, 3000)
    S.mainWin.on('closed', () => {
      // 主窗口关 = 内嵌会话卡全灭:逐张走卡关闭清理链(波2 抽出的 cleanupCardContext),
      // 不然 serve 进程/会话映射/busy 状态全成孤儿(browser.js:644-664 同款教训)
      try { for (const wcId of [...(S.embedWc || [])]) cleanupCardContext(S, wcId, null) } catch (e) { log('mainWin embedded cleanup err: ' + e.message) }
      S.mainWin = null
    })
    const shellImpl = (S.settings && S.settings.shellImpl) || 'vue'   // 'legacy' = 回退原生 shell.html
    S.mainWin.loadFile(shellImpl === 'legacy'
      ? path.join(__dirname, '..', 'ui', 'shell.html')
      : path.join(__dirname, '..', 'ui', 'dist', 'shell.html'))
    return S.mainWin
  }

  // 【内嵌浏览器核心】整块搬进 ./browser 的 initBrowser(ctx) 工厂(见该文件抬头)。
  // 必须在 initRecorder 之前构造:后者构造时即读取返回的 brActive(const,非提升)。
  // 录制钩子 wireRecToTab/brSendRecCount 是后定义但已提升的 function,按引用注入。
  // 浏览器 IPC / brWC / 调试分诊层仍留在本文件,消费下面解构出的函数。
  const { brActive, newTab, closeTab, activateTab, brSetDevice, brRotateDevice, brZoom, brLayout, brSendTabs, sendNetSnapshot, attachDbg, detachDbg, normalizeUrl, brScreenshot, brShotTab, brNetBody, brPickElement, brEval, createBrowser, ensureBrowserBackground, createWorkspace, createShellBrowser, shellBrowserVisible, chromeSend } = initBrowser({ S, session, log, path, fs, app, BrowserWindow, WebContentsView, oc, forgetBusy, wireRecToTab, brSendRecCount, cdpConsoleLevel, fmtRO, fmtException })

  // 【解析链②·文件总线】回放暂停步 ↔ Agent 的通信(设计:docs/技能系统-意图执行与Agent解析链设计.md 第 4 节):
  // 主进程写 req(userData/resolves/<gateId>.json)+ card-inject 通知工作台 Agent;
  // Agent 用 repro-mcp 的 skill_resolve 写 res(<gateId>.res.json);replayRec 轮询到即续跑。
  // 与 assertions/scans/reviews 同款文件总线 —— MCP 是独立进程,共享 userData 是既有契约。
  const resolvesDir = () => path.join(app.getPath('userData'), 'resolves')
  const resolveBus = {
    post(req) {
      try {
        fs.mkdirSync(resolvesDir(), { recursive: true })
        for (const f of fs.readdirSync(resolvesDir())) { try { const fp = path.join(resolvesDir(), f); if (Date.now() - fs.statSync(fp).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp) } catch {} }   // 顺手清陈旧 req/res
        fs.writeFileSync(path.join(resolvesDir(), req.gateId + '.json'), JSON.stringify(req, null, 2))
      } catch (e) { log('resolve post err: ' + e.message) }
    },
    check(gateId) { try { return JSON.parse(fs.readFileSync(path.join(resolvesDir(), gateId + '.res.json'), 'utf8')) } catch { return null } },
    clear(gateId) { for (const suf of ['.json', '.res.json']) { try { fs.unlinkSync(path.join(resolvesDir(), gateId + suf)) } catch {} } },
    // 尽力通知工作台 Agent(链②):无工作台/卡已销毁 → false,解析链自动只剩人工(链③),技能照样跑
    notifyAgent(req) {
      const b = S.browser
      const wc = agentInjectWc(); if (!wc) return false   // 没有收件人 → false,解析链自动只剩人工(链③),技能照样跑
      let disp, text
      if (req.kind === 'takeover') {   // 混合执行:严格回放整段失败 → Agent 流程级接管,直接操作内嵌浏览器完成剩余
        disp = `回放第 ${req.step} 步起整段失败 — Agent 接管执行中…`
        text = `技能「${req.title}」的严格回放从第 ${req.step} 步起整段失败,请你【接管执行剩余流程】。\n`
          + `目标:${req.goal || '(见步骤)'}${req.successText ? '\n成功标志:' + req.successText : ''}\n`
          + `当前页面:${req.url}${req.pageTitle ? '(' + req.pageTitle + ')' : ''}\n失败点:${req.failText}\n\n`
          + `【当前页可交互元素(→ 后为现成选择器,可直接用,无需先 read)】\n${req.pageElements || '(未采集到,先调 skill_page_read)'}\n\n`
          + `【已完成的步骤】\n${req.doneText}\n\n【剩余步骤(按意图达成,不必逐字照做)】\n${req.restText}\n\n`
          + `工具(操作的就是用户可见的内嵌浏览器):\n`
          + `- skill_page_act(action, …):执行一步。action ∈ click|type|type_param|select|check|enter|navigate|wait。\n`
          + `  · selector 用上面清单的现成选择器,或 __text__:tag|文本(按可见文本);【严禁】:has-text()/xpath。\n`
          + `  · secret 参数(密码等)用 action:"type_param" + key(如 "p1"),引擎代填,值不经过你。\n`
          + `- skill_page_read():页面变化后(点击/导航)重新看一眼再动手,不要盲点。\n`
          + `- 做完(或确认无法完成)调 skill_takeover_done(gateId="${req.gateId}", status="done"|"failed", note)。\n\n`
          + `【本任务只用以上三个 skill_ 工具】不要读写文件、不要用终端/bash、不要改代码 —— 这是页面操作任务,不是编码任务。\n\n`
          + `噪声处理原则:\n`
          + `- 登录缓存:若当前已是登录态(页面已在系统内),登录相关步骤直接跳过,从业务步做起;\n`
          + `- 录制里的无意义操作(菜单来回切换/多余点击)忽略,以达成技能目标为准;\n`
          + `- 遇到验证码等只有用户能提供的输入:在对话里提醒用户去页面输入,等他完成再继续。`
      } else if (req.kind === 'relocate') {   // Phase 6b:选择器失配,让 Agent 看当前页候选给一个新选择器
        disp = `⏳ 自愈·步 ${req.step}:元素定位失败,Agent 重定位中…`
        text = `技能回放第 ${req.step} 步的元素找不到了(页面可能改版/动态 id)。这步意图:${req.ask}\n`
          + `原选择器:${req.sel}${req.origAlt ? '(备选:' + req.origAlt + ')' : ''}\n所在页面:${req.url}\n\n`
          + `当前页可交互元素(tag #id '文本' name):\n${req.candidates || '(未采集到)'}\n\n`
          + `请挑出对应目标元素,调用 MCP 工具 skill_relocate(gateId="${req.gateId}", selector="…")。selector 必须是下面两种之一:\n`
          + `  1) 合法的原生 CSS 选择器(document.querySelector 能跑的):如 #id、input[name="x"]、.a > .b:nth-of-type(2)。\n`
          + `  2) 按可见文本匹配用本系统专用写法 __text__:tag|文本(如 __text__:button|确定)。\n`
          + `【严禁】:has-text()/:contains()/xpath —— 这些原生 querySelector 不认,会失败。优先用稳定锚点(语义 id/name/属性/文本),给一个你最有把握的。`
      } else {
        disp = `⏸ 回放暂停·步 ${req.step}:需要「${req.ask}」`
        text = `技能回放暂停在第 ${req.step} 步,需要一个运行时值:「${req.ask}」\n`
          + `目标字段:${req.sel}\n所在页面:${req.url}\n\n`
          + `请判断这个值能否用你手上的工具(读项目文件/Excel/查库/看复现证据)可靠得出:\n`
          + `- 能 → 解出后调用 MCP 工具 skill_resolve(gateId="${req.gateId}", value="…"),回放会立即续跑;\n`
          + `- 不能(如短信验证码只在用户手机上)→ 直接回复说明,用户会在页面手动输入。不要猜。`
      }
      try { wc.send('card-inject', { text, disp }); return true } catch { return false }
    },
  }

  // 【录制回放引擎】9 个函数搬进 ./recorder 的 initRecorder 工厂,这里注入闭包依赖后解构使用。
  // 必须放在 brActive(const,非提升)之后:initRecorder(ctx) 构造 ctx 时会即时读取 brActive。
  // 时序安全:此行在 initWindow 函数体靠前执行,而所有调用点(wireRecToTab/IPC handler/verifyFix/skillRun)均运行期才触发。
  // 自愈回写:把回放中重定位成功的步的稳定选择器持久化进技能(自愈=自更新,下次直接命中,无需再自愈)
  function persistHeal(recId, heals) {
    if (!recId || !heals || !heals.length) return
    try {
      const fp = path.join(recDir(), String(recId).replace(/[^\w.-]/g, '') + '.json')
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const ev = j.events || []
      let n = 0
      for (const h of heals) {
        const e = ev[h && h.ei]
        if (e && ['click', 'input', 'select', 'check', 'submit'].includes(e.act) && typeof h.sel === 'string' && h.sel) {
          e.sel = String(h.sel).slice(0, 1000)
          e.selAlt = Array.isArray(h.selAlt) ? h.selAlt.slice(0, 8).map((s) => String(s).slice(0, 1000)) : []
          n++
        }
      }
      if (n) { refreshSkillArtifacts(j); fs.writeFileSync(fp, JSON.stringify(j, null, 2)); log('skill self-heal 回写 ' + n + ' 步选择器: ' + recId) }
    } catch (e) { log('persistHeal err: ' + e.message) }
  }
  const { injectRecorder, waitNetIdle, waitForEl, highlightTarget, execStep, startCoverage, stopCoverage, checkAssertions, replayRec } = initRecorder({ S, brActive, session, log, snapshotBad, RECORDER_JS, frameFor, findElExpr, anchorExpr, coverageHits, gitChangedFiles, resolveBus, relocateSelectors, persistHeal, takeoverDigest, pageRead: skillPageRead })

  // Agent 自主浏览器会话:必须在 initRecorder 之后 —— 它复用 execStep/waitNetIdle 这两个强引擎原语,
  // 不另起一套弱实现(弱实现正是 mcp/browser-mcp.mjs 里那个无登录态无头浏览器的老问题)。
  // dev server 生命周期(仿 CC 的 preview_*):模型只能启动 launch.json 里【用户写好】的具名配置
  const preview = require('./preview')({ S, log })
  S.preview = preview
  // ── Agent 截的图直接摆进对话 ────────────────────────────────────────────────
  // 【为什么由壳层推,而不是让模型把图"说"出来】模型的回复只是纯文本 + markdown,
  // 它手里只有一个本地路径;就算吐 ![](file:///…),渲染端也不该去读模型给的任意路径(那是任意文件读)。
  // 而壳层【自己】刚把这张图写到盘上,它知道路径可信、知道当前是哪张对话卡 —— 这件事只有它做得对。
  // 缩略图【像素宽】= 显示宽的 2 倍:macOS 是 Retina,760 CSS px 实际要 1520 个物理像素。
  // ★第一版按 760 出图、又让它占满对话区(1500px 宽)—— 等于放大到 2 倍,用户一眼就说"太糊了"。
  // 两件事要分开定:出图分辨率(这里)和显示尺寸(chat.css 的 .shot-frame max-width),
  // 显示尺寸必须 ≤ 出图宽度的一半,否则一定糊。
  // 【本机有没有能读图的模型】—— 截图回执要据此说实话(2026-08-12 用户问"是不是该结合识图模型")。
  // 真机实测:这台 serve 12 个模型 input 全空、attachment 全 None,【一个都不能读图】,
  // 而 settings.modelVision 却存着一个 deepseek-v4-flash —— 一个同样不能读图的模型,纯空架子。
  // 后果是模型截完图去 read 那个 png,拿回一句「image omitted: could not be resized below the image size limit」,
  // 白烧一轮,然后改去翻数据库、翻后端源码找答案(真机就是这么走偏的)。
  // 所以不能让回执继续写"要看就读一遍"——【说不了就说不了】,并把还能用的路(read/eval/html)指出来。
  let visionCache = { at: 0, ok: false, why: '' }
  async function visionInfo() {
    if (Date.now() - visionCache.at < 5 * 60000) return visionCache
    const mv = S.settings.modelVision
    let ok = false, why = '本机没有能读图的模型'
    try {
      const bases = [...new Set([...S.sessionInfo.values()].map((si) => si && si.serve).filter(Boolean))]
      const list = bases.length ? await oc.listModels(bases[0]) : []
      const imgs = (list || []).filter((m) => m && m.image)
      if (mv && mv.modelID) {
        const hit = imgs.find((m) => m.modelID === mv.modelID && (!mv.providerID || m.providerID === mv.providerID))
        if (hit) { ok = true; why = '' }
        else why = '设置里的读图模型「' + (mv.name || mv.modelID) + '」其实不支持读图'
          + (imgs.length ? ',本机能读图的是:' + imgs.slice(0, 3).map((m) => m.providerID + '/' + m.modelID).join(' / ') : ',而本机一个能读图的模型都没有')
      } else if (imgs.length) {
        why = '还没在设置里选读图模型(本机可用:' + imgs.slice(0, 3).map((m) => m.providerID + '/' + m.modelID).join(' / ') + ')'
      }
    } catch (e) { why = '查不到模型清单(' + e.message + ')' }
    visionCache = { at: Date.now(), ok, why }
    return visionCache
  }
  S.visionInfo = visionInfo

  // ★"教会 Agent 用多模态"(2026-08-12 用户提)的正确做法不是劝主模型去读图 ——
  //   本机主模型根本不支持图片输入,劝它只会白烧一轮(真机实录:read 那个 png → image omitted)。
  //   正确做法是【壳层替它去问视觉模型,回来的是文字】:主模型拿到文字就能用,
  //   不需要它自己具备视觉能力。这条路把"看得见"和"想得清"拆成两个模型各干各的。
  async function askVision(imgPath, question) {
    const v = await visionInfo()
    if (!v.ok) return { error: '本机没有可用的读图模型(' + (v.why || '') + ')—— 去 设置 → 模型 里选一个支持图片输入的' }
    const mv = S.settings.modelVision
    let serve = null
    try { serve = await oc.ensureServe(S.settings.projectDir || '', S.handlers, log) } catch (e) { return { error: '起 serve 失败: ' + e.message } }
    let sid = ''
    try {
      sid = await oc.createSession(serve, '看图·' + String(question || '').slice(0, 20))
      if (!sid) return { error: '建会话失败' }
      const buf = fs.readFileSync(imgPath)
      const dataUrl = 'data:image/png;base64,' + buf.toString('base64')
      const q = String(question || '').trim() || '这一页现在是什么状态?有没有报错、弹窗、空数据?用简短的中文说清楚。'
      const ans = await oc.sendMessage(serve, sid, q + '\n\n(只看图回答,不要臆测图里没有的东西;看不清就说看不清)',
        { providerID: mv.providerID, modelID: mv.modelID, name: mv.name },
        [{ mime: 'image/png', url: dataUrl, filename: path.basename(imgPath) }])
      return { ok: true, answer: String(ans || '').trim(), model: mv.name || mv.modelID }
    } catch (e) { return { error: '读图失败: ' + e.message } }
    finally { if (sid) { try { await oc.deleteSession(serve, sid) } catch {} } }
  }
  S.askVision = askVision

  // 缩略图像素宽:与后台视口同宽(1440),源本来就是这个尺寸 → 不用缩放,只做一次 JPEG 编码。
  // 比原来"出 2880 再缩到 1520"省掉一次大图解码 + 一次缩放,主线程上的活少一大半。
  const SHOT_W = 1440
  const shotPaths = new Set()   // 壳层自己产出的截图路径白名单 —— 渲染端只能请求打开这里面的,不许开任意文件

  // 【收件人是谁】不能靠 agentInjectWc 猜:那条是给「发给 Agent」按钮用的(用户手动点,收件人=当前活动对话),
  // 而工具调用的收件人必须是【正在调这个工具的那张卡】。最硬的信号是回合在飞:
  // 模型能调 browser_shot,说明它这一轮还没结束 —— S.turnBusy 就是权威记录(card-send 起手入册)。
  // 只有一张卡在飞 → 就是它,没有歧义。多张都在飞才需要退让,而那时必须留痕说清"我不确定"。
  function busyChatWcs() {
    const out = []
    try {
      if (!S.turnBusy || !S.sessionInfo) return out
      for (const sid of S.turnBusy) {
        const si = S.sessionInfo.get(sid)
        if (si && si.wc && !si.wc.isDestroyed() && out.indexOf(si.wc) < 0) out.push(si.wc)
      }
    } catch { /* 静默:找不到就回落 */ }
    return out
  }
  function callerWc() {
    const busy = busyChatWcs()
    if (busy.length === 1) return busy[0]
    const live = wcById(S.activeChatWc)
    if (live) return live
    if (busy.length > 1) { log('[shot] 有 ' + busy.length + ' 张卡都在飞,认不出是哪张在调工具 —— 先推给第一张'); return busy[0] }
    // 没有回合在飞(用户手点 / 外部经 relay 调工具):退到"最近说过话的那张卡"。
    // ★这一条是自测时补的:三条线索全空时 shownToUser=false,而"图截好了没人看得见"是静默失效,
    //   最难被发现。宁可推给最近那张卡(用户一眼能认出),也不要让整件事悄悄消失。
    const last = wcById(S.lastChatWc)
    if (last) return last
    return agentInjectWc()
  }

  function showShot(info) {
    // 优先用【开这个浏览器会话时钉住的那张卡】:会话可能开了几分钟,期间别的卡也可能忙起来,
    // 那时再现算就会推错人。钉住的卡没了才回落现算。
    const pinned = (info && info.wc && !info.wc.isDestroyed()) ? info.wc : null
    const wc = pinned || callerWc()
    if (!wc) return false
    const fp = String((info && info.path) || '')
    if (!fp) return false
    let dataUrl = '', w = 0, h = 0, blankish = ''
    const t0 = Date.now()
    try {
      // ★有原始 buffer 就别再从磁盘解一遍:整页 PNG 能到 2MB,重解 + 缩放 + JPEG 编码全在主线程上,
      //   而主线程同时在跑 relay 的 HTTP —— 它卡住,MCP 那边就是一句 -32001(内网实测)。
      const img = (info && info.buf) ? nativeImage.createFromBuffer(info.buf) : nativeImage.createFromPath(fp)
      if (img.isEmpty()) throw new Error('读不出图片(可能还没写完)')
      const size = img.getSize(); w = size.width; h = size.height
      // 缩到 SHOT_W 再转 JPEG:原图 1280×800 的 PNG 常有 300KB~1.5MB,base64 还要再涨 1/3。
      // 这是给人【看一眼页面长什么样】的缩略图,原图点开就有,不必把它整个塞进 IPC。
      // 原图比 SHOT_W 还窄就【不放大】—— 放大只会更糊,还白占 IPC
      const small = w > SHOT_W ? img.resize({ width: SHOT_W, quality: 'best' }) : img
      dataUrl = 'data:image/jpeg;base64,' + small.toJPEG(88).toString('base64')
    } catch (e) { log('[shot] 缩图失败,只给路径: ' + e.message) }
    // ★窄条哨兵:后台标签如果没设视口,截出来会是 264×818 这种窄条(手机断点渲染),
    // 对排查毫无价值 —— 真机 2026-08-11 就出过一张。这类"能出图但图是废的"最容易蒙混过关,
    // 所以宁可多喊一声:宽度明显不够就留痕,别等用户看出来。
    if (w > 0 && w < 600) log('[shot] ⚠ 截图只有 ' + w + 'px 宽 —— 后台标签视口没设成功?这张图多半是手机断点布局,对排查没用')
    // ★空白图哨兵:后台标签(没挂进窗口)在某些平台/驱动上可能出全白图 —— 真机 mac 上撞到过一次。
    //   Windows 我这边验不了,所以宁可让它自己喊出来:PNG 压缩率能一眼分开 ——
    //   实测全白 2880×1800 只有 19KB(≈3.8KB/百万像素),正常 1440×900 是 213KB(≈164KB/百万像素)。
    //   低于 10KB/百万像素基本就是空白页,这时"截到了"和"截了个寂寞"必须分开说。
    try {
      const mp = (w * h) / 1e6
      const kbPerMp = mp > 0 ? (info.buf ? info.buf.length : fs.statSync(fp).size) / 1024 / mp : 0
      if (mp > 0.2 && kbPerMp < 10) {
        blankish = '这张图几乎是空白的(' + Math.round(kbPerMp) + 'KB/百万像素,正常页面在 100 以上)'
        log('[shot] ⚠ ' + blankish + ' —— 页面可能还没渲染,或后台标签在本平台截不出内容')
      }
    } catch {}
    shotPaths.add(fp)
    if (shotPaths.size > 200) { const it = shotPaths.values(); shotPaths.delete(it.next().value) }   // 粗粒度防涨
    try {
      wc.send('card-shot', { path: fp, label: String((info && info.label) || ''), url: String((info && info.url) || ''),
        full: !!(info && info.full), dataUrl, w, h })
      if (info) info.blankish = blankish   // 回执要能说出"截到的是空白"(见 agentShot)
    } catch (e) { log('[shot] 推送失败: ' + e.message); return false }
    log('[shot] 已摆进对话(缩图 ' + (Date.now() - t0) + 'ms):' + fp + ' ' + w + '×' + h + (dataUrl ? ' (缩略 ' + Math.round(dataUrl.length / 1024) + 'KB)' : ' (无缩略)'))
    return true
  }
  // 点缩略图 → 用系统看图器打开原图。★只开白名单里的路径:渲染端传什么就开什么等于开了一个任意文件打开接口
  ipcMain.handle('card-shot-open', (_e, p) => {
    const fp = String(p || '')
    if (!shotPaths.has(fp)) { log('[shot] 拒绝打开非本壳产出的路径:' + fp); return { error: '不是本次会话截的图' } }
    try { shell.openPath(fp); return { ok: true } } catch (e) { return { error: e.message } }
  })

  const brAgent = initBrowserAgent({ S, log, brActive, newTab, closeTab, activateTab, createBrowser, ensureBrowserBackground, brScreenshot, brShotTab, execStep, waitNetIdle, pageRead: skillPageRead, brSetDevice, showShot, callerWc, visionInfo, saveRec, readRec, skillList, askVision })
  // 挂 S:relay(mail.js)在本行【之前】就被 initMail 构造了,而 brAgent 是 const —— 直接传进去会踩 TDZ。
  // 本仓跨层访问的惯例本来就是挂 S(S.setCardBusy / S.dropPendingPerm 同款),relay 调用期再取,顺序天然安全。
  S.brAgent = brAgent

  // ── 浏览器要把东西"交给 Agent"时,收件人是谁 ─────────────────────────────────
  // 宿主模式(浏览器挂在主窗、作为【会话的辅助面板】)→ 当前活动对话(外壳经 shell-active-chat 上报);
  // 独立工作台(没有主窗时的回退形态)→ 它自带的那张卡。
  // ★原来三处都直接认 b.cardView(那张"调试助手"卡),而它在宿主模式下已经不存在了 ——
  //   不统一改的话,「发给 Agent」/ 技能接管通知 / 解闸询问 会全部静默失效(返回 false,没人报错)。
  function agentInjectWc() {
    const b = S.browser
    // 收件人:优先"当前活动对话"(外壳若上报了 shell-active-chat 就用它 —— 浏览器作为会话辅助面板时的语义);
    // 没有上报就回落到工作台自带的卡(现行 UI 走这条)。两条都试,不假设哪一种形态。
    const live = wcById(S.activeChatWc)
    if (live) return live
    return (b && b.cardView && !b.cardView.webContents.isDestroyed()) ? b.cardView.webContents : null
  }

  // ── 调试分诊 + 多 agent 对抗分析（工作台「发给 Agent」的大脑）──────────────────
  const tinyJson = (t) => { try { const m = String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, ' ').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null } catch { return null } }
  function dbgNote(cardWc, text, tone) { if (cardWc && !cardWc.isDestroyed()) cardWc.send('card-note', { text, tone: tone || 'info' }) }

  const DBG_LENS = {
    frontend: '作为资深前端工程师，假设根因在【前端】（状态管理 / 异步时序 / 事件绑定 / 渲染 / CSS / 打包构建）。请用工具读当前项目源码来求证或证伪这个假设，给出证据（文件:行）与判断（成立 / 不成立 / 部分成立）。',
    backend:  '作为资深后端工程师，假设根因在【后端】（接口实现 / 异常处理 / 数据 / 权限 / SQL / 配置）。请结合失败请求的状态码与响应体，用工具读源码求证或证伪，给出证据（文件:行）与判断。',
    contract: '作为接口联调专家，假设根因在【前后端契约】（参数格式 / 字段缺失 / 类型不符 / CORS / 鉴权头 / 接口版本）。请对比前端实际发出的请求与后端期望，求证或证伪，给出证据与判断。',
  }
  const DBG_TAG = { frontend: '前端', backend: '后端', contract: '接口契约' }

  // 分诊：先验来自启发式，这里让模型确认是否真的值得上多 agent（超时/失败回退启发式）
  async function dbgTriage(serve, summary, heur, model) {
    const p = `你是调试分诊器。根据复现信号，判断是否值得启动"多 agent 对抗分析"（多个 agent 各持一个假设并行查证，再交叉反驳）。\n` +
      `启发式先验：难度 ${heur.difficulty}/5，疑似层面 [${heur.layers.join(', ') || '未知'}]。\n\n复现信号摘要：\n${summary}\n\n` +
      `判断规则：跨前后端 / 根因不明确 / 多条相互矛盾线索 → multi；单一明确报错或单层小问题 → single（更快）。\n` +
      `只输出 JSON、不要调用任何工具、不要解释：{"difficulty":1-5,"layers":["frontend"|"backend"|"contract"...],"strategy":"single"|"multi","reason":"一句中文理由"}`
    try {
      const sid = await oc.createSession(serve, '分诊')
      const txt = await oc.sendMessage(serve, sid, p, model || null)   // 不限时:内网慢模型多慢都等完(曾经 45s race 把它误判成不可用,白回退启发式)
      const j = tinyJson(txt)
      if (j && (j.strategy === 'single' || j.strategy === 'multi')) {
        return { difficulty: +j.difficulty || heur.difficulty, layers: (Array.isArray(j.layers) && j.layers.length) ? j.layers : heur.layers, strategy: j.strategy, reason: j.reason || '' }
      }
    } catch (e) { log('triage fallback: ' + e.message) }
    return { ...heur, reason: '（模型分诊不可用，按启发式判断）' }
  }

  // 整个流程是后台异步（不阻塞「发给 Agent」按钮）：分诊 → 单 agent 直注 / 多 agent 并行调查 + 汇总回灌会话
  // bundleId 必须【显式传进来】:便签工具(read_notes / bundle_note)拿它当主键。
  // 原先这里没这个形参,函数体里却直接写 `bundleId || S.browser.lastBundleId` ——
  // 读一个不存在的名字是 ReferenceError(不是 undefined),`||` 兜不住,
  // 于是整个多 agent 对抗调查在拼提示词那一步就断了。见 npm run undef。
  async function runDebugFlow({ cardWc, serve, bundlePrompt, disp, heur, summary, bundleId }) {
    const inj = (text) => { if (cardWc && !cardWc.isDestroyed()) cardWc.send('card-inject', { text, disp: '' }) }
    // 子会话(分诊/lens/后端修复)跟随宿主调试卡当前所选模型;卡没选就用全局默认
    const hostSid = S.sessionByWc.get(cardWc && cardWc.id)
    const hostSi = hostSid && S.sessionInfo.get(hostSid)
    const hostModel = (hostSi && hostSi.model) || (S.modelByWc && cardWc && S.modelByWc.get(cardWc.id)) || S.settings.model || null
    try {
      dbgNote(cardWc, disp, 'user')
      // 信号简单 → 直接单 agent，省掉一次分诊调用
      if (heur.strategy === 'single' && heur.difficulty <= 2) {
        dbgNote(cardWc, `分诊：难度 ${heur.difficulty}/5 · 单 agent 直接定位`, 'info')
        inj(bundlePrompt); return
      }
      dbgNote(cardWc, '正在评估是否需要多 agent 对抗分析…', 'info')
      const v = await dbgTriage(serve, summary, heur, hostModel)
      dbgNote(cardWc, `分诊：难度 ${v.difficulty}/5 · 层面 [${(v.layers || []).map(k => DBG_TAG[k] || k).join('、') || '未定'}] · ${v.strategy === 'multi' ? '启动多 agent 对抗分析' : '单 agent 直接定位'}${v.reason ? '\n' + v.reason : ''}`, 'info')
      if (v.strategy !== 'multi') { inj(bundlePrompt); return }
      // 选 2~3 个假设角度（不足两个时补 frontend/contract 形成对抗）
      // 后端仓库：opencode 一 serve 一目录，跨前后端必须分 serve。配了就让后端调查/修复在它自己的 serve 上跑
      const backendDir = S.settings.backendDir || ''
      let backendServe = null
      // 后端仓库必须独立 serve(不能复用前端 / 用户手动起的 serve,cwd 不匹配会改错文件)
      if (backendDir) { try { backendServe = await oc.ensureServe(backendDir, S.handlers, log, { tryShare: false }) } catch (e) { dbgNote(cardWc, `后端仓库 serve 启动失败：${e.message}`, 'muted') } }
      let lenses = (v.layers || []).filter(k => DBG_LENS[k])
      for (const k of ['frontend', 'contract', 'backend']) { if (lenses.length >= 2) break; if (!lenses.includes(k)) lenses.push(k) }
      lenses = lenses.slice(0, 3)
      if (backendServe && !lenses.includes('backend')) lenses = [...lenses.slice(0, 2), 'backend']   // 配了后端仓库必查后端
      lenses.forEach(k => dbgNote(cardWc, `假设·${DBG_TAG[k]} 调查中…${k === 'backend' && backendServe ? '（后端仓库）' : ''}`, 'muted'))
      // #7 假设生成式分诊:并行起一个"开放式假设 lens",不局限于 frontend/backend/contract 三分类,
      // 让 agent 自己列 3 个最可能根因(可能是状态机/缓存/竞态/CSS 等启发式抓不到的)
      const dynamicLens = (async () => {
        let sid; try {
          sid = await oc.createSession(serve, '假设生成')
          S.sessionInfo.set(sid, { wc: cardWc, serve })
          const out = await oc.sendMessage(serve, sid, `根据下面这个复现包,**枚举 3 个最可能的根因假设**(每条 1 句话,按可能性排序),并对每条简述一句怎么验证。\n\n` +
            `不限于前端/后端/接口契约这 3 类,可以是状态机/并发竞态/缓存/CSS 布局/权限/边界条件/数据格式等任何角度。\n` +
            `**只输出假设清单,不要读代码、不要修改文件。**\n\n## 复现上下文\n` + bundlePrompt, hostModel)
          return { k: 'open_hypotheses', out, repo: '前端仓库(开放式)' }
        } catch (e) { return { k: 'open_hypotheses', out: '(假设生成失败:' + e.message + ')', repo: '前端仓库' } }
        finally { if (sid) { S.sessionInfo.delete(sid); S.streamBuf.delete(sid) } }
      })()
      dbgNote(cardWc, '同时启动开放式假设生成 lens(不局限于固定 3 分类)…', 'muted')
      const heurFindings = await Promise.all(lenses.map(async (k) => {
        const useServe = (k === 'backend' && backendServe) ? backendServe : serve
        const repo = useServe === backendServe ? '后端仓库' : '前端仓库'
        let sid
        try {
          sid = await oc.createSession(useServe, '调查:' + k)
          S.sessionInfo.set(sid, { wc: cardWc, serve: useServe })   // 只读工具自动放行；权限回本卡
          // 注入"共享便签":其它 lens 已经 confirmed/excluded 的假设,本 lens 不要重复查
          const notesHint = `\n\n# 团队共享便签(其它 agent/lens 已登记的假设状态)\n` +
            `请用 mcp 'BocomHermes-repro' 的 **read_notes{bundleId:"${bundleId || S.browser.lastBundleId || ''}"}** 工具先读现有便签 — excluded 的假设跳过,confirmed 的当前提条件用,maybe 的可作辅证。\n` +
            `你**调查结束时**(无论假设成立与否),都要用 **bundle_note{bundleId, key:"${k}_${Date.now().toString(36).slice(-4)}", status, evidence}** 把你的结论登记进去,让后续 lens 节省 token、避免重复劳动。`
          const out = await oc.sendMessage(useServe, sid, DBG_LENS[k] + `\n（你正在【${repo}】里，只能读到这个仓库的源码）\n\n## 复现上下文\n` + bundlePrompt + notesHint + '\n\n只聚焦你这个假设，简洁给出证据（文件:行）与判断，不要修改任何文件。', hostModel)
          dbgNote(cardWc, `✓ 假设·${DBG_TAG[k]} 完成`, 'muted')
          return { k, out, repo }
        } catch (e) { dbgNote(cardWc, `✗ 假设·${DBG_TAG[k]} 失败：${e.message}`, 'muted'); return { k, out: '(调查失败：' + e.message + ')', repo } }
        finally { if (sid) { S.sessionInfo.delete(sid); S.streamBuf.delete(sid) } }
      }))
      // 等启发式 + 开放式两路都跑完,合并
      const dyn = await dynamicLens
      const findings = [...heurFindings, dyn]
      dbgNote(cardWc, `✓ 开放式假设 lens 完成`, 'muted')
      const merged = findings.map(f => `### ${f.k === 'open_hypotheses' ? '开放式假设清单' : '假设·' + (DBG_TAG[f.k] || f.k)}（${f.repo}）\n${f.out}`).join('\n\n')

      // 后端修复：卡片会话在前端仓库改不到后端，所以由后端仓库 serve 上的 agent 判断并直接改后端源码（权限回本卡）
      if (backendServe) {
        dbgNote(cardWc, '后端 agent 正在判断是否需要改后端…', 'muted')
        let bsid
        try {
          bsid = await oc.createSession(backendServe, '后端修复')
          S.sessionInfo.set(bsid, { wc: cardWc, serve: backendServe })
          const bout = await oc.sendMessage(backendServe, bsid,
            `你在【后端仓库】里。下面是一个从前端复现的问题 + 多路调查结论。如果根因/修复在后端，请直接用编辑工具修改后端源码完成修复（我会逐次确认写入），改完用一两句话说明改了哪些文件、为什么；如果与后端无关，只回复"后端无需改动"。\n\n## 复现上下文\n${bundlePrompt}\n\n## 各路调查结论\n${merged}`, hostModel)
          dbgNote(cardWc, '后端 agent：' + String(bout || '').replace(/\s+/g, ' ').slice(0, 500), 'muted')
          findings.push({ k: 'backend-fix', out: bout, repo: '后端仓库' })
        } catch (e) { dbgNote(cardWc, `后端修复失败：${e.message}`, 'muted') }
        finally { if (bsid) { S.sessionInfo.delete(bsid); S.streamBuf.delete(bsid) } }
      }

      const mergedAll = findings.map(f => `### ${f.k === 'backend-fix' ? '后端修复结果' : '假设·' + (DBG_TAG[f.k] || f.k)}（${f.repo}）\n${f.out}`).join('\n\n')
      inj(`下面是对同一问题的多路并行调查${backendServe ? '（跨前后端两个仓库）+ 后端 agent 的修复结果' : ''}。请交叉验证、定出最可能的【唯一根因】。**前端改动你直接用编辑工具修改（你在前端仓库）**；${backendServe ? '后端已由后端 agent 在后端仓库处理，你据其结果说明后端结论即可，不要试图改后端文件；' : ''}改完总结根因与各端改动。\n\n## 原始复现上下文\n${bundlePrompt}\n\n## 各路调查结论\n${mergedAll}`)
    } catch (e) {
      log('runDebugFlow err: ' + e.message)
      dbgNote(cardWc, '分析流程出错：' + e.message + '（回退为单 agent）', 'info')
      inj(bundlePrompt)
    }
  }

  // ── 证据库 ─────────────────────────────────────────────────────────────
  // 大 payload(完整 DOM / 长 req body / 完整事件帧)落盘 evidence/<bundleId>/<ref>.txt,
  // 主上下文里只放短摘要 + ref 引用,Agent 用 mcp/repro-mcp 的 get_evidence 工具按需拉。
  // 128K 上下文友好;5KB 摘要不再被 9KB DOM 撑爆。
  function evidenceDir(bundleId) {
    const d = path.join(app.getPath('userData'), 'evidence', bundleId)
    try { fs.mkdirSync(d, { recursive: true }) } catch {}
    return d
  }
  function evdSave(bundleId, name, content) {
    try { fs.writeFileSync(path.join(evidenceDir(bundleId), name + '.txt'), String(content == null ? '' : content)) } catch (e) { log('evdSave err: ' + e.message) }
    return `ref#${bundleId}/${name}`
  }

  // 按动作生成紧凑时间线文本(<200 字/条),录制的 JSON 转人读
  function formatTimeline(events) {
    if (!events || !events.length) return '(本次未录制操作)'
    const lines = []
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      const t = ((e.t || 0) / 1000).toFixed(1).padStart(5)
      if (e.act === 'navigate') lines.push(`  t=${t}s  navigate    ${e.url}`)
      else if (e.act === 'click') lines.push(`  t=${t}s  click       ${e.sel}${e.text ? '  ("' + e.text.slice(0, 30) + '")' : ''}`)
      else if (e.act === 'input') lines.push(`  t=${t}s  input       ${e.sel} = "${(e.value || '').slice(0, 60)}"`)
      else if (e.act === 'key')   lines.push(`  t=${t}s  key         ${e.key} @ ${e.sel}`)
      else if (e.act === 'submit')lines.push(`  t=${t}s  submit      ${e.sel}`)
      else if (e.act === 'scroll')lines.push(`  t=${t}s  scroll      (${e.x}, ${e.y})`)
    }
    return lines.join('\n')
  }

  // 统一"异常网络快照":4xx/5xx/failed + 200 业务异常,async 因为要 fetch body
  async function snapshotBad(tab) {
    const failed = tab.net.filter((r) => r.state === 'failed' || (r.status && r.status >= 400))
    const xhr200 = tab.net.filter((r) => r.status === 200 && /xhr|fetch|XHR|Fetch/.test(r.type || ''))
    const biz = []
    for (const r of xhr200.slice(-30)) {
      if (r._biz) { biz.push(r); continue }   // 已检测过(compactRepro 跑过)
      if (r._bizChecked) continue
      r._bizChecked = true
      try { const d = await brNetBody(r.id); if (d && d.body && !d.base64) { const det = detectBizError(d.body, d.mime); if (det && det.hit) { r._biz = det; biz.push(r) } } } catch {}
    }
    return [...failed, ...biz].map((r) => ({ url: r.url, status: r.status || 0, state: r.state || '', biz: r._biz ? r._biz.hint : '' }))
  }

  // 200 业务异常检测:信贷/银行类后端常用"HTTP 200 + body 里 code != 0 / success: false"模式。
  // 不做这层探测,bundle 看不见这些"看似成功实则失败"的请求。返回 {hit, hint} 或 null。
  function detectBizError(body, mime) {
    if (!body) return null
    const s = String(body).slice(0, 4000).trim()
    // 优先 JSON 路径
    let j = null
    if (/^[{\[]/.test(s) && (!mime || /json/i.test(mime))) {
      try { j = JSON.parse(s) } catch {}
    }
    if (j && typeof j === 'object') {
      // 各家常见字段:code/respCode/retCode/errCode/status/ret
      const codeFields = ['code', 'respCode', 'retCode', 'errCode', 'errcode', 'ret', 'retcode', 'rspCode']
      for (const k of codeFields) {
        if (k in j) {
          const v = j[k]
          // 0 / '0' / '00' / '00000' / 'success' / 'SUCCESS' = 成功;其它视为异常
          const ok = v === 0 || v === '0' || /^0+$/.test(String(v)) || /^(success|ok|true)$/i.test(String(v))
          if (!ok) { return { hit: true, hint: `${k}=${JSON.stringify(v)}` + (j.message || j.msg || j.errMsg || j.errorMsg ? ' · ' + String(j.message || j.msg || j.errMsg || j.errorMsg).slice(0, 100) : '') } }
        }
      }
      // success/status: false / 'fail' / 'error'
      if (j.success === false) return { hit: true, hint: 'success=false' + (j.error || j.message || j.msg ? ' · ' + String(j.error || j.message || j.msg).slice(0, 100) : '') }
      if (typeof j.status === 'string' && /^(error|fail(ed)?|exception)$/i.test(j.status)) return { hit: true, hint: 'status=' + j.status + (j.message || j.msg ? ' · ' + String(j.message || j.msg).slice(0, 100) : '') }
      // 只有 error/exception 字段且非空
      if ((j.error && typeof j.error === 'string' && j.error) || (j.exception && j.exception)) return { hit: true, hint: 'error=' + String(j.error || j.exception).slice(0, 120) }
    }
    // 退化:body 里出现 "异常"/"错误"/"Exception"/"errMsg" 等关键字(只针对 xhr/fetch 类)
    if (/("|^)(errMsg|errorMessage|exception)("|$)/i.test(s) || /(系统异常|业务异常|失败|错误信息)/.test(s)) {
      return { hit: true, hint: '响应体含错误关键字' }
    }
    return null
  }

  // 因果链:把录制时间线的 click/submit/key 与"事后 2s 内"的网络/业务异常 + 控制台报错配对,
  // 让 agent 直接看出"哪个操作 → 触发了哪个接口出错 → 引发了哪个报错"。Agent 自己拼时间线很容易猜歪。
  function causalChains(events, recStartTs, tab) {
    if (!events || !recStartTs) return []
    const userActs = events.filter((e) => e.act === 'click' || e.act === 'submit' || e.act === 'key')
    if (!userActs.length) return []
    const chains = []
    for (const e of userActs.slice(-6)) {
      const absT = recStartTs + (e.t || 0)   // 该 user action 的墙钟时间
      // 找此后 2s 内的第一个 4xx/5xx/failed 或 200 业务异常
      const net = tab.net.find((r) => {
        if (!r.tWall) return false
        const tMs = r.tWall   // #2 墙钟(epoch ms),与 absT 同一时基;t0 是 CDP 单调时钟(秒),与墙钟不同源不能直接比
        if (tMs < absT || tMs > absT + 2000) return false
        return r.state === 'failed' || (r.status && r.status >= 400) || (r.status === 200 && r._biz && r._biz.hit)
      })
      // 找此后 4s 内的第一个 console.error(level=3)
      const err = tab.console.find((c) => {
        if (!c.ts) return false
        if (c.ts < absT || c.ts > absT + 4000) return false
        return c.level === 3
      })
      if (net || err) {
        const a = `t=${((e.t || 0) / 1000).toFixed(1)}s ${e.act} ${(e.sel || '').slice(0, 40)}${e.text ? ' "' + e.text.slice(0, 20) + '"' : ''}`
        const n = net ? ` → ${net._biz ? '200·业务异常 ' + net._biz.hint : (net.status || net.state) + ' ' + (net.method || '') + ' ' + (net.url || '')}` : ''
        const r = err ? ` → ✗ ${(err.message || '').split('\n')[0].slice(0, 100)}` : ''
        chains.push('  · ' + a + n + r)
      }
    }
    return chains
  }

  // 把"现在的现场"压成一份 <5KB 摘要 + 引用大块的 refs
  async function compactRepro(tab) {
    const bundleId = 'b_' + Date.now().toString(36)
    const wc = tab.view.webContents
    // DOM:只取摘要(title/url/前 800 字符可见文本 + body 的 outerHTML 截 1.5KB);完整 outerHTML 落盘
    let dom = { title: '', desc: '', visText: '', shortHtml: '' }, fullHtml = ''
    try {
      const r = await wc.executeJavaScript(`(()=>{
        const h=document.documentElement.outerHTML;
        const vt=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();
        const dd=document.querySelector('meta[name="description"]');
        return { title:document.title, desc: dd?dd.content:'', vis: vt.slice(0,800), shortHtml: (document.body?document.body.outerHTML:'').slice(0,1500), full: h };
      })()`, true)
      dom = { title: r.title || '', desc: r.desc || '', visText: r.vis || '', shortHtml: r.shortHtml || '' }
      fullHtml = r.full || ''
    } catch {}
    const domRef = fullHtml ? evdSave(bundleId, 'dom', fullHtml) : ''

    // 控制台:只列 warn/error,聚类后(同 stack 签名只列一次 + 计数)主文按 source-map 给"文件:行"
    const errs = tab.console.filter((c) => c.level >= 2)
    const groups = clusterErrs(errs).sort((a, b) => b.count - a.count).slice(0, 15)
    const errLines = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]; const c = g.sample; const tag = c.level === 3 ? '[E' : '[W'
      let loc = c.source ? String(c.source).split('/').pop() + (c.line ? ':' + c.line : '') : ''
      if (c.frames && c.frames.length) {
        for (const fr of c.frames.slice(0, 4)) { const r2 = await resolveFrame(fr.url, fr.line, fr.col); if (r2) { loc = r2 + (fr.fn ? ' (' + fr.fn + ')' : ''); break } }
      }
      const repeat = g.count > 1 ? `  ×${g.count}` : ''
      let line = `  ${tag}${i + 1}] ${c.message.split('\n')[0].slice(0, 220)}${repeat}  @ ${loc || '?'}`
      if (c.frames && c.frames.length > 1) {
        const stackRef = evdSave(bundleId, 'err' + (i + 1) + '-stack', JSON.stringify(c.frames, null, 2))
        line += `  · 完整堆栈 ${stackRef}`
      }
      errLines.push(line)
    }

    // 网络异常:4xx/5xx/failed + **200 但 body 里业务异常**(信贷/银行后端常用)
    const isXhrLike = (r) => /xhr|fetch|XHR|Fetch/.test(r.type || '')
    const networkBad = tab.net.filter((r) => r.state === 'failed' || (r.status && r.status >= 400))
    // 200 业务异常候选:只看 xhr/fetch,避免拉静态资源 body
    const biz200Cand = tab.net.filter((r) => r.status === 200 && isXhrLike(r))
    const biz200 = []
    for (const r of biz200Cand.slice(-20)) {
      try { const d = await brNetBody(r.id); if (d && d.body && !d.base64) { const det = detectBizError(d.body, d.mime); if (det && det.hit) { r._biz = det; r._body = d.body; biz200.push(r) } } } catch {}
    }
    // 合并 + 截 -8(最新优先)
    const bad = [...networkBad.slice(-8), ...biz200.slice(-8)].slice(-12)
    const netLines = []
    for (let i = 0; i < bad.length; i++) {
      const r = bad[i]; let body = r._body || '', isBin = false
      if (!body) { try { const d = await brNetBody(r.id); if (d) { body = String(d.body || ''); isBin = !!d.base64 } } catch {} }
      const st = r._biz ? ('200·业务异常 ' + r._biz.hint) : (r.state === 'failed' ? ('失败 ' + (r.failText || '')) : (r.status + ' ' + (r.statusText || '')))
      let line = `  [N${i + 1}] ${r.method} ${st}  ${r.url}`
      if (r.postData) {
        const pd = String(r.postData)
        if (pd.length > 200) { const ref = evdSave(bundleId, 'req' + (i + 1) + '-body', pd); line += `\n      请求体: (${pd.length}B) ref#${ref.split('/').pop()} · 摘要: ${pd.slice(0, 120)}…` }
        else { line += `\n      请求体: ${pd.slice(0, 200)}` }
      }
      if (body && !isBin) {
        if (body.length > 200) { const ref = evdSave(bundleId, 'resp' + (i + 1) + '-body', body); line += `\n      响应体: (${body.length}B) ref#${ref.split('/').pop()} · 摘要: ${body.slice(0, 120)}…` }
        else { line += `\n      响应体: ${body.slice(0, 200)}` }
      } else if (isBin) { line += `\n      响应体: (binary, 略)` }
      netLines.push(line)
    }

    // 录制时间线(当前标签最近一次)
    const rec = (S.browser.lastRec && S.browser.lastRec.tabId === tab.id) ? S.browser.lastRec
      : (S.browser.lastRec || null)   // tabId 未必存(早期 rec 没记) → 拿就用
    const tl = rec ? formatTimeline(rec.events) : '(本次未录制操作 — 想让 Agent 自动验证修复,先按"录制"复现一次)'
    // redactRec:证据包是交给 Agent 读的,不能带登录态。上面 skillRun 那条"严禁序列化内存里的 rec"的禁令(见 writeLastRun 注释)
    // 对这里同样成立,而这里以前正是直接 stringify 了 S.browser.lastRec —— 无参数技能上 applyParams 返回同一引用,
    // replayRec 又把 preState 塞进 events[i]._restorePreState → 会话 cookie 明文进证据文件。磁盘录制本体不动(回放要靠它恢复登录态)。
    const recRef = rec ? evdSave(bundleId, 'recording', JSON.stringify(redactRec(rec), null, 2)) : ''

    // 页面级捕获:fetch/XHR 全量(解决 CDP 拿不到响应体)+ alert/confirm/prompt + 错误模态/Toast
    let pageCap = { net: [], dialogs: [], errModals: [] }
    try { const raw = await wc.executeJavaScript(`JSON.stringify({n:window.__BR_CAP_NET||[],d:window.__BR_CAP_DIALOG||[],e:window.__BR_CAP_ERRMODAL||[]})`, true); const o = JSON.parse(raw || '{}'); pageCap = { net: o.n || [], dialogs: o.d || [], errModals: o.e || [] } } catch {}

    // 给 netLines 补"页面级 body fallback":CDP 拿不到 body 的请求(body 空 / "无法获取"),
    // 找页面 CAP 里同 URL 的最近一条用它的 respBody 作补
    if (pageCap.net.length) {
      const findCap = (url) => {
        for (let i = pageCap.net.length - 1; i >= 0; i--) { if (pageCap.net[i].url === url || (pageCap.net[i].url && pageCap.net[i].url.endsWith(url.split('?')[0].split('/').pop() || ''))) return pageCap.net[i] }
        return null
      }
      for (let i = 0; i < bad.length; i++) {
        const r = bad[i]
        // 如果这条 netLine 没有响应体或显示"无法获取",用 pageCap 的 respBody 顶
        const hasBody = / 响应体: /.test(netLines[i] || '')
        if (!hasBody) {
          const cap = findCap(r.url)
          if (cap && cap.respBody) {
            const bodyTxt = String(cap.respBody)
            if (bodyTxt.length > 200) { const ref = evdSave(bundleId, 'resp' + (i + 1) + '-page', bodyTxt); netLines[i] += `\n      响应体(页面捕获,CDP 拿不到时兜底): (${bodyTxt.length}B) ref#${ref.split('/').pop()} · 摘要: ${bodyTxt.slice(0, 120)}…` }
            else netLines[i] += `\n      响应体(页面捕获): ${bodyTxt.slice(0, 200)}`
          }
        }
      }
    }
    // 弹窗 + 错误模态 单独一节(信贷常用)
    const dialogLines = pageCap.dialogs.slice(-10).map((d, i) => `  [D${i + 1}] ${d.kind}: ${d.text}`).join('\n')
    const modalLines = (() => {
      // 同文本去重 + 取最近 8
      const seen = new Set(); const out = []
      for (let i = pageCap.errModals.length - 1; i >= 0 && out.length < 8; i--) {
        const e = pageCap.errModals[i]; const k = (e.text || '').slice(0, 80)
        if (seen.has(k)) continue; seen.add(k)
        out.unshift(`  [M${out.length + 1}] ${e.cls ? '.' + e.cls.split(/\s+/).slice(0, 2).join('.') + ' ' : ''}${e.text}`)
      }
      return out.join('\n')
    })()

    const exp = rec && rec.expectation ? rec.expectation : ''
    const text = `=== 复现包 ${bundleId} ===
URL: ${tab.url || '(空白页)'}
标题: ${dom.title || tab.title}
${exp ? '\n📝 用户期望(请优先围绕这个目标修): ' + exp + '\n' : '\n⚠ 用户未声明期望 — 你只能凭报错/异常推测,推测前请向用户确认目标\n'}${dom.desc ? '页面描述: ' + dom.desc + '\n' : ''}DOM 摘要(可见文本前 800 字): ${dom.visText || '(空)'}${domRef ? '\n完整 DOM: ' + domRef : ''}

时间线 (${rec ? rec.events.length : 0} 步):
${tl}${recRef ? '\n录制完整 JSON: ' + recRef : ''}${rec && rec.startedAt ? (() => {
  const chains = causalChains(rec.events, rec.startedAt, tab)
  return chains.length ? '\n\n因果链(操作→网络/业务异常→报错,2-4s 时窗自动配对,**优先看这段**):\n' + chains.join('\n') : ''
})() : ''}

控制台 warn/error (${errs.length} 条):
${errLines.length ? errLines.join('\n') : '  (无)'}

网络/业务异常 (${bad.length} 条;含 4xx/5xx/failed + **HTTP 200 但 body 业务异常**,后者内网信贷常见):
${netLines.length ? netLines.join('\n') : '  (无)'}

弹窗 / 错误模态 / Toast (页面级捕获 ${pageCap.dialogs.length + pageCap.errModals.length} 条 — 内网信贷常用模态报错+流水号):
${dialogLines || '  (无 alert/confirm/prompt)'}
${modalLines || '  (无错误样态 DOM 节点)'}

(大 payload 已落盘 userData/evidence/${bundleId}/;agent 可用 mcp 'BocomHermes-repro' 的 get_evidence 工具按需拉:传入 'ref#${bundleId}/<name>')`
    return { bundleId, text, errs, bad }
  }

  async function brAnalyze() {
    const tab = brActive(); if (!tab) return
    const { bundleId, text: bundle, errs, bad } = await compactRepro(tab)
    const planMode = S.settings.planMode !== false   // 默认 ON
    const planStep = planMode
      ? `【方案模式 — 你这次必须先出方案,等用户点"批准方案"才动手】\n` +
        `4. **不要立刻 edit**!先用编辑工具读相关源码,搞清根因;然后输出一份完整方案:\n` +
        `   - 一句话根因\n` +
        `   - 影响半径(用 scan_impact{bundleId:"${bundleId}", symbol, cwd} 扫每个要改的符号)\n` +
        `   - 计划改动清单:每条 "文件:行 — 改什么 — 为什么"\n` +
        `   - 风险提示 + 自评 risk 1~5\n` +
        `5. 等待用户回复"批准方案"(我会真发一条这样的消息)。批准前**严禁**调用任何 edit 类工具。\n` +
        `6. 批准后再 edit + 调 repro_assert / repro_self_review;改完用 mcp 'BocomHermes-repro' 的工具登记并简要总结(系统会自动展示 git diff)。\n`
      : `4. **改文件前先查影响半径(必做)**:对每个将要修改的导出符号,调 scan_impact{bundleId:"${bundleId}", symbol, cwd}\n` +
        `5. **直接用编辑工具改源码**(我会逐次确认每处写入),改完一两句话说明改了什么\n` +
        `6. **改完后必做两件**(repro-mcp 工具):① repro_assert 声明 1~4 条断言 ② repro_self_review 自评 risk + summary + edge_cases\n`
    const prompt =
      `我正在用内嵌浏览器复现一个问题，请你作为资深全栈工程师帮我定位根因并给出修复方案。\n\n` +
      bundle + '\n\n' +
      `请按以下步骤帮我修复：\n` +
      `1. 看时间线还原"用户做了什么导致问题",再结合控制台/网络/业务异常/弹窗模态定位根因(优先看 source-map 还原的"文件:行")\n` +
      `   ⚠ 内网信贷接口常**返回 200 但 body 里 code != 0** — bundle 里"200·业务异常"标的就是这类,务必当成失败处理\n` +
      `   ⚠ 流水号 / transactionId 通常在弹窗或错误模态里 — bundle 已抓"弹窗/错误模态"段,优先扫这里\n` +
      `2. 大块证据(完整 DOM / 长 req body)按需用 mcp 'BocomHermes-repro' 的 get_evidence/get_dom_subtree/get_event_window 工具拉详情;别一次性塞回回复\n` +
      `3. 用编辑工具读相关源码,确认根因所在的具体文件与行\n` +
      planStep +
      `7. 改完点"验证" — 系统:① 回放时间线 ② 检查改过 JS 是否被执行 ③ 核对断言 ④ 检查盲改 ⑤ 显示 self-review\n` +
      `   → 多维度判定 PASS / FAIL / SUSPICIOUS。FAIL 看报告调整,不要乱猜。\n` +
      `8. FAIL 且方向错了,**先用 repro_rollback{cwd, dryRun:true}** 列出会回滚的文件,确认后 dryRun:false 清掉本轮改动,从头分析。`
    S.browser.lastBundleId = bundleId   // verify 用它读 mcp 'repro_assert' 写入的断言
    log('brAnalyze: bundle ' + bundleId + ' size=' + Buffer.byteLength(bundle) + 'B')
    const disp = `已复现并发送：${tab.url || '(空白页)'}\n（${errs.length} 条控制台报错 + ${bad.length} 条网络异常 + 页面 DOM 上下文）`
    const b = S.browser
    // ★收件人:宿主模式(浏览器挂在主窗、作为会话的辅助面板)→ 注进【当前活动对话】;
    //   独立工作台那条老路仍用它自带的卡(没有主窗时的回退形态)。
    //   原来只认 b.cardWcId —— 那是"调试助手"卡,而它现在不存在了(见 createShellBrowser)。
    const targetWc = (b.shellHost ? S.activeChatWc : b.cardWcId)
    const hasTarget = b.shellHost ? (targetWc != null) : !!(b.cardView && !b.cardView.webContents.isDestroyed())
    if (hasTarget) {
      const cardSid = S.sessionByWc.get(targetWc)
      const cardSi = cardSid && S.sessionInfo.get(cardSid)
      if (cardSi && cardSi.serve) {
        // 启发式分诊先验：从捕获信号判断疑似层面 + 难度 + 是否需要多 agent
        const hasJsErr = errs.some(c => c.level === 3)
        const fe = hasJsErr || tab.net.some(r => r.status === 404 && /script|stylesheet|image|font|document/i.test(r.type || ''))
        const be = tab.net.some(r => r.state === 'failed' || (r.status >= 500))
        const ct = tab.net.some(r => [400, 401, 403, 422].includes(r.status) && /xhr|fetch/i.test(r.type || '')) || errs.some(c => /CORS|cross-origin/i.test(c.message))
        const layers = ['frontend', 'backend', 'contract'].filter((_, i) => [fe, be, ct][i])
        let difficulty = (errs.length || bad.length) ? 2 : 1
        if (bad.length) difficulty = 3
        if (layers.length >= 2) difficulty = 4
        if (fe && be) difficulty = 5
        const backendDir = S.settings.backendDir || ''
        // 配了后端仓库且有后端/契约信号 → 强制多 agent（这样后端调查/修复会在后端仓库 serve 上跑）
        const strategy = (layers.length >= 2 || difficulty >= 4 || (backendDir && (be || ct))) ? 'multi' : 'single'
        const summary = `URL：${tab.url || '(空白页)'}\n控制台错误/警告：${errs.length} 条${hasJsErr ? '（含 JS 错误）' : ''}\n网络异常：${bad.length} 条${be ? '（含 5xx/失败）' : ''}${ct ? '（含 4xx/CORS）' : ''}\n疑似层面：${layers.join('、') || '未定'}${backendDir ? '\n已配置后端仓库：可跨前后端调查/修复' : ''}`
        runDebugFlow({ cardWc: agentInjectWc(), serve: cardSi.serve, bundlePrompt: prompt, disp, heur: { layers, difficulty, strategy }, summary, bundleId })   // 后台异步，不阻塞按钮
      } else {
        b.cardView.webContents.send('card-inject', { text: prompt, disp })   // 会话还没就绪 → 退化为直接注入
      }
    } else {
      spawnCard('前端调试分析', null, prompt, disp)                          // 独立浏览器：另开一张分析卡
    }
  }

  // 闭环验证：重载复现页 → 重新采集 console/网络 → 把"修复后状态"回灌左侧 Agent 让它确认或继续修
  async function verifyFix() {
    const b = S.browser
    if (b.mode !== 'workspace' || !b.cardView || b.cardView.webContents.isDestroyed()) return
    const tab = brActive(); if (!tab) return
    const cardWc = b.cardView.webContents
    const wc = tab.view.webContents
    const rec = b.lastRec

    // 路径 A: 有录制 → 自动回放 + diff 报告(真正闭环)
    if (rec && rec.events && rec.events.length) {
      dbgNote(cardWc, '验证修复:回放录制(' + rec.events.length + ' 步)…', 'info')
      const replay = await replayRec(rec)
      if (!replay.ok) { dbgNote(cardWc, '回放失败:' + (replay.error || ''), 'info'); return }
      // 读 agent 写入的断言 / 影响半径扫描 / self-review
      const bid = rec.bundleId || S.browser.lastBundleId
      const assertions = await checkAssertions(tab, loadAssertions(bid))
      replay.assertions = assertions
      replay.scans = loadScans(bid)   // {scans:[], scannedFiles:Set}
      replay.review = loadReview(bid)  // 或 null
      const rep = diffReport(rec, replay)
      const snap = rec.snapshot || { errs: [], bad: [] }   // 导入的技能没有 snapshot
      const hitSummary = replay.hitInfo && replay.hitInfo.length ? `;改动 ${replay.hitInfo.length} 文件,${replay.hitInfo.filter((h) => h.executed > 0).length} 个被执行` : ''
      const statusKind = rep.pass ? 'pass' : (/SUSPICIOUS/.test(rep.verdict) ? 'suspicious' : 'fail')
      const disp = `验证完成 · ${rep.pass ? '✓ PASS' : (statusKind === 'suspicious' ? 'SUSPICIOUS' : '✗ FAIL')}\n(回放 ${replay.stepReport.length}/${rec.events.length} 步;修复前 ${snap.errs.length}/${snap.bad.length} → 修复后 ${replay.after.errs.length}/${replay.after.bad.length}${hitSummary})`
      // 同步推一份卡片到浏览器壳 UI,用户在右下角一眼看到结论而不用翻 agent 对话流
      if (b.win && !b.win.isDestroyed()) {
        chromeSend('wf-verify-result', {
          kind: statusKind, verdict: rep.verdict, fullText: rep.text,
          summary: `回放 ${replay.stepReport.length}/${rec.events.length} 步 · 修复前 ${snap.errs.length}报错/${snap.bad.length}异常 → 修复后 ${replay.after.errs.length}/${replay.after.bad.length}${hitSummary}`,
        })
      }
      const prompt =
        `我刚才录制了复现路径,你改完代码后我点了验证 → 系统自动回放并对比"修复前/后"的报错和网络异常。\n\n` +
        '## 回放验证报告\n' + rep.text + '\n\n' +
        (rep.pass
          ? '看起来修好了。请简要总结你这次的根因诊断 + 关键改动,并指出是否还有相关边界需要补测试用例。'
          : '回放显示问题没修好(或引入了新问题)。请认真看上面的对比,判断是修复没生效、改错了文件、还是另有根因,然后继续用编辑工具调整。')
      cardWc.send('card-inject', { text: prompt, disp })
      return
    }

    // 路径 B: 没录制 → 退回旧的"重载看现状"模式
    const url = tab.url || '(当前页)'
    dbgNote(cardWc, '验证修复:本次未录制 → 退回重载模式(下次点"录制"复现可启用自动回放)', 'info')
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; try { wc.off('did-stop-loading', onStop) } catch {} resolve() }
      const onStop = () => setTimeout(finish, 2500)
      wc.once('did-stop-loading', onStop)
      setTimeout(finish, 12000)
      try { wc.reload() } catch { finish() }
    })
    const errs = tab.console.filter((c) => c.level >= 2)
    const bad = tab.net.filter((r) => r.state === 'failed' || (r.status && r.status >= 400))
    const errText = errs.length ? errs.slice(-20).map((c) => (c.level === 3 ? '✗ ' : '! ') + c.message).join('\n') : '(无 warning / error)'
    const clean = !errs.length && !bad.length
    const disp = `已重载验证: ${url}\n(${errs.length} 报错 + ${bad.length} 网络异常)`
    const prompt =
      `我已重载页面验证你刚才的修复(注:这次没用录制,只是简单重载)。重载后的当前状态:\n\n## 控制台报错(${errs.length})\n${errText}\n\n` +
      (clean
        ? '控制台与网络都干净了。下次想要更可靠的验证,我会先点"录制"把复现路径录下来,再点验证就能自动回放出 PASS/FAIL 报告。'
        : '仍有报错。判断是修复没生效、引入了新问题、还是另有根因,然后继续修。')
    cardWc.send('card-inject', { text: prompt, disp })
  }

  // 托盘改道主窗视图(波5):与 main.js openMainView 同款 —— 拉起主窗口后 send('shell-view'),
  // 窗口新建时 webContents 尚在加载,等 did-finish-load 再发,防丢消息
  function openMainView(view) {
    const win = createMainWindow()
    if (!win) return
    const send = () => { try { if (!win.isDestroyed()) win.webContents.send('shell-view', { view }) } catch (e) { log('shell-view send err: ' + e.message) } }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }

  function trayMenuTemplate() {
    return [
      // 主窗口化(波5 收尾):orb/输入框/控制台已退役删除;凡已有主窗视图的入口一律改道主窗,
      // 未收编的独立小窗(工作台/录制回放/发件箱/待办/审计/抓包)保留
      { label: '主界面', accelerator: 'Ctrl+Shift+Space', click: () => createMainWindow() },
      { type: 'separator' },
      { label: '任务编排 · 历史对话', accelerator: 'Ctrl+Shift+B', click: () => openMainView('orch') },
      { label: '邮件（收件箱 · 摘要 · 设置）', accelerator: 'Ctrl+Shift+M', click: () => openMainView('mail') },
      { label: '设置…', click: () => openMainView('settings') },
      { type: 'separator' },
      { label: '调试工作台（Agent + 浏览器）', click: () => createWorkspace() },
      { label: '录制与回放（浏览器技能）', accelerator: 'Ctrl+Shift+R', click: () => createSkillCenter() },
      { label: '发件箱', click: openOutbox },
      { label: '待办事项', click: () => createMailCenter('todos') },
      { label: '截图提问', accelerator: 'Ctrl+Shift+S', click: () => snapAsk() },
      { label: '审计流水', click: openAudit },
      { label: 'HTTP 抓包(外部程序)', click: openHttpcap },
      { label: '打开日志', click: () => { if (S.logFile) shell.openPath(S.logFile).catch(() => {}) } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]
  }
  function refreshTrayMenu() {
    if (S.tray && !S.tray.isDestroyed()) S.tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()))
  }
  function buildTray() {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
    S.tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    S.tray.setToolTip('BocomHermes')
    refreshTrayMenu()
    S.tray.on('click', () => createMainWindow())   // 主窗口化:点托盘图标开主界面
  }

  function attachContextMenu(wc) {
    wc.on('context-menu', (_e, p) => {
      const items = []
      // 浏览器标签页内:链接 / 图片 / 通用页面动作
      const isBrowserTab = (S.browser.tabs || []).some((t) => t.view && t.view.webContents === wc)
      if (p.linkURL) {
        if (isBrowserTab) items.push({ label: '在新标签打开链接', click: () => newTab(p.linkURL) })
        items.push({ label: '复制链接地址', click: () => clipboard.writeText(p.linkURL) })
      }
      if (p.srcURL && p.mediaType === 'image') {
        items.push({ label: '复制图片地址', click: () => clipboard.writeText(p.srcURL) })
        if (isBrowserTab) items.push({ label: '在新标签打开图片', click: () => newTab(p.srcURL) })
      }
      if (p.isEditable) {
        if (items.length) items.push({ type: 'separator' })
        items.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { type: 'separator' }, { role: 'selectAll', label: '全选' })
      } else if (p.selectionText && p.selectionText.trim()) {
        if (items.length) items.push({ type: 'separator' })
        items.push({ role: 'copy', label: '复制' }, { type: 'separator' }, { role: 'selectAll', label: '全选' })
      }
      if (isBrowserTab) {
        if (items.length) items.push({ type: 'separator' })
        items.push(
          { label: '查看源代码', click: () => { try { wc.loadURL('view-source:' + wc.getURL()) } catch (e) { log('view-source err: ' + e.message) } } },
          { label: '检查元素', click: () => { try { wc.inspectElement(p.x, p.y) } catch (e) { log('inspect err: ' + e.message) } } },
        )
      }
      if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) })
    })
  }
  app.on('web-contents-created', (_e, wc) => attachContextMenu(wc))

  // ── IPC ─────────────────────────────────────────────────────────────────────
  // 双主题(浅色暖纸/深色深空):get-theme 读 settings.theme;set-theme 持久化并广播,各页 onTheme 监听照旧
  ipcMain.on('get-theme', (e) => { e.returnValue = S.settings.theme === 'dark' ? 'dark' : 'light' })
  ipcMain.on('set-theme', (_e, t) => {
    S.settings.theme = t === 'dark' ? 'dark' : 'light'
    try { saveSettings() } catch {}
    for (const wc of webContents.getAllWebContents()) { try { wc.send('theme-changed', S.settings.theme) } catch {} }
  })

  ipcMain.on('get-project', (e) => { e.returnValue = projName() })
  ipcMain.handle('pick-project', async () => {
    const r = await dialog.showOpenDialog({ title: '选择代码仓库（新卡将对它说话）', properties: ['openDirectory'] })
    if (!r.canceled && r.filePaths[0]) applyProject(r.filePaths[0])
    return projName()
  })
  // 本卡专用选目录:只改这张卡的绑定目录(S.cardDir),不动全局 projectDir、不广播 —— 每卡可对不同仓库说话
  ipcMain.handle('card-pick-project', async (e) => {
    if (!S.cardDir) S.cardDir = new Map()
    const cur = S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const r = await dialog.showOpenDialog({ title: '选择本卡对话的代码仓库(仅影响本卡)', defaultPath: cur || undefined, properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return { changed: false, dir: cur, project: cur ? path.basename(cur) : '未选目录' }
    const dir = r.filePaths[0]
    if (dir === cur) return { changed: false, dir, project: path.basename(dir) }
    S.cardDir.set(e.sender.id, dir)
    S.settings.recentDirs = [dir, ...(S.settings.recentDirs || []).filter((d) => d !== dir)].slice(0, 6); saveSettings()   // 只记最近,不动全局
    return { changed: true, dir, project: path.basename(dir) }
  })
  // 拖拽上传文档:把本地文档抽成文本(图片不走这,走 file part 给多模态)
  ipcMain.handle('parse-doc', async (_e, filePath) => {
    try { return await attachments.extractLocalFile(String(filePath || '')) } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('set-project-dir', (_e, dir) => {
    if (dir && fs.existsSync(dir)) applyProject(dir)
    else { S.settings.recentDirs = (S.settings.recentDirs || []).filter((d) => d !== dir); saveSettings() }
    return projName()
  })
  // 后端仓库（跨前后端调查/修复时，后端 agent 在它自己的 serve 上读/改后端源码）
  ipcMain.handle('pick-backend', async () => {
    const r = await dialog.showOpenDialog({ title: '选择后端代码仓库（Agent 跨前后端调查/修复时读它）', properties: ['openDirectory'] })
    if (!r.canceled && r.filePaths[0]) { S.settings.backendDir = r.filePaths[0]; saveSettings(); oc.ensureServe(r.filePaths[0], S.handlers, log, { tryShare: false }).catch((e) => log('backend prewarm failed: ' + e.message)) }
    return S.settings.backendDir || ''
  })
  ipcMain.handle('clear-backend', () => { S.settings.backendDir = ''; saveSettings(); return '' })

  ipcMain.handle('open-settings', () => openSettings())
  ipcMain.on('get-settings', (e) => {
    const im = S.settings.imap || {}
    const sm = S.settings.smtp || {}
    const ob = S.settings.ob || {}
    e.returnValue = {
      ob: { host: ob.host || '', port: ob.port || 3306, user: ob.user || '', hasPass: !!ob.passEncrypted, database: ob.database || '' },
      theme: S.settings.theme, editorCmd: S.settings.editorCmd || '', serveBin: S.settings.serveBin || '',
      serveBinEffective: process.env.BOCOMHERMES_SERVE_BIN || S.settings.serveBin || (app.isPackaged ? 'bocomcode' : 'opencode'),
      serveBinLocked: !!process.env.BOCOMHERMES_SERVE_BIN,
      proxy: S.settings.proxy || '',
      browserArgs: S.settings.browserArgs || '',
      project: projName(), projectDir: S.settings.projectDir || '', recentDirs: S.settings.recentDirs || [],
      backendDir: S.settings.backendDir || '',
      reqRepos: (S.settings.reqProfile && S.settings.reqProfile.repos) || [],
      planMode: S.settings.planMode !== false,
      knobs: mergeKnobs(S.settings.knobs),   // 阈值旋钮(治理波次):完整 9 键随设置下发,渲染端不必各自兜底
      permRules: (S.settings.permRules && typeof S.settings.permRules === 'object') ? S.settings.permRules : { allow: [], deny: [] },   // 用户权限规则(P2.3):设置页两个文本域读写
      permMode: S.settings.permMode === 'auto' ? 'auto' : 'default',   // 权限模式:default=写/执行逐次确认;auto=全部自动放行(deny 规则仍兜底,审计留痕)
      model: S.settings.model || null,   // 全局默认模型(对话坞设)
      modelMain: S.settings.modelMain || null,     // 双模型·干活主模型(会话默认;缺省回 model)
      modelVision: S.settings.modelVision || null, // 双模型·读图模型(带图消息/验证棒整卡;候选按 serve 模型元数据 image:true 过滤)
      encryptionAvailable: email.encryptionAvailable(),   // false → 密码只能明文落盘,设置面板要红字告警
      outboxHoldSeconds: S.settings.outboxHoldSeconds == null ? 15 : S.settings.outboxHoldSeconds,   // 发信延迟窗(软撤回),0=立即发
      imapIdleEnabled: S.settings.imapIdleEnabled !== false,   // IMAP IDLE 实时新邮件提醒,默认开
      imap: { host: im.host || '', port: im.port || 993, secure: im.secure !== false, allowSelf: !!im.allowSelfSigned, user: im.user || '', hasPass: !!im.passEncrypted, scheduleHour: im.scheduleHour ?? 9, sentFolder: im.sentFolder || 'Sent', archiveFolder: im.archiveFolder || 'Archive' },
      smtp: { host: sm.host || '', port: sm.port || 587, secure: !!sm.secure, allowSelf: !!sm.allowSelfSigned, sameAsImap: sm.sameAsImap !== false, user: sm.user || '', hasPass: !!sm.passEncrypted, from: sm.from || '' },
    }
  })
  ipcMain.handle('spawn-card', (_e, title) => spawnCard(title))
  // 对话坞带附件开会话:文档文本内联进 msg,图片(大 data URL)暂存,新卡 init 时取回随首条消息发
  // 任务编排执行规程:与「动态工作流」是两种东西 —— 后者=多 Agent 拆解答案未知的复杂任务;
  // 任务编排=【步骤已知】的业务链(跑技能→读文件→发邮件),要的是一个执行体按顺序办完,产出是"每步办成了"。
  // 实现=对话卡 + 静默前缀(复用 msg/disp 分离:用户气泡只见自己的描述):单 Agent 顺序执行,卡片白捡工具行/状态行可视化。
  const PIPELINE_RULES = [
    '<任务编排执行规程>',
    '你现在是「任务编排」执行器:把用户描述的业务链按顺序一步步【执行完】,不是分析问题。纪律:',
    '0. 【开工自检】先核对你的工具列表:必须有 skill_list / skill_run(浏览器技能)、doc_read(读文档)、mail_send(发邮件,若链里要发邮件)。缺任何一个 → 立即停,原话告诉用户:「任务编排工具未加载到当前引擎,请完整重启 opencode/bocomcode 引擎(serve)后重试」,不要用 bash/curl 等别的方式硬凑,也不要假装执行。',
    '1. 先把描述拆成有序步骤清单(用 todowrite 登记,做一步更新一步),然后逐步执行。',
    '2. 每步用对应工具真执行:跑浏览器技能=skill_run(导出文件的完整路径在其报告「导出/下载文件」行);读 Excel/CSV/文档=doc_read;发邮件=mail_send(经发件箱缓发,用户可撤销);不确定技能名=先 skill_list。技能的 secret 参数(密码类)【不要】向用户要值再传 —— 直接跑,回放到该步会自动暂停,由用户在页面现场输入(值不经过你);短信验证码同理(断点暂停等人)。',
    '3. 顺序依赖:上一步的产物(文件路径/数据/结论)接给下一步;某步失败就【停】,说清卡在哪、差什么,不要跳过继续、不要编造产物。',
    '4. 不扩大范围:不做描述之外的事,不派子 agent,不通读无关文件。',
    '5. 全链跑完用 3-5 行收尾:每步结果 + 产物位置(文件路径/邮件收件人)。',
    '6. 某步失败时,把该步 todo 保持 in_progress 并在汇报里写明失败原因;技能报告提示可另开编排时忽略之 —— 后续步骤已在链内,不要再开新编排卡。',
    '</任务编排执行规程>',
    '',
  ].join('\n')
  // 严格模式(固定步骤链)首条消息前缀:steps[0] 之后由 wfTurnDone 逐轮自动下发(strictSendNext),模型只管当前步
  const STRICT_PREFIX = '<任务编排·严格模式>\n本次编排按【固定步骤链】逐步下发:每轮只执行当前下发的这一步并汇报结果,不要提前做后续步骤、不要追问后续步骤,做完等下一步自动下发。若某步失败,明说「失败」及原因(会停止下发后续步骤)。\n</任务编排·严格模式>\n'
  ipcMain.handle('start-conversation', (_e, payload) => {
    const { title, msg, disp, files, mode } = payload || {}
    // 发起时选定模型(编排页模型 chip):{providerID,modelID,name} —— 随注册表走(session.js replayModel 取),主控派分片整条链继承
    const pm = payload && payload.model
    const launchModel = (pm && pm.modelID) ? { providerID: String(pm.providerID || ''), modelID: String(pm.modelID), name: String(pm.name || pm.modelID) } : null
    if (mode === 'wf' || mode === 'orch') { const r = startOrchRun(msg || title || '', { model: launchModel }); return r && r.error ? { error: r.error } : { id: r && r.cardId, runId: r && r.id } }   // 编排:代码测量级 → 出方案 → 面板批准 → 按 deps 派节点 → 每节点重规划
    if (mode === 'pipeline') {
      const body = msg || title || ''
      // 扩展:{steps, strict, files} —— strict=true 且 steps 非空进【严格模式】:开卡只发 steps[0]+严格规程前缀,
      // 后续每轮 wfTurnDone 自动下发下一步(状态存 reg.strictSteps/reg.strictIdx);files 照普通分支同款暂存(S.cardFiles)
      const steps = Array.isArray(payload && payload.steps) ? payload.steps.map((s) => String(s == null ? '' : s).trim()).filter(Boolean).slice(0, 20) : []
      const strict = !!(payload && payload.strict) && steps.length > 0
      const first = strict ? (PIPELINE_RULES + STRICT_PREFIX + '【第 1/' + steps.length + ' 步】\n' + steps[0]) : (PIPELINE_RULES + body)
      const id = spawnCard('任务编排 · ' + String(disp || body).slice(0, 18), null, first, disp || body, { flash: true, pipeline: true, model: launchModel })
      if (strict) { const reg = S.wfRegistry && S.wfRegistry.get(String(id)); if (reg) { reg.strictSteps = steps; reg.strictIdx = 1 } }
      if (Array.isArray(files) && files.length) { S.cardFiles = S.cardFiles || new Map(); S.cardFiles.set(String(id), files) }
      return { id }
    }
    const id = spawnCard(title || (msg || '').slice(0, 24) || '新对话', null, msg, disp, { flash: true })
    if (Array.isArray(files) && files.length) { S.cardFiles = S.cardFiles || new Map(); S.cardFiles.set(String(id), files) }
    return { id }
  })
  ipcMain.handle('get-card-files', (_e, id) => {
    const m = S.cardFiles; if (!m) return []
    const f = m.get(String(id)); if (f) m.delete(String(id)); return f || []
  })
  ipcMain.handle('spawn-workflow', (_e, goal) => spawnWorkflow(goal))
  // 主控卡进度条点分片 → 把那张大隐藏分片卡拉到台前细看(看完可手动关,会话不受影响)
  ipcMain.handle('shard-focus', (_e, id) => {
    const reg = S.wfRegistry && S.wfRegistry.get(String(id)); if (!reg) return false
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === reg.wcId)
    if (!win) return false
    try { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true } catch { return false }
  })
  // 工作流模板(对话坞模板入口;常量清单,goalPrefix 预置到目标前,引导主 Agent 按对应形状干活)
  const WF_TEMPLATES = [
    { id: 'explore-doc', name: '探索成文', hint: '大规模探索后蒸馏成文档', goalPrefix: '【探索成文】系统性地探索以下主题，fan-out 子代理分头摸底，最后蒸馏成结构化文档落盘：' },
    { id: 'review', name: '评审', hint: '多视角对抗评审', goalPrefix: '【评审】对以下对象做多视角(正确性/性能/安全/可维护性)对抗评审，输出按严重度分级的问题清单：' },
    { id: 'troubleshoot', name: '排查', hint: '定位问题根因', goalPrefix: '【排查】定位以下问题的根因：先收集证据(日志/代码/复现路径)，形成假设逐一验证，给出根因与修复建议：' },
  ]
  ipcMain.handle('wf-templates', () => WF_TEMPLATES)
  // ── 任务编排模板(F1):内置常量 + 用户模板(userData/pipeline-templates.json)合并;vars 从 goal 的 {{xxx}} 占位提取 ──
  const PIPELINE_TEMPLATES = [
    { id: 'export-check-mail', name: '导出→核对→邮件汇报', goal: '读取 {{导出文件}},逐行核对 {{核对要点}} 是否缺失或异常,汇总成 3-5 行核对结论,然后用 mail_send 发邮件给 {{收件人}},标题写「{{报表名}}核对汇报」,正文附结论。' },
    { id: 'export-anomaly-todo', name: '导出→异常行→加待办', goal: '读取 {{导出文件}},筛出符合 {{异常条件}} 的行,逐条加进待办(标题带行号和关键字段),最后汇报一共加了几条待办、异常集中在哪。' },
    { id: 'doc-digest-knowledge', name: '读文档→要点→写知识库', goal: '用 doc_read 读 {{文档路径}},提炼 3-7 条三个月后大概率仍成立的要点,用 memory_add 逐条写进项目知识库(每条一句话 + scene 写复用场景),最后列出写入了哪几条。' },
  ]
  const pipeTplFile = () => path.join(app.getPath('userData'), 'pipeline-templates.json')
  const pipeTplLoad = () => { try { const a = JSON.parse(fs.readFileSync(pipeTplFile(), 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
  const pipeTplVars = (goal) => { const out = new Set(); const re = /\{\{\s*([^{}]+?)\s*\}\}/g; let m; while ((m = re.exec(String(goal || '')))) out.add(m[1]); return [...out] }
  ipcMain.handle('pipeline-tpl-list', () => [
    ...PIPELINE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, goal: t.goal, builtin: true, vars: pipeTplVars(t.goal) })),
    ...pipeTplLoad().map((t) => ({ id: String(t.id || ''), name: String(t.name || ''), goal: String(t.goal || ''), builtin: false, vars: pipeTplVars(t.goal) })),
  ])
  ipcMain.handle('pipeline-tpl-save', (_e, it) => {
    const name = String((it && it.name) || '').trim().slice(0, 40), goal = String((it && it.goal) || '').trim().slice(0, 2000)
    if (!name || !goal) return { ok: false, err: '模板名称与目标都不能为空' }
    const list = pipeTplLoad(); list.push({ id: 'u' + Date.now().toString(36), name, goal })
    try { fs.writeFileSync(pipeTplFile(), JSON.stringify(list, null, 2)); return { ok: true } } catch (e) { return { ok: false, err: e.message } }
  })
  ipcMain.handle('pipeline-tpl-delete', (_e, id) => {
    const sid = String(id == null ? '' : id)
    if (PIPELINE_TEMPLATES.some((t) => t.id === sid)) return { ok: false, err: '内置模板不能删除' }
    const list = pipeTplLoad(), next = list.filter((t) => String(t.id) !== sid)
    if (next.length === list.length) return { ok: false, err: '没有找到这条模板' }
    try { fs.writeFileSync(pipeTplFile(), JSON.stringify(next, null, 2)); return { ok: true } } catch (e) { return { ok: false, err: e.message } }
  })
  // ── 定时任务编排:userData/pipeline-schedules.json;主进程 60s 轮询,到点(HH:MM 命中且今天没跑过)以 pipeline 模式开卡 ──
  // flash:false 不抢焦点;跑完走 wfTurnDone 的「任务编排完成」通知。lastRun 是内存标记 —— 重启后同一分钟内可能补跑一次,可接受。
  const pipeSchedFile = () => path.join(app.getPath('userData'), 'pipeline-schedules.json')
  const pipeSchedLoad = () => { try { const a = JSON.parse(fs.readFileSync(pipeSchedFile(), 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
  ipcMain.handle('pipeline-sched-list', () => pipeSchedLoad().map((s) => ({ id: String(s.id || ''), goal: String(s.goal || ''), time: String(s.time || '') })))
  ipcMain.handle('pipeline-sched-save', (_e, it) => {
    const goal = String((it && it.goal) || '').trim().slice(0, 2000), time = String((it && it.time) || '').trim()
    if (!goal) return { ok: false, err: '编排目标不能为空' }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, err: '时间格式要 HH:MM(24 小时制)' }
    const list = pipeSchedLoad(); list.push({ id: 's' + Date.now().toString(36), goal, time })
    try { fs.writeFileSync(pipeSchedFile(), JSON.stringify(list, null, 2)); return { ok: true } } catch (e) { return { ok: false, err: e.message } }
  })
  ipcMain.handle('pipeline-sched-delete', (_e, id) => {
    const list = pipeSchedLoad(), next = list.filter((s) => String(s.id) !== String(id == null ? '' : id))
    if (next.length === list.length) return { ok: false, err: '没有找到这条定时' }
    try { fs.writeFileSync(pipeSchedFile(), JSON.stringify(next, null, 2)); return { ok: true } } catch (e) { return { ok: false, err: e.message } }
  })
  const pipeSchedLastRun = new Map()   // id → 'YYYY-MM-DD'(今天已跑)
  setInterval(() => {
    try {
      const now = new Date()
      const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
      const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
      for (const sc of pipeSchedLoad()) {
        if (!sc || sc.time !== hm || !sc.goal) continue
        if (pipeSchedLastRun.get(sc.id) === today) continue
        pipeSchedLastRun.set(sc.id, today)
        log('pipeline schedule fired: ' + sc.id + ' ' + sc.time + ' — ' + String(sc.goal).slice(0, 60))
        try { spawnCard('定时编排 · ' + String(sc.goal).slice(0, 18), null, PIPELINE_RULES + sc.goal, sc.goal, { flash: false, pipeline: true }) } catch (e) { log('pipeline schedule spawn err: ' + e.message) }
      }
    } catch {}
  }, 60000).unref()
  // 编排重试(卡坞):找到注册表项的活会话,格式化消息直发(oc.sendMessage);卡已关/会话不在 → {ok:false, err}
  ipcMain.handle('pipeline-retry', async (_e, id) => {
    try {
      const reg = S.wfRegistry ? S.wfRegistry.get(String(id == null ? '' : id)) : null
      if (!reg) return { ok: false, err: '没有找到这条编排记录' }
      const sid = S.sessionByWc.get(reg.wcId), si = sid && S.sessionInfo.get(sid)
      if (!sid || !si || !si.serve) return { ok: false, err: '卡片已关或会话不在,无法续聊(可新开一张编排卡)' }
      const todos = Array.isArray(reg.todos) ? reg.todos : []
      const idx = todos.findIndex((x) => !/complet|cancel/i.test(String(x && x.status || '')))   // 第一个未完步 = 断点步
      const stepText = idx >= 0 ? String((todos[idx] && (todos[idx].content || todos[idx].text || todos[idx].title)) || '') : ''
      const msg = '上次在第 ' + (idx >= 0 ? idx + 1 : '?') + ' 步〈' + (stepText || '未登记步骤') + '〉失败/中断:' + String(reg.final || '').slice(0, 200) + '。请从该步重试并继续后续步骤。'
      const model = si.model || (S.modelByWc && S.modelByWc.get(reg.wcId)) || S.settings.model || null
      await oc.sendMessage(si.serve, sid, msg, model)
      if (reg.status === 'interrupted') reg.status = 'running'   // 续上了 → 摘中断标(严格模式失败标一并清,防停发状态卡死)
      reg.strictFailed = false
      return { ok: true }
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })
  // ── 项目知识库治理 IPC(纯逻辑在 src/knowledge.js;此处负责文件 IO/落盘/审计)────────────────
  // 防腐依赖注入工厂(与 session.js 同款):锚点相对路径一律围栏在项目目录内;读不了/非 git 对应检查自动跳过。
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
      churnOf: (rel, since) => {   // git log --numstat 累计增删行数;非 git 仓库/无 git → null(跳过 C4)
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
  const knowledgeChurnMaxKnob = () => {   // C4 阈值旋钮(与 session.js 注入侧同口径)
    const v = +(S.settings.knobs && S.settings.knobs.knowledgeChurnMax)
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 300
  }
  // 条目清单:文件不存在=空库(ok:true 空表,治理界面照常打开)
  ipcMain.handle('knowledge-list', (_e, dir) => {
    const d = String(dir || '').trim()
    const file = knowledge.fileFor(d, app.getPath('userData'))
    let raw = ''
    try { raw = fs.readFileSync(file, 'utf8') } catch {}
    const entries = knowledge.listEntries(raw)
    return { ok: true, file, entries, stats: { total: entries.length } }
  })
  // 健康度:真实 deps 跑 C1-C4;C3 行漂移重定位出新内容 → 先回写知识库文件再响应
  ipcMain.handle('knowledge-audit', (_e, dir) => {
    const d = String(dir || '').trim()
    if (!d) return { ok: false, err: '缺少 dir(项目目录)' }
    try {
      const file = knowledge.fileFor(d, app.getPath('userData'))
      let raw = ''
      try { raw = fs.readFileSync(file, 'utf8') } catch {}
      const audit = knowledge.auditEntries(raw, knowledgeDeps(d), { dir: d, churnMaxLines: knowledgeChurnMaxKnob() })
      if (audit.content && audit.content !== raw) {
        try { fs.writeFileSync(file, audit.content); log('knowledge-audit: relocated anchors, rewrote ' + path.basename(file)) } catch {}
      }
      return { ok: true, entries: audit.entries, stats: audit.stats }
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })
  // 编辑条目(index 定位;patch={text?,anchors?,scene?,confidence?})→ 写盘 + 审计留痕
  ipcMain.handle('knowledge-edit', (_e, dir, index, patch) => {
    const d = String(dir || '').trim()
    try {
      const file = knowledge.fileFor(d, app.getPath('userData'))
      const raw = fs.readFileSync(file, 'utf8')
      const next = knowledge.editEntry(raw, index, patch || {})
      if (next !== raw) fs.writeFileSync(file, next)
      try { S.audit && S.audit('knowledge', '编辑知识条目', { dir: path.basename(d), index: +index || 0 }) } catch {}
      return { ok: true }
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })
  // 删除条目(indexes 批量;空日期节自动清理)→ 写盘 + 审计留痕
  ipcMain.handle('knowledge-delete', (_e, dir, indexes) => {
    const d = String(dir || '').trim()
    const list = Array.isArray(indexes) ? indexes : []
    try {
      const file = knowledge.fileFor(d, app.getPath('userData'))
      const raw = fs.readFileSync(file, 'utf8')
      const next = knowledge.deleteEntries(raw, list)
      if (next !== raw) fs.writeFileSync(file, next)
      try { S.audit && S.audit('knowledge', '删除知识条目', { dir: path.basename(d), count: list.length }) } catch {}
      return { ok: true }
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })
  // ── 卡坞工作流面板:现行(内存注册表)+ 历史(磁盘存档)合并出清单;点一条聚焦活卡或打开存档 ──
  ipcMain.handle('wf-list', () => {
    const out = []
    const regs = S.wfRegistry ? [...S.wfRegistry.values()] : []
    const orchTagById = new Map()   // 主控 id → orchTag(统计它名下分片数用)
    try { if (S.orchByTag) for (const [tag, o] of S.orchByTag) orchTagById.set(String(o && o.id), tag) } catch {}
    for (const r of regs) {
      if (r.parentOrch) continue   // 分片卡是主控的内部机器,不列进面板 —— 面板只展示主控/独立工作流/编排(用户:最近使用只看主控)
      const todos = Array.isArray(r.todos) ? r.todos : []
      const doneN = todos.filter((x) => /complet|cancel/i.test(String(x && x.status || ''))).length
      const cur = todos.find((x) => /progress|doing/i.test(String(x && x.status || '')))   // 进行中步(in_progress)→ 卡坞"当前在干哪步"
      const tag = orchTagById.get(String(r.id))
      const shardN = tag ? regs.filter((x) => x.parentOrch === tag).length : 0   // 主控条目带分片数(面板好认"这是一次多层派发")
      out.push({
        id: r.id, goal: r.goal, status: r.status, kind: r.kind || 'workflow', rounds: r.rounds, elapsedMs: r.elapsedMs,
        files: (r.files || []).length, fileList: (r.files || []).slice(0, 50), at: r.at, archive: r.archive || '', shards: shardN || undefined, sid: r.sid || '',
        diff: r.diff || null,   // session.diff 权威账本:增删行/文件数(编码模式的改动证据)
        runId: r.runId || '',   // 编排面板卡:卡坞/编排页据此改口径(名字叫"编排",不给"去批准"横幅)
        planApproved: (r.kind === 'orch' && !r.runId) ? (r.planApproved !== false) : undefined,
        live: !!(S.wfCardByWc && S.wfCardByWc.has(r.wcId)), busy: !!(S.isCardBusy && S.isCardBusy(r.wcId)),
        todoDone: doneN, todoTotal: todos.length, current: cur ? String((cur && (cur.content || cur.text || cur.title)) || '') : '',
        todos: todos.map((t) => ({ text: String((t && (t.content || t.text || t.title)) || ''), status: String((t && t.status) || '') })).slice(0, 30),
        actions: (Array.isArray(r.actions) ? r.actions : []).map((a) => ({ kind: a.kind, label: a.label, detail: a.detail })),
      })
    }
    const seen = new Set(regs.map((r) => r.archive).filter(Boolean))
    try {   // 磁盘存档补进来(注册表只 50 条且重启即空):goal 只读文件头 2KB,别为个列表把整份存档读进来
      const dirW = path.join(app.getPath('userData'), 'workflows')
      const arcs = fs.readdirSync(dirW).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}_\d+_.+\.md$/.test(f))
        .map((f) => { const p = path.join(dirW, f); let m = 0; try { m = fs.statSync(p).mtimeMs } catch {}; return { f, p, m } })
        .sort((a, b) => b.m - a.m).slice(0, 40)
      for (const a of arcs) {
        if (seen.has(a.p)) continue
        let goal = '', kind = 'workflow', sid = '', runIdA = ''
        try {
          const fd = fs.openSync(a.p, 'r'); const buf = Buffer.alloc(2048)
          const n = fs.readSync(fd, buf, 0, 2048, 0); fs.closeSync(fd)
          const head = buf.toString('utf8', 0, n)
          goal = ((head.match(/^# (?:工作流|任务编排|编排):(.*)$/m) || [])[1] || '').trim()
          if (/^# 任务编排:/m.test(head)) kind = 'pipeline'
          sid = ((head.match(/· 会话:(\S+)/) || [])[1] || '')   // 存档头带会话 id → 关卡后重开完整会话(wf-open),不只甩 md
          // ★存档头也要带 runId(2026-08-10):注册表【重启即空】,重启之后卡坞里的历史条目全从这里解析 ——
          //   而它原来只捞 goal/kind/会话id,于是编排卡一旦跨过重启就再也认不出自己是编排,
          //   wf-open 只能按普通卡重开(没有节点表、没有留痕、没有续跑)。用户说的"历史会话没法续接工作流"就是这一格。
          //   老存档没有这一段 → runId 为空 → 照旧回落普通卡(wf-open 那边会打一行日志说明)。
          runIdA = ((head.match(/· run:(\S+)/) || [])[1] || '')
          if (sid === '-') sid = ''
        } catch {}
        out.push({ id: a.f.split('_')[1], goal: goal || a.f, status: 'archived', kind: runIdA ? 'orch' : kind, rounds: 0, elapsedMs: 0, files: 0, at: a.m, archive: a.p, sid, runId: runIdA, live: false, busy: false, todoDone: 0, todoTotal: 0, current: '', actions: [] })
      }
    } catch {}
    const rank = { running: 0, interrupted: 1, done: 2, archived: 3 }   // 进行中置顶,被掐断的次之(要人管),其余按时间倒序
    out.sort((a, b) => (rank[a.status] != null ? rank[a.status] : 3) - (rank[b.status] != null ? rank[b.status] : 3) || (b.at || 0) - (a.at || 0))
    // 响应改对象信封 { items, queued }:数组挂自定义属性过不了 IPC 结构化克隆,queued 只能在对象字段上带。
    // queued = 并发闸外排队等待的工作流(position 从 1 起,字段名与 dock 前端约定一致)
    return {
      items: out.slice(0, 60),
      queued: (S.wfQueue || []).map((q, i) => ({ goal: q.goal, position: i + 1, at: q.at })),
    }
  })
  ipcMain.on('wf-plan-approved', (e) => { const reg = S.wfCardByWc && S.wfCardByWc.get(e.sender.id); if (reg) reg.planApproved = true })   // 规划闸壳层状态位:批准动作(按钮/倒计时/分片自动)都经 approvePlan 上报,relay /orch/run 据此拦截主控未批派发

  // ── 编排面板 IPC(新引擎)────────────────────────────────────────────────────────
  // 批准在这里是一次【显式状态转移】,不再是"渲染端从 LLM 工具流里嗅出 todowrite 然后驱动主进程硬闸"那条推断链
  // (那条链的失效方式是静默的:嗅不到就永远没有按钮,而派发闸只认它)。唯一副本在主进程,渲染端只读投影。
  function runOfSender(e, runId) {
    if (!S.orch) return null
    if (runId) return S.orch.get(String(runId))
    const reg = S.wfCardByWc && S.wfCardByWc.get(e.sender.id)
    return reg && reg.runId ? S.orch.get(reg.runId) : null
  }
  ipcMain.handle('run-snapshot', (e, a) => { const r = runOfSender(e, a && a.runId); return r ? S.orch.snapshot(r.id) : null })
  ipcMain.handle('run-approve', (e, a) => { const r = runOfSender(e, a && a.runId); if (r) S.orch.approve(r.id, a && a.edits); return { ok: !!r } })
  ipcMain.handle('run-reject', (e, a) => { const r = runOfSender(e, a && a.runId); if (r) S.orch.reject(r.id, a && a.note); return { ok: !!r } })
  ipcMain.handle('run-note', (e, a) => { const r = runOfSender(e, a && a.runId); if (r) S.orch.note(r.id, a && a.text); return { ok: !!r } })
  ipcMain.handle('run-abort', (e, a) => { const r = runOfSender(e, a && a.runId); if (r) S.orch.abort(r.id); return { ok: !!r } })
  ipcMain.handle('run-retry-node', (e, a) => { const r = runOfSender(e, a && a.runId); if (r) S.orch.retryNode(r.id, a && a.nodeId); return { ok: !!r } })
  ipcMain.handle('run-resume', (e, a) => { const r = runOfSender(e, a && a.runId); if (r) S.orch.resume(r.id); return { ok: !!r } })
  ipcMain.handle('run-list', () => (S.orch ? S.orch.list().map((r) => S.orch.snapshot(r.id)) : []))

  // 分片弹窗查看:分片是隐藏卡(无人值守),点主控卡分片面板的 ⧉ 把它的真实窗口亮出来直接看 ——
  // 镜像视图(shard view)在渲染端重载后镜像缓冲是空的,弹窗是纯黑盒场景的兜底可见通道
  ipcMain.handle('shard-pop', (_e, id) => {
    try {
      const reg = S.wfRegistry && S.wfRegistry.get(String(id))
      if (!reg) return { ok: false, err: '分片记录不存在(可能已收官/重启后注册表清空)' }
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === reg.wcId)
      if (!win) return { ok: false, err: '分片窗口已关闭' }
      if (win.isMinimized()) win.restore()
      win.show(); win.focus()
      return { ok: true }
    } catch (e) { return { ok: false, err: e.message } }
  })

  ipcMain.handle('wf-open', (_e, it) => {
    try {
      const r = (S.wfRegistry ? [...S.wfRegistry.values()] : []).find((x) => String(x.id) === String(it && it.id))
      if (r && r.wcId != null && S.wfCardByWc && S.wfCardByWc.has(r.wcId)) {   // 卡还活着 → 聚焦
        // 内嵌卡(主窗口 webview guest):聚焦主窗口 + shell-spawn {sid} 让侧栏激活该会话;
        // 独立卡(波3 钉出/分片弹窗)照旧聚焦真窗口(getAllWindows 找得到)
        if (S.embedWc && S.embedWc.has(r.wcId) && S.mainWin && !S.mainWin.isDestroyed()) {
          try { if (S.mainWin.isMinimized()) S.mainWin.restore(); S.mainWin.show(); S.mainWin.focus() } catch {}
          const p = { sid: String(r.sid || '') }
          const send = () => { try { if (S.mainWin && !S.mainWin.isDestroyed()) S.mainWin.webContents.send('shell-spawn', p) } catch {} }
          if (S.mainWin.webContents.isLoading()) S.mainWin.webContents.once('did-finish-load', send); else send()
          return { ok: true, kind: 'focus' }
        }
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === r.wcId)
        if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return { ok: true, kind: 'focus' } }
      }
      const sid = String((it && it.sid) || (r && r.sid) || '')
      if (sid) {   // 卡已关但有会话 → 重开【完整会话】(serve 还在就续接;没了回本地转录回放,只读可看)—— 不再只甩一个 md。
        // 有意以【普通卡】重开(不带 wf/orch query):重开=回看全程+继续聊,不复活规划闸/看门狗/交棒。
        // 代价:续跑的长工作流失去 55% 主动交棒安全网 —— 可接受(续跑已是人工接管);要原样复活 wf 特性需重建注册表项,复杂度不值。
        const goal = String((r && r.goal) || (it && it.goal) || '工作流')
        // ★★编排面板卡是【例外】(2026-08-10 用户实测:"历史会话没法续接工作流")。
        // 上面那个取舍对普通工作流卡成立(重开=接着聊),对编排面板卡完全不成立:
        // 它"有会话但永不发消息",当普通卡重开等于什么都没有 —— 没有节点表、没有留痕、没有续跑按钮,
        // 而 runOfSender 靠 reg.runId 反查,普通卡没有这个字段,run-* 那一排 IPC 全部落空。
        // 所以编排卡按原身份重开(orch + run id),并把存档【按需读回内存】:
        // restore() 只在启动时读非终态的,已经 done/cancelled 的和启动后才归档的都够不到。
        const runId = String((r && r.runId) || (it && it.runId) || '')
        if (runId && S.orch) {
          const back = S.orch.load(runId)
          if (back) {
            const cid = spawnCard('编排 · ' + goal.slice(0, 20), sid, null, goal,
              { flash: true, wf: true, orch: true, run: runId })
            try {
              const reg2 = S.wfRegistry && S.wfRegistry.get(String(cid))
              if (reg2) { reg2.runId = runId; reg2.kind = 'orch' }   // 反查要靠它:没有 runId 就等于普通卡
            } catch { /* 注册表没建上也不该拦住重开 */ }
            try { back.panelCardId = String(cid); back.panelWcId = (S.cardWcById && S.cardWcById.get(String(cid))) != null ? S.cardWcById.get(String(cid)) : null } catch (e) { log('[orch] 回填面板 wcId 失败(只影响实时推送,面板仍可按 runId 拉快照):' + e.message) }
            log('[orch] 从历史重开编排卡 ' + runId + '(phase=' + back.phase + ')')
            return { ok: true, kind: 'orch' }
          }
          log('[orch] 历史里这条编排的存档已不在(可能被 GC),退回普通卡重开:' + runId)
        }
        spawnCard('工作流 · ' + goal.slice(0, 20), sid)
        return { ok: true, kind: 'session' }
      }
      const ap = String((it && it.archive) || (r && r.archive) || '')        // 没有会话可重开(老存档没带 sid)→ 才退到打开存档 md
      if (ap && fs.existsSync(ap)) { shell.openPath(ap); return { ok: true, kind: 'archive' } }
      return { ok: false, err: '卡片已关且没有存档' }
    } catch (e) { return { ok: false, err: e.message } }
  })
  // 删除工作流记录:卡还开着的一律拒(关卡时注册表会重写 + 重新存档,删了也会复活 —— 必须先关卡);
  // 卡已关 → 摘注册表 + 删存档文件(注册表没有的纯历史存档同此)。id 只跟文件名比对,不拼路径,防注入。
  // 当前项目目录的 git 分支(状态栏 ⎇;非 git 仓/拿不到 → '')
  ipcMain.handle('git-branch', () => {
    const dir = S.settings.projectDir || ''
    if (!dir) return { branch: '' }
    try {
      const b = require('child_process').execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      return { branch: b === 'HEAD' ? '(detached)' : b }
    } catch { return { branch: '' } }
  })
  // 全部停止(用户要的"全局中断"):中止所有 running 工作流的回合 + 清空排队位;状态标 interrupted 留痕
  ipcMain.handle('wf-stop-all', () => {
    let stopped = 0, queued = 0
    if (S.wfQueue && S.wfQueue.length) { queued = S.wfQueue.length; S.wfQueue.length = 0 }
    for (const reg of (S.wfRegistry ? [...S.wfRegistry.values()] : [])) {
      if (reg.status !== 'running') continue
      // 编排交给引擎自己停:它的计时器键是 runId:nodeId,不在 shardSettleTimers 里,下面那套对它一条都不生效 ——
      // 不通知的话用户点了【全部停止】,45s 后节点照常落定、零产出、重派,编排接着跑(实测口径)
      if (reg.runId && S.orch) { try { S.orch.abort(reg.runId); stopped++ } catch (e) { log('[orch] stop-all 路由失败:' + e.message) } ; continue }
      try {
        const sid = reg.wcId != null ? S.sessionByWc.get(reg.wcId) : (reg.sid || '')
        const si = sid && S.sessionInfo.get(sid)
        if (si) { try { oc.abort(si.serve, sid) } catch {} ; stopped++ }
        reg.status = 'interrupted'; reg.aborted = true
        // 竞态修复:挂着的 45s settle 计时必须清掉(不清 = 到点把刚写的 interrupted 按旧 verdict 覆写回 done);
        // 分片还要唤醒主控 + 刷进度面板(直写状态不唤醒 = 主控死等这片,面板也看不到终态)
        clearTimeout(shardSettleTimers.get(reg.wcId)); shardSettleTimers.delete(reg.wcId)
        try { S.wfArchive(reg) } catch {}
        if (reg.parentOrch) {
            try { pushShardProgress(reg.parentOrch) } catch {}
        }
      } catch {}
    }
    log('wf stop-all: aborted ' + stopped + ' running, cleared queue ' + queued)
    try { S.audit && S.audit('workflow', '全部停止', { stopped, queued }) } catch {}
    return { stopped, queued }
  })
  // 取消排队:并发位满时排在 S.wfQueue 里的工作流(还没开卡,没有注册表 id)—— 按 goal 精确匹配摘除(设计稿 S5:排队行内 ✕)
  ipcMain.handle('wf-cancel-queued', (_e, goal) => {
    const g = String(goal == null ? '' : goal)
    if (!g || !S.wfQueue) return { ok: false, err: '缺少 goal' }
    const i = S.wfQueue.findIndex((q) => String(q.goal || '') === g)
    if (i < 0) return { ok: false, err: '这条已不在队列(可能已开跑或已取消)' }
    S.wfQueue.splice(i, 1)
    log('workflow queued item canceled: ' + g.slice(0, 60))
    try { S.audit && S.audit('workflow', '取消排队工作流', { goal: g.slice(0, 120) }) } catch {}
    return { ok: true }
  })
  ipcMain.handle('wf-delete', (_e, id) => {
    try {
      const sid = String(id == null ? '' : id).trim()
      if (!sid) return { ok: false, err: '缺少 id' }
      const reg = S.wfRegistry ? S.wfRegistry.get(sid) : null
      if (reg && reg.wcId != null && S.wfCardByWc && S.wfCardByWc.has(reg.wcId))
        return { ok: false, err: '这张工作流卡还开着 —— 先关卡,再删记录' }
      if (reg) S.wfRegistry.delete(sid)
      let removed = false
      const kill = (p) => { try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); removed = true } } catch {} }
      if (reg && reg.archive) kill(reg.archive)
      if (!reg) {   // 纯历史存档:按文件名里的 id 找到再删
        try {
          const dirW = path.join(app.getPath('userData'), 'workflows')
          const hit = fs.readdirSync(dirW).find((f) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}_\d+_.+\.md$/.test(f) && f.split('_')[1] === sid)
          if (hit) kill(path.join(dirW, hit))
        } catch {}
      }
      if (!reg && !removed) return { ok: false, err: '没有找到这条记录(可能已删过)' }
      try { S.audit && S.audit('workflow', '删除工作流记录', { id: sid }) } catch {}
      try { wfDequeue() } catch {}   // 删记录后复查一次排队(出队触发点③;无空位时自动空转)
      return { ok: true }
    } catch (e) { return { ok: false, err: e.message } }
  })
  // 任务编排引擎体检:配置文件写了 ≠ serve 带上了(外部 serve 早于注册启动 = 静默没工具)。
  // 问 serve 实际加载的 /config;端点不认识时 known:false,前端只提示不吓人。
  ipcMain.handle('orch-tools-status', async () => {
    try {
      const serve = await oc.ensureServe(S.settings.projectDir || '', S.handlers, log)
      const chk = await oc.checkMcp(serve)
      return { ...chk, external: !!serve.external, regChanged: !!S.mcpRegChangedAt }
    } catch (e) { return { known: false, error: e.message } }
  })

  // ── 任务完成通知 ────────────────────────────────────────────────────────────
  const busyCards = new Set()   // 忙碌卡的 webContents id。写入唯一经 applyBusy:主进程回合态(session.js 回合起手/落定回调)+ legacy card-busy IPC
  const busyEndAt = new Map()   // wcId → 最近一次转闲的时间戳(由 applyBusy 打点,不再依赖已死的 card-busy IPC):出队补位给 3s 宽限 —— 分片轮间空窗(过规划闸/交棒)瞬间"闲"是假象,曾被机制性超发(4 并发跑出 8 张活卡,加剧内网 429)
  // 回合 busy 改主进程推导(实锤:busyCards 唯一来源是渲染端 card-busy IPC,默认 Vue 卡从不上报 →
  // wfConcurrency 并发闸形同虚设、看门狗门槛永不真、'忙着别杀'守卫失效):wcId → sid → 在回合中。
  // 权威记录 = session.js 的 turnBusy(sid 键 Set,经 S.turnBusy 挂载);挂载未就绪时回退 sessionInfo 字段形态,
  // 再兜底 wf 卡自维护的 wfTurnBusy(wfTurnStart 加 / wfTurnDone·wfTurnError 摘,见分片落定计时器段);
  // card-busy IPC 保留作补充不删(legacy 卡仍上报)。
  function turnBusyByWc(wcId) {
    const sid = S.sessionByWc.get(wcId)
    if (sid) {
      const tb = S.turnBusy
      if (tb && typeof tb.has === 'function' && tb.has(sid)) return true
      const si = S.sessionInfo.get(sid)
      if (si && (si.busy === true || si.turnBusy === true)) return true
    }
    return wfTurnBusy.has(wcId)
  }
  S.isCardBusy = (wcId) => turnBusyByWc(wcId) || busyCards.has(wcId)   // 暴露给 relay:/orch/result 据此区分"干活中"与"空闲(等批准/等插话)"
  S.isCardBusyLately = (wcId) => S.isCardBusy(wcId) || (Date.now() - (busyEndAt.get(wcId) || 0) < 3000)
  function updateTrayBusy() {
    if (!S.tray || S.tray.isDestroyed()) return
    const n = busyCards.size
    S.tray.setToolTip(n > 0 ? `BocomHermes · ${n} 个任务运行中` : 'BocomHermes')
  }
  // ── 忙闲的唯一写者 ────────────────────────────────────────────────────────
  // 这里挂着一整串副作用:3s 宽限打点、出队补位、任务栏闪烁、托盘计数、侧栏忙闲广播。
  // ★它们原来【全部】只长在 ipcMain.on('card-busy') 里,而 card-busy 的唯一发送方是 preload 的 reportBusy,
  //   reportBusy 只被 legacy 的 ui/card.html 和 ui/mailcenter.html 调用 —— ui-vue 整棵树零调用,
  //   而默认 cardImpl 就是 vue。于是对今天真正在跑的那些卡,上面五样【一起是死的】:
  //     · busyEndAt 恒空 → isCardBusyLately 退化成 isCardBusy,注释里"防机制性超发(4 并发跑出 8 张活卡)"成死代码
  //     · wfDequeue 的出队触发点② 失效 → 轮末释放了并发位却没人补位,排队分片要等某张卡真收官才动
  //     · 侧栏 c.busy 恒 false → shell/store.ts 的「运行中关卡要二次确认」闸形同虚设:
  //       正在生成的会话点侧栏 × 直接走全清理链 abort 掉,零确认(这条最要命)
  //     · 托盘计数与任务栏闪烁同哑
  //   修法不是把五个消费端逐个改去读 S.isCardBusy(要改四处,还会漏掉未读点),而是让主进程推导轨
  //   喂进同一个集合 —— 收敛成这一个写者,legacy IPC 与主进程回合态共用它。
  function applyBusy(wcId, busy) {
    if (wcId == null) return
    const wasBusy = busyCards.has(wcId)
    if (busy) busyCards.add(wcId)
    else {
      busyCards.delete(wcId)
      busyEndAt.set(wcId, Date.now())   // 先打点再补位:此刻本卡仍按 3s 宽限计占位,不会把自己的轮间空窗当成空位
      try { wfDequeue() } catch {}      // 卡一空闲(回合结束/被中止)就尝试补位
      // 隐藏分片工人卡不闪任务栏:没人在看它,闪了只是噪音
      if (wasBusy && !(S.shardWc && S.shardWc.has(wcId))) {
        const win = (S.embedWc && S.embedWc.has(wcId))
          ? S.mainWin
          : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents && w.webContents.id === wcId)
        if (win && !win.isDestroyed() && !win.isFocused()) {
          win.flashFrame(true)
          win.once('focus', () => win.flashFrame(false))
        }
      }
    }
    updateTrayBusy()   // 复位也走它(原来 size===0 时在处理器里另写了个 else 分支,最后一张卡转闲时 tooltip 不复位)
    // 波2:忙闲转发主窗口侧栏(按 wcId 找会话条目改状态点/转圈);内嵌 guest 卡的 sender 即 guest wcId
    try { if (S.mainWin && !S.mainWin.isDestroyed()) S.mainWin.webContents.send('shell-sess-status', { wcId, busy: !!busy }) } catch {}
  }
  S.setCardBusy = applyBusy   // session.js 在回合起手/真正落定时回调 —— Vue 卡不发 card-busy,这是它唯一的入口
  ipcMain.on('card-busy', (e, busy) => applyBusy(e.sender.id, !!busy))   // legacy 卡(card.html/mailcenter)仍走 IPC,与上面合一条路
  // 卡片关闭时清掉它的"忙"记录 —— 否则正在生成的卡被关，wcId 永留 busyCards,托盘提示会一直"运行中"
  function forgetBusy(wcId) {
    wfTurnBusy.delete(wcId)   // 主进程推导轨同步摘除(关卡即闲)
    if (!busyCards.delete(wcId)) return
    if (busyCards.size === 0) {
      if (S.tray && !S.tray.isDestroyed()) S.tray.setToolTip('BocomHermes')
    } else updateTrayBusy()
  }

  // ── 主窗口会话视图(波2)─────────────────────────────────────────────────────────
  // 内嵌会话卡登记:shell 在 webview dom-ready 后回报 {cardId, wcId};发卡收口时 wf 注册表项的 wcId 只能
  // 先挂 null,在此补齐(顺带建 wfCardByWc 映射);reg.sid 也顺手回填(card-init 可能早于本绑定跑完)
  ipcMain.handle('session-bind', (_e, arg) => {
    const a = arg || {}; if (a.wcId == null) return { ok: false }
    S.embedWc = S.embedWc || new Set(); S.embedWc.add(a.wcId)
    const reg = a.cardId != null && a.cardId !== '' && S.wfRegistry ? S.wfRegistry.get(String(a.cardId)) : null
    if (reg) {
      reg.wcId = a.wcId
      S.wfCardByWc = S.wfCardByWc || new Map(); S.wfCardByWc.set(a.wcId, reg)
      const sid0 = S.sessionByWc.get(a.wcId); if (sid0 && !reg.sid) reg.sid = sid0
      // 发起时选定的模型(reg.model):card-init 可能早于本绑定跑完(replayModel 那时还查不到注册表),在绑定点补进
      // sessionInfo + 历史;modelByWc 已有值 = 用户在卡内手选过,不盖
      if (reg.model && (!S.modelByWc || S.modelByWc.get(a.wcId) === undefined)) {
        const si0 = sid0 && S.sessionInfo && S.sessionInfo.get(sid0)
        if (si0 && !si0.model) si0.model = reg.model
        if (sid0) { const h0 = S.history.find((x) => x.id === sid0); if (h0 && !h0.model) { h0.model = reg.model; try { touchHistory(sid0) } catch {} } }
      }
    }
    return { ok: true }
  })
  // 活动会话清单(侧栏「会话」区):分片是内部工人不进列表;title 取历史/wf 注册表,拿不到给 null;
  // embed 标记该会话是否内嵌在主窗口(shell 启动时据此收养重载前还活着的会话)
  ipcMain.handle('session-list', () => {
    const out = []
    for (const [wcId, sid] of S.sessionByWc) {
      if (S.shardWc && S.shardWc.has(wcId)) continue
      const h = S.history.find((x) => x.id === sid)
      const reg = S.wfCardByWc && S.wfCardByWc.get(wcId)
      out.push({ sid, wcId, title: (h && h.title) || (reg && reg.goal) || null, dir: (h && h.dir) || '', busy: !!(S.isCardBusy && S.isCardBusy(wcId)), wf: reg ? reg.kind : '', embed: !!(S.embedWc && S.embedWc.has(wcId)), pinned: !!(S.pinnedWc && S.pinnedWc.has(wcId)) })
    }
    return out
  })
  // 关闭内嵌会话:与独立卡 closed 同一条清理链(幂等 —— shell 的 × 与 webview destroyed 兜底会同发,重复调用安全)
  ipcMain.handle('session-close', (_e, arg) => {
    const a = arg || {}; if (a.wcId == null) return { ok: false }
    try { cleanupCardContext(S, a.wcId, null) } catch (e) { log('session-close err: ' + e.message) }
    return { ok: true }
  })
  // 编排并发真值(波4 主窗口状态栏):只读聚合 —— running 与并发闸同一份 wfRunningCount()
  // (只占动态工作流,pipeline/orch 不占位,15s 启动宽限);max = knobs.wfConcurrency(缺失/非正回退 4)
  ipcMain.handle('wf-running-count', () => ({ running: wfRunningCount(), max: wfConcurrency() }))

  // ── 钉出(波3):侧栏会话钉出为独立迷你卡(独立真窗口盯梢单个会话)—— 全产品唯一保留的悬浮窗 ──────────
  // 流程:① 找 sid 当前 sessionInfo.wc(内嵌 guest;兜底扫 sessionByWc)② detach 语义摘死 wc 登记
  // (不动会话/serve/工作流注册表)③ spawnCard 真窗口重接(card-init 按 sid 天然接管:回放+流式续推;
  // wf 注册表挂键由 session.js trackWcSession 按 sid 认领)④ 登记 S.pinnedWc → resolve 后 shell 移除该
  // webview 与侧栏条目(绝不走 sessionClose,会话必须活着)。收回 = 钉出窗 closed 分流(见 spawnCard)。
  // 幂等:sid 已钉出 → 聚焦已有窗;sid 无活动会话 → 报错。x/y 缺省 → spawnCard 居中主屏。
  ipcMain.handle('session-pin-out', (_e, arg) => {
    try {
      const a = arg || {}; const sid = String(a.sid || '')
      if (!sid) return { ok: false, err: 'missing sid' }
      // 幂等:已在钉出窗 → 聚焦已有窗,不重复开
      for (const pid of (S.pinnedWc || [])) {
        if (S.sessionByWc.get(pid) !== sid) continue
        const w0 = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === pid)
        if (w0) { try { if (w0.isMinimized()) w0.restore(); w0.show(); w0.focus() } catch {} ; return { ok: true, wcId: pid, already: true } }
      }
      // ① 找 sid 当前绑的 wc(sessionInfo 权威且需活着;兜底扫 sessionByWc —— 收养条目的 wc 已死,走兜底)
      let oldWcId = null
      const si = S.sessionInfo.get(sid)
      if (si && si.wc && !si.wc.isDestroyed()) oldWcId = si.wc.id
      if (oldWcId == null) { for (const [w, s2] of S.sessionByWc) { if (s2 === sid) { oldWcId = w; break } } }
      if (oldWcId == null) return { ok: false, err: '会话无活动卡片(可能已关闭)' }
      if (S.shardWc && S.shardWc.has(oldWcId)) return { ok: false, err: '分片工人会话不可钉出' }
      // 已在独立真窗口(非内嵌):不重复开,聚焦即"钉出";不登记 pinnedWc —— 它的 closed 走正常清理链,收回语义不适用
      if (!(S.embedWc && S.embedWc.has(oldWcId))) {
        const w1 = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === oldWcId)
        if (w1) { try { if (w1.isMinimized()) w1.restore(); w1.show(); w1.focus() } catch {} ; return { ok: true, wcId: oldWcId, already: true } }
        // 顶层窗找不到的死 wc(收养/残留登记):照常走 detach + 重开,顺带清掉残留
      }
      const h = S.history.find((x) => x.id === sid)
      const reg = S.wfCardByWc && S.wfCardByWc.get(oldWcId)
      const title = (h && h.title) || (reg && reg.goal) || '对话'
      // ② detach 清死 wc 登记(降级版清理链:不 abort / 不 retire serve / 工作流注册表不收官)
      cleanupCardContext(S, oldWcId, null, { detach: true })
      // ③ 真窗口重接(card.html 非 embedded,窗控齐全;card-init 按 sid 接管流式)
      const id = spawnCard(title, sid, null, null, { window: true, x: a.x, y: a.y })
      const wcId = S.cardWcById && S.cardWcById.get(String(id))
      if (wcId == null) return { ok: false, err: '钉出窗创建失败' }
      // ④ 登记钉出窗(closed 分流判据)
      S.pinnedWc = S.pinnedWc || new Set(); S.pinnedWc.add(wcId)
      log('session pinned out: sid ' + sid.slice(0, 18) + ' → wc ' + wcId)
      return { ok: true, wcId }
    } catch (e) { return { ok: false, err: e.message } }
  })

  ipcMain.on('close-self', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('hide-self', (e) => BrowserWindow.fromWebContents(e.sender)?.hide())
  ipcMain.on('minimize-self', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  // JS 拖动支撑：抓取时读一次窗口 bounds，移动时写回「锁定尺寸 + 新坐标」——尺寸恒定，绝不缩放
  ipcMain.on('get-self-bounds', (e) => { const w = BrowserWindow.fromWebContents(e.sender); e.returnValue = (w && !w.isDestroyed()) ? w.getBounds() : null })
  ipcMain.on('set-self-bounds', (e, b) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isDestroyed() || !b) return
    let x = Math.round(b.x), y = Math.round(b.y), width = Math.round(b.width), height = Math.round(b.height)
    // 无边框窗自绘边缘缩放(carddrag.js):下钳各窗自己的 minWidth/minHeight;拖左/上缘缩放被钳时要连带修位置(对侧边不动)
    const [mw, mh] = w.getMinimumSize()
    if (mw && width < mw) { if (b.edges && String(b.edges).indexOf('l') >= 0) x += width - mw; width = mw }
    if (mh && height < mh) { if (b.edges && String(b.edges).indexOf('t') >= 0) y += height - mh; height = mh }
    w.setBounds({ x, y, width, height })
  })
  ipcMain.handle('toggle-pin', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    const v = !w.isAlwaysOnTop(); w.setAlwaysOnTop(v); return v
  })
  ipcMain.handle('toggle-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false
    if (w._restoreBounds || w.isMaximized()) {
      const b = w._restoreBounds; w._restoreBounds = null
      if (w.isMaximized()) w.unmaximize()
      if (b) w.setBounds(b)
      return false
    }
    w._restoreBounds = w.getBounds()
    const wa = screen.getDisplayMatching(w.getBounds()).workArea
    w.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height }); return true
  })

  ipcMain.handle('read-clipboard', () => clipboard.readText())

  // ── 邮件 IPC ─────────────────────────────────────────────────────────────
  ipcMain.handle('trigger-email-summary', async () => {
    // 不再 throw —— 否则主进程日志刷 "Error occurred in handler",前端也拿不到原因。
    // 一律返回结构化结果,让待办面板就地给反馈(未配置 → 引导去设置;无新邮件 → 提示)
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) {
      return { ok: false, reason: 'unconfigured', message: 'IMAP 未配置,请先在设置里填写收件邮箱' }
    }
    try {
      const count = await spawnEmailCard()
      return { ok: true, count }
    } catch (e) {
      const msg = (e && e.message) || '未知错误'
      const benign = /没有邮件|已整理过|未配置/.test(msg)
      return { ok: false, reason: benign ? 'empty' : 'error', message: msg }
    }
  })
  ipcMain.handle('email-test', async () => {
    const imap = S.settings.imap
    if (!imap || !imap.host || !imap.user || !imap.passEncrypted) throw new Error('IMAP 未配置')
    const r = await email.fetchUnread(imap, { limit: 5 })
    return { count: r.totalMatched, sample: r.emails.slice(0, 2).map(e => ({ from: e.from, subject: e.subject })) }
  })
  // ── 发件箱(发信安全闸门)IPC ─────────────────────────────────────────────
  ipcMain.handle('open-outbox', () => openOutbox())
  ipcMain.handle('outbox-list', () => S.outbox.list())
  ipcMain.handle('outbox-cancel', (_e, id) => S.outbox.cancel(id))
  ipcMain.handle('outbox-send-now', (_e, id) => S.outbox.sendNow(id))

  // ── MCP 一键注册 ────────────────────────────────────────────────────────────
  // 把自带 8 个本地 MCP server 写进 opencode/bocomcode 配置,整块搬进 ./mcp-config 的 initMcpConfig(ctx)。
  // 启动即确保已注册:缺失/路径过期自动补写(带备份)——否则 Agent 静默没有任何天枢工具(技能解析/自愈/接管全空转)。
  const mcpCfg = initMcpConfig({ app, path, fs, ipcMain, log })
  initIntranetOptimize({ app, path, fs, ipcMain, log, getPermRules: () => S.settings.permRules, getServeBases: () => [...new Set([...S.sessionInfo.values()].map((si) => si && si.serve && si.serve.base).filter(Boolean))], getModelVision: () => S.settings.modelVision })
  const agentMd = initAgentMd({ app, path, fs, ipcMain, log })
  setTimeout(() => {
    try {
      const r = mcpCfg.autoRegisterIfMissing()
      if (r && r.ok && !r.already) { S.mcpRegChangedAt = Date.now(); log('MCP 自动注册完成 → ' + r.path + '(若已有外部 serve 在跑,需重启 serve 才带上工具)') }
      // ★把两份账对上(2026-08-12 内网反复报 MCP not connected 的根因):
      //   serve 只在【它自己启动时】读一次 opencode.jsonc,而这份配置是壳层启动后才补写/纠正的。
      //   只要 serve 比壳层老(手动 bocomcode serve / 上一轮残留),它手里就是旧的:
      //   旧路径 → spawn ENOENT;没有条目 → 工具根本不存在。两种都表现为 not connected,
      //   而且【整个 serve 生命周期都不会自愈】—— 用户只看到"工具时好时坏",完全查不出所以然。
      //   这段就是把"磁盘上写的"和"serve 手里的"当场比一遍,不一致就【明说】+ 给唯一有效的动作。
      setTimeout(() => { mcpLiveCheck().catch(() => {}) }, 4000)
      // 卡死判定的阈值可调(内网端点慢就调大):knobs.dropWatchSec,缺省 90 秒。
      // 判据本身是"停滞满一个阈值",所以调大 = 更宽容,不会把真卡死漏掉,只是发现得晚一点。
      try {
        const sec = +(((S.settings || {}).knobs || {}).dropWatchSec)
        if (Number.isFinite(sec) && sec >= 10) { oc.setDropWatchMs(sec * 1000); log('[knob] 回合卡死判定阈值 = ' + sec + 's') }
      } catch {}
    } catch (e) { log('MCP 自动注册异常: ' + e.message) }
  }, 800)

  // serve 手里的 MCP 配置 vs 磁盘上的:不一致就是 not connected 的来源,必须当场说出来
  async function mcpLiveCheck() {
    let serve = null
    try { serve = await oc.ensureServe(S.settings.projectDir || '', S.handlers, log) } catch { return }
    if (!serve) return
    const chk = await oc.checkMcp(serve)
    if (!chk || !chk.known) { log('[mcp-check] 这台 serve 不认 /config 端点,跳过'); return }
    const base = (typeof mcpCfg.baseDir === 'function' ? mcpCfg.baseDir() : '') || ''
    const names = arrOf(chk.names)
    const stale = names.filter((k) => base && !String(chk.commands[k] || '').includes(base))
    if (!names.length) {
      const why = 'serve 手里【一个 BocomHermes-* 工具都没有】—— 它在配置写好之前就启动了。'
        + '这一轮里所有内嵌浏览器/邮件/编排工具都会报 not connected,而且不会自愈。'
        + '唯一有效的动作:重启 serve(退出 bocomcode serve 再起,或让本程序自己拉一个)。'
      log('[mcp-check] ★' + why)
      try { new Notification({ title: 'BocomHermes · MCP 工具没挂上', body: why.slice(0, 160) }).show() } catch {}
      S.mcpMismatch = why
      return
    }
    if (stale.length) {
      const why = 'serve 手里的 MCP 路径是旧的(' + String(chk.commands[stale[0]] || '').slice(0, 120) + '),'
        + '当前程序在 ' + base + '。它启动时读的是旧配置,spawn 会 ENOENT —— 表现就是 not connected。'
        + '唯一有效的动作:重启 serve。'
      log('[mcp-check] ★' + why)
      try { new Notification({ title: 'BocomHermes · MCP 路径过期', body: why.slice(0, 160) }).show() } catch {}
      S.mcpMismatch = why
      return
    }
    S.mcpMismatch = ''
    log('[mcp-check] serve 手里的 MCP 与当前程序一致(' + names.length + ' 个:' + names.join(' ') + ')')
  }
  const arrOf = (x) => (Array.isArray(x) ? x : [])

  // ── LSP 一键注册(内网无外网:opencode 内置 server 探测不到会联网安装必失败,代码智能靠随包自带) ──
  // 三个 node 系 server(TS/Vue/Pyright)用 Electron 内嵌 Node 跑,首启自动写 opencode.jsonc 的 lsp 段(缺失/路径过期才写)。
  const lspCfg = initLspConfig({ app, path, fs, log, isEnabled: () => S.settings.lspEnabled !== false })
  setTimeout(() => {
    try {
      const r = lspCfg.autoRegisterIfMissing()
      if (r && r.ok && !r.already && !r.skipped) log('LSP 自动注册完成 → ' + r.path + '(若已有外部 serve 在跑,需重启 serve 才生效)')
    } catch (e) { log('LSP 自动注册异常: ' + e.message) }
    try { initPluginInstall({ app, path, fs, log }).autoInstall() } catch (e) { log('read-spill 自动安装异常: ' + e.message) }
    try { if (S.settings.projectDir) agentMd.autoEnsure(S.settings.projectDir) } catch (e) { log('agent-md auto-ensure err: ' + e.message) }   // 启动也对当前项目兜底一次(换项目时已即时做过)
  }, 900)

  // ── Settings: IMAP 字段读写 ───────────────────────────────────────────────
  ipcMain.handle('set-settings', (_e, patch) => {
    // 存密码前先看能不能加密:不能 → 日志告警一次(设置面板另有红字提示),让用户知道密码明文落盘
    if (patch && ((patch.imap && patch.imap.pass && patch.imap.pass.trim()) || (patch.smtp && patch.smtp.pass && patch.smtp.pass.trim())) && !email.encryptionAvailable()) {
      log('安全告警:当前环境 safeStorage 不可用,邮箱密码将以明文保存到 settings.json')
    }
    if (patch && typeof patch.backendDir === 'string') S.settings.backendDir = patch.backendDir.trim()
    if (patch && typeof patch.editorCmd === 'string') S.settings.editorCmd = patch.editorCmd.trim()
    if (patch && typeof patch.serveBin === 'string') {
      S.settings.serveBin = patch.serveBin.trim()
      if (!process.env.BOCOMHERMES_SERVE_BIN && S.settings.serveBin) oc.setServeBin(S.settings.serveBin)
    }
    if (patch && typeof patch.proxy === 'string') {
      S.settings.proxy = patch.proxy.trim()
      // 即刻应用,无需重启;空字符串 = 走直连(不走代理)
      const rules = S.settings.proxy || ''
      session.defaultSession.setProxy(rules ? { proxyRules: rules } : { mode: 'direct' })
        .then(() => log('proxy updated: ' + (rules || '(direct)')))
        .catch((e) => log('setProxy err: ' + e.message))
    }
    if (patch && typeof patch.browserArgs === 'string') S.settings.browserArgs = patch.browserArgs.trim()
    // Agent 自主浏览器会话的围栏白名单。★这里必须自己再规范化+校验一遍,不能信 UI 传来的形状:
    //   这是条安全边界,而设置面板只是它的一个调用方(以后还会有别的,比如导入配置/命令行/内网下发)。
    //   一律削成 protocol//host —— 围栏比的就是这个;削不出来的直接丢弃,不入白名单(宁可不放行,不可放错)。
    if (patch && patch.browserAgent && typeof patch.browserAgent === 'object') {
      const cur = S.settings.browserAgent || {}
      const ba = { enabled: cur.enabled !== false, origins: Array.isArray(cur.origins) ? cur.origins : [] }
      if (typeof patch.browserAgent.enabled === 'boolean') ba.enabled = patch.browserAgent.enabled
      if (Array.isArray(patch.browserAgent.origins)) {
        const out = []
        for (const x of patch.browserAgent.origins) {
          try {
            const u = new URL(/^https?:\/\//i.test(String(x)) ? String(x) : 'https://' + String(x))
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
            const o = u.protocol + '//' + u.host
            if (!out.includes(o)) out.push(o)
          } catch { /* 丢弃:填不出 origin 的一律不放行 */ }
        }
        ba.origins = out.slice(0, 50)
      }
      if (patch.browserAgent.minutes !== undefined) ba.minutes = Math.max(1, Math.min(parseInt(patch.browserAgent.minutes) || 10, 30))
      S.settings.browserAgent = ba
      log('[browser-agent] 围栏更新: ' + (ba.enabled ? '开' : '关') + ',白名单 ' + ba.origins.length + ' 个' + (ba.origins.length ? ' — ' + ba.origins.join(', ') : ''))
    }
    if (patch && typeof patch.planMode === 'boolean') S.settings.planMode = patch.planMode
    if (patch && patch.outboxHoldSeconds !== undefined) S.settings.outboxHoldSeconds = Math.max(0, Math.min(parseInt(patch.outboxHoldSeconds) || 0, 3600))
    // 阈值旋钮:只收白名单 9 键,数值化(非数值忽略,防脏值进 settings.json)
    if (patch && patch.knobs && typeof patch.knobs === 'object') {
      S.settings.knobs = mergeKnobs(S.settings.knobs)
      for (const k of Object.keys(DEFAULT_KNOBS)) {
        const v = patch.knobs[k]
        if (v === undefined) continue
        const n = Number(v)
        if (Number.isFinite(n)) S.settings.knobs[k] = n
      }
    }
    // 用户权限规则(P2.3 壳层轨):{allow:[],deny:[]} 字符串数组;逐条取字符串截 200 字,各上限 100 条(防脏值)
    if (patch && patch.permRules && typeof patch.permRules === 'object') {
      const clean = (a) => (Array.isArray(a) ? a.map((x) => String(x).slice(0, 200).trim()).filter(Boolean).slice(0, 100) : [])
      S.settings.permRules = { allow: clean(patch.permRules.allow), deny: clean(patch.permRules.deny) }
    }
    // 权限模式(P2.4):'default'|'auto',非法值一律回 default(auto=写/执行全部自动放行,deny 规则仍兜底)
    if (patch && patch.permMode !== undefined) S.settings.permMode = patch.permMode === 'auto' ? 'auto' : 'default'
    // 双模型(M1):modelMain/modelVision,形状同 model({providerID,modelID,name} 或 null)
    if (patch && 'modelMain' in patch) S.settings.modelMain = (patch.modelMain && patch.modelMain.modelID) ? { providerID: patch.modelMain.providerID, modelID: patch.modelMain.modelID, name: patch.modelMain.name } : null
    if (patch && 'modelVision' in patch) S.settings.modelVision = (patch.modelVision && patch.modelVision.modelID) ? { providerID: patch.modelVision.providerID, modelID: patch.modelVision.modelID, name: patch.modelVision.name } : null
    // 轻活模型:只给编排的 verify/check 节点用(核实一条证据 / 跑一条命令,一两个回合就完)。
    // 留空 = 全走主模型,行为与加这个字段之前完全一致 —— 没配第二个模型的人不受任何影响。
    if (patch && 'model' in patch) S.settings.model = (patch.model && patch.model.modelID) ? { providerID: patch.model.providerID, modelID: patch.model.modelID, name: patch.model.name } : null   // 全局默认模型(对话坞设;卡片可覆盖)
    if (patch && patch.imap) {
      S.settings.imap = S.settings.imap || {}
      const im = patch.imap
      if (im.host      !== undefined) S.settings.imap.host          = String(im.host).trim()
      if (im.port      !== undefined) S.settings.imap.port          = parseInt(im.port) || 993
      if (im.secure    !== undefined) S.settings.imap.secure        = !!im.secure
      if (im.allowSelf !== undefined) S.settings.imap.allowSelfSigned = !!im.allowSelf
      if (im.user      !== undefined) S.settings.imap.user          = String(im.user).trim()
      if (im.pass && im.pass.trim()) S.settings.imap.passEncrypted  = email.encryptPass(im.pass.trim())
      if (im.scheduleHour !== undefined) S.settings.imap.scheduleHour = parseInt(im.scheduleHour) || 9
      if (im.sentFolder !== undefined) S.settings.imap.sentFolder    = String(im.sentFolder).trim() || 'Sent'
      if (im.archiveFolder !== undefined) S.settings.imap.archiveFolder = String(im.archiveFolder).trim() || 'Archive'
    }
    if (patch && patch.smtp) {
      S.settings.smtp = S.settings.smtp || {}
      const sm = patch.smtp
      if (sm.host       !== undefined) S.settings.smtp.host           = String(sm.host).trim()
      if (sm.port       !== undefined) S.settings.smtp.port           = parseInt(sm.port) || 587
      if (sm.secure     !== undefined) S.settings.smtp.secure         = !!sm.secure
      if (sm.allowSelf  !== undefined) S.settings.smtp.allowSelfSigned = !!sm.allowSelf
      if (sm.sameAsImap !== undefined) S.settings.smtp.sameAsImap     = !!sm.sameAsImap
      if (sm.user       !== undefined) S.settings.smtp.user           = String(sm.user).trim()
      if (sm.pass && sm.pass.trim())   S.settings.smtp.passEncrypted  = email.encryptPass(sm.pass.trim())
      if (sm.from       !== undefined) S.settings.smtp.from           = String(sm.from).trim()
    }
    if (patch && patch.imapIdleEnabled !== undefined) S.settings.imapIdleEnabled = !!patch.imapIdleEnabled
    if (patch && patch.reqProfile && Array.isArray(patch.reqProfile.repos)) {
      S.settings.reqProfile = S.settings.reqProfile || {}
      // repo 支持 { path, system, aliases[] }（新）与纯路径字符串（旧）；按 path 去重，无系统名则退回纯字符串保持兼容
      const seen = new Set(), out = []
      for (const r of patch.reqProfile.repos) {
        const rp = String((typeof r === 'string' ? r : (r && r.path)) || '').trim()
        if (!rp || seen.has(rp)) continue
        seen.add(rp)
        const system = (r && typeof r === 'object' && r.system) ? String(r.system).trim() : ''
        const aliases = (r && typeof r === 'object' && Array.isArray(r.aliases)) ? r.aliases.map((a) => String(a).trim()).filter(Boolean) : []
        out.push((system || aliases.length) ? { path: rp, system, aliases } : rp)
      }
      S.settings.reqProfile.repos = out
    }
    if (patch && patch.ob) {
      S.settings.ob = S.settings.ob || {}
      const o = patch.ob
      if (o.host     !== undefined) S.settings.ob.host         = String(o.host).trim()
      if (o.port     !== undefined) S.settings.ob.port         = parseInt(o.port) || 3306
      if (o.user     !== undefined) S.settings.ob.user         = String(o.user).trim()   // user@租户#集群
      if (o.database !== undefined) S.settings.ob.database     = String(o.database).trim()
      if (o.pass && o.pass.trim())  S.settings.ob.passEncrypted = email.encryptPass(o.pass.trim())
      try { db.closePool() } catch {}   // 配置变了,丢弃旧连接池
    }
    saveSettings()
    // IMAP 配置/IDLE 开关变化 → 重启监听
    if (patch && (patch.imap || patch.imapIdleEnabled !== undefined)) { try { mail.startIdleWatcher() } catch (e) { log('idle restart err: ' + e.message) } }
    return true
  })

  // OceanBase 测试连接:SELECT 1 + 库名 + 表数
  ipcMain.handle('db-test', async () => {
    const cfg = mail.effectiveOb()
    if (!cfg) return { ok: false, error: 'OceanBase 未配置(填 host/端口/user@租户#集群/密码/库)' }
    try { const r = await db.ping(cfg); return { ok: true, database: r.database, tableCount: r.tableCount } }
    catch (e) { return { ok: false, error: e.message } }
  })

  // SMTP 测试:给自己发一封空邮件,失败把错误返回前端展示
  ipcMain.handle('smtp-test', async () => {
    const cfg = mail.effectiveSmtp(S)
    if (!cfg) return { ok: false, error: 'SMTP 未配置(填 host/user/密码,或勾"同 IMAP")' }
    try {
      const to = cfg.from || cfg.user
      await email.sendMail(cfg, { to, subject: 'BocomHermes SMTP 测试 - ' + new Date().toLocaleString('zh-CN'), text: '这是一封由桌面智能体发出的 SMTP 测试邮件。\n如果你收到了,说明 SMTP 配置 OK,agent 可以代发邮件了。' })
      return { ok: true, to }
    } catch (e) { return { ok: false, error: e.message } }
  })

  // 取本次 session 的 git diff(前端+后端目录),给"查看本次改动"用,改完直接展示给用户看
  ipcMain.handle('current-diff', () => {
    const dirs = [S.settings.projectDir, S.settings.backendDir].filter(Boolean)
    if (!dirs.length) return '(未配置项目目录)'
    const out = []
    for (const cwd of dirs) {
      let d = ''
      try { d = require('child_process').execSync('git --no-pager diff HEAD', { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }) }
      catch (e) { d = '(git diff 失败: ' + e.message + ')' }
      let u = ''
      try {
        const ls = require('child_process').execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf8', timeout: 3000 }).split('\n').map((s) => s.trim()).filter(Boolean)
        if (ls.length) u = '\n\n(未跟踪新文件 ' + ls.length + '):\n  ' + ls.join('\n  ')
      } catch {}
      if ((d && d.trim()) || u) out.push('## ' + cwd + '\n' + (d || '(无 staged/unstaged 改动)') + u)
    }
    return out.length ? out.join('\n\n---\n\n') : '(本轮 session 无 git 改动)'
  })

  // ── Todos 广播（增删待办后通知邮件中心待办 tab 刷新）────────────────────────
  ipcMain.on('todos-updated', () => {
    for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('todos-updated') } catch {} }
  })

  // ── 浏览器 IPC ───────────────────────────────────────────────────────────
  const brWC = () => { const t = brActive(); return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null }
  ipcMain.handle('open-browser', (_e, url) => createWorkspace(url))
  // 通用目录选择(无副作用,只返回路径):编排页选「产出文档/中间过程文档」落盘路径用;pickProject 会动全局,不能复用
  ipcMain.handle('pick-dir', async (_e, arg) => {
    const title = (arg && arg.title) || '选择目录'
    const defaultPath = (arg && arg.defaultPath) || S.settings.projectDir || undefined
    const r = await dialog.showOpenDialog({ title, defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return { canceled: r.canceled, dir: r.canceled ? '' : (r.filePaths[0] || '') }
  })
  // ── 内嵌浏览器(波7 · 真重构):浏览器 chrome/页面视图挂进主窗口(不再是跟随的嵌入式子窗) ──
  ipcMain.handle('browser-embed', (_e, show) => {
    if (show) {
      if (!S.browser.shellHost) createShellBrowser()
      else shellBrowserVisible(true)
    } else shellBrowserVisible(false)
  })
  // ── 同屏分栏(2026-08-10:单会话 × 内嵌浏览器整合)──────────────────────────
  // chatW = 主窗内容区左边留给【对话】的像素宽;0 = 老行为(浏览器铺满内容区,与对话互斥)。
  // 只改一个数,几何全在 browser.js 的 layoutRegion 里现算 —— 标签栏/控制台/设备模拟/分隔条一并跟着缩。
  // 渲染端负责两件事:自己让出右边这块(CSS),以及把拖出来的宽度报上来。主进程不猜渲染端的布局。
  ipcMain.handle('browser-split', (_e, a) => {
    if (!S.browser) return { ok: false }
    const o = (a && typeof a === 'object') ? a : { chatW: a }
    S.browser.chatW = Math.max(0, Math.round(+o.chatW || 0))
    log('[split] 收到分栏:chatW=' + S.browser.chatW + ' sideW=' + (o.sideW != null ? o.sideW : '(未给)') + ' shellHost=' + !!S.browser.shellHost)
    // 侧栏宽度也一并收:layoutRegion 原来写死 228,而侧栏可拖 —— 拖过之后浏览器视图整体错位(既有 bug)
    if (o.sideW != null) S.browser.sideW = Math.max(0, Math.round(+o.sideW || 0))
    try { brLayout() } catch {}
    return { ok: true, chatW: S.browser.chatW, sideW: S.browser.sideW }
  })
  ipcMain.handle('open-skill-center', () => createSkillCenter())   // 「🎬 录制回放」入口(托盘/热键)
  // 分隔条拖动：start=临时分离内容视图让 chrome 独占鼠标事件；end=落定宽度并复位视图
  ipcMain.on('browser-split', (_e, arg) => {
    const b = S.browser
    if (!b.win || b.win.isDestroyed() || b.mode !== 'workspace') return
    const phase = arg && arg.phase
    if (phase === 'start') {
      b._dragging = true
      try { if (b.cardView) b.win.contentView.removeChildView(b.cardView) } catch {}
      const t = brActive(); if (t) { try { b.win.contentView.removeChildView(t.view) } catch {} }
    } else {
      const [cw] = b.win.getContentSize()
      b.leftW = Math.max(320, Math.min(cw - 440, (arg && arg.leftW) | 0))
      b._dragging = false
      if (b.cardView) { try { b.win.contentView.addChildView(b.cardView) } catch {} }
      const t = brActive(); if (t) { try { b.win.contentView.addChildView(t.view) } catch {} }
      brLayout()
      if (!b.win.isDestroyed()) chromeSend('browser-split-set', b.leftW)
    }
  })
  ipcMain.handle('browser-navigate', (_e, url) => { const wc = brWC(); const u = normalizeUrl(url); if (wc && u) wc.loadURL(u) })
  // ⋯ 更多菜单开/合 → 网页层从右让出/收回一条(否则原生层盖住 HTML 菜单)
  ipcMain.on('browser-menu-overlay', (_e, on) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.menuOpen = !!on; brLayout() })
  ipcMain.on('browser-settings-overlay', (_e, on) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.settingsOpen = !!on; brLayout() })
  // 通用 chrome 浮层让位:HTML 浮层(技能库 480px / 验证卡等)打开时,页面视图从右让出 w 像素
  ipcMain.on('browser-chrome-overlay', (_e, w) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.chromeOverlayW = Math.max(0, w | 0); brLayout() })
  // 模态浮层让位:模态卡(保存技能/填参数)打开时,页面视图高度压 0,关闭恢复
  ipcMain.on('browser-modal-overlay', (_e, on) => { const b = S.browser; if (!b || !b.win || b.win.isDestroyed()) return; b.modalOpen = !!on; brLayout() })
  ipcMain.on('browser-back',    () => { const wc = brWC(); if (wc && wc.canGoBack()) wc.goBack() })
  ipcMain.on('browser-forward', () => { const wc = brWC(); if (wc && wc.canGoForward()) wc.goForward() })
  ipcMain.on('browser-reload',  () => { const wc = brWC(); if (wc) wc.isLoading() ? wc.stop() : wc.reload() })
  // 禁用缓存:置一个全局 flag,每个 tab 的 did-start-navigation 钩子里读它,真要清就 session.clearCache()
  ipcMain.handle('browser-no-cache', async (_e, on) => {
    S.browser.noCache = !!on
    if (on) { try { await session.defaultSession.clearCache() } catch {} }   // 当下立刻清一次
    return S.browser.noCache
  })

  // ── 录制 ─────────────────────────────────────────────────────────────────


  // 「● 已录 N 步」实时徽标:每入队一个事件就推一次计数到 chrome
  function brSendRecCount() {
    const b = S.browser
    if (!b.rec) return
    const payload = { n: b.rec.events.length }
    if (b.win && !b.win.isDestroyed()) chromeSend('browser-rec-count', payload)
    skillsNotify('browser-rec-count', payload)   // 「录制与回放」中心的实况条同步跳数
  }

  // 把某个 tab 接入当前录制(原始 tab 与录制期间新开的 tab 共用):幂等挂钩 did-frame-finish-load,
  // 页面加载完重注入录制脚本 + URL 变化补 navigate 事件。opts.crossTab=新开标签,第一条 navigate 打 newTab 标记。
  // 事件通道 __bocom_rec_emit 已由 attachDbg 逐 tab 装好,这里只补脚本注入 + 放行(pushConsole 认 tabIds)。
  function wireRecToTab(tab, opts) {
    const rec = S.browser.rec
    if (!rec || !tab || tab._recWired) return
    rec.tabIds.add(tab.id)
    tab._recWired = true
    const wc = tab.view.webContents
    let firstNav = !!(opts && opts.crossTab)
    const handler = () => {
      const r = S.browser.rec
      if (!r || !r.active) return
      injectRecorder(wc).then(() => {
        const r2 = S.browser.rec
        if (!r2 || !r2.active) return
        const u = wc.getURL()
        if (!/^https?:\/\//i.test(u)) return   // 空白新标签(newtab.html=file://)不补 navigate,回放只认 http(s)
        // #5 去重比"最后一个 navigate 的 url",不是最后一个事件的 .url:非导航事件(click/input)没有 .url,
        //    否则 iframe 子框架 did-frame-finish-load(顶层 url 未变)会在每个非导航事件后补出幻影 navigate 刷屏。
        let lastNavUrl = null
        for (let i = r2.events.length - 1; i >= 0; i--) { if (r2.events[i].act === 'navigate') { lastNavUrl = r2.events[i].url; break } }
        if (lastNavUrl !== u) {
          const nav = { t: Date.now() - r2.startedAt, act: 'navigate', url: u }
          if (firstNav) { nav.newTab = true; firstNav = false }   // 供回放/报告降级标注
          r2.events.push(nav); brSendRecCount()
        }
      })
    }
    wc.on('did-frame-finish-load', handler)
    rec.cleanups.push(() => { try { wc.off('did-frame-finish-load', handler) } catch {} ; tab._recWired = false })   // 复位 _recWired:否则下次录制同一 tab 被幂等拦住不再挂钩
  }

  // 录制启动核心:浏览器工具栏与「录制与回放」中心共用(后者经 skills-record 先确保浏览器就绪)
  async function recStart() {
    const tab = brActive()
    if (!tab) return { ok: false, error: '没有活跃标签' }
    if (S.browser.rec && S.browser.rec.active) return { ok: true, already: true }   // #10 已在录制中:拒绝并发重入(双击录制会泄漏 did-frame-finish-load 监听器 + 卡死 _recWired)
    const wc = tab.view.webContents
    // #10 同步占位 rec(必须在任何 await 之前):否则 preState 快照的 await 窗口里第二次 rec-start 会重入,leaving _recWired 永久 true。
    //   tabId=起始/归属 tab(存档与 lastRec 匹配依赖它);tabIds=本次录制放行的 tab 集(含录制期间新开的);cleanups=各 tab 摘钩
    S.browser.rec = { active: true, tabId: tab.id, tabIds: new Set([tab.id]), startedAt: Date.now(), startUrl: wc.getURL(), preState: { cookies: [], local: '{}', session: '{}', origin: '' }, events: [], cleanups: [] }
    // 前置状态快照:cookies + localStorage + sessionStorage,回放前恢复才能在内网保持登录态
    let preState = { cookies: [], local: '{}', session: '{}', origin: '' }
    try {
      const url = wc.getURL()
      const u = new URL(url)
      preState.origin = u.origin
      preState.cookies = await session.defaultSession.cookies.get({ url })
      const s = await wc.executeJavaScript(`(()=>{try{var l={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);l[k]=localStorage.getItem(k)}var s={};for(var j=0;j<sessionStorage.length;j++){var k2=sessionStorage.key(j);s[k2]=sessionStorage.getItem(k2)}return JSON.stringify({l:l,s:s})}catch(e){return JSON.stringify({l:{},s:{}})}})()`, true)
      const ps = JSON.parse(s || '{"l":{},"s":{}}')
      preState.local = JSON.stringify(ps.l || {})
      preState.session = JSON.stringify(ps.s || {})
      log('rec preState: ' + preState.cookies.length + ' cookies, localStorage ' + Object.keys(ps.l || {}).length + ' keys')
    } catch (e) { log('preState dump err: ' + e.message) }
    S.browser.rec.preState = preState   // #10 占位后回填真实 preState
    // #4 空白新标签(newtab.html=file://)不写入毒首步(execStep/replayRec 只认 http(s),否则回放/验证在第 0 步就中止);
    //    首个真实 http 导航由 wireRecToTab 补成 events[0]。从已加载的 app 页开录则照常写入。
    const _startUrl = wc.getURL()
    if (/^https?:\/\//i.test(_startUrl)) S.browser.rec.events.push({ t: 0, act: 'navigate', url: _startUrl })
    const injected = await injectRecorder(wc)
    // 录制中导航/新开标签 → 重注入 + 补 navigate:抽成 wireRecToTab(原始 tab 与新 tab 共用)
    wireRecToTab(tab)
    // 健康自检:①注入是否真落地 ②事件通道(binding→console 回退)是否连通 ③CDP attach 状态,失败立刻告知原因
    const health = { injected: false, channel: false, dbg: !!tab.dbg }
    health.injected = injected && await wc.executeJavaScript('!!window.__bocom_rec_init && !!window.__bocom_rec_on', true).catch(() => false)
    if (health.injected) {
      S.browser.rec._pingOk = false
      // ping 走与 emit 相同的双通道:binding 命中即 return,否则回退 console.log
      const PING_JS = "(function(){var s='__BR__'+JSON.stringify({act:'__ping__'});try{if(typeof window.__bocom_rec_emit==='function')return window.__bocom_rec_emit(s)}catch(e){}try{console.log(s)}catch(e){}})()"
      try { await wc.executeJavaScript(PING_JS, true) } catch {}
      for (let k = 0; k < 3 && !(S.browser.rec && S.browser.rec._pingOk); k++) await sleep(200)
      health.channel = !!(S.browser.rec && S.browser.rec._pingOk)
    }
    if (!health.injected || !health.channel) {
      const cs = (S.browser.rec && S.browser.rec.cleanups) || []   // 早退前按 cleanups 数组摘所有钩子
      S.browser.rec = null
      for (const fn of cs) { try { fn() } catch {} }
      const error = !health.injected
        ? '录制脚本注入失败:页面还在加载或是受限页,等加载完再试'
        : (health.dbg ? '事件通道不通:页面可能覆写了 console.log(生产静音),可稍后重试' : '事件通道不通:CDP 调试器未附加(可能被 DevTools/外部工具占用),关掉 DevTools 后重试')
      log('rec start health fail: injected=' + health.injected + ' channel=' + health.channel + ' dbg=' + health.dbg)
      return { ok: false, error }
    }
    log('rec start: tab ' + tab.id + ' @ ' + S.browser.rec.startUrl)
    brSendRecCount()   // 初始 navigate 已入队 → 徽标从 1 起跳
    return { ok: true, health }
  }
  ipcMain.handle('browser-rec-start', async () => await recStart())

  async function recStop() {
    const r = S.browser.rec
    if (!r || !r.active) return { ok: false, error: '没有进行中的录制' }
    r.active = false
    chromeSend('browser-rec-count', { n: r.events.length, done: true })   // 收徽标(宿主/独立两路统一)
    skillsNotify('browser-rec-count', { n: r.events.length, done: true })   // 「录制与回放」中心同步收实况条
    if (r.cleanups) for (const fn of r.cleanups) { try { fn() } catch {} }
    // 把页面里的 flag 关掉(监听仍在,只是不再 emit);顺手收掉防抖里还没吐出来的最后一个输入。
    // 必须走返回值通道:此刻 r.active 已 false,console 通道的 __BR__ 会被 pushConsole 丢弃且有异步竞态。
    // 停录时用户多半停在最后操作的 tab(可能是新开的)→ 用 brActive() 兜底取快照/flush
    const tab = brActive() || (S.browser.tabs || []).find((t) => t.id === r.tabId)
    if (tab) {
      try {
        const pend = await tab.view.webContents.executeJavaScript(
          `;(function(){try{var s=window.__bocom_rec_flush?window.__bocom_rec_flush(true):null;window.__bocom_rec_on=false;return s}catch(e){window.__bocom_rec_on=false;return null}})()`, true)
        if (pend) { const ev = JSON.parse(pend); ev.t = Date.now() - r.startedAt; r.events.push(ev) }
      } catch {}
    }
    // 录制结束 = 复现成功瞬间 → 抓快照(报错 + 网络异常【含 200 业务异常】),供 Phase C 验证时 diff
    const snapshot = tab ? {
      errs: tab.console.filter((c) => c.level >= 2).map((c) => ({ level: c.level, msg: (c.message || '').split('\n')[0].slice(0, 200) })),
      bad: await snapshotBad(tab),
      url: tab.url || '',
    } : { errs: [], bad: [], url: '' }
    const id = 'rec_' + Date.now().toString(36)
    const dir = path.join(app.getPath('userData'), 'recordings')
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    // 降噪:逐事件照录 → 有意义的操作序列(删滚动/合并重复输入/去焦点点击/去重复提交/去 Tab)。
    // 带兜底:compactEvents 万一抛异常也绝不阻断保存,回退原始事件。dropped 明细留档,透明可回溯。
    let events = r.events, compaction = null
    try {
      const c = compactEvents(r.events)
      events = c.events; compaction = { from: r.events.length, to: c.events.length, dropped: c.dropped }
      log('rec compact: ' + r.events.length + ' → ' + c.events.length + ' events(降噪删 ' + c.dropped.length + ' 步)')
      // 人机断点识别:验证码/动态令牌/滑块这类"必须人来"的步标 human,回放到此暂停等人现场输入(见 replayRec)
      events = markHumanGates(events)
      const gates = events.filter((e) => e.human)
      if (gates.length) log('rec human-gates: ' + gates.length + ' 处(' + gates.map((g) => g.humanHint).join('/') + ')— 回放将暂停等人工输入')
    } catch (e) { log('rec compact err(回退原始事件): ' + e.message) }
    const rec = { id, tabId: r.tabId, startedAt: r.startedAt, startUrl: r.startUrl, durationMs: Date.now() - r.startedAt, events, compaction, snapshot, preState: r.preState || null }
    refreshSkillArtifacts(rec)   // steps 语义视图(此刻尚无 params/title,保存为技能时会重建)
    try { fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(rec, null, 2)) } catch (e) { log('rec save err: ' + e.message) }
    S.browser.lastRec = rec
    log('rec stop: ' + id + ' · ' + events.length + ' events · pre-fix snapshot: ' + snapshot.errs.length + ' errs / ' + snapshot.bad.length + ' bad')
    skillsNotify('skills-changed')
    return { ok: true, ...rec }
  }
  ipcMain.handle('browser-rec-stop', async () => await recStop())

  // ── 回放 ─────────────────────────────────────────────────────────────────
  // 按录制时间线在当前 tab 自动播放;每步执行后等"网络静默"(<=900ms 无新请求),
  // 步间最长 sleep 2s。播完抓"修复后状态"快照,跟录制时的"修复前状态"diff。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  ipcMain.on('browser-devtools', () => {
    const tab = brActive(); if (!tab || tab.view.webContents.isDestroyed()) return
    const wc = tab.view.webContents
    if (wc.isDevToolsOpened()) { wc.closeDevTools(); return }
    if (tab.dbg) detachDbg(tab)   // 原生 DevTools 与我们的 debugger 互斥 → 让出通道（网络捕获暂停）
    try { wc.openDevTools({ mode: 'detach' }) } catch (e) { log('devtools open fail: ' + e.message) }
    wc.once('devtools-closed', () => { if (!wc.isDestroyed()) { attachDbg(tab); sendNetSnapshot(tab) } })   // 关闭后恢复网络捕获
  })
  ipcMain.on('browser-new-tab', (_e, url) => newTab(url || ''))
  ipcMain.on('browser-close-tab', (_e, id) => closeTab(id))
  ipcMain.on('browser-activate-tab', (_e, id) => activateTab(id))
  ipcMain.on('browser-set-device', (_e, key) => brSetDevice(key))
  ipcMain.on('browser-rotate', () => brRotateDevice())
  ipcMain.on('browser-zoom', (_e, dir) => brZoom(dir))
  ipcMain.on('browser-console-resize', (_e, h) => { S.browser.consoleH = h || 0; brLayout() })
  ipcMain.on('browser-find', (_e, { text, findNext, forward }) => {
    const wc = brWC(); if (!wc) return
    if (!text) { wc.stopFindInPage('clearSelection'); return }
    wc.findInPage(text, { findNext: !!findNext, forward: forward !== false })
  })
  ipcMain.on('browser-find-stop', () => { const wc = brWC(); if (wc) wc.stopFindInPage('clearSelection') })
  ipcMain.handle('browser-screenshot', async (_e, full) => await brScreenshot(full !== false))   // 默认整页
  ipcMain.handle('browser-analyze', async () => { await brAnalyze() })
  // 网络面板
  ipcMain.handle('browser-net-get', async (_e, id) => await brNetBody(id))
  ipcMain.on('browser-net-clear', () => { const tab = brActive(); if (!tab) return; tab.net = []; tab.netById = new Map(); sendNetSnapshot(tab) })
  ipcMain.on('browser-net-preserve', (_e, on) => { const tab = brActive(); if (tab) tab.preserveNet = !!on })
  // 元素拾取
  ipcMain.handle('browser-pick-element', async () => await brPickElement())
  // 控制台 REPL 求值
  ipcMain.handle('browser-eval', async (_e, expr) => await brEval(String(expr || '')))
  // 闭环验证：重载复现页并把修复后状态回灌 Agent
  ipcMain.handle('browser-verify', async () => { await verifyFix() })
  // 人机断点续跑:回放暂停在验证码/滑块步时,用户点 HUD「继续」→ 解开 replayRec 里挂着的 resolver
  ipcMain.on('browser-replay-resume', () => { const f = S.browser && S.browser._replayResume; if (typeof f === 'function') { try { f() } catch {} } })

  // ── 「录制与回放」中心的 IPC 面(ui/skills.html)──────────────────────────────
  // 执行全部复用既有引擎:录制=recStart、运行=skillRun、批跑=skillRunBatch;这里只做"确保浏览器就绪+调度"。
  // 录制:可带起始网址;浏览器没开自动拉起,已开则导航过去,然后走与工具栏同一套 recStart
  ipcMain.handle('skills-record', async (_e, url) => {
    const u = String(url || '').trim()
    if (!brActive()) {
      createBrowser(u)
      for (let i = 0; i < 100 && !brActive(); i++) await sleep(150)
      if (!brActive() && S.browser.win && !S.browser.win.isDestroyed()) { newTab(u); for (let i = 0; i < 40 && !brActive(); i++) await sleep(150) }
      if (!brActive()) return { ok: false, error: '内嵌浏览器未能就绪(15s 超时)' }
      if (u) await sleep(1500)   // 让起始页加载完,录制脚本注入/健康自检才有落点
    } else {
      if (u) { const wc = brWC(); const nu = normalizeUrl(u); if (wc && nu) { wc.loadURL(nu); await sleep(1500) } }
      if (S.browser.shellHost) shellBrowserVisible(true)
      else if (S.browser.win && !S.browser.win.isDestroyed()) S.browser.win.focus()
    }
    const r = await recStart()
    // 浏览器壳的录制按钮/徽标同步进入录制态(recStart 只管引擎;徽标本会随首个计数事件出现,按钮态要显式推)
    if (r && r.ok) chromeSend('browser-rec-ui', { on: true })
    return r
  })
  // 停止:浏览器窗还在 → 让它走自己的停录流(弹"保存为技能"卡,用户就在那给技能起名);窗没了才直接停
  ipcMain.handle('skills-stop-rec', async () => {
    const bw = S.browser.win
    if (bw && !bw.isDestroyed()) { bw.webContents.send('browser-do-stop-rec'); bw.focus(); return { ok: true, via: 'browser' } }
    return await recStop()
  })
  // 运行/批跑:直接复用按名字/id 跑技能的引擎入口(自带确保浏览器/参数注入/审计)
  ipcMain.handle('skills-run', async (_e, a) => await skillRun(a || {}))
  ipcMain.handle('skills-run-batch', async (_e, a) => await skillRunBatch(a || {}))
  // 原始录制"整理成技能":确保浏览器开着,让它弹既有的保存卡(表单在浏览器壳里,不重造)
  ipcMain.handle('skills-make-skill', async (_e, id) => {
    if (!brActive()) { createBrowser(''); for (let i = 0; i < 100 && !brActive(); i++) await sleep(150) }
    const bw = S.browser.win
    if (!bw || bw.isDestroyed()) return { ok: false, error: '内嵌浏览器未能就绪' }
    bw.focus(); await sleep(250)
    bw.webContents.send('browser-open-save-skill', { id: String(id || '') })
    return { ok: true }
  })
  // 复制到剪贴板（供网络面板「复制 URL / 复制 cURL」、拾取「复制选择器」）
  ipcMain.handle('browser-copy', (_e, text) => { clipboard.writeText(String(text || '')); return true })
  ipcMain.on('browser-reveal', (_e, filePath) => { try { shell.showItemInFolder(String(filePath || '')) } catch (e) { log('reveal err: ' + e.message) } })
  ipcMain.handle('browser-rec-set-expectation', (_e, { recId, text }) => {
    const t = String(text || '').slice(0, 500)
    if (!t) return false
    // 更新内存
    if (S.browser.lastRec && S.browser.lastRec.id === recId) S.browser.lastRec.expectation = t
    // 落盘到 recordings/<id>.json
    const fp = path.join(app.getPath('userData'), 'recordings', recId + '.json')
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      j.expectation = t
      fs.writeFileSync(fp, JSON.stringify(j, null, 2))
      log('rec ' + recId + ' expectation set: ' + t.slice(0, 60))
      return true
    } catch (e) { log('set expectation err: ' + e.message); return false }
  })
  // 一键回滚:直接在主进程跑(不用走 MCP), 给浏览器卡片的"回滚"按钮用
  ipcMain.handle('browser-rollback-changes', async (_e, opts) => {
    const dirs = [S.settings.projectDir, S.settings.backendDir].filter(Boolean)
    if (!dirs.length) return { ok: false, error: '未配置项目目录' }
    const dryRun = !!(opts && opts.dryRun)
    const result = []
    for (const cwd of dirs) {
      let tracked = [], untracked = []
      try {
        const t = require('child_process').execSync('git diff --name-only HEAD', { cwd, encoding: 'utf8', timeout: 5000 })
        const c = require('child_process').execSync('git diff --cached --name-only HEAD', { cwd, encoding: 'utf8', timeout: 5000 })
        tracked = [...new Set([...t.split('\n'), ...c.split('\n')].map((s) => s.trim()).filter(Boolean))]
      } catch {}
      try { untracked = require('child_process').execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf8', timeout: 5000 }).split('\n').map((s) => s.trim()).filter(Boolean) } catch {}
      result.push({ dir: cwd, tracked, untracked })
      if (dryRun) continue
      for (const f of tracked) { try { require('child_process').execSync(`git checkout HEAD -- "${f.replace(/"/g, '\\"')}"`, { cwd, timeout: 3000 }) } catch {} }
      for (const f of untracked) { try { fs.unlinkSync(path.join(cwd, f)) } catch {} }
    }
    if (!dryRun) { try { const n = result.reduce((a, r) => a + r.tracked.length + r.untracked.length, 0); S.audit && S.audit('rollback', '回滚改动 ' + n + ' 个文件', { dirs: result.map((r) => path.basename(r.dir)), files: result.flatMap((r) => [...r.tracked, ...r.untracked]).slice(0, 50) }) } catch {} }
    return { ok: true, dryRun, result }
  })
  // ── 浏览器技能(SKILL):一条录制即一个技能 ─────────────────────────────────
  // 不新建第二套子系统:录制 JSON 就地扩展 skill/description/params/skipSteps/success 字段。
  // params[].stepIndex 指向 events 里某个 input/select 步;回放前把运行时值写进【深拷贝】的
  // events[i].value,再喂给 replayRec —— 参数化在门口完成,只落输入步、拒绝替 selector(防注入)。
  // 单个录制事件的白名单净化(导入/步骤编辑共用):返回净化后的事件或 null(丢弃)。
  // 只放行已知 act,字段类型强转+截断,navigate/fu 强制 http/https —— 挡 loadURL/executeJavaScript 注入。
  const _ACTS = new Set(['navigate', 'click', 'input', 'key', 'submit', 'scroll', 'select', 'check'])
  const _KEYS = new Set(['Enter', 'Escape', 'Tab'])
  function sanitizeEvent(ev) {
    if (!ev || !_ACTS.has(ev.act)) return null
    const e2 = { act: ev.act }
    if (ev.act === 'navigate') {
      if (!safeOrigin(ev.url)) return null
      e2.url = String(ev.url).slice(0, 2000); if (ev.spa) e2.spa = true
    } else {
      if (ev.sel != null) e2.sel = String(ev.sel).slice(0, 1000)
      if (Array.isArray(ev.selAlt)) e2.selAlt = ev.selAlt.slice(0, 8).map((s) => String(s).slice(0, 1000))
      if (ev.transient) e2.transient = true   // 日历格子标记:丢了会让这类步计入级联早停(存量修复)
      // 语义字段随事件走:人机断点(human/humanHint)与字段上下文(ph/lb/ac/im),编辑保存不能洗掉
      if (ev.human) { e2.human = true; if (ev.humanHint) e2.humanHint = String(ev.humanHint).slice(0, 60) }
      for (const k of ['ph', 'lb', 'ac', 'im']) if (ev[k]) e2[k] = String(ev[k]).slice(0, 60)
      if (ev.act === 'input') { e2.value = String(ev.value == null ? '' : ev.value).slice(0, 200); if (ev.secret) { e2.secret = true; e2.value = '' } if (ev.human) e2.value = '' }
      if (ev.act === 'select') { e2.value = String(ev.value == null ? '' : ev.value).slice(0, 200); if (ev.text) e2.text = String(ev.text).slice(0, 60) }
      if (ev.act === 'check') e2.checked = !!ev.checked
      if (ev.act === 'key') { if (!_KEYS.has(ev.key)) return null; e2.key = ev.key }
      if (ev.act === 'scroll') { e2.x = Number(ev.x) || 0; e2.y = Number(ev.y) || 0 }
      if (ev.act === 'click' && ev.text) e2.text = String(ev.text).slice(0, 40)
      if (ev.fu && /^https?:\/\//i.test(String(ev.fu))) e2.fu = String(ev.fu).slice(0, 2000)
    }
    e2.t = Number(ev.t) || 0
    return e2
  }
  // SKILL 语义视图 + 技能文档(对标 Codex R&R,设计见 docs/技能系统-意图执行与Agent解析链设计.md):
  // events/params/skipSteps 任一变动就重建 steps;技能(skill:true)另落 <id>.skill.md(四段式,与 JSON 并排)。
  // 纯增强,try/catch 兜底,绝不阻断保存。
  function refreshSkillArtifacts(j) {
    try {
      const v = upgradeToSkill(j)
      j.skillRev = v.skillRev; j.steps = v.steps
      if (j.skill && j.id) fs.writeFileSync(path.join(recDir(), String(j.id).replace(/[^\w.-]/g, '') + '.skill.md'), skillMd(j))
    } catch (e) { log('skill view err: ' + e.message) }
  }
  // 运行历史:重读磁盘 read-modify-write,只改 lastRun 一个键。
  // 严禁序列化内存里的 rec/clone —— replayRec 会把 preState(cookie)塞进 events[i]._restorePreState,直接 stringify 会持久化敏感态
  // 按名字跑技能(relay /skill/run 与 agent 共用):浏览器没开就自动拉起,回完给文字结论 + 写运行历史
  async function skillRun(a) {
    const want = String((a && (a.name || a.id)) || '').trim()
    if (!want) return { error: '缺少 name(技能名)' }
    // 批跑是逐行调 replayRec,行与行之间那把回放锁是松开的 —— 不在这儿拦一道,UI/Agent 发起的单跑会插进两行中间,
    // 与批跑抢同一个标签页(replayRec 的互斥只覆盖单行)
    if (S.browser._batchRunning) return { error: '正在批量跑技能,等它结束再发起单次运行' }
    const all = skillList()
    let hit = all.find((s) => s.name === want || s.id === want)
    if (!hit) {   // 模糊匹配只在无歧义时用:「导出报表」不能悄悄跑成「导出报表-测试」
      const fuzzy = all.filter((s) => s.name.includes(want))
      if (fuzzy.length > 1) return { error: '「' + want + '」命中多条技能,请用全名: ' + fuzzy.map((s) => s.name).join('、') }
      hit = fuzzy[0]
    }
    if (!hit) return { error: '没有叫「' + want + '」的技能。现有: ' + (all.map((s) => s.name).join('、') || '(空 — 让用户在内嵌浏览器录一条并保存为技能)') }
    let rec; try { rec = readRec(hit.id) } catch (e) { return { error: '读取技能失败: ' + e.message } }
    if (a && a.baseUrl) {
      if (!safeOrigin(a.baseUrl)) return { error: 'baseUrl 必须是 http/https origin,如 https://uat.example.com' }
      rec = applyBaseUrl(rec, a.baseUrl)
    }
    if (!brActive()) {   // 窗口没开 → 自动拉起并等首个标签就绪(chrome 加载完才建 tab)
      createBrowser(rec.startUrl)
      for (let i = 0; i < 100 && !brActive(); i++) await sleep(150)
      if (!brActive() && S.browser.win && !S.browser.win.isDestroyed()) {
        newTab(rec.startUrl)   // 窗口开着但 0 tab(createBrowser 对已开窗只 focus)
        for (let i = 0; i < 40 && !brActive(); i++) await sleep(150)
      }
      if (!brActive()) return { error: '内嵌浏览器未能就绪(15s 超时)' }
      await sleep(1200)   // 让首页先加载;回放的首个 navigate 步会再校准 URL
    }
    S.browser.lastRec = rec
    const replay = await replayRec(applyParams(rec, (a && a.params) || {}), { fast: true })
    if (!replay.ok) return { error: replay.error || '回放失败' }
    writeLastRun(hit.id, replay)
    const fails = replay.stepReport.filter((s) => !s.ok && !s.transient)
    const retried = replay.stepReport.filter((s) => s.retried && s.ok).length
    const ok = fails.length === 0 && (!replay.success || replay.success.pass)
    // 失败自动取证包:截图 + 当前 URL + 首个失败步 + 这步试过的选择器 + 页面文本摘要 → userData/evidence/(留最近 60 份)。
    // 排查选择器失配类失败不用复跑 —— 直接看"它当时到底看到了什么"。报告里带路径(UI 与 Agent 都拿得到)。
    let evidencePath = ''
    if (fails.length) {
      try {
        const tab = brActive()
        const wc = tab && tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents
        const evDir = path.join(app.getPath('userData'), 'evidence'); fs.mkdirSync(evDir, { recursive: true })
        const f0 = fails[0]
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        let shot = ''
        if (wc) {
          try { fs.writeFileSync(path.join(evDir, stamp + '_' + hit.id + '.png'), (await wc.capturePage()).toPNG()); shot = path.join(evDir, stamp + '_' + hit.id + '.png') } catch {}
        }
        let url = '', domText = ''
        if (wc) {
          try { url = wc.getURL() } catch {}
          try { domText = await wc.executeJavaScript('(document.title||"")+"\\n"+((document.body&&document.body.innerText)||"").slice(0,3000)', true) } catch {}
        }
        const failEv = (rec.events || [])[f0.i - 1]
        const bundle = { at: new Date().toISOString(), skill: hit.name, id: hit.id, url, failStep: f0,
          selectorsTried: failEv ? [failEv.sel, ...(failEv.selAlt || [])].filter(Boolean) : [],
          healed: replay.healed || [], domText, screenshot: shot }
        evidencePath = path.join(evDir, stamp + '_' + hit.id + '.json')
        fs.writeFileSync(evidencePath, JSON.stringify(bundle, null, 2))
        try {   // 只留最近 60 份(.json 与同名 .png 一起清)
          const all = fs.readdirSync(evDir).filter((f) => f.endsWith('.json')).map((f) => ({ f, m: fs.statSync(path.join(evDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)
          for (const old of all.slice(60)) { try { fs.unlinkSync(path.join(evDir, old.f)) } catch {}; try { fs.unlinkSync(path.join(evDir, old.f.replace(/\.json$/, '.png'))) } catch {} }
        } catch {}
      } catch (e) { log('evidence capture err: ' + e.message) }
    }
    try { S.audit && S.audit('skill', 'Agent 运行技能「' + hit.name + '」', { by: 'agent', steps: replay.stepReport.length, result: ok ? 'PASS' : (fails.length + ' 步失败'), baseUrl: (a && a.baseUrl) || '' }) } catch {}
    const lines = ['技能「' + hit.name + '」回放 ' + replay.stepReport.length + '/' + replay.totalSteps + ' 步 · ' + (fails.length === 0 ? '✓ 步骤全部成功' : '✗ ' + fails.length + ' 步失败') + (retried ? '(' + retried + ' 步重试后成功)' : '')]
    for (const f of fails.slice(0, 8)) lines.push('  · 步 ' + f.i + ' ' + f.act + ' "' + String(f.sel).slice(0, 60) + '" — ' + f.err)
    if (evidencePath) lines.push('失败取证包(截图+页面快照): ' + evidencePath)
    const skippedState = replay.stepReport.filter((s) => s.skipped === 'state').length
    if (skippedState) lines.push('· ' + skippedState + ' 步已被页面状态满足自动跳过(登录缓存/无效导航)')
    // 人机断点透明化:等人的步怎么过的(人点的/自动判出的/Agent 给的);【超时】要单独喊出来 —— 那步等于没人管就往下跑了
    const humans = replay.stepReport.filter((s) => s.human || s.liveGate)
    const HOW = { manual: '人工点继续', auto: '自动检测填入', 'auto-nav': '自动检测页面跳转', 'auto-gone': '自动检测验证消失', agent: 'Agent 给值', timeout: '等了 5 分钟没人管(该步未处理即继续)' }
    for (const h of humans) {
      // liveGate 现在拦到就留痕(不管重试成没成)—— 失败那条恰恰是"没人管干等 5 分钟"的路,必须照实说
      if (h.liveGate) lines.push('· 步 ' + h.i + ' 回放时冒出「' + h.liveGate.hint + '」(录制时没有)→ ' + (h.liveGate.ok ? '已等人过关后重试成功' : '等人处理后重试仍失败') + '(' + (HOW[h.liveGate.how] || h.liveGate.how) + ')')
      else lines.push('· 步 ' + h.i + ' 人机断点 → ' + (HOW[h.how] || h.how))
    }
    if (humans.some((h) => h.how === 'timeout' || (h.liveGate && h.liveGate.how === 'timeout'))) lines.push('注意:有人机断点超时未处理,结果可能不可信')
    if (rec.noCache) lines.push('· 本次已禁用缓存运行(跑前 + 每次导航前清 HTTP 缓存)')
    if (replay.takeover) lines.push('· 第 ' + replay.takeover.from + ' 步起由 Agent 接管:' + (replay.takeover.status === 'done' ? '目标达成 ✓' : '未完成(' + replay.takeover.status + ')') + (replay.takeover.note ? ' — ' + replay.takeover.note : ''))
    if (replay.success) lines.push('成功断言: ' + (replay.success.pass ? '✓ 达成' : '✗ 未达成') + ' [' + replay.success.kind + '] "' + replay.success.value + '"' + (replay.success.err ? '(检查出错: ' + replay.success.err + ')' : ''))
    if (replay.dialogs && replay.dialogs.length) lines.push('自动应答弹窗 ' + replay.dialogs.length + ' 个(confirm→确定): ' + replay.dialogs.slice(0, 3).map((d) => d.k + '「' + d.m + '」').join(' | '))
    if (replay.baseSwapped) lines.push('已切环境运行(未恢复录制时的登录态;需要登录的流程请先在浏览器登录目标环境,或把登录步录进技能)')
    if (replay.after.errs.length) lines.push('回放后控制台报错 ' + replay.after.errs.length + ' 条: ' + replay.after.errs.slice(0, 3).map((x) => x.msg).join(' | '))
    if (replay.after.bad.length) lines.push('网络/业务异常 ' + replay.after.bad.length + ' 条: ' + replay.after.bad.slice(0, 3).map((b) => (b.biz ? '200·' + b.biz : (b.status || b.state)) + ' ' + b.url).join(' | '))
    lines.push('结束页面: ' + (replay.after.url || '?'))
    // 下载后编排 = 【单 Agent 任务编排】,与「动态工作流」(多 Agent 拆解)彻底无关:技能配了 postPipeline 且捕获到下载文件
    // → 开一张任务编排卡(注入 PIPELINE_RULES,单 Agent 顺序读文件→加工→按目标办),不再 spawnWorkflow。
    // 网关挂了也不影响 —— 文件已在本地;批跑不走这条(见 skillRunBatch,循环批跑属"运行计划")。
    let pipeline = null
    const dls = Array.isArray(replay.downloads) ? replay.downloads : []
    const pp = rec.postPipeline || rec.postWorkflow   // 向后兼容:老技能存的是 postWorkflow 字段,读时兜底
    // 导出文件【完整路径】始终进报告(不只配了 postPipeline 的场景):任务编排里 Agent 调 skill_run 后要拿路径接 doc_read 加工,
    // 以前没配时报告对下载只字不提 —— 链条断在第一棒
    if (dls.length) lines.push('导出/下载文件(' + dls.length + ' 个): ' + dls.join(' | '))
    // 触发条件"文件到手就接编排":导出文件已捕获说明主链目标基本达成,个别收尾步失败不该卡死整条链 —— 有失败照样起,报告明说
    if (pp && pp.goal) {
      if (dls.length) {
        // T7 级联超生抑制:调用链是不是 MCP/relay 没有可靠标记(mail.js 中继与 UI 共用 skillRun 入口),
        // 用保守启发式 —— 同目录已有 running 编排卡(多半就是编排链里的 Agent 在 skill_run)→ 不另开卡,报告改注
        const projDir = S.settings.projectDir || ''
        const runningPipe = S.wfRegistry && S.wfCardByWc
          ? [...S.wfRegistry.values()].find((r) => r.kind === 'pipeline' && r.status === 'running' && (r.dir || '') === projDir && S.wfCardByWc.has(r.wcId))
          : null
        if (runningPipe) {
          lines.push('文件就绪(' + dls.length + ' 个,已在编排链内,不另开编排): ' + dls.map((p) => String(p).split(/[\\/]/).pop()).join('、') + ' —— 完整路径见上方「导出/下载文件」行')
        } else {
          if (!ok) lines.push('注意:回放有失败步骤,但导出文件已捕获 —— 仍按文件启动下载后任务编排(不放心可关掉那张卡)')
          let go = true
          if (pp.ask) {   // F7「启动前问我」:回放完先弹确认,点了才开编排卡
            try {
              const r = await dialog.showMessageBox({ type: 'question', buttons: ['启动编排', '不启动'], defaultId: 0, cancelId: 1, title: '下载后任务编排', message: '技能「' + hit.name + '」已导出 ' + dls.length + ' 个文件', detail: '是否按目标启动任务编排:' + String(pp.goal).slice(0, 120) })
              go = r && r.response === 0
            } catch {}
          }
          if (!go) lines.push('已按你的选择跳过「下载后任务编排」(文件仍在本地,路径见上方「导出/下载文件」行)')
          else try {
            const pipeGoal = composePostPipelineGoal(hit.name, pp.goal, dls)
            const cardId = spawnCard('任务编排 · ' + hit.name, null, PIPELINE_RULES + pipeGoal, pp.goal, { flash: !pp.silent, pipeline: true })   // F7 silent → 静默后台跑(不抢焦点)
            pipeline = { started: true, files: dls, id: cardId }
            lines.push('→ 已对下载的 ' + dls.length + ' 个文件启动「任务编排」(单 Agent 顺序执行,见对话卡): ' + dls.map((p) => String(p).split(/[\\/]/).pop()).join('、'))
            try { S.audit && S.audit('skill', '技能「' + hit.name + '」触发下载后任务编排', { files: dls.map((p) => String(p).split(/[\\/]/).pop()), goal: String(pp.goal).slice(0, 120), cardId }) } catch {}
          } catch (e) { lines.push('下载后任务编排启动失败: ' + e.message) }
        }
      } else {
        lines.push('该技能配了「下载后任务编排」,但本次没捕获到下载文件 —— 请确认导出/下载步骤成功(任务编排未启动)')
      }
    }
    return { ok, pass: ok, report: lines.join('\n'), stepReport: replay.stepReport, downloads: dls, pipeline }
  }
  // 批量跑技能(relay /skill/run-batch,Phase 5·数据集循环,设计文档第 6 节):
  // dataset 每行 = {参数label/key: 值} = 一次独立运行(独立参数注入/独立结果);循环在技能外,技能保持线性。
  // 行间容错:默认失败跳过继续(onError:'stop' 则中止);每行重读技能文件 —— replayRec 会把 preState
  // 塞进 events[i]._restorePreState,复用内存对象会让上一行的状态污染下一行。
  async function skillRunBatch(a) {
    const want = String((a && (a.name || a.id)) || '').trim()
    if (!want) return { error: '缺少 name(技能名)' }
    const dataset = Array.isArray(a && a.dataset) ? a.dataset : null
    if (!dataset || !dataset.length) return { error: '缺少 dataset(非空数组,每行 = {参数label: 值};参数名先用 skill_list 查)' }
    if (dataset.length > 200) return { error: 'dataset 上限 200 行(收到 ' + dataset.length + '),请分批' }
    if (a && a.baseUrl && !safeOrigin(a.baseUrl)) return { error: 'baseUrl 必须是 http/https origin,如 https://uat.example.com' }
    if (S.browser._batchRunning) return { error: '已有批量任务在跑,等它结束再发起' }
    const all = skillList()
    let hit = all.find((s) => s.name === want || s.id === want)
    if (!hit) {
      const fz = all.filter((s) => s.name.includes(want))
      if (fz.length > 1) return { error: '「' + want + '」命中多条技能,请用全名: ' + fz.map((s) => s.name).join('、') }
      hit = fz[0]
    }
    if (!hit) return { error: '没有叫「' + want + '」的技能。现有: ' + (all.map((s) => s.name).join('、') || '(空)') }
    if (!brActive()) {   // 与 skillRun 同款:浏览器没开就自动拉起
      let first; try { first = readRec(hit.id) } catch (e) { return { error: '读取技能失败: ' + e.message } }
      createBrowser(first.startUrl)
      for (let i = 0; i < 100 && !brActive(); i++) await sleep(150)
      if (!brActive() && S.browser.win && !S.browser.win.isDestroyed()) {
        newTab(first.startUrl)
        for (let i = 0; i < 40 && !brActive(); i++) await sleep(150)
      }
      if (!brActive()) return { error: '内嵌浏览器未能就绪(15s 超时)' }
      await sleep(1200)
    }
    S.browser._batchRunning = true
    try {
      const rows = []
      let passN = 0, failN = 0
      for (let ri = 0; ri < dataset.length; ri++) {
        let rec; try { rec = readRec(hit.id) } catch (e) { rows.push({ row: ri + 1, ok: false, firstErr: '读取技能失败: ' + e.message, unmatched: [] }); failN++; break }
        if (a && a.baseUrl) rec = applyBaseUrl(rec, a.baseUrl)
        const { values, unmatched } = rowToParamValues(rec.params || [], dataset[ri])
        S.browser.lastRec = rec
        const replay = await replayRec(applyParams(rec, values), { fast: true })
        const fails = replay.ok ? replay.stepReport.filter((s) => !s.ok && !s.transient) : null
        const rowOk = !!replay.ok && fails.length === 0 && (!replay.success || replay.success.pass)
        rowOk ? passN++ : failN++
        rows.push({ row: ri + 1, ok: rowOk,
          fails: fails ? fails.length : -1,
          firstErr: rowOk ? '' : (fails && fails[0] ? '步' + fails[0].i + ' ' + fails[0].err : (replay.error || (replay.success && !replay.success.pass ? '成功断言未达成' : ''))),
          unmatched })
        log('skill batch「' + hit.name + '」行 ' + (ri + 1) + '/' + dataset.length + ': ' + (rowOk ? 'PASS' : 'FAIL'))
        skillsNotify('skill-batch-progress', { row: ri + 1, total: dataset.length, pass: passN, fail: failN, ok: rowOk, firstErr: rows[rows.length - 1].firstErr || '' })
        if (!rowOk && (a && a.onError) === 'stop') break
      }
      try { S.audit && S.audit('skill', 'Agent 批量运行技能「' + hit.name + '」', { by: 'agent', rows: rows.length, pass: passN, fail: failN }) } catch {}
      const lines = ['技能「' + hit.name + '」批量运行 ' + rows.length + '/' + dataset.length + ' 行 · ✓ ' + passN + ' / ✗ ' + failN + (rows.length < dataset.length ? '(onError=stop 提前中止)' : '')]
      const unm = rows.find((r) => r.unmatched && r.unmatched.length)
      if (unm) lines.push('有列名未匹配到任何参数(检查 dataset 键是否 = 参数 label): ' + unm.unmatched.join('、'))
      for (const r of rows.slice(0, 60)) lines.push('  行' + r.row + ' ' + (r.ok ? '✓' : '✗ ' + r.firstErr))
      if (rows.length > 60) lines.push('  …(共 ' + rows.length + ' 行,只列前 60)')
      return { ok: failN === 0, pass: passN, fail: failN, report: lines.join('\n'), rows }
    } finally { S.browser._batchRunning = false }
  }
  // ── 混合执行 · Agent 直接操作内嵌浏览器的三个动作面(relay /skill/page-*,browser-mcp 转发)────
  // 复用确定性引擎的同一套加固原语(waitForEl/原生 setter+事件/__text__),Element-UI 等框架事件才触发得对。
  // 读页任何时候可用;【执行】仅在接管期(S.browser._takeover.active)开放 —— 防 Agent 随手戳生产页面。
  // tab 可选:Agent 自主会话有自己的标签页,不能读 brActive()(那是用户正在看的那个)
  // ── 读页(ref 化,仿 Claude Code 的 read_page)────────────────────────────────
  // 【为什么要 ref】原来这里返回的是"元素 + 现成选择器",而选择器是【模型要自己复用的字符串】:
  //   __text__:button|提交 这种在同名按钮上直接歧义,#id 遇到动态 id 又不稳。
  //   CC 那套的地基是 read_page 给每个可交互元素一个 [ref_N] 句柄,后续 click/type 直接用 ref ——
  //   模型不用拼选择器,也就不会拼错。
  // 【本仓的实现比"记一张表"更稳】读页时给元素盖一个 data-bh-ref 属性:
  //   ref_N 解析成 [data-bh-ref="N"],是精确唯一的;页面一刷新/重渲染属性就没了 → ref 自然失效,
  //   act 那边会明说"refs 已失效,先重新 browser_read"—— 与 CC 的"先 read_page"契约一致,
  //   而且失效是【被发现的】,不是悄悄点到别的元素上(那才是最坏的结果)。
  // 【截断要说出来】原来 80 个元素 / 6000 字正文是硬截且不吭声 —— 模型以为自己看全了。
  //   今天一整天的教训:静默截断读起来和"就这么多"一模一样。
  const PAGE_MAX_EL = 200, PAGE_MAX_TEXT = 8000
  /** 元素采集的注入体(主框架和每个 iframe 各跑一遍;__BASE 是本 frame 的 ref 起始号) */
  const str2 = (x) => (x == null ? '' : String(x))
  function collectBody(onlyInteractive) {
    return `
        var SEL='button,a,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"],[onclick]';
        var es=document.querySelectorAll(${onlyInteractive ? 'SEL' : "SEL+',h1,h2,h3,label,td,th'"});
        // ★框架 H5 的退路(2026-08-12 冒烟实测):uni-app / Taro 这类把所有可点区域编译成
        //   <div> + JS 事件,语义标签【一个都没有】—— 实测一页 101 个可见元素、文案齐全,
        //   而 button/a/input 命中 0。照老判据读出来就是"这页没有可交互元素",
        //   模型于是开始猜选择器(正是本轮一直在修的那个坑)。
        //   所以:语义标签几乎为空时,退到"看着能点"的判据 —— 鼠标手型 / uni-app 的 data-event-opts /
        //   类名带 btn|link|tab。只在语义扫描落空时才做全量 getComputedStyle,不给正常页面加负担。
        var fallback=false;
        if(es.length<5){
          fallback=true;
          var all=document.querySelectorAll('*');var pick=[];
          for(var q=0;q<all.length&&pick.length<400;q++){
            var el=all[q];
            if(el.children&&el.children.length>3)continue;              // 只要叶子附近的,容器不算
            var txt=(el.innerText||'').trim();
            if(!txt&&!el.getAttribute('data-event-opts'))continue;
            if(txt.length>40)continue;                                   // 一大段文字不是按钮
            var cls=String(el.className||'');
            var looks=!!el.getAttribute('data-event-opts')||/btn|button|link|tab|menu|cell|item/i.test(cls);
            if(!looks){var cs2=window.getComputedStyle(el);if(!cs2||cs2.cursor!=='pointer')continue}
            // 去重:外层包着内层、文字又一模一样时只留【最里面】那个 —— 点它最准,
            // 也省得清单里"首页"连出三条(冒烟实测就是这样,10 条里有 6 条是重复的壳)
            while(pick.length&&pick[pick.length-1].contains(el)&&(pick[pick.length-1].innerText||'').trim()===txt)pick.pop();
            pick.push(el);
          }
          if(pick.length)es=pick;
        }
        var lines=[],n=0,total=0;   // n 是本 frame 内的序号,ref 用 __BASE+n 保证全页唯一
        // 先清掉上一次的 ref —— 不清的话旧编号会和新编号混在一页上,ref_3 到底指谁就说不清了
        var old=document.querySelectorAll('[data-bh-ref]');
        for(var k=0;k<old.length;k++){try{old[k].removeAttribute('data-bh-ref')}catch(e){}}
        for(var i=0;i<es.length;i++){
          var e=es[i];var r=e.getBoundingClientRect();
          if(!r.width&&!r.height)continue;                       // 不可见的不给 ref:给了模型也点不着
          var cs=window.getComputedStyle(e); if(cs&&(cs.visibility==='hidden'||cs.display==='none'))continue;
          total++;
          if(__BASE+n>=${PAGE_MAX_EL})continue;
          n++; e.setAttribute('data-bh-ref',String(__BASE+n));
          var role=e.getAttribute('role')||e.tagName.toLowerCase();
          var name=(e.innerText||e.value||e.placeholder||(e.getAttribute&&e.getAttribute('aria-label'))||'').trim().replace(/\\s+/g,' ').slice(0,60);
          var st=[];
          if(e.disabled)st.push('disabled');
          if(e.checked)st.push('checked');
          if(e.getAttribute&&e.getAttribute('aria-expanded'))st.push('expanded='+e.getAttribute('aria-expanded'));
          if(e.tagName==='INPUT'&&e.type)st.push('type='+e.type);
          if(e.tagName==='A'&&e.getAttribute('href'))st.push('href='+String(e.getAttribute('href')).slice(0,60));
          lines.push('[ref_'+(__BASE+n)+'] '+role+(name?' "'+name+'"':'')+(st.length?' ('+st.join(', ')+')':''));
        }
        // 盲区普查:"Agent 在页面元素上摸索半天,不知道为什么"的真因多半在这里 ——
        // 元素采集【只看主框架】,iframe 里的东西一个都进不来,而回执从不说这件事。
        // 内网柜面那套是"外壳 + 各系统的 flex/h5 页面",典型的 iframe 架构:
        // 它读到的是外壳,业务页在它眼里根本不存在,于是开始猜选择器 —— 猜一辈子也猜不到。
        // shadow DOM(组件库)和 canvas(图表/Flex)同理:看得见,DOM 里摸不着。
        // 所以把"我看不见什么"数出来、报出来 —— 这是诊断,也是它下一步该往哪走的唯一依据。
        var blind={frames:[],shadow:0,canvas:0};
        try{
          var ifr=document.querySelectorAll('iframe,frame');
          for(var z=0;z<ifr.length&&z<12;z++){
            var f=ifr[z];var r2=f.getBoundingClientRect();
            var same=false;try{same=!!f.contentDocument}catch(e2){same=false}
            var inner=0;if(same){try{inner=f.contentDocument.querySelectorAll('button,a,input,select,textarea,[role="button"]').length}catch(e3){}}
            blind.frames.push({i:z,src:String(f.src||f.getAttribute('src')||'(没有 src,可能是 JS 写进去的)').slice(0,160),
              same:same,inner:inner,w:Math.round(r2.width),h:Math.round(r2.height)});
          }
          var all2=document.querySelectorAll('*');
          for(var y=0;y<all2.length;y++){if(all2[y].shadowRoot)blind.shadow++}
          blind.canvas=document.querySelectorAll('canvas,object,embed').length;
        }catch(e4){}
        return {els:lines.join('\\n'),shown:n,total:total,fallback:fallback,blind:blind};
})()`
  }

  async function skillPageRead(tab0, opts) {
    const tab = tab0 || brActive(); if (!tab) return { error: '没有活跃标签' }
    const wc = tab.view.webContents
    const onlyInteractive = !(opts && opts.all)
    let text = '', els = '', more = '', elemErr = '', blind = ''
    try {
      const r = await wc.executeJavaScript('(function(){var t=(document.body&&document.body.innerText)||"";'
        + 'return {t:t.slice(0,' + PAGE_MAX_TEXT + '),n:t.length}})()', true)
      text = (r && r.t) || ''
      if (r && r.n > PAGE_MAX_TEXT) more += '正文共 ' + r.n + ' 字,这里只给了前 ' + PAGE_MAX_TEXT + ' 字;'
    } catch {}
    // ★iframe 里的元素也要采(2026-08-12 用户:"Agent 在页面元素上摸索半天,不知道为什么")。
    //   内网柜面那套是"外壳 + 各系统 flex/h5 页",业务页全在 iframe 里 —— 只采主框架的话,
    //   它读到的是一张几乎空的清单,然后开始猜选择器,而它要点的东西【根本不在它能看到的世界里】。
    //   这里不新造机器:录制早就支持在 iframe 里执行(frameFor + evalJs(fr,…)),WebFrameMain
    //   在那个 frame 自己的上下文里跑,连跨域也进得去。所以读页按 frame 各跑一遍、ref 全局编号,
    //   再记下"哪个 ref 属于哪个 frame",act 时把 fu 带上就落到对应 frame。
    const collectJs = (base) => `(function(){`
      + `var __BASE=${base};`
      + collectBody(onlyInteractive)
    let refFrames = {}
    try {
      const out = await wc.executeJavaScript(collectJs(0), true)
      els = (out && out.els) || ''
      let refN = (out && out.shown) || 0, total = (out && out.total) || 0
      // 子框架逐个采:ref 接着编号,并记下这个 ref 属于哪个 frame(act 靠它把动作送进去)
      let frames = []
      try { frames = wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame && f.url && !/^about:/.test(f.url)) } catch {}
      for (const f of frames.slice(0, 8)) {
        if (refN >= PAGE_MAX_EL) { more += '子框架里还有元素没采(总数已到 ' + PAGE_MAX_EL + ' 上限);'; break }
        let sub = null
        try { sub = await f.executeJavaScript(collectJs(refN), true) } catch (e) { more += '子框架 ' + String(f.url).slice(0, 60) + ' 采集失败:' + e.message + ';'; continue }
        const sl = str2(sub && sub.els)
        if (!sl) continue
        // 标出这些元素在子页面里 —— 它得知道自己在跟谁打交道(选择器写在子页面的坐标系里)
        els += (els ? '\n' : '') + '--- 以下在 iframe 内:' + String(f.url).slice(0, 120) + ' ---\n' + sl
        for (let q = refN + 1; q <= refN + ((sub && sub.shown) || 0); q++) refFrames[q] = f.url
        refN += (sub && sub.shown) || 0; total += (sub && sub.total) || 0
        try { const tr = await f.executeJavaScript('(document.body&&document.body.innerText||"").slice(0,1500)', true); if (tr && tr.trim()) text += '\n--- iframe 正文:' + String(f.url).slice(0, 80) + ' ---\n' + tr } catch {}
      }
      if (total > refN) more += '可交互元素共 ' + total + ' 个,这里只给了前 ' + refN + ' 个(想看全部或按区域细看,先滚动/收窄再读一次);'
      // 走了退路要说出来:这些 ref 是按"看着能点"挑的,不是语义标签,可能有漏有多
      if (out && out.fallback) more += '这一页没有 button/a/input 这类语义标签(框架 H5 常见),上面的元素是按【鼠标手型/事件属性/类名】挑出来的 —— 可能有漏也可能有多,拿不准就用 browser_eval 直接查 DOM;'
      blind = blindNote(out && out.blind)
    } catch (e) {
      // ★采集失败必须【留痕 + 单独一个字段】,不能塞进 elements 里冒充内容(2026-08-11 真机):
      // 原来是 els='(采集失败: …)' 且外层照样 ok:true —— 于是模型分不清"这页没有可交互元素"和
      // "采集这一步炸了",只会接着往下猜 selector;而日志里一个字都没有,查都没法查。
      // 那次的真因就藏在这个 catch 里:注入串里 lines.join('\n') 的 \n 被模板串吃成真换行,
      // 页面拿到的是一条断行的字符串字面量 → SyntaxError → 这个 catch。见 npm run inject。
      elemErr = e.message
      log('[browser] 元素采集失败(ref 句柄这一轮不可用):' + e.message + ' @ ' + wc.getURL())
    }
    return { ok: true, url: wc.getURL(), title: wc.getTitle(), elements: els, text, truncated: more || '', elemErr, blind, refFrames }
  }
  /** 把盲区普查翻成人话 + 明确的下一步。上面那段只负责数,判断口径全在这里。 */
  function blindNote(b) {
    if (!b) return ''
    const L = []
    const fr = (b.frames || []).filter((f) => f && f.w > 40 && f.h > 40)   // 1×1 的埋点 iframe 不算
    if (fr.length) {
      L.push('⚠ 这一页有 ' + fr.length + ' 个 iframe。子页面里的元素【已经采进清单了】'
        + '(标着「--- 以下在 iframe 内 ---」那几行),用 [ref_N] 点它们照常生效。'
        + '但要记住一件事:【CSS 选择器跨不进 iframe】—— 子页面里的东西只能用 ref,'
        + '写 selector:"#xxx" 一定是 not found,那不是元素不存在,是 querySelector 到不了那一层。')
      for (const f of fr.slice(0, 6)) {
        L.push('   · iframe#' + f.i + ' ' + f.w + '×' + f.h + ' ' + (f.same ? '同源' : '跨域(连内容都读不到)')
          + (f.same && f.inner ? ',里面约 ' + f.inner + ' 个可交互元素' : '') + '  src=' + f.src)
      }
      // 挑"最像业务页"的那个推给它:同源且内部元素多的优先。真机第一版按协议挑,
      // 结果推了跨域那个(里面 1 个按钮),而同源那个装着整张登录表单(5 个元素)—— 推反了。
      const usable = fr.filter((f) => /^https?:\/\//i.test(f.src))
      const first = usable.slice().sort((x, y) => (y.same ? 1 : 0) - (x.same ? 1 : 0) || (y.inner || 0) - (x.inner || 0) || (y.w * y.h) - (x.w * x.h))[0]
      L.push('   【子页面里步骤很多的话】直接 browser_open 那个 src 当独立页跑更省事:少一层嵌套,'
        + '选择器也能用了。' + (first ? '最像业务页的是 iframe#' + first.i + ':' + first.src : ''))
    }
    if (b.shadow > 0) L.push('⚠ 页面里有 ' + b.shadow + ' 处 shadow DOM(组件库常见):这些元素在 DOM 里查不到,'
      + 'querySelector 返回 null。用 browser_eval 走 el.shadowRoot.querySelector(…) 才进得去。')
    if (b.canvas > 0) L.push('⚠ 有 ' + b.canvas + ' 个 canvas/object/embed(图表、Flex、旧插件):内部没有 DOM,'
      + '选择器一个都定位不到。看内容用 browser_see(视觉模型读图),点里面用 browser_act{action:"point"} 按坐标。')
    return L.join('\n')
  }

  async function skillPageAct(a) {
    const t = S.browser._takeover
    if (!t || !t.active) return { error: '当前没有进行中的接管(仅回放整段失败、Agent 被点名接管时才可执行页面操作)' }
    const tab = brActive(); if (!tab) return { error: '没有活跃标签' }
    const wc = tab.view.webContents
    const action = String((a && a.action) || '')
    const sel = a && a.selector != null ? String(a.selector).slice(0, 1000) : ''
    let ev = null
    if (action === 'click') ev = { act: 'click', sel, selAlt: [] }
    else if (action === 'type') ev = { act: 'input', sel, selAlt: [], value: String(a.value == null ? '' : a.value).slice(0, 500) }
    else if (action === 'type_param') {
      const v = t.paramValues[String(a.key || '')]
      if (v == null) return { error: '参数无值: ' + (a.key || '(空)') + '(可用: ' + Object.keys(t.paramValues).join(',') + ')' }
      ev = { act: 'input', sel, selAlt: [], value: v }
    }
    else if (action === 'select') ev = { act: 'select', sel, selAlt: [], value: String(a.value == null ? '' : a.value).slice(0, 200), text: String(a.text == null ? '' : a.text).slice(0, 60) }
    else if (action === 'check') ev = { act: 'check', sel, selAlt: [], checked: a.checked !== false }
    else if (action === 'enter') ev = { act: 'key', sel, selAlt: [], key: 'Enter' }
    else if (action === 'navigate') ev = { act: 'navigate', url: String(a.url || '') }
    else if (action === 'wait') { await sleep(Math.min(Math.max(+a.ms || 800, 100), 5000)); return { ok: true, url: wc.getURL() } }
    else return { error: '未知 action: ' + action + '(可用 click|type|type_param|select|check|enter|navigate|wait)' }
    const r = await execStep(wc, ev, tab, { waitMs: 4000 })
    await waitNetIdle(brActive(), 300, 2500)
    const masked = action === 'type_param'
    log('takeover act: ' + action + ' ' + (sel || ev.url || '') + (masked ? ' (值已代填)' : '') + ' → ' + (r.ok ? 'ok' : r.err))
    return r.ok ? { ok: true, url: wc.getURL() } : { error: r.err || '执行失败' }
  }
  function skillTakeoverDone(a) {
    const t = S.browser._takeover
    if (!t || !t.active) return { error: '当前没有进行中的接管' }
    if (String(a && a.gateId || '') !== t.gateId) return { error: 'gateId 不匹配(当前 ' + t.gateId + ')' }
    const status = (a && a.status) === 'done' ? 'done' : 'failed'
    t.result = { status, note: String(a && a.note || '').slice(0, 300) }
    log('takeover done: ' + status + (t.result.note ? ' — ' + t.result.note : ''))
    return { ok: true, status }
  }
  // 录制管理面板:list / star / rename / delete / replay-stored
  ipcMain.handle('browser-rec-list', () => {
    const dir = recDir()
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return [] }
    const items = []
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        items.push({
          id: j.id || f.replace(/\.json$/, ''),
          title: j.title || '',
          starred: !!j.starred,
          skill: !!j.skill,
          description: j.description || '',
          paramCount: (j.params || []).length,
          params: (j.params || []).map((p) => ({ key: p.key, label: p.label || p.key, secret: !!p.secret, default: p.default != null ? String(p.default) : '' })),   // 「录制与回放」中心:填参/批跑映射预览用
          gates: (j.events || []).filter((e) => e && e.human).length,   // 人机断点数(验证码等,卡片上提示"回放会暂停等人")
          postPipeline: (() => { const pp = j.postPipeline || j.postWorkflow; return (pp && pp.goal) ? { goal: String(pp.goal), ask: !!pp.ask, silent: !!pp.silent } : null })(),   // 下载后任务编排:配了就在卡片上出 chip + ⋯ 里可编辑(ask/silent 透传给配置弹层)
          noCache: !!j.noCache,   // 技能级禁用缓存(跑前+每次导航前清 HTTP 缓存)
          startUrl: j.startUrl || '',
          expectation: j.expectation || '',
          eventCount: (j.events || []).length,
          durationMs: j.durationMs || 0,
          lastRun: j.lastRun || null,
          mtime: fs.statSync(path.join(dir, f)).mtimeMs,
        })
      } catch {}
    }
    return items.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.mtime - a.mtime)
  })
  // 取整条录制(技能编辑器要列 input 步做参数勾选)
  ipcMain.handle('browser-rec-get', (_e, id) => { try { return readRec(id) } catch { return null } })
  // ── 录制中实况步骤流(技能中心边录边看,录错当场删/改,不用整段重录)─────────────
  // 只读投影:secret/人机断点步的值不下发(与导出脱敏同规);步名借 upgradeToSkill 的语义视图,不另写一套。
  ipcMain.handle('browser-rec-events', () => {
    const r = S.browser.rec
    if (!r || !r.active) return { active: false, events: [] }
    const intents = new Map()
    try { for (const s of upgradeToSkill({ events: r.events }).steps) intents.set(s.ei, s.intent) } catch {}
    return {
      active: true,
      events: r.events.map((ev, i) => ({
        i, act: ev.act, intent: intents.get(i) || String((ev && ev.act) || ''),
        value: (ev && (ev.secret || ev.human)) ? '' : String((ev && ev.value) == null ? '' : ev.value).slice(0, 60),
        secret: !!(ev && ev.secret), human: !!(ev && ev.human),
      })),
    }
  })
  // 删步:仅限录制中(保存后走技能编辑器的勾掉/编辑链)。index=当前 events 下标
  ipcMain.handle('browser-rec-event-delete', (_e, idx) => {
    const r = S.browser.rec
    if (!r || !r.active || !Array.isArray(r.events)) return { ok: false }
    const i = Math.floor(+idx)
    if (!(i >= 0 && i < r.events.length)) return { ok: false }
    r.events.splice(i, 1); brSendRecCount()
    return { ok: true, n: r.events.length }
  })
  // 改值:仅非密文、非人机断点的填值/选择步(secret/验证码类各有专属机制,不在录制态改)
  ipcMain.handle('browser-rec-event-update', (_e, a) => {
    const r = S.browser.rec
    if (!r || !r.active || !Array.isArray(r.events)) return { ok: false }
    const i = Math.floor(+(a && a.index))
    if (!(i >= 0 && i < r.events.length)) return { ok: false }
    const ev = r.events[i]
    if (!ev || (ev.act !== 'input' && ev.act !== 'select')) return { ok: false, err: '只有填值/选择步可改值' }
    if (ev.secret || ev.human) return { ok: false, err: '密文/人机断点步不改(回放时现场输入)' }
    ev.value = String((a && a.value) == null ? '' : a.value).slice(0, 500)
    return { ok: true }
  })
  // 技能文档(Codex 四段式):现生成保证与 JSON 同步,不读 .skill.md 缓存(那份是给文件系统/Agent 看的)
  ipcMain.handle('browser-rec-skillmd', (_e, id) => { try { return skillMd(readRec(id)) } catch { return null } })
  // 【编译时 Agent·Phase 4(工作流化)】技能精修:「保存为技能」后【自动触发】,不设手动按钮
  // (一步工作流,对标 Codex"录完即起草";用户反馈:精修要可视化 + 不给一堆选项)。
  // 可视化优先:工作台卡片开着 → card-inject 把整理请求发进【可见对话】,用户看着 Agent 干活;
  // 没开工作台 → 降级无头会话(同一 prompt)。两条路 Agent 都用 MCP 工具 skill_refine(recId,…)
  // 提交补丁(refines/<id>.json 文件总线),这里轮询取走 → 剥掉用户已定字段(标题必保,
  // 描述仅在空/懒时收)→ applyRefinePatch 校验 → 落盘 + browser-skill-refined 通知。
  // 纯增强:超时(5 分钟)/失败/坏补丁都不动技能。
  const refinesDir = () => path.join(app.getPath('userData'), 'refines')
  const _refining = new Set()
  async function skillRefineFlow(id) {
    if (_refining.has(id)) return
    _refining.add(id)
    try {
      let rec; try { rec = readRec(id) } catch (e) { log('refine 读取失败: ' + e.message); return }
      try { fs.mkdirSync(refinesDir(), { recursive: true }) } catch {}
      try { fs.unlinkSync(path.join(refinesDir(), id + '.json')) } catch {}   // 清陈旧补丁,防误取上一轮的
      const evDigest = (rec.events || []).map((ev, i) => {
        const bits = [i + '.', ev.act, ev.sel || ev.url || '']
        if (ev.text) bits.push('text=' + ev.text)
        if (ev.lb) bits.push('label=' + ev.lb)
        if (ev.ph) bits.push('placeholder=' + ev.ph)
        if (ev.act === 'input' && !ev.secret && !ev.human) bits.push('value=' + String(ev.value == null ? '' : ev.value).slice(0, 40))
        if (ev.secret) bits.push('(密码)')
        if (ev.human) bits.push('⏸human:' + (ev.humanHint || ''))
        return bits.join(' ')
      }).join('\n')
      const prompt = '请整理这条刚保存的浏览器自动化技能(自动工作流,直接做,无需征询用户):\n\n'
        + '## 当前技能文档(确定性草稿)\n' + skillMd(rec) + '\n\n'
        + '## 原始事件明细(行首数字=stepIndex)\n' + evDigest + '\n\n'
        + '任务:\n'
        + '1. 给含糊的步骤起人话名:intents={事件下标:名字},≤20字/步,只写能明显改善的\n'
        + '2. 提名"每次运行都会不同"的输入步为参数:params=[{stepIndex,label}](stepIndex 必须是 input/select 步;录制值像常量配置的不提名)\n'
        + '3. 推断可自动检查的成功标志:success={kind:"text"或"css",value}(推断不出就省略)\n'
        + '4. 补"何时使用"(description)与注意事项/决策点(notes),可省略\n'
        + '完成后调用 MCP 工具 skill_refine(recId="' + id + '", …上述字段…) 提交;不确定的字段省略,宁缺毋滥。\n'
        + '提交后用一两句话说明你改了什么即可,不要把 JSON 贴在对话里。'
      const b = S.browser
      const viaCard = b.mode === 'workspace' && b.cardView && !b.cardView.webContents.isDestroyed()
      if (viaCard) {
        b.cardView.webContents.send('card-inject', { text: prompt, disp: '自动整理技能「' + (rec.title || id) + '」:步骤命名/参数识别/成功判据…' })
      } else {
        try {
          const serve = await oc.ensureServe(S.settings.projectDir || process.cwd(), S.handlers, log)
          const sid = await oc.createSession(serve, '技能精修:' + (rec.title || id))
          if (!sid) { log('refine createSession 失败'); return }
          oc.sendMessage(serve, sid, prompt).catch((e) => log('refine 无头会话错误: ' + e.message))
        } catch (e) { log('refine serve 不可用: ' + e.message); return }
      }
      log('skill refine 已发起(' + (viaCard ? '工作台可视' : '无头降级') + '): ' + id)
      // 轮询 Agent 经 skill_refine 提交的补丁,最长 5 分钟;拿不到就静默放弃(技能已可用,精修只是增强)
      const fp = path.join(refinesDir(), id + '.json')
      const t0 = Date.now()
      let got = null
      while (Date.now() - t0 < 300000) {
        await sleep(1500)
        try { got = JSON.parse(fs.readFileSync(fp, 'utf8')); break } catch {}
      }
      if (!got || !got.patch) { log('refine 超时/无补丁: ' + id); return }
      try { fs.unlinkSync(fp) } catch {}
      // 重读技能(等待期间用户可能改过)再套补丁;用户已定字段优先:标题必保,描述仅空/懒(=标题)时收
      let cur; try { cur = readRec(id) } catch { return }
      const patch = got.patch
      if (cur.title) delete patch.title
      if (cur.description && cur.description !== cur.title) delete patch.description
      const { rec: j2, applied } = applyRefinePatch(cur, patch)
      if (!applied.length) { log('refine 无可应用改进: ' + id); return }
      refreshSkillArtifacts(j2)
      try { fs.writeFileSync(path.join(recDir(), String(id).replace(/[^\w.-]/g, '') + '.json'), JSON.stringify(j2, null, 2)) } catch (e) { log('refine 写盘失败: ' + e.message); return }
      log('skill refine 应用: ' + id + ' → ' + applied.join('/'))
      if (b.win && !b.win.isDestroyed()) chromeSend('browser-skill-refined', { id, title: j2.title || id, applied })
      skillsNotify('browser-skill-refined', { id, title: j2.title || id, applied })
      skillsNotify('skills-changed')
    } finally { _refining.delete(id) }
  }
  ipcMain.handle('browser-rec-update', (_e, { id, patch }) => {
    if (!id || !patch || typeof patch !== 'object') return false
    const fp = path.join(recDir(), String(id).replace(/[^\w.-]/g, '') + '.json')
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const wasSkill = !!j.skill   // 晋升检测:非技能 → 技能 的那一次触发自动精修
      const allowed = ['title', 'starred', 'expectation', 'description', 'params', 'skill']   // events 不进白名单,保持只读
      for (const k of allowed) if (k in patch) j[k] = patch[k]
      if ('noCache' in patch) { if (patch.noCache) j.noCache = true; else delete j.noCache }   // 技能级禁用缓存:跑前+每次导航前清 HTTP 缓存
      // 形状校验后才放行的字段(坏形状直接丢弃,不落盘)
      if ('postWorkflow' in patch) {   // 下载后编排:{goal:人话目标};传 null/空目标 = 清除
        const pw = patch.postWorkflow
        if (pw && typeof pw.goal === 'string' && pw.goal.trim() && pw.goal.trim().length <= 2000) j.postWorkflow = { goal: pw.goal.trim() }
        else delete j.postWorkflow
      }
      if ('postPipeline' in patch) {   // 下载后编排(新字段,UI 保存链走这里):{goal, ask?, silent?};null/空目标 = 清除
        const pp = patch.postPipeline
        if (pp && typeof pp.goal === 'string' && pp.goal.trim() && pp.goal.trim().length <= 2000) {
          j.postPipeline = { goal: pp.goal.trim() }
          if (pp.ask) j.postPipeline.ask = true        // 启动前问我:回放完弹确认才开编排卡
          if (pp.silent) j.postPipeline.silent = true  // 静默后台跑:开卡不抢焦点
        }
        else delete j.postPipeline
      }
      if ('skipSteps' in patch) {
        const n = (j.events || []).length
        j.skipSteps = Array.isArray(patch.skipSteps) ? patch.skipSteps.filter((x) => Number.isInteger(x) && x >= 0 && x < n) : []
      }
      if ('success' in patch) {
        const s = patch.success
        if (s && (s.kind === 'css' || s.kind === 'text') && typeof s.value === 'string' && s.value.length > 0 && s.value.length <= 500) j.success = { kind: s.kind, value: s.value }
        else delete j.success
      }
      refreshSkillArtifacts(j)   // params/skill/success 变了 → 重建 steps;skill:true 落 .skill.md
      fs.writeFileSync(fp, JSON.stringify(j, null, 2))
      // 一步工作流:「保存为技能」的那一次自动触发 Agent 精修(可视化跑在工作台对话;fire-and-forget,失败不影响保存)
      if (patch.skill === true && !wasSkill) setTimeout(() => { skillRefineFlow(j.id || id).catch((e) => log('refine flow err: ' + e.message)) }, 400)
      skillsNotify('skills-changed')
      return true
    } catch (e) { log('rec update err: ' + e.message); return false }
  })
  ipcMain.handle('browser-rec-delete', (_e, id) => {
    const base = path.join(recDir(), String(id).replace(/[^\w.-]/g, ''))
    try { fs.unlinkSync(base + '.skill.md') } catch {}   // 技能文档随录制一起删
    try { fs.unlinkSync(base + '.json'); log('rec deleted: ' + id); skillsNotify('skills-changed'); return true } catch (e) { log('rec del err: ' + e.message); return false }
  })
  // 入参兼容两种形态:'rec_xx'(旧)或 { id, params, baseUrl }(带运行时参数/环境切换)
  ipcMain.handle('browser-rec-replay-stored', async (_e, arg) => {
    const id = arg && typeof arg === 'object' ? arg.id : arg
    const values = (arg && typeof arg === 'object' && arg.params) || null
    const baseUrl = (arg && typeof arg === 'object' && arg.baseUrl) || null
    let rec; try { rec = readRec(id) } catch (e) { return { ok: false, error: '读取失败: ' + e.message } }
    if (baseUrl) {
      if (!safeOrigin(baseUrl)) return { ok: false, error: 'baseUrl 必须是 http/https origin,如 https://uat.example.com' }
      rec = applyBaseUrl(rec, baseUrl)
    }
    S.browser.lastRec = rec   // 让 verify 用这条
    // fast 只给技能:普通复现录制保持录制节奏,时序敏感的 bug 才复现得出来
    const replay = await replayRec(values ? applyParams(rec, values) : rec, { fast: !!rec.skill })
    if (replay.ok) writeLastRun(id, replay)
    try { if (rec.skill) { const nf = replay.ok ? replay.stepReport.filter((s) => !s.ok && !s.transient).length : -1; S.audit && S.audit('skill', '运行技能「' + (rec.title || id) + '」', { steps: replay.stepReport ? replay.stepReport.length : 0, result: !replay.ok ? '回放失败' : (nf === 0 ? 'PASS' : nf + ' 步失败') }) } } catch {}
    return replay
  })
  // 技能导出:剥离 preState/snapshot(cookie/报错快照不外泄)与 _ 前缀运行时键,写到「下载」目录
  ipcMain.handle('browser-rec-export', (_e, id) => {
    try {
      const j = readRec(id)
      const out = {}
      for (const k of ['id', 'title', 'description', 'expectation', 'skill', 'params', 'skipSteps', 'success', 'startUrl', 'startedAt', 'durationMs']) if (k in j) out[k] = j[k]
      out.events = (j.events || []).map((ev) => { const e2 = {}; for (const k of Object.keys(ev)) if (!k.startsWith('_')) e2[k] = ev[k]; return e2 })
      const safeId = String(j.id || id).replace(/[^\w.-]/g, '')
      const fp = path.join(app.getPath('downloads'), 'skill-' + safeId + '.json')
      fs.writeFileSync(fp, JSON.stringify(out, null, 2))
      try { shell.showItemInFolder(fp) } catch {}
      // 提醒调用方:事件里仍带录制时的输入明文(密码步除外,录制即脱敏)
      const inputValues = out.events.filter((e2) => (e2.act === 'input' || e2.act === 'select') && e2.value).length
      return { ok: true, path: fp, inputValues }
    } catch (e) { return { ok: false, error: e.message } }
  })
  // 技能导入:白名单重建 + 类型强转,绝不整包落盘;preState 一律丢弃;navigate/startUrl 强制 http/https。
  // 事件被过滤时用 idxMap 重映射 params/skipSteps 的 stepIndex,防错位指到别的步
  ipcMain.handle('browser-rec-import', async () => {
    try {
      const r = await dialog.showOpenDialog({ title: '导入技能 JSON', filters: [{ name: 'Skill JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true }
      const fpIn = r.filePaths[0]
      if (fs.statSync(fpIn).size > 2 * 1024 * 1024) return { ok: false, error: '文件超过 2MB,拒绝导入' }
      const src = JSON.parse(fs.readFileSync(fpIn, 'utf8'))
      if (!safeOrigin(src.startUrl)) return { ok: false, error: 'startUrl 必须是 http/https,拒绝导入' }
      const evsIn = Array.isArray(src.events) ? src.events.slice(0, 5000) : []
      const events = []; const idxMap = new Map()
      evsIn.forEach((ev, oldIdx) => {
        const e2 = sanitizeEvent(ev)   // 白名单净化(与步骤编辑器共用)
        if (!e2) return
        idxMap.set(oldIdx, events.length)
        events.push(e2)
      })
      if (!events.length) return { ok: false, error: '文件里没有可用的步骤' }
      const id = 'rec_' + Date.now().toString(36)
      const rec2 = {
        id, startUrl: String(src.startUrl).slice(0, 2000), startedAt: Date.now(), durationMs: Number(src.durationMs) || 0,
        events, snapshot: { errs: [], bad: [], url: '' }, preState: null,
        title: String(src.title || '导入技能').slice(0, 120), description: String(src.description || '').slice(0, 500),
        expectation: String(src.expectation || '').slice(0, 2000), skill: true,
      }
      const params = (Array.isArray(src.params) ? src.params : [])
        .filter((p) => p && /^p\d+$/.test(String(p.key)) && Number.isInteger(p.stepIndex) && idxMap.has(p.stepIndex))
        .map((p) => ({ key: String(p.key), label: String(p.label || p.key).slice(0, 60), stepIndex: idxMap.get(p.stepIndex), default: String(p.default == null ? '' : p.default).slice(0, 200), ...(p.secret ? { secret: true } : {}) }))
        .filter((p) => { const ev = events[p.stepIndex]; return ev && (ev.act === 'input' || ev.act === 'select') })
      if (params.length) rec2.params = params
      const skips = (Array.isArray(src.skipSteps) ? src.skipSteps : []).filter((x) => Number.isInteger(x) && idxMap.has(x)).map((x) => idxMap.get(x))
      if (skips.length) rec2.skipSteps = skips
      if (src.success && (src.success.kind === 'css' || src.success.kind === 'text') && typeof src.success.value === 'string' && src.success.value.length <= 500) rec2.success = { kind: src.success.kind, value: src.success.value }
      const dir = recDir(); try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(rec2, null, 2))
      return { ok: true, id, title: rec2.title, steps: events.length }
    } catch (e) { return { ok: false, error: e.message } }
  })
  // 技能步骤编辑器:改 events(删步/重排/改 input/select 值),同步重映射 params.stepIndex 与 skipSteps。
  // keep = 新顺序的步骤列表,每项 { srcIndex(指向原 events 下标), value?(编辑后的 input/select 值) };
  // 不在 keep 里的原步骤 = 删除。events 只读约束在此处松绑,但一律走 sanitizeEvent 净化,不接受任意新事件。
  ipcMain.handle('browser-rec-edit-steps', (_e, { id, keep }) => {
    if (!id || !Array.isArray(keep)) return { ok: false, error: '参数错误' }
    const fp = path.join(recDir(), String(id).replace(/[^\w.-]/g, '') + '.json')
    let j; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch (e) { return { ok: false, error: '读取失败: ' + e.message } }
    const src = Array.isArray(j.events) ? j.events : []
    const events = []; const idxMap = new Map()   // 原下标 → 新下标
    for (const k of keep.slice(0, 5000)) {
      const si = k && Number(k.srcIndex)
      if (!Number.isInteger(si) || si < 0 || si >= src.length || idxMap.has(si)) continue   // 越界/重复引用跳过
      const base = { ...src[si] }
      if (k.value !== undefined && (base.act === 'input' || base.act === 'select') && !base.secret) base.value = String(k.value)
      const e2 = sanitizeEvent(base)   // 净化(保留 _ 前缀键之外的合法字段;secret 步 value 仍被清空)
      if (!e2) continue
      idxMap.set(si, events.length)
      events.push(e2)
    }
    if (!events.length) return { ok: false, error: '至少保留一步' }
    j.events = events
    // 重映射 params:stepIndex 落在保留步且仍是 input/select 才留;
    // 编辑过值的参数步,default 跟着走(否则回放用旧 default 覆盖,编辑白改)
    if (Array.isArray(j.params)) {
      j.params = j.params
        .filter((p) => p && idxMap.has(p.stepIndex))
        .map((p) => { const ni = idxMap.get(p.stepIndex); const ev = events[ni]; return { ...p, stepIndex: ni, ...(ev && !p.secret ? { default: String(ev.value == null ? '' : ev.value).slice(0, 200) } : {}) } })
        .filter((p) => { const ev = events[p.stepIndex]; return ev && (ev.act === 'input' || ev.act === 'select') })
    }
    // 重映射 skipSteps
    if (Array.isArray(j.skipSteps)) j.skipSteps = j.skipSteps.filter((x) => idxMap.has(x)).map((x) => idxMap.get(x))
    // 重映射 intentOverrides(Agent 精修的步名按 ei 键存,删步后下标平移)
    if (j.intentOverrides && typeof j.intentOverrides === 'object') {
      const no = {}
      for (const [k, v] of Object.entries(j.intentOverrides)) { const ni = idxMap.get(Number(k)); if (ni !== undefined) no[ni] = v }
      j.intentOverrides = no
    }
    delete j.lastRun   // 步骤变了,上次运行结果作废
    refreshSkillArtifacts(j)   // events/params/skipSteps 都可能变了 → 重建语义视图
    try { fs.writeFileSync(fp, JSON.stringify(j, null, 2)); log('rec edit-steps: ' + id + ' → ' + events.length + ' 步') }
    catch (e) { return { ok: false, error: e.message } }
    return { ok: true, steps: events.length, params: (j.params || []).length }
  })
  ipcMain.on('browser-open-rec-dir', () => {
    const d = path.join(app.getPath('userData'), 'recordings')
    try { fs.mkdirSync(d, { recursive: true }) } catch {}
    try { shell.openPath(d) } catch (e) { log('open rec dir err: ' + e.message) }
  })
  // URL 历史(每访问 did-navigate 都补,内存上限 200,sendSync 给 renderer 做 datalist)
  ipcMain.on('get-browser-history', (e) => { e.returnValue = (S.browser.history || []).slice(0, 200) })
  // 标签重排:renderer 拖动 .tab 后告诉 main 新顺序(id 数组)
  ipcMain.on('browser-reorder-tabs', (_e, ids) => {
    if (!Array.isArray(ids) || !S.browser.tabs) return
    const map = new Map(S.browser.tabs.map((t) => [t.id, t]))
    const reordered = ids.map((id) => map.get(id)).filter(Boolean)
    if (reordered.length === S.browser.tabs.length) { S.browser.tabs = reordered; brSendTabs() }
  })

  ipcMain.handle('open-dock', () => openDock())
  ipcMain.handle('open-main', () => createMainWindow())   // 桌面主窗口(shell.html)
  ipcMain.on('get-history', (e) => { e.returnValue = S.history })
  // ★侧栏「会话」里点开一条编排 —— 与卡坞的 wf-open 是【两条不同的入口】,我先前只修了后者(实测本条一次没触发)。
  // 编排面板卡有会话但永不发消息:当普通对话开出来必然是空白的"历史消息未能载入",而用户要的是节点表与留痕。
  // runId 来源两条:① 历史条目上记的(recordHistory 现在会记);② 老条目没有 → 扫存档头的 `· 会话:x · run:y`。
  // 外壳上报"当前活动对话"的 wcId —— 内嵌浏览器的「发给 Agent」据此注进你正在聊的会话。
  // 主进程本来无从得知哪个会话是"当前的"(它只有 wcId↔卡的登记,没有焦点概念)。
  ipcMain.on('shell-active-chat', (_e, wcId) => { const n = +wcId; S.activeChatWc = Number.isFinite(n) ? n : null })

  ipcMain.handle('open-history', (_e, { sid, title }) => {
    const id = String(sid || '')
    let runId = ''
    try { const h = S.history.find((x) => x && x.id === id); if (h && h.runId) runId = String(h.runId) } catch {}
    if (!runId) runId = runIdBySid(id)
    if (runId && S.orch) {
      try {
        const back = S.orch.load(runId)
        if (back) {
          const cid = spawnCard('编排 · ' + String(title || back.goal || '').slice(0, 20), id, null, String(back.goal || title || ''),
            { flash: true, wf: true, orch: true, run: runId })
          try { const reg = S.wfRegistry && S.wfRegistry.get(String(cid)); if (reg) { reg.runId = runId; reg.kind = 'orch' } } catch {}
          try { back.panelCardId = String(cid); back.panelWcId = (S.cardWcById && S.cardWcById.get(String(cid))) != null ? S.cardWcById.get(String(cid)) : null } catch (e) { log('[orch] 回填面板 wcId 失败:' + e.message) }
          log('[orch] 从侧栏历史重开编排卡 ' + runId + '(phase=' + back.phase + ')')
          return cid
        }
        log('[orch] 侧栏历史:' + runId + ' 的存档已不在(可能被 GC),按普通对话开')
      } catch (e) { log('[orch] 侧栏历史重开失败,退回普通对话:' + e.message) }
    }
    return spawnCard(title, id)
  })
  ipcMain.handle('clear-history', () => { S.history = []; saveHistory(); return true })

  return { createBrowser, createWorkspace, createSkillCenter, createMailCenter, createMainWindow, openMailView, spawnCard, spawnWorkflow, spawnEmailCard, snapAsk, buildTray, openDock, openOutbox, openSettings, applyProject, projName, recordHistory, touchHistory, replaceHistoryId }
}
