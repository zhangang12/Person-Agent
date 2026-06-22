// BocomHermes · 复现取证 MCP(本地 stdio 服务,零依赖)
// 给 agent 提供"按需取大块证据"的工具,配合"证据包"摘要里的 ref# 引用使用。
// 主上下文只放 ~5KB 摘要,真要细节(完整 DOM / 长 req body / 完整事件帧)agent 自己 call 这些工具拉。
// 数据全在本机 userData/evidence/,完全离线;只读,不修改任何东西。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const log = (...a) => process.stderr.write('[repro-mcp] ' + a.join(' ') + '\n')

// userData 路径(跟主应用对齐):Windows = %APPDATA%/BocomHermes-shell;macOS = ~/Library/Application Support/BocomHermes-shell;Linux = ~/.config/BocomHermes-shell
function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
const EVD = path.join(userData(), 'evidence')
const REC = path.join(userData(), 'recordings')
const ASS = path.join(userData(), 'assertions')
const SCN = path.join(userData(), 'scans')
const REV = path.join(userData(), 'reviews')

// ref 形如 "ref#b_lz4kj/dom" → bundleId=b_lz4kj, name=dom
function parseRef(s) {
  const m = String(s || '').match(/^(?:ref#)?([^/]+)\/(.+)$/)
  if (!m) return null
  return { bundleId: m[1], name: m[2] }
}
function readEvd(ref) {
  const p = parseRef(ref); if (!p) return null
  const fp = path.join(EVD, p.bundleId, p.name + '.txt')
  try { return { path: fp, text: fs.readFileSync(fp, 'utf8') } } catch { return null }
}

const TOOLS = [
  { name: 'list_bundles', description: '列出最近的复现包(bundleId 列表,最新在前)。看不到具体 bundleId 时先调这个。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'list_evidence', description: '列出某个复现包里所有可取的证据 ref(dom / err*-stack / req*-body / resp*-body / recording 等)', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' } }, required: ['bundleId'] } },
  { name: 'get_evidence', description: '按 ref 拉取证据全文(ref 形如 "ref#bundleId/name" 或简写 "bundleId/name")。常用于 dom / req-body / resp-body / err-stack', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, head: { type: 'number', description: '只取前 N 字符,省略=全文' } }, required: ['ref'] } },
  { name: 'get_dom_subtree', description: '从一个复现包的完整 DOM 中,按 CSS 选择器抽某个子树的 outerHTML(优先用这个而非整页 dom)', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' }, selector: { type: 'string' } }, required: ['bundleId', 'selector'] } },
  { name: 'get_event_window', description: '从录制时间线里取某一步前后 ±N 步的窗口,看用户在出问题前后做了什么。先 list_bundles 拿 recording ref。', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' }, step: { type: 'number' }, radius: { type: 'number' } }, required: ['bundleId', 'step'] } },
  { name: 'repro_assert', description: '改完代码后**必须调用**:声明这次修复"应该让什么消失/出现"。每条断言会在验证回放时单独检查。kind 选: no_console(无匹配报错) / no_element(元素消失) / has_element(元素出现) / no_net(无该 URL 请求 4xx/5xx)。why 简述断言理由。', inputSchema: { type: 'object', properties: { bundleId: { type: 'string', description: '复现包 id(从证据包顶部 === 复现包 b_xxx === 拷过来)' }, kind: { type: 'string', enum: ['no_console', 'no_element', 'has_element', 'no_net'] }, value: { type: 'string', description: 'no_console: 报错消息中应不再出现的子串;no_element/has_element: CSS 选择器;no_net: URL 子串' }, why: { type: 'string', description: '一句话:这条断言对应的修复意图' } }, required: ['bundleId', 'kind', 'value'] } },
  { name: 'repro_assertions', description: '列出某个复现包的所有断言(给主程序的验证流程读)', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' } }, required: ['bundleId'] } },
  { name: 'scan_impact', description: '**改代码前必须先调用** — 查导出符号在项目里的所有引用,评估"改了它会影响哪些地方"。这一步同时被验证流程检查:如果改了某文件却没扫过对应符号,验证报告会标 SUSPICIOUS。底层用 git grep,所以必须传项目目录 cwd(repo 根)。返回引用清单 + 落盘到 userData/scans/<bundleId>.json 备查。', inputSchema: { type: 'object', properties: { bundleId: { type: 'string', description: '复现包 id(从证据包顶部拷过来)' }, symbol: { type: 'string', description: '要查引用的符号(函数名/常量名/类名等)' }, cwd: { type: 'string', description: '项目目录绝对路径(git grep 的工作目录)' } }, required: ['bundleId', 'symbol', 'cwd'] } },
  { name: 'repro_self_review', description: '**改完代码后必须调用** — 对你这次修复做 self-review:summary(改了什么)/risk 1-5(对修复正确性的信心,1=不确定,5=确信)/edge_cases(没覆盖的边界,可空)。验证报告会显示这条 review,信心低或缺少 review 会标 SUSPICIOUS。', inputSchema: { type: 'object', properties: { bundleId: { type: 'string' }, summary: { type: 'string', description: '1-3 句:你这次改了哪些文件、为什么这样改' }, risk: { type: 'number', description: '对修复正确性的自评信心 1-5(5=很有把握)' }, edge_cases: { type: 'string', description: '可空:本次修复没覆盖到的边界场景' } }, required: ['bundleId', 'summary', 'risk'] } },
  { name: 'repro_rollback', description: '验证 FAIL 后,把本次 session 的改动回滚到 HEAD。默认回滚所有改动文件(git checkout + git clean 未跟踪);files 列表非空则只回滚那些。**慎用**:会丢失本次未提交的改动;但当你已确定本次修复方向错误时,这是干净重来的最快路径。', inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: '仓库根目录绝对路径' }, files: { type: 'array', items: { type: 'string' }, description: '可选:仅回滚这些文件;省略=回滚所有改动' }, dryRun: { type: 'boolean', description: 'true 只列出会被回滚的文件,不真动手(强烈建议先 dryRun)' } }, required: ['cwd'] } },
]

