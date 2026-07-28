# 性能审查：内网 LLM 每次调用的成本构成与优化清单

> **日期**：2026-07-28。**测量方式**：forkcheck T1 首轮 prompt 基线（真实读数）+ T2b limit.context + T2c 构成估算 + 本机配置/文件实测。
> **结论先行**：单次调用的快慢，八成由"进上下文的 token 量"和"缓存命中率"决定——本轮实测最大可砍项是 **AGENTS.md 全量注入**与**并行工具批处理**。

## 0. 每次调用的成本构成（实测）

| 构成 | 大小（估算） | 是否每轮都付 | 优化空间 |
|---|---|---|---|
| serve 系统提示（兜底模板） | ~2-3k tokens | 每轮（吃缓存） | 小（引擎侧） |
| **AGENTS.md（serve 自动全量注入）** | **本仓库 30.5KB ≈ 19k tokens；生成器产物 ~1KB ≈ 0.6k** | **每轮（吃缓存，但首次贵）** | **大（①）** |
| MCP 工具表（9 server / 68 工具） | ≈25k 字符 ≈ 8-10k tokens | 每轮（吃缓存） | 中（④） |
| 壳层首发注入（记忆/背景/知识/技能/纪律） | 有预算帽合计 ~15k 字符 ≈ 9k tokens | 仅首条消息 | 已收口（③） |
| 历史消息（工具结果/对话） | 随轮次增长 | 每轮 | 已治理（context-guard 清理/交棒） |
| 输出 token（生成） | 几百-几千/轮 | 每轮 | 中（⑤） |

**T1 实测基线：首轮 26k tokens 进上下文**（BH 仓库语境）。关键点：**第 2 轮起这些前缀应吃 KV-cache**（命中率看卡片 ctx chip，健康线 >70%）——所以优化靶子是"首轮基线 + 缓存别被戳破"。

## 1. 优化清单（按 ROI 排序）

### ① AGENTS.md 瘦身（最大可砍项，尤其 BH 本仓库）
- **事实**：BH 自己的 AGENTS.md 已膨胀到 30.5KB（≈19k tokens，占首轮基线七成）——serve 全量注入每轮。主犯：仓库结构注释树（62 行）与测试段（29 行）。
- **生成器已加护栏（本次实施）**：`src/agent-md.js` 新增大小检查——已有 AGENTS.md >8KB 时在草稿返回 `sizeWarn`，并给生成块加"保持精简"头部约束；人工大文件追加前先在日志告警。
- **建议**：BH 仓库的 AGENTS.md 做减法（CC /init 原则"删掉会让 Agent 犯错才保留"）——结构树压到 20 行内、测试段只留命令清单，机制细节迁 `docs/`。这是给我们自己开发 BH 省钱，不影响用户项目（生成器产物本就精简）。
- **用户项目侧**：生成器产物 ~1KB，无此问题。

### ② 并行工具批处理（省整轮时间）
- opencode 原生有 `experimental.batch_tool`（一次回合并行跑最多 25 个内置工具调用）——弱模型爱连发 read/grep，开启后**一轮顶好几轮**，是最直接的省时项。
- **本次实施**：已并入 `src/intranet-optimize.js` 静态包（`experimental.batch_tool: true`），设置页「应用内网优化」一键写入。
- **验证点（内网）**：fork 是否真执行批量（forkcheck 后续加探针；不支持会被 schema 忽略，无害）。

### ③ 轻任务小模型（省钱）
- opencode 支持 `small_model`（标题生成等轻任务走小模型）。**建议**：在 opencode.jsonc 配一个快模型当 small_model（如 flash 类）；BH 侧自动命名目前用的是首条消息前 24 字（不调模型，零成本，无需改）。

### ④ MCP 工具表按项目裁剪
- 68 个工具 ≈ 8-10k tokens 常驻。当前 9 个 server 全量注册——邮件/数据库/抓包类 server 在不相干项目里是白付的。
- **建议**：`mcp-config.js` 的注册支持按项目开关（entries 的 `enabled` 字段现成的）；不相干项目关掉 2-3 个 server，省 2-3k tokens/轮。

### ⑤ 输出长度收口（防拖尾）
- 弱模型长篇大论是拖尾主因之一。开关已在：`BOCOMHERMES_MAX_OUTPUT_TOKENS`（context-guard `chat.params` 钳制，默认关）。
- **建议**：内网先开 8192 试一周（spawn serve 的环境变量注入；改 opencode.js 一行，要做随时说）。

### ⑥ 缓存命中率运营（不花钱的提速）
- 前缀稳定就是钱：①c 注入铁律（稳定块在前、动态只追加尾部）+ context-guard 清理决策幂等已保住前缀。
- **用法**：盯卡片 ctx chip 的 KV-cache 命中率——>70% 健康；掉到 30% 以下说明前缀在漂（多半是某处动态内容插到头部了），抓出来修。

### ⑦ 其它（已做，不重复）
- context-guard 历史工具结果清理 + 交棒 + read-spill 外溢（历史侧已收口）；MCP 工具描述已瘦身一轮（19.4k→16.9k）；交棒熔断防病态重试；看门狗防绕圈白烧。

## 2. 立即可做的三件（按你的点头执行）

1. **应用内网优化一键写入**（设置页按钮）：现在包含 tools 瘦身 + permission.bash 通配 + agent.explore.maxSteps + **batch_tool**（新增）。
2. **BH 仓库 AGENTS.md 减法**（30.5KB → ~15KB）：结构树与测试段压缩，机制细节迁 docs——你点头我就动手。
3. **开 `BOCOMHERMES_MAX_OUTPUT_TOKENS=8192`**（改一行 spawn env）——弱模型拖尾收口。

**本轮已实施**：agent-md 大小护栏（见下）+ intranet-optimize 并入 batch_tool（见下）。

---

*测量备注：T2c 的 "31k+ tokens" 是按字节的保守高估（CJK 约 1.6 字符/token，30.5KB ≈ 19k tokens）；T1 的 26k 是 serve 上报的真实 input tokens（含缓存口径），以 T1 为准。*
