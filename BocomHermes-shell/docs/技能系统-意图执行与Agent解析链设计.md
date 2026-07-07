# 技能系统设计:从「录制回放」到「意图执行」

> 2026-07-07 定稿方向。上游文档:《浏览器+Agent应用场景.md》(场景清单);本文是机制设计。
> 已落地的地基:确定性降噪(4cbef7c)、人机断点+暂停/续跑原语(515b4b6)。

## 0. 一句话

**录制只是"演示证据",技能是从演示编译出的"意图文档",回放是"意图执行"。**
一步执行不了(值不知道 / 时机不知道 / 元素找不到 / 该不该继续不知道)就暂停,
交给**解析链**(静态值 → Agent → 人)拿到答案再续跑。Agent 不是某个场景的补丁,
而是全生命周期(编译/绑定/运行/验证)的通用解析者。

## 1. 为什么逐事件回放到头了

录制能记下"当时发生了什么",但很多步的**值/动作/时机在录制时刻就注定无法静态重放**:

- 值每次不同且必须人给:验证码/动态令牌/滑块(→ 已做 human-gate)
- 值来自外部数据:填表依据在 Excel/DB 里、测试案例物料对应字段
- 动作参数是运行时才知道的:上传哪些图片、放在哪、什么类别
- 时机不确定:导出要等多久、下载有没有成功
- 页面变了:选择器漂移、多了一步弹窗确认
- 该不该继续要判断:审批流走 A 分支还是 B 分支

**这些不是 N 个特性,是同一个问题**:一步的执行依据不在录制里,需要运行时"解析"。
解析者只有两类:**人**,或**带工具的 Agent**(读 xlsx、查 db-mcp、看下载目录、重读 DOM)。
所以设计目标不是"支持上传/下载/Excel",而是**一个统一的解析机制,让任何缺依据的步都能被解析**。

## 2. 三个概念分离

| 概念 | 是什么 | 对应现状 |
|---|---|---|
| **演示 Demonstration** | 录制的原始事件+字段上下文+快照,只是证据,不再直接执行 | 现在的 `events`(已含 ph/lb/ac/im 字段上下文) |
| **技能 SKILL** | 从演示编译出的意图文档:每步有意图、输入来源、断点、判据 | 现在的 rec JSON + params + skipSteps 的升维 |
| **执行 Run** | 解释器逐步执行 SKILL;缺依据 → 解析链;带数据集则循环 | 现在的 `replayRec` 的升维 |

## 3. SKILL schema v1(向后兼容)

```jsonc
{
  "id": "rec_xxx", "title": "导出用户反馈", "description": "…",
  "startUrl": "http://…",
  "steps": [
    {
      "intent": "填写客户手机号",          // 人话。Agent 编译时起;降级时 = act+sel 拼的占位
      "action": { "act": "input", "sel": "#phone", "selAlt": ["…"] },   // 默认实现 = 录制事件
      "input": {                            // 该步需要值时才有
        "name": "手机号",
        "source": "static|param|resolve",   // ← 核心:值从哪来
        "value": "13800001111",             // static 用
        "key": "p1",                        // param 用(对接现有 params 机制)
        "ask": "本次要填的客户手机号,来自测试物料表"   // resolve 用:对解析者描述这个值的语义
      },
      "gate": { "type": "human|agent|wait", "hint": "短信验证码" },   // 该步不能盲目往下走时才有
      "expect": { "kind": "has_element|no_console|url|text", "value": "…" }  // 该步后置判据(可选)
    }
  ],
  "success": { "kind": "text", "value": "导出成功" },   // 整体成功判据(现有字段)
  "demonstration": { "events": [...], "compaction": {...} }   // 原始证据留档,供 Agent 重编译/审计
}
```

要点:
- **`input.source` 是统一枚举,不是场景枚举**。上传图片 = `resolve`(ask="要上传的发票图片路径");
  Excel 填表 = `resolve`(绑定时批量解成 static);验证码 = `gate:human`。新场景不用改 schema。
- **`gate` 是"不能盲目继续"的统一表达**。human=等人;agent=让 Agent 判断/操作;
  wait=等条件(expect 满足才继续,如"下载目录出现文件"),解析者轮询判定。
- **`action` 可缺省**:纯语义步(如"等导出完成")没有 DOM 事件,只有 gate+expect。
- 老格式(events 数组)执行器继续吃,升格函数 `upgradeToSkill(rec)` 确定性地把
  events→steps(intent 用占位、params→input.key、human 标→gate),**离线可测,无 LLM 也能跑**。

## 4. 统一解析链(resolver chain)

执行器遇到一步缺依据(input.source=resolve / gate / action 执行失败),按序问:

```
① 绑定值:本次 run 预先绑好的值(pre-run 阶段 Agent/人批量填的)      —— 零成本
② Agent 解析:把 {intent, ask, 页面上下文, 可用工具} 发给卡片会话,
   Agent 用 MCP 工具(xlsx/db/doc/browser/文件系统)解出答案写回        —— 需要网关
③ 人解析:顶栏暂停横幅(已做),人现场操作/给值,自动检测+手动继续     —— 永远可用
```

