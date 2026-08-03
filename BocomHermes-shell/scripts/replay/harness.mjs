// 【L1 golden transcript 录制回放 · 测试骨架】零依赖（只用 Node 内置模块）。
//
// 测什么：把壳层编排逻辑（多层派发/分片收官/交棒兜底）从"人工实跑"变成"确定性回归"——
//   真 opencode.js（HTTP+SSE 连接层）+ 真 src/session.js（卡片↔会话 IPC）+ 真 src/window.js
//   （spawnWorkflow/wfTurnDone/wfDequeue/并发闸），真 src/orch/*（编排状态机）,
//   只桩 Electron 边界（BrowserWindow/webContents/app/Notification/dialog/shell/screen）与 serve 进程
//   （oc.__test.setSpawnHook 注入假进程，流量打到本文件实现的 fake serve 上）。
//   业务逻辑零修改、零替身：分片收官 45s 兜底、主控唤醒(N/M 注入)、并发排队出队、tag 二次扫描全走真代码。
//
// 怎么跑：npm run replay:test（= node scripts/replay/run.mjs，跑 scripts/replay/cases/*.case.mjs）。
//
// 关键机制：
//   · fake serve：127.0.0.1 随机端口 http server，脚本化响应表（respond 规则）+ 有状态会话存储
//     （POST /session 建会话、POST /session/:id/message 收发、GET .../message 历史、/event SSE 推流）。
//     ensureServe 经 setSpawnHook "自起"它：hook 收到 (dir, port) 就 listen 该端口，waitHealthy 探活通过。
//   · transcript：JSONL，每行 {t:相对毫秒, op:'sse'|'respond', ...}——sse 行进播放器（manual=测试代码
//     显式逐条推，确定性；auto=按 t×timeScale 自动推），respond 行进响应规则表。会话 id 用逻辑别名
//     "$s1/$s2..."（按建会话顺序绑定真实 ses_xxx），推流/响应时统一替换，transcript  thus 与会话 id 解耦。
//   · 定时器分层：≥10s 的 setTimeout/setInterval（45s 落定、5min 索引催办、60s 停滞巡检、90s 看门狗、
//     120s 保活）全部捕获进手动注册表，world.fireTimer 显式触发——确定性不等墙钟；<10s 的（轮询/sleep/
//     心跳）走真实定时器，保证真实异步链路（SSE 流、POST 往返）正常运转。
//   · Electron 桩：Module._load 劫持 require('electron')；app.getPath 全名字重定向到临时目录
//     （MCP/LSP 自动注册、存档、转录全落临时目录，绝不碰真实用户目录）；BrowserWindow 假类记录
//     loadFile/close 语义（close 可 preventDefault——分片弹窗 X 转隐藏路径同构）；webContents.fromId
//     按 id 注册表反查（window.js wcById 给主控卡投 card-inject 全靠它）。
//
// 怎么补新用例：
//   ① 录制：真实 serve 跑着，node scripts/replay/record.mjs --send "你的目标" --out scripts/replay/cases/xx.jsonl
//      ——把 /event 流与 API 往返录成 JSONL（自动把 ses_xxx 别名化成 $sN，path 参数化成正则）；
//   ② 裁剪：编辑 JSONL，删掉与断言无关的事件/响应（或补 respond 规则做错误注入）；
//   ③ 写用例：cases/xx.case.mjs，export default { name, transcript, mode, settings, async run(world) }，
//      world 提供 spawnWorkflow/cardInit/cardSend/relayPost/fireTimer/injects/S.orch 等，
//      断言用 ok/expectSeq(子序列+参数子集匹配)/expectState/expectFile。跑 npm run replay:test 验收。
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { EventEmitter } from 'events'

const require = createRequire(import.meta.url)

// ── 断言工具（ok 风格与仓内各自测一致：✓/✗ + 计数，run.mjs 汇总退出码）──────────────
let _pass = 0, _fail = 0
function ok(name, cond, extra) {
  if (cond) { _pass++; console.log('  ✓ ' + name) }
  else { _fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra, null, 0).slice(0, 800) : '')) }
  return !!cond
}
function resetAsserts() { _pass = 0; _fail = 0 }
function assertCounts() { return { pass: _pass, fail: _fail } }

