# 桌面智能体架构：基于 OpenCode Serve 的可扩展宿主

> 用途：把《个人桌面智能体设计方案》里的"方案 B（OpenCode 内核 + 桌面壳）"落到可实现的架构。
> 核心思想：`opencode serve` 是一个**无头的大脑 + 工具总线 + 事件流**；你写一个**宿主进程（Host）**驱动它，并暴露一套**能力插件接口**，从而"把 OpenCode 能力发挥到位、且可持续扩展"。
> 本文档中的端点与 SDK 方法名经 opencode.ai 官方文档核对（2026-06），但 OpenCode 迭代较快——**以你本机 `http://127.0.0.1:4096/doc` 的 OpenAPI 规范为最终准**。

---

## 1. OpenCode Serve 暴露了什么（事实基线）

> ✅ 以下已在**本机 opencode 1.14.40** 实测（起服务逐个打端点验证）。注意两点版本坑：
> - `/doc`（OpenAPI）在 1.14.40 **不完整**，只列了 `/auth`、`/log` 两条——**别拿 /doc 当全集**，真实路由以实测为准。
> - **未知路由会静默返回 SPA 的 HTML（200）而非 404**，所以 `POST /session/:id/prompt` 看似 200 实则是网页，不是 API。判断"端点是否存在"要看返回是不是 HTML。

启动：
```bash
opencode serve --port 4096 --hostname 127.0.0.1
# 单机自用：绑 127.0.0.1 即可；可选 OPENCODE_SERVER_PASSWORD 开 HTTP Basic 鉴权
```

| 能力 | 端点 | 说明 |
|---|---|---|
| 健康检查 | `GET /global/health` | 服务状态/版本，用于宿主启动探活 |
| **OpenAPI 规范** | `GET /doc` | OpenAPI 3.1，**自描述全部接口**——以它为准 |
| **事件流（SSE）** | `GET /event`（亦 `/global/event`） | 首事件 `server.connected`；权限请求事件名 `permission.asked`（带 `requestID`/`sessionID`），回复后 `permission.replied` |
| 会话列表/创建 | `GET /session` · `POST /session` | 一个任务 = 一个会话 |
| 会话详情/删除 | `GET /session/:id` · `DELETE /session/:id` | |
| 中止 | `POST /session/:id/abort` | 长任务可打断 |
| 取消息历史 | `GET /session/:id/message` | |
| **发消息（同步等结果）** | `POST /session/:id/message` ✅实测存在 | 主入口；空体回 400，需带 `parts` |
| **应答权限请求（新）** | `POST /permission/:requestID/reply` ✅ | 1.14.40 已有；配 `permission.asked` 事件的 `requestID` |
| 应答权限请求（旧/弃用） | `POST /session/:id/permissions/:permissionID` ✅ | 仍可用，新版已弃用 |
| 应答 body / 取值 | `{ "response": "once" \| "always" \| "reject" }` | once=本次/always=记住/reject=拒绝 |
| 会话 diff | `GET /session/:id/diff` | 拿本次改动 |
| Agent 列表 | `GET /agent` ✅（注意：`/agents` 是网页） | 确认 reviewer/req-locator 已加载 |
| 命令列表 | `GET /command` ✅ | 自定义 /命令清单 |
| 配置读/改 | `GET /config` ✅ · `PATCH /config` | |
| Provider 列表 | `GET /provider` ✅ 返回 `{ all: [...] }` | 确认内网模型已挂上 |
| 项目 | `GET /project` · `GET /project/current` ✅ | |
| 文件检索 | `GET /find?pattern=` · `GET /find/file?query=` ✅ | grep/找文件 |
| 文件状态 | `GET /file/status` ✅ | 跟踪文件 |

官方 SDK `@opencode-ai/sdk`（TS，一等公民）：
```ts
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })

client.session.create({...})          // 建会话
client.session.prompt({ path, body }) // 发提示（支持 format: json_schema 结构化输出）
client.session.command({...})         // 触发 OpenCode 自定义 /命令
client.session.shell({...})           // 跑 shell
client.session.messages({ path })     // 历史
client.session.abort({ path })        // 中止
client.event.subscribe()              // 订阅事件流
client.app.agents()                   // 列出可用 Agent
client.find.text({ query }) / client.file.read({ query })
// 权限应答：postSessionByIdPermissionsByPermissionId({ path, body })
```

> 结构化输出（很关键）：`session.prompt` 的 body 里给 `format: { type: "json_schema", schema }`，模型就会返回**可被程序消费的 JSON**——让"需求定位""评审"这类能力的产出能直接进流水线，而不是一坨文本。

