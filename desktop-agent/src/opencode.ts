// OpenCode serve 客户端：运行时零依赖，直接打已确认的 REST 端点 + 手写 SSE。
// 端点/事件字段以本机 http://127.0.0.1:4096/doc 的 OpenAPI 为最终准；本文件做了宽松解析以适配版本差异。

import type { Capability, PermissionPolicy, RunContext, RunResult } from "./types.js"

export interface HostOpts {
  baseUrl: string
  username?: string
  password?: string
}

const AUTO_APPROVE = process.env.AGENT_AUTO_APPROVE === "1" // confirm 类工具是否自动放行

function authHeaders(o: HostOpts): Record<string, string> {
  if (!o.password) return {}
  const u = o.username ?? "opencode"
  return { authorization: "Basic " + Buffer.from(`${u}:${o.password}`).toString("base64") }
}

export async function api(method: string, path: string, o: HostOpts, body?: any): Promise<any> {
  const res = await fetch(`${o.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...authHeaders(o) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const txt = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${txt.slice(0, 300)}`)
  return txt ? JSON.parse(txt) : undefined
}

export async function health(o: HostOpts): Promise<boolean> {
  try { await api("GET", "/global/health", o); return true } catch { return false }
}

// ---- 权限策略：每个进行中的会话登记其策略，供全局事件循环查询 ----
const sessionPolicies = new Map<string, PermissionPolicy | undefined>()
export function setPolicy(id: string, p?: PermissionPolicy) { sessionPolicies.set(id, p) }
export function clearPolicy(id: string) { sessionPolicies.delete(id) }

// ---- 权限应答端点自检（不同版本路由不同；未知路由会静默返回 SPA-HTML，故需探测）----
// 新版：POST /permission/:requestID/reply ；旧版：POST /session/:id/permissions/:permissionID
let permStyle: "new" | "old" = "new"
export async function detectPermissionEndpoint(o: HostOpts, log: (m: string) => void) {
  const isRealApi = async (path: string) => {
    try {
      const res = await fetch(`${o.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(o) },
        body: JSON.stringify({ response: "reject" }),
      })
      const txt = await res.text()
      return !txt.includes("<!doctype html>") // 非 HTML（含 400/404）即真实 API
    } catch { return false }
  }
  if (await isRealApi("/permission/__detect__/reply")) permStyle = "new"
  else if (await isRealApi("/session/__detect__/permissions/__detect__")) permStyle = "old"
  log(`权限端点：${permStyle === "new" ? "/permission/:requestID/reply" : "/session/:id/permissions/:permissionID"}`)
}

function decide(tool: string, p?: PermissionPolicy): "once" | "always" | "reject" {
  if (!p) return "reject"
  if (p.deny.includes(tool)) return "reject"
  if (p.autoAllow.includes(tool)) return "once"
  return AUTO_APPROVE ? "once" : "reject" // confirm 类：接入托盘对话框前，安全默认拒绝
}

// ---- 全局事件循环：常驻，解析 SSE /event，自动应答权限请求 ----
export async function runEventLoop(o: HostOpts, log: (m: string) => void): Promise<never> {
  for (;;) {
    try {
      const res = await fetch(`${o.baseUrl}/event`, { headers: authHeaders(o) })
      if (!res.ok || !res.body) throw new Error(`/event ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      log("事件流已连接")
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = chunk.split("\n").filter(l => l.startsWith("data:"))
            .map(l => l.slice(5).trim()).join("\n")
          if (!data) continue
          let ev: any; try { ev = JSON.parse(data) } catch { continue }
          await onEvent(ev, o, log)
        }
      }
    } catch (e) {
      log(`事件流断开，2s 后重连：${(e as Error).message}`)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

async function onEvent(ev: any, o: HostOpts, log: (m: string) => void) {
  const type: string = ev?.type ?? ""
  if (!type.includes("permission")) return       // 仅处理权限事件；其余按需扩展
  if (type.includes("replied") || type.includes("response")) return // 别响应"已回复"事件造成回环
  const p = ev.properties ?? ev.data ?? ev
  const sessionID = p.sessionID ?? p.session_id ?? p.sessionId
  const requestID = p.requestID ?? p.id ?? p.permissionID ?? p.permissionId // 新版用 requestID
  const tool = p.tool ?? p.type ?? p.title ?? p.permission?.type ?? "unknown"
  if (!requestID) return
  const decision = decide(tool, sessionPolicies.get(sessionID))
  log(`权限请求 [${tool}] → ${decision}`)
  const path = permStyle === "new"
    ? `/permission/${requestID}/reply`
    : `/session/${sessionID}/permissions/${requestID}`
  try {
    await api("POST", path, o, { response: decision })
  } catch (e) {
    log(`权限应答失败：${(e as Error).message}`)
  }
}

// ---- 结果解析（宽松，兼容不同响应形状）----
function extractSessionId(s: any): string | undefined {
  return s?.id ?? s?.data?.id ?? s?.info?.id ?? s?.sessionID ?? s?.session?.id
}

function extractResult(msg: any): RunResult {
  const info = msg?.info ?? msg?.data?.info ?? msg
  const parts = msg?.parts ?? msg?.data?.parts ?? info?.parts ?? []
  const text = Array.isArray(parts)
    ? parts.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n").trim()
    : (typeof msg === "string" ? msg : "")
  const structured = info?.structured_output ?? info?.structuredOutput ?? msg?.structured_output
  return { text, structured, raw: msg }
}

// ---- 运行一个能力：建会话 → 登记权限策略 → 发 prompt（同步等结果）→ 落地 ----
export async function runCapability(cap: Capability, ctx: RunContext, o: HostOpts): Promise<RunResult> {
  const session = await api("POST", "/session", o, { title: cap.name })
  const id = extractSessionId(session)
  if (!id) throw new Error("无法解析 session id：" + JSON.stringify(session).slice(0, 200))
  setPolicy(id, cap.permission)
  try {
    const body: any = { parts: cap.buildPrompt(ctx) }
    if (cap.agent) body.agent = cap.agent
    if (cap.model) body.model = cap.model
    if (cap.schema) body.format = { type: "json_schema", schema: cap.schema }
    const msg = await api("POST", `/session/${id}/message`, o, body)
    const result = extractResult(msg)
    await cap.onResult(result, ctx)
    return result
  } finally {
    clearPolicy(id)
  }
}
