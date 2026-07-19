# AGENTS.md — BocomHermes 开发指引

> 写给 AI 编码代理的项目说明书。读完后你应能直接上手改代码，不需要再问架构问题。

## 项目概览

**BocomHermes**（产品对外名，原代号"天枢"，已全仓库统一命名，无残留）是一个 **Electron 桌面壳**，定位是**公司内网环境下的个人桌面智能体**（单人、自己机器、个人/工作邮箱，不是企业/团队产品）。

核心形态：**可拖动的透明玻璃卡片 + 全局输入框**。一张对话卡 = 一个独立的 `opencode serve` 会话，多卡并行。除此之外还有：悬浮球（orb）、内嵌浏览器（多标签 + CDP 控制台/网络面板）、浏览器操作录制回放（技能系统）、邮件中心（IMAP/SMTP + 发件箱安全闸门）、待办、需求分析多 Agent 对抗管线、动态工作流编排等。

铁律：**数据不出网**。shell 本身不发任何外网请求（无 analytics / CDN / update check），LLM 流量只走本地 spawn 的 `opencode serve`（其对接内网模型端点）。所有工具一律本地。

## 技术栈

- **运行时**：Electron 34（`package.json` `devDependencies`），主进程是 CommonJS（`.js`，`'use strict'` 开头）；UI 是无框架的原生 HTML/JS/CSS（`ui/*.html`，脚本内联在 HTML 里）。
- **Node**：开发机 Node v20+ 可跑主仓库；`mcp/` 下的 MCP server（ESM `.mjs`）**要求 Node 22+**（需内置全局 WebSocket，用于 CDP 驱动系统 Edge/Chrome）。
- **打包**：electron-builder 25（Windows NSIS + portable，macOS dmg + zip），配置全在 `package.json` 的 `build` 字段。
- **依赖**（仅 4 个运行时依赖）：`pdf-parse`、`mammoth`、`xlsx`（需求文档解析）、`mysql2`（OceanBase MySQL 模式只读连接）。MCP server 与自测脚本**零依赖**（只用 Node 内置模块）。
- **AI 引擎**：不内置模型。主进程 spawn 本机的 `opencode serve`（开发）或 `bocomcode serve`（打包后），通过 HTTP + SSE 通信。引擎命令可被环境变量 `BOCOMHERMES_SERVE_BIN` 或 `settings.json` 的 `serveBin` 覆盖。

## 仓库结构

```
BocomHermes-shell/
├── main.js            # 主进程入口：app 生命周期、全局热键、内网三件套(证书/NTLM/代理)、
│                      #   下载登记、装配各 init 模块。日志同时写 userData/BocomHermes.log
├── preload.js         # contextBridge 安全桥，暴露 window.BocomHermes.*（全部 IPC API 在此，约 230 行）
├── opencode.js        # serve 连接层：按项目目录分池 spawn serve、会话/消息/中止/SSE 事件流、
│                      #   权限审批路由、子 agent 会话(parentID)路由回父卡片
├── align.js           # 需求分析·对齐引擎（话题聚簇，纯逻辑可单测）
├── reqanalysis.js     # 需求分析管线（5 个对抗读者 persona → 对齐 → 三类清单，纯逻辑）
├── reqplan.js         # 出详设管线（需求点 → grep 定位代码切片 → 详设卡，纯逻辑）
├── src/
│   ├── window.js      # ⚠ 最大模块(~178KB)：所有窗口工厂(orb/卡片/工作台/技能中心/邮件中心…)、
│   │                  #   大部分 IPC 处理器、托盘、设置、历史、快照提问等
│   ├── session.js     # 卡片↔opencode 会话 IPC、个人记忆库(memory.md)、成果抽屉读文件(路径围栏)、项目上下文注入
│   ├── browser.js     # 内嵌浏览器核心(initBrowser 工厂)：多标签/WebContentsView/CDP 控制台与网络面板/截图/元素拾取
│   ├── recorder.js    # 录制回放 IPC 层(initRecorder 工厂)
│   ├── recorder-core.js # 录制回放纯逻辑：注入页面的 RECORDER_JS、选择器、技能升级、报告等(无闭包依赖)
│   ├── mail.js        # 邮件子系统(initMail 工厂)：收发/发件箱闸门/IMAP IDLE/本地中继
│   ├── email.js       # IMAP/SMTP 协议实现(零依赖)
│   ├── attachments.js / mail-cache.js / email-summary-seen.js / outbox.js / meeting-extract.js
│   ├── db.js          # OceanBase(MySQL 模式)只读连接器：只放行单条 SELECT/SHOW/DESCRIBE，强制 LIMIT
│   ├── mcp-config.js  # 把 8 个自带 MCP server 一键注册进 opencode.json(备份+深合并)
│   ├── audit.js       # 审计流水：userData/audit.jsonl，append-only，启动时裁剪到 5000 行
│   ├── httpcap.js     # HTTP 正向代理抓包(仅 HTTP)
│   ├── todos.js / todo-reminder.js / trigger.js / reqanalysis-ipc.js / extract-json.js / cdp-format.js
│   ├── knowledge.js   # 项目级知识库(任务尾蒸馏落点,纯逻辑可单测):slug/条目追加去重/注入裁剪
├── ui/                # 全部窗口页面（原生 HTML，脚本内联）：card.html(对话卡,~117KB)、browser.html(~115KB)、
│                      #   orb.html/orb-input.html(悬浮球)、dock.html(卡坞)、mailcenter.html、skills.html、
│                      #   settings.html、glass.css(双主题设计令牌,html[data-theme] 驱动)等
├── mcp/               # 8 个本地 stdio MCP server(ESM,零依赖,打包时 asarUnpack)：
│                      #   browser-mcp(浏览器自动化+技能回放)、httpcap-mcp、repro-mcp(复现取证)、
│                      #   orch-mcp(动态工作流编排)、mail-mcp、db-mcp、doc-mcp、git-mcp；
│                      #   print-config.mjs 打印注册块；README.md 有完整工具清单
├── scripts/           # 自测与探针脚本(见下"测试")
├── build/             # 图标与 macOS entitlements
├── docs/              # 设计文档(中文)；docs/项目记忆/ 是 Claude Code 项目记忆的手动同步镜像
└── assets/tray.png    # 托盘图标
```