// 参数子集匹配：expected 的每个键在 actual 里递归匹配——值支持：正则(test String)、函数(谓词)、
// {includes:'子串'}、数组(逐元素子集)、对象(递归)、原始值(===)。
function matchSubset(exp, act) {
  if (exp instanceof RegExp) return exp.test(typeof act === 'string' ? act : JSON.stringify(act))
  if (typeof exp === 'function') { try { return !!exp(act) } catch { return false } }
  if (exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).length === 1 && typeof exp.includes === 'string')
    return String(act == null ? '' : act).includes(exp.includes)
  if (Array.isArray(exp)) {
    if (!Array.isArray(act) || act.length < exp.length) return false
    return exp.every((e, i) => matchSubset(e, act[i]))
  }
  if (exp && typeof exp === 'object') {
    if (!act || typeof act !== 'object') return false
    return Object.keys(exp).every((k) => matchSubset(exp[k], act[k]))
  }
  return exp === act
}
// expectSeq：expected 是 actual 的【子序列】(游标单调推进,中间杂讯自动跳过)——请求流水/事件流断言用。
function expectSeq(name, actual, expected) {
  const list = Array.isArray(actual) ? actual : []
  let cur = 0
  for (let i = 0; i < expected.length; i++) {
    let hit = -1
    for (let j = cur; j < list.length; j++) { if (matchSubset(expected[i], list[j])) { hit = j; break } }
    if (hit < 0) {
      return ok(name + '（第 ' + (i + 1) + '/' + expected.length + ' 项未匹配）', false, {
        未匹配: expected[i], 已匹配到: cur, actual摘要: list.slice(Math.max(0, cur - 1), cur + 6).map((x) => JSON.stringify(x).slice(0, 160)),
      })
    }
    cur = hit + 1
  }
  return ok(name, true)
}
// expectSet：无序集合匹配——expected 每项都能在 actual 中找到独立匹配项。
function expectSet(name, actual, expected) {
  const list = Array.isArray(actual) ? actual : []
  const used = new Set()
  for (const e of expected) {
    let hit = -1
    for (let j = 0; j < list.length; j++) { if (!used.has(j) && matchSubset(e, list[j])) { hit = j; break } }
    if (hit < 0) return ok(name + '（缺一项）', false, { 缺: e, actual摘要: list.map((x) => JSON.stringify(x).slice(0, 120)) })
    used.add(hit)
  }
  return ok(name, true)
}
// expectState：状态断言。fn 返回 truthy 或抛错；失败时把 fn 的返回值打印出来。
function expectState(name, fn) {
  let v, err = null
  try { v = fn() } catch (e) { err = e }
  return ok(name, !err && !!v, err ? String(err && err.message || err) : v)
}
// expectFile：文件存在且内容包含全部子串。
function expectFile(name, fp, includes) {
  let txt = null
  try { txt = fs.readFileSync(fp, 'utf8') } catch {}
  const miss = (Array.isArray(includes) ? includes : [includes]).filter((s) => txt == null || !txt.includes(s))
  return ok(name, txt != null && miss.length === 0, txt == null ? '(文件不存在) ' + fp : { 缺子串: miss })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// waitFor：轮询断言前置条件（SSE 推流落地等），超时抛错由 run.mjs 记 fail。
async function waitFor(fn, { timeout = 4000, interval = 20, name = 'waitFor 超时' } = {}) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = fn() } catch {}
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(name)
    await sleep(interval)
  }
}

// ── 定时器分层：≥LONG_MS 的进手动注册表(fireTimer 显式触发),短定时器走真实 ─────────────
const LONG_MS = 10000
const _realST = global.setTimeout, _realCT = global.clearTimeout
const _realSI = global.setInterval, _realCI = global.clearInterval
const _longTimers = []   // { id, fn, ms, type:'timeout'|'interval', dead }
let _ltSeq = 0
let _timersInstalled = false
function installTimersOnce() {
  if (_timersInstalled) return
  _timersInstalled = true
  const fakeTimer = (id) => ({ __longId: id, unref() { return this }, ref() { return this } })
  global.setTimeout = (fn, ms, ...a) => {
    if ((+ms || 0) >= LONG_MS) { const id = ++_ltSeq; _longTimers.push({ id, fn: () => fn(...a), ms: +ms, type: 'timeout', dead: false }); return fakeTimer(id) }
    return _realST(fn, ms, ...a)
  }
  global.clearTimeout = (t) => {
    if (t && t.__longId) { const e = _longTimers.find((x) => x.id === t.__longId); if (e) e.dead = true; return }
    return _realCT(t)
  }
  global.setInterval = (fn, ms, ...a) => {
    if ((+ms || 0) >= LONG_MS) { const id = ++_ltSeq; _longTimers.push({ id, fn: () => fn(...a), ms: +ms, type: 'interval', dead: false }); return fakeTimer(id) }
    return _realSI(fn, ms, ...a)
  }
  global.clearInterval = (t) => {
    if (t && t.__longId) { const e = _longTimers.find((x) => x.id === t.__longId); if (e) e.dead = true; return }
    return _realCI(t)
  }
}
// 触发捕获的长定时器：pred 为数字(按 ms 精确匹配)或谓词函数。timeout 型触发即摘,interval 型触发后保留。
function fireTimer(pred) {
  const m = typeof pred === 'number' ? (e) => e.ms === pred : pred
  const hits = _longTimers.filter((e) => !e.dead && m(e))
  for (const e of hits) { if (e.type === 'timeout') e.dead = true; try { e.fn() } catch (err) { console.log('  ⚠ fireTimer 回调异常: ' + (err && err.message)) } }
  return hits.length
}
function pendingTimers() { return _longTimers.filter((e) => !e.dead).map((e) => ({ ms: e.ms, type: e.type })) }
function resetTimers() { _longTimers.length = 0 }

