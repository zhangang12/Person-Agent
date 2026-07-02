# BocomHermes — 个人桌面研发智能体

> 一个跑在你桌面、用**内网私有化模型**、**数据永不出门**的个人 AI 研发智能体。
> 形态：可拖动的**透明玻璃对话卡**，多卡并行 = 多个隔离会话。
> 底座：**opencode serve 的外层封装**——只消费 serve 的 HTTP API，不碰 opencode 自身配置。

## 现状
- **L1（单兵）已成型、可打包 exe**：真会话 / 逐 token 流式 / 内联权限 / 多项目隔离（按目录建独立 serve 的连接池）/ Markdown+表格 / `文件:行` 跳转 / 双主题 / 系统托盘 / 无感启动。
- 详细路线与差距见《产品蓝图》。

## 仓库结构
```
.
├── BocomHermes-shell/      ← 产品代码（Electron 桌面壳）。运行/打包见其 README
├── desktop-agent/      ← 参考：零依赖 TS host 脚手架（CLI/REST 入口的雏形）
├── BocomHermes-产品蓝图.md          ← 愿景 / 三级跳 / 五招牌 / Backlog / KPI / 风险 / 竞品借鉴
├── BocomHermes-产品设计规范.md       ← 设计系统：玻璃材质 / 色彩 / 字体 / 动效 / 组件 / 双主题
├── 桌面智能体架构-基于OpenCodeServe.md ← 技术架构 + opencode serve API 参考（实测）
└── 信贷系统Wiki生成手册-OpenCode执行版.md ← 项目知识底座（给智能体喂的业务/代码地图）
```

## 快速开始
```powershell
cd BocomHermes-shell
npm install          # 国内 Electron 镜像见该目录 README
npm start            # 开发运行
npm run dist         # 打包出 exe（dist/）
```
前提：`opencode`（或打包后默认 `bocomcode`）在 PATH，且已配好一个内网模型。

## 文档导航
| 文档 | 看它解决什么 |
|---|---|
| [产品蓝图](BocomHermes-产品蓝图.md) | 这产品要长成什么样、怎么排期（含对标 Hermes/OpenClaw） |
| [产品设计规范](BocomHermes-产品设计规范.md) | 长什么样、怎么实现一致的视觉与交互 |
| [架构与 serve API](桌面智能体架构-基于OpenCodeServe.md) | 外壳怎么跟 opencode serve 对接 |
| [BocomHermes-shell/README](BocomHermes-shell/README.md) | 怎么跑、怎么打包、怎么接真引擎 |
| [信贷系统 Wiki 手册](信贷系统Wiki生成手册-OpenCode执行版.md) | 怎么让智能体看懂这套信贷代码 |

## 设计铁律
1. **opencode serve 的外层封装**：只走 serve API（会话/事件/权限），不改 opencode 配置/模型。
2. **数据不出门**：模型私有化、内网部署；写/执行操作经确认；全程可审计（规划中）。
3. **能力即扩展**：新功能在外层加（技能/触发/集成），引擎不动。

仓库：https://github.com/zhangang12/Person-Agent （私有）

<!-- 测试改动:验证工作分支 → PR → 合并 main 流程(2026-07-02) -->

