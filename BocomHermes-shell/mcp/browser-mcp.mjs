// BocomHermes · 浏览器自动化 MCP（本地 stdio 服务，零依赖）
// 给 opencode/bocomcode 的 agent 扩能：导航/取文本/点击/输入/执行JS/截图。
// 实现：用 CDP(Chrome DevTools Protocol) 驱动【系统已装的 Edge/Chrome】，
//   不依赖 playwright、不下载浏览器；WebSocket 用 Node 内置全局(需 Node 22+)。
// 数据不出网：浏览器与 CDP 全程 127.0.0.1。
// 注册到 opencode.json 的 mcp（type:local, command:["node", 本文件路径]）。见 mcp/README.md。
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const log = (...a) => process.stderr.write('[browser-mcp] ' + a.join(' ') + '\n')   // 日志走 stderr，stdout 只发协议
const HEADFUL = process.env.BOCOMHERMES_BROWSER_HEADFUL === '1'

// ---------- 浏览器发现 ----------
const CANDS = [
  process.env.BOCOMHERMES_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && (process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const findBrowser = () => CANDS.find((p) => { try { return fs.existsSync(p) } catch { return false } })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort(start) {
  return new Promise((resolve) => { const t = (p) => { const s = net.createServer(); s.once('error', () => t(p + 1)); s.once('listening', () => s.close(() => resolve(p))); s.listen(p, '127.0.0.1') }; t(start) })
}

// ---------- 极简 CDP 客户端（基于内置 WebSocket）----------
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data) } catch { return }
        if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message || 'CDP error')) : res(m.result) }
      }
    })
  }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })) }) }
  close() { try { this.ws.close() } catch {} }
}

// ---------- 浏览器会话（懒启动，单页复用）----------
let B = null
async function ensureBrowser() {
  if (B) return B
  if (typeof WebSocket === 'undefined') throw new Error('当前 Node 无内置 WebSocket（需 Node 22+），无法驱动浏览器')
  const exe = findBrowser()
  if (!exe) throw new Error('未找到 Edge/Chrome，可设环境变量 BOCOMHERMES_BROWSER 指向浏览器 exe')
  const port = await freePort(9333)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'BocomHermes-br-'))
  const args = ['--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-allow-origins=*', 'about:blank']
  if (!HEADFUL) args.unshift('--headless=new', '--disable-gpu')
  log('launch', exe, 'port', port, HEADFUL ? '(headful)' : '(headless)')
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
  const base = 'http://127.0.0.1:' + port
  let ver = null
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(base + '/json/version')).json(); break } catch { await sleep(300) } }
  if (!ver) { try { proc.kill() } catch {}; throw new Error('浏览器调试端口未就绪（30s 超时）') }
  let list = []; try { list = await (await fetch(base + '/json/list')).json() } catch {}
  let page = list.find((t) => t.type === 'page')
  if (!page) { try { page = await (await fetch(base + '/json/new', { method: 'PUT' })).json() } catch {} }
  if (!page || !page.webSocketDebuggerUrl) { try { proc.kill() } catch {}; throw new Error('拿不到页面调试端点') }
  const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  B = { proc, cdp, port, dir, base }
  return B
}
function closeBrowser() {
  if (!B) return
  try { B.cdp.close() } catch {}
  try { B.proc.kill() } catch {}
  try { fs.rmSync(B.dir, { recursive: true, force: true }) } catch {}
  B = null
}
async function evalJs(expression, awaitPromise = true) {
  const b = await ensureBrowser()
  const r = await b.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 执行异常')
  return r.result?.value
}
async function navigate(url) {
  const b = await ensureBrowser()
  await b.cdp.send('Page.navigate', { url })
  for (let i = 0; i < 60; i++) { const rs = await evalJs('document.readyState'); if (rs === 'complete' || rs === 'interactive') break; await sleep(300) }
  const title = await evalJs('document.title'); const href = await evalJs('location.href')
  return { title, url: href }
}

// ---------- 技能(录制回放)——经本地中继调 GUI 主进程的强回放引擎 ----------
// 用户在内嵌浏览器里"录制一次→保存为技能",agent 在这里按名字复用。
// 执行不在本文件的 headless 浏览器里(那套是裸 querySelector 弱引擎),而是 relay 回
// GUI 主进程跑 replayRec(selAlt fallback + 登录态恢复 + 红框可视化,用户看得见)。
import http from 'node:http'
function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
function relayCfg() { try { return JSON.parse(fs.readFileSync(path.join(userData(), 'mail-relay.json'), 'utf8')) } catch { return null } }
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

