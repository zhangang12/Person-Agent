# 整改实施计划 —— 内网 opencode × 弱模型（一次性冲刺版）

> **日期**：2026-07-26。**定位**：`docs/优化待办清单-内网opencode×弱模型.md` 的执行版——21 项整改全部展开为可照做的步骤，目标是一个连续冲刺（约 6-8 个工作日）完成。
> **口径**：机制思想借鉴、代码净室重写；提示词文本已写成终稿可直接粘贴，但**同一文件的提示词改动合并为一次提交**，进两周观测期（弱模型服从率对措辞敏感，见提示词借鉴 §9.5）。
> **依赖处理**：fork 能力探针（P0）是插件项的判定门——探针不绿的项**代码照写、默认不启用**，待 fork 维护方回信后开闸，不阻塞本冲刺。

## 执行总表

| 阶段 | 项 | 内容 | 落点 | 验证 | 耗时 |
|---|---|---|---|---|---|
| P0 探针 | P0.1-P0.3 | fork 钩子探针、serve 现状抓包、台账建立 | scripts/ | forkcheck 全绿 | 0.5d |
| P1 提示词包 | P1.1-P1.4 | 交棒摘要/熔断/纪律/技能注入 | store.ts、session.js | compact/session 自测 | 1d |
| P2 插件 | P2.1-P2.3 | read-spill 累计桶、context-guard 合体插件、权限规则 | plugin/ | readspill + 新自测 | 2.5d |
| P3 配置与 API | P3.1-P3.4 | jsonc 静态包、PATCH 热更新、children/todo 数据源、prompt_async | mcp-config.js、opencode.js、session.js、设置页 | permcheck/jsonschema/session 自测 | 2d |
| P4 文档闭环 | P4.1-P4.3 | 需求单复核记录、台账登记、AGENTS.md 纪律 | docs/ | 目检 | 0.5d |
| P5 回归 | P5.1-P5.2 | 全量自测 + 真实 smoke | — | 全绿 | 0.5d |

---

## P0 · 探针与判定门（半天）

### P0.1 forkcheck 增补 T4/T5/T6（2026-07-26 已完成，本机实测）
- **T4**（`experimental.chat.messages.transform` 回写）✅ 本机绿：插件替换历史工具结果为占位符后，下一轮模型只见到占位符、无法逐字引用原文。
- **T5**（`permission.ask` deny）✗ 本机红：插件回 deny 后权限事件仍到达 SSE 并被放行；二进制字符串检索证实 **1.18.3 无该钩子触发点（类型已声明、实现未上线）** → P2.3 插件轨搁置（见 P2.3 修订）。
- **T6**（`experimental.chat.system.transform` 注入）✅ 本机绿：插件往系统提示尾部注入唯一标记后，模型能原样复述。
- 落点：`scripts/fork-capability-probe.mjs`（自起隔离 serve，探针插件放项目级 `.opencode/plugin/`，不污染全局配置，用完即杀）。验证：`npm run forkcheck`。
- **判定门现状**：T4/T6 在公网 opencode 1.18.3 成立 → P2.2 全部子项（含 c/d）通道已验证；**剩余判定门 = 内网 bocomcode fork 复验**（fork 基于的版本/裁剪可能不同，结论以 fork 实测为准）。T5 在公网已红 → P2.3 插件轨默认搁置，fork 若基于更新版本可复验翻案。

### P0.2 serve 现状抓包
- 用 `scripts/opencode-wire-probe.mjs` / `text-output-probe.mjs` 抓内网模型实收请求体：① 系统提示落点（验证"兜底模板"假设，决定 P2.2d 补课内容）② read/grep 截断阈值（决定 P4.1 对 R1 的复核结论）。结果记入台账。

### P0.3 建台账
- 新建 `docs/项目记忆/弱模型行为台账.md`，模板：`日期 | 病灶 | 失败样本 | 补丁（落点） | 依据 | 观测期 | 去留结论`。本冲刺全部提示词改动当天登记。

---

## P1 · 提示词包（1 天，一次提交进观测期）

### P1.1 交棒摘要四项补齐 + 逃生舱
落点：`ui-vue/src/chat/store.ts:1159-1160`（legacy `ui/card.html:987-988` 同步改，保持一致）。
- SUM_PROMPT_CHAT 第 5 条后续三条（WF 版在第 6 条后同样追加）：
  ```
  6) 用户消息清单：逐条列出本段对话中用户发过的所有消息（原话，不含工具结果）
  7) 已读文件清单：本段精读过的文件路径，各附一句"读到了什么"；新会话直接采信这些结论，不要重读这些文件
  8) 下一步：逐字引用最近一条进行中的对话原话，说明做到哪、接着做什么（防意图漂移）
  ```
