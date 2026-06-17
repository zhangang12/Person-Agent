# desktop-agent —— 内网桌面研发智能体（基于 OpenCode serve）

在 `opencode serve` 之上的**可扩展宿主（外壳）**。运行时**零 npm 依赖**（仅用 Node 内置 `fetch`/`http`）。

> 它是 `opencode serve` 的纯外壳：**只连 `http://127.0.0.1:4096`，不碰模型地址 / 模型名 / token**。
> 模型、provider、Agent 全是 OpenCode 自己的事，早就在 OpenCode 里配好了（你生成信贷 Wiki 用的那套）。
> 本工程里没有、也不该有任何模型配置。架构详见上级《桌面智能体架构-基于OpenCodeServe.md》。

```
desktop-agent/
├── src/
│   ├── host.ts            # 入口：监督 serve + 事件循环 + REST + CLI
│   ├── opencode.ts        # OpenCode 客户端（REST + SSE + 权限策略）零依赖
│   ├── server.ts          # 本地 REST（127.0.0.1）供托盘/热键调
│   ├── registry.ts        # 能力注册表
│   ├── types.ts           # Capability 契约（扩展核心）
│   └── capabilities/      # ★ 扩展点：每个文件一个能力
│       ├── review.ts      #   代码评审（只读）
│       ├── locate.ts      #   需求改动点定位（只读+结构化）
│       └── index.ts       #   在此 register 新能力
├── desktop/
│   ├── hotkey.ahk         # 全局热键 → 调 REST（AutoHotkey v2）
│   └── tray.ps1           # 系统托盘 → 调 REST（PowerShell）
└── package.json / tsconfig.json
```

---

## 1. 前置条件
- Node.js ≥ 18（要内置 `fetch`/SSE）。
- **OpenCode 已能接内网模型跑通**——就是你生成信贷 Wiki 用的那套，host 不参与模型配置。

自检（确认 OpenCode 侧 OK 即可）：
```powershell
opencode serve --port 4096 --hostname 127.0.0.1
# 另开一个窗口
curl http://127.0.0.1:4096/provider     # 能看到你的内网模型 = OK
```

## 2. 装宿主依赖（仅开发期工具，运行时零依赖）
```powershell
cd desktop-agent
npm install        # 内网走私服 registry；只装 typescript/tsx/@types/node
```

## 3. 运行
指向目标仓库（OpenCode 在此读 AGENTS.md / docs），然后：
```powershell
$env:AGENT_PROJECT="C:\path\to\信贷系统仓库"
npm start          # 常驻：自动拉起 opencode serve（若未运行）+ 本地 REST(5174)
```
一次性 CLI 模式（最快验证）：
```powershell
$env:AGENT_PROJECT="C:\path\to\信贷系统仓库"
npm run run-cap review                       # 评审当前 diff
npm run run-cap locate "授信审批新增一级总行复核节点"   # 需求定位
```
产出写到 `目标仓库\out\`（review.md / locate.json），同时打印到控制台。

### 完全离线运行（零 npm 依赖）
host 运行时没有任何 npm 依赖，只用 Node 内置能力。在能联网的机器上编译一次，
之后内网机器只要有 Node 就能跑，**不需要 npm install**：
```powershell
npm install; npm run build        # 联网机器：编译出 dist/
# 把 dist/ + package.json 拷到内网机器，直接：
$env:AGENT_PROJECT="C:\path\to\信贷系统仓库"
node dist/host.js                 # 常驻 + REST
node dist/host.js run review      # 一次性
```

## 4. 桌面入口（本地 REST + 托盘/热键）
常驻服务起来后：
- **托盘**：`powershell -ExecutionPolicy Bypass -File desktop\tray.ps1` —— 托盘菜单列出能力，点一下即跑。
- **热键**（装 AutoHotkey v2）：双击 `desktop\hotkey.ahk` —— `Ctrl+Alt+R` 评审；`Ctrl+Alt+L` 把剪贴板当需求做定位。

REST 接口：
```
GET  /health
GET  /capabilities
POST /run/<capId>   body: { "input": "...", "cwd": "...", "selection": "..." }
```

## 5. 扩展一个新能力（这是重点）
在 `src/capabilities/` 新建 `xxx.ts`，实现 `Capability`：
```ts
import type { Capability } from "../types.js"
export const genTest: Capability = {
  id: "gen-test", name: "生成单测", description: "为指定类补 JUnit",
  triggers: [{ kind: "command", name: "gen-test" }],
  // agent 可省略 → 跑在 OpenCode 默认 agent 上；要更强隔离再填某个已配好的 agent 名
  permission: { autoAllow: ["read","grep","glob","list"], confirm: ["write","edit"], deny: ["bash"] },
  buildPrompt: (ctx) => [{ type:"text", text:`为 ${ctx.input} 生成 JUnit+Mock 单测，覆盖 Mapper 动态 SQL 分支。` }],
  onResult: (res, ctx) => { /* 写文件 / 打印 */ },
}
```
然后在 `src/capabilities/index.ts` 里 `register(genTest)`。完。**内核不动。**

## 6. 安全
- 全程绑 `127.0.0.1`，不对外暴露；可设 `OPENCODE_SERVER_PASSWORD` 开 HTTP Basic。
- 权限策略写在每个能力里：`autoAllow` 自动放行、`deny` 直接拒、`confirm` 默认拒绝。
- 想让 `confirm` 类工具自动放行（power user）：设 `AGENT_AUTO_APPROVE=1`（谨慎）。
- 危险命令、写操作默认不放行；接真实客户数据前务必脱敏。

## 7. 已实测（opencode 1.14.40）与注意事项
- 发消息 = `POST /session/:id/message`（`/prompt` 是网页不是 API）。
- 权限应答自动探测新/旧端点：新 `POST /permission/:requestID/reply`、旧 `POST /session/:id/permissions/:permissionID`，
  body `{ response: "once" | "always" | "reject" }`，权限事件名 `permission.asked`。
- `/doc`（OpenAPI）在 1.14.40 不完整，**别当全集**；未知路由会静默返回 SPA-HTML(200) 而非 404。
- 首次联调建议在 `opencode.ts` 的 `onEvent` 里打印一次真实事件，确认 `parts`/`requestID` 字段名；升级 opencode 后复核。

## 环境变量一览（全是 host/serve 的事，无任何模型项）
| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_PROJECT` | 当前目录 | 目标代码仓库路径 |
| `OPENCODE_PORT` | 4096 | opencode serve 端口 |
| `AGENT_REST_PORT` | 5174 | 宿主本地 REST 端口 |
| `OPENCODE_SERVER_PASSWORD` | 空 | 设了则启用 serve 的 HTTP Basic 鉴权 |
| `AGENT_AUTO_APPROVE` | 0 | =1 时 confirm 类工具自动放行 |