// ── Electron 桩：Module._load 劫持 require('electron')；内部状态经 ACTIVE 按 world 切换 ──
// window.js 模块作用域 `const { clipboard, session, Notification, desktopCapturer, webContents } = require('electron')`
// 在首次 require 时绑定本桩对象——所有方法委托 ACTIVE(per-world),跨用例互不污染。
const ACTIVE = { wcs: new Map(), root: '' }
let _wcSeq = 0

class FakeWebContents {
  constructor() { this.id = ++_wcSeq; this.sent = []; this._destroyed = false; this._handlers = {}; ACTIVE.wcs.set(this.id, this) }
  send(ch, p) { this.sent.push({ ch, p, at: Date.now() }) }
  isDestroyed() { return this._destroyed }
  isLoading() { return false }
  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this }
  once(ev, fn) { return this.on(ev, fn) }
  removeAllListeners() { this._handlers = {}; return this }
  executeJavaScript() { return Promise.resolve(undefined) }
  openDevTools() {} closeDevTools() {} isDevToolsOpened() { return false }
  setWindowOpenHandler() {} setAudioMuted() {}
  getURL() { return '' } getTitle() { return '' }
  destroy() { this._destroyed = true; ACTIVE.wcs.delete(this.id) }
}
class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts || {}
    this.webContents = new FakeWebContents()
    this._destroyed = false; this._visible = !!this.opts.show; this._handlers = {}
    this.loadedFile = ''; this.loadedQuery = null
    FakeBrowserWindow._all.push(this)
  }
  loadFile(f, q) { this.loadedFile = f; this.loadedQuery = (q && q.query) || null }
  loadURL(u) { this.loadedFile = String(u) }
  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this }
  once(ev, fn) { return this.on(ev, fn) }
  // 与真 Electron 同语义:先 'close'(可 preventDefault,分片弹窗 X 转隐藏走这里),未拦才销毁并发 'closed'
  close() {
    if (this._destroyed) return
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    for (const fn of (this._handlers['close'] || [])) { try { fn(ev) } catch {} }
    if (ev.defaultPrevented) return
    this._destroyed = true
    try { this.webContents.destroy() } catch {}
    for (const fn of (this._handlers['closed'] || [])) { try { fn() } catch {} }
  }
  destroy() { this._destroyed = true; try { this.webContents.destroy() } catch {} }
  isDestroyed() { return this._destroyed }
  isMinimized() { return false } isFocused() { return false } isVisible() { return this._visible }
  show() { this._visible = true } hide() { this._visible = false } focus() {} restore() {} showInactive() { this._visible = true }
  moveTop() {} center() {} setAlwaysOnTop() {} flashFrame() {} setSkipTaskbar() {} setMenu() {}
  setBounds() {} getBounds() { return { x: 0, y: 0, width: 680, height: 860 } }
  setBackgroundColor() {} setOpacity() {} setShape() {} setIgnoreMouseEvents() {}
  static _all = []
  static getAllWindows() { return FakeBrowserWindow._all.filter((w) => !w._destroyed) }
  static fromWebContents(wc) { return FakeBrowserWindow._all.find((w) => w.webContents === wc) || null }
  static getFocusedWindow() { return null }
}
class FakeWebContentsView {
  constructor() { this.webContents = new FakeWebContents() }
  setBounds() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 } } setBackgroundColor() {} setVisible() {}
}
class FakeNotification {
  constructor(o) { this.o = o || {} }
  show() {} close() {} on() { return this } once() { return this }
  static isSupported() { return true }
}
// app.getPath 全名字重定向:任何名字的目录都落在本 world 的临时根下,自动注册类副作用(MCP/LSP/插件)不出临时目录
function stubGetPath(name) { return path.join(ACTIVE.root, 'electron-' + String(name || 'x').replace(/[^\w-]/g, '_')) }
const electronStub = {
  app: {
    getPath: (name) => stubGetPath(name),
    isQuitting: false, on() {}, once() {}, whenReady: () => Promise.resolve(),
    setAppUserModelId() {}, getVersion: () => '0.0.0-replay', getName: () => 'BocomHermes-replay',
    quit() {}, relaunch() {}, requestSingleInstanceLock: () => true,
  },
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  Notification: FakeNotification,
  ipcMain: { handle(n, fn) { electronStub.ipcMain._handlers[n] = fn }, on(n, fn) { electronStub.ipcMain._handlers[n] = fn }, removeHandler(n) { delete electronStub.ipcMain._handlers[n] }, removeAllListeners() {}, _handlers: {} },
  webContents: { fromId: (id) => ACTIVE.wcs.get(id) || null, getAllWebContents: () => [...ACTIVE.wcs.values()] },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, workAreaSize: { width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ x: 100, y: 100 }), getAllDisplays: () => [],
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }) },
  Tray: class { setToolTip() {} setContextMenu() {} setImage() {} on() {} destroy() {} },
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({ popup() {} }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize() { return this } }), createEmpty: () => ({ isEmpty: () => true }) },
  shell: { openPath: async () => '', openExternal: async () => {}, trashItem: async () => {}, showItemInFolder() {} },
  clipboard: { readText: () => '', writeText() {}, readImage: () => ({ isEmpty: () => true }), writeImage() {}, clear() {} },
  session: {
    defaultSession: { setProxy: async () => {}, on() {}, webRequest: { onBeforeSendHeaders() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {}, setUserAgent() {}, clearCache: async () => {} },
    fromPartition() { return electronStub.session.defaultSession },
  },
  desktopCapturer: { getSources: async () => [] },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + String(s)), decryptString: (b) => String(b).replace(/^enc:/, '') },
  globalShortcut: { register: () => true, unregister() {}, unregisterAll() {}, isRegistered: () => false },
  net: { request: () => { throw new Error('replay 桩:net.request 未实现') } },
}
let _electronInstalled = false
function installElectronStubOnce() {
  if (_electronInstalled) return
  _electronInstalled = true
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'electron') return electronStub
    return origLoad.apply(this, arguments)
  }
}