- 交棒续命消息（RESUME_MSG）追加：`摘要中的已读文件清单直接采信，不要重读；上一棒完整记录见 transcript：{path}，需要细节可回查。`
  实现：`{path}` 由 session.js 落盘路径（appendTranscript 已有）经 card-init ctx 下发到 store；路径暂不可得时降级为"可向用户索要上一棒记录"。
- 依据：提示词借鉴 §2.1。验证：`npm run compact:test` + 一次真实交棒目检（新会话不重读）。

### P1.2 交棒失败熔断
落点：`ui-vue/src/chat/store.ts` compactCore/maybeAutoCompact。
- 拆计数：`autoCompactN`（仅成功交棒计数，棒次显示语义不变）+ `compactFailStreak`（连续失败）+ `lastCompactFailTurn`。
- compactCore 成功 → `compactFailStreak=0`；失败 → `compactFailStreak++`，**不耗 autoCompactN**。
- maybeAutoCompact 双闸：`compactFailStreak>=2` → 停止本卡自动交棒，贴醒目 note"交棒连续失败 2 次，已停止自动重试——请点上下文 chip 手动压缩或检查模型状态"（只贴一次）；`turnCount-lastCompactFailTurn<1` → 冷却一轮。
- 依据：借鉴清单 A1。验证：stub 场景补"连败 2 次停 retry"一例。

### P1.3 弱模型双向纪律 + 元定义（终稿，重写非照抄）
落点：`src/session.js:76-79` `<上下文纪律(128k)>` 块尾部追加：
```
<如实汇报>做成了什么、没做成什么照实说：跑过验证再说"完成"；没法验证就明说"还没验证"；失败贴原始输出，不许粉饰成成功；确认通过的也直说，不要防御性打折扣。</如实汇报>
<委派回报纪律>子 Agent 回报后直接用它的结论；不要偷看子 Agent 的中间过程（会把噪音灌进你的上下文）；它没回报的内容不要编造。</委派回报纪律>
<系统提醒说明>会话中卡片注入的提醒文字是系统侧提醒，与你正在读的文件内容、工具输出无关，按提醒本身行事即可。</系统提醒说明>
```
依据：提示词借鉴 §1.2/§3/§4.2/§1.4。

### P1.4 技能摘要常驻 + 全文预算
落点：`src/session.js` loadSkills（:178-189）与技能注入段（:929 一带）。
- 首发注入的项目背景块尾部追加摘要清单（全量 <500 字）：
  `可用技能（说"用XX技能"即启用，启用后会注入该技能全文）：\n- 技能「{name}」：{desc}`（一行一个）
- 技能全文注入超 4000 字截尾，尾部标注 `（技能正文过长已截断，完整版见 skills 目录）`（memory.md 截尾同款风格）。
- 依据：借鉴清单 ⑤。验证：`npm run session:test` 补两例。

---

## P2 · 插件（2.5 天）

### P2.1 read-spill 会话累计桶（先做，通道已验证）
落点：`plugin/read-spill.js`。
- 进程内 `Map<sessionID,{bytes, spillAll}>`；`tool.execute.after` 先计入本次输出长度；累计超 `BOCOMHERMES_READ_SPILL_SESSION_MAX`（默认 40000）后该会话后续输出**一律外溢**，替代文本：`本会话读取量已到预算线，完整内容在 {path}，请改用 grep 定位后分段精读`。
- 计数只增不减；Map 超 500 整表清（与壳层防涨风格一致）。
- 验证：`npm run readspill:test` 加两例（超线后小输出也外溢 / 未超线放行）。回滚：环境变量调大阈值即失效。

### P2.2 合体插件 `plugin/bocomhermes-context-guard.js`
ESM **单导出**（目录扫描铁律：只认 `{plugin,plugins}/*.{ts,js}`，每个导出都会被当插件调用）。骨架：