**主进程架构约定**：`main.js` 创建共享可变状态对象 `S`（settings/history/窗口引用/会话映射等），各模块导出 `initX(S, deps)` 工厂函数，通过同一个 `S` 引用和显式注入的 deps 协作（依赖注入，无全局单例 import）。`preload.js` 是唯一渲染进程入口 API，渲染进程一律经 `window.BocomHermes.*` 调主进程。

**serve 池架构**（`opencode.js`）：一个项目目录 = 一个独立 serve 进程（端口从 4096 起自动找空闲），因为此版 opencode 的 `POST /session` 不支持会话级目录。同项目多卡复用同一 serve 的并发会话；每个 serve 一条 `/event` SSE。只读工具(read/grep/glob/list/ls/find/tree)自动放行，写/执行转卡片内联确认（允许一次/总是/拒绝）。逐 token 流式靠 SSE `message.part`，POST 结果作权威兜底。

## 常用命令

```bash
npm install            # 装 Electron（国内重装用 ELECTRON_MIRROR 环境变量，见 .npmrc 注释）
npm start              # 开发运行（electron .），需 PATH 里有 opencode 且已配好模型

# 打包（产物在 dist/）
npm run dist           # Windows：NSIS 安装版 + 便携版 exe
npm run dist:mac       # macOS：dmg + zip（x64/arm64）
```

## 测试

**没有测试框架**（无 jest/mocha/vitest）。测试 = `scripts/*.mjs` 与 `mcp/*-selftest.mjs` 里的**零依赖自测脚本**：自写 `ok()` 断言、打印 `✓/✗`、进程退出码表成败。改代码后跑对应的自测：

```bash
npm run align:test     # 对齐引擎(align.js)：假裁判函数，不连模型
npm run req:test       # 需求分析管线(reqanalysis.js)：注入假 run/ground
npm run plan:test      # 出详设管线(reqplan.js)
npm run mail:test      # 邮件解析
npm run tool:test      # 工具 part 解析
npm run compact:test   # 录制事件压缩
npm run card:ui:test   # card.html 主脚本无头自测：vm + DOM 桩真跑（抓 TDZ/esc 类运行时雷）
npm run knowledge:test # 项目知识库(knowledge.js)：slug 稳定/追加去重/注入裁剪
npm run mcp:browser:test   # 浏览器 MCP 端到端(需本机 Edge/Chrome)
npm run mcp:httpcap:test   # 抓包代理端到端
npm run mcp:repro:test     # 复现取证 MCP
npm run repro:e2e          # Electron 内嵌浏览器录制回放 e2e（electron scripts/e2e-repro-test.mjs）
npm run bars:e2e           # card.html 真 Chromium 渲染 e2e：重放工作流卡事件流抓"细条"类布局回归（截图 /tmp/bars-e2e.png）
```

