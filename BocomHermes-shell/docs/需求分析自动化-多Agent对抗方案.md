# 需求分析自动化 · 多Agent 对抗式方案

> 研发流程第一道关(读懂需求)的落地方案。一句话:**用多个互不通气的 Agent 对抗式地读同一份脏需求文档,把意思明确的解释清楚、把意思不明确的拆解清楚,交人工二次确认,确认结论落档、越分析越上手。**
>
> 本文是 2026-06-26 设计讨论的完整记录,供后续继续。**下一步从「对齐引擎的三个待解硬问题」继续(见第八节)。**

---

## 一、背景与纠偏(为什么不是那份信贷大方案)

`docs/信贷-需求到详设-解决方案.md` 那套(领域本体 / 制度库 / 向量 RAG / claim 账本框架 / 状态机闸口)**已判定"落不了地",弃用**。原因:它假设了内网根本没有的一堆东西。

**新方向的地基:内网里唯一可信、可验证的只有两样——代码仓库 + 数据库。** 它们是业务"如其所是"的真相。需求文档是**待核对的主张**。所以不建领域大脑——领域知识本就编码在代码和 DB 里。

---

## 二、核心洞察:需求是脏数据,"拆点"不是抄,是诚实摊开

真实需求文档是没格式、没标准、人写的大白话。把它当成"本来就分好点、照抄下来"是根本性错误。真实的脏长这样:

- 一段话里 **背景吐槽 / 现状 / 诉求 / 约束 / 验收全揉在一起**,边界是糊的;
- 真正的诉求 **藏在抱怨里**("明明还了款额度没恢复"——是 BUG 还是要做的需求?);
- 同一个东西 **好几个叫法**(额度 / 授信 / 敞口 / 限额混用);
- "**顺便 / 最好能 / 上次开会提的 / 看能不能一起做**"——范围根本不确定;
- "**参考信用卡那边的逻辑**"——把外部上下文甩给你,而信用卡是循环授信,跟对公额度模型不是一回事;
- **跨页矛盾**(第 3 节说"自动冻结",第 9 节附录又说"需人工复核");
- **V1 残留**(V2 文档里没删干净的废弃段落,会被当现行诉求);
- **非文字载体**(夹着 Excel 字段表、流程截图、粘进来的邮件往来;截图里的信息抽不出来,要诚实标"这里有张图我读不了")。

因此机器在"拆点"这一步真正该干的,**不是给干净结论,而是诚实地把脏摊开**:每个疑似诉求钉回原话、给置信度、读不准就并列、把藏的 / 存疑的 / 有风险的挑出来。人来认领。**拆点错,后面全错——这是整个产品最重、最值钱的工序。**

---

## 三、核心机制:多Agent 对抗分析(分歧 = 歧义探测器)

让多个 Agent **各自独立、互不通气**地读同一份脏文档,再比对它们的读法:

- **全体读法一致 → 意思明确**:把一致的解释 + 证据合并输出(N 个互不通气的读者都这么读 = 高置信背书)。这就是"把明确的解释清楚"。
- **读法分裂 → 意思不明确**:而分裂出来的几种读法,**正好就是把歧义拆解清楚**。"不明确"不再是空泛的"这里不清楚",而是"3 个 Agent 读出 3 种意思:①②③",直接拿给人选。
- **仅 1 个 Agent(尤其挑刺派)发现 → 隐藏诉求 / 易漏**。
- **跨页 / 自相矛盾 → 冲突卡**(挑刺派 + 历史派专职挖)。

**拆解的力量来自对抗,不是单个 Agent 的自我怀疑**——单个 Agent 不会真的跟自己分歧。这也是单个 opencode Agent 搞不定的根因:它只有一种读法、没有分歧信号,也塞不下"大脏文档 + 双仓 + DB"。

### 角色分化(逼出真分歧)

| 角色 | 读法取向 |
|---|---|
| 业务字面派 | 只读字面要求的是什么 |
| 数据派 | 把一切读成"什么数据 / 字段会变",用 DB 词汇对齐 |
| 流程派 | 读成"什么流程 / 状态流转会变" |
| 挑刺 · 对抗派 | 假设文档是错的 / 不全的,猎杀矛盾、隐含诉求、未写假设 |
| 历史 · 跨页派 | 拿文档跟自己比(V1 残留、跨页冲突),也跟知识库比 |

