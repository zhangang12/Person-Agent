// 浏览器 MCP 自测：通过 stdio 跑 MCP 协议握手 + 真浏览器导航/取文本/执行JS。
// 用法： node mcp/selftest.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srv = spawn(process.execPath, [path.join(__dirname, 'browser-mcp.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''; const waiters = new Map(); let id = 0
srv.stdout.setEncoding('utf8')
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } } })
const req = (method, params, timeout = 30000) => { const myId = ++id; return new Promise((res, rej) => { const to = setTimeout(() => { waiters.delete(myId); rej(new Error('超时 ' + method)) }, timeout); waiters.set(myId, (m) => { clearTimeout(to); res(m) }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n') }) }
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
// 注意:本文件的 ok 是 (条件, 名称),与仓里其它自测的 (名称, 条件) 相反 —— 写反了断言会恒真(名称字符串永远 truthy)
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

try {
  const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  ok(init.result?.serverInfo?.name === 'BocomHermes-browser', 'initialize 返回 serverInfo')
  notify('notifications/initialized')
  const list = await req('tools/list')
  ok(Array.isArray(list.result?.tools) && list.result.tools.some((t) => t.name === 'headless_navigate'), 'tools/list 含 headless_navigate（' + (list.result?.tools?.length || 0) + ' 个工具）')
  ok(list.result.tools.some((t) => t.name === 'doc_read'), 'tools/list 含 doc_read(任务编排加工环节)')
  // ── 契约:两套浏览器工具族必须都在、且【绝不重名】────────────────────────
  // browser_*  = 内嵌浏览器(用户真在用的那个:带登录态、看得见、强引擎)——端到端验证走这组
  // headless_* = MCP 进程内另起的一次性无头浏览器(无登录态、看不见)——只适合公网只读页
  // 重名是硬故障:tools/list 里两个同名不同 schema 的条目,模型必然随机挑一个,而且没人会发现。
  // (这里真踩过:新族的会话收口和弱族的关浏览器都叫 browser_close。)
  {
    const names = (list.result?.tools || []).map((t) => t.name)
    const dup = names.filter((n, i) => names.indexOf(n) !== i)
    ok(dup.length === 0, '★工具名零重复' + (dup.length ? ' —— 重了: ' + dup.join(',') : ''))
    for (const n of ['browser_open', 'browser_read', 'browser_act', 'browser_assert', 'browser_shot', 'browser_diag', 'browser_close']) {
      ok(names.includes(n), '  内嵌浏览器族含 ' + n)
    }
    for (const n of ['headless_navigate', 'headless_get_text', 'headless_close']) {
      ok(names.includes(n), '  无头族已改名带 headless_ 前缀:' + n)
    }
    ok(!names.some((n) => ['browser_navigate', 'browser_get_text', 'browser_eval', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_get_html'].includes(n)),
      '★弱族不再占用 browser_ 前缀(否则模型挑错的那个,验的就不是真实环境)')
    const open = (list.result?.tools || []).find((t) => t.name === 'browser_open')
    ok(!!open && Array.isArray(open.inputSchema?.required) && open.inputSchema.required.includes('purpose'),
      '  browser_open 强制要 purpose(用户得知道 Agent 在他浏览器里干嘛)')
  }

  // ── doc_read:任务编排链路的加工积木(不依赖浏览器/relay,先测) ──
  {
    const os = await import('node:os')
    const fsm = await import('node:fs')
    const tmp = fsm.mkdtempSync(path.join(os.tmpdir(), 'docread-'))
    // csv/txt 直读
    const csvP = path.join(tmp, '导出报表.csv')
    fsm.writeFileSync(csvP, '客户号,金额,状态\nC001,8000,正常\nC002,-99,异常', 'utf8')
    const r1 = await req('tools/call', { name: 'doc_read', arguments: { path: csvP } }, 20000)
    const t1 = r1.result?.content?.[0]?.text || ''
    ok(/C002,-99,异常/.test(t1) && /已完整/.test(t1), 'doc_read 读 CSV 全文')
    // xlsx → CSV 文本(复用 attachments.js 的 xlsx 解析;真写一个 xlsx)
    let xlsxOk = false
    try {
      const { createRequire } = await import('node:module')
      const xlsx = createRequire(import.meta.url)('../node_modules/xlsx')
      const wb = xlsx.utils.book_new()
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['户名', '余额'], ['张三', 123.45]]), '对账单')
      const xp = path.join(tmp, '对账.xlsx')
      xlsx.writeFile(wb, xp)
      const r2 = await req('tools/call', { name: 'doc_read', arguments: { path: xp } }, 20000)
      const t2 = r2.result?.content?.[0]?.text || ''
      xlsxOk = /Sheet: 对账单/.test(t2) && /张三,123.45/.test(t2)
      ok(xlsxOk, 'doc_read 读 XLSX → 每 Sheet 一段 CSV 文本')
    } catch (e) { console.log('  ! xlsx 库不可用,跳过 xlsx 用例: ' + e.message) }
    // 分段:limit 截断 + nextOffset 续读
    const bigP = path.join(tmp, 'big.txt')
    fsm.writeFileSync(bigP, 'A'.repeat(50) + 'B'.repeat(50), 'utf8')
    const r3 = await req('tools/call', { name: 'doc_read', arguments: { path: bigP, limit: 60 } }, 20000)
    const t3 = r3.result?.content?.[0]?.text || ''
    ok(/继续传 offset=60/.test(t3), 'doc_read 大文件分段(带 nextOffset)')
    const r4 = await req('tools/call', { name: 'doc_read', arguments: { path: bigP, offset: 60 } }, 20000)
    ok(/B{40}/.test(r4.result?.content?.[0]?.text || ''), 'doc_read 按 offset 续读')
    // 防呆
    const r5 = await req('tools/call', { name: 'doc_read', arguments: { path: '相对路径.csv' } }, 20000)
    ok(/必须是绝对路径/.test(r5.result?.content?.[0]?.text || ''), 'doc_read 拒绝相对路径')
    const r6 = await req('tools/call', { name: 'doc_read', arguments: { path: path.join(tmp, '不存在.csv') } }, 20000)
    ok(/文件不存在/.test(r6.result?.content?.[0]?.text || ''), 'doc_read 不存在给可读错误')
    try { fsm.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  const html = 'data:text/html,' + encodeURIComponent('<title>TS-OK</title><body><h1 id=h>HELLO_BOCOMHERMES</h1>')
  const nav = await req('tools/call', { name: 'headless_navigate', arguments: { url: html } }, 60000)
  const navText = nav.result?.content?.[0]?.text || ''
  if (nav.result?.isError) {
    console.log('  ! 浏览器不可用（MCP 协议已通过，运行时需 Edge/Chrome + Node22+）：' + navText.replace(/\n/g, ' '))
  } else {
    ok(/TS-OK/.test(navText), 'navigate 返回标题（' + navText.replace(/\n/g, ' ') + '）')
    const txt = await req('tools/call', { name: 'headless_get_text', arguments: {} }, 20000)
    ok(/HELLO_BOCOMHERMES/.test(txt.result?.content?.[0]?.text || ''), 'get_text 取到正文')
    const ev = await req('tools/call', { name: 'headless_eval', arguments: { expression: 'document.querySelector("#h").id' } }, 20000)
    ok((ev.result?.content?.[0]?.text || '') === 'h', 'eval 返回元素 id')
    await req('tools/call', { name: 'headless_close', arguments: {} }, 10000)
  }
} catch (e) { console.error('selftest error:', e.message); fail++ }

// ── 编排 MCP 的工具契约(另起一个进程,与浏览器 MCP 互不影响)──────────────
// 只验协议层能不能把工具亮出来、必填项对不对 —— 真正的行为在 replay ㉗(走真 relay)。
// 【为什么值得单独验】report_findings 是把"发现"从格式约定换成工具调用的那一步;
// 工具名/必填项写错的话,模型调不通只会静默不报,而这正是本轮要消灭的那种失败。
try {
  const oc = spawn(process.execPath, [path.join(__dirname, 'orch-mcp.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] })
  let ob = ''; const ow = new Map(); let oid = 0
  oc.stdout.setEncoding('utf8')
  oc.stdout.on('data', (d) => { ob += d; let i; while ((i = ob.indexOf('\n')) !== -1) { const line = ob.slice(0, i).trim(); ob = ob.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } if (m.id && ow.has(m.id)) { ow.get(m.id)(m); ow.delete(m.id) } } })
  const oreq = (method, params, timeout = 10000) => { const my = ++oid; return new Promise((res, rej) => { const to = setTimeout(() => { ow.delete(my); rej(new Error('超时 ' + method)) }, timeout); ow.set(my, (m) => { clearTimeout(to); res(m) }); oc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n') }) }
  await oreq('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  const ol = await oreq('tools/list')
  const on = (ol.result?.tools || []).map((t) => t.name)
  ok(on.includes('report_findings'), '编排 MCP 亮出 report_findings(发现从格式约定换成工具调用)')
  const rf = (ol.result?.tools || []).find((t) => t.name === 'report_findings')
  ok(!!rf && (rf.inputSchema?.required || []).includes('nodeRef'),
    '  必填 nodeRef(只认 nodeId 的话两个工作流同时跑会把发现记错人)')
  ok(!!rf && (rf.inputSchema?.required || []).includes('findings'), '  必填 findings')
  ok(!!rf && rf.inputSchema?.properties?.findings?.items?.required?.includes('what'), '  每条发现必填 what(说不清是什么就核不动)')
  const odup = on.filter((n, i) => on.indexOf(n) !== i)
  ok(odup.length === 0, '  编排 MCP 工具名零重复' + (odup.length ? ' —— 重了: ' + odup.join(',') : ''))
  // 没起壳层时调它必须给出【人能看懂的】失败,而不是抛栈
  const bad = await oreq('tools/call', { name: 'report_findings', arguments: { findings: [{ what: 'x' }] } })
  ok(/nodeRef/.test(bad.result?.content?.[0]?.text || ''), '  缺 nodeRef → 明确告诉它去哪儿抄,不是抛栈')
  try { oc.stdin.end() } catch {}
  oc.kill()
} catch (e) { console.error('orch-mcp contract error:', e.message); fail++ }

console.log(`\n小结:${pass} 通过 / ${fail} 失败`)
try { srv.stdin.end() } catch {}
srv.kill()
process.exit(fail ? 1 : 0)
