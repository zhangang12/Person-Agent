# BocomHermes 全面优化待办清单 —— 内网 opencode × 弱模型专项

> **日期**：2026-07-26。**性质**：机制层优化（上下文/提示词/权限/缓存），与 `docs/研发功能路线图.md`（功能层）并轨，不含功能项。
> **来源三合**：`external/claude-code-提示词工程借鉴.md`（L1-L7/P1-P6）、`external/claude-code-借鉴总清单.md`（A-F 组）、`docs/内网引擎需求-上下文工程.md`（R1-R3）。每项标注依据与验证方式。
> **口径**：机制思想可借鉴、代码净室重写；提示词改动**小步单变量、每项留两周观测期**（弱模型服从率对措辞/位置极敏感，一次只改一处）。

## 0. 两个基本面（决定全部策略）

**内网 opencode（bocomcode fork）**：无外网（webfetch/websearch 注定失败）、Windows 目标机、数据不出网红线、fork 能力面未全证实（钩子/热更新需探针）、opencode.jsonc 配置面是零代码杠杆、serve 自带默认权限（.env ask/外目录 ask）与 50KB 工具输出截断。
**弱模型（MiniMax M2.5 级，128k）**：指令服从对位置/标题/措辞敏感（CC eval：行动 cue 标题 3/3 vs 抽象 0/3）；虚假声明、幻觉产出、交棒后重读、委派贴原文、半途而废是已观测病灶 → **提示词纪律与硬闸（插件/配置/壳层拦截）并重，不能只靠提示词**。

## 波次总览

| 波次 | 内容 | 前置 | 预期收益 |
|---|---|---|---|
| W0 验证前置（4 项） | fork 能力探针 + 现状盘点 | 无 | 决定 W2/W3/W4 的可行性边界 |
| W1 纯提示词（5 项） | 交棒/纪律/技能注入，零架构风险 | 无 | 交棒不漂移、防重读、防虚假声明 |
| W2 插件层（3 项） | context-guard 合体插件等 | W0.1 | 历史工具结果清理、子 Agent 盲区、压缩质量 |
| W3 配置与 API（4 项） | jsonc 静态包 + 权威数据源 | W0.2 部分 | 工具表瘦身、权限双轨、路由不再猜 |
| W4 引擎需求（4 项） | R1-R3 复核推进 + fork 盘点 | W0.2 | 需求单闭环、KV-cache 收益 |
| W5 观测与制度（3 项，贯穿） | 台账/纪律/回归 | 无 | 补丁可管理、改动可回归 |

---

## W0 · 验证前置（不动产品代码）

- [x] **W0.1 forkcheck 增补 T4/T5/T6 探针**（2026-07-26 已完成并本机实测）：T4 = `messages.transform` 回写、T5 = `permission.ask` deny、T6 = `system.transform` 注入。落点：`scripts/fork-capability-probe.mjs`（自起隔离 serve，探针插件放项目级 `.opencode/plugin/`，不污染全局配置）。**本机 opencode 1.18.3 结果：T4/T6 绿、T5 红（该钩子类型已声明、实现未上线，二进制无触发点）**。**剩：把探针带到内网对 bocomcode fork 复验（fork 结论以 fork 实测为准）**。
- [ ] **W0.2 与 fork 维护方确认四件事**：① 源码可改性/上游基线版本 ② experimental 三钩子是否保留 ③ `PATCH /config` 是否热生效 ④ 是否已有并发/压缩实现（防 W4 重复移植）。依据：通道方案 §4。形式：一封需求沟通邮件。
- [ ] **W0.3 内网 serve 提示词与截断现状抓包**：确认内网模型实际收到的系统提示（验证"落兜底模板"假设）、read/grep 工具截断阈值现状（R1 是"加"还是"调"）。落点：`scripts/opencode-wire-probe.mjs` / `text-output-probe.mjs`。依据：提示词借鉴 §6、需求单兼容性确认项 2。成本：半天。
- [ ] **W0.4 建弱模型行为台账**：登记表模板=病灶/失败样本截图/补丁内容/依据/去留条件/观测期。落点：`docs/项目记忆/` 或 AGENTS.md 附录。依据：提示词借鉴 §8.3/§9.3。成本：1 小时。

## W1 · 纯提示词与壳层小改（零架构风险，先做）

