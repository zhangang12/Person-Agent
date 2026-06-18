# 天枢 · 浏览器自动化 MCP

给 opencode/bocomcode 的 agent 扩能：在内置无头浏览器里**导航、取文本、点击、输入、执行 JS、截图**。
任何 agent（包括动态工作流的 worker）注册后即可调用。

## 特点
- **零依赖**：不装 `playwright`、不下载浏览器内核。用 CDP(Chrome DevTools Protocol) 直接驱动**系统已装的 Edge/Chrome**。
- **数据不出网**：浏览器与调试通道全程 `127.0.0.1`，符合内网铁律。
- **运行要求**：`node`（**22+**，需内置全局 WebSocket）+ 本机有 Edge 或 Chrome。

## 注册到 opencode.json
跑一下，把输出合并进 opencode/bocomcode 的 `opencode.json`（已自动填好本机绝对路径）：

```
npm run mcp:browser:config
```

形如：

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

## 自测 / 调试
```
npm run mcp:browser:test      # MCP 协议握手 + 真浏览器导航/取文本/执行JS 端到端
npm run mcp:browser           # 以 stdio 方式独立启动（手动联调）
```
- 看见浏览器窗口：环境变量 `TIANSHU_BROWSER_HEADFUL=1`
- 指定浏览器：`TIANSHU_BROWSER=C:/path/to/msedge.exe`

## 安全
写/执行类没有；浏览器操作本身不改本地文件（除 `browser_screenshot` 写临时 PNG）。
权限仍由 opencode 管控——在天枢工作流卡里，这些调用会路由到卡内联确认。