另有一批**探针脚本**（需要真实运行中的 serve，不是离线自测）：`npm run compat`（serve API 兼容自检，对内网 bocomcode / 公网 opencode 各跑一遍对比）、`permcheck`、`jsonschema`、`modelroute`。

写新自测时沿用同一风格：文件头注释说明"测什么、怎么跑"，纯逻辑模块（如 align.js/reqanalysis.js/reqplan.js/recorder-core.js）设计时就要求**可注入依赖、不连真模型**。

## 代码风格约定

- 主进程与 `src/`：CommonJS，文件首行 `'use strict'`；`mcp/` 与 `scripts/`：ESM `.mjs`。
- **注释用中文**（仓库现状如此，设计文档也全中文）；**终端/serve 日志一律英文**（避免 Windows 控制台乱码，`opencode.js` 有明确注释）。
- 模块文件头惯例有一段中文块注释：说明职责、设计要点、注入哪些依赖、为何这样切分——改动模块时请同步维护这段头注释。
- UI 无构建步骤：HTML 内联脚本直接写，改完重启即可；`card.html`/`browser.html`/`window.js` 都是超大单文件，**改前先定位、最小改动**，不要顺手重构（历史包袱重，自测只覆盖部分）。
- 命名：产品文案/品牌一律用 **BocomHermes**；内部 API 命名空间 `window.BocomHermes` 保持不变。
- 每卡 = 一个独立无边框透明 `BrowserWindow`；内嵌浏览器标签页用 `WebContentsView`。

## 安全与内网约束（改代码时必须守住）

- **数据不出网**：不加任何外网请求/上报/CDN；MCP 与中继只绑 `127.0.0.1`（`mail-relay.json` 本地中继带 token）。
- 渲染进程 IPC 暴露面全部走 `preload.js` 白名单，新增能力时在 preload 里加窄接口，不开泛化通道。
- `read-file-text` 有路径围栏：只放行项目目录/后端目录/userData 之内、≤512KB，realpath + `path.relative` 防逃逸——不要放宽。
- `db.js` 只读铁律：只放行单条 SELECT/SHOW/DESCRIBE，写关键词直接拒，强制 LIMIT。
- 录制系统**密码框不存明文**（录制即脱敏）；邮箱密码用 Electron `safeStorage` 加密落盘。
- 发件箱是**发信安全闸门**：默认延迟 15s 可软撤回，真发信是高风险操作。
- 审计流水 `audit.jsonl` 只 append，敏感字段（密码/token/cookie）由调用方负责不传入。
- 内网妥协项（有意的，别当 bug 修）：`certificate-error` 全放行自签名证书、NTLM 自动传 Windows 凭据、内嵌浏览器 `webSecurity:false` 解决跨域。
- `main.js` 会**过滤 `--user-data-dir`** 浏览器启动参数（会搬走应用数据），不要在 `browserArgs` 里支持它。

## 配置与用户数据

运行期数据都在 Electron `userData` 目录：`settings.json`（theme/projectDir/backendDir/serveBin/editorCmd/recentDirs/proxy/browserArgs/smtp 等）、`history.json`、`BocomHermes.log`（3MB 滚动）、`audit.jsonl`、`memory.md`（个人记忆库，注入会话上下文）、`recordings/`（录制与技能 JSON）、`evidence/`（复现取证）。

全局热键（`main.js`）：`Ctrl+Shift+Space` 唤起输入框、`+B` 工作台、`+R` 技能中心、`+M` 邮件中心、`+S` 截图提问、`+V` 剪贴板带入输入框。

## 文档地图

- `README.md`：面向用户的功能说明与运行/打包手册。
- `mcp/README.md`：8 个 MCP server 的完整工具清单与注册方法。
- `docs/`：设计文档（需求分析多 Agent 对抗方案、信贷需求到详设方案、技能系统设计、研发功能路线图等）。
- `docs/项目记忆/`：Claude Code 项目记忆的版本化镜像（真实来源在仓库外 `~/.claude/.../memory/`，可能短暂不一致）——含产品定位（个人桌面智能体优先于企业合规）、内网模式等关键决策背景。
