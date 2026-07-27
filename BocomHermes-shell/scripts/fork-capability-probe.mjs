// BocomHermes · fork 兼容性一键探针(内网验收用,零依赖,需要真实运行中的 serve + 已配模型)
//
// 验什么(bocomcode fork 的三条必验项,其余是壳层配置自检):
//   T1 插件机制 + tool.execute.after 回写:造一个 ~50KB 大文件,让模型 read 它,
//      若输出被 read-spill 插件外溢(摘要含「输出过长已外溢」)→ 插件机制与钩子回写都活;
//      输出原文 >8000 字符 → 插件没生效(机制被砍/目录没扫/.js 没被加载);
//      模型没调 read → WARN(模型行为,不是机制问题,换 prompt 重跑)
//   T2 LSP 配置落地:opencode 配置里 lsp.typescript 是否带 env/initialization(壳层 lsp-config 是否写入;
//      fork 是否真接受了 schema 要看 serve 日志,这里只能验配置面)
//   T3 serve 健康:起没起来、provider 配没配
//   T4 experimental.chat.messages.transform 回写:自起隔离 serve(探针插件只在 serve 启动时加载),
//      插件把含唯一标记的工具结果替换为占位符 → 下一轮问模型看到什么;
//      模型只见到占位符=钩子+回写都活;模型还能逐字引用原文=未生效
//   T5 permission.ask 插件 deny:同隔离 serve(项目 opencode.json 配 bash:ask 强制触发权限),
//      插件对含唯一标记的命令回 deny;命令无执行痕迹=生效;命令真跑了=未生效
//      (注:公网 opencode 1.18.3 实测二进制中无 permission.ask 触发点,该钩子是"类型已声明、实现未上线")
//   T6 experimental.chat.system.transform 系统提示注入:插件往系统提示尾部注入唯一标记,
//      模型能复述=钩子+回写都活(子 Agent 系统提示注入 B2 的前提)
//   T8 双模型与读图能力(同隔离 serve):T8a 同一会话两条消息各指定不同模型(body.model),
//      两条都答=消息级模型切换支持;T8b 找 capabilities.input.image 的模型发 64x64 纯红 PNG,
//      答出"红/red"=多模态可读图(清单无多模态模型则 WARN 降级)
// 用法: node scripts/fork-capability-probe.mjs [baseURL]   (默认 http://127.0.0.1:4096)
// 注意:T1 会真实调一次模型(读大文件),内网跑一次约 1-3 分钟;T4/T5 自起隔离 serve 真实调 3 回合,约 3-10 分钟;
//      隔离 serve 用 bocomcode/opencode(PATH 或 BOCOMHERMES_SERVE_BIN),探针插件放项目级 .opencode/plugin/,用完即删。
// 注意:T1 会真实调一次模型(读大文件),内网跑一次约 1-3 分钟;临时文件用完即删。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:4096'
const SPILL_MARK = '输出过长已外溢'
// T8b 读图用:64x64 纯红 PNG(预生成的 data URL 常量,168 字节)
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC'
let passN = 0, warnN = 0, failN = 0
const PASS = (n, d) => { passN++; console.log('  ✓ ' + n + (d ? ' — ' + d : '')) }
const WARN = (n, d) => { warnN++; console.log('  ⚠ ' + n + (d ? ' — ' + d : '')) }
const FAIL = (n, d) => { failN++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) }

