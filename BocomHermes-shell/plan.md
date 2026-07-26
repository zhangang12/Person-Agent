# P2b · 子 Agent 侧边栏 + 命令块运行 + wf/orch/shard 迁移(已完成)

## 目标
P2a-2 留尾的三项全部落地,对话页(ui-vue chat)与 legacy card.html 功能对齐,cardImpl 全卡型默认 Vue。

## 范围与落点

### P2b-1 · 子 Agent 侧边栏 ✅
- store:SubAgent 缓冲(各自思考/工具/产出,subAgentDone 经委派块终态勾掉;响应式铁律——subIdx 存数组代理,原对象改属性不触发更新,实测踩中)
- SubAgentRail.vue:右抽屉清单+窗格(思考/ToolBlock/产出),扇出自动滑出(本轮未手动关),徽标=在跑数,轮次快照(20 轮,历史只读概要)
- ToolBlock:taskChild 跳子 Agent 窗格

### P2b-2 · 命令块「运行」 ✅
- store.turnToEl(target 轮):回答渲染进命令块下 details.rout,不占新气泡;rAF 合帧;POST 权威收尾
- FeedView run:DANGER 二次确认(4s 武装态)→ 运行 → 已运行 ✓/出错还原

### P2b-3 · wf/orch/shard 迁移 ✅
- wireInject:card-inject 过 card-send 通道(严格模式/主控唤醒闭环)
- 规划闸:wfSawTodo+!wfExecSeen → planAsk 待批条;批准 → wfPlanApproved IPC + 批准轮;分片静默自动批
- wfAutoAllow:权限自动放行 once + 留痕(仅 wf 卡显式开启)
- 主动交棒:水位 ≥knobs.ctxHandoffPct(0.55)→ compactCore{wf,auto}(SUM_PROMPT_WF + RESUME_MSG 棒次),autoCompactMax 顶
- 分片/主控空答自动重试(≤2,拿到文本归零)
- ShardPanel.vue:分片进度 N/M + chips + 点片就地渲染镜像会话(shardRoot 缓冲;镜像 write/edit → 成果抽屉)
- cardImpl 翻牌:wf/orch/shard 放行 Vue(legacy 仍可退,产物缺失自动回退)

## 验收(全绿)
- ui:typecheck 零错误 / ui:build / ui:test 78 例
- scripts/chat-p2b-stub.cjs 五场景 stub:侧边栏(滑出/清单/窗格/勾终态)/命令块运行/规划闸+批准/自动批准/分片面板 → /tmp/chat-p2b-*.png 目检
- 既有自测全绿(mail/tool/compact/card:ui/knowledge/scope/cleanup/session/readspill)

## 仍不做(后续棒)
- 状态行 ✻/hang 探针/watchdog 绕圈检测/delegate nudge 等 harness 功能(legacy 卡仍有,迁移需单独评估)
- 分片视图只看镜像;shard-pop 弹窗细看仍走 shardFocus IPC

---

# P2c · harness 四件套迁移(已完成)

## 落点(全部对齐 legacy card.html 行为,不再依赖旧卡)
- **状态行 ✻**:StatusLine.vue —— 忙时【✻ 正在跑什么(runningTools 登记,工具名+标题)+ 已耗时 + Esc 中断】,完成短显 ✓ Ns(3.5s 隐);已按 Esc =「正在停止…」(store.aborting)
- **hang 探针**:任何流事件打点 lastStreamAt;忙碌期 15s 一拍 —— 90s 静默提示(长考/挂死),5min 升级(建议 Esc 重试);新一轮复位
- **进展型看门狗**(仅 wf 卡):轮末结算读文件集合,连续 N 轮(默认 3)重合 ≥0.7 且 todo 无进展 → 注入绕圈提醒(带总目标背诵);再绕 M 轮(默认 2)→ 横幅判死权给人;分片无人值守 → 自动中止。账本压缩即清,分片跨棒连续
- **三催**:委派驱动(todo ≥3 + 已干活 + ≥2 轮 + 未派 task → wf 注入派子 Agent 规程/普通卡可见建议,每任务一次)、长任务防停(todo 未完 → wf 自动连催 ≤3 无进展转人工/普通卡「继续执行」)、产出兜底(wf 全勾零落盘 → 补 MD 提醒一次);交棒优先闸(handoffDue 时全静默);轮末链 busy 闸(已有注入开跑时其余催办让到下轮末,防并发回合撞 answerParts);普通卡 ctx ≥90% 提醒一次
- **收尾补齐**:规划闸倒计时自动开跑(knobs.approvalTimeoutMin,双计时器防泄漏,可取消引信)+ 实质执行旁路(没守首轮只规划 → 撤闸注入继续,防软死锁);todo 提醒兜底(knobs.todoNudgeRounds,N 轮没动 todo → 下条消息尾附提醒,只进 serve);看门狗第二级真横幅(中止本轮/知道了)

## 验收
- scripts/chat-p2c-stub.cjs 五场景 stub 全过(状态行/看门狗/委派/防停连催/产出兜底)→ /tmp/chat-p2c-*.png 目检
- ui:typecheck 零错误 / ui:test 78 例 / ui:build / 既有自测全绿
- 至此 legacy card.html 的全部功能性行为已迁移完毕,card.html 仅作 cardImpl=legacy 回退保留