// ---------- 工具表 ----------
const TOOLS = [
  {
    name: 'skill_list',
    description: '列出用户已保存的浏览器自动化技能(名称/说明/参数)。用户说"用XX技能/按我录的流程跑"或要复用已录页面操作时,先调它看有哪些。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_run',
    description: '按名字运行已保存的浏览器技能:在用户可见的内嵌浏览器里逐步回放,返回每步结果与成败结论。params 按 skill_list 的参数键传,不传用录制默认值(select 参数传 option 的 value 字典码;跨环境字典不同则不传)。',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: '技能名(skill_list 返回的 name)' },
      params: { type: 'object', description: '运行时参数,如 {"p1":"6222..."}' },
      baseUrl: { type: 'string', description: '可选,环境根地址(仅 http/https origin);不传用录制环境。切环境不恢复录制登录态' },
    }, required: ['name'] },
  },
  {
    name: 'skill_run_batch',
    description: '用数据集循环跑同一条技能:dataset 每行 = {参数label或key: 值},逐行回放并汇总 PASS/FAIL,适合批量录入/N 条案例。先 skill_list 看参数名再组行。行失败默认继续(onError="stop" 中止);上限 200 行。',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: '技能名(skill_list 返回的 name)' },
      dataset: { type: 'array', items: { type: 'object' }, description: '每行一个对象,键=参数 label(或 key)' },
      baseUrl: { type: 'string', description: '可选,环境根地址(http/https origin);切环境不恢复录制登录态' },
      onError: { type: 'string', enum: ['skip', 'stop'], description: '某行失败后:skip=继续下一行(默认)/ stop=中止' },
    }, required: ['name', 'dataset'] },
  },
  {
    name: 'doc_read',
    description: '读本地文档文本(Excel/CSV/Word/PDF/TXT/MD/JSON 等;Excel 转 CSV 按 Sheet 分段)。skill_run 报告的导出/下载文件路径拿它直接读,别自写脚本解析。支持 offset/limit 分段读。',
    inputSchema: { type: 'object', properties: {
      path:   { type: 'string', description: '本地文件绝对路径' },
      offset: { type: 'number', description: '从第几个字符开始,默认 0' },
      limit:  { type: 'number', description: '本次取多少字符,默认 8000,最大 50000' },
    }, required: ['path'] },
  },
  {
    name: 'skill_page_read',
    description: '【混合执行】读内嵌浏览器当前页:URL/标题/可交互元素清单(带现成选择器)/正文节选。接管期每步操作前先调它确认页面状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_page_act',
    description: '【混合执行·仅接管期可用】在内嵌浏览器执行一步操作。selector 用 skill_page_read 给的现成选择器或 __text__:tag|文本(按可见文本);严禁 :has-text()/xpath。secret(密码)用 type_param+key,引擎代填,值不经过你。',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['click', 'type', 'type_param', 'select', 'check', 'enter', 'navigate', 'wait'] },
      selector: { type: 'string', description: '目标元素(click/type/type_param/select/check/enter 用)' },
      value: { type: 'string', description: 'type 的文本 / select 的 value' },
      text: { type: 'string', description: 'select 可选:按选项文本回退' },
      key: { type: 'string', description: 'type_param 用:参数键(如 p1)' },
      checked: { type: 'boolean', description: 'check 用,默认 true' },
      url: { type: 'string', description: 'navigate 用(仅 http/https)' },
      ms: { type: 'number', description: 'wait 用,毫秒(≤5000)' },
    }, required: ['action'] },
  },
  {
    name: 'skill_takeover_done',
    description: '【混合执行】接管收口:做完或确认无法完成时必须调用,回放据此出报告。status: done=达成 / failed=无法完成(note 写原因)。',
    inputSchema: { type: 'object', properties: { gateId: { type: 'string', description: '接管请求 id(来自接管通知)' }, status: { type: 'string', enum: ['done', 'failed'] }, note: { type: 'string', description: '一句话:做了什么/为何失败' } }, required: ['gateId', 'status'] },
  },
  // ── Agent 自主浏览器会话:端到端验证用【真浏览器】(带用户登录态、用户看得见、强引擎)────────
  // 与headless_* 那组的区别很要紧,描述里必须写清楚,否则模型会随手挑错的那个:
  //   headless_navigate/get_text/... 跑在【MCP 进程内另起的无头浏览器】里 —— 没有登录态、
  //   用户看不见、和真实使用环境不是同一个东西,只适合公网只读页面。
  //   这一组跑在内嵌浏览器里,是用户真在用的那个浏览器。要"打开页面验一遍"就用这一组。
  {
    name: 'preview_start',
    description: '把项目【跑起来】(dev server),等端口就绪后返回地址 —— 然后就能 browser_open 去验了。'
      + '★只能启动 launch.json 里【用户写好】的具名配置(项目下 .bocom/launch.json 或 .claude/launch.json),'
      + '不接受任意命令 —— 这是安全边界,不要试图绕。不知道有哪些就先 preview_list。'
      + '同名已在跑会直接复用(不会重复起、撞端口)。起不来时回执直接带最后几行日志 ——'
      + '"起不来"三个字对排查没有价值,原因几乎总在那几行里。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'launch.json 里配置的 name' } }, required: ['name'] },
  },
  {
    name: 'preview_list',
    description: '看有哪些可启动的配置(launch.json)以及当前在跑的 dev server(serverId/端口/地址/已跑多久)。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_logs',
    description: 'dev server 的 stdout/stderr。level="error" 只看像错误的行,search 按关键词 —— '
      + '编译报错、端口占用、接口 500 都先看它。命中多于给出时会明说。',
    inputSchema: { type: 'object', properties: {
      serverId: { type: 'string' }, lines: { type: 'number', description: '最多给几行(默认 80)' },
      level: { type: 'string', enum: ['all', 'error'] }, search: { type: 'string' },
    }, required: ['serverId'] },
  },
  {
    name: 'preview_stop',
    description: '停掉一个 dev server(先 SIGTERM,3 秒不退再 SIGKILL)。验完就停 —— 留着会占端口。',
    inputSchema: { type: 'object', properties: { serverId: { type: 'string' } }, required: ['serverId'] },
  },
  {
    name: 'browser_open',
    description: '【端到端验证·首选】在内嵌浏览器里开一个受围栏的自主会话(自己的标签页,用户看得见,带登录态)。'
      + '默认只放行本机 localhost/127.0.0.1;其他站点需用户在 设置→浏览器→Agent 自主会话 里加白名单。'
      + '返回 sessionId + 首屏页面结构。做完必须调 browser_close 出报告 —— 报告里的 verdict 是机器算的,没断言不算 PASS。',
    inputSchema: { type: 'object', properties: {
      url: { type: 'string', description: '要验证的页面地址(http/https)' },
      purpose: { type: 'string', description: '一句话:这次要验什么。会写进报告并显示给用户(浏览器是他的,得让他知道你在干嘛)' },
    }, required: ['url', 'purpose'] },
  },
  {
    name: 'browser_read',
    description: '读会话当前页:URL/标题/【带 [ref_N] 句柄的可交互元素清单】/正文节选。'
      + '每步操作前先读一次 —— 后续 browser_act 直接用 ref(如 ref_3),不用自己拼选择器,也就不会拼错。'
      + '★ref 只对【这一次读页】有效:页面刷新或重渲染后必须重新 browser_read 拿新的;'
      + '拿旧 ref 去点会明确报"找不到元素",不会悄悄点到别的东西上。'
      + '元素或正文被截断时回执里会明说(truncated 字段),别把截断当成"页面就这么多"。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      all: { type: 'boolean', description: '默认只列可交互元素;true = 连标题/标签/表格单元一起列(页面结构看不清时用)' },
    }, required: ['sessionId'] },
  },
  {
    name: 'browser_find',
    description: '在【已读过的】当前页里按一句话找元素,返回匹配的 [ref_N](按相关度排序)。'
      + '页面元素多的时候不要自己在 browser_read 的清单里翻 —— 直接说"登录按钮""用户名输入框"让它找。'
      + '★必须先 browser_read 过这一页(ref 是那次读页盖上去的);没读过会明确提示。'
      + '找不到时先 scroll 到那一块再 browser_read —— 不在视口里的元素不给 ref。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      query: { type: 'string', description: '一句话描述,如「提交按钮」「搜索框」「退出登录」' },
      limit: { type: 'number', description: '最多返回几条(默认 10)' },
    }, required: ['sessionId', 'query'] },
  },
  {
    name: 'browser_act',
    description: '在会话标签页里执行一步操作(强引擎:选择器兜底+可见性等待+红框高亮)。'
      + '★定位优先用 ref(browser_read 返回的 [ref_N]),没有 ref 再用 selector。navigate 的目标也走围栏。'
      + ' scroll:给 ref/selector 就滚到那个元素,不给就整页滚 —— 页面很长时"点不到"最常见的原因就是它不在视口里。'
      + ' hover:发【真实鼠标事件】(纯 CSS 的下拉菜单也能弹出来),悬停后通常要再 browser_read 一次才看得到浮层。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      action: { type: 'string', enum: ['click', 'type', 'select', 'check', 'enter', 'key', 'scroll', 'hover', 'navigate', 'wait'] },
      key: { type: 'string', description: 'action=key 时:Enter/Escape/Tab/Backspace/Delete/方向键/Home/End/PageUp/PageDown(输入文字用 type)' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'action=scroll 且没给 ref/selector 时:整页往哪滚(默认 down)' },
      amount: { type: 'number', description: 'action=scroll 整页滚多少像素(默认 600)' },
      ref: { type: 'string', description: '★首选:browser_read 给的句柄(ref_3 或 3)。用它就不用拼选择器 —— 精确唯一,页面变了会明确报错而不是点错' },
      selector: { type: 'string', description: '没有 ref 时才用(browser_read 里的现成选择器或 __text__:tag|文本);严禁 :has-text()/xpath' },
      value: { type: 'string' }, text: { type: 'string' },
      checked: { type: 'boolean' }, url: { type: 'string' }, ms: { type: 'number' },
    }, required: ['sessionId', 'action'] },
  },
  {
    name: 'browser_tabs',
    description: '会话内的多标签:list 看有哪些 / open 开一个新页 / switch 切过去 / close 关掉。'
      + '★什么时候用:要【对着两个页面看】的时候 —— 改前改后、列表页与详情页、两个环境同一功能。'
      + '单标签只能来回 navigate,前一页的滚动位置、填了一半的表单、控制台历史全丢,"对比"就只能靠记忆描述。'
      + '新标签一样过围栏;只能操作本会话自己开的标签(用户手动开的页面不归你碰);不许关掉最后一个。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      action: { type: 'string', enum: ['list', 'open', 'switch', 'close'], description: '默认 list' },
      url: { type: 'string', description: 'action=open 时要打开的地址' },
      tabId: { type: 'number', description: 'action=switch/close 时的目标(list 里给的 tabId)' },
    }, required: ['sessionId'] },
  },
  {
    name: 'browser_resize',
    description: '切设备尺寸(desktop/mobile/tablet)或配色(light/dark),用来验响应式与暗色 —— 这两类问题不切过去就看不见。'
      + '切完页面会重排,要看效果请再 browser_read 或 browser_shot 一次。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      preset: { type: 'string', enum: ['desktop', 'mobile', 'tablet'], description: '手机 390 / 平板 834 / 桌面(还原)' },
      colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'], description: '模拟系统配色偏好(prefers-color-scheme)' },
    }, required: ['sessionId'] },
  },
  {
    name: 'browser_assert',
    description: '断言一条可判定的事实,结果进报告。这是"验过了"和"打开看了一眼"的分界线 —— 一条断言都没有的会话判 INCONCLUSIVE,不算通过。'
      + ' no_console_error / no_failed_request 查的是浏览器自己采集的控制台与网络,是"页面看着正常但其实报错了"的唯一抓手,建议每次都验。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      kind: { type: 'string', enum: ['text_present', 'text_absent', 'selector_exists', 'selector_absent', 'url_matches', 'no_console_error', 'no_failed_request'] },
      expect: { type: 'string', description: '前五种需要:要找的文本/选择器/URL 片段' },
      label: { type: 'string', description: '这条断言在验什么(写进报告,用人话)' },
    }, required: ['sessionId', 'kind'] },
  },
  {
    name: 'browser_shot',
    description: '给会话标签页截图,返回 PNG 路径。截完把它当附件读一遍再下结论(带图消息会自动切到读图模型)——'
      + '布局崩没崩、内容对不对,只有看图才知道。',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, full: { type: 'boolean', description: '整页长图(默认只截可视区)' }, label: { type: 'string' } }, required: ['sessionId'] },
  },
  {
    name: 'browser_diag',
    description: '取会话标签页的控制台与网络明细(排查用;判定请用 browser_assert)。默认只给错误与失败请求。'
      + '★三件事最值钱:① pattern 按关键词找那一条(报错信息你通常已知一半);'
      + '② only="all" 看【成功】请求 —— 接口返回了什么才是问题所在,不是它有没有 200;'
      + '③ requestId 取某一条的【响应体】——"接口通了但返回体不对"是前端 bug 的大头,只看状态码永远看不见。'
      + '列表里每条都带 id,拿 id 回来取体。命中数多于给出数时回执会明说,别把"最近 N 条"当成全部。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      level: { type: 'string', enum: ['error', 'warn', 'all'], description: '控制台级别(默认 error)' },
      pattern: { type: 'string', description: '控制台按关键词筛(命中 message 或来源文件)' },
      only: { type: 'string', enum: ['failed', 'all'], description: '请求:默认只给失败/4xx+;all = 全部(要看成功接口返回什么就用它)' },
      urlPattern: { type: 'string', description: '请求按 URL 关键词筛,如 /api/order' },
      requestId: { type: 'string', description: '给了就【只返回这一条的响应体】(id 来自列表)' },
      limit: { type: 'number', description: '各最多给几条(默认 30,上限 100)' },
    }, required: ['sessionId'] },
  },
  {
    name: 'browser_close',
    description: '收会话并出报告(必调)。报告含逐步流水/断言结果/截图路径/机判 verdict。verdict 由壳层算,你说了不算。',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' },
      status: { type: 'string', enum: ['done', 'failed'], description: 'done=验完(通过与否看断言) / failed=没法验下去' },
      note: { type: 'string', description: '一句话:验了什么/为什么验不下去' },
    }, required: ['sessionId', 'status'] },
  },
  { name: 'headless_navigate', description: '【无头·非用户浏览器】在 MCP 进程内另起的一次性浏览器里打开网址,返回标题与最终URL。没有登录态、用户看不见 —— 只适合公网只读页面;要验证本项目页面请用 browser_open 那一组', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'headless_get_text', description: '获取当前页面可见正文文本(innerText)', inputSchema: { type: 'object', properties: {} } },
  { name: 'headless_get_html', description: '获取当前页面或某选择器的 HTML', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器，可空=整页' } } } },
  { name: 'headless_click', description: '点击匹配 CSS 选择器的第一个元素', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'headless_type', description: '向输入框(选择器)填入文本，可选回车提交', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] } },
  { name: 'headless_eval', description: '在页面里执行一段 JS 表达式并返回结果(JSON可序列化)', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'headless_screenshot', description: '对当前页面截图，保存为临时 PNG 并返回文件路径', inputSchema: { type: 'object', properties: {} } },
  { name: 'headless_close', description: '【无头】关闭那个一次性无头浏览器、释放资源(与 browser_close 不是一回事:后者是收 Agent 自主会话并出报告)', inputSchema: { type: 'object', properties: {} } },
]