// ── transcript：JSONL 读写 + 会话别名替换 ─────────────────────────────────────────────
// 行格式:{t:相对毫秒, op:'sse', event:{...}} | {t, op:'respond', method, path(正则源), ...}
// '#' 开头与空行跳过(注释)。$sN = 第 N 个建出来的会话(1 起,按 POST /session 顺序绑定真实 ses_xxx)。
function parseTranscript(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    try { out.push(JSON.parse(l)) } catch (e) { throw new Error('transcript 坏行: ' + l.slice(0, 120) + ' — ' + e.message) }
  }
  return out
}
function serializeTranscript(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

// ── fake serve：脚本化响应表 + 有状态会话存储 + SSE 播放器 ─────────────────────────────
// 端点(opencode.js 真实打到的):/global/health、/heartbeat、POST /session(?directory=)、GET /session、
//   GET /session/:id、POST /session/:id/message、GET /session/:id/message、GET /session/:id/children、
//   GET /session/:id/todo、POST /session/:id/abort、POST /permission/:id/reply(detectPerm 探针)、
//   /event(SSE)、GET /config|/config/providers、PATCH /config。未匹配的兜底 200 'true'。
// respond 规则字段:{ method, path(正则源), queryIncludes?, bodyIncludes?, once?, status?, json?, text?,
//   appendUser?(默认 true), appendAssistant?(字符串,往会话落一条 assistant 完成消息), todo?(覆盖该会话 todo),
//   sseAfter?(响应后推一条 sse 事件) }——未给 json/text 时走默认响应体。
function createFakeServe({ transcript = [], mode = 'manual', timeScale = 1, log = () => {} } = {}) {
  const state = {
    sessions: new Map(),   // sid -> { id, title, messages: [], todo: [] }
    aliases: new Map(),    // '$s1' -> sid
    requests: [],          // 请求流水 { method, path, query, body(截200), at } —— expectSeq 的 actual
    seq: 0,
  }
  const rules = transcript.filter((l) => l && l.op === 'respond')
  const sseLines = transcript.filter((l) => l && l.op === 'sse').sort((a, b) => (+a.t || 0) - (+b.t || 0))
  let sseIdx = 0
  const sseClients = new Set()
  const pendingEv = []   // /event 尚未连接时到达的事件,连接建立即 flush
  const sockets = new Set()
  let server = null, port = 0, base = ''
  const t0 = Date.now()

  // 逻辑别名 $sN ↔ 真实 sid 双向替换(record.mjs 反向用 aliasify)
  const subst = (v) => String(v == null ? '' : v).replace(/\$s(\d+)\b/g, (m) => state.aliases.get(m) || m)
  function noteSession(sid, title) {
    const alias = '$s' + (state.aliases.size + 1)
    state.aliases.set(alias, sid)
    state.sessions.set(sid, { id: sid, title: title || '对话', messages: [], todo: [] })
  }
  function broadcast(ev) {
    const data = subst(JSON.stringify(ev))
    if (!sseClients.size) { pendingEv.push(data); return }
    for (const res of sseClients) { try { res.write('data: ' + data + '\n\n') } catch {} }
  }
  // SSE 播放器:manual=测试代码 pushNextSse/pushAllSse 显式推(确定性);auto=/event 连上后按 t×timeScale 自动推
  function pushNextSse() { if (sseIdx < sseLines.length) { broadcast(sseLines[sseIdx++].event); return true } return false }
  function pushAllSse() { let n = 0; while (pushNextSse()) n++; return n }
  function autoPlay(res) {
    let at = 0
    for (const l of sseLines.slice(sseIdx)) {
      at = Math.max(at, (+l.t || 0) * timeScale)
      setTimeout(() => broadcast(l.event), at)   // 短定时器(压缩后),走真实时钟
    }
    sseIdx = sseLines.length
  }

  function matchRule(method, p, query, rawBody) {
    for (const r of rules) {
      if (r.once && r.__used) continue
      if (r.method && String(r.method).toUpperCase() !== method) continue
      if (r.path && !(new RegExp(r.path).test(p))) continue
      if (r.queryIncludes && !String(query || '').includes(r.queryIncludes)) continue
      if (r.bodyIncludes && !String(rawBody || '').includes(r.bodyIncludes)) continue
      return r
    }
    return null
  }
  const sendJson = (res, status, obj) => { const s = JSON.stringify(obj === undefined ? true : obj); res.writeHead(status || 200, { 'content-type': 'application/json' }); res.end(s) }
  // assistant 完成消息(形状对齐真 serve:info.role/time.completed + parts[text])——extractText/pickTurnText 直接认
  const asstMsg = (text) => ({ info: { role: 'assistant', time: { created: Date.now(), completed: Date.now() } }, parts: [{ id: 'prt_' + Math.random().toString(36).slice(2, 8), type: 'text', text: String(text == null ? '' : text) }] })
  const userMsg = (text) => ({ info: { role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text: String(text == null ? '' : text) }] })

  async function route(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1')
    const p = u.pathname, q = u.search || ''
    let raw = ''
    if (req.method === 'POST' || req.method === 'PATCH') {
      raw = await new Promise((r) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => r(Buffer.concat(b).toString('utf8'))) })
    }
    state.requests.push({ method: req.method, path: p, query: q, body: raw.slice(0, 200), at: Date.now() - t0 })

    // /event:SSE 长连接(opencode.js runEventLoop fetch 流读)
    if (req.method === 'GET' && p === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': ok\n\n')
      sseClients.add(res)
      for (const d of pendingEv.splice(0)) { try { res.write('data: ' + d + '\n\n') } catch {} }
      if (mode === 'auto') autoPlay(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    // 健康/保活/权限探针(detectPerm 判非 HTML 即"新"端点)
    if (p === '/global/health') return sendJson(res, 200, { healthy: true })
    if (p === '/heartbeat') return sendJson(res, 200, true)
    if (p === '/config' && req.method === 'GET') return sendJson(res, 200, {})
    if (p === '/config' && req.method === 'PATCH') return sendJson(res, 200, true)
    if (p === '/config/providers') return sendJson(res, 200, { providers: [] })

    const rule = matchRule(req.method, p, q, raw)
    if (rule) rule.__used = true
    // 规则带的 json 统一做别名替换($sN → 真实 sid)——录制产物直接回放时,响应体里的会话引用不失效
    const rj = (rule && rule.json !== undefined) ? JSON.parse(subst(JSON.stringify(rule.json))) : undefined

    // POST /session:建会话(sidOf 认 id/data.id/info.id;响应顺带绑定 $sN 别名)。
    // id 恒用 fake 新发的(与 state 一致;录制规则里的旧 sid 只是样本,不能拿去当会话状态键),其余字段可随规则合并
    if (req.method === 'POST' && p === '/session') {
      const sid = 'ses_' + (++state.seq) + Math.random().toString(36).slice(2, 6)
      let title = '对话'
      try { title = (JSON.parse(raw || '{}') || {}).title || title } catch {}
      noteSession(sid, title)
      return sendJson(res, (rule && rule.status) || 200, { ...(rj || {}), id: sid, title })
    }
    if (req.method === 'GET' && p === '/session')
      return sendJson(res, 200, [...state.sessions.values()].map((s) => ({ id: s.id, title: s.title, time: { updated: Date.now() } })))
    const mSess = p.match(/^\/session\/(ses_[^/?]+)(\/(message|children|todo|abort|permissions\/[^/?]+|prompt_async))?$/)
    if (mSess) {
      const sid = mSess[1], sub = mSess[3] || ''
      const sess = state.sessions.get(sid) || (noteSession(sid), state.sessions.get(sid))
      if (req.method === 'GET' && !sub) return sendJson(res, 200, { id: sid, title: sess.title })
      if (req.method === 'DELETE' && !sub) { state.sessions.delete(sid); return sendJson(res, 200, true) }
      if (sub === 'message' && req.method === 'POST') {
        // 先 stateful 落 user 消息(规则 appendUser:false 抑制——错误注入时 lastUserMatches 探不到才直接抛)
        let userText = ''
        try {
          const b = JSON.parse(raw || '{}')
          const tp = (b.parts || []).find((x) => x && x.type === 'text')
          userText = tp ? String(tp.text || '') : ''
        } catch {}
        if (!rule || rule.appendUser !== false) sess.messages.push(userMsg(userText))
        if (rule && Array.isArray(rule.todo)) sess.todo = rule.todo
        if (rule && rule.status && rule.status >= 400) {
          if (rule.sseAfter) broadcast(rule.sseAfter)
          return sendJson(res, rule.status, rj || { error: 'fake serve scripted error' })
        }
        // 默认/规则都收敛到"落一条 assistant 完成消息并返回"(sendMessage 的 extractText 快速路径,不轮询)
        const ansText = rule && typeof rule.appendAssistant === 'string' ? subst(rule.appendAssistant) : '(fake 终答:收到)'
        const am = asstMsg(ansText)
        sess.messages.push(am)
        if (rule && rule.sseAfter) broadcast(rule.sseAfter)
        return sendJson(res, (rule && rule.status) || 200, rj || am)
      }
      if (sub === 'message' && req.method === 'GET') return sendJson(res, 200, rj || sess.messages)
      if (sub === 'children') return sendJson(res, 200, rj || [])
      if (sub === 'todo') return sendJson(res, 200, rj || sess.todo || [])
      if (sub === 'abort') return sendJson(res, 200, rj || true)
      if (sub === 'prompt_async') return sendJson(res, 404, { error: 'not found' })   // 内网 fork 同形:404 熔断回落原路径
      if (sub && sub.startsWith('permissions/')) return sendJson(res, 200, true)
      return sendJson(res, 200, true)
    }
    if (req.method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(p)) return sendJson(res, 200, true)
    if (req.method === 'POST' && /^\/question\/[^/]+\/(reply|reject)$/.test(p)) return sendJson(res, 200, true)
    if (rule) return sendJson(res, rule.status || 200, rj !== undefined ? rj : true)
    return sendJson(res, 200, true)   // 兜底:未知端点也给 200 JSON(与"内网 serve 形状容忍"同向,不让杂讯炸链路)
  }

  return {
    state, rules, requests: state.requests,
    get port() { return port }, get base() { return base },
    listen(p) {
      if (server) { if (port === p) return; throw new Error('fake serve 已监听 :' + port + ',不能再听 :' + p) }
      port = p; base = 'http://127.0.0.1:' + p
      server = http.createServer((req, res) => { route(req, res).catch((e) => { log('fake serve route err: ' + e.message); try { sendJson(res, 500, { error: e.message }) } catch {} }) })
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
      server.on('error', (e) => log('fake serve listen err: ' + e.message))
      server.listen(p, '127.0.0.1')
    },
    broadcast, pushNextSse, pushAllSse, subst,
    ssePending: () => sseLines.length - sseIdx,
    async close() {
      for (const res of sseClients) { try { res.end() } catch {} }
      sseClients.clear()
      for (const s of sockets) { try { s.destroy() } catch {} }
      if (server) await new Promise((r) => { try { server.close(() => r()) } catch { r() } })
      server = null
    },
  }
}
// 假 serve 子进程(setSpawnHook 的返回值):wireServeProc 要 EventEmitter + stdout/stderr(可空),
// killProc 看 proc.pid —— 不给 pid(0/undefined)就是 no-op,绝不误杀真进程。
function fakeServeProc() {
  const em = new EventEmitter()
  em.pid = 0; em.stdout = null; em.stderr = null; em.exitCode = null
  em.kill = () => true
  return em
}

