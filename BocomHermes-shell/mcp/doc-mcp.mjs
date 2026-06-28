// BocomHermes · 文档读取 MCP(本地 stdio,零业务依赖)
// 给 opencode 一个工具:按需把用户拖入的本地文档(PDF/DOCX/XLSX/CSV/TXT/MD/HTML/JSON/XML)抽成文本。
//   · A+B 折中:文档不预抽塞 prompt,而是把"路径"给 opencode,它需要时自己调 read_document 读
//     (可反复读、可分段),抽取用客户端解析器(pdf-parse/mammoth/xlsx),搞定二进制格式。
//   · 走主进程本地 HTTP 中继(复用 mail-relay.json 的 server + token)。文件全在本机。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const log = (...a) => process.stderr.write('[doc-mcp] ' + a.join(' ') + '\n')

function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
const DATA = userData()
function relayCfg() { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'mail-relay.json'), 'utf8')) } catch { return null } }
function relayPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const cfg = relayCfg(); if (!cfg) return reject(new Error('找不到 mail-relay.json — 桌面智能体没在跑'))
    const data = JSON.stringify(body || {})
    const req = http.request({ hostname: '127.0.0.1', port: cfg.port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-bocom-tok': cfg.token } }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => buf += c)
      res.on('end', () => { try { const j = JSON.parse(buf || '{}'); j.error ? reject(new Error(j.error)) : resolve(j) } catch (e) { reject(new Error('relay 响应非 JSON: ' + buf.slice(0, 200))) } })
    })
    req.on('error', (e) => reject(new Error('relay 连不上(' + cfg.port + '): ' + e.message)))
    req.write(data); req.end()
  })
}

const TOOLS = [
  {
    name: 'read_document',
    description:
      '读取用户拖入对话的本地文档的文本内容。专治 opencode 自带 Read 读不了的二进制文档:PDF / DOCX / XLSX(Excel)/ PPTX;也支持 CSV / TXT / MD / HTML / JSON / XML。\n' +
      '用法:用户在消息里给出文档路径后,调本工具读它的内容再回答。大文档可分段:先不带 offset 读开头,按返回的 nextOffset 续读。\n' +
      '注意:纯文本 / 代码文件在项目目录内的,用你自带的 Read 即可,不必用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档的本地绝对路径(从用户消息里拿)' },
        offset: { type: 'number', description: '从第几个字符开始读(分段续读用,默认 0)' },
        limit: { type: 'number', description: '本次最多读多少字符(默认 20000,最大 100000)' },
      },
      required: ['path'],
    },
  },
]

async function callTool(name, a) {
  a = a || {}
  if (name === 'read_document') {
    const p = String(a.path || '').trim()
    if (!p) return '需要 path(文档的本地绝对路径)'
    const r = await relayPost('/doc/read', { path: p, offset: a.offset, limit: a.limit })
    const head = `文档:${p}\n总长 ${r.total} 字符` + (r.hasMore ? `(本段 ${a.offset || 0}~,未读完;续读传 offset=${r.nextOffset})` : '(已全部)') + '\n\n'
    return head + (r.content || '(空)')
  }
  throw new Error('未知工具: ' + name)
}

// ── MCP stdio 协议 ──
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'bocomhermes-doc', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '文档读取出错: ' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现: ' + method } })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle err: ' + e.message)) } })
log('ready · userData=' + DATA)