async function callTool(name, a) {
  a = a || {}
  if (name === 'list_bundles') {
    try {
      const ds = fs.readdirSync(EVD).filter((d) => /^b_/.test(d))
      const sorted = ds.map((d) => ({ id: d, m: (fs.statSync(path.join(EVD, d)).mtimeMs) })).sort((x, y) => y.m - x.m).slice(0, a.limit || 20)
      return sorted.length ? sorted.map((s) => `${s.id}  (${new Date(s.m).toISOString().replace('T', ' ').slice(0, 19)})`).join('\n') : '(暂无证据包)'
    } catch (e) { return '(读取失败:' + e.message + ')' }
  }
  if (name === 'list_evidence') {
    const d = path.join(EVD, String(a.bundleId)); let files = []
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')) } catch (e) { return '(找不到 bundle "' + a.bundleId + '":' + e.message + ')' }
    if (!files.length) return '(空)'
    const lines = files.map((n) => { const p = path.join(d, n + '.txt'); const sz = (fs.statSync(p).size); return `  ref#${a.bundleId}/${n}    (${sz}B)` })
    return '复现包 ' + a.bundleId + ' 含 ' + files.length + ' 份证据:\n' + lines.join('\n')
  }
  if (name === 'get_evidence') {
    const r = readEvd(a.ref); if (!r) return '(找不到 ref:' + a.ref + ')'
    const t = a.head ? r.text.slice(0, Number(a.head)) : r.text
    return `# ${a.ref}  (${r.text.length}B${a.head && a.head < r.text.length ? ', 取前 ' + a.head + ' 字' : ''})\n` + t
  }
  if (name === 'get_dom_subtree') {
    const r = readEvd(a.bundleId + '/dom'); if (!r) return '(找不到 bundle 的 dom,先 list_bundles 看 id 对不对)'
    // 用一个超轻的 outerHTML 抽取:不引入完整 DOM parser,用正则定位选择器目标的 outerHTML
    // 仅支持 id / class / tagname 简单选择器;复杂选择器请改用浏览器里的 picker 再来
    const sel = String(a.selector || '').trim()
    let pat
    if (sel.startsWith('#')) pat = new RegExp('<([a-zA-Z][\\w-]*)([^>]*\\bid\\s*=\\s*["\\\']' + sel.slice(1).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '["\\\'][^>]*)>', 'i')
    else if (sel.startsWith('.')) pat = new RegExp('<([a-zA-Z][\\w-]*)([^>]*\\bclass\\s*=\\s*["\\\'][^"\\\']*\\b' + sel.slice(1).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b[^"\\\']*["\\\'][^>]*)>', 'i')
    else pat = new RegExp('<(' + sel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + ')(\\s[^>]*|)>', 'i')
    const m = r.text.match(pat)
    if (!m) return '(在 DOM 里找不到选择器 "' + sel + '";支持 #id / .class / tagname)'
    const tag = m[1]
    const start = m.index
    // 从 start 起平衡 <tag>...</tag>(忽略自闭合)
    const open = new RegExp('<' + tag + '(\\s[^>]*|)>', 'gi'); open.lastIndex = start
    const close = new RegExp('</' + tag + '\\s*>', 'gi'); close.lastIndex = start
    let depth = 0, pos = start, end = -1, safety = 0
    while (safety++ < 2000) {
      open.lastIndex = pos; close.lastIndex = pos
      const o = open.exec(r.text), c = close.exec(r.text)
      if (!c) break
      if (o && o.index < c.index) { depth++; pos = o.index + o[0].length }
      else { depth--; pos = c.index + c[0].length; if (depth === 0) { end = pos; break } }
    }
    const out = end > start ? r.text.slice(start, end) : r.text.slice(start, start + 4000)
    return `# ${a.bundleId} → ${sel}  (${out.length}B)\n` + (out.length > 8000 ? out.slice(0, 8000) + '\n<!-- ...(截断,完整 outerHTML 见 ref#' + a.bundleId + '/dom) -->' : out)
  }
  if (name === 'get_event_window') {
    const r = readEvd(a.bundleId + '/recording'); if (!r) return '(找不到 bundle 的 recording — 这次没录制?)'
    let rec; try { rec = JSON.parse(r.text) } catch { return '(recording JSON 解析失败)' }
    const events = rec.events || []
    const step = Math.max(0, Math.min(events.length - 1, Number(a.step) - 1))
    const rad = Math.max(0, Number(a.radius || 3))
    const lo = Math.max(0, step - rad), hi = Math.min(events.length - 1, step + rad)
    const lines = events.slice(lo, hi + 1).map((e, i) => {
      const idx = lo + i + 1; const mark = (lo + i) === step ? ' ◀──' : ''
      return `  步 ${idx}${mark}  t=${((e.t || 0) / 1000).toFixed(1)}s  ${e.act.padEnd(8)} ${e.sel || e.url || ''}${e.text ? ' "' + e.text + '"' : ''}${e.value ? ' = "' + e.value + '"' : ''}${e.key ? ' key:' + e.key : ''}`
    })
    return `录制 ${a.bundleId} 步 ${step + 1} 的 ±${rad} 步窗口(共 ${events.length} 步):\n` + lines.join('\n')
  }
  if (name === 'repro_assert') {
    const bundleId = String(a.bundleId || '').trim()
    const kind = String(a.kind || '').trim()
    const value = String(a.value || '').trim()
    if (!bundleId || !kind || !value) return '需要 bundleId + kind + value'
    if (!['no_console', 'no_element', 'has_element', 'no_net'].includes(kind)) return '未知 kind:' + kind
    try { fs.mkdirSync(ASS, { recursive: true }) } catch {}
    const fp = path.join(ASS, bundleId + '.json')
    let arr = []; try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch {}
    if (!Array.isArray(arr)) arr = []
    arr.push({ kind, value, why: String(a.why || ''), ts: Date.now() })
    try { fs.writeFileSync(fp, JSON.stringify(arr, null, 2)) } catch (e) { return '写入失败:' + e.message }
    return `✓ 已为 ${bundleId} 记入断言 #${arr.length}: ${kind}="${value}"${a.why ? ' (' + a.why + ')' : ''}\n下次用户点"验证",回放结束后会自动检查这条。`
  }
  if (name === 'repro_assertions') {
    const bundleId = String(a.bundleId || '').trim()
    const fp = path.join(ASS, bundleId + '.json')
    let arr = []; try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch {}
    if (!Array.isArray(arr) || !arr.length) return '(' + bundleId + ' 暂无断言)'
    return arr.map((x, i) => `  #${i + 1}  ${x.kind}  "${x.value}"${x.why ? '  · ' + x.why : ''}`).join('\n')
  }
  if (name === 'scan_impact') {
    const bundleId = String(a.bundleId || '').trim()
    const symbol = String(a.symbol || '').trim()
    const cwd = String(a.cwd || '').trim()
    if (!bundleId || !symbol || !cwd) return '需要 bundleId + symbol + cwd(项目根目录绝对路径)'
    if (!fs.existsSync(cwd)) return 'cwd 不存在: ' + cwd
    let files = []; let preview = ''
    try {
      // -l 只出文件名,大小写敏感(更准);限制 200 行
      const out = execFileSync('git', ['grep', '-l', '--', symbol], { cwd, encoding: 'utf8', timeout: 5000 })
      files = out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 200)
    } catch (e) {
      // git grep 找不到匹配会 exit 1(不是错误,空结果);其它 exit code 才是真错(找不到 git / 非 repo / IO 错)
      if (e.status !== 1) return 'git grep 失败 (exit ' + (e.status == null ? '?' : e.status) + '): ' + (e.stderr ? e.stderr.toString() : e.message) + '(此目录是 git 仓库吗?)'
    }
    // 附带 5 行上下文预览(头几个文件),帮 agent 快速判断
    if (files.length) {
      const sampleFiles = files.slice(0, 5)
      const prev = []
      for (const f of sampleFiles) {
        try { const ln = execFileSync('git', ['grep', '-n', '--', symbol, '--', f], { cwd, encoding: 'utf8', timeout: 3000 }).split('\n').slice(0, 3).join('\n'); if (ln) prev.push(ln) } catch {}
      }
      if (prev.length) preview = '\n\n预览(前 5 文件的引用行):\n' + prev.join('\n')
    }
    // 落盘
    try { fs.mkdirSync(SCN, { recursive: true }) } catch {}
    const fp = path.join(SCN, bundleId + '.json')
    let arr = []; try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch {}
    if (!Array.isArray(arr)) arr = []
    arr.push({ symbol, cwd, files, ts: Date.now() })
    try { fs.writeFileSync(fp, JSON.stringify(arr, null, 2)) } catch (e) { return '记录失败: ' + e.message }
    if (!files.length) return `符号 "${symbol}" 在 ${cwd} 里 git grep 无匹配。已记录(可能拼错了,或这是即将新增的符号)。`
    return `符号 "${symbol}" 在 ${cwd} 里被 ${files.length} 个文件引用:\n` + files.map((f) => '  · ' + f).join('\n') + preview + `\n\n已记录到 scans/${bundleId}.json,改这些文件后验证不会标 SUSPICIOUS;改其它文件会被标。`
  }
  if (name === 'repro_self_review') {
    const bundleId = String(a.bundleId || '').trim()
    const summary = String(a.summary || '').trim()
    const risk = Number(a.risk)
    if (!bundleId || !summary || !risk) return '需要 bundleId + summary + risk(1-5 数值)'
    if (risk < 1 || risk > 5) return 'risk 必须在 1-5 之间'
    try { fs.mkdirSync(REV, { recursive: true }) } catch {}
    const fp = path.join(REV, bundleId + '.json')
    const rev = { summary, risk, edge_cases: String(a.edge_cases || ''), ts: Date.now() }
    try { fs.writeFileSync(fp, JSON.stringify(rev, null, 2)) } catch (e) { return '写入失败: ' + e.message }
    return `✓ self-review 已记录 (risk=${risk}/5)。验证报告会展示这条 review,用户和验证流程据此判断你的修复信心。`
  }
  if (name === 'repro_rollback') {
    const cwd = String(a.cwd || '').trim()
    if (!cwd || !fs.existsSync(cwd)) return '需要 cwd(仓库根绝对路径)'
    let tracked = [], untracked = []
    try {
      const tOut = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000 })
      const cOut = execFileSync('git', ['diff', '--cached', '--name-only', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000 })
      tracked = [...new Set([...tOut.split('\n'), ...cOut.split('\n')].map((s) => s.trim()).filter(Boolean))]
    } catch (e) { return 'git diff 失败:' + e.message }
    try {
      const u = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', timeout: 5000 })
      untracked = u.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch {}
    // files 白名单过滤
    if (Array.isArray(a.files) && a.files.length) {
      const set = new Set(a.files.map(String))
      tracked = tracked.filter((f) => set.has(f))
      untracked = untracked.filter((f) => set.has(f))
    }
    if (!tracked.length && !untracked.length) return '(没有可回滚的改动 — 工作区干净)'
    const summary = `将回滚:\n  追踪文件(${tracked.length}):\n${tracked.map((f) => '    ' + f).join('\n') || '    (无)'}\n  未追踪新文件(${untracked.length}):\n${untracked.map((f) => '    ' + f).join('\n') || '    (无)'}`
    if (a.dryRun) return '[DRY RUN] ' + summary + '\n\n再次调用,把 dryRun:false 或省略即可真正回滚。'
    const errs = []
    for (const f of tracked) {
      try { execFileSync('git', ['checkout', 'HEAD', '--', f], { cwd, timeout: 3000 }) } catch (e) { errs.push(f + ': ' + (e.stderr ? e.stderr.toString() : e.message)) }
    }
    for (const f of untracked) {
      try { fs.unlinkSync(path.join(cwd, f)) } catch (e) { errs.push(f + ': ' + e.message) }
    }
    return summary + '\n\n' + (errs.length ? '⚠ 部分失败:\n  ' + errs.join('\n  ') : '✓ 回滚完成')
  }
  throw new Error('未知工具:' + name)
}

// ── MCP stdio 协议 ──
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'bocomhermes-repro', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '工具出错:' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现:' + method } })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle err: ' + e.message)) } })
log('ready · evidence=' + EVD)
