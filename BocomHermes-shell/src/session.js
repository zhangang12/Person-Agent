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
    for (const name of candidates) {
      try {
        const p = path.join(dir, name)
        if (!fs.existsSync(p)) continue
        const content = fs.readFileSync(p, 'utf8').slice(0, 4000)
        parts.push(`## ${name}\n${content.trim()}`)
        if (parts.join('').length > 5500) break
      } catch {}
    }
    if (!parts.length) return ''
    return `<项目背景>\n以下是当前项目的背景信息，请在后续回答中参考：\n\n${parts.join('\n\n---\n\n')}\n</项目背景>\n\n`
  }

  // ── 事件路由（所有 serve 共用，按 sessionId 路由到对应卡）─────────────────
  function onPermission({ sessionId, requestId, tool, detail }) {
    const si = S.sessionInfo.get(sessionId); if (!si) return
    if (oc.AUTO_ALLOW.has(tool)) { oc.replyPermission(si.serve, sessionId, requestId, 'once'); return }
    if (!si.wc || si.wc.isDestroyed()) { oc.replyPermission(si.serve, sessionId, requestId, 'reject'); return }
    S.pendingPerm.set(requestId, sessionId)
    si.wc.send('permission-request', { requestId, tool, detail: detail || '' })   // detail=要改的文件/要跑的命令，便于知情审批
  }
  function onText({ sessionId, text, role, partID, kind }) {
    const si = S.sessionInfo.get(sessionId); if (!si || !si.wc || si.wc.isDestroyed()) return
    if (role && role !== 'assistant') return
    if (!role && kind !== 'reasoning' && text === S.sentPrompt.get(sessionId)) return
    let buf = S.streamBuf.get(sessionId); if (!buf) { buf = {}; S.streamBuf.set(sessionId, buf) }
    const prev = buf[partID] || ''
    const full = prev && !text.startsWith(prev) ? prev + text : text   // 兼容累积/增量
    buf[partID] = full
    si.wc.send('card-stream', { kind: kind || 'text', text: full, partID })
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
  ipcMain.handle('card-init', async (e, opts) => {
    const sid = opts && opts.sid
    const wantTitle = (opts && opts.title) || ''
    if (sid) {
      const h = S.history.find((x) => x.id === sid)
      const dir = (h && h.dir) || S.settings.projectDir || ''
      const serve = await oc.ensureServe(dir, S.handlers, log)
      const proj = dir ? path.basename(dir) : (S.settings.projectDir ? path.basename(S.settings.projectDir) : '未选目录')
      if (await oc.sessionExists(serve, sid)) {   // 会话还在 → 重连 + 回放（已有历史，不注入上下文）
        S.sessionByWc.set(e.sender.id, sid)
        S.sessionInfo.set(sid, { wc: e.sender, serve })
        S.pushServeHealth && S.pushServeHealth(e.sender, serve)
        touchHistory(sid)
        let messages = []; try { messages = await oc.getMessages(serve, sid) } catch {}
        return { sessionId: sid, project: proj, reattached: true, messages }
      }
      const ns = await oc.createSession(serve, wantTitle || (h && h.title) || 'BocomHermes 对话')  // 已不在 → 新开一段
      if (!ns) throw new Error('create session failed')
      S.sessionByWc.set(e.sender.id, ns)
      S.sessionInfo.set(ns, { wc: e.sender, serve })
      S.pushServeHealth && S.pushServeHealth(e.sender, serve)
      const ctx1 = loadMemory() + loadProjectContext(dir); if (ctx1) S.firstMsgCtx.set(ns, ctx1)
      recordHistory(ns, wantTitle || (h && h.title), dir)
      return { sessionId: ns, project: proj, reattached: false, stale: true }
    }
    const dir = S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话')
    if (!sessionId) throw new Error('create session failed')
    S.sessionByWc.set(e.sender.id, sessionId)
    S.sessionInfo.set(sessionId, { wc: e.sender, serve })
    S.pushServeHealth && S.pushServeHealth(e.sender, serve)
    const ctx0 = loadMemory() + loadProjectContext(dir); if (ctx0) S.firstMsgCtx.set(sessionId, ctx0)
    recordHistory(sessionId, wantTitle, dir)
    return { sessionId, project: S.settings.projectDir ? path.basename(S.settings.projectDir) : '未选目录', reattached: false }
  })

  // 切项目目录后即时重绑本卡:opencode 一个 serve 只认一个 cwd,换项目 = 换 serve + 换会话。
  // 工作台内嵌卡用它实现"切目录立刻生效",不用关掉重开。
  ipcMain.handle('card-reinit', async (e) => {
    const old = S.sessionByWc.get(e.sender.id)
    if (old) {
      const si = S.sessionInfo.get(old)
      if (si) { try { oc.abort(si.serve, old) } catch {} }
      S.sessionInfo.delete(old); S.streamBuf.delete(old); S.sentPrompt.delete(old); S.firstMsgCtx.delete(old)
    }
    S.sessionByWc.delete(e.sender.id)
    const dir = S.settings.projectDir || ''
    const serve = await oc.ensureServe(dir, S.handlers, log)
    const sessionId = await oc.createSession(serve, 'BocomHermes 对话')
    if (!sessionId) throw new Error('create session failed')
    S.sessionByWc.set(e.sender.id, sessionId)
    S.sessionInfo.set(sessionId, { wc: e.sender, serve })
    S.pushServeHealth && S.pushServeHealth(e.sender, serve)
    const ctx = loadMemory() + loadProjectContext(dir); if (ctx) S.firstMsgCtx.set(sessionId, ctx)
    recordHistory(sessionId, 'BocomHermes 对话', dir)
    log('card-reinit → [' + (dir || '(home)') + '] session ' + sessionId)
    return { sessionId, project: dir ? path.basename(dir) : '未选目录' }
  })

  ipcMain.handle('card-send', async (e, text) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (!si) throw new Error('session not ready')
    // 首条消息：静默注入项目上下文前缀（用户看到原文，Serve 收到"背景+原文"）
    const ctxPrefix = S.firstMsgCtx.get(sessionId) || ''
    if (ctxPrefix) { S.firstMsgCtx.delete(sessionId); log('inject project context (' + ctxPrefix.length + ' chars) for ' + sessionId) }
    const msg = ctxPrefix ? ctxPrefix + text : text
    S.sentPrompt.set(sessionId, text); S.streamBuf.delete(sessionId)
    touchHistory(sessionId)
    try { return await oc.sendMessage(si.serve, sessionId, msg) }
    catch (err) {
      const m = String((err && err.message) || err)
      if (/ECONNREFUSED|ECONNRESET|socket hang up|ENOTFOUND|EPIPE|fetch failed/i.test(m))
        throw new Error('引擎连接中断（serve 可能已退出）。关掉这张卡重开即可（已自动准备重启 serve）。')
      throw err
    }
  })

  ipcMain.on('card-abort', (e) => {
    const sessionId = S.sessionByWc.get(e.sender.id); const si = sessionId && S.sessionInfo.get(sessionId)
    if (si) oc.abort(si.serve, sessionId)
  })

  ipcMain.on('permission-reply', (_e, { requestId, decision }) => {
    const sessionId = S.pendingPerm.get(requestId); S.pendingPerm.delete(requestId)
    const si = sessionId && S.sessionInfo.get(sessionId)
    if (si) oc.replyPermission(si.serve, sessionId, requestId, decision === 'always' ? 'always' : decision === 'once' ? 'once' : 'reject')
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
    return applyDiffToDisk(baseDir, String(diffText || ''))
  })
}