---

## 2. 总体架构：两个扩展平面

可扩展性分布在**两个平面**，别混为一谈：

```
                       ┌──────── 你的可扩展智能体（Host 进程，TS）────────┐
 交互表面              │                                                  │
 hotkey / 托盘 /       │  ① Trigger 层 ──► ② Capability 注册表（插件目录）  │
 右键 / REST / 定时 ─► │                        每个能力 = 一个插件模块     │
                       │                          │                       │
                       │                          ▼                       │
                       │   ③ Orchestrator：建会话→发 prompt→收事件→出结果   │
                       │        │ SDK                       ▲ 事件路由      │
                       │        ▼                           │              │
                       │   ④ Permission 策略（读自动过 / 写排队确认）        │
                       └────────┬───────────────────────────┴─────────────┘
                                │ HTTP  127.0.0.1:4096   (+ /event SSE)
                                ▼
                  ┌──────── opencode serve（无头内核，Plane-1）────────┐
                  │ Agents · Commands · Tools · MCP · Permissions      │
                  │ /session  /event  /config  /find  /file ...        │
                  └────────────────────┬──────────────────────────────┘
                                       │ provider = intranet
                                       ▼
                          内网私有化大模型（OpenAI 兼容）
```

- **Plane-1（OpenCode 内，配置驱动）**：用 OpenCode 原生扩展点——自定义 **Agent / Command / Tool / Plugin / MCP**。改这层不用写宿主代码，放文件/改配置即可。
- **Plane-2（你的 Host 内，代码驱动）**：触发表面、能力插件注册表、编排、权限策略、输入输出适配器。这层是"桌面智能体"的本体。

**口诀**：能在 Plane-1 用配置解决的，就别在 Plane-2 写代码；Plane-2 只做 OpenCode 给不了的——**触发、编排、落地、策略、桌面入口**。

---

## 3. "把 OpenCode 能力发挥到位"＝复用而非重造

| OpenCode 已经提供（直接复用，别自己写） | 你在 Host 里要建（真正的扩展点） |
|---|---|
| 会话生命周期 `/session` | 能力插件注册表（drop-in 加载） |
| 工具调用与执行（read/edit/bash/grep/glob…） | 触发表面（热键/托盘/右键/定时/REST/文件监听） |
| **权限请求事件 + 应答端点** | 权限策略引擎（按能力/工具白名单自动决策） |
| Agents / Commands / Tools / MCP（配置驱动） | 输入/输出适配器（取编辑器选区→喂；结果→写文件/发 GitLab/Jira） |
| **实时事件流** `/event`（消息/工具/权限） | 事件路由 + 任务↔会话映射 |
| 文件检索 `/find`、读 `/file`、会话 `diff` | 多能力编排/串联（pipeline，如 定位→改→补测→评审） |
| **结构化输出** `format: json_schema` | 各能力的结果 schema（让产出可被程序消费） |
| Provider 抽象（已指向内网模型） | 模型路由策略（小任务用小模型、长上下文切大窗口） |

---

## 4. 扩展的核心：Capability（能力插件）契约

一个"能力"＝一个插件模块。新增一种研发工作流 = 往 `capabilities/` 丢一个文件，**不动内核**。

```ts
// capability.ts — 能力契约
export interface Capability {
  id: string                       // "review" | "locate" | "gen-test" ...
  name: string
  description: string
  triggers: Trigger[]              // 如何被唤起（可多种）
  agent?: string                   // 用哪个 OpenCode Agent（Plane-1 定义）
  model?: string                   // 可覆盖模型
  permission?: PermissionPolicy    // 该能力的权限策略
  schema?: JSONSchema              // 需要结构化产出时提供
  buildPrompt(ctx: RunContext): PromptParts          // 组装提示
  onResult(res: RunResult, ctx: RunContext): Promise<void> | void  // 落地结果
}

export type Trigger =
  | { kind: "command";  name: string }                 // CLI/REST: run <name>
  | { kind: "hotkey";   combo: string }                // 全局热键
  | { kind: "fileWatch"; glob: string }                // 文件变更触发
  | { kind: "schedule"; cron: string }                 // 定时（夜间批跑）
  | { kind: "event";    match: (e: OpencodeEvent) => boolean } // 监听 OpenCode 事件

export interface RunContext {
  cwd: string                      // 当前项目根
  input?: string                   // 用户输入/选区/工单内容
  selection?: string               // 编辑器选区
  vars: Record<string, string>     // 触发时携带的变量
}

export interface PermissionPolicy {
  autoAllow: string[]              // 自动放行的工具（如 read/grep/glob/list）
  confirm:   string[]              // 必须人工确认（如 edit/write/bash）
  deny:      string[]              // 直接拒绝（如 rm/drop/format）
}
```

