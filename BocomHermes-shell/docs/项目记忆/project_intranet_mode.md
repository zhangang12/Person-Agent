---
name: project-intranet-mode
description: BocomHermes 是内网使用的个人桌面智能体，连接内网部署的 opencode serve，不是本地 spawn
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b103e32-0acb-47b9-bf1f-348a87822a31
---

BocomHermes 是在**公司内网环境下使用**的个人桌面智能体。opencode serve 在**用户本机本地启动**（当前 spawn 模式正确），但 serve 对接的 LLM 端点是内网 API（非公网 OpenAI/Anthropic）。

**Why:** 用户澄清：不是远端 serve，是本地 spawn serve；"内网"指整个工具在公司网络环境下使用，LLM 后端是内网部署的模型服务。

**How to apply:**
- opencode.js 当前架构（本地 spawn + localhost 连接）是正确的，不需要改
- 产品评审 P0 重新聚焦：权限审批参数展示、变更可回滚、onboarding 引导
- 内网分发：auto-update 不需要公网 electron update server，改为内部下载页/IT 推送
- 数据安全：Electron shell 本身不发任何外网请求（analytics、CDN、update check）是合规要求
