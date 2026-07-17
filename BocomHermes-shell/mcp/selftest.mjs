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
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

try {
  const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  ok(init.result?.serverInfo?.name === 'BocomHermes-browser', 'initialize 返回 serverInfo')
  notify('notifications/initialized')
  const list = await req('tools/list')
  ok(Array.isArray(list.result?.tools) && list.result.tools.some((t) => t.name === 'browser_navigate'), 'tools/list 含 browser_navigate（' + (list.result?.tools?.length || 0) + ' 个工具）')
  ok(list.result.tools.some((t) => t.name === 'doc_read'), 'tools/list 含 doc_read(任务编排加工环节)')

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
  const nav = await req('tools/call', { name: 'browser_navigate', arguments: { url: html } }, 60000)
  const navText = nav.result?.content?.[0]?.text || ''
  if (nav.result?.isError) {
    console.log('  ! 浏览器不可用（MCP 协议已通过，运行时需 Edge/Chrome + Node22+）：' + navText.replace(/\n/g, ' '))
  } else {
    ok(/TS-OK/.test(navText), 'navigate 返回标题（' + navText.replace(/\n/g, ' ') + '）')
    const txt = await req('tools/call', { name: 'browser_get_text', arguments: {} }, 20000)
    ok(/HELLO_BOCOMHERMES/.test(txt.result?.content?.[0]?.text || ''), 'get_text 取到正文')
    const ev = await req('tools/call', { name: 'browser_eval', arguments: { expression: 'document.querySelector("#h").id' } }, 20000)
    ok((ev.result?.content?.[0]?.text || '') === 'h', 'eval 返回元素 id')
    await req('tools/call', { name: 'browser_close', arguments: {} }, 10000)
  }
} catch (e) { console.error('selftest error:', e.message); fail++ }

console.log(`\n小结：${pass} 通过 / ${fail} 失败`)
try { srv.stdin.end() } catch {}
srv.kill()
process.exit(fail ? 1 : 0)
