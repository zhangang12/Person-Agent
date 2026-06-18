# 天枢 · 本地 MCP 工具（浏览器自动化 + HTTP 抓包）

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
    "tianshu-browser": {
      "type": "local",
      "command": ["node", "<本仓库>/mcp/browser-mcp.mjs"],
      "enabled": true,
      "environment": { "TIANSHU_BROWSER_HEADFUL": "0" }
    }
  }
}
```

> 注册 MCP 属于"给 agent 装本地工具"，不决定模型、数据不出网——与天枢"外层封装、工具一律本地"的原则一致。

## 工具
**浏览器（tianshu-browser）** — 需 Node 22+ 与本机 Edge/Chrome
| 工具 | 作用 |
|---|---|
| `browser_navigate {url}` | 打开网址，返回标题与最终 URL |
| `browser_get_text {}` | 当前页可见正文(innerText) |
| `browser_get_html {selector?}` | 整页或某选择器的 HTML |
| `browser_click {selector}` | 点击元素 |
| `browser_type {selector,text,submit?}` | 填输入框，可回车提交 |
| `browser_eval {expression}` | 页面内执行 JS 表达式取结果 |
| `browser_screenshot {}` | 截图存临时 PNG，返回路径 |
| `browser_close {}` | 关闭浏览器释放资源 |

**HTTP 抓包（tianshu-httpcap）** — 零依赖，仅抓 HTTP
| 工具 | 作用 |
|---|---|
| `httpcap_start {port?}` | 启动本地 HTTP 代理，返回代理地址 |
| `httpcap_list {limit?,urlContains?,method?,status?}` | 列出捕获(最近在前) |
| `httpcap_get {id}` | 某条请求的完整头/体 |
| `httpcap_clear {}` / `httpcap_stop {}` / `httpcap_status {}` | 清空/停止/状态 |

> 用法：`httpcap_start` 后，把被测程序/浏览器的 **HTTP 代理**指向返回的地址
> （如 Java：`-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=<端口>`），即可捕获其 HTTP 调用。

## 自测 / 调试
```
npm run mcp:browser:test      # 浏览器：协议握手 + 真 Edge 导航/取文本/执行JS 端到端
npm run mcp:httpcap:test      # 抓包：起目标服务 + 经代理转发 + 捕获/查询 端到端
npm run mcp:browser           # 以 stdio 独立启动（手动联调）
npm run mcp:httpcap
```
- 看见浏览器窗口：环境变量 `TIANSHU_BROWSER_HEADFUL=1`
- 指定浏览器：`TIANSHU_BROWSER=C:/path/to/msedge.exe`

## 安全
两者均为本地工具、数据不出网；浏览器不改本地文件（除 `browser_screenshot` 写临时 PNG），抓包只读不改流量。
权限仍由 opencode 管控——在天枢工作流卡里，这些调用会路由到卡内联确认。
