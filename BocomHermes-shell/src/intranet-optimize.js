// 【内网 serve 优化配置】"内网×弱模型"静态优化包:写 opencode/bocomcode 配置(备份+合并) + PATCH /config 热应用。
// 内容(依据 external/claude-code-借鉴总清单.md C1-C3、提示词借鉴 §6):
//   ① tools 瘦身:webfetch/websearch/codesearch:false —— 内网无外网,注定失败的工具从工具表删掉(= 模型不可见级 deny)
//   ② permission.bash 命令通配:静态默认(git/npm 放,rm -rf/curl/wget 拒) + 合并用户 settings.permRules 里的 bash 条(用户意图优先)
//   ③ agent.explore.maxSteps:30 —— 弱模型防绕圈(已配置的不覆盖)
// 热应用:PATCH /config 在本机 opencode 1.18.3 已实测真热生效(scripts/config-patch-probe.mjs --behavior);
//   fork 不保证——PATCH 失败只记日志,配置仍落盘(重启 serve 生效),两条路都不伤。
// 与 mcp-config.js 同款候选路径/备份风格;纯自足,不碰 window.js 内其它函数。
'use strict'
module.exports = function initIntranetOptimize(ctx) {
  const { app, path, fs, ipcMain, log, getPermRules, getServeBases } = ctx

  function configCandidates() {
    const home = app.getPath('home')
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const explicit = [process.env.OPENCODE_CONFIG, process.env.BOCOMCODE_CONFIG].filter(Boolean)
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

  // 用户权限规则(settings.permRules)里的 bash 条 → serve permission.bash map 语法
  function userBashRules() {
    const out = {}
    const pr = (getPermRules && getPermRules()) || {}
    for (const kind of ['allow', 'deny']) {
      for (const r of (Array.isArray(pr[kind]) ? pr[kind] : [])) {
        const m = String(r).trim().match(/^bash\(([\s\S]*)\)$/i)
        if (m && m[1].trim()) out[m[1].trim()] = kind
      }
    }
    return out
  }

  // 合并优化包进已有配置对象(就地改;已存在的自定义一律保留,用户规则优先级最高)
  function applyBlock(cfg, uBash) {
    cfg.tools = Object.assign({}, (cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {}), { webfetch: false, websearch: false, codesearch: false })
    cfg.permission = (cfg.permission && typeof cfg.permission === 'object') ? cfg.permission : {}
    const curBash = (cfg.permission.bash && typeof cfg.permission.bash === 'object' && !Array.isArray(cfg.permission.bash)) ? cfg.permission.bash : {}
    cfg.permission.bash = Object.assign({ 'git *': 'allow', 'npm run *': 'allow', 'rm -rf*': 'deny', 'curl *': 'deny', 'wget *': 'deny' }, curBash, uBash)
    cfg.agent = (cfg.agent && typeof cfg.agent === 'object') ? cfg.agent : {}
    cfg.agent.explore = Object.assign({ maxSteps: 30 }, (cfg.agent.explore && typeof cfg.agent.explore === 'object' ? cfg.agent.explore : {}))
    if (!cfg.agent.explore.maxSteps) cfg.agent.explore.maxSteps = 30
    return cfg
  }

  function inspect(cfg) {
    const c = cfg || {}
    return {
      toolsLean: !!(c.tools && c.tools.webfetch === false),
      bashRules: !!(c.permission && c.permission.bash && typeof c.permission.bash === 'object' && Object.keys(c.permission.bash).length),
      exploreSteps: !!(c.agent && c.agent.explore && c.agent.explore.maxSteps),
    }
  }

  ipcMain.handle('intranet-optimize-status', () => {
    const cands = configCandidates().map((p) => {
      const exists = fs.existsSync(p)
      let applied = null, parseErr = null
      if (exists) {
        try { applied = inspect(JSON.parse(fs.readFileSync(p, 'utf8'))) }
        catch (e) { parseErr = e.message }
      }
      return { path: p, exists, applied, parseErr }
    })
    return { candidates: cands }
  })

  async function patchToBase(base, body) {
    try {
      const r = await fetch(base + '/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return r.status < 400
    } catch { return false }
  }

  ipcMain.handle('intranet-optimize-apply', async () => {
    try {
      const cands = configCandidates()
      const target = cands.find((p) => fs.existsSync(p)) || cands[1]
      if (!target) throw new Error('找不到可写入的配置路径')
      try { fs.mkdirSync(path.dirname(target), { recursive: true }) } catch {}
      let existing = {}, backup = null
      if (fs.existsSync(target)) {
        try { existing = JSON.parse(fs.readFileSync(target, 'utf8')) || {} }
        catch (e) { throw new Error('已有 ' + target + ' 但 JSON 解析失败,人工修一下再试: ' + e.message) }
        backup = target + '.bak.' + Date.now()
        try { fs.copyFileSync(target, backup) } catch (e) { log('intranet-optimize backup err: ' + e.message) }
      }
      if (!existing.$schema) existing.$schema = 'https://opencode.ai/config.json'
      const merged = applyBlock(existing, userBashRules())
      fs.writeFileSync(target, JSON.stringify(merged, null, 2))
      log('intranet-optimize: wrote ' + target + (backup ? ' (backup ' + backup + ')' : ''))
      // 热应用:对正在跑的会话所属 serve PATCH 同一份配置(本机 1.18.3 实测热生效;失败只记日志,重启 serve 后照样生效)
      const bases = (getServeBases && getServeBases()) || []
      const patched = [], cold = []
      for (const b of bases) { (await patchToBase(b, merged)) ? patched.push(b) : cold.push(b) }
      if (bases.length) log('intranet-optimize: PATCH hot-apply ok=' + patched.length + ' fail=' + cold.length)
      return { ok: true, path: target, backup, patched, cold, applied: inspect(merged) }
    } catch (e) { return { ok: false, error: e.message } }
  })

  return {}
}
