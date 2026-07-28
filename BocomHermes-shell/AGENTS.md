# AGENTS.md — BocomHermes 开发指引

> 写给 AI 编码代理的项目说明书（精简版：只留高频必读。机制详解（多层派发/serve 池/上下文口径/提示词纪律/验证闭环）见 `docs/AGENTS-机制细节.md`，改对应机制前必读那份）。
> 读完后你应能直接上手改代码，不需要再问架构问题。

## 项目概览

**BocomHermes**（产品对外名，原代号"天枢"，已全仓库统一命名，无残留）是一个 **Electron 桌面壳**，定位是**公司内网环境下的个人桌面智能体**（单人、自己机器、个人/工作邮箱，不是企业/团队产品）。

核心形态：**一体化桌面主窗口（`ui/shell.html`，侧栏 + 视图区 + 状态栏）+ 快捷输入层**。对话会话以 `<webview>` 内嵌在主窗口对话视图，多会话并行（一张会话卡 = 一个 `opencode serve` 会话）；可从主窗口**钉出单张迷你卡**盯梢单个会话（唯一独立对话窗）。悬浮球（orb）与自由悬浮卡已退役（波5 删除装配），控制台 2.0（console.html）被 shell 取代后同步删除。除此之外还有：内嵌浏览器（多标签 + CDP 控制台/网络面板，独立工作台窗）、浏览器操作录制回放（技能系统）、邮件中心（IMAP/SMTP + 发件箱安全闸门，主窗邮件视图）、待办、需求分析多 Agent 对抗管线、动态工作流编排等。

铁律：**数据不出网**。shell 本身不发任何外网请求（无 analytics / CDN / update check），LLM 流量只走本地 spawn 的 `opencode serve`（其对接内网模型端点）。所有工具一律本地。

## 技术栈

- **运行时**：Electron 34（`package.json` `devDependencies`），主进程是 CommonJS（`.js`，`'use strict'` 开头）；UI 全部是无框架的原生 HTML/JS/CSS（`ui/*.html`，脚本内联在 HTML 里，无构建步骤）。
- **Node**：开发机 Node v20+ 可跑主仓库；`mcp/` 下的 MCP server（ESM `.mjs`）**要求 Node 22+**（需内置全局 WebSocket，用于 CDP 驱动系统 Edge/Chrome）。
- **打包**：electron-builder 25（Windows NSIS + portable，macOS dmg + zip），配置全在 `package.json` 的 `build` 字段。
- **依赖**（运行时）：`pdf-parse`、`mammoth`、`xlsx`（需求文档解析）、`mysql2`（OceanBase MySQL 模式只读连接）、`typescript-language-server`+`typescript@5.x`+`@vue/language-server`+`pyright`（随包自带 LSP，内网无外网装不了——TS/Vue/Python 代码智能全靠它们，用 Electron 内嵌 Node 跑，必须 asarUnpack）。MCP server 与自测脚本**零依赖**（只用 Node 内置模块）。
- **AI 引擎**：不内置模型。主进程 spawn 本机的 `opencode serve`（开发）或 `bocomcode serve`（打包后），通过 HTTP + SSE 通信。引擎命令可被环境变量 `BOCOMHERMES_SERVE_BIN` 或 `settings.json` 的 `serveBin` 覆盖。

## 仓库结构（压缩图，机制职责以各文件头注释为准）

```
BocomHermes-shell/
├── main.js / preload.js / opencode.js   # 主进程入口+装配 / contextBridge 安全桥(全部 IPC API) / serve 连接层(分池 spawn/会话/权限路由/子agent路由)
├── src/
│   ├── window.js      # ⚠ 最大模块：窗口工厂、大部分 IPC、托盘、设置、编排(spawnWorkflow/Orchestrator/shardSettled/验证棒)
│   ├── session.js     # 卡片↔会话 IPC：首发注入/计量/权限(onPermission)/事件路由/转录/看门狗/发送与轮询
│   ├── browser.js / recorder.js / recorder-core.js   # 内嵌浏览器核心 / 录制回放 IPC / 录制纯逻辑
│   ├── mail.js / email.js / outbox.js / mail-cache.js / attachments.js / meeting-extract.js / email-summary-seen.js
│   ├── db.js          # OceanBase(MySQL 模式)只读连接器:只放行单条 SELECT/SHOW/DESCRIBE,强制 LIMIT
│   ├── mcp-config.js / lsp-config.js / plugin-install.js / intranet-optimize.js / agent-md.js
│   │                  # 配置写入四件套(MCP/LSP/插件/内网优化包) + AGENTS.md 生成器
│   ├── knowledge.js / card-cleanup.js / writescope.js / standards.js / audit.js / todos.js / todo-reminder.js / trigger.js / httpcap.js / cdp-format.js
├── ui/                # 原生 HTML 页面：shell.html(主窗口)、card.html(legacy 会话卡,仅 cardImpl:"legacy" 回退)、browser.html、dock.html、mailcenter.html、skills.html、settings.html、glass.css
├── ui-vue/            # Vue3+TS 工作区(shell/chat/lab 三入口;chat=会话卡事实实现),ui/dist/ 是其全内联构建产物(随库入库)
├── mcp/               # 9 个本地 stdio MCP server(ESM,零依赖,asarUnpack)：browser/httpcap/repro/orch/mail/db/doc/git/lsp;README.md 有工具清单
├── scripts/           # 自测与探针脚本(见下"测试")
├── plugin/            # opencode 插件(serve 侧)：read-spill.js、bocomhermes-context-guard.js、edit-guard.js
│                      #   ⚠ 必须 .js/.ts 且单导出;拷到 .opencode/plugin/ 或 ~/.config/opencode/plugin/ 即生效
├── build/             # 图标与 macOS entitlements
└── docs/              # 设计文档(中文)；docs/项目记忆/ 是项目记忆手动同步镜像
```

