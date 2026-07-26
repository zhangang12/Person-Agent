# P2a 第二棒 · 工具权限 chips + 上线

## 目标
对话核心剩余部分(工具块/todo卡/权限条/提问卡/标题栏chips/成果抽屉/技能菜单/快捷指令条)+ cardImpl 接线上线(默认 Vue,legacy 可退)。

## 阶段

### Stage 1 · 纯函数层 + vitest 契约(先测后码锚定旧行为)
- `lib/tool.ts`:isTodoTool/asObj/fmtInput/todoModel(☒◐⊘☐+meta N/M)/toolStatus/toolSummary(⎿ N字·X.Xk字)/truncIn(4000)/truncOut(20000)/isWriteEditTool/extractFilePath/artAbs/artRel
- `lib/ctxchip.ts`:CTX_FALLBACK 兜底表/ctxCap(128k 顶)/估算口径 chars/1.6/**阈值按设计稿 <60 绿、60-80 橙、>80 红(旧页 70/90,报告标注变更)**/<5% 隐藏
- `lib/perm.ts`:高危判定(复用旧页 DANGER 正则;设计稿新增,旧页无分级,存疑标注)
- `lib/question.ts`:canSend/summaryOf 纯逻辑
- 测试:tool.test.ts / ctxchip.test.ts / perm.test.ts(question 并入 perm.test 或单列)

### Stage 2 · store 扩展
- 新 FeedItem:ToolItem/TodoItem/PermItem/QuestionItem;upsertTool(同 partID 原地更新、插 curAnswer 前、ctx 记账迁入、write/edit → 成果抽屉)
- wirePermission/wireQuestion 挂 wireStream 旁;pendingPerms sticky 计数
- 成果抽屉态:artFiles/lastFinalText/artActivePath
- ctx chip 数据:modelKey/ctxLimitTokens/realTokens/cacheHit;refreshCtxLimit/pollRealUsage;compactCore(压缩续聊)+ resetConversation
- verbose(localStorage cardVerbose)、hb(onServeHealth)、activeSkill(submit→cardSend 第三参)

### Stage 3 · 组件
- ToolBlock.vue(details 折叠、verbose 联动、⎿ 摘要、截断提示)
- TodoCard.vue(一等公民卡)
- PermBar.vue(橙/红;高危无「总是」;Y/A/N 键盘快捷键=设计稿新增)
- QuestionCard.vue(k-quiz 单/多选/custom/跳过/定格留痕)
- ArtDrawer.vue(右抽屉:最终结论+文件清单+readFileText 预览)
- TitleBar.vue 改:model chip+KMenu、ctx chip(点击→KDialog 压缩确认)、hb 灯、verbose 钮、art 钮+badge
- ComposerBar.vue 改:技能 slash 菜单+技能 chip、快捷指令条(QUICK+查看本次改动+我的记忆弹层)
- ChatApp.vue 改:perm sticky 条、Y/A/N 全局键、ArtDrawer 挂载
- chat.css 追加样式(只吃 tokens)

### Stage 4 · 接线上线
- window.js:203 cardImpl 开关(wf/orch/shard 强制 legacy)
- shell/store.ts:cardImpl 读取 + spawnChat src 选择('./chat.html' vs '../card.html')

### Stage 5 · 验收
- ui:typecheck / ui:build / ui:test 全绿
- stub 截图:工具折叠+展开、todo、权限橙/红、提问单/多选、ctx 三态、成果抽屉、模型菜单 → /tmp/chat-p2a2-*.png 目检
- 真机冒烟:npm start 15s ×2(默认 vue + cardImpl:legacy 回退,测完还原)
- 7 项既有自测全绿
- 一个 commit

## 不做(留 P2b)
- 子 Agent 侧边栏(ev.sub 仍只计数)
- 命令块「运行」动作(turn target 轮)
- wf/orch/shard 卡迁移(强制 legacy + unsupportedMode 占位)
- 状态行 ✻/hang 探针/watchdog/delegate nudge 等 harness 功能
