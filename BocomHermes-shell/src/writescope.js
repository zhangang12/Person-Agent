'use strict'
// 分片写归属(编码模式):从分片 goal 解析写归属清单 + 范围匹配(纯逻辑,可单测)。
// 格式约定(主控规程要求):goal 里一行「写归属: <相对路径1>, <相对路径2>, <目录/>」。
// 匹配语义:文件精确命中 / 目录前缀包含(都按 serveDir 解析);归属为空 = 不设闸(探查类分片照常)。
const path = require('path')

function parseWriteScope(goal) {
  const m = String(goal || '').match(/^写归属[:：]\s*(.+)$/m)
  if (!m) return []
  return m[1].split(/[,、;；]/).map((s) => s.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean)
}

// filePath 是否落在任一归属项内(归属为空 → 放行)。serveDir = 分片会话的工作目录(归属按它解析)。
function matchScope(scope, serveDir, filePath) {
  if (!Array.isArray(scope) || !scope.length) return true
  const base = path.resolve(String(serveDir || '.'))
  const abs = path.resolve(base, String(filePath || ''))
  return scope.some((s) => {
    const sp = path.resolve(base, s)
    if (abs === sp) return true
    const rel = path.relative(sp, abs)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
}

module.exports = { parseWriteScope, matchScope }
