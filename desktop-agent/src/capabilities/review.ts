import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Capability } from "../types.js"

// 代码评审（只读）：评审目标项目当前 git 改动
export const review: Capability = {
  id: "review",
  name: "代码评审",
  description: "评审当前 git diff：正确性 / 空指针 / SQL注入 / 事务 / 金额单位",
  triggers: [
    { kind: "command", name: "review" },
    { kind: "hotkey", combo: "Ctrl+Alt+R" },
  ],
  // 不指定 agent → 用 OpenCode 默认 agent（无需在 OpenCode 侧预配）。
  // 想要更强的只读隔离时，再在 OpenCode 配一个 reviewer agent 并填 agent: "reviewer"。
  permission: {
    autoAllow: ["read", "grep", "glob", "list", "bash"], // 注意：bash 仅为执行 git diff，下行已限制
    confirm: [],
    deny: ["edit", "write", "patch"],
  },
  buildPrompt: (ctx) => [{
    type: "text",
    text:
`你是信贷系统的资深代码评审者，只读分析、不改文件、不臆造。
评审当前工作区的 git 改动（先 git diff 看变更）。按"必改 / 建议 / 可忽略"三档输出。
重点检查：
- 空指针 / 边界缺失
- MyBatis \${} 拼接导致的 SQL 注入
- 事务边界是否正确
- 金额单位（分/元）混用
- 状态机被绕过、直接 set 状态字段
每条结论标注 文件:行 出处；不确定的标【存疑】，不臆造。
术语先查 docs/glossary.md，定位先查 docs/capability-map.md。${ctx.input ? "\n额外关注：" + ctx.input : ""}`,
  }],
  onResult: (res, ctx) => {
    const dir = join(ctx.cwd, "out"); mkdirSync(dir, { recursive: true })
    const file = join(dir, "review.md")
    writeFileSync(file, res.text || "(无文本输出)", "utf8")
    console.log(`\n[review] 已写出 ${file}\n`)
    console.log(res.text)
  },
}
