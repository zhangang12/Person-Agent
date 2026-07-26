# 工作汇总：内网 opencode × 弱模型 全面整改（2026-07-26）

> 一句话：针对内网 serve（bocomcode fork）和弱模型（128k）两个基本面，把调研阶段的三份外部文档（Claude Code 借鉴系列）落成了一整套可运行的机制 + 提示词 + 配置改造，全部带自测，本机验证全绿。

## 一、为什么做：四个实测病灶

1. **上下文烧得太快**：128k 窗口下三四个大文件就能吃掉 70-90%——"还没读完就触发压缩"；更隐蔽的是"十次 6k 中等输出累计灌爆"（单次不超标，总量超标）。
2. **交棒质量差**：换棒后新会话把上一棒精读过的文件原样重读一遍（读取预算双份烧），任务意图还会漂移。
3. **弱模型行为病**：没验证就宣布完成、失败粉饰成成功、委派时把文件原文贴进指令、空工具输出后卡壳。
4. **操作摩擦大**：内网日常 bash/edit 每次都要点一次批准；想"永远拒绝某类命令"只能改代码。
5. **结构性盲区**：task 子 Agent 是全新会话，壳层的首发注入**根本管不到它们的系统提示**。

## 二、做了什么：十二项改造总览

| # | 改造 | 解决什么 | 落点 |
|---|---|---|---|
| 1 | 交棒摘要四项补齐 | 病灶 2 | `ui-vue/src/chat/store.ts`、legacy `ui/card.html` |
| 2 | 交棒失败熔断 | 摘要失败连烧额度 | `ui-vue/src/chat/store.ts` |
| 3 | 弱模型双向纪律注入 | 病灶 3 | `src/session.js` |
| 4 | 技能摘要常驻+全文预算 | 模型不知道有哪些技能、技能全文无上限 | `src/session.js` |
| 5 | read-spill 会话累计桶 | 病灶 1（累计灌爆） | `plugin/read-spill.js` |
| 6 | context-guard 合体插件 | 病灶 1（历史结果）+ 盲区 + 压缩裸奔 + 空输出 | `plugin/bocomhermes-context-guard.js`（新） |
| 7 | 权限规则（deny/allow 通配） | 病灶 4 | `src/session.js`、`ui/settings.html` |
| 8 | 内网优化配置包 | 无外网工具占工具表、权限无静态层 | `src/intranet-optimize.js`（新）+ 设置页按钮 |
| 9 | PATCH /config 热应用 | 改配置要重启 serve | `scripts/config-patch-probe.mjs` + 8 的处理器 |
| 10 | children/todo 权威数据源 | 子 Agent 路由靠猜、收官判定扒工具入参 | `opencode.js`、`src/session.js` |
| 11 | prompt_async 发送通道 | POST 挂起等回合、在飞断开 | `opencode.js`（knob 默认关） |
| 12 | fork 能力探针 T4/T5/T6 | fork 能力面不明、方案无验证手段 | `scripts/fork-capability-probe.mjs` |

## 三、逐项说明（问题 → 方案 → 验证）

### 1. 交棒摘要四项补齐（防漂移、防重读）
- **问题**：换棒后新会话重读已读文件（预算双份烧）、意图漂移。
- **方案**：对照 Claude Code 压缩模板给 SUM_PROMPT 补四条——① 下一步**逐字引用**最近对话原话（CC 防漂移核心手法）② 全部用户消息逐条列出 ③ 已读文件清单各附一句"读到了什么"（下一棒直接采信不重读）④ transcript 落盘路径作"逃生舱"（细节可回查）。续命消息同步加"已读文件清单直接采信"。
- **验证**：ui:typecheck/compact:test 全绿；已进两周观测期（台账跟踪）。

### 2. 交棒失败熔断（CC autoCompact 同款）
- **问题**：摘要失败一次也消耗一棒额度，下轮立即重试，病态循环烧到额度耗尽。
- **方案**：拆成功/失败两个计数——失败不耗额度、成功复位、**连败 2 次停自动重试转人工**（醒目提示）、失败隔一个轮末冷却。CC 的熔断注释里记着真实事故数据（单会话连败 50+ 次、全球日白烧 25 万次调用）。
- **验证**：ui:typecheck 全绿。

