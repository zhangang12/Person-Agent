'use strict'
// 项目级知识库(任务尾蒸馏的落点)—— 纯逻辑,依赖全部注入,可单测。
// 背景:个人记忆 memory.md 是【全局】的(所有项目共用),蒸馏出的"系统级事实"(如"计息规则在 X 文件")
// 是项目级知识,写全局会污染其它项目 → 每项目一个文件:userData/knowledge/<basename>_<md5前8>.md。
// 条目制追加(带日期/置信度/锚点/场景),注入按项目匹配、新→旧裁剪 —— 索引制两级加载是后续演进(设计备忘 §7)。
const path = require('path')
const crypto = require('crypto')

// 同一目录 → 同一 slug(跨会话稳定);不同项目不撞(同名目录靠 hash 区分)
function slugFor(dir) {
  const d = String(dir || '').replace(/[\\/]+$/, '')
  const base = (d.split(/[\\/]/).pop() || 'project').replace(/[\\/:*?"<>|\s]+/g, '_')
  const h = crypto.createHash('md5').update(d).digest('hex').slice(0, 8)
  return base + '_' + h
}
function fileFor(dir, userDataDir) {
  return path.join(userDataDir, 'knowledge', slugFor(dir) + '.md')
}

// 条目归一成一行:- [verified] 一句话 (锚点: a.js:88, b.sql:12) (场景: 计息/跑批)
// anchors/scene 可空;confidence 只认 verified|suspected(默认 verified)。
function fmtEntry(e) {
  const text = String((e && e.text) || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const conf = /suspect/i.test(String((e && e.confidence) || '')) ? 'suspected' : 'verified'
  const anchors = Array.isArray(e && e.anchors) ? e.anchors.map((a) => String(a).trim()).filter(Boolean).slice(0, 6) : []
  const scene = String((e && e.scene) || '').replace(/\s+/g, ' ').trim()
  let line = '- [' + conf + '] ' + text
  if (anchors.length) line += ' (锚点: ' + anchors.join(', ') + ')'
  if (scene) line += ' (场景: ' + scene + ')'
  return line
}
// 去重的键:一句话正文(忽略首尾空白与大小写)。完全匹配才去重 —— 近似合并是模型活,壳层不做。
function entryKey(line) {
  const m = String(line).match(/^- \[[^\]]+\]\s*(.*?)\s*(?:\((?:锚点|场景):|$)/)
  return (m ? m[1] : String(line)).trim().toLowerCase()
}

// 追加:existing=文件现有内容('' 表示没有),entries=[{text,anchors,scene,confidence}...]
// 返回 { content, added, dupes } —— added=真加进去的条数,dupes=撞重跳过的条数。
function appendEntries(existing, entries, dateStr) {
  const lines = String(existing || '').split('\n')
  const seen = new Set(lines.filter((l) => l.startsWith('- [')).map(entryKey))
  const fresh = []
  let dupes = 0
  for (const e of entries || []) {
    const line = fmtEntry(e)
    if (!line) continue
    const k = entryKey(line)
    if (seen.has(k)) { dupes++; continue }
    seen.add(k); fresh.push(line)
  }
  let content = String(existing || '').trimEnd()
  if (fresh.length) {
    const stamp = '## ' + (dateStr || new Date().toISOString().slice(0, 10))
    // 今天的节已在且是最后一节 → 续在节尾;否则开新日期节(判"最后一节"==今天,不能 endsWith:文件尾部是条目不是节头)
    const heads = content.split('\n').filter((l) => l.startsWith('## '))
    const hasToday = !!(heads.length && heads[heads.length - 1] === stamp)
    if (content && !hasToday) content += '\n\n' + stamp + '\n' + fresh.join('\n')
    else if (content) content += '\n' + fresh.join('\n')
    else content = '# 项目知识库(任务尾蒸馏:系统级事实,每条带锚点与场景)\n\n' + stamp + '\n' + fresh.join('\n')
  }
  return { content: content + (content ? '\n' : ''), added: fresh.length, dupes }
}

// 注入文本:新→旧裁剪到 maxEntries 条 / maxChars 字。超出在头部明示被略去的条数(别让模型以为看到的是全部)。
function injectText(existing, dir, opts) {
  const o = opts || {}
  const maxEntries = o.maxEntries || 60, maxChars = o.maxChars || 6000
  const entries = String(existing || '').split('\n').filter((l) => l.startsWith('- ['))
  if (!entries.length) return ''
  const keep = []
  let chars = 0
  for (let i = entries.length - 1; i >= 0 && keep.length < maxEntries; i--) {
    if (chars + entries[i].length > maxChars) continue   // 超长条目跳过,继续试更老的短条目
    keep.unshift(entries[i]); chars += entries[i].length
  }
  const dropped = entries.length - keep.length
  const name = path.basename(String(dir || '').replace(/[\\/]+$/, '')) || '本项目'
  return '<项目知识(' + name + ')>\n'
    + (dropped ? '(共 ' + entries.length + '条,按新→旧注入 ' + keep.length + ' 条,略去 ' + dropped + ' 条)\n' : '')
    + keep.join('\n') + '\n</项目知识>\n\n'
}

module.exports = { slugFor, fileFor, fmtEntry, entryKey, appendEntries, injectText }
