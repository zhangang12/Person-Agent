import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Capability } from "../types.js"

// 需求 → 改动点定位（只读 + 结构化输出）
export const locate: Capability = {
  id: "locate",
  name: "需求改动点定位",
  description: "按 glossary→capability-map→modules 链路定位改哪，结构化产出",
  triggers: [{ kind: "command", name: "locate" }],
  // 不指定 agent → 用 OpenCode 默认 agent。需要更强隔离再配 req-locator 并填 agent。
  permission: {
    autoAllow: ["read", "grep", "glob", "list"],
    confirm: [],
    deny: ["edit", "write", "bash", "patch"],
  },
  schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "需求理解一句话" },
      files: { type: "array", items: { type: "string" }, description: "改动文件/类/方法，带 文件:行 或 类#方法" },
      tables: { type: "array", items: { type: "string" }, description: "涉及的表" },
      apis: { type: "array", items: { type: "string" }, description: "受影响接口" },
      regress: { type: "array", items: { type: "string" }, description: "需回归项" },
      todos: { type: "array", items: { type: "string" }, description: "存疑 / 待业务确认" },
    },
    required: ["summary", "files"],
  },
  buildPrompt: (ctx) => [{
    type: "text",
    text:
`你是信贷系统需求落点分析者，只读、结论带出处、不臆造。
需求：${ctx.input ?? "（未提供，请在命令后补充需求描述）"}
按仓库 docs/glossary.md → docs/capability-map.md → docs/modules 的链路定位：
1) 把需求里的业务术语翻成代码符号；
2) 找到入口文件/类；
3) 评估涉及表 / 接口 / 受影响模块 / 需回归项。
结论必须带 文件:行 或 类#方法 出处；不确定的进 todos，不臆造。
严格按给定 JSON schema 返回结构化结果。`,
  }],
  onResult: (res, ctx) => {
    const dir = join(ctx.cwd, "out"); mkdirSync(dir, { recursive: true })
    const data = res.structured ?? { summary: res.text }
    writeFileSync(join(dir, "locate.json"), JSON.stringify(data, null, 2), "utf8")
    console.log("\n[locate] 结构化结果：")
    console.log(JSON.stringify(data, null, 2))
    if (!res.structured) console.log("\n(未拿到结构化输出，已存原文；确认模型/版本是否支持 json_schema)")
  },
}