两个示例能力：

```ts
// capabilities/locate.ts —— 需求 → 改动点定位（只读 + 结构化输出）
export const locate: Capability = {
  id: "locate", name: "需求改动点定位",
  description: "按 glossary→capability-map→modules 链路定位改哪",
  triggers: [{ kind: "command", name: "locate" }],
  agent: "req-locator",
  permission: { autoAllow: ["read","grep","glob","list"], confirm: [], deny: ["edit","write","bash"] },
  schema: {                        // 让产出可进流水线
    type: "object",
    properties: {
      files:   { type: "array", items: { type: "string" } },
      tables:  { type: "array", items: { type: "string" } },
      apis:    { type: "array", items: { type: "string" } },
      regress: { type: "array", items: { type: "string" } },
    },
  },
  buildPrompt: (ctx) => [{ type:"text", text:
    `需求：${ctx.input}\n按仓库 docs/glossary.md→capability-map.md→modules 链路，` +
    `给出改动文件/类、涉及表、受影响接口、需回归项。结论必须带 文件:行 出处。` }],
  onResult: (res) => { /* 写出改动点清单 .md / 推给 Jira 工单评论 */ },
}

// capabilities/review.ts —— 当前 diff 评审（只读）
export const review: Capability = {
  id: "review", name: "代码评审",
  description: "评审当前改动：正确性/空指针/SQL注入/事务/金额单位",
  triggers: [{ kind: "command", name: "review" }, { kind: "hotkey", combo: "Ctrl+Alt+R" }],
  agent: "reviewer",
  permission: { autoAllow: ["read","grep","glob","list"], confirm: [], deny: ["edit","write","bash"] },
  buildPrompt: () => [{ type:"text", text:
    `评审当前 git diff，按"必改/建议/可忽略"三档输出，重点查：空指针、` +
    `MyBatis \${} 注入、事务边界、金额单位(分/元)。每条带 文件:行。` }],
  onResult: (res) => { /* 打印 / 写 review.md / 作为 PR 评论 */ },
}
```

---

## 5. 宿主参考骨架（最小可跑）

```ts
// host.ts —— 智能体宿主：监督 serve + 连接 + 事件路由 + 能力调度
import { createOpencodeClient } from "@opencode-ai/sdk"
import { spawn } from "node:child_process"

const BASE = "http://127.0.0.1:4096"

// ① 监督 opencode serve（探活+重连）
async function ensureServer() {
  spawn("opencode", ["serve", "--port", "4096", "--hostname", "127.0.0.1"],
        { stdio: "inherit" })
  const client = createOpencodeClient({ baseUrl: BASE })
  for (let i = 0; i < 30; i++) {
    try { await client.global.health(); return client } catch { await sleep(500) }
  }
  throw new Error("opencode serve 未就绪")
}

// ② 能力注册表（从 capabilities/ 目录加载 → drop-in 扩展）
const registry = new Map<string, Capability>()
function register(c: Capability) { registry.set(c.id, c) }

// ③ 运行一个能力
async function runCapability(client, cap: Capability, ctx: RunContext) {
  const { data: session } = await client.session.create({ body: { title: cap.name } })

  // 订阅事件：处理权限请求 + 收集结果（按能力策略自动决策）
  const stream = await client.event.subscribe()
  const pending = handleEvents(client, stream, session.id, cap.permission)

  const body: any = { parts: cap.buildPrompt(ctx) }
  if (cap.agent)  body.agent = cap.agent
  if (cap.model)  body.model = cap.model
  if (cap.schema) body.format = { type: "json_schema", schema: cap.schema }

  const res = await client.session.prompt({ path: { id: session.id }, body })
  await pending
  await cap.onResult(res.data, ctx)
  return res.data
}

// ④ 事件路由 + 权限策略（autoAllow 自动过，confirm 问用户，deny 拒）
async function handleEvents(client, stream, sessionId, policy?: PermissionPolicy) {
  for await (const ev of stream) {
    if (ev.type === "permission.updated" && ev.properties?.sessionID === sessionId) {
      const tool = ev.properties.tool ?? ev.properties.title
      const decision =
        policy?.deny?.includes(tool)     ? "reject"
      : policy?.autoAllow?.includes(tool) ? "once"
      : await askUser(tool) ? "always" : "reject"   // 托盘/CLI 弹确认
      await client.postSessionByIdPermissionsByPermissionId({
        path: { id: sessionId, permissionID: ev.properties.id },
        body: { response: decision },
      })
    }
    if (ev.type === "session.idle" && ev.properties?.sessionID === sessionId) return
  }
}

// ⑤ 触发表面：CLI / REST / 热键 / 定时 都最终落到 runCapability
async function main() {
  const client = await ensureServer()
  register(locate); register(review) // …更多能力
  // 例：命令行触发  node host.js review
  const id = process.argv[2], input = process.argv.slice(3).join(" ")
  const cap = registry.get(id); if (!cap) throw new Error("no such capability")
  await runCapability(client, cap, { cwd: process.cwd(), input, vars: {} })
}
main()
```