```js
const KEEP_TURNS = +(process.env.BOCOMHERMES_CTX_GUARD_KEEP_TURNS || 3)
const BUDGET     = +(process.env.BOCOMHERMES_CTX_GUARD_BUDGET || 40000)
const MAX_OUT    = +(process.env.BOCOMHERMES_MAX_OUTPUT_TOKENS || 0)   // 0=不收口
const cleaned = new Map()   // messageID -> 占位符（同 ID 同决策，保 KV-cache）
const SYS_BLOCK = `<上下文纪律(128k)>…</上下文纪律><如实汇报>…</如实汇报><委派纪律>…</委派纪律>` // 文本见附录 A
const COMPACT_RULES = [ /* 附录 B 五条 */ ]

export default async function () {
  return {
    // a) 历史工具结果清理（T4 门）：保最近 KEEP_TURNS 轮全文；更早的 tool part 替换为
    //    `[已清理:read <path>,原 N 字符,全文在 <spill 路径>]`；决策按 messageID 记忆（幂等）。
    //    同一遍历聚合本轮可见工具结果总字符，超 BUDGET 对次老轮也降级。
    'experimental.chat.messages.transform': async (input, output) => { /* … */ },
    // b) 子 Agent 系统提示（T4 门）：尾部追加，不替换；已含 SYS_BLOCK 则不重复加
    'experimental.chat.system.transform': async (input, output) => {
      if (!output.system.includes(SYS_BLOCK)) output.system.push(SYS_BLOCK)
    },
    // c) 压缩纪律（T4 门）：只往 context 追加，不替换 prompt；autocontinue 保持开
    'experimental.session.compacting': async (input, output) => { output.context.push(...COMPACT_RULES) },
    'experimental.compaction.autocontinue': async () => ({ enabled: true }),
    // d) 参数收口：仅在 MAX_OUT>0 时钳制（安全默认）
    'chat.params': async (input, output) => {
      if (MAX_OUT) output.maxOutputTokens = Math.min(output.maxOutputTokens ?? MAX_OUT, MAX_OUT)
    },
    // e) 空输出占位符：与 read-spill 互补（它管大输出，这里管空输出）
    'tool.execute.after': async (input, output) => {
      if (!String(output.output ?? '').trim()) output.output = '(tool completed with no output)'
    },
  }
}
```

自测 `scripts/context-guard-selftest.mjs`（mock input/output 直调钩子，仿 read-spill-selftest）：① 6 轮历史清理后第 1-3 轮被替换，**再跑一遍输出逐字节相同**（幂等=缓存安全）② 聚合超 BUDGET 次老轮降级 ③ system 尾追加不替换、重复调用不重复 ④ compacting 只追加 context ⑤ 空输出→占位符、非空不动。
安装：走 `src/plugin-install.js` 既有拷贝通道自更新；**T4/T6 本机 opencode 1.18.3 已验证绿（P0.1），fork 复验不绿则不注册进 jsonc `plugin` 清单**（文件照常发布，钩子不生效也不伤）。

### P2.3 权限规则双轨（2026-07-26 实测修订：插件轨搁置）
- **~~插件轨~~**：`permission.ask` 在公网 1.18.3 无实现（P0.1 T5 实测 + 二进制证据），fork 复验翻案前不动工。serve 内"连事件都不出"的硬拦需求由配置轨承接（bash 通配 deny 在 serve 判定层生效，同样无壳层往返）。
- **配置轨（serve 硬拦）**：并入 P3.1 jsonc `permission.bash` map（T5 过程已反证 bash 权限配置在 1.18.3 真生效）。
- **壳层轨（少弹框 UX）**：`settings.json` 加 `permRules:{allow,deny}`；`src/session.js onPermission` 在 AUTO_ALLOW 后、弹框前插 `matchRule()`（~30 行，复用 writeScope detail 解析）：deny → `replyPermission(reject)` + card-note 留痕；allow → `reply('once')`。设置页两个文本域（window.js knobs 合并路径同款）。
- 依据：借鉴总清单 B3/C1、借鉴清单 ①、通道方案勘误（2026-07-26）。规则文件示例：
  ```json
  { "allow": ["bash(git *)", "bash(npm run *)"],
    "deny":  ["bash(rm -rf*)", "bash(curl *)", "bash(wget *)", "write(*.env)"] }
  ```

---

## P3 · 配置与 HTTP API（2 天）

### P3.1 opencode.jsonc 静态优化包
落点：`src/mcp-config.js` doRegister 同款（备份 + 深合并），设置页加"内网优化"一节。
目标合并块（以 P0.2 抓包确认的字段为准）：
```jsonc
{
  "tools": { "webfetch": false, "websearch": false, "codesearch": false },  // 内网无外网：模型不可见级 deny
  "permission": {
    "bash": { "git *": "allow", "npm run *": "allow", "rm -rf*": "deny", "curl *": "deny", "wget *": "deny" },
    "edit": "ask", "webfetch": "deny"
  },
  "agent": { "explore": { "maxSteps": 30 } }   // 弱模型防绕圈；temperature 收口待 P0.2 确认字段后加
}
```
（`experimental.hook.session_completed` 挂知识蒸馏为**可选项**：有独立蒸馏脚本才配，没有就跳过，不新造。）
验证：`npm run permcheck` / `npm run jsonschema` + `GET /experimental/tool` 自省脚本确认瘦身生效。回滚：设置页"恢复默认"→ 还原备份。

