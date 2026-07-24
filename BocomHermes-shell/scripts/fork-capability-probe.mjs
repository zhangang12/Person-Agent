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
// 用法: node scripts/fork-capability-probe.mjs [baseURL]   (默认 http://127.0.0.1:4096)
// 注意:T1 会真实调一次模型(读大文件),内网跑一次约 1-3 分钟;临时文件用完即删。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:4096'
const SPILL_MARK = '输出过长已外溢'
let passN = 0, warnN = 0, failN = 0
const PASS = (n, d) => { passN++; console.log('  ✓ ' + n + (d ? ' — ' + d : '')) }
const WARN = (n, d) => { warnN++; console.log('  ⚠ ' + n + (d ? ' — ' + d : '')) }
const FAIL = (n, d) => { failN++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) }

async function api(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, text, json }
}
// 长回合用 http.request(实测:electron-as-node 的 undici fetch 在分钟级长响应上会 fetch failed,http 模块稳)
import http from 'node:http'
function apiLong(p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p)
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
    const send = await apiLong('/session/' + sid + '/message', { parts: [{ type: 'text', text: '用 read 工具读取文件 ' + bigFile + '(直接 read,不要分段),然后只回答:它的总行数。' }] }, 300000)
    // 有的版本 POST 直接返回回合结果(单条 assistant 消息或消息数组),有的要拉消息列表;三种形状都认
    let msgs = null
    if (Array.isArray(send.json)) msgs = send.json
    else if (send.json && Array.isArray(send.json.parts)) msgs = [send.json]
    else if (send.json && (send.json.messages || send.json.data)) msgs = send.json.messages || send.json.data
    if (!msgs || !msgs.length) { const g = await api('GET', '/session/' + sid + '/message'); msgs = g.json && (Array.isArray(g.json) ? g.json : (g.json.messages || g.json.data)) }
    const readParts = []
    for (const m of msgs || []) for (const p of (m.parts || (m.data && m.data.parts) || [])) {
      if (p && p.type === 'tool' && /read/i.test(String(p.tool || (p.state && p.state.tool) || p.name || ''))) readParts.push(p)
    }
    if (!readParts.length) WARN('模型没调 read', '模型行为差异,不是机制问题 —— 换个更强势的 prompt 重跑本探针')
    else {
      const out = String(readParts.map((p) => (p.state && p.state.output) || p.output || '').join('\n'))
      if (out.includes(SPILL_MARK)) PASS('插件外溢生效', 'read 输出被替换为摘要+落盘路径(tool.execute.after 回写确认)')
      else if (out.length > 8000) FAIL('插件未生效', 'read 输出原文 ' + out.length + ' 字符直接进了上下文 —— fork 插件机制被砍/目录没扫/没加载 read-spill.js(检查 ~/.config/opencode/plugin/)')
      else WARN('read 输出小于阈值', out.length + ' 字符 < 8000 —— 无法判定插件是否生效(文件被 fork 侧截断了?这反而是好事,说明 R1 已在引擎里)')
    }
  } catch (e) { FAIL('T1 执行', e.message) }
  finally { try { if (sid) await api('DELETE', '/session/' + sid) } catch {}; try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {} }
  dump()
}
function dump() { console.log('\n== ' + passN + ' 过 / ' + warnN + ' 警 / ' + failN + ' 失败 =='); process.exit(failN ? 1 : 0) }
main().catch((e) => { console.error(e); process.exit(1) })