**主进程架构约定**：`main.js` 创建共享可变状态对象 `S`，各模块导出 `initX(S, deps)` 工厂函数协作（依赖注入，无全局单例 import）；渲染进程一律经 `window.BocomHermes.*` 调主进程（preload 是唯一入口）。**多层派发（主控编排）与 serve 池**：复杂目标走主控卡（预检路由→规划闸→分片(隐藏卡)→索引棒收口，分片 goal 带 `[orch:TAG]` 前缀回流唤醒）；一个项目目录 = 一个独立 serve 进程（4096 起），同项目多卡复用并发会话——**完整机制与健壮性口径见 `docs/AGENTS-机制细节.md`**。

## 上下文口径（MiniMax M2.5 = 192k，所有 Agent 同规）

口径数值 = `knobs.ctxLimitMax`（默认 192000），生效上限 = min(serve 上报 limit.context, 该值)；纪律/规程文本按 `window.js ctxK()` 动态注入，不再写死 128k。四道防线：①纪律注入（首发 `<上下文纪律(Nk)>` + wf 规程加强版）；②硬闸（`knobs.taskPromptMax` 拦"贴原文"委派，精确 abort 不株连）；③看门狗（子会话 80% 预警/挂死中止）+ 读字节计量（单次 >12k 提醒分段、按文件去重累计超 `knobs.readWarnMax`（默认 100k）提醒派子 Agent）+ read-spill 外溢 + edit-guard + 截断续写 + 模型降级路由；④工作流卡 55% 主动交棒（普通卡 knobs.chatHandoffPct 高水位）。**细节见 `docs/AGENTS-机制细节.md`**。

## 常用命令

```bash
npm install            # 装 Electron（国内重装用 ELECTRON_MIRROR 环境变量，见 .npmrc 注释）
npm start              # 开发运行（electron .），需 PATH 里有 opencode 且已配好模型
npm run dist           # Windows：NSIS 安装版 + 便携版 exe
npm run dist:mac       # macOS：dmg + zip（x64/arm64）
```

## 测试

**没有测试框架**。测试 = `scripts/*.mjs` 与 `mcp/*-selftest.mjs` 里的**零依赖自测脚本**：自写 `ok()` 断言、打印 `✓/✗`、进程退出码表成败。改代码后跑对应的自测：

```bash
npm run session:test   # session.js 卡片↔会话层(改动高频区,最全)
npm run card:ui:test   # card.html 主脚本无头自测:vm + DOM 桩真跑
npm run replay:test    # golden transcript 回放 e2e(多层派发/验证棒/分片,scripts/replay/,补新用例用 record.mjs 录再裁剪)
npm run compact:test / mail:test / tool:test / knowledge:test / cleanup:test / scope:test / readspill:test / ctxguard:test / agentmd:test / lsp:test / lspmcp:test
npm run forkcheck      # fork 兼容性探针(T1-T8:插件钩子/experimental 钩子/双模型读图,需真实 serve+模型)
npm run ui:typecheck / ui:test / ui:build   # Vue 侧三件套(vue-tsc 零错误门槛/vitest/全内联构建)
```

另有探针脚本（需真实 serve）：`npm run compat`、`permcheck`、`jsonschema`、`modelroute`。
写新自测沿用同一风格：文件头注释说明"测什么、怎么跑"，纯逻辑模块设计时就要求**可注入依赖、不连真模型**。

## 代码风格约定