### 3. 弱模型双向纪律注入（治虚假声明）
- **问题**：没验证就宣布完成、失败粉饰成成功；委派后偷看子 Agent 过程、编造未收到的回报。
- **方案**：首发注入追加三段（重写非照抄 CC）：`<如实汇报>`（跑过验证再说完成；失败贴原始输出；**确认通过也直说，不许防御性打折**——CC 的双向纠偏写法）、`<委派回报纪律>`（直接用结论/不偷看/不编造）、`<系统提醒说明>`（防把注入提醒误归因于当前文件）。
- **验证**：session:test 全绿。

### 4. 技能摘要常驻 + 全文预算
- **问题**：模型不知道本机有哪些技能可用（摘要只给用户挑）；技能全文是注入侧唯一无预算的口子。
- **方案**：技能摘要清单（≤800 字截断）拼进项目背景块尾部；技能全文注入超 4000 字截尾标注（CC 的 frontmatter 摘要常驻思想）。
- **验证**：session:test 全绿。

### 5. read-spill 会话累计桶（第二道闸）
- **问题**：单次外溢（>8000 字符）已被 read-spill 治住，但"十次 6k 中等输出累计 60k"没人管。
- **方案**：插件按会话累计输出字符，累计超 40k（env 可调）后**该会话后续输出一律外溢**，替代文本引导"grep 定位后分段精读"。
- **验证**：自测 25 例全绿（超线外溢/分桶隔离/0 关闭）。

### 6. context-guard 合体插件（本次最重头）
新插件 `plugin/bocomhermes-context-guard.js`，六个钩子：
- **历史工具结果清理（R2 需求）**：发给模型前，保最近 3 轮工具结果全文，更早的替换为 `[已清理:read <路径>,原 N 字符]`；聚合预算 40k 顺带降级。**清理决策按 partID 记忆（同 ID 同决策）**——前缀逐字节稳定，保住 KV-cache 命中（CC 用缓存命中率换来的教训）。
- **子 Agent 系统提示注入**：128k 纪律+弱模型纪律追加到 system 数组尾部——**补上了壳层管不到 task 子 Agent 系统提示的结构性盲区**。
- **压缩纪律五条**：serve 被动压缩时摘要不再裸奔（todo 原样逐条/已读清单/失败证据/下一步逐字引用/增量锚定）。
- **压缩后自动续跑**（防停）、**maxOutputTokens 收口**（默认关）、**空输出占位符**（CC 实测：空 tool_result 会让模型零输出卡壳）。
- **验证**：自测 25 例全绿（清理幂等逐字节相同/追加不替换/预算降级/总开关）。`npm run ctxguard:test`。

### 7. 权限规则（deny/allow 通配）
- **问题**：逐次点批准是日常最大摩擦；想永远拒绝某类命令只能改代码。
- **方案**：`settings.json` 加 `permRules:{allow,deny}`，语法 `工具名(通配)`（如 `bash(git *)`、`bash(rm -rf*)`）。**deny 在一切自动放行之前**（分片无人值守卡同样生效）直接拒+留痕；**allow 在弹框前**免批准。设置页两个文本域即改即存。
- **关键事实**：原计划的"插件 permission.ask 轨"被实测否掉了（见第四节），收敛为壳层轨+配置轨。
- **验证**：session:test 补 7 例（deny 即拒/通配/allow 免弹/分片同规），共 62 例全绿。

### 8+9. 内网优化配置包 + PATCH 热应用
- **问题**：无外网工具（webfetch/websearch/codesearch）留在工具表里制造失败循环；改配置要重启 serve。
- **方案**：设置页"应用内网优化"一键写入 opencode.jsonc（备份+合并，已有自定义不覆盖）：tools 瘦身（模型不可见级 deny）、`permission.bash` 命令通配（serve 原生能力）、`agent.explore.maxSteps:30`；写文件后**对运行中的 serve 做 PATCH /config 热应用**（本机实测：改规则不重启即生效）。
- **验证**：临时配置实测合并正确；PATCH 探针幂等+行为级双过。

