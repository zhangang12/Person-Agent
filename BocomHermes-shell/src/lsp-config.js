// 【LSP 一键注册】把随应用打包的三个 node 系 LSP server(typescript-language-server / @vue/language-server / pyright)
// 写进 opencode/bocomcode 配置的 lsp 段 —— 内网无外网,opencode 内置 server 的"探测不到就联网安装"必失败,
// 代码智能(跳转/引用/诊断)全靠随包自带。
// 方案(调研结论):command[0] 用 Electron 自己的 process.execPath(开发=electron.exe,打包=BocomHermes.exe),
// env 塞 ELECTRON_RUN_AS_NODE=1 → exe 当纯 Node 用,目标机器没有独立 Node 也能跑;
// 三个包必须 asarUnpack(spawn 要读到实体文件,asar 里读不到);配置覆盖 opencode 同名内置定义,其余内置 server
// which 失败静默跳过,另有 serve spawn 恒设 OPENCODE_DISABLE_LSP_DOWNLOAD=true 兜底(opencode.js spawnServe)。
// 模式与 mcp-config.js 一致:候选路径扫描(.jsonc 优先) + 备份 + 深合并 lsp 段;只在缺失/路径过期时写。
// 开关:settings.lspEnabled === false 时整体不注册(装包体积换基础设施,默认开)。
'use strict'
module.exports = function initLspConfig(ctx) {
  const { app, path, fs, log, isEnabled } = ctx
  // 随包 node_modules 根:dev = 仓库根;packaged = resources/app.asar.unpacked
  function nodeBase() {
    const appPath = app.getAppPath()
    const base = appPath.endsWith('app.asar')
      ? path.join(path.dirname(appPath), 'app.asar.unpacked')
      : appPath
    return base.replace(/\\/g, '/')
  }
  function lspEntries() {
    const b = nodeBase() + '/node_modules'
    const exe = process.execPath.replace(/\\/g, '/')
    const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }
    return {
      typescript: {
        command: [exe, b + '/typescript-language-server/lib/cli.mjs', '--stdio'],
        env: NODE_ENV,
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
        initialization: { tsserver: { path: b + '/typescript/lib/tsserver.js' } },
      },
      vue: {
        command: [exe, b + '/@vue/language-server/bin/vue-language-server.js', '--stdio'],
        env: NODE_ENV,
        extensions: ['.vue'],
      },
      pyright: {
        command: [exe, b + '/pyright/langserver.index.js', '--stdio'],
        env: NODE_ENV,
        extensions: ['.py', '.pyi'],
      },
    }
  }
  // 与 mcp-config.js 同一份候选清单(.jsonc 优先;显式环境变量最优先)——两处各自拷贝,保持模块自足
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
  function doRegister(targetPath) {
    const entries = lspEntries()
    let target = targetPath
    if (!target) {
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
      try { fs.copyFileSync(target, backup) } catch (e) { log('lsp register backup err: ' + e.message) }
    }
    existing.lsp = existing.lsp || {}
    for (const [k, v] of Object.entries(entries)) existing.lsp[k] = v
    fs.writeFileSync(target, JSON.stringify(existing, null, 2))
    log('lsp register: wrote ' + Object.keys(entries).length + ' servers to ' + target + (backup ? ' (backup ' + backup + ')' : ''))
    return { ok: true, path: target, backup }
  }
  // 启动自动注册:缺失 / 路径过期(换安装目录、dev↔打包切换)才写,带备份。settings.lspEnabled=false 整体跳过。
  function autoRegisterIfMissing() {
    try {
      if (typeof isEnabled === 'function' && !isEnabled()) return { ok: true, skipped: true }
      const base = nodeBase()
      for (const p of configCandidates()) {
        if (!fs.existsSync(p)) continue
        try {
          const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
          const ent = cfg && cfg.lsp && cfg.lsp.typescript
          if (ent) {
            const cmd = Array.isArray(ent.command) ? ent.command.join(' ') : ''
            if (cmd.includes(base)) return { ok: true, already: true, path: p }
            log('lsp auto-register: 已注册但路径过期(' + cmd.slice(0, 80) + '),按当前目录重写')
            return doRegister(p)
          }
        } catch {}
      }
      return doRegister()
    } catch (e) { log('lsp auto-register err: ' + e.message); return { ok: false, error: e.message } }
  }
  return { autoRegisterIfMissing }
}
