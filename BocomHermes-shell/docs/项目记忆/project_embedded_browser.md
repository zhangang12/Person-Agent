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

**iframe 回放(已做完,2026-07):** 录制端 emit 给子框架事件打 `fu`=本框架 URL(window.top!==window 时);回放端 `frameFor(wc,ev)` 按 ev.fu 在 mainFrame.framesInSubtree 里找同 URL 的 WebFrameMain(宽松退 origin+path,找不到退主框架),execStep/waitForEl/highlightTarget 全部改走 frame.executeJavaScript;key 步在 frame 内 focus 后由 wc.sendInputEvent 打焦点帧。导入白名单放行 http/https 的 fu。银行老系统业务表单在 iframe 里的操作现在录得到也放得回。

**技能 phase-3(已做完,2026-07):**
- **技能步骤编辑器**:技能库行「✎ 步骤」→ 独立弹层列全部步骤,可删/上移下移/改 input·select 值。前端只交新顺序(rows[{srcIndex,value?}]),后端 browser-rec-edit-steps 用 idxMap(原→新下标)一处同时重建 events + 重映射 params.stepIndex/skipSteps + 作废 lastRun;events 走独立 handler + 共用 sanitizeEvent 白名单校验(不进 rec-update);参数步改值同步 param.default;弹层调 modalOverlay 让位
- **新窗口/新标签录制**:rec 单值 tabId → tabIds Set(录制期间新开的 tab 都纳入)+ cleanups 数组;wireRecToTab(原始/新 tab 共用,幂等)在 newTab 里挂钩;pushConsole 过滤改 tabIds.has;跨标签第一条 navigate 打 newTab 标记。回放降级:不真开新 tab,navigate 在当前 tab loadURL(真·多标签同时存活的流程无法回放,属结构限制)
- **日期/日历控件**:change 监听对 readonly/日历类 INPUT 补录终值(act:'input',原生 setter 直接写,绕开点格子);日历浮层内 click 标 transient;回放 transient 步 fast-fail(800ms 不重试)且失败不计级联早停、不计入回归失败统计
- **sanitizeEvent** 抽为导入/编辑共用的单事件白名单净化器

**待办：** ② HTTP 抓包的 GUI 面板;技能 phase-4(留待立项):录制端 dialog 按录制答案回放、真·多标签同时存活回放、OOPIF 跨域 iframe 录制采集(需 CDP flatten 自动附着,定位/回放侧已可用)。详见 [[project-intranet-mode]]。

构建：`npm run dist:mac`（dmg+zip，x64+arm64）；`npm run dist`（win，**需 wine**，纯 macOS 无 wine 打不了 exe）。