**已做的暂停/续跑原语(`awaitHumanGate` + `browser-replay-resume`)就是③,
②只是同一个 await 换了个应答方**:挂起 → 把解析请求发进会话流 → Agent 调新 MCP 工具
`skill_resolve(runId, stepIndex, value|action)` 写回 → 续跑。链条有超时,②超时/网关挂 → 自动落到③。
**这保证网关不稳时技能永远跑得动(退化成"多几次人工介入",不是"跑不了")。**

选择器漂移的自愈也走同一条链:执行失败(selector not found)→ ② Agent 重读 DOM 重定位
(答复一个新 action)→ ③ 人手点一下、引擎记录修正并回写 SKILL(自愈即自我更新)。

## 5. Agent 的四个介入时机

| 时机 | Agent 做什么 | 降级(网关不稳) |
|---|---|---|
| **编译时**(停录后) | 事件流+页面上下文 → SKILL 草稿:每步起人话名、判断哪些 input 该 param/resolve、哪里是 gate、推断 expect/success;有疑问直接问用户("这步填的 8000 每次一样吗?") | 启发式升格:占位 intent + 现有 param 候选 + humanGate 标注 |
| **绑定时**(运行前) | "用这批物料跑" → 读 Excel/DB 把 resolve-input 批量绑成值;多行数据 → 生成 run plan(循环) | 人在填参卡手工填 |
| **运行时**(执行中) | 解析链② :给值、判 wait 条件、自愈重定位、意外弹窗决策 | 解析链③人工 |
| **验证时**(跑完后) | 逐步 expect + 整体 success 判定,生成报告(升级现有 diffReport) | 现有确定性 diffReport |

## 6. 数据集与循环(run plan)

循环不进 SKILL(保持技能线性、可读),放在**运行计划**里:

```jsonc
{ "skillId": "rec_xxx", "dataset": [ {"手机号":"138…","金额":"8000"}, … ], "onError": "skip|stop" }
```

"跑 20 条测试案例" = Agent 绑定时读物料表生成 dataset → runner 逐行执行技能,
每行是一次独立 run(独立报告)。批量场景(《应用场景》第 5 条)自然落进来。

## 7. 落地路线(每步独立可交付、可回退)

| Phase | 内容 | 依赖网关 | 状态 |
|---|---|---|---|
| 1 | 降噪 + 字段上下文 + human-gate + 暂停/续跑原语 | 否 | ✅ 4cbef7c / 515b4b6 |
| 2 | SKILL schema v1 + `upgradeToSkill` 确定性升格 + `skillMd` 四段式技能文档(.skill.md 与 JSON 并排) | 否 | ✅ steps=语义视图(ei 回指 events,不复制 action 防双真相);events 仍是唯一可执行来源 |
| 3 | 解析链②接入执行器:`skill_resolve`/`skill_pending_resolves` MCP + resolveBus 文件总线 + 三路竞速(Agent/人自动/人手动),超时降级到人 | ②需要 | ✅ |
| 4 | 编译时 Agent(工作流化):「保存为技能」自动触发精修,无手动按钮;工作台开着走 card-inject【可视对话】,否则降级无头;Agent 调 `skill_refine` MCP 提交补丁(refines/ 文件总线)→ `applyRefinePatch` 校验落盘;用户已定的 标题/描述/success 不覆盖 | 是 | ✅ |
| 5 | 数据集批跑:`skill_run_batch` MCP(browser-mcp)→ relay `/skill/run-batch` → `skillRunBatch`(行级容错/互斥/上限200)+ `rowToParamValues` 列名→参数映射(label 精确→key→包含唯一) | 是(Agent 读物料表组 dataset) | ✅ |
| 6 | 自愈回放:失配步不早停 → 6a 确定性语义重定位(placeholder/label/文本 + `relocateSelectors`/`__label__`)/ 6b Agent 重定位(采集页面候选 → `skill_relocate` MCP);命中即 `persistHeal` 回写技能(自更新) | 6b 需要 | ✅ |

**六阶段全部落地。** 后续增强(非阻塞):file-gate(上传图片,input[type=file] 注入)、wait-gate(等导出/下载完成)作为解析链的更多 gate 类型接入,机制已就绪。

## 8. 与 Codex Record & Replay 对照

Codex(2026-06,macOS)):录一遍 → LLM 起草 SKILL.md(步骤/可变输入/成功判据/决策点)→ 复用。
本设计同构,多三件事:**解析链的三级降级**(内网网关不稳是硬约束)、**运行时 gate**(Codex 偏编译时,
我们的验证码/等待/自愈需要运行时解析)、**数据集循环**(测试案例批跑是主场景)。

## 9. 现有资产映射(不重写,只升维)

- `compactEvents/markHumanGates/humanGateHint`(recorder-core)→ Phase 2 升格函数的输入
- `awaitHumanGate + browser-replay-resume + 暂停横幅` → 解析链③,②复用其挂起机制
- `params/applyParams` → `input.source=param` 的实现,填参卡继续用
- `replayRec/waitForEl/waitNetIdle/frameFor` → 执行器内核不变
- `repro-mcp`(assert/self_review/evidence)→ 验证时 Agent 的既有工具;新增 `skill_resolve`
- `xlsx 依赖 + db-mcp/doc-mcp/browser-mcp` → 绑定/运行时 Agent 的工具箱
- `diffReport` → 验证报告升级(加逐步 expect)
