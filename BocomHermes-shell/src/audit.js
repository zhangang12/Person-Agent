'use strict'
// 审计流水(治理横切,银行内网生命线):把「谁/何时/在哪个项目/动了什么」落成本机 append-only 流水。
// 全程数据不出网;敏感字段(密码/token/cookie)由调用方负责不传入 —— 本模块只做截断,不做脱敏猜测。
module.exports = function initAudit(S, { app, path, fs, ipcMain, log }) {
  const file = path.join(app.getPath('userData'), 'audit.jsonl')
  const MAX_LINES = 5000          // 超过就从头裁掉最老的(启动时做一次)
  const MAX_DETAIL = 2000         // 单条 detail 上限,防流水爆炸

  // 启动时按行数裁剪(append-only 文件不适合频繁改写,只在启动整理一次)
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n')
    }
  } catch (e) { log('audit trim err: ' + e.message) }

  // 记一条审计。kind=动作类型(mail/edit/rollback/permission/skill/…),summary=一句话,detail=结构化补充
  // 低侵入:任何埋点只需 audit(kind, summary, { ... })
  function audit(kind, summary, detail) {
    try {
      const entry = {
        ts: Date.now(),
        kind: String(kind || 'misc').slice(0, 40),
        project: (S.settings && S.settings.projectDir) ? path.basename(S.settings.projectDir) : '',
        summary: String(summary == null ? '' : summary).slice(0, 300),
        detail: detail == null ? undefined : (() => { try { return JSON.parse(JSON.stringify(detail).slice(0, MAX_DETAIL)) } catch { return String(detail).slice(0, MAX_DETAIL) } })(),
      }
      fs.appendFileSync(file, JSON.stringify(entry) + '\n')
    } catch (e) { log('audit write err: ' + e.message) }
  }

  // 读:倒序(最近在前),支持 kind 过滤 + 关键字(summary/detail 文本包含) + limit
  function read(opts) {
    const o = opts || {}
    let lines = []
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    const kw = (o.q || '').trim().toLowerCase()
    const out = []
    for (let i = lines.length - 1; i >= 0 && out.length < (o.limit || 500); i--) {
      let e; try { e = JSON.parse(lines[i]) } catch { continue }
      if (o.kind && e.kind !== o.kind) continue
      if (kw && !(JSON.stringify(e).toLowerCase().includes(kw))) continue
      out.push(e)
    }
    return out
  }

  ipcMain.handle('audit-list', (_e, opts) => read(opts || {}))

  S.audit = audit   // 挂到 S,供 window.js/session.js 各埋点处调用
  log('audit: 流水已就绪 (' + file + ')')
  return { audit, read }
}
