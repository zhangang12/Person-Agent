# 项目记忆(版本化镜像)

这些文件是 Claude Code 在本项目的**项目类记忆(project memory)**的版本化快照,镜像自本机
`~/.claude/projects/<proj>/memory/` 下的 `project_*.md`。目的:把"代码/git 历史里看不出来的项目背景与决策"沉淀进仓库,可追溯、可分享、可回溯。

## 说明
- **真实来源在仓库之外**(`~/.claude/.../memory/`),每个会话自动加载进 Claude 的上下文;这里是**手动同步的镜像**,两边可能短暂不一致。
- 内容只含 `project` 类记忆(项目事实 / 进行中的工作 / 取向),**不含**个人偏好或敏感凭据。
- 记忆变化后若想保持同步,重新 `cp ~/.claude/.../memory/project_*.md docs/项目记忆/` 再提交即可。

## 索引
- `project_bocomhermes.md` — 对外品牌名 BocomHermes(原代号天枢),已全仓库统一命名
- `project_intranet_mode.md` — 内网部署模式:连接内网 opencode serve,非本地 spawn
- `project_embedded_browser.md` — 内嵌浏览器相关背景
- `project_personal_agent_focus.md` — 产品定位:个人桌面智能体,功能优先级按个人场景排
- `project_sdlc_roadmap.md` — 当前做"需求分析自动化"(多Agent 对抗式,详见 `docs/需求分析自动化-多Agent对抗方案.md`);弃用信贷大方案,只锚代码+DB
