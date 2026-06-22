// repro-mcp 自测:用一个临时 BOCOMHERMES_USERDATA 摆几个证据文件,跑 5 个工具看返回
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-test-'))
const evd = path.join(tmp, 'evidence', 'b_test01')
fs.mkdirSync(evd, { recursive: true })
fs.writeFileSync(path.join(evd, 'dom.txt'), '<html><body><div id="err" class="banner"><span>额度计算失败</span></div><div id="ok">其他</div></body></html>')
fs.writeFileSync(path.join(evd, 'req1-body.txt'), '{"amount":50000}')
fs.writeFileSync(path.join(evd, 'recording.txt'), JSON.stringify({ events: [
  { t: 0, act: 'navigate', url: 'http://localhost/credit' },
  { t: 1200, act: 'click', sel: 'button#submit', text: '提交' },
  { t: 2400, act: 'input', sel: 'input[name=amt]', value: '50000' },
  { t: 3500, act: 'submit', sel: 'form#f1' },
  { t: 4800, act: 'click', sel: 'button#confirm' },
] }))

const srv = spawn(process.execPath, [path.join(__dirname, 'repro-mcp.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, BOCOMHERMES_USERDATA: tmp } })
let buf = ''; const waiters = new Map(); let id = 0
srv.stdout.setEncoding('utf8')
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } } })
const req = (method, params, timeout = 10000) => { const myId = ++id; return new Promise((res, rej) => { const to = setTimeout(() => { waiters.delete(myId); rej(new Error('超时 ' + method)) }, timeout); waiters.set(myId, (m) => { clearTimeout(to); res(m) }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n') }) }
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

try {
  const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  ok(init.result?.serverInfo?.name === 'bocomhermes-repro', 'initialize OK')
  notify('notifications/initialized')

  const list = await req('tools/list')
  ok(list.result?.tools?.length === 7, '7 个工具(' + (list.result?.tools?.length || 0) + ')')

  const bs = await req('tools/call', { name: 'list_bundles', arguments: {} })
  ok(/b_test01/.test(bs.result?.content?.[0]?.text || ''), 'list_bundles 含 b_test01')

  const le = await req('tools/call', { name: 'list_evidence', arguments: { bundleId: 'b_test01' } })
  const lt = le.result?.content?.[0]?.text || ''
  ok(/dom\b/.test(lt) && /req1-body/.test(lt) && /recording/.test(lt), 'list_evidence 列出 dom/req1-body/recording')

  const ge = await req('tools/call', { name: 'get_evidence', arguments: { ref: 'ref#b_test01/req1-body' } })
  ok(/"amount":50000/.test(ge.result?.content?.[0]?.text || ''), 'get_evidence 取到请求体')

  const gd = await req('tools/call', { name: 'get_dom_subtree', arguments: { bundleId: 'b_test01', selector: '#err' } })
  ok(/额度计算失败/.test(gd.result?.content?.[0]?.text || ''), 'get_dom_subtree #err 子树')

  const gw = await req('tools/call', { name: 'get_event_window', arguments: { bundleId: 'b_test01', step: 3, radius: 1 } })
  const wt = gw.result?.content?.[0]?.text || ''
  ok(/步 2.*click/.test(wt) && /步 3.*◀──.*input/.test(wt) && /步 4.*submit/.test(wt), 'get_event_window 取到 ±1 窗口含当前步标记')

  // 断言读写
  const ra = await req('tools/call', { name: 'repro_assert', arguments: { bundleId: 'b_test01', kind: 'no_element', value: '.error-banner', why: '修复后该元素应消失' } })
  ok(/已为 b_test01 记入断言/.test(ra.result?.content?.[0]?.text || ''), 'repro_assert 写入成功')
  const ra2 = await req('tools/call', { name: 'repro_assert', arguments: { bundleId: 'b_test01', kind: 'no_console', value: 'TypeError: rate' } })
  ok(/记入断言 #2/.test(ra2.result?.content?.[0]?.text || ''), '第二条断言追加')
  const rl = await req('tools/call', { name: 'repro_assertions', arguments: { bundleId: 'b_test01' } })
  const rlt = rl.result?.content?.[0]?.text || ''
  ok(/no_element.*error-banner/.test(rlt) && /no_console.*TypeError: rate/.test(rlt), 'repro_assertions 列出两条断言')
  // 未知 kind 拒绝
  const bad = await req('tools/call', { name: 'repro_assert', arguments: { bundleId: 'b_test01', kind: 'invalid', value: 'x' } })
  ok(/未知 kind/.test(bad.result?.content?.[0]?.text || ''), 'invalid kind 被拒')
} catch (e) { console.error('err:', e.message); fail++ }

console.log(`\n小结: ${pass} 通过 / ${fail} 失败`)
try { srv.stdin.end() } catch {}; srv.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