> 注：`permission.updated` / `session.idle` 等事件名与权限 body 字段，**以 `/doc` 和你本机 SDK 版本为准**——上面是结构示意，落地前用 `client.event.subscribe()` 打印真实事件结构对齐一次即可。

---

## 6. 触发表面（桌面入口怎么接）

所有入口最终都调 `runCapability`，互不耦合：

| 表面 | 实现思路（Windows） | 用途 |
|---|---|---|
| CLI | `node host.js <capId> <input>` | 最快验证、脚本化 |
| REST | Host 内起个本地 HTTP（仅 127.0.0.1） | 给其它内网工具/IDE 插件调 |
| 全局热键 | 托盘程序注册热键 → 调 REST | 选中代码按 `Ctrl+Alt+R` 评审 |
| 系统托盘 | 托盘菜单列能力 → 点一下跑 | 日常主入口 |
| 右键菜单 | 资源管理器注册"问问 AI" | 对文件/目录直接发起 |
| 定时 | Windows 计划任务 → 调 CLI/REST | 夜间批跑 Wiki 刷新 |
| 文件监听 | Host 内 watch glob | 改了 Mapper 自动补注释（谨慎用） |

> 桌面壳保持"薄"：托盘 + 热键 + 一个小窗显示结果，**真正的活全在 Host + OpenCode**。

---

## 7. 进程与部署模型（单机自用）

```
[Windows 开机自启]
   └─ Host 进程（Node）
        ├─ 子进程: opencode serve  (127.0.0.1:4096, 仅本地)
        ├─ 本地 REST (127.0.0.1:xxxx)  ← 托盘/热键/IDE 调
        └─ 托盘 UI
```
- **一个 serve 实例**服务多会话；Host 负责探活、崩溃重启、端口管理。
- 全程绑 `127.0.0.1`，不对外暴露；如需更稳可加 `OPENCODE_SERVER_PASSWORD`。
- OpenCode、Node、SDK 全部走内网私服离线安装（见主方案 §3.3）。

---

## 8. 扩展演进路线

| 步骤 | 做什么 | 验收 |
|---|---|---|
| S0 | `opencode serve` 起来，`/global/health` 通，`/provider` 能看到内网模型 | 内核就绪 |
| S1 | 写 `ensureServer + runCapability`，跑通 1 个只读能力（review） | 端到端打通 |
| S2 | 把事件流 + 权限策略接好（autoAllow/confirm/deny） | 安全可控 |
| S3 | 抽出 Capability 契约 + 注册表，能力做成插件目录 | **可扩展成立** |
| S4 | 接触发表面：CLI→REST→托盘热键 | 桌面化 |
| S5 | 用 `format: json_schema` 把 locate/review 结构化，串成 pipeline（定位→改→补测→评审） | 编排能力 |
| S6 | 接内网 GitLab/Jira（MCP 或适配器）做输入输出闭环 | 融入研发流 |

---

## 9. 关键设计原则

1. **薄宿主、厚内核**：能让 OpenCode 干的别自己写；Host 只做触发/编排/落地/策略/入口。
2. **能力即插件**：所有研发动作抽象成 `Capability`，drop-in 扩展，核心稳定不动。
3. **结构化优先**：凡结果要进流水线的能力，一律 `json_schema` 输出，别处理散文。
4. **权限策略化**：只读自动放行、写/执行排队确认、危险命令黑名单——策略写在能力里，集中可审。
5. **以 `/doc` 为准**：端点/事件/字段以本机 OpenAPI 为最终事实，别迷信文档记忆。
6. **复用 Wiki 记忆**：能力的 prompt 一律引用 glossary/capability-map/modules，把前期文档投入变现。
```
