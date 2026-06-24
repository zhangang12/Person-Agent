'use strict'
// OceanBase(MySQL 模式)只读连接器 —— 在主进程跑(MCP 子进程没法解 safeStorage 密码)
//   · mysql2 纯 JS,连 OBProxy(默认 3306),user 形如 user@租户#集群
//   · 只读铁律:db_query 只放行单条 SELECT/SHOW/DESCRIBE,任何写关键词直接拒
//   · 给 agent 的工具是固定查询(tables/schema/grep/sample),agent 不写裸 SQL(防注入);
//     db_query 是给"需要 JOIN/WHERE/COUNT 做影响分析"时的受控逃生口,强校验 + 强制 LIMIT
//   · 连的是测试库 → 允许行采样;限行数 + 输出截断,避免把大表灌进 128K 上下文
let mysql = null
function loadMysql() {
  if (mysql) return mysql
  try { mysql = require('mysql2/promise') } catch (e) { throw new Error('mysql2 未安装(外网 npm i mysql2 后拷 node_modules 进内网)') }
  return mysql
}

const SAMPLE_MAX = 100        // 单次采样最多行
const QUERY_MAX = 500         // db_query 强制 LIMIT 上限
const CELL_MAX = 500          // 单格字符截断(防超长字段灌爆上下文)

// 连接池按连接四元组缓存,配置变了重建
let _pool = null, _poolKey = ''
async function getPool(cfg) {
  const m = loadMysql()
  const key = `${cfg.host}:${cfg.port}/${cfg.database}/${cfg.user}`
  if (_pool && _poolKey === key) return _pool
  if (_pool) { try { await _pool.end() } catch {} _pool = null }
  _pool = m.createPool({
    host: cfg.host, port: +cfg.port || 3306,
    user: cfg.user, password: cfg.password, database: cfg.database || undefined,
    waitForConnections: true, connectionLimit: 3, maxIdle: 1, idleTimeout: 60000,
    connectTimeout: 15000, charset: 'utf8mb4', multipleStatements: false,
    dateStrings: true,
  })
  _poolKey = key
  return _pool
}
async function closePool() { if (_pool) { try { await _pool.end() } catch {} _pool = null; _poolKey = '' } }

