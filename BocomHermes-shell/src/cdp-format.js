// 【CDP 控制台格式化 + Source map 还原】纯计算，从 window.js 原样搬来。
// 不依赖 S / tab / log / 任何 window.js 闭包 → 纯函数模块，require 即用。
// - 控制台：cdpConsoleLevel / fmtPreviewProp / fmtPreview / fmtRO / fmtException
// - Source map：vlqDecode / buildSourceMap / smLookup / smFetch / getSourceMap / resolveFrame
//   （smCache 模块私有；smFetch 用全局 fetch，Electron 主进程 Node 20+ 自带）
'use strict'

function cdpConsoleLevel(t) { return (t === 'error' || t === 'assert') ? 3 : t === 'warning' ? 2 : (t === 'debug' || t === 'trace') ? 0 : 1 }
function fmtPreviewProp(p) {
  if (p.type === 'string') return JSON.stringify(p.value)
  if (p.type === 'object') return p.subtype === 'array' ? (p.value || 'Array') : (p.value || '{…}')
  return p.value
}
function fmtPreview(pv) {
  if (!pv) return ''
  if (pv.subtype === 'array') return '[' + (pv.properties || []).map(fmtPreviewProp).join(', ') + (pv.overflow ? ', …' : '') + ']'
  const cls = pv.description && pv.description !== 'Object' ? pv.description + ' ' : ''
  return cls + '{' + (pv.properties || []).map((p) => p.name + ': ' + fmtPreviewProp(p)).join(', ') + (pv.overflow ? ', …' : '') + '}'
}
function fmtRO(ro) {
  if (!ro) return ''
  switch (ro.type) {
    case 'string': return ro.value
    case 'number': case 'boolean': return String(ro.value)
    case 'undefined': return 'undefined'
    case 'bigint': return (ro.description || ro.unserializableValue || '') + ''
    case 'symbol': return ro.description || 'Symbol()'
    case 'function': return ro.description ? String(ro.description).split('{')[0].trim() + ' {…}' : 'ƒ'
    case 'object':
      if (ro.subtype === 'null') return 'null'
      if (ro.preview) return fmtPreview(ro.preview)
      return ro.description || (ro.subtype === 'array' ? 'Array' : 'Object')
    default: return ro.description || String(ro.value == null ? '' : ro.value)
  }
}
function fmtException(d) {
  if (!d) return 'Uncaught'
  if (d.exception && d.exception.description) return d.exception.description     // 通常已含完整堆栈
  let s = d.text || 'Uncaught'
  if (d.exception && d.exception.value !== undefined) s += ' ' + JSON.stringify(d.exception.value)
  if (d.url) s += '  (' + d.url + ':' + ((d.lineNumber || 0) + 1) + ')'
  return s
}

// ── Source map：把打包文件的堆栈帧还原成源码 文件:行（零依赖 VLQ 解码）──────────
const SM_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlqDecode(str) {
  const out = []; let shift = 0, value = 0
  for (let i = 0; i < str.length; i++) {
    const d = SM_B64.indexOf(str[i]); if (d < 0) continue
    value += (d & 31) << shift
    if (d & 32) shift += 5
    else { out.push((value & 1) ? -(value >> 1) : (value >> 1)); value = 0; shift = 0 }
  }
  return out
}
function buildSourceMap(map) {
  const lines = []; let srcIdx = 0, srcLine = 0, srcCol = 0
  for (const rowStr of (map.mappings || '').split(';')) {
    let genCol = 0; const arr = []
    for (const seg of rowStr.split(',')) {
      if (!seg) continue
      const f = vlqDecode(seg); genCol += f[0] || 0
      if (f.length >= 4) { srcIdx += f[1]; srcLine += f[2]; srcCol += f[3]; arr.push({ genCol, srcIdx, srcLine, srcCol }) }
      else arr.push({ genCol })
    }
    lines.push(arr)
  }
  return { sources: map.sources || [], sourceRoot: map.sourceRoot || '', lines }
}
function smLookup(sm, genLine, genCol) {
  const row = sm.lines[genLine]; if (!row || !row.length) return null
  let best = null
  for (const s of row) { if (s.srcIdx === undefined) continue; if (s.genCol <= genCol) best = s; else if (best) break }
  if (!best) for (const s of row) if (s.srcIdx !== undefined) { best = s; break }
  if (!best) return null
  let src = sm.sources[best.srcIdx] || ''
  if (sm.sourceRoot && !/^https?:|^\//.test(src)) src = sm.sourceRoot.replace(/\/$/, '') + '/' + src
  return { source: src, line: best.srcLine + 1 }
}
const smCache = new Map()   // jsUrl -> sm | null
async function smFetch(url, headers) { try { const r = await fetch(url, headers ? { headers } : undefined); if (!r.ok && r.status !== 206) return null; return await r.text() } catch { return null } }
async function getSourceMap(jsUrl) {
  if (smCache.has(jsUrl)) return smCache.get(jsUrl)
  let sm = null
  try {
    const js = (await smFetch(jsUrl, { Range: 'bytes=-4096' })) || (await smFetch(jsUrl))   // 先取尾部 4KB 找注释，失败再整取
    if (js) {
      const all = [...js.matchAll(/sourceMappingURL=([^\s'"]+)/g)]
      const smu = all.length ? all[all.length - 1][1] : null
      let mapJson = null
      if (smu && smu.startsWith('data:')) {
        const body = smu.slice(smu.indexOf(',') + 1)
        mapJson = JSON.parse(smu.includes(';base64,') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body))
      } else {
        const mapUrl = smu ? new URL(smu, jsUrl).href : jsUrl + '.map'
        const t = await smFetch(mapUrl); if (t) mapJson = JSON.parse(t)
      }
      if (mapJson && mapJson.mappings) sm = buildSourceMap(mapJson)
    }
  } catch {}
  if (smCache.size > 60) smCache.clear()
  smCache.set(jsUrl, sm)
  return sm
}
async function resolveFrame(url, line, col) {   // line/col 为 CDP 的 0 基
  if (!url || !/^https?:/.test(url)) return null
  const sm = await getSourceMap(url); if (!sm) return null
  const o = smLookup(sm, line, col || 0); if (!o) return null
  const src = o.source.replace(/^webpack:\/\/\/?/, '').replace(/^(\.\/|\/@fs\/|\/@id\/)/, '')
  return src + ':' + o.line
}

module.exports = {
  cdpConsoleLevel, fmtPreviewProp, fmtPreview, fmtRO, fmtException,
  vlqDecode, buildSourceMap, smLookup, smFetch, getSourceMap, resolveFrame,
}