### P3.2 `PATCH /config` 热更新
- 探针：PATCH 一个无害字段（如 temperature）→ GET /config 读回确认生效且无需重启。落点：新增 `scripts/config-patch-probe.mjs`（或并入 fork-capability-probe）。
- 绿 → 设置页改动改走 PATCH：`opencode.js` 加 `patchConfig(body)`，body 复用 mcp-config.js 的深合并逻辑。不绿 → 维持"写文件+提示重启"现状，台账标记。

### P3.3 权威数据源替换两处"从事件流学习"
- `opencode.js` 加 `getSessionChildren(id)`（`GET /session/:id/children`）：回合末或 onChildSession 缺失时拉一次，子 Agent 路由不再依赖 SSE 早发。
- `opencode.js` 加 `getSessionTodo(id)`（`GET /session/:id/todo`）：分片收官判定、防停催办改用 serve 权威 todo，不再扒 todowrite 工具入参。
- 落点：`opencode.js` + `src/session.js`。验证：`npm run session:test` 补例（事件缺失时 children 兜底命中；畸形 todowrite 入参不再漏判）。

### P3.4 `prompt_async` 发送路径（knob 门控，默认关）
- `opencode.js` sendMessage 走 `POST /session/:id/prompt_async`（立即返回）+ SSE/pollTurnParts 回收；`knobs.promptAsync` 默认 false，真机验证稳定后再翻默认。
- 收益：POST 不再挂起等回合，R4 在飞断开自愈复杂度可退役（退役留给后续波次，本冲刺只加通道不拆旧路）。
- 验证：stub 双跑（新旧路径各一遍），回合收尾判据一致。

---

## P4 · 文档闭环（0.5 天）

- **P4.1** `docs/内网引擎需求-上下文工程.md` 尾部追加"复核记录（2026-07）"：R1 按 P0.2 抓包结论标"关闭（上游 50KB 截断+read-spill+纪律①已覆盖）"或"降级为阈值可配"；R2 按 T4 结果标"壳层插件已实现/保持引擎需求"；R3 保持引擎需求并补一段"壳层已做缓存纪律"（①c 铁律/ctx chip/清理决策幂等）。
- **P4.2** 台账登记：P1 全部提示词改动 + P2/P3 机制改动按模板入 `docs/项目记忆/弱模型行为台账.md`，观测期两周一栏留空待复盘。
- **P4.3** `AGENTS.md` 追加"提示词改动纪律"一节：小步单变量、两周观测期、无效条款靠观测淘汰、提示词长度过 128k 预算秤。

## P5 · 回归与验收（0.5 天）

- **P5.1 全量自测**：`forkcheck` / `compat` / `permcheck` / `jsonschema` / `mail:test` / `tool:test` / `compact:test` / `card:ui:test` / `knowledge:test` / `cleanup:test` / `scope:test` / `lsp:test` / `readspill:test` / `lspmcp:test` / `session:test` / `ui:typecheck` / `ui:test` / `ui:build` + 新增 `context-guard-selftest`。
- **P5.2 真实 smoke 五连**：① 开卡发一条消息（首发注入生效）② 跑到交棒一次（摘要含已读清单+逃生舱路径）③ 派一个 task 子 Agent（其系统提示含纪律块——T4 绿时）④ 触发一条 deny 规则命令（连弹框都不出）⑤ 设置页改一条规则 PATCH 即时生效（P3.2 绿时）。
- **DoD**：全绿 + 台账登记完毕 + 不绿项均有"待 fork"标记与回滚说明。

## 需要你（用户）做的事（机器做不了的三件）

> 这三件是冲刺的外部依赖，不阻塞 P1-P3 开工，但 W2/W3/W4 的开闸结论等它们的结果。