- 主进程与 `src/`：CommonJS，文件首行 `'use strict'`；`mcp/` 与 `scripts/`：ESM `.mjs`。
- **注释用中文**（仓库现状如此，设计文档也全中文）；**终端/serve 日志一律英文**（避免 Windows 控制台乱码）。
- 模块文件头惯例有一段中文块注释：说明职责、设计要点、注入哪些依赖、为何这样切分——改动模块时请同步维护这段头注释。
- UI 无构建步骤：HTML 内联脚本直接写，改完重启即可；`card.html`/`browser.html`/`window.js` 都是超大单文件，**改前先定位、最小改动**，不要顺手重构（历史包袱重，自测只覆盖部分）。
- 命名：产品文案/品牌一律用 **BocomHermes**；内部 API 命名空间 `window.BocomHermes` 保持不变。
- 对话会话 = 主窗口对话视图里的内嵌 `<webview>`；只有**钉出的迷你卡**才是独立无边框透明 `BrowserWindow`；内嵌浏览器标签页用 `WebContentsView`。

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
- **LSP 集成（内网无外网）**：`lsp-config.js` 首启把随包三个 node 系 LSP（typescript/vue/pyright）注册进 opencode.jsonc 的 `lsp` 段（Electron 内嵌 Node 跑，三个包在 `build.asarUnpack`）；`settings.lspEnabled=false` 整体关闭；serve spawn 恒设 `OPENCODE_DISABLE_LSP_DOWNLOAD=true`。

## 提示词改动纪律（内网×弱模型专项）

**小步单变量**（一次只改一处、合并成一波进两周观测期）；**每条补丁进台账**（`docs/项目记忆/弱模型行为台账.md`，无效靠观测淘汰）；**长度是一等资源**（新增注入先过秤，清单类常驻必须有硬预算）；写法库（负面指令给颗粒度、禁令附理由、双向纠偏、行动 cue 标题）；注入位置纪律（壳层拼首条 user 消息，serve 纪律走 context-guard 追加 system 数组**尾部**）。完整版见 `docs/AGENTS-机制细节.md`。

## 验证闭环与双模型（改验证相关代码前必读）

- **双模型**：`settings.modelMain`（干活）/ `modelVision`（读图，设置页下拉）；带图消息自动切读图模型；**验证棒整卡跑读图模型**（`spawnWorkflow(goal, forceModel)`）；读图后 context-guard 把历史图片换成结论文字（`BOCOMHERMES_CTX_GUARD_IMG_PURGE=0` 关）。
- **验证闭环**（`window.js shardSettled`）：证据闸标【未验证】→ 自动派【集成验证】分片（`verifyGoalFor` 全量提示词，只读沙箱 writeScope=/tmp）→ VERDICT 机判（无字面量/PASS 无 Command run 块=拒收回派，连 2 次转人工）→ **FAIL 保留同棒复验**（喂复验前**必须复位 `reg.orchNotified`**——实测坑）→ PASS 清账 + 抽查重放（抽只读命令真跑，不符拒收）；FAIL ≤3 轮到顶转人工。完整版见 `docs/AGENTS-机制细节.md`。

## 配置与用户数据

运行期数据都在 Electron `userData` 目录：`settings.json`（theme/projectDir/backendDir/serveBin/editorCmd/recentDirs/proxy/browserArgs/smtp 等）、`history.json`、`BocomHermes.log`（3MB 滚动）、`audit.jsonl`、`memory.md`（个人记忆库，注入会话上下文）、`recordings/`（录制与技能 JSON）、`evidence/`（复现取证）。

全局热键（`main.js`）：`Ctrl+Shift+Space` 唤起主窗口快捷输入层（回车=新会话带首发消息）、`+B` 主窗任务编排视图、`+M` 主窗邮件视图、`+R` 技能中心（录制回放工作台）、`+S` 截图提问、`+V` 剪贴板带入快捷输入层。（原 `+C` 控制台已随 console.html 退役删除。）

## 文档地图

- `README.md`：面向用户的功能说明与运行/打包手册。
- `docs/AGENTS-机制细节.md`：**多层派发/serve 池/上下文口径/提示词纪律/验证闭环双模型的完整机制原文**（根 AGENTS.md 的迁出留存）。
- `mcp/README.md`：9 个 MCP server 的完整工具清单与注册方法。
- `docs/`：设计文档（记忆系统设计、动态工作流设计备忘、需求分析多 Agent 对抗方案、信贷需求到详设方案、技能系统设计、研发功能路线图等）。
- `docs/ui-design/`：桌面主窗口化设计套件（W0-W5 设计稿 `desktop.html` 等）——同时是**全产品样式事实源**（`design.css` 令牌值为准，`ui/glass.css` 从中映射）；重构实施方案见仓库根 `plan.md`。
- `docs/项目记忆/`：Claude Code 项目记忆的版本化镜像（真实来源在仓库外 `~/.claude/.../memory/`，可能短暂不一致）——含产品定位（个人桌面智能体优先于企业合规）、内网模式等关键决策背景。