---

## 四、端到端架构(7 段)

```
脏需求文档(Word/PDF,无格式)
        │
        ▼
① 多Agent 独立阅读 · 互不通气    [业务字面 / 数据派 / 流程派 / 挑刺·对抗 / 历史·跨页]
        │
        ▼
② 对齐引擎 —— 一致=明确,分裂=不明确(技术核心)
     · 全体一致 → 意思明确(自动解释清楚)
     · 读法分裂 → 意思不明确(并列每种读法 = 拆解清楚)
     · 仅 1 个发现 → 隐藏诉求 / 易漏
     · 跨页/自相矛盾 → 冲突卡
        │  ▲ 回灌消解
        ▼  │
③ 代码 + DB 消歧 / 定位(真相字典)
     db_columns_grep + grep 代码 → 收敛歧义 / 坐实缺口,挂 file:line · 表.字段
        │
        ▼
④ 三类清单(给人看):  明确·已解释 | 不明确·已拆解待选 | 矛盾·待裁
        │
        ▼
⑤ 人工二次确认 —— 认领诉求 / 选定读法 / 裁决矛盾(唯一真相源)
        │
        ▼
⑥ 落档 · 项目知识库(人确认 + 证据锚定 · append-only)
        │
        └──────────────► 回灌下次分析(越分析越上手)
```

---

## 五、代码 + DB 是消歧字典(不只是定位改动点)

对分裂的读法和拿不准的术语,fan-out 一批 grounder 去 `db-mcp` 查字段、grep 代码:

- 很多歧义会被真相**收敛**(文档说"额度",在 DB 里只对得上一个概念,分裂就塌缩);
- 收不敛的就**坐实成问题**(`grace_days` 全库无、代码无引用 → 确实是新增,必须问);
- 每条结论挂 `file:line` / `表.字段`,内网当场可点开核对,绝不现编。

---

## 六、人工二次确认 = 唯一真相源

机器只摊开三类清单,**不替人拍板**:

- **明确 · 已解释**:读者一致 + 证据。人只需 ✓ 或纠正。
- **不明确 · 已拆解待选**:原文 span + 并列读法 + grounding 给的推荐读法。人选 / 写真实意图。
- **矛盾 · 待裁**:冲突两端并排。人裁。

人的决定就是 ground truth。这正是"Agent 分析后人工介入二次确认"。

---

## 七、落档知识库:赚来的记忆,不是预建本体

**关键区别**(回应之前被否掉的领域大脑):那是"凭空猜一套本体";这里完全相反——**只有人确认过的结论才落档**,append-only,锚定文档版本 + 代码/DB ref:

- 术语归一:"额度" = `loan_limit.credit_amt`(谁、何时确认,带 ref)
- 已决歧义:"已用不能动" = 读法①(已确认)
- 范围决策:宽限期 移出本期

下次分析,读者和 grounder **先加载这个知识库** → settled 的不再重复问 → 真的"越分析越上手"。它从真实工作里长出来、有人背书、有证据锚——**这是好的记忆,不是被否掉的预建知识库**。

---

## 八、技术核心:对齐引擎 + 三个待解硬问题(明天从这里继续)

对齐引擎决定了"分歧探测"能不能成立,是别人抄不走的核心。至少三个硬问题要啃:

1. **怎么判定两个 Agent"在说同一件事"** —— 它们各自圈的原文 span 会错位、用词不同(一个说"冻结额度",一个说"limit status 改 1")。要靠 span 重叠 + 语义对齐把它们聚成一簇,才能比"读法一不一致"。纯字符串不够,模糊处得上**裁判 Agent**。

2. **"一致"和"分裂"的判据** —— 5 个里 4 个一种读法、1 个另一种,算明确还是不明确?置信度怎么按 读者数 + 视角权重 + grounding 证据 聚合?挑刺派的反对要不要加权(它专职找茬)?