// ── createWorld：一条用例一套世界(S + 真 window.js/session.js + 真 opencode.js + fake serve) ──
// opts: { transcript(JSONL 字符串或行数组), mode('manual'|'auto'), timeScale, settings(深并入默认), quiet }
async function createWorld(opts = {}) {
  installElectronStubOnce()
  installTimersOnce()
  resetTimers()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-replay-'))
  ACTIVE.root = root
  ACTIVE.wcs = new Map()
  FakeBrowserWindow._all.length = 0
  const UD = path.join(root, 'ud')
  const PROJ = path.join(root, 'proj'); fs.mkdirSync(PROJ, { recursive: true })
  for (const d of ['ud']) fs.mkdirSync(path.join(root, d), { recursive: true })
  // app.getPath('userData') 的落点必须【先存在】:mail.js 的 startMailRelay 在 listen 回调里
  // writeFileSync(userData/mail-relay.json) 且【没有 mkdir】—— 目录不在就 ENOENT 被 catch 吞成一行日志,
  // relay 端口号从此没人知道,整层 /orch/* 端点在 replay 里不可达(这就是它一直裸奔的原因)。
  // 生产里 userData 由 Electron 保证存在,这里补齐同一前提。
  fs.mkdirSync(stubGetPath('userData'), { recursive: true })

  const logs = []
  const log = (m) => { logs.push(String(m)); if (!opts.quiet && process.env.REPLAY_VERBOSE) console.log('    [log] ' + m) }
  const transcript = typeof opts.transcript === 'string' ? parseTranscript(opts.transcript) : (Array.isArray(opts.transcript) ? opts.transcript : [])
  const fake = createFakeServe({ transcript, mode: opts.mode || 'manual', timeScale: opts.timeScale ?? 1, log })

  // 真 opencode.js(模块单例):spawnHook 把"自起 serve"换成 fake serve 同端口 listen
  const oc = require('../../opencode.js')
  oc.__test.setSpawnHook((dir, p) => { fake.listen(p); return fakeServeProc() })

  // S 形状仿 main.js:各模块 initX(S, deps) 协作的共享可变状态
  const S = {
    settingsFile: path.join(UD, 'settings.json'), historyFile: path.join(UD, 'history.json'),
    settings: { theme: 'light', projectDir: PROJ, backendDir: '', serveBin: '', editorCmd: '', recentDirs: [], ...(opts.settings || {}) },
    history: [], cardSeq: 0, settingsWin: null, dockWin: null, tray: null,
    sessionByWc: new Map(), sessionInfo: new Map(), pendingPerm: new Map(), pendingQuestion: new Map(),
    streamBuf: new Map(), sentPrompt: new Map(), firstMsgCtx: new Map(), workflows: new Map(),
    handlers: null,
  }
  const deps = {
    ipcMain: electronStub.ipcMain, app: electronStub.app, BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView, screen: electronStub.screen, dialog: electronStub.dialog,
    Tray: electronStub.Tray, Menu: electronStub.Menu, nativeImage: electronStub.nativeImage,
    shell: electronStub.shell, path, fs, oc, log,
  }
  electronStub.ipcMain._handlers = {}
  // 装配顺序同 main.js:initWindow 先(产出 recordHistory 等),initSession 后(填入 S.handlers)
  const winApi = require('../../src/window.js')(S, deps)
  require('../../src/session.js')(S, {
    ipcMain: electronStub.ipcMain, path, fs, shell: electronStub.shell, oc, log,
    recordHistory: winApi.recordHistory, touchHistory: winApi.touchHistory, replaceHistoryId: winApi.replaceHistoryId,
  })
  const handlers = electronStub.ipcMain._handlers
  const senderOf = (wc) => ({ sender: wc })
  // 预热:以 tryShare:false 自起 fake serve 并登记进 pool —— 之后 card-init 的 ensureServe 直接命中
  // pool 复用它,永不走 findExistingServe 端口扫描。必做:本机 4096-4110 可能有真 serve 在跑
  // (开发机常态),复用它 = 流量跑偏到真模型,用例全乱(实测踩中:requests 流水全空)。
  await oc.ensureServe(S.settings.projectDir, S.handlers, log, { tryShare: false })

  const world = {
    S, fake, logs, handlers, winApi, root, proj: PROJ, ud: UD, oc,
    wcById: (id) => ACTIVE.wcs.get(id) || null,
    windows: () => FakeBrowserWindow._all.slice(),
    // 分片/工作流:spawn-workflow → spawnWorkflow;正常开卡返回 { id, wcId, wc, reg },排队返回 { queued: true }
    spawnWorkflow(goal) {
      const r = handlers['spawn-workflow'](senderOf({ id: 0 }), goal)
      if (r && r.queued) return { queued: true, position: r.position }
      const reg = S.wfRegistry && S.wfRegistry.get(String(r))
      const wcId = reg && reg.wcId
      return { id: r, wcId, wc: ACTIVE.wcs.get(wcId) || null, reg }
    },
    approvePlan(wcId) { if (handlers['wf-plan-approved']) handlers['wf-plan-approved'](senderOf({ id: wcId })) },
    // ── 走【真 relay】的入口(MCP 视角)────────────────────────────────────────────────
    // 以前用例一律从 S.dispatchShard 进,把 mail.js 的 /orch/run、/orch/run-orch、/orch/result 整层绕过去了 ——
    // 而自主升格开卡、编排入口回包、成果回取、queued 拍平、递归硬禁全住在那一层。
    // relay 在 harness 里其实是【真起着】的:mail.js 的 startMailRelay 无条件执行,app.getPath 又被重定向到本 world
    // 的临时根,所以 mail-relay.json(端口 + token)就在 world.ud 下。之前只是没人从这个口进来过。
    // 用法:const r = await world.relayPost('/orch/run', { goal, parentTag })
    async relayPost(urlPath, body) {
      // srv.listen(0) 是异步的,mail-relay.json 在 listen 回调里才写 —— 首次调用等它落地
      const fp = path.join(stubGetPath('userData'), 'mail-relay.json')
      const cfg = await waitFor(() => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return null } },
        { timeout: 4000, interval: 20, name: 'relay 未就绪(等不到 ' + fp + ')' })
      return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body || {}), 'utf8')
        const req = http.request({
          hostname: '127.0.0.1', port: cfg.port, path: urlPath, method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-bocom-tok': cfg.token },
        }, (res) => {
          let buf = ''; res.setEncoding('utf8')
          res.on('data', (c) => { buf += c })
          res.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { reject(new Error('relay 响应非 JSON: ' + buf.slice(0, 200))) } })
        })
        req.on('error', (e) => reject(new Error('relay 连不上(' + cfg.port + '): ' + e.message)))
        req.write(data); req.end()
      })
    },
    // 模拟渲染层:卡片加载后 card-init(分片传 shard:1,生产同形),随后 card-send 发首条消息
    async cardInit(wc, o) { return handlers['card-init'](senderOf(wc), o || {}) },
    async cardSend(wc, text) { return handlers['card-send'](senderOf(wc), { text }) },
    // 投递取证:某卡 webContents 收到的信道流水 / card-inject 过滤
    sentTo(wcId) { const wc = ACTIVE.wcs.get(wcId); return wc ? wc.sent : [] },
    injects(wcId) { return world.sentTo(wcId).filter((s) => s.ch === 'card-inject') },
    shardProgress(wcId) { return world.sentTo(wcId).filter((s) => s.ch === 'shard-progress') },
    fireTimer, pendingTimers,
    async teardown() {
      // 事件循环退出:置 dead + 销毁 SSE socket(reader.read 结束 → loop 见 dead 返回);pool/映射全清
      try { for (const info of oc.__test.maps.pool.values()) info.dead = true } catch {}
      try { oc.killAll() } catch {}
      try { oc.__test.setSpawnHook(null) } catch {}
      try {
        const m = oc.__test.maps
        m.classifiedSessions.clear(); m.childToParent.clear(); m.childTitle.clear(); m.sidBase.clear()
        oc.__test.abortedSids.clear(); oc.__test.stoppedSids.clear(); oc.__test.turnTextCache.clear()
      } catch {}
      await fake.close()
      resetTimers()
      ACTIVE.wcs = new Map()
      FakeBrowserWindow._all.length = 0
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    },
  }
  return world
}

// ── record.mjs 复用:把真实 ses_xxx 反向别名化成 $sN(录制产物可直接回放) ────────────────
function aliasify(text, sidOrder) {
  let out = String(text == null ? '' : text)
  sidOrder.forEach((sid, i) => { out = out.split(sid).join('$s' + (i + 1)) })
  return out
}

export {
  createWorld, createFakeServe, parseTranscript, serializeTranscript, aliasify,
  ok, expectSeq, expectSet, expectState, expectFile, resetAsserts, assertCounts,
  sleep, waitFor, fireTimer, pendingTimers,
}