### 10. children/todo 权威数据源
- **问题**：子 Agent 会话路由靠 SSE 事件学习（事件早发晚发决定成败）；分片收官判定扒 todowrite 工具入参（弱模型参数畸形会漏判）。
- **方案**：`GET /session/:id/children` 回合末兜底建映射；`GET /session/:id/todo` serve 权威 todo 直接注册。fork 无端点自动熔断回落现有学习路径，不伤现状。

### 11. prompt_async 发送通道（knob 默认关）
- **问题**：POST /message 挂起等回合结束，进程断开要自愈一整段复杂度。
- **方案**：`POST /session/:id/prompt_async` 立即返回 + 现有 SSE/轮询回收；`knobs.promptAsync` 门控，默认关，真机验证稳后再翻默认。

### 12. fork 能力探针（T4/T5/T6）
- **问题**：全部 serve 侧方案的可行性前提不明——fork 保不保留 experimental 钩子？
- **方案**：forkcheck 新增三个探针，自起**隔离 serve**（探针插件放项目级 `.opencode/plugin/`，用完即杀不污染配置）真实调模型验证。

## 四、三个关键实测发现（改变了方案走向）

1. **`experimental.chat.messages.transform` / `system.transform` 在公网 opencode 1.18.3 端到端可用**（T4：模型只见到占位符；T6：模型能复述注入的系统提示标记）——原以为"够不着、只能等 fork"的机制（历史清理/子 Agent 系统提示/压缩定制）其实插件就能做，需求单 R2 据此降级。
2. **`permission.ask` 钩子名存实亡**：类型已声明但 1.18.3 二进制无触发点（T5 实测 + 字符串证据）——权限插件轨搁置，权限规则改走壳层+配置双轨，反而更简单。
3. **`PATCH /config` 真热生效**（行为级验证：改 permission.bash 规则不重启即拦/放）——设置改动免重启 serve 的通道打通。

## 五、借鉴来源与合规

- **机制与提示词写法**：Claude Code v2.1.88 泄露源码（`external/` 下六份调研文档：架构分析/Thesirix 补充/借鉴清单/serve 通道方案/借鉴总清单/提示词工程借鉴）。**合规口径：机制思想可借鉴，代码与提示词一律净室重写**——泄露源码无 license，银行内网对可辨识复制零容忍。
- **引擎通道**：opencode 官方仓库一手提示词与插件/SDK 类型定义（`anomalyco/opencode`），全部经本机端到端探针验证，不靠猜。

## 六、还需要你做的（已写进整改计划 U1-U3）

1. **内网 fork 复验**：把 `scripts/fork-capability-probe.mjs` 带到内网跑 `npm run forkcheck`（T4/T6 绿 → 插件项开闸；T5 绿 → 权限插件轨翻案）。
2. **P0.2 抓包**：内网跑 `opencode-wire-probe.mjs` / `text-output-probe.mjs`，确认模型实收系统提示与截断阈值。
3. **发确认邮件**（草稿在整改计划 U3，照抄即发）：fork 基线版本/钩子保留/PATCH 热生效/已有实现。

**观测期**：全部提示词改动已进 `docs/项目记忆/弱模型行为台账.md`（观测期至 2026-08-09），两周后按台账逐条复盘"保留/改写/删除"。提示词纪律（小步单变量/长度预算/写法库/位置纪律）已写入 `AGENTS.md`。

## 七、验证清单（2026-07-26 全绿）

`session:test` 62 例 / `readspill:test` 25 例 / `ctxguard:test` 25 例 / `compact:test` 142 例 / `card:ui:test` 153 例 / `scope:test` 27 例 / `knowledge:test` 59 例 / `cleanup:test` 27 例 / `mail:test` 15 例 / `tool:test` 69 例 / `ui:typecheck` 零错误 / `forkcheck`（T1-T6）/ `config-patch-probe --behavior` / `ui:build`。