async function callTool(name, args) {
  args = args || {}
  if (name === 'skill_list') {
    const r = await relayPost('/skill/list', {})
    const list = r.skills || []
    if (!list.length) return '还没有已保存的技能。让用户在内嵌浏览器工具条点「● 录制」把操作跑一遍,停止后「保存为技能」即可复用。'
    const fmtRun = (lr) => lr ? (lr.ok ? `上次运行✓` : `上次运行✗(${lr.fails}步失败)`) : '未运行过'
    return list.map((s) => `· ${s.name} — ${s.description || '(无说明)'} · ${s.steps} 步 · ${fmtRun(s.lastRun)}${s.hasSuccess ? ' · 含成功断言' : ''} · 起始 ${s.startUrl}` +
      (s.params.length ? '\n  参数: ' + s.params.map((p) => `${p.key}=${p.label}${p.secret ? '(密码,必传)' : `(默认 ${p.default === '' ? '空' : p.default})`}`).join(', ') : '')).join('\n')
  }
  if (name === 'skill_run') {
    const body = { name: String(args.name || ''), params: args.params || {} }
    if (args.baseUrl) body.baseUrl = String(args.baseUrl)
    const r = await relayPost('/skill/run', body)
    let out = r.report || JSON.stringify(r)
    // 任务编排的接力棒:导出文件的【完整路径】必须回到 agent 手里(report 兜底再补一次,防主进程侧文案改动漏掉)——
    // 没有路径,"回放导出 → doc_read 加工"这条链就断在第一棒
    if (Array.isArray(r.downloads) && r.downloads.length && !out.includes(r.downloads[0])) {
      out += '\n导出/下载文件(' + r.downloads.length + ' 个,用 doc_read 读内容):\n' + r.downloads.map((p) => '  · ' + p).join('\n')
    }
    return out
  }
  if (name === 'doc_read') {
    const fp = String(args.path || '').trim()
    if (!fp) return '(path 必填:本地文件绝对路径)'
    if (!path.isAbsolute(fp)) return '(path 必须是绝对路径,收到: ' + fp + ')'
    if (!fs.existsSync(fp)) return '(文件不存在: ' + fp + ')'
    // 复用主进程同一套解析(attachments.js 无 electron 依赖,MCP 子进程可直载;xlsx/mammoth/pdf-parse 懒加载,缺依赖会给可读错误)
    const { createRequire } = await import('node:module')
    const attachments = createRequire(import.meta.url)('../src/attachments.js')
    const r = await attachments.extractLocalFile(fp)
    if (!r.ok) return 'doc_read 失败: ' + r.error
    const text = r.text || ''
    const off = Math.max(0, +args.offset || 0)
    const lim = Math.max(1, Math.min(+args.limit || 8000, 50000))
    const chunk = text.slice(off, off + lim)
    const more = off + lim < text.length
    return `[${path.basename(fp)} · ${chunk.length} / ${text.length} 字${more ? ` · 继续传 offset=${off + lim}` : ' · 已完整'}]\n──────────\n${chunk}`
  }
  if (name === 'skill_run_batch') {
    const body = { name: String(args.name || ''), dataset: Array.isArray(args.dataset) ? args.dataset : [] }
    if (args.baseUrl) body.baseUrl = String(args.baseUrl)
    if (args.onError) body.onError = String(args.onError)
    const r = await relayPost('/skill/run-batch', body)
    return r.report || JSON.stringify(r)
  }
  // ── Agent 自主浏览器会话 ────────────────────────────────────────────────
  if (name === 'preview_start') {
    const r = await relayPost('/preview/start', { name: String(args.name || '') })
    if (r.error) return '起不来:' + r.error + (r.cmd ? '\n命令: ' + r.cmd + '  (cwd=' + r.cwd + ')' : '')
      + (r.logTail && r.logTail.length ? '\n最后几行日志:\n  ' + r.logTail.join('\n  ') : '')
    return (r.reused ? '已在跑(复用):' : '已就绪:') + r.name + '  ' + (r.url || ('端口 ' + r.port))
      + '  serverId=' + r.serverId + (r.readyMs ? '  (' + Math.round(r.readyMs / 100) / 10 + 's)' : '')
      + (r.note ? '\n' + r.note : '') + '\n→ 接着 browser_open 这个地址去验'
  }
  if (name === 'preview_list') {
    const [cfg, run] = await Promise.all([relayPost('/preview/configs', {}), relayPost('/preview/list', {})])
    const cs = (cfg.configs || []).map((c) => '  · ' + c.name + '  → ' + c.cmd + (c.port ? '  :' + c.port : '')).join('\n')
    const rs = (run.servers || []).map((s) => '  · ' + s.name + '  serverId=' + s.serverId + '  ' + (s.url || '') + (s.running ? '  运行中 ' + s.uptimeSec + 's' : '  已退出')).join('\n')
    return '可启动的配置' + (cfg.from ? '(' + cfg.from + ')' : '') + ':\n' + (cs || '  (空)' + (cfg.error ? ' —— ' + cfg.error : ''))
      + '\n\n在跑的:\n' + (rs || '  (无)')
  }
  if (name === 'preview_logs') {
    const body = { serverId: String(args.serverId || '') }
    for (const k of ['level', 'search']) if (args[k] != null) body[k] = String(args[k])
    if (args.lines != null) body.lines = +args.lines
    const r = await relayPost('/preview/logs', body)
    if (r.error) return r.error
    return r.name + (r.running ? '(运行中)' : '(已退出 code=' + ((r.exit && r.exit.code) != null ? r.exit.code : '?') + ')')
      + '  ' + r.matched + '/' + r.total + ' 行:\n' + ((r.lines || []).join('\n') || '  (无)')
      + (r.truncated ? '\n⚠ ' + r.truncated : '')
  }
  if (name === 'preview_stop') {
    const r = await relayPost('/preview/stop', { serverId: String(args.serverId || '') })
    return r.error ? r.error : (r.already ? '它已经退出了' : '已发停止信号')
  }
  if (name === 'browser_open') {
    const r = await relayPost('/browser/open', { url: String(args.url || ''), purpose: String(args.purpose || '') })
    return '会话已开: ' + r.sessionId + '(' + r.expiresInSec + 's 内有效)\n当前页: ' + r.url + (r.title ? '(' + r.title + ')' : '')
      + '\n' + (r.note || '') + '\n\n可交互元素(→ 后为现成选择器):\n' + (r.elements || '(无)')
      + '\n\n正文节选:\n' + String(r.text || '').slice(0, 2000)
  }
  if (name === 'browser_read') {
    const r = await relayPost('/browser/read', { sessionId: String(args.sessionId || ''), all: !!args.all })
    return '当前页: ' + r.url + (r.title ? '(' + r.title + ')' : '') + '\n\n可交互元素(用 [ref_N] 直接给 browser_act 的 ref 参数):\n' + (r.elements || '(无)')
      // 截断必须原样带出来:不说的话模型把"前 N 个"当成"页面就这么多"
      + (r.truncated ? '\n\n⚠ 本次读页有截断:' + r.truncated : '')
      + '\n\n正文节选:\n' + String(r.text || '').slice(0, 3000)
  }
  if (name === 'browser_find') {
    const r = await relayPost('/browser/find', { sessionId: String(args.sessionId || ''), query: String(args.query || ''), limit: args.limit == null ? 10 : +args.limit })
    if (!r.found) return String(r.hint || '没找到')
    return '找到 ' + r.found + (r.total > r.found ? '/' + r.total : '') + ' 个(按相关度):\n' + (r.elements || '')
  }
  if (name === 'browser_tabs') {
    const body = { sessionId: String(args.sessionId || ''), action: String(args.action || 'list') }
    if (args.url != null) body.url = String(args.url)
    if (args.tabId != null) body.tabId = args.tabId
    const r = await relayPost('/browser/tabs', body)
    if (r.tabs) {
      return '本会话标签(' + r.tabs.length + ' 个,★=当前):\n'
        + r.tabs.map((t) => '  ' + (t.active ? '★' : ' ') + ' [tabId=' + t.tabId + '] ' + (t.title || '(无标题)') + '  ' + t.url).join('\n')
    }
    return 'ok — 当前标签 tabId=' + r.activeTabId + ' ' + (r.url || '') + (r.hint ? '\n' + r.hint : '')
  }
  if (name === 'browser_resize') {
    const body = { sessionId: String(args.sessionId || '') }
    for (const k of ['preset', 'colorScheme']) if (args[k] != null) body[k] = String(args[k])
    const r = await relayPost('/browser/resize', body)
    return 'ok — ' + JSON.stringify(r.applied || {}) + (r.hint ? '\n' + r.hint : '')
  }
  if (name === 'browser_act') {
    const body = { sessionId: String(args.sessionId || ''), action: String(args.action || '') }
    for (const k of ['ref', 'selector', 'value', 'text', 'url', 'key', 'direction']) if (args[k] != null) body[k] = String(args[k])
    if (args.amount != null) body.amount = +args.amount
    if (args.checked != null) body.checked = !!args.checked
    if (args.ms != null) body.ms = +args.ms
    const r = await relayPost('/browser/act', body)
    return 'ok — 当前页: ' + (r.url || '') + (r.scrolled ? '(' + r.scrolled + ')' : '') + (r.hint ? '\n' + r.hint : '')
  }
  if (name === 'browser_assert') {
    const r = await relayPost('/browser/assert', {
      sessionId: String(args.sessionId || ''), kind: String(args.kind || ''),
      expect: args.expect == null ? '' : String(args.expect), label: args.label == null ? '' : String(args.label),
    })
    return (r.pass ? '✅ 断言通过' : '❌ 断言未过') + ': ' + r.label + '\n实际: ' + r.actual
  }
  if (name === 'browser_shot') {
    const r = await relayPost('/browser/shot', { sessionId: String(args.sessionId || ''), full: !!args.full, label: args.label == null ? '' : String(args.label) })
    return '截图已保存: ' + r.path + '\n' + (r.note || '')
  }
  if (name === 'browser_diag') {
    const body = { sessionId: String(args.sessionId || '') }
    for (const k of ['level', 'pattern', 'only', 'urlPattern', 'requestId']) if (args[k] != null) body[k] = String(args[k])
    if (args.limit != null) body.limit = +args.limit
    const r = await relayPost('/browser/diag', body)
    if (r.body != null) {   // 取单条响应体
      const q = r.request || {}
      return '请求 ' + q.method + ' ' + q.url + ' → ' + q.status + (q.mime ? ' ' + q.mime : '')
        + '\n\n响应体:\n' + String(r.body) + (r.truncated ? '\n\n⚠ ' + r.truncated : '')
    }
    const errs = (r.consoleErrors || []).map((e, i) => '  ' + (i + 1) + '. [' + (e.level || 'error') + '] ' + e.message + (e.source ? '  @' + e.source + ':' + e.line : '')).join('\n')
    // ★每条带 id:要看响应体就是拿这个 id 再调一次 browser_diag(requestId=...)。不印 id 等于把那条路封了
    const bad = (r.failedRequests || []).map((x) => '  [' + x.id + '] ' + (x.status || x.failText) + ' ' + x.method + ' ' + x.url + (x.ms ? '  ' + x.ms + 'ms' : '')).join('\n')
    return '页面: ' + r.url
      + '\n控制台 ' + (r.consoleShown || 0) + ' 条(命中 ' + (r.consoleMatched || 0) + ' / 全部 ' + (r.consoleTotal || 0) + ',警告 ' + (r.consoleWarnCount || 0) + ' 条):\n' + (errs || '  (无)')
      + '\n请求 ' + (r.requestsShown || 0) + ' 条(命中 ' + (r.requestsMatched || 0) + ' / 全部 ' + (r.totalRequests || 0) + '):\n' + (bad || '  (无)')
      + '\n  ↑ 想看某条返回了什么:browser_diag(requestId="上面方括号里的 id")'
      + (r.truncated ? '\n⚠ ' + r.truncated : '')
  }
  // ★条件原来写成 headless_close(复制粘贴改漏了名字),两头都坏:
  //   ① browser_close 没有任何分发 —— 而它是"必调、verdict 机器算"的收口,等于整套问责流程收不了口;
  //   ② headless_close 反而会去收掉 Agent 的【可见会话】,而真正的无头关闭(下方 closeBrowser)永远走不到。
  //   两个工具的说明里都写着"与另一个不是一回事",偏偏实现把它们弄成了一回事。
  if (name === 'browser_close') {
    const r = await relayPost('/browser/close', { sessionId: String(args.sessionId || ''), status: String(args.status || 'done'), note: args.note == null ? '' : String(args.note) })
    const rep = r.report || {}
    const lines = [
      'VERDICT: ' + rep.verdict + '   (' + rep.status + ', ' + rep.durationSec + 's)',
      '目的: ' + rep.purpose,
      '断言: ' + rep.assertPassed + '/' + rep.assertTotal + '   步骤: ' + (rep.steps || []).length,
    ]
    if ((rep.failures || []).length) lines.push('未过项:\n' + rep.failures.map((x) => '  · ' + x).join('\n'))
    if ((rep.shots || []).length) lines.push('截图:\n' + rep.shots.map((x) => '  · ' + x).join('\n'))
    if (rep.verdict === 'INCONCLUSIVE') lines.push('注意: 一条断言都没做 —— 这只是"打开看了一眼",不算验证。')
    return lines.join('\n')
  }
  if (name === 'skill_page_read') {
    const r = await relayPost('/skill/page-read', {})
    return '当前页:' + r.url + (r.title ? '(' + r.title + ')' : '') + '\n\n可交互元素(→ 后为现成选择器):\n' + (r.elements || '(无)') + '\n\n正文节选:\n' + String(r.text || '').slice(0, 3000)
  }
  if (name === 'skill_page_act') {
    const body = { action: String(args.action || '') }
    for (const k of ['selector', 'value', 'text', 'key', 'url']) if (args[k] != null) body[k] = String(args[k])
    if (args.checked != null) body.checked = !!args.checked
    if (args.ms != null) body.ms = +args.ms
    const r = await relayPost('/skill/page-act', body)
    return '✓ 已执行 ' + body.action + ',当前页:' + (r.url || '')
  }
  if (name === 'skill_takeover_done') {
    const r = await relayPost('/skill/takeover-done', { gateId: String(args.gateId || ''), status: String(args.status || ''), note: String(args.note || '') })
    return '✓ 接管已收口(' + r.status + '),回放报告随之更新。'
  }
  if (name === 'headless_navigate') { const r = await navigate(String(args.url || '')); return `已打开：${r.title}\n${r.url}` }
  if (name === 'headless_get_text') { return String(await evalJs('document.body ? document.body.innerText : document.documentElement.innerText') || '').slice(0, 20000) }
  if (name === 'headless_get_html') { const sel = args.selector ? JSON.stringify(args.selector) : null; const expr = sel ? `(document.querySelector(${sel})||{}).outerHTML||''` : 'document.documentElement.outerHTML'; return String(await evalJs(expr) || '').slice(0, 40000) }
  if (name === 'headless_click') { const sel = JSON.stringify(String(args.selector)); const r = await evalJs(`(()=>{const el=document.querySelector(${sel}); if(!el) return 'NOT_FOUND'; el.click(); return 'OK';})()`); return r === 'OK' ? '已点击 ' + args.selector : '未找到元素：' + args.selector }
  if (name === 'headless_type') {
    const sel = JSON.stringify(String(args.selector)), txt = JSON.stringify(String(args.text))
    const r = await evalJs(`(()=>{const el=document.querySelector(${sel}); if(!el) return 'NOT_FOUND'; el.focus(); el.value=${txt}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';})()`)
    if (r !== 'OK') return '未找到输入框：' + args.selector
    if (args.submit) await evalJs(`(()=>{const el=document.querySelector(${sel}); if(el&&el.form) el.form.submit(); return 'OK';})()`)
    return '已输入到 ' + args.selector + (args.submit ? '（并提交）' : '')
  }
  if (name === 'headless_eval') { const v = await evalJs(String(args.expression || '')); return typeof v === 'string' ? v : JSON.stringify(v) }
  if (name === 'headless_screenshot') {
    const b = await ensureBrowser(); const r = await b.cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(os.tmpdir(), 'BocomHermes-shot-' + Date.now() + '.png'); fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return '已截图：' + file
  }
  if (name === 'headless_close') { closeBrowser(); return '已关闭浏览器' }
  throw new Error('未知工具：' + name)
}

// ---------- MCP stdio 协议（行分隔 JSON-RPC 2.0）----------
const PROTO = '2024-11-05'
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }) }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'BocomHermes-browser', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const nm = params && params.name
    try { const text = await callTool(nm, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '工具出错：' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) fail(id, -32601, '未实现的方法：' + method)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    Promise.resolve(handle(msg)).catch((e) => log('handle error', e && e.message || e))
  }
})
process.on('exit', closeBrowser)
process.on('SIGTERM', () => { closeBrowser(); process.exit(0) })
process.on('SIGINT', () => { closeBrowser(); process.exit(0) })
log('ready (headful=' + HEADFUL + ', browser=' + (findBrowser() || 'NOT FOUND') + ')')