### U1 · 内网 fork 复验探针（半天，最重要）
1. 把更新后的 `scripts/fork-capability-probe.mjs` 同步到内网机器（连同仓库或直接拷文件）。
2. 内网机器上跑 `npm run forkcheck`（或 `node scripts/fork-capability-probe.mjs`）。T4/T5/T6 会自动用 PATH 里的 `bocomcode` 起隔离 serve（项目级 `.opencode/plugin/`，用完即杀，不碰你的全局配置）；约 5-13 分钟，会真实调几次模型。
3. 把输出贴回来。判读：T4/T6 绿 → P2 插件项开闸；T5 绿 → P2.3 插件轨翻案（公网 1.18.3 无此钩子实现，fork 若基于更新版本可能有）。

### U2 · P0.2 内网 serve 抓包（半天）
内网环境跑：`node scripts/opencode-wire-probe.mjs`、`node scripts/text-output-probe.mjs`。要两个事实：① 内网模型实际收到的系统提示（验证"落兜底模板"假设，决定 P2.2b 补课内容）② read/grep 工具截断阈值现状（决定需求单 R1 关闭还是降级）。结果贴回来。

### U3 · 给 fork 维护方的确认邮件（照抄即发）

> **主题**：bocomcode fork 四项能力确认（壳层插件改造前置）
>
> 我们计划在壳层侧做一轮上下文工程与权限优化，四项结论依赖 fork 现状，请确认：
> 1. **源码可改性与基线**：bocomcode 基于 opencode 上游哪个版本？我们若需提引擎侧需求（如 KV-cache 断点），走什么流程？
> 2. **插件 experimental 钩子**：fork 是否保留了 `experimental.chat.messages.transform`、`experimental.chat.system.transform`、`experimental.session.compacting` 三个插件钩子（公网 1.18.3 已验证前两个可用）？
> 3. **`PATCH /config`**：该端点在 fork 上是否真热生效（免重启）？
> 4. **已有实现**：fork（或上游）是否已有工具并发、边流边执行、会话内压缩的自有实现？避免我们重复移植。
>
> 附：我们用 `scripts/fork-capability-probe.mjs` 做了端到端探针，公网 opencode 1.18.3 结果 T4/T6 绿、T5 红（`permission.ask` 类型已声明但无实现）——fork 侧复验结果会同步给你。

---

## 附录 A · context-guard 系统提示追加块（终稿）

```
<上下文纪律(128k)>你的上下文窗口约 128k tokens，省着用：① 按需精读，不通读整个模块——单次 read ≤400 行（带 offset/limit），grep 先收窄路径与类型；深读大片文件用 task 派子 Agent（它有独立 128k）。② task/delegate_task 指令只写目标+文件路径+边界+回报格式，严禁贴文件原文/大段代码。③ 子 Agent 结论一律落盘成文档，回报只给一句话+路径。</上下文纪律>
<如实汇报>跑过验证再说"完成"；没法验证就明说"还没验证"；失败贴原始输出，不许粉饰成成功；确认通过的也直说，不要防御性打折扣。</如实汇报>
<委派纪律>委派指令=目标+路径+边界+回报格式；回报要自包含（结论带 文件:行号）；不偷看子 Agent 的中间过程，不编造未收到的回报。</委派纪律>
```

## 附录 B · 压缩纪律五条（compacting 的 context 追加）

```
- 保留 todo 计划清单原样逐条及其当前状态
- 保留已读文件清单（路径 + 一句"读到了什么"），新上下文直接采信不重读
- 保留失败证据：已尝试与已排除路径，各附一句原因
- "下一步"逐字引用最近对话原话，防止意图漂移
- 增量更新摘要：保留仍然成立的事实，删除过期事实，合并新事实
```

## 风险与回滚总表

| 风险 | 缓解 |
|---|---|
| T4/T5 不绿，插件项白做 | 代码照写不注册，零副作用；待 fork 回信开闸 |
| 提示词改动引发弱模型新病灶 | 合并一次提交 + 台账 + 两周观测期；单项回滚=还原该段文本 |
| jsonc 写坏导致 serve 起不来 | mcp-config.js 备份机制先行；设置页"恢复默认"一键还原 |
| children/todo 端点在 fork 缺失 | P3.3 保留事件流学习作兜底，端点 404 时自动回落 |
| prompt_async 收尾判据变化 | knob 默认关，旧路径不拆 |

**沟通项（不阻塞冲刺，并行发出）**：给 fork 维护方的确认邮件——① 源码可改性/上游基线 ② experimental 钩子保留情况 ③ `PATCH /config` 热生效 ④ 上游已有的并发/压缩实现（防重复移植）。回信只影响 W4.4 移植盘点的排期，不影响本冲刺任何代码项。