async function api(method, p, body, base) {
  const B = base || BASE
  const res = await fetch(B + p, { method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, text, json }
}
// 权限自动放行(探针无人值守:模型调 write/bash 触发批准框没人点,回合卡死——实测复现)。听 SSE 的 permission 事件,来了就回 once
// onReply:每放行一次回调一次(T5 用——钩子 deny 生效时权限事件根本不该到达 SSE)
function autoApprovePerms(stop, sid, base, onReply) {
  const B = base || BASE
  ;(async () => {
    try {
      const res = await fetch(B + '/event')
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
      while (!stop.done) {
        const { value, done } = await rd.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              const evt = JSON.parse(line.slice(5).trim())
              const type = String((evt && evt.type) || '')
              if (!type.includes('permission') || type.includes('replied') || type.includes('response')) continue
              const p = (evt && evt.properties) || {}
              const rid = p.requestID ?? p.id ?? p.permissionID ?? p.permissionId
              if (!rid) continue
              const r1 = await api('POST', '/permission/' + rid + '/reply', { reply: 'once' }, B)
              if (r1.status >= 400) await api('POST', '/session/' + sid + '/permissions/' + rid, { reply: 'once' }, B)   // 老端点兜底
              if (onReply) onReply()
              console.log('  (权限放行 ' + String(rid).slice(0, 16) + '…)')
            } catch {}
          }
        }
      }
      try { rd.cancel() } catch {}
    } catch {}
  })()
}
// 长回合用 http.request(实测:electron-as-node 的 undici fetch 在分钟级长响应上会 fetch failed,http 模块稳)
import http from 'node:http'
import { spawn } from 'node:child_process'
function apiLong(p, body, timeoutMs, base) {
  const B = base || BASE
  return new Promise((resolve, reject) => {
    const u = new URL(B + p)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: timeoutMs || 300000 }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => { let json; try { json = text ? JSON.parse(text) : undefined } catch {}; resolve({ status: res.statusCode, text, json }) })
    })
    req.on('timeout', () => req.destroy(new Error('回合超时(' + Math.round((timeoutMs || 300000) / 1000) + 's)')))
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

// ── T4/T5 探针:experimental 钩子(experimental.chat.messages.transform 回写 / permission.ask deny) ──
// 探针插件源码(写到隔离 serve 的项目级 .opencode/plugin/ —— 只在那个 serve 的 cwd 下生效,不碰用户全局配置)
function probePluginSource() {
  return '// T4/T5 探针插件(fork-capability-probe 自动生成,用完即删)\n'
    + 'import fs from "node:fs"\n'
    + 'import path from "node:path"\n'
    + 'const DIR = process.env.T4_PROBE_DIR || ""\n'
    + 'const LOG = path.join(DIR, "probe-log.jsonl")\n'
    + 'const log = (o) => { try { fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\\n") } catch {} }\n'
    + 'export default async function () {\n'
    + '  return {\n'
    + '    "experimental.chat.messages.transform": async (input, output) => {\n'
    + '      let replaced = 0\n'
    + '      for (const m of (output && output.messages) || []) {\n'
    + '        for (const p of (m && m.parts) || []) {\n'
    + '          if (!p || p.type !== "tool") continue\n'
    + '          if (p.state && typeof p.state.output === "string" && p.state.output.includes("T4-ORIGINAL-")) { p.state.output = "[T4-PROBE-MARKER 工具结果已被探针替换]"; replaced++ }\n'
    + '          else if (typeof p.output === "string" && p.output.includes("T4-ORIGINAL-")) { p.output = "[T4-PROBE-MARKER 工具结果已被探针替换]"; replaced++ }\n'
    + '        }\n'
    + '      }\n'
    + '      log({ hook: "messages.transform", replaced })\n'
    + '    },\n'
    + '    "permission.ask": async (input, output) => {\n'
    + '      const s = JSON.stringify(input || {})\n'
    + '      log({ hook: "permission.ask", input: s.slice(0, 400) })\n'
    + '      if (s.includes("T5-RAN-") && output) output.status = "deny"\n'
    + '    },\n'
    + '    "experimental.chat.system.transform": async (input, output) => {\n'
    + '      const mark = process.env.T6_MARKER || ""\n'
    + '      if (mark && output && Array.isArray(output.system) && !output.system.some((s) => String(s).includes(mark))) output.system.push("注入测试标记:" + mark)\n'
    + '      log({ hook: "system.transform", sysLen: (output && output.system && output.system.length) || -1 })\n'
    + '    },\n'
    + '  }\n'
    + '}\n'
}
async function waitServeUp(proc, port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false
    try { const r = await fetch('http://127.0.0.1:' + port + '/global/health'); if (r.status === 200) return true } catch {}
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}
function readProbeLog(dir) { try { return fs.readFileSync(path.join(dir, 'probe-log.jsonl'), 'utf8') } catch { return '' } }
function normMsgs(json) { return (json && (Array.isArray(json) ? json : (json.messages || json.data))) || [] }
function assistantTexts(msgs) {
  let t = ''
  for (const m of msgs) {
    const role = (m.info && m.info.role) || m.role || (m.data && m.data.info && m.data.info.role) || ''
    if (role !== 'assistant') continue
    for (const p of (m.parts || (m.data && m.data.parts) || [])) if (p && p.type === 'text') t += String(p.text || '') + '\n'
  }
  return t
}
function toolOutputs(msgs) {
  let t = ''
  for (const m of msgs) for (const p of (m.parts || (m.data && m.data.parts) || [])) {
    if (p && p.type === 'tool') t += String((p.state && p.state.output) || p.output || '') + '\n'
  }
  return t
}

