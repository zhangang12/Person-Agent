---
name: project-embedded-browser
description: BocomHermes 内嵌浏览器（WebContentsView）是三大功能之一，专业级，含 AI 分析联动
metadata: 
  node_type: memory
  type: project
  originSessionId: 25c4a57a-3c8a-45dc-81fc-b5deb4f016dc
---

BocomHermes 规划的「三大功能」：① 内嵌浏览器内核（实时渲染前端页面做前端自动化调试）② 内嵌 HTTP 请求抓包（分析本地柜面客户端收发的请求）③ 定时邮件整理。另外在探索 ④ Codex 的 Record & Replay（录制一次操作→生成可复用技能→自动重放）。

**内嵌浏览器现状（已做完，专业级）：**
- `ui/browser.html` = chrome（标签栏 38 + 工具栏 44，BR_TOP_H=82）；`ui/newtab.html` = 新标签页（dev server 快捷入口）
- `src/window.js` 的 `S.browser = { win, tabs[], activeId, consoleH, seq }`，基于 `WebContentsView`（每个 tab 一个 view，add/removeChildView 切换）
- 功能：多标签、设备模拟（桌面/手机390/平板834+旋转，enableDeviceEmulation）、全等级控制台捕获+筛选+per-tab 快照、页内查找（findInPage）、缩放、整页截图（存 downloads）、加载进度条
- **AI 分析联动**：`brAnalyze()` 收集 URL+控制台报错+DOM(截断9000) → `spawnCard(title, null, prompt, disp)` 生成前端调试卡。card.html 新增 `disp` 参数：大段上下文走 msg 发送，气泡只显示 disp 摘要
- 入口：托盘「🌐 内嵌浏览器」+ 全局快捷键 Ctrl+Shift+B
- 已有 MCP 版本：`mcp:browser`（mcp/browser-mcp.mjs）、`mcp:httpcap`（mcp/httpcap-mcp.mjs）是给 agent 用的独立 MCP server，与 GUI 内嵌浏览器是两套东西

**④ Record & Replay → SKILL(已做完,2026-07):**
- 「一条录制即一个技能」:recordings/<id>.json 就地扩展 `skill/description/params` 三字段,无第二套子系统。params[].stepIndex 指向 events 里的 input 步,回放前 applyParams 深拷贝注入运行值,replayRec 引擎零改动
- UI:录制停止后自动弹「⚡ 保存为技能」卡(起名+说明+勾选参数);「录制管理」抽屉升级为「技能库」(⚡徽标/参数×N/▶运行带填参 popover/⚙ 存为技能就地晋升)
- Agent:browser-mcp 新增 `skill_list` / `skill_run {name,params}`,经 mail-relay 中继(x-bocom-tok)调主进程 `/skill/list` `/skill/run`;skill_run 在可见内嵌浏览器跑强引擎,窗口没开自动 createBrowser 拉起
- 说明字段同时写 expectation,兼作修复验证的成功判据

**待办：** ② HTTP 抓包的 GUI 面板（仅本地 127.0.0.1 的 serve / HTTP，不做 HTTPS MITM，不做 remote）；技能 phase-2:host 变量化(dev/uat/prod)、export/import 去 cookie 分享、显式"等元素出现"条件等待。详见 [[project-intranet-mode]]。

构建：`npm run dist:mac`（dmg+zip，x64+arm64）；`npm run dist`（win，**需 wine**，纯 macOS 无 wine 打不了 exe）。
