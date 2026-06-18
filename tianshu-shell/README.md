# 个人桌面智能体（桌面壳 · Electron）

> 应用名「个人桌面智能体」；代码目录沿用 `BocomHermes-shell`，内部 API 命名空间 `window.BocomHermes` 不变。

可在真实桌面上**自由拖动的透明玻璃卡片** + **全局输入框**。一句话开一张卡，多卡并行。
选 Electron 而非 Tauri：**不需要 Rust、不需要 VS Build Tools 的 C++ 工具链**——Electron 是预编译二进制，`npm install` 即可，零原生编译。

```
BocomHermes-shell/
├── main.js          # 主进程：建窗、全局热键、主题/项目、卡片↔会话 IPC
├── opencode.js      # 连 opencode serve：建会话/发消息/中止/事件流/权限
├── preload.js       # 安全桥：window.BocomHermes.*
├── ui/
│   ├── glass.css    # 双主题设计令牌 + 玻璃材质 + 组件样式
│   ├── input.html   # 全局输入框（启动器）+ 主题/项目切换
│   └── card.html    # 对话卡（一张卡 = 一个 opencode 会话）
└── package.json
```

## 前置条件
- **Node.js**（你已是 v24）。Electron 内置 Chromium，**不需要** Rust / MSVC。
- **serve 已装且配好一个模型**——卡片会真的去调它。本壳自动拉起 serve（按项目分端口，从 4096 起），只连本地、不碰模型配置。
- **serve 命令可配**：开发环境默认 `opencode serve`，打包成 exe 后默认 `bocomcode serve`（由 `app.isPackaged` 自动区分）。
  也可手动覆盖：环境变量 `BOCOMHERMES_SERVE_BIN=bocomcode`，或 `userData/settings.json` 里 `"serveBin": "bocomcode"`。

## 运行
```powershell
cd BocomHermes-shell
npm install        # 下载 Electron 预编译二进制（已配国内镜像，见下）
npm start          # 启动
```

> 国内/内网装 Electron：二进制默认从 GitHub 下，常卡住报 `Electron failed to install correctly`。
> 重装时用**环境变量**走 npmmirror 镜像（别写进 npm config，新版 npm 会告警）：
> `Remove-Item -Recurse -Force node_modules\electron; $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install`
启动后：
- 屏幕上方出现**全局玻璃输入框**（启动器）。输入一句话回车 → **开一个新对话卡**。
- 每张**对话卡自带底部输入框**，可在卡内继续聊（同一会话，不再开新窗）。
- **多张卡并行** = 多个独立对话，各自一个 opencode 会话。
- **拖动**：抓**卡片顶部标题栏**移动窗口（卡内消息区可滚动/选中）；输入框抓左侧紫色星标圆点。
- **关卡**：点卡片右上角 ×。
- **唤起/收起全局输入框**：热键 `Ctrl + Shift + Space`；按 `Esc` 收起。
- **系统托盘**：托盘图标常驻；左键点图标唤起输入框，右键菜单可切主题 / 退出。
- **切主题**：点输入框右侧**半圆图标**，浅磨砂 / 墨玻璃 实时切换并记住（默认浅色）。
- **选项目**：点输入框里的**文件夹按钮**选代码仓库；之后新开的卡都对它说话。
- **批准操作**：卡里出现「请求执行 xxx」时 → 允许一次 / 总是 / 拒绝（只读类自动放行）。
- **停止**：回复进行中时发送键变成 ■，点它中止本轮。
- **卡片控制**：标题栏右侧 置顶(图钉) / 最大化 / 最小化 / 关闭；卡片也可拖边缘缩放。
- **思考链**：模型若有推理（如 deepseek-v4-pro），答案上方会显示可折叠的「思考过程」块。
- **文件:行 可点**：回复里的 `LoanMapper.xml:120` 等会变成链接，点它在编辑器打开定位。
  - 默认 VS Code（`code -g`）。用 IDEA 等可在 `userData/settings.json` 配 `editorCmd`，如 `"idea64 --line {line} \"{file}\""`；`{file}`/`{line}` 为占位符。命令失败则用系统默认程序打开该文件。

> 全局输入框 = 开新对话；对话卡 = 持续会话（自带输入），**已接 opencode 真会话**。
> 双主题：一套设计令牌两套皮肤，由 `html[data-theme]` 驱动，见 `ui/glass.css`。

## 毛玻璃说明
- `main.js` 里 `USE_ACRYLIC = true` 启用 Win11 系统级 **Acrylic** 毛玻璃（透出并模糊你真实桌面）。
- 若你的系统上没显示毛玻璃（个别版本/设置），把它改成 `false`：退回**纯透明**窗口——仍然透出桌面、仍可拖动，只是少了模糊。
- 卡片是浅色磨砂 + 深色字（macOS 浅色 vibrancy 风），材质在 `ui/glass.css` 调。

## 形态要点（对应产品设计）
- **每张卡 = 一个独立的无边框透明 BrowserWindow**，不是一个大窗里画卡片。
- 可自由拖动、各自关闭、并行运行；产品不带壁纸，透出的是你真实桌面/IDE。
- 全局输入框是另一个常驻窗口，热键唤起。

## 引擎接入（serve 池架构）
- **多 serve 池**：每个项目目录起一个独立 `opencode serve`（从 4096 起自动找空闲端口）。
  - 同一项目的多张卡 → 复用同一 serve 的**多个并发会话**（任务隔离）。
  - 不同项目的卡 → **各自的 serve**（进程级隔离）。
  - > 原因：此版 `opencode` 的 `POST /session` 不支持会话级目录（`directory/cwd/path` 均被忽略，会话恒用 serve 启动目录），所以"一个项目 = 一个 serve"。
- 每张卡 = 一个 `POST /session` + `POST /session/:id/message`。
- 每个 serve 一条 `/event` SSE：**只读工具自动放行**，写/执行转给对应卡片**内联确认**（允许一次/总是/拒绝）。
- **逐 token 流式**：`/event` 的 `message.part` 实时写气泡；`POST /message` 结果作权威兜底。
- **选项目只影响"下一张新卡"绑哪个 serve**；已开的卡不受影响（不再杀端口/重启）。退出时统一关闭所有 serve。
- 报「引擎未就绪」：确认 `opencode` 在 PATH、已配好模型。

## 打包成 exe
```powershell
npm install
# 国内首次打包：下载 nsis/winCodeSign 走镜像
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```
产物在 `dist/`：
- `个人桌面智能体 Setup <版本>.exe` —— 安装版（可选安装目录、建快捷方式）。
- `个人桌面智能体-便携版-<版本>.exe` —— 免安装版，双击即用，适合发给同事。
- 应用图标 `build/icon.ico`；打包配置在 `package.json` 的 `build` 字段。

目标机注意：
- 需有 **`bocomcode`**（打包后默认）或 `opencode` 在 PATH，否则卡里报"引擎未就绪"。可用 `BOCOMHERMES_SERVE_BIN` 或 settings.json `serveBin` 覆盖。
- 未做代码签名，首次运行 Windows SmartScreen 可能提示"未知发布者" → 更多信息 → 仍要运行。

## 后续可加（功能路线）
选中即问、模型切换、卡坞/历史、设置面板（图形化配 serveBin/editorCmd/项目）、审计日志、接 AGENTS.md/glossary 作项目记忆、代码签名。