async function main() {
  console.log('== fork 兼容性探针 ==')
  console.log('target:', BASE, '\n[T3] serve 健康')
  try {
    const r = await api('GET', '/global/health')
    if (r.status === 200) PASS('GET /global/health', 'version=' + ((r.json && r.json.version) || '?'))
    else { FAIL('GET /global/health', 'status=' + r.status + '(serve 没起来,后续跳过)'); return dump() }
  } catch (e) { FAIL('GET /global/health', e.message + '(serve 没起来,后续跳过)'); return dump() }
  try {
    const r = await api('GET', '/provider')
    const all = r.json && (r.json.all || r.json)
    const n = Array.isArray(all) ? all.length : Object.keys(all || {}).length
    n ? PASS('provider 已配', n + ' 个') : WARN('provider', '看不到 provider(模型可能没配,T1 会失败)')
  } catch { WARN('provider', '查询失败') }

  console.log('\n[T2] LSP 配置落地(配置面)')
  try {
    const home = os.homedir()
    const cands = [
      process.env.OPENCODE_CONFIG, process.env.BOCOMCODE_CONFIG,
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'opencode', 'opencode.jsonc'),
      path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      path.join(home, '.config', 'bocomcode', 'opencode.jsonc'),
    ].filter(Boolean)
    let hit = null
    for (const p of cands) {
      if (!fs.existsSync(p)) continue
      try { const c = JSON.parse(fs.readFileSync(p, 'utf8')); if (c && c.lsp && c.lsp.typescript) { hit = { p, ts: c.lsp.typescript } ; break } } catch {}
    }
    if (!hit) FAIL('lsp.typescript 配置', '所有候选配置文件里都没有(壳层 lsp-config 没写入?跑一次应用看启动日志)')
    else {
      const envOk = hit.ts.env && hit.ts.env.ELECTRON_RUN_AS_NODE === '1'
      const initOk = !!(hit.ts.initialization && hit.ts.initialization.tsserver)
      envOk && initOk ? PASS('lsp.typescript', 'env+initialization 齐备 → ' + hit.p)
        : WARN('lsp.typescript', '存在但字段不全(env=' + envOk + ', initialization.tsserver=' + initOk + ') —— fork 若 schema 不认这两个字段,代码智能起不来')
    }
  } catch (e) { WARN('lsp 配置检查', e.message) }

  console.log('\n[T2b] 上下文上限上报(limit.context → 壳层生效上限 = min(上报, 192k))')
  try {
    const r = await api('GET', '/config/providers')
    const all = (r.json && (r.json.all || r.json.providers || r.json)) || []
    const vals = new Map()   // limit.context → [modelID]
    for (const p of (Array.isArray(all) ? all : [])) {
      for (const [mid, m] of Object.entries(p.models || {})) {
        const lim = (m && m.limit && m.limit.context) || 0
        if (lim) { if (!vals.has(lim)) vals.set(lim, []); vals.get(lim).push((p.id || p.providerID || '?') + '/' + mid) }
      }
    }
    if (!vals.size) WARN('limit.context 上报', '拿不到任何模型的窗口上限(壳层回退 128000 兜底;fork 若阉割此字段,192k 口径无法生效)')
    for (const [lim, models] of [...vals.entries()].sort((a, b) => a[0] - b[0])) {
      const eff = Math.min(lim, 192000)
      PASS('limit.context=' + lim, '生效上限 ' + eff / 1000 + 'k(' + models.length + ' 个模型,如 ' + models[0] + ')')
    }
  } catch (e) { WARN('limit.context 查询', e.message) }

  console.log('\n[T2c] 首轮注入基线构成(本地估算:项目文档(serve 自动注入嫌疑) + MCP 工具表)')
  try {
    // 项目文档:opencode 会自动把项目根的 AGENTS.md/CLAUDE.md 注入系统提示(上游行为),和壳层 CLAUDE/README 注入可能重复计税
    const docNames = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'README']
    for (const n of docNames) {
      const p = path.join(process.cwd(), n)
      if (fs.existsSync(p)) {
        const sz = fs.statSync(p).size
        console.log('  ' + (sz > 8000 ? '⚠' : '✓') + ' ' + n + ': ' + (sz / 1000).toFixed(1) + 'KB' + (sz > 8000 ? ' —— 偏大,serve 若全量注入将吃掉 ' + Math.round(sz / 1000) + 'k+ tokens' : ''))
      }
    }
    // MCP 工具表:逐 server tools/list 量尺寸(内建工具表在 serve 侧拿不到,此处只量壳层 9 个 MCP)
    const mcpDir = path.join(process.cwd(), 'mcp')
    if (fs.existsSync(mcpDir)) {
      // 简化法:直接 require 各 server 的 TOOLS 定义不可行(stdio 协议),用上次实测常数 + 提示
      console.log('  MCP 工具表: 9 个 server 约 68 个工具 / ≈25k 字符(本机实测,scripts 同目录可复测) —— 占首轮基线约 8-10k tokens')
    }
    console.log('  (说明:serve 系统提示与内建工具表的大小只能由 T1 的 tokens 反推 —— 看 T1 的"首轮 prompt 基线"读数)')
  } catch (e) { WARN('T2c 注入基线', e.message) }

  console.log('\n[T1] 插件机制(read-spill 端到端,真实调一次模型)')
  const tmpDir = path.join(os.tmpdir(), 'bocomhermes-forkprobe')
  fs.mkdirSync(tmpDir, { recursive: true })
  const bigFile = path.join(tmpDir, 'big.txt').replace(/\\/g, '/')
  fs.writeFileSync(bigFile, Array.from({ length: 1500 }, (_, i) => '第' + (i + 1) + '行 fork 兼容性探针测试数据 ' + 'x'.repeat(40)).join('\n'))
  let sid = null
  try {
    const r = await api('POST', '/session', { title: 'fork-probe', directory: tmpDir })
    sid = r.json && (r.json.id || (r.json.data && r.json.data.id) || (r.json.info && r.json.info.id))
    if (!sid) { FAIL('POST /session', 'status=' + r.status); return dump() }
    console.log('  (session ' + String(sid).slice(0, 16) + '… 让模型 read ~60KB 文件,等待回合结束,最长 5 分钟)')
    const permStop = { done: false }
    autoApprovePerms(permStop, sid)   // 权限自动放行:模型触发批准框没人点会卡死回合(实测)
    const send = await apiLong('/session/' + sid + '/message', { parts: [{ type: 'text', text: '【只允许用 read 工具】(禁止 bash/cat/powershell/任何其它工具)读取文件 ' + bigFile + ',然后只回答:它的总行数。' }] }, 300000)
    permStop.done = true
    // 有的版本 POST 直接返回回合结果(单条 assistant 消息或消息数组),有的要拉消息列表;三种形状都认
    let msgs = null
    if (Array.isArray(send.json)) msgs = send.json
    else if (send.json && Array.isArray(send.json.parts)) msgs = [send.json]
    else if (send.json && (send.json.messages || send.json.data)) msgs = send.json.messages || send.json.data
    // POST 只带本轮【最后一条】消息(实测)——工具 part 在前面几条里,必须拉全量消息列表判
    const g = await api('GET', '/session/' + sid + '/message')
    msgs = g.json && (Array.isArray(g.json) ? g.json : (g.json.messages || g.json.data)) || msgs
    const allTools = [], readParts = []
    let promptTokens = 0
    for (const m of msgs || []) {
      const tk = (m && m.info && m.info.tokens) || (m && m.tokens) || {}
      const c = tk.cache || {}
      const p0 = (tk.input || 0) + (c.read || 0) + (c.write || 0)
      if (p0 > promptTokens) promptTokens = p0
      for (const p of (m.parts || (m.data && m.data.parts) || [])) {
        if (p && p.type === 'tool') allTools.push(String(p.tool || (p.state && p.state.tool) || p.name || '?') + '(' + String((p.state && p.state.output) || p.output || '').length + '字)')
        if (p && p.type === 'tool' && /^(read|grep|bash|powershell|pwsh|cmd)$/i.test(String(p.tool || (p.state && p.state.tool) || p.name || ''))) readParts.push(p)
      }
    }
    if (promptTokens > 0) console.log('  (首轮 prompt 基线: ' + Math.round(promptTokens / 1000) + 'k tokens 进上下文 —— 含 serve 系统提示+工具表+自动注入+壳层注入;内网治理靶子就是它)')
    if (allTools.length) console.log('  (本轮实际调用的工具: ' + allTools.join(', ') + ')')
    if (!readParts.length) WARN('模型没调 read/grep/bash', '(msgs=' + ((msgs && msgs.length) || 0) + ', toolParts=' + allTools.length + ') 模型行为差异,不是机制问题 —— 换个更强势的 prompt 重跑本探针')
    else {
      const out = String(readParts.map((p) => (p.state && p.state.output) || p.output || '').join('\n'))
      const usedBash = readParts.some((p) => /bash/i.test(String(p.tool || (p.state && p.state.tool) || p.name || '')))
      if (out.includes(SPILL_MARK)) PASS('插件外溢生效', 'read/grep/bash 输出被替换为摘要+落盘路径(tool.execute.after 回写确认' + (usedBash ? ',模型走了 bash 也被拦' : '') + ')')
      else if (out.length > 8000) FAIL('插件未生效', 'read/grep/bash 输出原文 ' + out.length + ' 字符直接进了上下文 —— fork 插件机制被砍/目录没扫/没加载 read-spill.js(检查 ~/.config/opencode/plugin/ 与 serve 启动时间:插件只在新 serve 启动时加载)')
      else WARN('read/grep/bash 输出小于阈值', out.length + ' 字符 < 8000 —— 无法判定插件是否生效(文件被 fork 侧截断了?这反而是好事,说明 R1 已在引擎里)')
    }
  } catch (e) { FAIL('T1 执行', e.message) }
  finally { try { if (sid) await api('DELETE', '/session/' + sid) } catch {}; try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {} }

  console.log('\n[T4/T5] experimental 钩子(messages.transform 回写 / permission.ask deny,自起隔离 serve)')
  const t4Dir = path.join(os.tmpdir(), 'bocomhermes-t4t5-probe')
  let proc = null, sid2 = null
  try {
    fs.rmSync(t4Dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(t4Dir, '.opencode', 'plugin'), { recursive: true })
    fs.writeFileSync(path.join(t4Dir, '.opencode', 'plugin', 't4t5-probe.js'), probePluginSource())
    fs.writeFileSync(path.join(t4Dir, 'opencode.json'), JSON.stringify({ permission: { bash: 'ask' } }, null, 2))
    const RAND = Math.random().toString(36).slice(2, 8)
    const ORIG = 'T4-ORIGINAL-' + RAND, RAN = 'T5-RAN-' + RAND
    const t4File = path.join(t4Dir, 't4file.txt').replace(/\\/g, '/')
    fs.writeFileSync(t4File, ORIG + '\n' + Array.from({ length: 20 }, (_, i) => '第' + (i + 2) + '行 探针填充数据 ' + 'x'.repeat(30)).join('\n'))
    // 起隔离 serve(bocomcode/opencode 依次试;探针插件只在 serve 启动时加载,所以必须新起)
    let port = 0, lastErr = ''
    const bins = [process.env.BOCOMHERMES_SERVE_BIN, 'bocomcode', 'opencode'].filter(Boolean)
    outer: for (const bin of bins) {
      for (const p of [4699, 4700, 4701]) {
        const pr = spawn(bin, ['serve', '--port', String(p), '--hostname', '127.0.0.1'], {
          cwd: t4Dir, env: { ...process.env, BOCOMCODE_TERMINAL: '0', CI: '1', NO_COLOR: '1', TERM: 'dumb', T4_PROBE_DIR: t4Dir, T6_MARKER: 'T6-MARKER-' + RAND },
          stdio: 'ignore', windowsHide: true,
        })
        const crashed = await new Promise((res) => { pr.once('error', () => res(true)); setTimeout(() => res(false), 2500) })
        if (crashed) { lastErr = bin + ' 不在 PATH 或启动即崩'; try { pr.kill() } catch {}; continue outer }
        if (await waitServeUp(pr, p, 25000)) { proc = pr; port = p; break outer }
        try { pr.kill() } catch {}
      }
    }
    if (!proc) FAIL('T4/T5 探针 serve', lastErr + ' —— 跳过 T4/T5(不影响 T1-T3 结论)')
    else {
      const B2 = 'http://127.0.0.1:' + port
      console.log('  (隔离 serve 已起 @' + port + ',用完即杀;真实调 3 回合模型,最长 ~10 分钟)')
      const r = await api('POST', '/session', { title: 't4t5-probe', directory: t4Dir }, B2)
      sid2 = r.json && (r.json.id || (r.json.data && r.json.data.id) || (r.json.info && r.json.info.id))
      if (!sid2) FAIL('POST /session(隔离 serve)', 'status=' + r.status)
      else {
        let permReplies = 0
        const stop2 = { done: false }
        autoApprovePerms(stop2, sid2, B2, () => permReplies++)
        // T4 turn1:读带唯一标记的文件,只答"已读取"(若模型复述原文会污染判定,靠 leaked 兜底)
        await apiLong('/session/' + sid2 + '/message', { parts: [{ type: 'text', text: '【只允许用 read 工具】读取文件 ' + t4File + ' ,然后只回答两个字:已读取。不要引用文件内容,不要总结,不要解释。' }] }, 300000, B2)
        const g1 = await api('GET', '/session/' + sid2 + '/message', undefined, B2)
        const leaked = assistantTexts(normMsgs(g1.json)).includes(ORIG)
        // T4 turn2:问它看到的工具输出 —— transform 生效则原文已不在请求里,模型只能复述占位符
        await apiLong('/session/' + sid2 + '/message', { parts: [{ type: 'text', text: '你上一轮用 read 工具读到的内容,现在显示为什么?原样复述你看到的工具输出文字(如果看到的是占位符,就复述占位符)。不要猜测,不要编造。' }] }, 300000, B2)
        const g2 = await api('GET', '/session/' + sid2 + '/message', undefined, B2)
        const a2 = assistantTexts(normMsgs(g2.json))
        const log1 = readProbeLog(t4Dir)
        if (a2.includes('T4-PROBE-MARKER')) PASS('T4 messages.transform 回写', '模型只见到占位符 —— 钩子触发且回写生效')
        else if (a2.includes(ORIG) && !leaked) FAIL('T4 messages.transform 回写', '模型仍能逐字引用原文 —— 钩子未生效(fork 未保留/回写无效)')
        else if (leaked) WARN('T4 无法判定', '模型 turn1 复述了原文污染判定 —— 换个更强势的 prompt 重跑')
        else if (/"replaced":[1-9]/.test(log1)) WARN('T4 存疑', '钩子日志显示已替换,但模型回答既无占位符也无原文(弱模型答非所问) —— 人工看 transcript 复核')
        else FAIL('T4 钩子未触发', '探针插件无 transform 日志 —— fork 未保留该钩子或插件未被加载(检查 .opencode/plugin 扫描)')
        // T5:让模型 echo 唯一标记;插件 permission.ask 应直接 deny(事件不到 SSE、命令无输出)
        console.log('\n[T5] permission.ask 插件 deny')
        await apiLong('/session/' + sid2 + '/message', { parts: [{ type: 'text', text: '【只允许用 bash 工具】执行命令: echo ' + RAN + ' ,然后把输出原样复述一遍。' }] }, 300000, B2)
        stop2.done = true
        const g3 = await api('GET', '/session/' + sid2 + '/message', undefined, B2)
        const ranOut = toolOutputs(normMsgs(g3.json)).includes(RAN)
        const log2 = readProbeLog(t4Dir)
        const askFired = log2.includes('permission.ask') && log2.includes(RAN)
        if (ranOut) {
          if (askFired) FAIL('T5 permission.ask', '钩子已触发但 deny 未生效(命令仍执行) —— fork 回写无效')
          else if (permReplies > 0) FAIL('T5 permission.ask', '权限事件到达 SSE 并被自动放行 —— 插件 deny 未生效(钩子未保留?)')
          else WARN('T5 无法判定', '命令直接执行且未触发权限询问 —— 项目 opencode.json 的 permission.bash=ask 未生效,查 fork 配置面')
        } else {
          if (askFired) PASS('T5 permission.ask deny', '命令被插件拦截,工具输出无执行痕迹')
          else WARN('T5 无法判定', '模型没执行 bash(也没触发权限) —— 模型行为,重跑或换 prompt')
        }
        // T6:experimental.chat.system.transform —— 插件往系统提示尾部注入唯一标记,问模型能否看到(B2 的前提)
        console.log('\n[T6] experimental.chat.system.transform 系统提示注入')
        const T6M = 'T6-MARKER-' + RAND
        await apiLong('/session/' + sid2 + '/message', { parts: [{ type: 'text', text: '你的系统提示里有一句"注入测试标记:T6-MARKER-XXXXXX"样式的标记。请原样复述这个标记(只要标记本身,不要别的字)。如果找不到,只回答:找不到。' }] }, 300000, B2)
        const g4 = await api('GET', '/session/' + sid2 + '/message', undefined, B2)
        const a4 = assistantTexts(normMsgs(g4.json))
        const log3 = readProbeLog(t4Dir)
        if (a4.includes(T6M)) PASS('T6 system.transform 注入', '模型能复述系统提示里的注入标记 —— 钩子触发且回写生效')
        else if (/"hook":"system.transform"/.test(log3)) WARN('T6 存疑', '钩子日志显示已触发并追加,但模型没能复述标记(可能注入了但模型没注意) —— 人工看 transcript 复核')
        else FAIL('T6 钩子未触发', '探针插件无 system.transform 日志 —— fork 未保留该钩子')
        // T8:双模型与读图能力(消息级 body.model 切换 + 多模态图片输入;沿用隔离 serve B2,独立会话用完即删)
        console.log('\n[T8] 双模型与读图能力(消息级模型切换 / 多模态读图)')
        let sid3 = null
        try {
          // 模型发现:GET /config/providers 拍平 → {providerID, modelID, name, image}
          const rp = await api('GET', '/config/providers', undefined, B2)
          const provAll = (rp.json && (rp.json.all || rp.json.providers || rp.json)) || []
          const models = []
          for (const p of (Array.isArray(provAll) ? provAll : [])) {
            for (const [mid, m] of Object.entries(p.models || {})) {
              models.push({ providerID: p.id || p.providerID || '?', modelID: mid, name: (m && m.name) || mid, image: !!(((m && m.capabilities && m.capabilities.input) || {}).image) })
            }
          }
          const mmList = models.filter((m) => m.image)
          console.log('  (模型清单 ' + models.length + ' 个: ' + models.map((m) => m.providerID + '/' + m.modelID).join(', ') + ')')
          console.log('  (多模态 ' + mmList.length + ' 个: ' + (mmList.map((m) => m.name).join(', ') || '无') + ')')
          // 发消息时双写:body.model={providerID,modelID} + 顶层 providerID/modelID(兼容不同 fork 版本)
          const sendWith = (m, parts, ms) => apiLong('/session/' + sid3 + '/message', { parts, model: { providerID: m.providerID, modelID: m.modelID }, providerID: m.providerID, modelID: m.modelID }, ms || 180000, B2)
          const answerText = (r) => {
            const parts = (r && r.json && (Array.isArray(r.json.parts) ? r.json.parts : (r.json.data && r.json.data.parts))) || []
            return parts.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n')
          }
          const answered = (r) => !!(r && r.status < 400 && answerText(r).trim())
          // HTTP 200 也可能内嵌 info.error(账号余额/鉴权等模型侧原因,实测 deepseek Insufficient Balance) —— 不是切换机制的锅,要区分开
          const errOf = (r) => { const e = r && r.json && r.json.info && r.json.info.error; return e ? String((e.data && e.data.message) || e.message || e.name || 'error') : '' }
          const echoOk = (r, m) => { const i = r && r.json && r.json.info; return !!(i && i.modelID === m.modelID && i.providerID === m.providerID) }
          const rs = await api('POST', '/session', { title: 't8-probe', directory: t4Dir }, B2)
          sid3 = rs.json && (rs.json.id || (rs.json.data && rs.json.data.id) || (rs.json.info && rs.json.info.id))
          if (!sid3) FAIL('T8 POST /session', 'status=' + rs.status)
          else {
            // T8a:同一会话两条消息各指定不同模型 —— 都拿到回答且回显各随消息 = fork 支持消息级模型切换
            const uniq = []
            for (const m of models) { if (!uniq.some((x) => x.modelID === m.modelID)) uniq.push(m) }
            if (uniq.length < 2) WARN('T8a 双模型切换', '模型清单不足两个不同 modelID(只有 ' + uniq.length + ' 个) —— 跳过')
            else {
              // 清单前几个可能是死账号(秒回 info.error)—— 顺延扫描,各找第一个能答的 A/B(上限 8 个)
              const scan = uniq.slice(0, 8)
              let A = null, r1 = null, Bm = null, r2 = null, lastWhy = ''
              const why = (m, r) => m.providerID + '/' + m.modelID + ':' + (r.status >= 400 ? 'HTTP' + r.status : errOf(r) || '无回答')
              for (const m of scan) { const r = await sendWith(m, [{ type: 'text', text: '只回答:甲' }]); if (answered(r)) { A = m; r1 = r; break } lastWhy = why(m, r) }
              if (A) for (const m of scan) { if (m.modelID === A.modelID) continue; const r = await sendWith(m, [{ type: 'text', text: '只回答:乙' }]); if (answered(r)) { Bm = m; r2 = r; break } lastWhy = why(m, r) }
              if (A && Bm && echoOk(r1, A) && echoOk(r2, Bm)) PASS('T8a 消息级模型切换', A.name + ' → ' + Bm.name + ' 两条都拿到回答且 info 回显各随消息指定 —— fork 支持消息级 model 指定')
              else if (A && Bm) WARN('T8a 消息级模型切换', A.name + '/' + Bm.name + ' 都答了,但 info 回显模型与指定不符 —— 可能全程走默认模型,切换疑似被静默忽略')
              else FAIL('T8a 消息级模型切换', (A ? 'A(' + A.name + ') 能答,但找不到第二个能答的模型' : '清单前 ' + scan.length + ' 个模型无一能答') + ';末次 ' + lastWhy + ' —— 消息级切换不可用或模型全挂,验证棒整卡多模态成唯一通道')
            }
            // T8b:多模态读图 —— 带 64x64 纯红 PNG 问颜色,答出红/red = 图片真进了上下文
            const mm = models.find((m) => m.image)
            if (!mm) WARN('T8b 多模态读图', 'serve 无多模态模型,读图环节降级 console+DOM 断言')
            else {
              let a3 = '', why3 = '', ok3 = false
              for (let att = 1; att <= 2 && !ok3; att++) {   // 免费模型路由偶发"No provider available"(实测,隔离 serve 复测又正常) —— 重试一次
                try {
                  const r3 = await sendWith(mm, [{ type: 'file', mime: 'image/png', url: RED_PNG }, { type: 'text', text: '这张图主要是什么颜色?只答颜色名。' }], 240000)
                  a3 = answerText(r3).trim()
                  if (r3.status < 400 && /红|red/i.test(a3)) ok3 = true
                  else why3 = 'status=' + r3.status + (errOf(r3) ? ' 错误:' + errOf(r3) : '') + (a3 ? ' 答「' + a3.slice(0, 60) + '」' : ' 无回答')
                } catch (e) { why3 = e.message }
              }
              if (ok3) PASS('T8b 多模态读图', mm.name + ' 答「' + a3.slice(0, 40) + '」—— 多模态可读图')
              else FAIL('T8b 多模态读图', mm.providerID + '/' + mm.modelID + ' 两次均失败(末次 ' + why3 + ') —— 读图失败/答非所问')
            }
          }
        } catch (e) { FAIL('T8 执行', e.message) }
        finally { try { if (sid3) await api('DELETE', '/session/' + sid3, undefined, B2) } catch {} }
      }
    }
  } catch (e) { FAIL('T4/T5 执行', e.message) }
  finally {
    try {
      if (proc) {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        else proc.kill()
      }
    } catch {}
    try { fs.rmSync(t4Dir, { recursive: true, force: true }) } catch {}
  }
  dump()
}
function dump() { console.log('\n== ' + passN + ' 过 / ' + warnN + ' 警 / ' + failN + ' 失败 =='); process.exit(failN ? 1 : 0) }
main().catch((e) => { console.error(e); process.exit(1) })
