'use strict'
// 邮件附件:落盘 + 文本化 + 按需读取 + 定期清理
//   · 文件全保存到 userData/mail-att/{safeMsgId}/{safeFilename}
//   · ≤ 3MB 的可识别格式(PDF/DOCX/XLSX/CSV/TXT/HTML/JSON/XML)同时抽出文本 → {filename}.txt
//   · 30 天前的目录启动时清理(以 meta.json.savedAt 优先,无则 mtime)
//   · 依赖(pdf-parse / mammoth / xlsx)走 lazy require,内网没装也不崩 —— agent 拿到 hasText=false 就知道读不到
const fs = require('fs')
const path = require('path')

const TEXT_EXTRACT_LIMIT = 3 * 1024 * 1024     // 3MB:超过只保存,不抽文本
const KEEP_DAYS = 30                            // 30 天前清理

// Windows/POSIX 通用:剥保留字符 + 控制字符 + 首尾点 + 限长
function safe(s, max) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+/, '_').replace(/\.+$/, '_')
    .slice(0, max || 200) || 'unnamed'
}

// 按 mime / 扩展名挑解析器
function pickExtractor(filename, mime) {
  const ext = path.extname(filename).toLowerCase()
  const m = String(mime || '').toLowerCase()
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf'
  if (ext === '.docx' || m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (['.xlsx', '.xls', '.xlsm'].includes(ext) || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || m === 'application/vnd.ms-excel') return 'xlsx'
  if (ext === '.csv' || ext === '.tsv' || m === 'text/csv' || m === 'text/tab-separated-values') return 'text'
  if (ext === '.txt' || ext === '.log' || ext === '.md' || m === 'text/plain' || m === 'text/markdown') return 'text'
  if (ext === '.json' || ext === '.xml' || m === 'application/json' || m === 'application/xml') return 'text'
  if (ext === '.html' || ext === '.htm' || m === 'text/html') return 'html'
  return null
}

function stripHtml(raw) {
  return String(raw || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// Lazy require:外网装好 → 内网就能用;没装就降级
async function extractText(filePath, kind) {
  try {
    if (kind === 'text') return fs.readFileSync(filePath, 'utf8')
    if (kind === 'html') return stripHtml(fs.readFileSync(filePath, 'utf8'))
    if (kind === 'pdf') {
      let pdfParse
      try { pdfParse = require('pdf-parse') } catch { return { err: 'pdf-parse 未安装' } }
      const buf = fs.readFileSync(filePath)
      const data = await pdfParse(buf)
      return data.text || ''
    }
    if (kind === 'docx') {
      let mammoth
      try { mammoth = require('mammoth') } catch { return { err: 'mammoth 未安装' } }
      const r = await mammoth.extractRawText({ path: filePath })
      return r.value || ''
    }
    if (kind === 'xlsx') {
      let xlsx
      try { xlsx = require('xlsx') } catch { return { err: 'xlsx 未安装' } }
      const wb = xlsx.readFile(filePath)
      const parts = []
      for (const sn of wb.SheetNames) {
        parts.push('# Sheet: ' + sn)
        parts.push(xlsx.utils.sheet_to_csv(wb.Sheets[sn]))
      }
      return parts.join('\n\n')
    }
  } catch (e) { return { err: e.message } }
  return null
}

// 主接口:对一批 emails 逐封写盘 + 抽文本,strip bytes
//   入参:emails(来自 email.fetchUnread,带 _rawAttachments)、userDataDir、log
//   副作用:每封 em 的 _rawAttachments 删除,attachments 字段重写为带 savedPath/textPath/hasText/extractError 的 meta
async function saveAttachments(emails, userDataDir, log) {
  const base = path.join(userDataDir, 'mail-att')
  try { fs.mkdirSync(base, { recursive: true }) } catch {}
  for (const em of emails) {
    if (!em || !em.messageId || !em._rawAttachments || !em._rawAttachments.length) {
      if (em && em._rawAttachments) delete em._rawAttachments
      continue
    }
    const dir = path.join(base, safe(em.messageId, 120))
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    const meta = []
    for (const att of em._rawAttachments) {
      const fname = safe(att.filename || 'unnamed.bin', 180)
      const fp = path.join(dir, fname)
      try { fs.writeFileSync(fp, att.bytes) }
      catch (e) { log && log('att write err ' + fname + ': ' + e.message); continue }
      let textPath = null, textLen = 0, extractError = null
      const kind = pickExtractor(fname, att.mime)
      if (!kind) {
        extractError = '无可识别的解析器(binary)'
      } else if (att.size > TEXT_EXTRACT_LIMIT) {
        extractError = '超过 ' + Math.round(TEXT_EXTRACT_LIMIT / 1024 / 1024) + 'MB,跳过文本提取(原文件仍保存)'
      } else {
        const r = await extractText(fp, kind)
        if (r && typeof r === 'object' && r.err) extractError = r.err
        else if (typeof r === 'string') {
          try {
            textPath = fp + '.txt'
            fs.writeFileSync(textPath, r, 'utf8')
            textLen = r.length
          } catch (e) { extractError = '写 .txt 失败: ' + e.message; textPath = null }
        }
      }
      meta.push({ filename: fname, mime: att.mime, size: att.size, savedPath: fp, textPath, textLen, extractError })
    }
    try {
      fs.writeFileSync(path.join(dir, 'meta.json'),
        JSON.stringify({ messageId: em.messageId, subject: em.subject || '', from: em.from || '', date: em.date || '', savedAt: Date.now(), attachments: meta }, null, 2))
    } catch (e) { log && log('meta.json err: ' + e.message) }
    em.attachments = meta.map((m) => ({
      filename: m.filename, mime: m.mime, size: m.size,
      hasText: !!m.textPath, textLen: m.textLen,
      extractError: m.extractError || undefined,
    }))
    delete em._rawAttachments
  }
  return emails
}

// 按 msgId + filename 读已落盘的 .txt(分段)。原始文件若是 text/* 也直接读。
function readAttachmentText(userDataDir, messageId, filename, offset, limit) {
  const dirName = safe(messageId, 120)
  const fname   = safe(filename,  180)
  const dir     = path.join(userDataDir, 'mail-att', dirName)
  const txtPath = path.join(dir, fname + '.txt')
  let text, source
  if (fs.existsSync(txtPath)) { text = fs.readFileSync(txtPath, 'utf8'); source = 'extracted' }
  else {
    const orig = path.join(dir, fname)
    if (!fs.existsSync(orig)) {
      const e = new Error('附件未找到:msgId=' + messageId + ' filename=' + filename)
      e.code = 'ENOENT'; throw e
    }
    // 仅文本扩展允许走 raw,否则 binary 当 utf8 读就是给 agent 喂垃圾(浪费 128K)
    const ext = path.extname(fname).toLowerCase()
    const TEXT_EXT = new Set(['.txt','.csv','.tsv','.md','.json','.xml','.log','.html','.htm','.yaml','.yml','.ini','.conf'])
    if (!TEXT_EXT.has(ext)) {
      const e = new Error('附件未文本化(可能是二进制或解析依赖缺失,扩展名 ' + ext + '),原路径: ' + orig)
      e.code = 'BINARY'; throw e
    }
    text = fs.readFileSync(orig, 'utf8'); source = 'raw'
  }
  const off = Math.max(0, +offset || 0)
  const lim = Math.max(1, Math.min(+limit || 8000, 50000))
  return {
    content: text.slice(off, off + lim),
    totalLen: text.length,
    hasMore: off + lim < text.length,
    nextOffset: off + lim < text.length ? off + lim : null,
    source,
  }
}

// 启动时清理:meta.json.savedAt 优先,无 meta 走 mtime
function cleanupOld(userDataDir, log) {
  const base = path.join(userDataDir, 'mail-att')
  if (!fs.existsSync(base)) return 0
  const cutoff = Date.now() - KEEP_DAYS * 86400000
  let removed = 0
  for (const name of fs.readdirSync(base)) {
    const p = path.join(base, name)
    try {
      const st = fs.statSync(p); if (!st.isDirectory()) continue
      let savedAt = st.mtimeMs
      try { const meta = JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8')); if (meta.savedAt) savedAt = meta.savedAt } catch {}
      if (savedAt < cutoff) { fs.rmSync(p, { recursive: true, force: true }); removed++ }
    } catch {}
  }
  if (removed && log) log('mail-att cleanup: removed ' + removed + ' dirs older than ' + KEEP_DAYS + 'd')
  return removed
}

module.exports = { saveAttachments, readAttachmentText, cleanupOld, TEXT_EXTRACT_LIMIT, KEEP_DAYS }
