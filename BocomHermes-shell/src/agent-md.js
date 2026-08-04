// 【AGENTS.md 生成器】扫项目清单文件(package.json/pom.xml/pytest/go.mod/Cargo/Makefile),起草"怎么构建/测试/验证"
// 的 AGENTS.md —— serve 原生读 AGENTS.md 并注入每个会话(含 task 子 Agent)的系统上下文,模型不用现摸验证方式。
// 写法纪律(依据 external/claude-code-测试手段借鉴.md §0,CC /init 同款):
//   ① 只写可执行事实(命令/路径/URL),不写规范口号("要写测试"这类条款 CC 明确禁止);
//   ② 每行都要过"删掉会让 Agent 犯错吗"的秤,过不去就删;
//   ③ 不编造 —— 检测不到的一律写「待确认」由人补,别替项目瞎猜。
'use strict'
module.exports = function initAgentMd(ctx) {
  const { app, path, fs, ipcMain, log } = ctx

  // ── 检测:把已知清单文件翻成候选命令(只检测不执行,全部有防御) ──
  function detectProject(dir) {
    const d = { dir, name: path.basename(dir), eco: [], build: [], test: [], singleTest: [], lint: [], devCmd: [], devUrl: '', api: [], notes: [] }
    const has = (rel) => { try { return fs.existsSync(path.join(dir, rel)) } catch { return false } }
    const readJ = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) } catch { return null } }
    // Node/前端
    const pkg = readJ('package.json')
    if (pkg) {
      d.eco.push('node')
      const sc = pkg.scripts || {}
      const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies)
      for (const k of ['build']) if (sc[k]) d.build.push('npm run ' + k)
      for (const k of ['typecheck', 'tsc', 'lint', 'check']) if (sc[k]) d.lint.push('npm run ' + k)
      for (const k of ['test', 'test:unit']) if (sc[k]) d.test.push(k === 'test' ? 'npm test' : 'npm run ' + k)
      if (deps.vitest) d.singleTest.push('npx vitest run <文件路径>')
      else if (deps.jest) d.singleTest.push('npx jest <测试名或文件路径>')
      else if (deps.mocha) d.singleTest.push('npx mocha <文件路径>')
      for (const k of ['dev', 'start', 'serve']) if (sc[k]) d.devCmd.push('npm run ' + k)
      if (/vue|nuxt/i.test(JSON.stringify(deps))) d.eco.push('vue')
      if (/react|next/i.test(JSON.stringify(deps))) d.eco.push('react')
    }
    // Java/Maven(内网常见)
    if (has('pom.xml')) {
      d.eco.push('java-maven')
      const mvn = has('mvnw') ? './mvnw' : 'mvn'
      d.build.push(mvn + ' -q compile')
      d.test.push(mvn + ' test')
      d.singleTest.push(mvn + ' -Dtest=<类名> test')
      try {
        const pom = fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8')
        if (/spring-boot/.test(pom)) d.devCmd.push(mvn + ' spring-boot:run')
      } catch {}
    }
    if (has('build.gradle') || has('build.gradle.kts')) {
      d.eco.push('java-gradle')
      d.test.push('gradle test'); d.singleTest.push('gradle test --tests <类名>')
    }
    // Python
    if (has('pytest.ini') || has('tox.ini') || has('pyproject.toml') || has('setup.cfg')) {
      const pyproj = readJ('pyproject.toml')
      if (has('pytest.ini') || has('tox.ini') || (pyproj && pyproj.tool && pyproj.tool.pytest) || has('setup.cfg')) {
        d.eco.push('python')
        d.test.push('pytest'); d.singleTest.push("pytest -k '<关键字>' 或 pytest <文件>::<用例名>")
      }
    }
    // Go / Rust
    if (has('go.mod')) { d.eco.push('go'); d.test.push('go test ./...'); d.singleTest.push('go test -run <名字> ./...') }
    if (has('Cargo.toml')) { d.eco.push('rust'); d.test.push('cargo test'); d.singleTest.push('cargo test <名字>') }
    // Makefile
    if (has('Makefile')) {
      try {
        const mk = fs.readFileSync(path.join(dir, 'Makefile'), 'utf8')
        const targets = [...mk.matchAll(/^([a-zA-Z_-]+)\s*:/gm)].map((m) => m[1])
        for (const t of ['build', 'test', 'lint', 'dev', 'run']) {
          if (targets.includes(t)) { const cmd = 'make ' + t; if (t === 'build') d.build.push(cmd); else if (t === 'test') d.test.push(cmd); else if (t === 'lint') d.lint.push(cmd); else d.devCmd.push(cmd) }
        }
      } catch {}
    }
    // 现成文档线索(别重复发明):README 里的端口/启动提示 → 只作 notes 提示人确认
    for (const rn of ['CLAUDE.md', 'README.md', 'readme.md']) {
      if (has(rn)) { d.notes.push('已有 ' + rn + '(检测时未解析,若与本文件冲突以人审为准)'); break }
    }
    return d
  }

  // ── 起草:检测结果 → AGENTS.md 文本(检测不到的写「待确认」,不编造) ──
  const li = (arr, fallback) => (arr && arr.length ? arr : [fallback || '（待确认：本项目尚未登记，使用前请先补）'])
  function draftAgentsMd(d) {
    const L = []
    L.push('# AGENTS.md — ' + d.name, '')
    L.push('> 给 Agent 的项目说明书：怎么构建、怎么测试、怎么验证。只写可执行事实；命令失效时先报告再建议修改本文件。', '> 本文件刻意保持精简（serve 每轮全量注入 = token 成本，详细机制与背景放 docs/ 并在这里给路径，别把长文档搬进来）。', '')
    L.push('## 构建 / 检查')
    for (const c of li(d.build)) L.push('- 构建：`' + c + '`')
    for (const c of li(d.lint, '（无）')) L.push('- Lint/类型检查：`' + c + '`')
    L.push('', '## 测试')
    for (const c of li(d.test)) L.push('- 全量测试：`' + c + '`')
    for (const c of li(d.singleTest)) L.push('- 跑单个测试：`' + c + '`')
    L.push('', '## 验证纪律（本项目约定）')
    L.push('- 改完代码必须跑"构建/测试"其一验证；过不了就如实报告，不许声称完成。')
    L.push('- 验证只信命令输出，不信"读代码觉得没问题"。')
    if (d.devCmd.length || d.devUrl) {
      L.push('', '## 前端自验')
      for (const c of li(d.devCmd, '（待确认）')) L.push('- 起 dev 服务：`' + c + '`')
      L.push('- 入口 URL：' + (d.devUrl || '（待确认：通常 ' + (d.eco.includes('vue') ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:3000') + '，以实际输出为准）'))
      L.push('- 页面验证步骤：browser_open 打开入口（内嵌浏览器，带登录态、用户看得见）→ browser_assert 验 no_console_error / no_failed_request → 再断一条本次改动的具体预期（text_present 或 selector_exists）→ browser_shot 截图并把图读一遍 → browser_close 出报告。VERDICT 由壳层机判：零断言算 INCONCLUSIVE，不算通过。')
    }
    if (d.eco.includes('java-maven') || d.eco.includes('java-gradle')) {
      L.push('', '## 后端自验')
      L.push('- 起服务：`' + (d.devCmd[0] || '（待确认）') + '`')
      L.push('- 接口探针：用 curl 调关键接口，校验**响应体字段**（不只看状态码）；无现成探针时先 `curl -s http://127.0.0.1:<端口>/actuator/health`（Spring 系）。')
    }
    L.push('', '## 给 Agent 的其它事实')
    L.push('- 项目栈：' + (d.eco.length ? d.eco.join(' / ') : '（未识别）'))
    for (const n of d.notes) L.push('- ' + n)
    L.push('')
    return L.join('\n')
  }

  function targetFile(dir) { return path.join(dir, 'AGENTS.md') }

  // 内部共用写入:按三种情形落盘(新建/我们生成的段幂等替换/人工文件备份+追加),返回 {action, backup}
  function writeBlock(dir, content, log) {
    const f = targetFile(dir)
    let backup = null, action = 'created'
    if (fs.existsSync(f)) {
      const old = fs.readFileSync(f, 'utf8')
      if (old.includes('<!-- BocomHermes:agents-md -->')) {
        action = 'replaced-section'   // 我们以前生成的段:整体替换(幂等,可重复点)
      } else {
        backup = f + '.bak.' + Date.now()   // 人工写的 AGENTS.md:备份后把生成段【追加】到尾部,不覆盖
        try { fs.copyFileSync(f, backup) } catch (e) { log && log('agent-md backup err: ' + e.message) }
        action = 'appended'
      }
    }
    const block = '<!-- BocomHermes:agents-md -->\n' + String(content || '').trim() + '\n'
    const final = (action === 'appended') ? fs.readFileSync(f, 'utf8').trimEnd() + '\n\n' + block : block
    fs.writeFileSync(f, final, 'utf8')
    return { path: f, action, backup }
  }

  ipcMain.handle('agent-md-draft', (_e, dir) => {
    try {
      if (!dir || !fs.existsSync(dir)) return { ok: false, error: '目录不存在' }
      const d = detectProject(dir)
      const existing = fs.existsSync(targetFile(dir)) ? fs.readFileSync(targetFile(dir), 'utf8') : null
      // 大小护栏(性能审查①):serve 会全量注入 AGENTS.md 到每轮请求——超 8KB 告警(≈5k tokens/轮白烧)
      const sizeWarn = (existing && existing.length > 8192) ? '已有 AGENTS.md 偏大(' + Math.round(existing.length / 1024) + 'KB ≈ ' + Math.round(existing.length / 1.6 / 1000) + 'k tokens/轮),serve 每轮全量注入;建议精简或换生成段' : ''
      if (sizeWarn) log('agent-md: ' + sizeWarn + ' (' + targetFile(dir) + ')')
      return { ok: true, draft: draftAgentsMd(d), detected: d, existing, sizeWarn }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('agent-md-write', (_e, { dir, content }) => {
    try {
      if (!dir || !fs.existsSync(dir)) return { ok: false, error: '目录不存在' }
      const r = writeBlock(dir, content, log)
      log('agent-md: ' + r.action + ' → ' + r.path + (r.backup ? ' (backup ' + r.backup + ')' : ''))
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
  })

  // 自动插入(用户确认的方向:不靠设置页手点)——选定项目/启动时壳层自己把说明书写进项目:
  //   无 AGENTS.md → 直接生成;有我们生成的段 → 自动刷新(幂等);【人工写的文件不碰】(不把机器文本塞给人)。
  //   草稿里「待确认」项保留由人补;写入事实只记日志,不打扰。
  function autoEnsure(dir) {
    try {
      if (!dir || !fs.existsSync(dir)) return { ok: false, skipped: 'no-dir' }
      const f = targetFile(dir)
      if (fs.existsSync(f)) {
        const old = fs.readFileSync(f, 'utf8')
        if (!old.includes('<!-- BocomHermes:agents-md -->')) return { ok: true, skipped: 'human-file' }   // 人工文件,不碰
      }
      const r = writeBlock(dir, draftAgentsMd(detectProject(dir)), log)
      log('agent-md auto-ensure: ' + r.action + ' → ' + r.path)
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
  }

  return { autoEnsure }
}
