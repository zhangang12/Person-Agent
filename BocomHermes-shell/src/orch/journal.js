'use strict'
// ══════════════════════════════════════════════════════════════════════════════
// 编排存档(run.json)· 唯一的编排持久层
//
// 【为什么必须落盘】旧引擎的编排事实全在内存(S.wfRegistry / S.orchByTag / 6 个 tag 键 Map),
// 重启即空 —— 于是"续接恢复"只能写进提示词让模型自己按磁盘产出重新对账(主控规程第 9 条,80 字纯记账),
// 而模型对不准就重复劳动。这里把 run 整个落盘,重启后由代码恢复,模型只回答"接下来干嘛"。
//
// 【写入策略】300ms 防抖 + 终态/关键转移强写。
//   编排一轮里 persist 会被打很多次(每个 effect 批都带一条),每次都同步写盘会把主进程拖住;
//   但"崩溃前最后一次状态没落盘"又会让续接看到旧图。折中:防抖攒批,终态(done/failed/cancelled)
//   与显式 flush 立即写。
//
// 【原子写】先写 <file>.tmp 再 rename —— 半截 JSON 比没有更糟:续接时 JSON.parse 抛错,
// 那条 run 直接读不出来,用户看到的是"编排凭空消失"。rename 在同分区上是原子的。
//
// 本模块是 orch 里【唯一】允许碰 fs 的文件,所以它不在 orch-boundary-check 的纯度约束内 ——
// 它不是状态机,是状态机的存储适配器;run.js 只发 {type:'persist'},由 index.js 转调这里。
// ══════════════════════════════════════════════════════════════════════════════
const fs = require('fs')
const path = require('path')

const DEBOUNCE_MS = 300
const KEEP_DAYS = 30          // 终态 run 保留天数
const KEEP_MAX = 200          // 存档条数上限(超了删最老的终态)
const TERMINAL = ['done', 'failed', 'cancelled']

function isTerminal(run) { return run && TERMINAL.indexOf(String(run.phase)) >= 0 }
function safeName(id) { return String(id || 'run').replace(/[^\w.-]/g, '_').slice(0, 80) }

/**
 * makeJournal({ dir, log }) → { save, flush, flushAll, load, list, remove, gc, dispose }
 *   dir: 存档目录(index.js 传 path.join(app.getPath('userData'), 'orch-runs'))
 */
function makeJournal(opts) {
  const o = opts || {}
  const dir = String(o.dir || '')
  const log = typeof o.log === 'function' ? o.log : () => {}
  const timers = new Map()     // runId → timeout
  const dirty = new Map()      // runId → run(最后一次快照;防抖期间只留最新)

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); return true }
    catch (e) { log('orch-journal mkdir 失败: ' + (e && e.message)); return false }
  }
  function fileOf(id) { return path.join(dir, safeName(id) + '.json') }

  function writeNow(run) {
    if (!run || !run.id || !dir) return false
    if (!ensureDir()) return false
    const fp = fileOf(run.id)
    const tmp = fp + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(run), 'utf8')
      fs.renameSync(tmp, fp)   // 原子替换:半截 JSON 会让这条 run 在续接时整个读不出来
      return true
    } catch (e) {
      log('orch-journal 写入失败(' + run.id + '): ' + (e && e.message))
      try { fs.unlinkSync(tmp) } catch { /* 清不掉就算了,下次覆盖 */ }
      return false
    }
  }

  function clearTimer(id) {
    const t = timers.get(id)
    if (t) { clearTimeout(t); timers.delete(id) }
  }

  return {
    /** 状态变了就调:终态立刻写,其余 300ms 防抖攒批 */
    save(run) {
      if (!run || !run.id) return
      dirty.set(run.id, run)
      if (isTerminal(run)) { clearTimer(run.id); dirty.delete(run.id); writeNow(run); return }
      if (timers.has(run.id)) return
      timers.set(run.id, setTimeout(() => {
        timers.delete(run.id)
        const r = dirty.get(run.id); dirty.delete(run.id)
        if (r) writeNow(r)
      }, DEBOUNCE_MS))
    },
    /** 立刻把某条(或全部)攒着的写下去 —— 退出前 / 关键节点用 */
    flush(id) {
      if (id == null) return this.flushAll()
      clearTimer(id)
      const r = dirty.get(id); dirty.delete(id)
      return r ? writeNow(r) : false
    },
    flushAll() {
      let n = 0
      for (const id of [...dirty.keys()]) { if (this.flush(id)) n++ }
      return n
    },
    load(id) {
      try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) }
      catch { return null }
    },
    /** 启动扫描:返回全部存档(按 updatedAt 新→旧);坏文件跳过不炸 */
    list() {
      const out = []
      let names = []
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return out }
      for (const f of names) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
          if (r && r.id) out.push(r)
        } catch (e) { log('orch-journal 存档损坏,跳过: ' + f) }
      }
      out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return out
    },
    remove(id) {
      clearTimer(id); dirty.delete(id)
      try { fs.unlinkSync(fileOf(id)); return true } catch { return false }
    },
    /** GC:终态且超 KEEP_DAYS 的删;总数超 KEEP_MAX 时按 updatedAt 删最老的终态(在跑的一律不动) */
    gc(now) {
      const t = Number(now) || 0
      const all = this.list()
      let removed = 0
      for (const r of all) {
        if (!isTerminal(r)) continue
        if (t && r.updatedAt && (t - r.updatedAt) > KEEP_DAYS * 86400e3) { if (this.remove(r.id)) removed++ }
      }
      if (all.length - removed > KEEP_MAX) {
        const rest = this.list().filter(isTerminal).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
        let over = this.list().length - KEEP_MAX
        for (const r of rest) { if (over-- <= 0) break; if (this.remove(r.id)) removed++ }
      }
      if (removed) log('orch-journal GC:清掉 ' + removed + ' 条终态存档')
      return removed
    },
    dispose() {
      this.flushAll()
      for (const id of [...timers.keys()]) clearTimer(id)
    },
  }
}

module.exports = { makeJournal, isTerminal, DEBOUNCE_MS, KEEP_DAYS, KEEP_MAX }
