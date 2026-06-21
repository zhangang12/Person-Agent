// BocomHermes · Git 工具 MCP（本地 stdio 服务，零依赖）
// 给 opencode/bocomcode 的 agent 提供 git 感知能力：
//   git_status / git_log / git_diff / git_blame / git_show / git_branch
// 实现：spawnSync 调系统 git，不依赖任何第三方库。
// CWD 取 process.cwd()（serve 以项目目录启动），可用 BOCOMHERMES_GIT_CWD 覆盖。
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const log = (...a) => process.stderr.write('[git-mcp] ' + a.join(' ') + '\n')
const cwd = () => process.env.BOCOMHERMES_GIT_CWD || process.cwd()

// 执行 git 命令，返回 stdout 字符串；失败抛错（含 stderr）
function git(args) {
  const r = spawnSync('git', args, {
    cwd: cwd(), encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,  // 10 MB
    windowsHide: true,
  })
  if (r.error) throw new Error('git 不可用：' + r.error.message)
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'git exited ' + r.status)
  return (r.stdout || '').trimEnd()
}

// 超长输出截断，避免撑爆上下文
const clip = (s, max = 12000) => s.length > max ? s.slice(0, max) + `\n\n…（已截断，共 ${s.length} 字符）` : s

// ---------- 工具实现 ----------

function gitStatus() {
  // 短状态 + 完整状态
  const short = git(['status', '--short'])
  const full = git(['status'])
  return `# git status --short\n${short || '（工作区干净）'}\n\n# git status\n${full}`
}

function gitLog(args) {
  const n = Math.min(Math.max(1, parseInt(args.n) || 20), 100)
  const cmd = ['log', '--oneline', '--graph', '--decorate', '-n', String(n)]
  if (args.author) cmd.push('--author=' + args.author)
  if (args.since) cmd.push('--since=' + args.since)
  if (args.file) cmd.push('--', args.file)
  return clip(git(cmd) || '（无提交记录）')
}

function gitDiff(args) {
  const cmd = ['diff']
  if (args.staged) cmd.push('--cached')
  if (args.ref) cmd.push(String(args.ref))
  if (args.file) cmd.push('--', String(args.file))
  const out = git(cmd)
  return clip(out || '（无差异）')
}

function gitBlame(args) {
  if (!args.file) throw new Error('必须提供 file 参数')
  const cmd = ['blame', '--date=short']
  if (args.from_line && args.to_line) cmd.push('-L', `${args.from_line},${args.to_line}`)
  else if (args.from_line) cmd.push('-L', `${args.from_line},+40`)
  cmd.push('--', String(args.file))
  return clip(git(cmd))
}

function gitShow(args) {
  const ref = String(args.ref || 'HEAD')
  const cmd = ['show', ref, '--stat', '--patch']
  if (args.file) cmd.push('--', String(args.file))
  return clip(git(cmd))
}

function gitBranch(args) {
  const cmd = ['branch', '-vv']
  if (args.all) cmd.push('-a')
  return git(cmd) || '（无分支）'
}

// ---------- 工具表 ----------
const TOOLS = [
  {
    name: 'git_status',
    description: '查看当前工作区状态（已修改/暂存/未追踪的文件）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_log',
    description: '查看提交历史（oneline + graph 格式）',
    inputSchema: {
      type: 'object',
      properties: {
        n:      { type: 'number', description: '显示条数，默认 20，最多 100' },
        file:   { type: 'string', description: '只看这个文件的提交历史（可选）' },
        author: { type: 'string', description: '按作者过滤（可选，支持模糊匹配）' },
        since:  { type: 'string', description: '起始时间，如 "2 weeks ago"、"2024-01-01"（可选）' },
      },
    },
  },
  {
    name: 'git_diff',
    description: '查看文件差异（默认=未暂存；staged=已暂存；ref=与某个提交的差异）',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: '查看已暂存（git diff --cached）' },
        ref:    { type: 'string',  description: '对比的 ref，如 HEAD~1、main（可选）' },
        file:   { type: 'string',  description: '只看某个文件（可选）' },
      },
    },
  },
  {
    name: 'git_blame',
    description: '查看文件每行最后是谁/哪次提交修改的',
    inputSchema: {
      type: 'object',
      required: ['file'],
      properties: {
        file:      { type: 'string', description: '文件路径（相对项目根）' },
        from_line: { type: 'number', description: '起始行（可选，不填=全文件）' },
        to_line:   { type: 'number', description: '结束行（可选）' },
      },
    },
  },
  {
    name: 'git_show',
    description: '查看某次提交的详情（diff + stat），默认显示 HEAD',
    inputSchema: {
      type: 'object',
      properties: {
        ref:  { type: 'string', description: '提交 hash 或 HEAD~N（默认 HEAD）' },
        file: { type: 'string', description: '只看该提交中某文件的变化（可选）' },
      },
    },
  },
  {
    name: 'git_branch',
    description: '列出分支（含追踪状态）',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '是否显示远程分支（默认只本地）' },
      },
    },
  },
]

async function callTool(name, args) {
  args = args || {}
  switch (name) {
    case 'git_status':  return gitStatus()
    case 'git_log':     return gitLog(args)
    case 'git_diff':    return gitDiff(args)
    case 'git_blame':   return gitBlame(args)
    case 'git_show':    return gitShow(args)
    case 'git_branch':  return gitBranch(args)
    default: throw new Error('未知工具：' + name)
  }
}

// ---------- MCP stdio 协议（行分隔 JSON-RPC 2.0）----------
const PROTO = '2024-11-05'
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const fail  = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize')
    return reply(id, { protocolVersion: (params && params.protocolVersion) || PROTO, capabilities: { tools: {} }, serverInfo: { name: 'BocomHermes-git', version: '1.0.0' } })
  if (method === 'notifications/initialized' || method === 'initialized' || method === 'ping')
    return id != null ? reply(id, {}) : undefined
  if (method === 'tools/list')
    return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const nm = params && params.name
    try {
      const text = await callTool(nm, params && params.arguments)
      return reply(id, { content: [{ type: 'text', text: String(text) }] })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: '工具出错：' + (e && e.message || e) }], isError: true })
    }
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
process.stdin.on('end', () => process.exit(0))
log('ready, cwd=' + cwd())
