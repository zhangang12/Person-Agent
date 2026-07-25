# BocomHermes 桌面主窗口化重构 · plan.md

> 目标:悬浮球 + 多悬浮卡 → 一体化桌面主窗口(侧栏 + 主工作区 + 状态栏);
> 悬浮球与自由悬浮卡**退役**;保留唯一例外:从主窗口**钉出单张迷你卡**(盯梢单个会话)。
> 设计稿:`docs/ui-design/desktop.html`(W0-W5)。

## 架构决策

**主窗口 = 新 `ui/shell.html`**,各功能页以 `<webview>`(preload 同一份)收编为视图,
不重写各页业务逻辑。已验证的两个先例照抄:

- `src/browser.js:631` — WebContentsView 内嵌 `card.html?embedded=1`(会话卡嵌入可行)
- `ui/console.html:846-850` — `<webview preload="abs-file-url">` 内嵌 `mailcenter.html?embed=1`

视图映射:

| 主窗口视图 | 承载 | 说明 |
|---|---|---|
| 对话(默认) | `card.html?embedded=1&sid=…` | 侧栏会话列表切换;每会话一个 webview,后台保活 |
| 任务编排 | `dock.html?embed=1` | 牌桌/模板/清单/历史都在 dock |
| 邮件中心 | `mailcenter.html?embed=1` | 已有 embed 先例 |
| 设置+知识库 | `settings.html?embed=1` | 旋钮与知识库治理都在 |
| 内嵌浏览器 | 不开视图,唤起现有 `createWorkspace()` 窗口 | 功率工具,保持独立 |

钉出/收回:

- 钉出:shell 会话项「钉出」→ IPC `session-pin-out {sid}` → 销毁内嵌 webview(**不 abort 会话**)→ `spawnCard(title, sid)`(cardInit 按 sid 重接,天然接管流式)→ 记录 `S.pinnedWc`
- 收回:迷你卡 `closed` → 若 `S.pinnedWc` 命中且主窗口活着 → 跳过 abort 清理,通知 shell `session-reattached {sid}` → shell 重建该会话 webview;主窗口已关 → 走原清理链
- 拖出手势:侧栏会话项 mousedown 拖动 >8px 即视为拖出,新卡出现在光标屏幕坐标

## 关键事实(侦察结论,改造时对照)

- 会话绑定键 = `webContents.id`:`S.sessionByWc / S.sessionInfo`(src/session.js:788-824),webview guest 天然兼容
- 窗口控制 IPC(`close-self` 等)对 guest **静默失效**(src/window.js:1997-2016),嵌入页的 `#x`/Esc 关窗必须改走 embed 分支
- glass.css 透明壳假设:`body{padding:24px}` + `.glass` 圆角/阴影(ui/glass.css:111-146),embed 样式开关必须补齐(现在只隐藏按钮,card.html:869-870)
- 窗口 `closed` 清理链(abort 会话/retire serve/forgetBusy):src/window.js:253-286,视图化后要抽出复用;工作台曾漏复刻踩过坑(src/browser.js:644-664 注释)
- 主题广播只发 BrowserWindow 顶层(src/window.js:857,1545-1548),guest 收不到 → 改 `webContents.getAllWebContents()`
- `skills.html` 是无引用死页,**不收编**;console.html(控制台2.0)被 shell 取代后退役
- 热键改道点:main.js:161-174;托盘菜单:src/window.js:1477-1497;`window-all-closed` 自动重建 orb:main.js:180-185

## 分波实施

- **波1 主窗口骨架**:`ui/shell.html` + `createMainWindow()` + 启动/热键/托盘改道 + 停建 orb;dock/settings 补 embed 分支;embed 样式覆盖
  验收:`npm start` 出主窗口,四视图可切(邮件/编排/设置活),对话视图能聊,无 orb,自测全绿
- **波2 会话视图完备**:侧栏会话列表(活动会话+历史)、切换/新建/关闭(清理链抽出复用)、主题广播修 guest、空态
  验收:多会话并行流式不串、关会话清理正确(无孤儿 serve/卡死状态球)
- **波3 钉出/收回**:`session-pin-out` / `session-reattach` IPC、迷你卡 closed 改道、拖出手势
  验收:钉出后流式不断、收回后会话回列表、主窗口关闭时钉出卡退回原清理链
- **波4 快捷输入与状态栏**:Ctrl+Shift+Space → 聚焦主窗+快捷输入层(回车=新会话带首发消息);状态栏(项目/引擎保活/token/并发);Ctrl+Shift+V 进快捷输入
  验收:热键全链路通、状态栏数据真
- **波5 退役与收尾**:删 orb.html/orb-input.html/console.html 及其装配(createOrb/createOrbInput/toggleOrbInput/createConsole)、`window-all-closed` 重建逻辑、托盘残留项;全量自测 + `npm start` 冒烟;git 提交
  验收:`grep -r orb` 仅剩无害注释;`npm run card:ui:test` 等全绿;提交记录清晰

## 风险 Top 5(侦察原文)

1. 窗口控制 IPC 对 guest 失效 → embed 分支逐一改道(死按钮零容忍)
2. glass.css 透明壳 → embed 样式开关(padding/radius/shadow/出场动画)
3. `closed` 清理链复刻不全 → 抽公共函数,钉出/视图关闭都走它
4. 主题/广播漏 guest → 统一 `webContents.getAllWebContents()`
5. 双壳口径分裂 → console.html 退役,shell 为唯一主界面
