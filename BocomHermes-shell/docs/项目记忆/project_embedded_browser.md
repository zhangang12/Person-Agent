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

**④ Record & Replay → SKILL(已做完并对标 Codex 完善,2026-07):**
- 「一条录制即一个技能」:recordings/<id>.json 就地扩展 `skill/description/params/skipSteps/success/lastRun` 字段,无第二套子系统。params[].stepIndex 指向 events 里的 input/select 步,回放前 applyParams 深拷贝注入运行值(显式传参的 select 禁 text 回退);applyBaseUrl 做 dev/uat/prod 环境切换(safeOrigin 校验,切环境不恢复录制登录态)
- 录制保真:change 监听录 `<select>`(act:'select',含选项文本回退键)与 checkbox/radio(act:'check');输入防抖 per-element flush(修丢事件+次序反转);IME 组合态过滤;**密码框录制即脱敏**(secret:true,value 空,保存卡默认勾成参数);radio/checkbox 的 name 候选拼 value;停录经返回值通道收 pending 输入
- 回放健壮(Codex 核心):waitForEl 每步先等元素出现且可交互(5s 轮询,级联失败时收缩到 1.5s);「元素未找到」重试一次(400ms 后,executeJavaScript 异常不重试防双提交);select/check/navigate 后也等网络静默;原生 confirm/alert/prompt 自动应答桩(confirm→true,navigate 后重注入,应答记录进报告);replayRec 加 opts{fast}——技能运行 fast(gap 封顶 400ms),**verifyFix 无参调用节奏零回归**;skipSteps 跳步推占位条目保 stepReport 对齐;密码步失败不计级联早停
- 生命周期:成功断言 success:{kind:'css'|'text',value}(技能运行硬判,verify 路径仅展示);lastRun 运行历史(重读磁盘 read-modify-write,防 preState 泄漏);导出(剥 preState/snapshot/_键,写下载目录)/导入(白名单重建+类型强转+URL safeOrigin 校验+stepIndex 重映射)
- Agent:`skill_list`(含 lastRun/hasSuccess/secret 参数标记)/`skill_run {name,params,baseUrl?}`(名字歧义时报错列候选);经 mail-relay 中继调主进程,窗口没开自动拉起(含开窗 0-tab 边界)
- 安全加固:rec-update/delete id 消毒;execStep scroll 插值 Number 强转;verifyFix snapshot 裸取守卫;参数只落 input/select 步(拒绝替 selector)

**待办：** ② HTTP 抓包的 GUI 面板（仅本地 127.0.0.1 的 serve / HTTP，不做 HTTPS MITM，不做 remote）;技能 phase-3(明确不做留待立项):iframe 逐 frame 注入回放、日期日历弹层专项、录制端 dialog 按录制答案回放、技能步骤编辑器。详见 [[project-intranet-mode]]。

构建：`npm run dist:mac`（dmg+zip，x64+arm64）；`npm run dist`（win，**需 wine**，纯 macOS 无 wine 打不了 exe）。
