import { createServer, type IncomingMessage } from "node:http"
import { all, get } from "./registry.js"
import { runCapability, type HostOpts } from "./opencode.js"
import type { RunContext } from "./types.js"

// 本地 REST：仅监听 127.0.0.1，供托盘 / 全局热键 / IDE 调用
export function startRestServer(port: number, o: HostOpts, defaultCwd: string, log: (m: string) => void) {
  const server = createServer(async (req, res) => {
    const send = (code: number, obj: any) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(obj))
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true })
      if (req.method === "GET" && url.pathname === "/capabilities")
        return send(200, all().map(c => ({ id: c.id, name: c.name, description: c.description })))

      const m = url.pathname.match(/^\/run\/([\w-]+)$/)
      if (req.method === "POST" && m) {
        const cap = get(m[1]!)
        if (!cap) return send(404, { error: "no such capability: " + m[1] })
        const body = await readJson(req)
        const ctx: RunContext = {
          cwd: body.cwd || defaultCwd,
          input: body.input,
          selection: body.selection,
          vars: body.vars ?? {},
        }
        log(`运行能力 ${cap.id}` + (ctx.input ? `（input: ${ctx.input.slice(0, 40)}…）` : ""))
        const result = await runCapability(cap, ctx, o)
        return send(200, { id: cap.id, text: result.text, structured: result.structured })
      }
      send(404, { error: "not found" })
    } catch (e) {
      send(500, { error: (e as Error).message })
    }
  })
  server.listen(port, "127.0.0.1", () => log(`REST 监听 http://127.0.0.1:${port}`))
  return server
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", c => (data += c))
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on("error", reject)
  })
}