3. **独立性怎么保证** —— 都连同一个 opencode serve,若共享上下文就会"传染",分歧信号就假了。得各自开独立 session、裸上下文、甚至给对立 persona,才逼得出真分歧。

> **明天的起点:对齐引擎 = 优先钻透(它不通,整个产品的"分歧=歧义"立不住)。** 备选支线:③三类清单的二次确认 UI;④落档知识库的存储 schema + 回灌实现。

---

## 九、底座盘点:现成 vs 要建的硬核

**几乎现成(站得住的承重墙):**

| 能力 | 用处 |
|---|---|
| 动态工作流卡(`src/window.js` spawnWorkflow) | spawn 多 Agent 的骨架:单主 Agent 连续上下文自拆+并行派子 Agent+自综合(旧 `src/orch.js` fan-out + `onBeforeBatch` 已退役删除) |
| opencode serve 原生 Read/Grep/Glob | grounder 读代码(不用建 git_grep) |
| `db-mcp`(db_tables/schema/columns_grep/query) | grounder 读 DB,字段级反查 |
| `src/attachments.js` `extractText` | 需求文档解析(PDF/DOCX/XLSX),提出来给本地文件用 |

**新要建的硬核:**

1. **多视角对抗阅读编排** —— 角色分化(5 类 persona)+ 强独立性(独立 session / 裸上下文)。
2. **对齐引擎** —— span 聚类 + 一致/分裂判定 + 置信度聚合 + 裁判 Agent。(最难)
3. **三类清单二次确认 UI** —— 明确/不明确/矛盾;分裂读法并排可选;证据可点开。
4. **落档知识库 + 回灌闭环** —— append-only、证据锚定、加载回灌。

---

## 十、已锁定的产品决策(2026-06-26 用户拍板)

1. **入口** = 独立「需求分析」窗口/向导(不是对话卡里说)。
2. **拆点后停一下** 让人扫一眼圈范围再核对(人审闸口)。
3. **报告** = 交互面板,证据可点开(`file:line` → 编辑器,`表.字段` → 看 schema)。
4. **彻底不碰邮件 / outbox** —— 需求问题就活在面板里读/标记,不外发。
5. 用户是**强视觉型**,要可点的真 UI 原型,不要流程图。

> 今日用 visualize 交互画布演示了 4 版:用户操作流程图 → 交互 UI 原型 → "诚实版拆点"脏文档标注 → 本架构图。用户认可"诚实摊开脏数据 + 对抗分歧"方向。

---

## 十一、为什么单个 opencode Agent 搞不定(存档结论)

- **上下文塞不下**:大脏文档 + 双仓代码 + DB 现状。
- **没有分歧信号**:一个 Agent = 一种读法,无从分辨"明确 vs 不明确"。
- **没有角色对抗**:自我怀疑 ≠ 独立反对;挑刺派/历史派的价值来自它们跟别人不通气。

多 Agent 给的是:独立读法(真分歧信号)+ 并行 grounding + 专职找茬的 critic。

---

## 十二、对齐引擎已锁定的实现决策(2026-06-26 续,用户拍板)

把第八节三个硬问题往实现推时,用户做了三个"从简"决定,以及多模态、UI 的定调。这些是后续编码的硬前提。

### 模型(三问都收敛到"统一 MiniMax M2.5")
- **5 个读者 + 裁判 + grounder 全用 MiniMax M2.5**,不做模型级去相关。
- **代价(写明、别忘):同模型 = 独立性只剩 persona 一条腿。** MiniMax 的盲区 5 个读者会一起踩、然后"全体一致"——这个一致是假的(模型自我点头)。因此去掉模型层后,下面几根补偿腿从可选变**必须**:
  1. persona 要**真对立**(挑刺派硬指令"假设文档是错的";数据派只准用 DB 词汇说话);
  2. **温度拉开 + 裸上下文**(同模型至少让采样发散,且绝不互看输出);
  3. **保守偏置更重要**(同模型更易假一致,阈值更狠地往"不明确"推);
  4. **挑刺派不对称 = 抓共享盲区的主防线**(孤证也能掀旗)。
