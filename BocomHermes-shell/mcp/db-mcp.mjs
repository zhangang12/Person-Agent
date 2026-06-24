// BocomHermes · OceanBase 只读数据库 MCP(本地 stdio,零业务依赖)
// 给 agent 这些能力(全部只读):列表 / 看结构 / 全库找列 / 行采样(测试库) / 受控 SELECT
// 连接配置(host/端口/user@租户#集群/密码/库)从设置面板配,密码 safeStorage 加密 →
// 走主进程本地 HTTP 中继解密 + mysql2 连接(子进程没法解密)。数据全在内网。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const log = (...a) => process.stderr.write('[db-mcp] ' + a.join(' ') + '\n')

function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
const DATA = userData()

// 复用 mail-relay.json 的本地中继(同一个 HTTP server + token)
function relayCfg() { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'mail-relay.json'), 'utf8')) } catch { return null } }
function relayPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const cfg = relayCfg(); if (!cfg) return reject(new Error('找不到 mail-relay.json — 桌面智能体没在跑,先启动它'))
    const data = JSON.stringify(body || {})
    const req = http.request({ hostname: '127.0.0.1', port: cfg.port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-bocom-tok': cfg.token } }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => buf += c)
      res.on('end', () => { try { const j = JSON.parse(buf || '{}'); j.error ? reject(new Error(j.error)) : resolve(j) } catch (e) { reject(new Error('relay 响应非 JSON: ' + buf.slice(0, 200))) } })
    })
    req.on('error', (e) => reject(new Error('relay 连不上(' + cfg.port + '): ' + e.message)))
    req.write(data); req.end()
  })
}

// rows → 紧凑文本表(列对齐,行/列都截断,避免灌爆 128K)
function renderRows(rows, maxRows) {
  if (!Array.isArray(rows) || !rows.length) return '(0 行)'
  const cap = maxRows || 50
  const shown = rows.slice(0, cap)
  const cols = Object.keys(shown[0])
  const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => String(r[c] == null ? 'NULL' : r[c]).slice(0, 40).length)))
  const fmt = (vals) => vals.map((v, i) => String(v).slice(0, 40).padEnd(widths[i])).join(' | ')
  const head = fmt(cols)
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-')
  const body = shown.map((r) => fmt(cols.map((c) => r[c] == null ? 'NULL' : r[c]))).join('\n')
  const more = rows.length > cap ? `\n…(共 ${rows.length} 行,只显示前 ${cap})` : ''
  return head + '\n' + sep + '\n' + body + more
}

const TOOLS = [
  { name: 'db_tables', description: 'OceanBase 列出表(按 表名 或 表注释 关键词过滤)。信贷表名常是拼音/英文缩写,先用关键词搜(如"额度/loan/limit")定位表。返回 表名+注释+估算行数。', inputSchema: { type: 'object', properties: {
    keyword: { type: 'string', description: '表名或表注释关键词;留空列全部(最多 200)' },
  } } },
  { name: 'db_schema', description: '看某张表的结构:字段名/类型/可空/键/默认值/注释 + 索引 + 建表 DDL。改动点分析时用这个拿"DB 的真实字段"(代码里 Mapper 可能过时,DB 是真相)。', inputSchema: { type: 'object', properties: {
    table: { type: 'string', description: '表名(从 db_tables 拿)' },
  }, required: ['table'] } },
  { name: 'db_columns_grep', description: '全库搜含某关键词的列(列名 或 列注释命中)。例:搜"逾期"→ 所有 overdue/yuqi 字段分布在哪些表;搜"余额"→ 定位所有余额字段。跨表找"某业务概念落在哪"。', inputSchema: { type: 'object', properties: {
    keyword: { type: 'string', description: '列名或列注释关键词' },
  }, required: ['keyword'] } },
  { name: 'db_sample', description: '行采样(连的是测试库,可看真实数据辅助理解字段含义/枚举值)。可选 where 等值过滤。默认 20 行,最多 100。', inputSchema: { type: 'object', properties: {
    table: { type: 'string', description: '表名' },
    limit: { type: 'number', description: '行数,默认 20,最大 100' },
    where: { type: 'object', description: '可选等值过滤,如 {status:"1", product_type:"对公"}(参数化,安全)' },
  }, required: ['table'] } },
  { name: 'db_query', description: '受控只读 SQL(只放行单条 SELECT/SHOW/DESCRIBE/EXPLAIN;任何写关键词直接拒;自动补 LIMIT 500)。需要 JOIN/WHERE/COUNT/GROUP BY 做影响分析时用。不许多条语句。', inputSchema: { type: 'object', properties: {
    sql: { type: 'string', description: '单条只读 SQL。例:SELECT COUNT(*) FROM loan_acct WHERE status=1' },
  }, required: ['sql'] } },
]

async function callTool(name, a) {
  a = a || {}
  if (name === 'db_tables') {
    const r = await relayPost('/db/tables', { keyword: a.keyword })
    const rows = r.rows || []
    if (!rows.length) return '(无匹配表)'
    return `命中 ${rows.length} 张表:\n` + rows.map((t) => `  ${t.name}${t.comment ? '  — ' + t.comment : ''}${t.rows_est != null ? '  (~' + t.rows_est + ' 行)' : ''}`).join('\n')
  }
  if (name === 'db_schema') {
    const r = await relayPost('/db/schema', { table: a.table })
    const s = r.schema || r
    const cols = (s.columns || []).map((c) => `  ${c.col}  ${c.type}${c.nullable === 'NO' ? ' NOT NULL' : ''}${c.key ? ' [' + c.key + ']' : ''}${c.comment ? '  — ' + c.comment : ''}`).join('\n')
    const idx = (s.indexes || []).map((i) => `  ${i.name}: (${i.cols})${i.non_unique == 0 ? ' UNIQUE' : ''}`).join('\n')
    return `表 ${s.table}${s.comment ? '(' + s.comment + ')' : ''}\n\n字段:\n${cols}${idx ? '\n\n索引:\n' + idx : ''}${s.ddl ? '\n\n建表 DDL:\n' + s.ddl : ''}`
  }
  if (name === 'db_columns_grep') {
    const r = await relayPost('/db/grep', { keyword: a.keyword })
    const rows = r.rows || []
    if (!rows.length) return `(全库没有列名/注释含「${a.keyword}」)`
    return `含「${a.keyword}」的列(${rows.length} 个):\n` + rows.map((c) => `  ${c.table}.${c.col}  ${c.type}${c.comment ? '  — ' + c.comment : ''}`).join('\n')
  }
  if (name === 'db_sample') {
    const r = await relayPost('/db/sample', { table: a.table, limit: a.limit, where: a.where })
    return `${a.table} 采样:\n` + renderRows(r.rows || [], a.limit || 20)
  }
  if (name === 'db_query') {
    const r = await relayPost('/db/query', { sql: a.sql })
    return renderRows(r.rows || [], 50)
  }
  throw new Error('未知工具: ' + name)
}

// ── MCP stdio 协议 ──
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'bocomhermes-db', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: 'DB 工具出错: ' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现: ' + method } })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle err: ' + e.message)) } })
log('ready · userData=' + DATA)
