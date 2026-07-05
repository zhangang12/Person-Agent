// 【MCP 一键注册】把 BocomHermes 自带的 8 个本地 MCP server 写进 opencode/bocomcode 配置文件。
// 从 window.js 整块搬来,做成 initMcpConfig(ctx) 工厂——只搬不改。纯自足:只用 app/path/fs/ipcMain/log,
// 不碰 S、不引用 window.js 内其它函数。注册两个 ipcMain 处理器(mcp-register-status / mcp-register)。
'use strict'
module.exports = function initMcpConfig(ctx) {
  const { app, path, fs, ipcMain, log } = ctx
  // ── MCP 一键注册到 opencode/bocomcode 配置文件 ────────────────────────────
  // 扫描候选路径 → 让前端展示 → 用户挑一个 → 备份 + 深合并 mcp.* 字段 + 写回
  function mcpBaseDir() {
    // dev: BocomHermes-shell/mcp/;packaged: <install>/resources/app.asar.unpacked/mcp/
    const appPath = app.getAppPath()
    const base = appPath.endsWith('app.asar')
      ? path.join(path.dirname(appPath), 'app.asar.unpacked')
      : appPath
    return path.join(base, 'mcp').replace(/\\/g, '/')
  }
  function mcpEntries() {
    const b = mcpBaseDir()
    return {
      'BocomHermes-browser': { type: 'local', command: ['node', b + '/browser-mcp.mjs'], enabled: true, environment: { BOCOMHERMES_BROWSER_HEADFUL: '0' } },
      'BocomHermes-httpcap': { type: 'local', command: ['node', b + '/httpcap-mcp.mjs'], enabled: true },
      'BocomHermes-git':     { type: 'local', command: ['node', b + '/git-mcp.mjs'],     enabled: true },
      'BocomHermes-repro':   { type: 'local', command: ['node', b + '/repro-mcp.mjs'],   enabled: true },
      'BocomHermes-mail':    { type: 'local', command: ['node', b + '/mail-mcp.mjs'],    enabled: true },
      'BocomHermes-db':      { type: 'local', command: ['node', b + '/db-mcp.mjs'],      enabled: true },
      'BocomHermes-orch':    { type: 'local', command: ['node', b + '/orch-mcp.mjs'],    enabled: true },
      'BocomHermes-doc':     { type: 'local', command: ['node', b + '/doc-mcp.mjs'],     enabled: true },
    }
  }
  function configCandidates() {
    const home = app.getPath('home')
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const explicit = [process.env.OPENCODE_CONFIG, process.env.BOCOMCODE_CONFIG].filter(Boolean)
    // 注意:opencode/bocomcode 实际常用 opencode.jsonc(带注释),.jsonc 优先于 .json,
    // 否则"自动注册"会新建一个 serve 根本不读的 .json,等于没注册(两文件打架)。
    return [
      ...explicit,
      path.join(appData, 'opencode', 'opencode.jsonc'),
      path.join(appData, 'opencode', 'opencode.json'),
      path.join(appData, 'bocomcode', 'opencode.jsonc'),
      path.join(appData, 'bocomcode', 'opencode.json'),
      path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      path.join(home, '.config', 'opencode', 'opencode.json'),
      path.join(home, '.config', 'bocomcode', 'opencode.jsonc'),
      path.join(home, '.config', 'bocomcode', 'opencode.json'),
      path.join(home, '.opencode.jsonc'),
      path.join(home, '.opencode.json'),
      path.join(home, '.bocomcode.jsonc'),
      path.join(home, '.bocomcode.json'),
    ]
  }
  ipcMain.handle('mcp-register-status', () => {
    const cands = configCandidates().map((p) => {
      const exists = fs.existsSync(p)
      let hasOur = false, parseErr = null
      if (exists) {
        try { const cfg = JSON.parse(fs.readFileSync(p, 'utf8')); hasOur = !!(cfg && cfg.mcp && cfg.mcp['BocomHermes-mail']) }
        catch (e) { parseErr = e.message }
      }
      return { path: p, exists, hasOur, parseErr }
    })
    return { candidates: cands, entries: Object.keys(mcpEntries()), mcpBaseDir: mcpBaseDir() }
  })
  ipcMain.handle('mcp-register', async (_e, targetPath) => {
    const entries = mcpEntries()
    let target = targetPath
    if (!target) {
      // 自动选:已存在的优先;否则默认 %APPDATA%/opencode/opencode.json
      const cands = configCandidates()
      target = cands.find((p) => fs.existsSync(p)) || cands[1]
    }
    if (!target) throw new Error('找不到可写入的配置路径')
    try { fs.mkdirSync(path.dirname(target), { recursive: true }) } catch {}
    let existing = {}, backup = null
    if (fs.existsSync(target)) {
      try { existing = JSON.parse(fs.readFileSync(target, 'utf8')) || {} }
      catch (e) { throw new Error('已有 ' + target + ' 但 JSON 解析失败,人工修一下再试: ' + e.message) }
      backup = target + '.bak.' + Date.now()
      try { fs.copyFileSync(target, backup) } catch (e) { log('mcp register backup err: ' + e.message) }
    }
    if (!existing.$schema) existing.$schema = 'https://opencode.ai/config.json'
    existing.mcp = existing.mcp || {}
    const overwritten = []
    for (const [k, v] of Object.entries(entries)) {
      if (existing.mcp[k]) overwritten.push(k)
      existing.mcp[k] = v
    }
    fs.writeFileSync(target, JSON.stringify(existing, null, 2))
    log('mcp register: wrote ' + Object.keys(entries).length + ' entries to ' + target + (backup ? ' (backup ' + backup + ')' : ''))
    return { ok: true, path: target, backup, added: Object.keys(entries), overwritten }
  })
}