function curDb(cfg) { return cfg.database || '' }
function escId(name) { return '`' + String(name).replace(/`/g, '') + '`' }

// 截断单格,转可读字符串
function cell(v) {
  if (v == null) return 'NULL'
  if (Buffer.isBuffer(v)) return '0x' + v.slice(0, 16).toString('hex') + (v.length > 16 ? '…' : '')
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > CELL_MAX ? s.slice(0, CELL_MAX) + '…' : s
}

// ── 只读守卫(db_query 用)─────────────────────────────────────────────
function assertReadOnly(sql) {
  // 去注释
  let s = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/#[^\n]*/g, ' ').trim()
  if (!s) throw new Error('空 SQL')
  // 单语句(去掉结尾分号后不能再有分号接非空白)
  const noTrail = s.replace(/;\s*$/, '')
  if (/;\s*\S/.test(noTrail)) throw new Error('只允许单条语句(检测到多条)')
  if (!/^(select|show|describe|desc|explain|with)\b/i.test(s)) throw new Error('只允许 SELECT/SHOW/DESCRIBE/EXPLAIN 开头')
  if (/\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|set|lock|unlock|load|rename|merge|handler)\b/i.test(s)
      || /into\s+(out|dump)file/i.test(s)) {
    throw new Error('检测到写/危险关键词,拒绝')
  }
  return noTrail
}
// 给 SELECT 补 LIMIT(SHOW/DESCRIBE 不动)
function ensureLimit(sql, max) {
  if (/^(show|describe|desc|explain)\b/i.test(sql)) return sql
  if (/\blimit\s+\d+/i.test(sql)) return sql
  return sql + ' LIMIT ' + max
}

// ── 工具实现 ────────────────────────────────────────────────────────────
// 列出表(按 表名/表注释 关键词过滤)
async function tables(cfg, keyword) {
  const pool = await getPool(cfg)
  const db = curDb(cfg)
  if (!db) throw new Error('未指定库名(database)')
  const kw = keyword ? `%${keyword}%` : '%'
  const [rows] = await pool.query(
    `SELECT table_name AS name, table_comment AS comment, table_rows AS rows_est
       FROM information_schema.tables
      WHERE table_schema = ? AND (table_name LIKE ? OR table_comment LIKE ?)
      ORDER BY table_name LIMIT 200`, [db, kw, kw])
  return rows
}

// 表结构(字段/类型/可空/键/注释 + 索引 + 建表 DDL)
async function schema(cfg, table) {
  const pool = await getPool(cfg)
  const db = curDb(cfg)
  const [cols] = await pool.query(
    `SELECT column_name AS col, column_type AS type, is_nullable AS nullable,
            column_key AS \`key\`, column_default AS \`default\`, column_comment AS comment
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [db, table])
  if (!cols.length) throw new Error('表不存在或无字段: ' + table)
  const [idx] = await pool.query(
    `SELECT index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols, non_unique
       FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = ? GROUP BY index_name, non_unique`, [db, table])
  let ddl = ''
  try { const [r] = await pool.query(`SHOW CREATE TABLE ${escId(db)}.${escId(table)}`); ddl = r[0] && (r[0]['Create Table'] || r[0]['Create View']) || '' } catch {}
  const [tinfo] = await pool.query(
    `SELECT table_comment AS comment FROM information_schema.tables WHERE table_schema=? AND table_name=?`, [db, table])
  return { table, comment: (tinfo[0] || {}).comment || '', columns: cols, indexes: idx, ddl }
}

// 全库找含某关键词的列(列名 或 列注释)
async function columnsGrep(cfg, keyword) {
  const pool = await getPool(cfg)
  const db = curDb(cfg)
  if (!keyword) throw new Error('需要 keyword')
  const kw = `%${keyword}%`
  const [rows] = await pool.query(
    `SELECT table_name AS \`table\`, column_name AS col, column_type AS type, column_comment AS comment
       FROM information_schema.columns
      WHERE table_schema = ? AND (column_name LIKE ? OR column_comment LIKE ?)
      ORDER BY table_name, ordinal_position LIMIT 300`, [db, kw, kw])
  return rows
}

// 行采样(测试库)。可选简单等值过滤 where:{col:val}(参数化,防注入)
async function sample(cfg, table, limit, where) {
  const pool = await getPool(cfg)
  const db = curDb(cfg)
  // 验证表存在(也防 table 名注入)
  const [chk] = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=? AND table_name=? LIMIT 1`, [db, table])
  if (!chk.length) throw new Error('表不存在: ' + table)
  const lim = Math.max(1, Math.min(+limit || 20, SAMPLE_MAX))
  let sql = `SELECT * FROM ${escId(db)}.${escId(table)}`
  const params = []
  if (where && typeof where === 'object' && Object.keys(where).length) {
    const conds = []
    for (const [k, v] of Object.entries(where)) { conds.push(`${escId(k)} = ?`); params.push(v) }
    sql += ' WHERE ' + conds.join(' AND ')
  }
  sql += ' LIMIT ' + lim
  const [rows] = await pool.query(sql, params)
  return rows
}

// 受控只读 SQL(JOIN/WHERE/COUNT/GROUP 等影响分析用)
async function query(cfg, sql) {
  const pool = await getPool(cfg)
  const safe = ensureLimit(assertReadOnly(sql), QUERY_MAX)
  const [rows] = await pool.query(safe)
  return Array.isArray(rows) ? rows : [rows]
}

// 测连接:SELECT 1 + 库名 + 表数
async function ping(cfg) {
  const pool = await getPool(cfg)
  const [[one]] = await pool.query('SELECT 1 AS ok')
  const db = curDb(cfg)
  let tableCount = null
  if (db) { try { const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=?`, [db]); tableCount = c.n } catch {} }
  return { ok: one.ok === 1, database: db, tableCount }
}

module.exports = { tables, schema, columnsGrep, sample, query, ping, closePool, cell, SAMPLE_MAX, QUERY_MAX }