- **裁判:单个、也是 MiniMax**,只判模糊边界;先单裁判跑起来看错误率,**不上双裁判**(别过度设计)。
- **置信度:只排序 + 打标签,不决策。** 机器永远不替人拍板,分数只用来给三类清单排序/标"明确 vs 不明确";保守偏置——拿不准就往"不明确"推,不纠结 4:1 算不算明确。

### 多模态(Word 内嵌图片)
- 输入只认 **Word(.docx)**,但 **Word 里的图片(流程图/截图/字段表)要切到 Qwen3.6 多模态识别**。
- 管线:解析分两路——文字/表格走 MiniMax 线(mammoth);内嵌图片**逐张喂 Qwen 翻成文字、按原位置插回正文**变成 `[图N:…]`,5 个读者拿到的是"图已翻成字"的统一文本,全程不碰图片。
- 要点:**位置要保留**(第3节流程图≠附录截图);**字段表截图尽量还原成文字表**(数据派的料);**Qwen 读不准要诚实标** `[图N:读不准,原图在此]`(继承"诚实摊开");**翻一次缓存**。
- **命门:这把方案B(按请求传 modelID)重新拉回关键路径**——要在引擎用 MiniMax 的同时单独调一次 Qwen。前提风险:**bocomcode 的 `POST /message` 到底吃不吃 `model` 字段**(见 opencode-serve-api 记忆:model 字段形状按版本变、稳妥是不传)。"能不能程序化切到 Qwen"是整条多模态线能否自动化的命门,**得先用探针验证**(沿用 compat-check 那套,内网跑)。
- 注意:Qwen 是**引擎外的预处理翻译器**(进来时跑一次、跑完即切),不破坏"统一 MiniMax"——对抗引擎(读者+裁判+grounder)仍全 MiniMax。

### UI(两块定清楚,样式沿用现智能体)
- **① 单窗口工作流**:一个窗口、一条竖向工作流——导入 Word → 解析进度(详细:文字/表 + 图片逐张 Qwen 状态)→ 多Agent 分析进度(详细:5 读者各自命中数 + 对齐引擎计数 + grounding 收敛/坐实)→ 汇总结论 + **产物文档**(`需求分析报告_xxx.docx`,可导出 Word / 打开逐条确认)。
- **② 独立逐条确认面板**(从工作流窗口"打开逐条确认"另开):三类清单可筛选(明确/不明确/矛盾/隐藏);每条**钉回原话** + 挂**可点证据**(`表.字段`→看 schema、`file:line`→编辑器);四种确认动作各异(明确→认领/纠正;不明确→并列读法单选+grounding 推荐;矛盾→两端并排裁决;隐藏→纳入/转缺陷/忽略);确认满才走**落档**(append-only)。
- 样式取真实令牌:浅磨砂玻璃窗 + `─ ☐ ✕` 窗钮、深藏蓝字 `#111228`、品牌**紫→青渐变** `#8b5cf6→#0891b2` 只用在主操作与序号球、蓝=信息证据、绿/琥珀/红=三类语义。

### 对齐引擎已落地的砖(`align.js`,纯逻辑可单测,裁判注入)
- **第一块·话题聚簇(硬问题①)**:`spanOverlapRatio`(交集/较短 span)+ 并查集 + `clusterByTopic(findings,{overlapHi,overlapLo,judge})`。`judge(a,b)->'same'|'different'` 注入,缺省 null 只用结构信号;裁判只问"桥接两个不同分量"的模糊对、已同簇则跳过(把调用压到刀刃)。
- **第二块·读法分簇 + 分类 + 置信度(硬问题②)**:`analyzeCluster(cluster,{readingJudge,criticPersona,weightOf,groundingBoost})` + `analyzeClusters`。簇内按 readingKey 二次聚簇,`readingJudge(a,b)->'same'|'different'|'contradict'` 注入(same 合并/different 并列/contradict 标冲突);**分类结构决定、置信度只排序**(`clear/split/conflict/hidden`);**挑刺派不对称**——独家异见不把多数拉成 split,而是单独挂 `riskFlags`;置信度 = 背书 × grounding 加成归一化(`weightOf` 是视角权重的注入点,默认按人头数 1)。
- **跨页桥接(补)**:`clusterByTopic` 增加 `term`(归一化概念)信号——共享 term 但 span 零重叠的对也交裁判,跨页冲突两端才聚得到一起(纯 span 永远聚不上)。
- 自测 `npm run align:test` = **31/31**。

