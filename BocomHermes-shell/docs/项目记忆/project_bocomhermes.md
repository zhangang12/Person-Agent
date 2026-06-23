---
name: project-bocomhermes
description: "产品对外名是 BocomHermes（原代号天枢）。2026-06-21 已全仓库统一命名：目录 BocomHermes-shell、4 个设计文档、代码/UI 文案全部改为 BocomHermes，无天枢/Tianshu 残留"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b103e32-0acb-47b9-bf1f-348a87822a31
---

产品正式名称是 **BocomHermes**（交银赫尔墨斯 / 天枢）。

**Why:** 用户明确告知，这是对外展示的品牌名。

**How to apply:** 涉及产品名的场合（package.json productName、DMG 标题、窗口标题、README、UI 提示文案）一律用 BocomHermes，而非"个人桌面智能体"或其他描述性名称。

**已完成（2026-06-21 本次会话）：** 全仓库统一命名。
- 目录 `tianshu-shell/` → `BocomHermes-shell/`（git mv，内部全是相对路径，不影响运行）
- 设计文档重命名：`BocomHermes-产品蓝图.md` / `BocomHermes-产品设计规范.md` / `BocomHermes-功能设计-富结果.md`
- 代码/UI/脚本/MCP 注释与文案中的 天枢/Tianshu 全部 → BocomHermes（含会话默认标题 `BocomHermes 对话`、settings 提示）
- **刻意保留**：`个人智能体` 作为品类词（如"对标主流个人智能体 Hermes/OpenClaw"）、《个人桌面智能体设计方案》外部文档名——这些不是本产品命名，未替换。
- 仅文档/工作树改动，尚未 commit；`dist/` 旧构建产物未动（下次 `npm run dist` 自然刷新）。