- [x] **W1.1 交棒摘要四项补齐**（2026-07-26 已实施）：SUM_PROMPT_WF/CHAT 已加"用户消息清单/已读文件清单/下一步逐字引用"；逃生舱实现为 `transcriptPath` IPC（session.js `transcript-path` + preload 桥接），交棒续命消息动态拼上一棒 transcript 路径；RESUME_MSG 加"已读文件清单直接采信"。落点：`ui-vue/src/chat/store.ts`（legacy `ui/card.html` 同步提示词与续命文案）。验证：ui:typecheck/compact:test 全绿；真实交棒目检待观测期。
- [x] **W1.2 交棒失败熔断**（2026-07-26 已实施）：`compactFailStreak/compactFailSeq/compactClock/compactFailNoted` 落 store.ts compactCore/maybeAutoCompact；成功复位、失败不耗 autoCompactN、连败 2 次停自动重试转人工（醒目 note 只贴一次）、失败隔一个轮末冷却。验证：ui:typecheck 全绿。
- [x] **W1.3 弱模型双向纪律条款**（2026-07-26 已实施）：`<如实汇报>`+`<委派回报纪律>` 已追加到 `src/session.js` 128k 纪律块尾部（重写非照抄，含双向纠偏）。验证：session:test 55 例全绿；两周观测期（台账已登记）。
- [x] **W1.4 技能摘要常驻 + 全文预算**（2026-07-26 已实施）：技能摘要清单（≤800 字截断）拼进 loadProjectContext 项目背景块尾部；技能全文注入超 4000 字截尾标注（card-send 注入段）。验证：session:test 全绿。
- [x] **W1.5 注入通道"元定义"补一句**（2026-07-26 已实施，并入 W1.3 同波）：`<系统提醒说明>` 已随纪律块尾部一并注入，合并观测。

## W2 · 插件层（前置：W0.1 探针绿——**T4/T6 本机 opencode 1.18.3 已验证绿，fork 待复验；T5 公网已红，W2.3 插件轨搁置**）

- [x] **W2.1 `bocomhermes-context-guard.js` 合体插件**（2026-07-26 已实施）：六钩子全落——① messages.transform 历史清理（保最近 3 轮+聚合预算 40k+partID 决策记忆"同 ID 同决策"，占位符确定性生成保 KV-cache，read-spill 外溢路径一并保留进占位符）② system.transform 尾部追加纪律三件套（去重不替换）③ compacting 追加五条压缩纪律（不动 prompt）④ autocontinue 恒开 ⑤ chat.params 收口（默认关，`BOCOMHERMES_MAX_OUTPUT_TOKENS` 开启）⑥ 空输出占位符。总开关 `BOCOMHERMES_CTX_GUARD=0` 全关。落点：`plugin/bocomhermes-context-guard.js` + `src/plugin-install.js`（改双插件拷贝）。验证：`scripts/context-guard-selftest.mjs` 25 例全绿（幂等/追加不替换/占位符/预算/总开关）。
- [x] **W2.2 read-spill 会话累计桶**（2026-07-26 已实施；**2026-07-27 默认关闭**：编码实测 40k 线对长周期编码任务太紧、超线后 200 字小读也一律外溢，工具效率腰斩——累计增长归 context-guard① 历史清理层管，桶逻辑保留，`BOCOMHERMES_READ_SPILL_SESSION_MAX` >0 作逃生门）：`sessionBuckets: Map<sessionID,{bytes}>`，累计超线后该会话后续输出一律外溢，替代文本"本会话读取量已到预算线…请改用 grep 定位后分段精读"，metadata.spillBudgetLine 留痕；超 500 会话整表清。落点：`plugin/read-spill.js`。验证：`npm run readspill:test` 25 例全绿。
- [x] **W2.3 权限规则双轨之壳层轨**（2026-07-26 已实施；插件轨搁置、配置轨并入 W3.1）：`settings.json` `permRules:{allow,deny}`；`src/session.js onPermission` 插入 `matchPermRule()`——**deny 在 skill_ 后、一切自动放行前**（分片卡同样生效）：reject + card-note + audit 留痕；**allow 在弹框前**：reply once。设置页"智能体"页签加两个文本域（`ui/settings.html`），get/set-settings 白名单加 permRules（截 200 字/各 100 条防脏值）。规则语法 `工具名(通配)`（CC permissionRuleParser 思想重写）。验证：session:test 补 7 例（deny 即拒/通配/allow 免弹框/不命中走弹框/工具名不匹配/分片同规）共 62 例全绿。

## W3 · 配置与 HTTP API（零/低代码杠杆）

- [x] **W3.1 opencode.jsonc 静态优化包**（2026-07-26 已实施）：新模块 `src/intranet-optimize.js`（mcp-config 同款候选路径/备份风格）——① `tools:{webfetch,websearch,codesearch}:false`（模型不可见级瘦身）② `permission.bash` 通配（git/npm 放、rm -rf/curl/wget 拒 + 合并用户 permRules 的 bash 条，用户意图优先，已有自定义不覆盖）③ `agent.explore.maxSteps:30`（已配置不覆盖）。设置页"通用"页签加「应用内网优化」按钮，一键写入 + 对运行中 serve PATCH 热应用。`experimental.hook.session_completed` 挂蒸馏为可选项（无独立蒸馏脚本，跳过）。验证：临时 `OPENCODE_CONFIG` 实测合并正确、备份生成、已有 maxSteps 保留。
- [x] **W3.2 `PATCH /config` 热更新**（2026-07-26 本机已验证并接入）：`scripts/config-patch-probe.mjs` 幂等写回 + `--behavior` 行为级验证——**本机 opencode 1.18.3 真热生效**（改 permission.bash 规则不重启即拦/放）。已接入 W3.1 的 apply 处理器（写文件持久化 + PATCH 到运行中 serve 热应用）。依据：借鉴总清单 D3。**剩：内网 fork 复验（U1），失败仅热应用失效，文件路径仍生效**。
- [x] **W3.3 权威数据源替换两处"从事件流学习"**（2026-07-26 已实施）：`opencode.js` 新增 `getSessionChildren/getSessionTodo`（404 记 Set 熔断不再发）；回合成功收尾与 R4 自愈路径 fire-and-forget children 映射兜底；`src/session.js` 回合结束后对 wf 卡同步 serve 权威 todo（wfTodos 在场+wf 卡+函数存在三重门，空数组/异常回落现有工具入参学习）。验证：session:test 补 6 例共 70 例全绿。
- [x] **W3.4 `prompt_async` 发送路径（knob 门控，默认关）**（2026-07-26 已实施）：`knobs.promptAsync=1` 时 sendMessage 改 POST `/session/:id/prompt_async`（立即返回），回合收尾复用现有 waitAssistantText（abort 宽限/轮询/onRawMessages 全继承）；404 记熔断回落原 POST /message 路径本次即重发；R4 自愈/abort 赛跑/4xx 降级原路径一行未动。验证：session:test 补 2 例（knob 传参/缺席不传）。**真机验证稳定后再翻默认**。

