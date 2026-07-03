# BocomHermes · 本地 MCP 工具（浏览器自动化 + HTTP 抓包）

给 opencode/bocomcode 的 agent 扩能。任何 agent（包括动态工作流的 worker）注册后即可调用。
- **浏览器自动化**：在内置无头浏览器里导航、取文本、点击、输入、执行 JS、截图。
- **HTTP 抓包**：起本地 HTTP 正向代理，捕获经过的请求/响应供 agent 查询分析（内网开发环境只有 HTTP，不涉及 HTTPS 证书）。

一条命令打印两者的注册块（已填本机路径），合并进 `opencode.json` 即可：

```
npm run mcp:config
```

## 特点
- **零依赖**：不装 `playwright`、不下载浏览器内核。用 CDP(Chrome DevTools Protocol) 直接驱动**系统已装的 Edge/Chrome**。
- **数据不出网**：浏览器与调试通道全程 `127.0.0.1`，符合内网铁律。
- **运行要求**：`node`（**22+**，需内置全局 WebSocket）+ 本机有 Edge 或 Chrome。

## 注册到 opencode.json
`npm run mcp:config` 输出形如：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "BocomHermes-browser": {
      "type": "local",
      "command": ["node", "<本仓库>/mcp/browser-mcp.mjs"],
      "enabled": true,
      "environment": { "BOCOMHERMES_BROWSER_HEADFUL": "0" }
    }
  }
}
```

> 注册 MCP 属于"给 agent 装本地工具"，不决定模型、数据不出网——与BocomHermes"外层封装、工具一律本地"的原则一致。

## 工具
**浏览器（BocomHermes-browser）** — 需 Node 22+ 与本机 Edge/Chrome
| 工具 | 作用 |
|---|---|
| `skill_list {}` | 列出用户录制并保存的浏览器自动化技能(名称/说明/参数/上次运行结果/是否含成功断言) |
| `skill_run {name,params?,baseUrl?}` | 按名字运行技能:relay 回主进程,在**用户可见的内嵌浏览器**里逐步回放(强引擎:等元素出现+失败重试+selAlt fallback+登录态恢复+弹窗自动应答+红框可视化),返回每步结果、成功断言与成败结论;`baseUrl` 可切 dev/uat/prod 环境 |
| `browser_navigate {url}` | 打开网址，返回标题与最终 URL |
| `browser_get_text {}` | 当前页可见正文(innerText) |
| `browser_get_html {selector?}` | 整页或某选择器的 HTML |
| `browser_click {selector}` | 点击元素 |
| `browser_type {selector,text,submit?}` | 填输入框，可回车提交 |
| `browser_eval {expression}` | 页面内执行 JS 表达式取结果 |
| `browser_screenshot {}` | 截图存临时 PNG，返回路径 |
| `browser_close {}` | 关闭浏览器释放资源 |

**HTTP 抓包（BocomHermes-httpcap）** — 零依赖，仅抓 HTTP
| 工具 | 作用 |
|---|---|
| `httpcap_start {port?}` | 启动本地 HTTP 代理，返回代理地址 |
| `httpcap_list {limit?,urlContains?,method?,status?}` | 列出捕获(最近在前) |
| `httpcap_get {id}` | 某条请求的完整头/体 |
| `httpcap_clear {}` / `httpcap_stop {}` / `httpcap_status {}` | 清空/停止/状态 |

> 用法：`httpcap_start` 后，把被测程序/浏览器的 **HTTP 代理**指向返回的地址
> （如 Java：`-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=<端口>`），即可捕获其 HTTP 调用。

## 技能(Record & Replay → SKILL,对标 Codex)
「录一次 → 生成技能 → 复用自动化」的完整链路:
1. 用户在**内嵌浏览器**工具条点「● 录制」,把操作(点/填/下拉/勾选/回车/跳转)跑一遍,点「停止」;
2. 自动弹「⚡ 保存为技能」卡:起名 + 一句话说明 + 勾选哪些输入是**每次运行可改的参数**
   + 可选**成功标志**(CSS 选择器或 `text:…`)+「跳过滚动步」开关;
3. 之后两条复用通路,同一套回放内核:
   - **用户**:工具条「技能库」→ ▶ 运行(带参先弹填参框,可选环境地址),红框逐步回放;
   - **Agent**:`skill_list` 发现 → `skill_run {name, params, baseUrl?}` 按名字带参运行。

**录制保真**:`<select>` 下拉(含选项文本回退,跨环境字典码不同也能回放)、checkbox/radio、
输入防抖按元素 flush(快速切换输入框不丢事件)、IME 组合态过滤(拼音上屏 Enter 不误录)、
**密码框不存明文**(录制即脱敏,保存时自动建议设为参数,运行时用密码框填)。

**回放健壮**:每步先**等元素出现且可交互**(默认 5s 轮询)、元素未找到自动**重试一次**、
select/check/navigate 后等网络静默(级联下拉/SPA 首屏)、原生 confirm/alert **自动应答**
(无人值守不挂死)、技能运行走 fast 节奏(步间 gap 封顶 400ms)。

**生命周期**:运行历史(上次成功/失败徽标)、成功断言(PASS=目标达成而非仅步骤跑完)、
**导出/导入**(剥离 cookie/快照的可分享 JSON,导入白名单重建校验)。

存储即 `userData/recordings/<id>.json` 就地扩展 `skill/description/params/skipSteps/success/lastRun` 字段,无第二套子系统。
`skill_run` 经 `mail-relay.json` 本地中继(127.0.0.1 + token)调 GUI 主进程,数据不出网。
局限:iframe 内操作暂不支持;银行安全键盘控件录不到;日期日历弹层建议直接在输入框敲终值。

## 自测 / 调试
```
npm run mcp:browser:test      # 浏览器：协议握手 + 真 Edge 导航/取文本/执行JS 端到端
npm run mcp:httpcap:test      # 抓包：起目标服务 + 经代理转发 + 捕获/查询 端到端
npm run mcp:browser           # 以 stdio 独立启动（手动联调）
npm run mcp:httpcap
```
- 看见浏览器窗口：环境变量 `BOCOMHERMES_BROWSER_HEADFUL=1`
- 指定浏览器：`BOCOMHERMES_BROWSER=C:/path/to/msedge.exe`

## 安全
两者均为本地工具、数据不出网；浏览器不改本地文件（除 `browser_screenshot` 写临时 PNG），抓包只读不改流量。
权限仍由 opencode 管控——在BocomHermes 工作流卡里，这些调用会路由到卡内联确认。
