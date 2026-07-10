// BocomHermes · 动态工作流编排 MCP(本地 stdio,零业务依赖)
// 给对话 Agent 一个能力:当它判断"这事自己一个人扛不动"时,自主拉起一支动态小队。
//   · 调 run_workflow → relay 到主进程 spawnWorkflow → 跑 orchestrator.js(LLM 动态拆图 +
//     按依赖并行 + 任务账本 + 看结果重规划 + 人审闸口),不是写死角色的并行。
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
      '把一个复杂任务交给一支"动态小队"并行处理(开一个工作流窗口:LLM 按复杂度动态拆子任务、按依赖并行、看结果重规划、有人审闸口)。\n' +
      '【何时调用 —— 你自己判断,不是规则】当任务满足以下任一,调它比自己一个人做更好:\n' +
      ' · 需要并行探查多个相对独立的来源(如 代码 + 数据库 + 文档),分头更快;\n' +
      ' · 需要多个独立视角互相校验(如 实现方 + 专挑刺的评审方);\n' +
      ' · 步骤多、且后面依赖前面的产出,值得拆成带依赖的任务图。\n' +
      '【何时不要调】简单查询、解释、小改动、闲聊 —— 直接自己答,别拉队(拉队更慢更贵)。\n' +
      '【拿不准】倾向先自己做;真觉得划算再升格。升格后过程对用户可见、可中止、第一份计划要用户批准。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '交给小队的总目标,一句话讲清要达成什么(把你已掌握的关键上下文也写进去,子 Agent 看不到本对话)' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'workflow_result',
    description: '取回某个动态工作流的成果(工作流不是一次性的:成果已存档,随时可取回继续用)。进行中 → 返回状态;完成 → 返回最终成果全文。用户问"刚才那个工作流结果怎样/基于结果继续做 X"时调这个,拿到成果直接接着干活。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '工作流 id(run_workflow 返回过);省略 = 最近一个' } } },
  },
]

async function callTool(name, a) {
  a = a || {}
  if (name === 'run_workflow') {
    const goal = String(a.goal || '').trim()
    if (!goal) return '需要 goal(交给小队的总目标)'
    const r = await relayPost('/orch/run', { goal })
    return '已拉起动态工作流,id=' + (r.id != null ? r.id : '?') + '(窗口已打开:按复杂度拆解 → 并行执行 → 汇总;第一份计划等用户批准)。'
      + '完成后调 workflow_result(id="' + (r.id != null ? r.id : '') + '") 取回成果全文继续用;现在可以先和用户讨论别的。'
  }
  if (name === 'workflow_result') {
    const body = {}
    if (a.id != null && String(a.id).trim()) body.id = String(a.id).trim()
    const r = await relayPost('/orch/result', body)
    if (r.status === 'running') return '工作流 #' + r.id + ' 仍在进行(第 ' + (r.round || '?') + ' 轮):' + r.goal + '\n稍后再调 workflow_result 取成果。'
    return '工作流 #' + r.id + '(' + r.status + ' · ' + (r.rounds || 0) + ' 轮 · ' + Math.round((r.elapsedMs || 0) / 1000) + 's)\n目标:' + r.goal + (r.archive ? '\n存档:' + r.archive : '') + '\n\n' + (r.final || '(无成果)')
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
