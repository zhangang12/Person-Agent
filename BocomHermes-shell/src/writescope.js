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

// bash 命令里的【写文件目标】提取(纯逻辑):写归属闸对 write/edit 生效,但弱模型常绕到 bash 写文件
// (cat > f / tee / sed -i),不收这个口 = 归属闸形同虚设。覆盖三类:
//   ① 重定向  > f / >> f(2> / >& / &> 不算 —— 那是 stderr 与 fd 复制)
//   ② tee [-a] f
//   ③ sed -i … f(macOS 带备份后缀 '' 也认;取该段最后一个 token 当目标文件 —— 启发式,够用)
// 拿不到的不硬猜:含 $( ) ` ~ 的目标原样返回由调用方跳过(宁可放过,不可误杀)。
// 注意:权限事件 detail 被截到 200 字,长命令尾部的目标可能已被切掉 —— 本函数是【尽力防线】,不是完备解析器。
function bashWriteTargets(cmd) {
  const out = []
  const s = String(cmd || '')
  const push = (t) => { if (t && !out.includes(t)) out.push(t) }
  // ① 重定向:> 前不能是数字(2>)、&>(>& 复制 fd)、另一个 >(>> 由同式吃)
  const reRedir = /(?:^|[^0-9>&])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g
  let m
  while ((m = reRedir.exec(s))) push(m[1] || m[2] || m[3])
  // ② tee:第一个非选项参数
  const reTee = /\btee\s+((?:-[a-zA-Z]+\s+)*)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g
  while ((m = reTee.exec(s))) push(m[2] || m[3] || m[4])
  // ③ sed -i:命令段(到 ; & | 为止)最后一个 token 是目标文件
  const reSed = /\bsed\s+-[a-zA-Z]*i[a-zA-Z]*\s+([^;&|]+)/g
  while ((m = reSed.exec(s))) {
    const toks = String(m[1]).trim().split(/\s+/).filter(Boolean)
    const last = toks[toks.length - 1]
    if (last) push(last.replace(/^["']|["']$/g, ''))
  }
  return out.filter((t) => t && !t.startsWith('-') && !/^&/.test(t) && !/[$`~]/.test(t))
}

// 契约签名清单解析(纯逻辑):goal 里一行「契约: 签名1, 签名2, …」—— 该片必须产出的关键函数/类/端点。
// 主控从 CONTRACT.md 摘本片相关签名写进 goal(与写归属同行风格);壳层收官时拿它们去归属文件里逐个核对,
// 缺的就是【契约缺口】—— 防"看上去做完了实际差一截"的机械兜底(提示词叮嘱弱模型会忘,壳层不会)。
// 签名规整:去尾括号( foo() → foo )、去引号;空行 = 无契约(不设检)。
function parseContract(goal) {
  const m = String(goal || '').match(/^契约[:：]\s*(.+)$/m)
  if (!m) return []
  return m[1].split(/[,、;；]/).map((s) => s.trim().replace(/\(\s*\)$/, '').replace(/^["'`]|["'`]$/g, '')).filter(Boolean)
}

module.exports = { parseWriteScope, matchScope, bashWriteTargets, parseContract }