### 端到端管线已落地(`reqanalysis.js`,纯逻辑可单测,run/ground 注入)
整条线串通,用假 run/ground 端到端跑通,自测 `npm run req:test` = **18/18**。

- **多视角对抗阅读** `readDocument(run)`:5 个 persona(业务字面/数据派/流程派/挑刺·对抗/历史·跨页,提示词在 `PERSONAS`,信贷域口径可细化)并行、各自独立 `run`(生产=各自会话/裸上下文)、互不通气;`parseFindings` 容错抽 JSON(剥 `<think>`)+ `locateSpan` 把读者引用的原文片段定位成 `[start,end]`(找不到给 null,不给错偏移)。
- **裁判封装** `makeTopicJudge` / `makeReadingJudge`:包注入 run,构造提示词 + `pickVerdict` 容错解析 same/different/contradict。
- **grounding 编排** `groundCluster(ground)`:对 split/conflict 的每个读法 fan-out 注入的 `ground`(生产=查 `db-mcp`/grep),产出 `groundingBoost` + evidence 回灌再分析(真相收敛/坐实)。
- **报告装配** `assembleReport`:引擎输出 → 逐条确认面板吃的 JSON(钉回原话 quote、并列读法、grounding 证据 ref、三类汇总 summary)。
- **管线** `analyzeRequirement(sourceText,{run,ground,...})`:读者 → `clusterByTopic` → `analyzeClusters` → grounding 回灌 → `assembleReport`,一把出 `{findings,clusters,analyses,report}`。
- **Word 图片预处理** `parseDocx(path,{describeImage})`:mammoth `convertToHtml` 抠图原位留 `[[IMGk]]` 占位 → 注入 `describeImage` 走 Qwen 翻字 → `spliceImageDescriptions` 按位插回(读不准诚实标);`htmlToText`/`spliceImageDescriptions` 纯逻辑已测,`parseDocx` 需对真实 .docx 在装 mammoth 的环境跑。
- **切模型探针** `npm run modelroute [baseURL] [目标关键词]`:验证 serve `POST /message` 吃不吃 `model` 字段、能否按请求切到 Qwen(深搜 serve 回报的 model 元数据 + 自报名作判据);零依赖,**内网由用户跑**,贴回输出据此定多模态线怎么接。

### Electron 集成已接通(`npm start` 启动干净)
管线已接进真 app,端到端可走:**托盘「📄 需求分析（Word）」→ 选 .docx → 单窗口工作流(`reqflow.html`,逐段推进度)→ 跑真分析 → 汇总 + 产物文档 → 打开逐条确认面板(`reqconfirm.html`,三类清单可筛/原话/证据/认领·选读法·裁矛盾)→ 落档**。
- `src/reqanalysis-ipc.js`:`req-analyze`(解析 Word → 5 读者各自独立 opencode 会话跑 `analyzeRequirement` → 推 `req-event`)、`open-req-confirm`、`get-req-report`、`req-landfill`(append-only 写 `userData/req-knowledge.jsonl`)。
- `src/window.js`:`spawnReqAnalysis`/`spawnReqConfirm`/`pickReqDoc` 窗口工厂 + 托盘入口;`main.js` 接 `initReqAnalysis`;`preload.js` 暴露 `reqAnalyze/onReqEvent/openReqConfirm/getReqReport/reqLandfill`。
- 实测:`npm start` 启动无报错(复用 serve :4096、event stream connected、reqanalysis 模块加载正常)。

**仍待办(需你/内网):**
- **`describeImage` 暂为 null** —— Qwen 读图接多模态,等 `npm run modelroute` 探针结论 + OB 配置。当前图片按"读不准"诚实标。
- **persona 提示词口径细化**(信贷域,尤其挑刺派/数据派硬指令)。
- 落档**回灌加载**(下次分析先读 `req-knowledge.jsonl`,settled 的不再问)。

