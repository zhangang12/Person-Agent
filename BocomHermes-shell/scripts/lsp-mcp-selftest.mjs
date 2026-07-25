// 自测:mcp/lsp-mcp.mjs —— ①帧编解码 ②扩展名路由 ③1基↔0基换算 ④路径围栏 ⑤真实握手
// (起 typescript-language-server,initialize + didOpen + definition,允许慢,超时 30s)。
// 跑法:npm run lspmcp:test
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeFrame, createFrameDecoder, routeServer, toLspPos, fromLspPos, resolveInRoot, LspClient } from '../mcp/lsp-mcp.mjs'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

console.log('用例1:Content-Length 帧编解码')
{
  const m1 = { jsonrpc: '2.0', id: 1, method: 'initialize' }
  const m2 = { jsonrpc: '2.0', id: 2, result: { 文本: '多字节中文' } }
  const wire = Buffer.from(encodeFrame(m1) + encodeFrame(m2), 'utf8')
  const got = []
  const dec = createFrameDecoder((m) => got.push(m))
  // 故意切得稀碎(每 7 字节一片)喂进去,验证跨片重组
  for (let i = 0; i < wire.length; i += 7) dec.feed(wire.slice(i, i + 7))
  ok('碎片重组出 2 条消息', got.length === 2, got.length)
  ok('第 1 条内容正确', got[0] && got[0].method === 'initialize', got[0])
  ok('多字节内容按字节长截对(中文不烂码)', got[1] && got[1].result && got[1].result.文本 === '多字节中文', got[1])
  // 编码形态:Content-Length 是字节数不是字符数
  const f = encodeFrame({ a: '中' })
  ok('编码帧头字节长正确', f.startsWith('Content-Length: ' + Buffer.byteLength(JSON.stringify({ a: '中' }), 'utf8') + '\r\n\r\n'), f.slice(0, 40))
}

console.log('用例2:扩展名路由')
{
  ok('.ts → ts', routeServer('a/b.ts') === 'ts')
  ok('.tsx → ts', routeServer('a/b.tsx') === 'ts')
  ok('.js/.mjs/.cjs → ts', routeServer('a.js') === 'ts' && routeServer('a.mjs') === 'ts' && routeServer('a.cjs') === 'ts')
  ok('大写扩展名也认(.TS)', routeServer('A.TS') === 'ts')
  ok('.vue → vue', routeServer('comp/App.vue') === 'vue')
  ok('.py/.pyi → python', routeServer('x.py') === 'python' && routeServer('x.pyi') === 'python')
  ok('不认的类型 → null(.md/.json)', routeServer('r.md') === null && routeServer('c.json') === null)
}

console.log('用例3:1基 ↔ 0基换算')
{
  const p = toLspPos(1, 1)
  ok('1基(1,1) → LSP(0,0)', p.line === 0 && p.character === 0, p)
  const q = toLspPos(12, 34)
  ok('1基(12,34) → LSP(11,33)', q.line === 11 && q.character === 33, q)
  const r = fromLspPos({ line: 11, character: 33 })
  ok('LSP(11,33) → 1基(12,34) 回程一致', r.line === 12 && r.character === 34, r)
  ok('0/负数钳到 0(不崩)', toLspPos(0, -5).line === 0 && toLspPos(0, -5).character === 0, toLspPos(0, -5))
}

console.log('用例4:路径围栏')
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lspfence-'))
  try {
    ok('根内相对路径放行', resolveInRoot(root, 'src/a.ts') === path.join(root, 'src', 'a.ts'), resolveInRoot(root, 'src/a.ts'))
    ok('根内绝对路径放行', resolveInRoot(root, path.join(root, 'src', 'a.ts')) === path.join(root, 'src', 'a.ts'))
    ok('.. 逃逸拒绝', resolveInRoot(root, '../secret/x.ts') === null)
    ok('根外绝对路径拒绝', resolveInRoot(root, path.join(path.dirname(root), 'outside.ts')) === null)
    ok('根目录本身拒绝(不是文件)', resolveInRoot(root, '.') === null)
    ok('伪装兄弟目录拒绝(root2 不蹭 root)', resolveInRoot(root, path.join(root + '2', 'x.ts')) === null)
  } finally { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} }
}

console.log('用例5:真实握手(typescript-language-server,超时 30s)')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lspmcp-'))
  const f = path.join(tmp, 'demo.ts')
  // 1 基:greet 声明在 1:10;调用点在 4:13
  fs.writeFileSync(f, 'function greet(name: string): string {\n  return "hi " + name\n}\nconst msg = greet("world")\n')
  const client = new LspClient({ serverKey: 'ts', root: tmp, logf: () => {} })
  try {
    await client.ensureStarted()
    ok('initialize 握手成功', true)
    const uri = await client.openFile(f)
    const def = await client.request('textDocument/definition', { textDocument: { uri }, position: toLspPos(4, 13) }, 30000)
    const loc = Array.isArray(def) ? def[0] : def
    const range = loc && (loc.range || loc.targetSelectionRange || loc.targetRange)
    ok('definition 有返回', !!range, def)
    if (range) {
      const p = fromLspPos(range.start)
      ok('definition 指向 greet 声明(1:10)', p.line === 1 && p.character === 10, p)
    }
  } catch (e) {
    ok('真实握手', false, String(e && e.message || e))
  } finally {
    client.kill()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
