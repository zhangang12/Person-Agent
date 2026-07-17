'use strict'
const { exec } = require('child_process')

module.exports = function initSession(S, { ipcMain, path, fs, shell, oc, log, recordHistory, touchHistory }) {
  // ── 个人记忆库 ──────────────────────────────────────────────────────────────
  const memoryFile = path.join(require('electron').app.getPath('userData'), 'memory.md')
  function loadMemory() {
    try { const t = fs.readFileSync(memoryFile, 'utf8').trim(); return t ? `<个人记忆>\n${t}\n</个人记忆>\n\n` : '' } catch { return '' }
  }
  ipcMain.handle('memory-read', () => { try { return fs.readFileSync(memoryFile, 'utf8') } catch { return '' } })
  ipcMain.handle('memory-write', (_e, text) => { try { fs.writeFileSync(memoryFile, text, 'utf8'); return true } catch { return false } })

  // ── 项目上下文注入 ──────────────────────────────────────────────────────────
  function loadProjectContext(dir) {
    if (!dir) return ''
    const candidates = ['CLAUDE.md', 'claude.md', 'README.md', 'readme.md', 'README']
    const parts = []
    const seen = new Set()
    for (const name of candidates) {
      try {
        const p = path.join(dir, name)
        const key = p.toLowerCase()   // Windows 大小写不敏感:README.md 与 readme.md 命中同一文件 → 去重,别注入两遍
        if (seen.has(key)) continue
        seen.add(key)
        if (!fs.existsSync(p)) continue
        const content = fs.readFileSync(p, 'utf8').slice(0, 4000)
        parts.push(`## ${name}\n${content.trim()}`)
        if (parts.join('').length > 5500) break
      } catch {}
    }
    // 显式锚定工作目录(唯一真相源):外部/global 模式的 serve 常忽略会话级 ?directory=,模型会漂到
    // 其它项目路径(如桌面同级目录)。用强指令把它钉在当前项目 —— 也会传导到它派生的 task 子agent的探索路径。
    const anchor = `当前项目工作目录（唯一真相源）：${dir}\n`
      + `分析、探索、读写代码时一律在此目录内进行;不要访问或分析其它路径下的项目/目录。\n`
    const body = parts.length ? ('\n以下是本项目的说明文档,供参考:\n\n' + parts.join('\n\n---\n\n')) : ''
    return `<项目背景>\n${anchor}${body}</项目背景>\n\n`
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
  S.dropPendingPerm = (sessionId) => {
    if (!sessionId) return
    for (const [k, v] of S.pendingPerm) {
      if (v === sessionId) { S.pendingPerm.delete(k); S.pendingPerm.delete(k + ':meta') }   // k=requestId → v=sessionId;:meta 是同 requestId 的伴生键
    }
  }

  // ── 事件路由（所有 serve 共用，按 sessionId 路由到对应卡）─────────────────
  function onPermission({ sessionId, requestId, tool, detail }) {
    const si = S.sessionInfo.get(sessionId); if (!si) return
    if (oc.AUTO_ALLOW.has(tool)) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    // 天枢技能工具族(skill_*):回放接管/断点解析的 MCP 工具,引擎侧已有门禁(如 page_act 仅接管期可执行),
    // 不再叠人工审批 —— 否则 Agent 接管每一步都弹批准框,混合执行没法用。MCP 工具名可能带服务前缀,按含 skill_ 匹配。
    if (/(^|[._-])skill_/.test(String(tool || ''))) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    if (!si.wc || si.wc.isDestroyed()) { oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return }
    S.pendingPerm.set(requestId, sessionId)
    S.pendingPerm.set(requestId + ':meta', { tool, detail: detail || '' })   // 供审计留痕(批准/拒绝了什么)
    // 「在等人批准」要记账:lastAt 只在 onText 打点,弹了审批框之后整个等人窗口期时间戳是冻结的 →
    // 工作流的空转看门狗(src/orch.js)会把"用户去吃饭了"当成黑洞,20 分钟(高读会话 6 分钟)后把会话杀掉,
    // 还报"连续 20 分钟无任何活动"。等人不是空转,看门狗见 awaitPerm>0 就不判死(用户随时可以点停止)。
    si.lastAt = Date.now()
    si.awaitPerm = (si.awaitPerm || 0) + 1
    si.wc.send('permission-request', { requestId, tool, detail: detail || '' })   // detail=要改的文件/要跑的命令，便于知情审批
  }
  function onText({ sessionId, text, role, partID, kind, status, delta, toolInput, toolOutput, toolTitle, toolError, subagent, agentId, agentName, taskChild, taskDesc }) {
    const si = S.sessionInfo.get(sessionId); if (!si || !si.wc || si.wc.isDestroyed()) return
    si.lastAt = Date.now()   // 流活动时间戳:工作流空转看门狗据此判"会话是否还活着"(慢≠死,有动静就不杀)
    if (role && role !== 'assistant') return
    const tag = si.tag || null   // 登记方自定义的任务身份(scope/kind/id…)：随 card-stream 下发,窗口按并发任务分组(监控组件 agentmon)
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
      si.wc.send('card-stream', { kind: 'tool', text, partID, status: status || '', input: toolInput, output: toolOutput, title: toolTitle, error: toolError, sub: !!subagent, agentId: agentId || '', agentName: agentName || '', taskChild: taskChild || '', taskDesc: taskDesc || '', readN, sessionId, tag }); return
    }
    if (!subagent && !role && kind !== 'reasoning' && text === S.sentPrompt.get(sessionId)) return   // "回显自己prompt"过滤只对父会话
    let buf = S.streamBuf.get(sessionId); if (!buf) { buf = {}; S.streamBuf.set(sessionId, buf) }
    const prev = buf[partID] || ''
    // delta=true（message.part.delta）始终追加；快照按"是否累积前缀"判断累积/增量
    const full = delta ? (prev + text) : (prev && !text.startsWith(prev) ? prev + text : text)
    buf[partID] = full
    si.wc.send('card-stream', { kind: kind || 'text', text: full, partID, sub: !!subagent, agentId: agentId || '', agentName: agentName || '', sessionId, tag })
  }
  S.handlers = { onPermission, onText }

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

  // ── IPC ─────────────────────────────────────────────────────────────────────
  // per-card 状态(按 webContents 存,比 sessionInfo 长寿 —— 跨 init/reinit 存活):
  //   S.cardDir:  wcId → 本卡绑定的项目目录(不动全局 projectDir)
  //   S.modelByWc: wcId → 本卡选的模型({providerID,modelID,name} | null=serve默认)
  if (!S.cardDir) S.cardDir = new Map()
  if (!S.modelByWc) S.modelByWc = new Map()
  // 会话就绪/重建时把 per-card 模型回放进 sessionInfo;返回给 UI 的是"实际生效"的模型
  function replayModel(wcId, sid) {
    const si = S.sessionInfo.get(sid); if (!si) return null
    const mw = S.modelByWc.get(wcId)
    if (mw !== undefined) si.model = mw
    else { const h = S.history.find((x) => x.id === sid); if (h && h.model) si.model = h.model }   // 卡坞续接:恢复当初那张卡选的模型
    return si.model || S.settings.model || null
  }
  ipcMain.handle('card-init', async (e, opts) => {
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
        const model = replayModel(e.sender.id, sid)
        S.pushServeHealth && S.pushServeHealth(e.sender, serve)
        touchHistory(sid)
        let messages = []; try { messages = await oc.getMessages(serve, sid) } catch {}
        return { sessionId: sid, project: proj, dir, model, reattached: true, messages }
      }
      const ns = await oc.createSession(serve, wantTitle || (h && h.title) || 'BocomHermes 对话', dir)  // 已不在 → 新开一段(带项目目录)
      if (!ns) throw new Error('create session failed')
      S.sessionByWc.set(e.sender.id, ns)
      S.sessionInfo.set(ns, { wc: e.sender, serve })
      const model1 = replayModel(e.sender.id, ns)
      S.pushServeHealth && S.pushServeHealth(e.sender, serve)
      const ctx1 = loadMemory() + loadProjectContext(dir); if (ctx1) S.firstMsgCtx.set(ns, ctx1)
      recordHistory(ns, wantTitle || (h && h.title), dir)
      return { sessionId: ns, project: proj, dir, model: model1, reattached: false, stale: true }
    }
    const dir = S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话', dir)
    if (!sessionId) throw new Error('create session failed')
    S.sessionByWc.set(e.sender.id, sessionId)
    S.sessionInfo.set(sessionId, { wc: e.sender, serve })
    const model0 = replayModel(e.sender.id, sessionId)
    S.pushServeHealth && S.pushServeHealth(e.sender, serve)
    const ctx0 = loadMemory() + loadProjectContext(dir); if (ctx0) S.firstMsgCtx.set(sessionId, ctx0)
    recordHistory(sessionId, wantTitle, dir)
    return { sessionId, project: dir ? path.basename(dir) : '未选目录', dir, model: model0, reattached: false }
  })

  // 切项目目录后即时重绑本卡:opencode 一个 serve 只认一个 cwd,换项目 = 换 serve + 换会话。
  // opts.dir = 本卡要切到的目录(仅影响本卡,不动全局);不传则用本卡已绑目录/全局默认。
  ipcMain.handle('card-reinit', async (e, opts) => {
    const old = S.sessionByWc.get(e.sender.id)
    let oldServe = null
    if (old) {
      const si = S.sessionInfo.get(old)
      if (si) { oldServe = si.serve; try { oc.abort(si.serve, old) } catch {} }
      S.sessionInfo.delete(old); S.streamBuf.delete(old); S.sentPrompt.delete(old); S.firstMsgCtx.delete(old)
    }
    S.sessionByWc.delete(e.sender.id)
    if (opts && opts.dir) S.cardDir.set(e.sender.id, String(opts.dir))
    const dir = (opts && opts.dir) || S.cardDir.get(e.sender.id) || S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)   // requireDirMatch 默认开:cwd 不符不共享,自起独立 serve
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话', dir)
    if (!sessionId) throw new Error('create session failed')
    S.sessionByWc.set(e.sender.id, sessionId)
    S.sessionInfo.set(sessionId, { wc: e.sender, serve })
    const model = replayModel(e.sender.id, sessionId)
    S.pushServeHealth && S.pushServeHealth(e.sender, serve)
    // carryCtx=压缩续聊的接力摘要:上一段对话的要点随首条消息带进新会话(用户气泡不显示,回放展示层会剥)
    const carry = opts && typeof opts.carryCtx === 'string' && opts.carryCtx.trim() ? '<上轮对话接力摘要>\n' + opts.carryCtx.trim().slice(0, 20000) + '\n</上轮对话接力摘要>\n\n' : ''
    const ctx = loadMemory() + loadProjectContext(dir) + carry; if (ctx) S.firstMsgCtx.set(sessionId, ctx)
    recordHistory(sessionId, 'BocomHermes 对话', dir)
    // 旧 serve 若已无任何会话引用且是自起的 → 退休,不留孤儿进程
    if (oldServe && oldServe !== serve) {
      const inUseBases = new Set([...S.sessionInfo.values()].map((si) => si.serve && si.serve.base).filter(Boolean))
      try { if (oc.retireIfOrphan(oldServe, inUseBases)) log('card-reinit: 旧 serve ' + oldServe.base + ' 已退休(无会话引用)') } catch {}
    }
    log('card-reinit → [' + (dir || '(home)') + '] session ' + sessionId)
    return { sessionId, project: dir ? path.basename(dir) : '未选目录', dir, model }
  })

  ipcMain.handle('card-send', async (e, arg) => {
    const { text, files, skill } = (typeof arg === 'string') ? { text: arg } : (arg || {})   // 兼容老调用(纯字符串)与新 {text, files, skill}
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (!si) throw new Error('session not ready')
    // 首条消息：静默注入项目上下文前缀（用户看到原文，Serve 收到"背景+原文"）
    const ctxPrefix = S.firstMsgCtx.get(sessionId) || ''
    if (ctxPrefix) {
      S.firstMsgCtx.delete(sessionId); log('inject project context (' + ctxPrefix.length + ' chars) for ' + sessionId)
      // 后台动作可视化:注入了什么背景要让用户在对话里看得见(一行灰字),不能只躺在日志里
      try { if (!e.sender.isDestroyed()) e.sender.send('card-note', { text: '已随首条消息注入背景：个人记忆 + 项目上下文（' + ctxPrefix.length + ' 字）', tone: 'muted' }) } catch {}
    }
    // 作答技能：选中的技能把方法论指令静默预置到用户原文前（用户气泡仍显示原文）
    let skillPrefix = ''
    if (skill) { const sk = loadSkills().find((s) => s.id === skill); if (sk) { skillPrefix = '<作答技能:' + sk.name + '>\n' + sk.body + '\n</作答技能>\n\n'; log('inject skill 「' + sk.name + '」(' + sk.body.length + ' chars) for ' + sessionId) } }
    const msg = ctxPrefix + skillPrefix + (text || '')
    S.sentPrompt.set(sessionId, msg); S.streamBuf.delete(sessionId)   // 存【实际发出的全文】(含注入前缀):回显过滤比对的是 serve 收到的东西 —— 只存原文的话,带前缀的回显漏网,整坨背景提示词会打进对话流
    touchHistory(sessionId)
    let model = si.model || S.settings.model || null
    const fileArr = Array.isArray(files) ? files : []
    const hasImage = fileArr.some((f) => f && /^image\//.test(f.mime || ''))
    if (hasImage) {                                   // 有图 → 确保用支持图像的模型(动态切多模态)
      try {
        const models = await oc.listModels(si.serve)
        const cur = model && models.find((m) => m.providerID === model.providerID && m.modelID === model.modelID)
        if (!cur || !cur.image) {
          const v = models.find((m) => m.image)
          if (v) { model = { providerID: v.providerID, modelID: v.modelID, name: v.name }; if (!si.wc.isDestroyed()) si.wc.send('card-note', { text: '检测到图片，已临时切到多模态模型「' + v.name + '」识别', tone: 'muted' }) }
        }
      } catch {}
    }
    const onNote = (t) => { try { if (!si.wc.isDestroyed()) si.wc.send('card-note', { text: t, tone: 'muted' }) } catch {} }
    try { return await oc.sendMessage(si.serve, sessionId, msg, model, fileArr, onNote) }
    catch (err) {
      const m = String((err && err.message) || err)
      if (/ECONNREFUSED|ECONNRESET|socket hang up|ENOTFOUND|EPIPE|fetch failed/i.test(m))
        throw new Error('引擎连接中断（serve 可能已退出）。关掉这张卡重开即可（已自动准备重启 serve）。')
      throw err
    }
  })

  // 模型选择:列出可用模型 + 设置本卡模型(每个模块各自选)
  ipcMain.handle('list-models', async (e) => {
    const tryServe = async (serve) => { if (!serve || !serve.base) return []; try { return await oc.listModels(serve) } catch { return [] } }
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    let out = await tryServe(si && si.serve)                                        // 先用本卡的 serve
    if (!out.length) { try { out = await tryServe(await oc.ensureServe(S.settings.projectDir || '', S.handlers, log)) } catch {} }   // 拿不到 → 退到项目 serve(对话坞/嵌入卡也能列)
    return out
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

  ipcMain.on('permission-reply', (_e, { requestId, decision }) => {
    const sessionId = S.pendingPerm.get(requestId); const meta = S.pendingPerm.get(requestId + ':meta'); S.pendingPerm.delete(requestId); S.pendingPerm.delete(requestId + ':meta')
    const si = sessionId && S.sessionInfo.get(sessionId)
    const d = decision === 'always' ? 'always' : decision === 'once' ? 'once' : 'reject'
    if (si) { si.awaitPerm = Math.max(0, (si.awaitPerm || 1) - 1); si.lastAt = Date.now() }   // 人答完了:解除"等人"记账,空转计时从此刻重新起算(别把等人那段算进空转)
    if (si) oc.replyPermission(si.serve, sessionId, requestId, d)
    // 审计:写/执行类操作的人工批准(工具+目标),reject 也记(留痕拒绝)
    try { S.audit && S.audit('permission', (d === 'reject' ? '拒绝' : '批准' + (d === 'always' ? '(总是)' : '')) + '权限:' + ((meta && meta.tool) || '?'), { decision: d, tool: meta && meta.tool, detail: (meta && meta.detail || '').slice(0, 300), sessionId }) } catch {}
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
