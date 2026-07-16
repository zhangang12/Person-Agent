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
  ok(list.result?.tools?.length === 16, '16 个工具(' + (list.result?.tools?.length || 0) + ')')   // P3/P6 加了 skill_* 等 4 个:12→16,断言曾一直没跟上

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

  // scan_impact: 在临时 git repo 里测
  const fs = await import('node:fs'); const path2 = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const repo = path2.join(tmp, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path2.join(repo, 'a.js'), 'export function calcRate(x){return x*0.05}\n')
  fs.writeFileSync(path2.join(repo, 'b.js'), 'import { calcRate } from "./a"; export const v = calcRate(100)\n')
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo }); execFileSync('git', ['config', 'user.name', 't'], { cwd: repo }); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    const si = await req('tools/call', { name: 'scan_impact', arguments: { bundleId: 'b_test01', symbol: 'calcRate', cwd: repo } })
    const sit = si.result?.content?.[0]?.text || ''
    ok(/2 个文件/.test(sit) && /a\.js/.test(sit) && /b\.js/.test(sit), 'scan_impact 找到 a.js + b.js')
    const si2 = await req('tools/call', { name: 'scan_impact', arguments: { bundleId: 'b_test01', symbol: 'doesNotExist', cwd: repo } })
    ok(/无匹配/.test(si2.result?.content?.[0]?.text || ''), 'scan_impact 无匹配也正常返回(不报错)')
    const scanFp = path2.join(tmp, 'scans', 'b_test01.json')
    const sj = JSON.parse(fs.readFileSync(scanFp, 'utf8'))
    ok(Array.isArray(sj) && sj.length === 2 && sj[0].symbol === 'calcRate' && sj[0].files.length === 2, 'scan_impact 落盘到 scans/<bundleId>.json')
  } catch (e) { fail++; console.log('  ✗ scan_impact 测试失败:', e.message) }

  // repro_self_review
  const sr = await req('tools/call', { name: 'repro_self_review', arguments: { bundleId: 'b_test01', summary: '修了 calc.js 的空指针', risk: 4, edge_cases: '负数未测' } })
  ok(/self-review 已记录/.test(sr.result?.content?.[0]?.text || '') && /risk=4/.test(sr.result?.content?.[0]?.text || ''), 'repro_self_review 接受并落盘')
  const sr2 = await req('tools/call', { name: 'repro_self_review', arguments: { bundleId: 'b_test01', summary: 'x', risk: 9 } })
  ok(/risk 必须在 1-5/.test(sr2.result?.content?.[0]?.text || ''), 'repro_self_review 拒绝非法 risk')
  const revFp = path.join(tmp, 'reviews', 'b_test01.json')
  const rj = JSON.parse(fs.readFileSync(revFp, 'utf8'))
  ok(rj.risk === 4 && /空指针/.test(rj.summary) && rj.edge_cases === '负数未测', 'review JSON 字段完整')

  // 共享便签
  const bn1 = await req('tools/call', { name: 'bundle_note', arguments: { bundleId: 'b_test01', key: 'is_cors', status: 'excluded', evidence: '读过 api.js:42 无 cors 配置' } })
  ok(/✓ note\[is_cors\] = excluded/.test(bn1.result?.content?.[0]?.text || ''), 'bundle_note 写入 excluded')
  const bn2 = await req('tools/call', { name: 'bundle_note', arguments: { bundleId: 'b_test01', key: 'is_null', status: 'confirmed', evidence: 'calc.js:42 rate 字段未赋值' } })
  ok(/✓ note\[is_null\] = confirmed/.test(bn2.result?.content?.[0]?.text || ''), 'bundle_note 写入 confirmed')
  const rn = await req('tools/call', { name: 'read_notes', arguments: { bundleId: 'b_test01' } })
  const rnt = rn.result?.content?.[0]?.text || ''
  ok(/✗ \[excluded\] is_cors/.test(rnt) && /✓ \[confirmed\] is_null/.test(rnt), 'read_notes 列出两条便签 + icon')
  // 同 key 覆盖
  const bn3 = await req('tools/call', { name: 'bundle_note', arguments: { bundleId: 'b_test01', key: 'is_null', status: 'maybe', evidence: '再查发现可能 race' } })
  const rn2 = await req('tools/call', { name: 'read_notes', arguments: { bundleId: 'b_test01' } })
  ok(/\? \[maybe\] is_null/.test(rn2.result?.content?.[0]?.text || ''), '同 key 写入覆盖原状态')

  // 回滚:在前面创建的临时 git repo 上,改一个文件 + 加一个新文件,再 dryRun + 真回滚
  try {
    fs.writeFileSync(path2.join(repo, 'a.js'), 'export function calcRate(x){return x*999}\n')
    fs.writeFileSync(path2.join(repo, 'c.js'), 'untracked new file\n')
    const dry = await req('tools/call', { name: 'repro_rollback', arguments: { cwd: repo, dryRun: true } })
    const dt = dry.result?.content?.[0]?.text || ''
    ok(/\[DRY RUN\]/.test(dt) && /a\.js/.test(dt) && /c\.js/.test(dt), '[DRY RUN] 列出 a.js (改) + c.js (未跟踪)')
    const realCall = await req('tools/call', { name: 'repro_rollback', arguments: { cwd: repo } })
    ok(/回滚完成/.test(realCall.result?.content?.[0]?.text || ''), 'rollback 真执行成功')
    const aBack = fs.readFileSync(path2.join(repo, 'a.js'), 'utf8')
    ok(/x\*0\.05/.test(aBack), 'a.js 已回到 HEAD 版本(0.05 而非 999)')
    ok(!fs.existsSync(path2.join(repo, 'c.js')), 'c.js 未跟踪新文件已被删')
  } catch (e) { fail++; console.log('  ✗ rollback 测试失败:', e.message) }
} catch (e) { console.error('err:', e.message); fail++ }

console.log(`\n小结: ${pass} 通过 / ${fail} 失败`)
try { srv.stdin.end() } catch {}; srv.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
