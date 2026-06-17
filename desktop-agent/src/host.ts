import { spawn } from "node:child_process"
import { detectPermissionEndpoint, health, runCapability, runEventLoop, type HostOpts } from "./opencode.js"
import { startRestServer } from "./server.js"
import { loadCapabilities } from "./capabilities/index.js"
import { all, get } from "./registry.js"
import type { RunContext } from "./types.js"

// ---- 配置（环境变量覆盖）----
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096)
const REST_PORT = Number(process.env.AGENT_REST_PORT ?? 5174)
const PROJECT = process.env.AGENT_PROJECT ?? process.cwd() // 目标代码仓库（OpenCode 在此读 AGENTS.md/docs）

const opts: HostOpts = {
  baseUrl: `http://127.0.0.1:${OPENCODE_PORT}`,
  username: process.env.OPENCODE_SERVER_USERNAME,
  password: process.env.OPENCODE_SERVER_PASSWORD,
}
const log = (m: string) => console.log(`[agent] ${m}`)

// ---- 监督 opencode serve：已运行则复用，否则在目标项目目录启动并探活 ----
async function ensureServer() {
  if (await health(opts)) { log("检测到已运行的 opencode serve，复用之"); return }
  log(`在 ${PROJECT} 启动 opencode serve …`)
  const child = spawn("opencode", ["serve", "--port", String(OPENCODE_PORT), "--hostname", "127.0.0.1"], {
    cwd: PROJECT,
    stdio: "inherit",
    shell: process.platform === "win32", // Windows 下 opencode 多为 .cmd，需 shell
  })
  child.on("exit", c => log(`opencode serve 退出 code=${c}`))
  for (let i = 0; i < 60; i++) {
    if (await health(opts)) { log("opencode serve 就绪"); return }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error("opencode serve 启动超时（30s）")
}

async function main() {
  loadCapabilities()
  log(`已加载能力：${all().map(c => c.id).join(", ")}`)

  await ensureServer()
  await detectPermissionEndpoint(opts, log)                              // 探测权限端点（新/旧）
  runEventLoop(opts, log).catch(e => log("事件循环异常：" + e.message)) // 常驻，应答权限

  // 子命令 run：一次性 CLI 模式  ——  tsx src/host.ts run <capId> <input...>
  const [, , sub, capId, ...rest] = process.argv
  if (sub === "run") {
    const cap = get(capId!)
    if (!cap) throw new Error("no such capability: " + capId + "（已加载：" + all().map(c => c.id).join(",") + "）")
    const ctx: RunContext = { cwd: PROJECT, input: rest.join(" "), vars: {} }
    await runCapability(cap, ctx, opts)
    log("完成")
    process.exit(0)
  }

  // 默认：常驻 + 本地 REST（供托盘 / 热键调）
  startRestServer(REST_PORT, opts, PROJECT, log)
  log(`目标项目：${PROJECT}`)
  log("智能体已就绪。托盘/热键可调本地 REST；Ctrl+C 退出。")
}

main().catch(e => { console.error("[agent] 致命错误：", e); process.exit(1) })
