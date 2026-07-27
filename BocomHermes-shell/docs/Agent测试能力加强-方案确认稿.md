# Agent 测试能力加强方案（确认稿 v2）—— 只借鉴 Claude Code 设计

> **日期**：2026-07-27。**状态**：待用户确认后开工（v1 开源方案已按用户指示废弃）。
> **问题**：Agent 干完活没有测试思维——不验证就说完成。
> **设计来源**：全部出自 Claude Code v2.1.88 泄露源码（`external/` 调研文档已取证），不掺其它开源方案。

## 0. CC 的"测试思维"设计（四处，附行号）

1. **内置 verification agent**（`built-in/verificationAgent.ts`，全套源码里验证纪律最重的一段）：
   - 角色翻转："Your job is not to confirm the implementation works — **it's to try to break it**"（:10）
   - **点名模型自身的失败模式再反驳**（`=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===`，:53-61）："The code looks correct based on my reading" — **reading is not verification. Run it.**；防"被前 80% 迷惑"（:12）
   - 机可解析输出契约：`VERDICT: PASS|FAIL|PARTIAL`（字面量，"No markdown bold, no punctuation, no variation"，:117-127）
   - 证据块强制：每项检查必须带 "Command run / Output observed" 块；**"A check without a Command run block is not a PASS — it's a skip"**（:82）
   - 预告外部校验："The caller may spot-check your commands by re-running them — if a PASS step has no command output... **your report gets rejected**"（:12）
2. **主提示词完成前验证纪律**（`constants/prompts.ts:210-211`）："Before reporting a task complete, verify it actually works: run the test, execute the script, check the output... If you can't verify (no test exists, can't run the code), **say so explicitly rather than claiming success**"（注释：capy v8 thoroughness counterweight，PR #24302——这是 CC 为治"最小化被误读为偷工"专门打的补丁）。
3. **TodoWrite 诚信四条**（`tools/TodoWriteTool/prompt.ts:162-170`）：四种情况禁标 completed——测试在挂 / 只做一半 / 有未解决错误 / 找不到依赖；卡住时保持 in_progress 并新建一条"要解决什么"的任务。
4. **编排层验证原则**（`coordinator/coordinatorMode.ts:284-293, 325-335`）：验证类任务**用新眼睛**（新 agent，防锚定）；验证 worker 的提示词范句 "Prove the code works, don't just confirm it exists"。

## 1. 改动清单（请确认）

### V1 · 验证棒提示词按 CC verificationAgent 重写（提示词层核心）
现状（99143a6）：`【集成验证】…跑全量构建/测试;失败按归属回派;只汇报:命令+通过/失败数+失败归属文件`——只有流程，没有"反糊弄"纪律。
改为 CC 五件套（中文重写，不照抄）：
1. **角色翻转**："你的任务不是确认它能跑，是**试图搞挂它**。"
2. **点名借口再反驳**："读过代码不算验证，跑一遍才算。""别被前 80% 迷惑——最后 20% 才是问题藏身处。"
3. **输出契约（机可解析）**：最终回报第一行必须是 `VERDICT: PASS|FAIL|PARTIAL`（字面量，不加粗不变体）。
4. **证据块强制**：每项检查必须带 `Command run: <命令>` / `Output observed: <关键输出>` 两行；"**没有 Command run 块的 PASS 是跳过，不是通过**"。
5. **预告外部校验**："壳层会机判你的 VERDICT 与 Command run 块，缺了一律不收。"
落点：`src/window.js` 自动验证棒 vGoal（99143a6 处）。

### V2 · 壳层 VERDICT 机判（harness 层核心，把"report gets rejected"做成真机判）
验证棒收官时解析其最终回报文本：
- 没有 `VERDICT: PASS|FAIL|PARTIAL` 字面量 → **拒收**；
- `VERDICT: PASS` 但全文没有任何 `Command run:` 块 → **拒收**（这就是 CC 点名的 verification avoidance：写 PASS 但没跑）。
- 拒收处理：标 `verifyRejected` 并回派一根验证棒（注明上次拒因；连撞 2 次 → 标"验证未完成"转人工，防循环复用 orchVerifyDone 风格）。
落点：`src/window.js` 验证棒收官判定处（shardSettled 一带）；replay 用例⑥（无 VERDICT→拒收回派 / 有 VERDICT 无 Command run→拒收 / 齐全→放行）。

### V3 · wf 规程收官判据补"诚信四条"
编码规程收官段补（TodoWriteTool/prompt.ts:162-170 的改写）："四种情况禁标完成：测试在挂 / 只做一半 / 有未解决错误 / 找不到依赖；卡住时保持 in_progress 并新建一条'要解决什么'的任务。"
落点：`src/window.js` workflowSystemPrompt 收官段。
⚠ 这是提示词改动——按 AGENTS.md 提示词纪律该等观测期（08-09）后进，但它改的是 wf 规程不是首发注入纪律块，**你定这轮上还是下轮**（决策点 2）。

### V4 · 验证用"新眼睛"原则（文档化，已有等价）
验证棒本来就是新分片——正是 CC 的 Continue vs Spawn（验证用新眼睛、错误方案 clean slate）。在规程文本补一句"验证不由原分片自查（防锚定）"，随 V1 一起改，零额外成本。

### V5 · 提示词"完成=有验证证据"（观测期 08-09 后）
`<如实汇报>` 已有 prompts.ts:211 的等价；观测期后视台账病灶再决定是否补"读过不算验证"。本轮不动。

## 2. 与 v1 开源稿的差异（按你的指示已砍）

- ~~Aider 式"普通卡改后必跑"循环~~：不是 CC 设计（CC 靠提示词 + 验证代理），砍。普通卡靠 `<如实汇报>` + 机判分片/验证棒体系覆盖。
- ~~复现先行、测试伴随检查~~：CC 源码里无对应机制，砍。
- 保留：浏览器自验（cd07fbe，CC verification agent 思想的浏览器形态）、证据闸（BH 自研，与 CC 机判思想同构，是 V2 的天然落点）。

## 3. 成本与回归

V1 半天（vGoal 文本）/ V2 1 天（机判+回派+replay 用例⑥）/ V3 1 小时 / V4 顺带。回归：replay 全套 + session:test + ui:typecheck。

## 4. 决策点（请拍板）

1. **V2 拒收后的处理**：自动回派一次再转人工（建议，复用防循环标记）还是直接标"验证未完成"转人工？
2. **V3 诚信四条**：这轮就上（wf 规程，不等观测期）还是按提示词纪律等 08-09 后随下波？