## W4 · 引擎需求与 fork（需求单闭环）

- [ ] **W4.1 R1（工具输出截断）复核后关闭或降级**：上游 opencode 已自带 2000 行/50KB 截断+落临时文件，read-spill 已拦单次 >8000 字符，128k 纪律①已约束 read ≤400 行——需求单所基于的"无截断"事实已变。动作：W0.3 确认 fork 实际阈值；若 50KB 对 128k 偏高，把需求从"加截断"降级为"阈值可配/调低"。依据：提示词借鉴 §6、需求单 R1。成本：半天（沟通）。
- [ ] **W4.2 R2（历史工具结果清理）随 W2.1 结果降级**：插件钩子在 fork 保留且回写有效 → R2 由壳层插件实现，需求单从"引擎侧"改标"壳层插件已实现"；探针失败 → 保持引擎需求原样。依据：通道方案 A1、需求单 R2。
- [ ] **W4.3 R3（KV-cache 断点）保持引擎需求**：唯一无插件/配置通道的项（M14）。壳层侧兜底已就位（①c 注入铁律、ctx chip 命中率悬停、W2.1 清理决策幂等保前缀）——需求单补一段"壳层已做的缓存纪律"作为引擎侧参照。依据：借鉴总清单 E6。
- [ ] **W4.4 fork 移植项盘点（E1-E6）**：W0.2 拿到 fork 现状后，对照 CC 主循环/并发分区/边流边执行/错误恢复链只做**差距补齐**，防重复移植（上游已有 CompactionPart/batch_tool/chatMaxRetries）。产出：移植差距清单，各项单独立项。依据：借鉴总清单 E 组、通道方案 §4。

## W5 · 观测与制度（贯穿各波）

- [ ] **W5.1 提示词改动纪律入档**："小步单变量 + 两周观测期 + 无效条款靠观测淘汰"写进 AGENTS.md/开发约定；提示词长度按 128k 预算过秤（CC 原则：提示词长度是一等资源）。依据：提示词借鉴 §9.5/§8.1#3。
- [ ] **W5.2 补丁台账随改随记**：W1.1-W2.3 每项提示词改动按 W0.4 模板登记病灶/依据/去留；观测到期复盘一次。
- [ ] **W5.3 自测并入常规回归**：新增的 context-guard-selftest、readspill 新例、session 新例、forkcheck T4/T5 并入发版前回归清单（与既有 mail/tool/compact/card:ui/knowledge/scope/cleanup/session 自测同列）。

## 缓行 / 不做（附理由）

| 项 | 处置 | 理由 |
|---|---|---|
| 壳层统一回合末注入队列（借鉴清单 ⑥/A4） | 缓行 | 动回合生命周期主路径，下次加新注入源时顺手做，不为重构而重构 |
| 知识库后台整固 DreamTask（A5） | 低优先 | 条目量未到瓶颈；蓝本已备（提示词借鉴 §2.2 四阶段流水线） |
| E 组 fork 大改（主循环/并发/边流边执行） | 先盘点后立项 | 见 W4.4 |
| beast.txt 联网强推、CC 安全条款原文、verification 心理战全文、TodoWrite 185 行全文 | 不做 | 内网场景不符 / 128k 预算烧不起，只抽条款重写（提示词借鉴 §9.4） |
| serve 压缩语义混用（原地续用 vs 摘要+新会话） | 观察 | W2.1 压缩纪律上线后对比两种语义实测再定（借鉴总清单 D5） |

## 执行节奏建议

1. **本周**：W0.1-W0.4 + W1.1/W1.2（互不干扰，全无外部依赖）。
2. **下周**：W1.3-W1.5（合并一波提示词改动，进两周观测期）+ 发 W0.2 沟通邮件。
3. **探针绿后**：W2.1 → W2.2 → W2.3（插件三件套按序）。
4. **W0.2 回信后**：W3.1-W3.3、W4.1-W4.4 排期。
5. 每波结束跑全量自测回归（W5.3），台账复盘（W5.2）。
