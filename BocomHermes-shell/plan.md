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
