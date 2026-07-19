// BocomHermes · 动态工作流编排 MCP(本地 stdio,零业务依赖)
// 给对话 Agent 一个能力:当它判断"这事自己一个人扛不动"时,自主升格给动态工作流。
//   · 调 run_workflow → relay 到主进程 spawnWorkflow → 开一张工作流卡(Claude Code 式:单主 Agent
//     在连续上下文里自拆 + task 并行派子 Agent 深挖 + 自综合;规划先行,用户批准后才开跑)。
//   · workflow_result 取成果:内存注册表按轮快照(进行中也能取),关卡/重启后由 userData/workflows/ 存档兜底。
//   · 工具描述本身就是"何时升格"的判据 —— 升格与否是 Agent 在上下文里自主决定,不是规则触发。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const log = (...a) => process.stderr.write('[orch-mcp] ' + a.join(' ') + '\n')

function userData() {
  const env = process.env.BOCOMHERMES_USERDATA
  if (env) return env
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BocomHermes-shell')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BocomHermes-shell')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BocomHermes-shell')
}
const DATA = userData()

// 复用 mail-relay.json 的本地中继(同一个 HTTP server + token)
function relayCfg() { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'mail-relay.json'), 'utf8')) } catch { return null } }
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

const TOOLS = [
  {
    name: 'run_workflow',
    description:
      '把一个复杂目标升格给"动态工作流"(开一张主 Agent 卡:它在连续上下文里自己规划(todo 清单可见)、用 task 工具一次并行派多个子 Agent 深挖、自己综合成品;过程全程可视,用户可随时插话引导或中止)。\n' +
      '【何时调用 —— 你自己判断,不是规则】当任务满足以下任一,升格比自己一个人做更好:\n' +
      ' · 需要大范围深读代码/资料(几十上百个文件),该由多个子 Agent 用各自独立的上下文分头深读;\n' +
      ' · 需要并行探查多个相对独立的来源(如 代码 + 数据库 + 文档),分头更快;\n' +
      ' · 需要多个独立视角互相校验(如 实现方 + 专挑刺的评审方)。\n' +
      '【何时不要调】简单查询、解释、小改动、闲聊 —— 直接自己答,别升格(更慢更贵)。\n' +
      '【拿不准】倾向先自己做;真觉得划算再升格。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '总目标,一句话讲清要达成什么(把你已掌握的关键上下文也写进去,工作流主 Agent 看不到本对话)' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'workflow_result',
    description: '取回某个动态工作流的成果(成果按轮快照进注册表并存档,进行中也能取到最新阶段成果,完成后取终稿全文)。用户问"刚才那个工作流结果怎样/基于结果继续做 X"时调这个,拿到成果直接接着干活。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '工作流 id(run_workflow 返回过);省略 = 最近一个' } } },
  },
]

async function callTool(name, a) {
  a = a || {}
  if (name === 'run_workflow') {
    const goal = String(a.goal || '').trim()
    if (!goal) return '需要 goal(交给小队的总目标)'
    const r = await relayPost('/orch/run', { goal })
    return '已拉起动态工作流,id=' + (r.id != null ? r.id : '?') + '(卡片已打开:主 Agent 自拆 + 并行派子 Agent 深挖 + 自综合,过程可视、用户可插话)。'
      + '之后调 workflow_result(id="' + (r.id != null ? r.id : '') + '") 取回成果继续用(进行中也能取到最新阶段成果);现在可以先和用户讨论别的。'
  }
  if (name === 'workflow_result') {
    const body = {}
    if (a.id != null && String(a.id).trim()) body.id = String(a.id).trim()
    const r = await relayPost('/orch/result', body)
    if (r.status === 'running') return '工作流 #' + r.id + ' 仍在进行(第 ' + (r.round || '?') + ' 轮):' + r.goal
      + (r.final ? '\n\n【最新阶段成果(快照,后续还会更新)】\n' + r.final : '\n还没有阶段成果,稍后再调 workflow_result。')
    // archived = 该工作流来自之前的运行(注册表已随重启清空),成果取自磁盘存档
    const bits = [r.status === 'archived' ? '已存档(历史运行)' : r.status]
    if (r.rounds != null) bits.push(r.rounds + ' 轮')
    if (r.elapsedMs != null) bits.push(Math.round(r.elapsedMs / 1000) + 's')
    return '工作流 #' + r.id + '(' + bits.join(' · ') + ')\n目标:' + (r.goal || '') + (r.archive ? '\n存档:' + r.archive : '') + '\n\n' + (r.final || '(无成果)')
  }
  throw new Error('未知工具: ' + name)
}

// ── MCP stdio 协议 ──
const PROTO = '2024-11-05'
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'bocomhermes-orch', version: '0.1.0' } })
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try { const text = await callTool(params && params.name, params && params.arguments); reply(id, { content: [{ type: 'text', text: String(text) }] }) }
    catch (e) { reply(id, { content: [{ type: 'text', text: '编排工具出错: ' + (e && e.message || e) }], isError: true }) }
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现: ' + method } })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } Promise.resolve(handle(m)).catch((e) => log('handle err: ' + e.message)) } })
log('ready · userData=' + DATA)