---

## 十三、出详设阶段落地(2026-06-27,扩边界:从"只摊清单"到"出实施方案")

用户拍板把产物从"三类清单"推进到**详设级实施方案**(精确到 `file:line`/`表.字段`/接口签名/改动点/步骤,未决项显式标 `opens`,不替人拍板)。讨论敲定的设计前提:

- **文档小(就几页)** → 上下文焦虑作废(MiniMax M2.5 = 128K,几页随便塞),重心整体移到**代码侧**。
- **两阶段两 grounding 模式**:① 找问题 = 方案B 确定性 `git grep`(代码不进模型上下文);③ 出详设 = agent 只读 locate 命中的**切片**(上下文有界)。
- **统一脊柱 + 按场景插**:对抗读/对齐/三类清单/确认/落档全保留;场景差异只在 `repos` 集 + grounding 策略(场景一多仓+归属、场景三跨层链)。多仓可达性选**方案B**(wrapper 侧跨仓 grep),场景 = `reqProfile.repos[]`(在需求分析入口 UI 里配,不碰 settings.json)。

### 已落地(本次)
- **`reqplan.js`**(纯逻辑、注入式,`npm run plan:test` = 20/20):`collectPoints`(三类清单+人确认决策→待出详设的需求点,ignore/defect 排除、未裁决标 `unresolved`)、`buildPlanPrompt`、`parsePlanCard`(剥 think+解析+铁律兜底:plan 没给 files 则回落挂 locate 命中)、`planRequirement`(locate→读切片→plan→装配,推进度)、`planToMarkdown` 产物文档。
- **`src/reqanalysis-ipc.js`**:跨仓检索原语 `gitGrep`/`readSlice`/`extractAsciiTokens` + `reqRepos()`(读 `reqProfile.repos`,缺省回落 项目目录+后端目录);`locate`=确定性 ascii token + 模型补"中文需求→代码标识符"关键词 + 跨仓 grep+切片;`plan`=独立 opencode 会话;新 handler `req-plan`/`get-req-plan`/`open-req-plan`/`export-req-plan`;**`ground` 已接进 `req-analyze`**(读法 ascii token 跨仓 grep,命中即坐实+证据 ref;中文无 token 则退化,不破坏现有三类清单)。
- **UI**:`ui/reqplan.html`(详设卡:需求点+系统归属+原文+总体改动+影响文件/数据/接口+步骤+`⛑未决`,证据 chip 可点 `openLoc`,带实时进度,导出实施方案);`reqconfirm.html` 底栏加「生成实施方案 →」(落档→开方案面板,出详设在那窗口里跑)。
- **接线**:`window.js` `spawnReqPlan`、`main.js` 透传、`preload.js` 暴露 `reqPlan/onReqPlanEvent/openReqPlan/getReqPlan/exportReqPlan`。`npm start` 启动干净。
- **仓库配置 UI(就近原则)**:`ui/reqflow.html` 导入页加「📁 代码仓库 · grounding 真相源」区——可增删多个仓,经通用 `getSettings().reqRepos` / `setSettings({reqProfile:{repos}})` 读写(白名单已加进 `window.js` get/set-settings),目录选择走 `pick-req-repo`。**配置在需求分析自己的入口,不进设置面板、不让用户手改文件。**

### 仍待办(需你/内网)
- **拿真仓走一遍 ③**:选一份真 .docx → 找问题 → 确认 → 生成实施方案,看 locate 命中质量与详设卡。`locate` 的"中文需求→代码关键词"桥是命门,内网用真仓调提示词。
- **场景一多仓**:在**需求分析导入页**点「+ 添加仓库」配各系统的仓(个网/渠道管理台/渠道整合平台),经 `setSettings({reqProfile:{repos}})` 落盘——**配置就近放在功能入口,不进全局设置面板,更不让用户手改 settings.json**;`system` 归属靠 plan 判 + 路径前缀。
- **`tables` 接 db-mcp** 做字段级坐实(当前 tables 仅由 plan 据切片推断,未反查 DB)。
