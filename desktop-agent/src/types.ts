// 能力插件契约 —— 新增一种研发工作流 = 在 capabilities/ 下加一个实现本接口的模块

export type Trigger =
  | { kind: "command"; name: string }                  // CLI / REST: /run/<name>
  | { kind: "hotkey"; combo: string }                  // 全局热键（由 AHK 调 REST 实现）
  | { kind: "fileWatch"; glob: string }                // 文件变更触发（预留）
  | { kind: "schedule"; cron: string }                 // 定时（预留）
  | { kind: "event"; match: (e: any) => boolean }      // 监听 OpenCode 事件（预留）

export interface PermissionPolicy {
  autoAllow: string[]   // 自动放行的工具名（如 read/grep/glob/list）
  confirm: string[]     // 需人工确认（第一版默认拒绝，见 host 的 AGENT_AUTO_APPROVE）
  deny: string[]        // 直接拒绝（如 edit/write/bash/patch）
}

export interface RunContext {
  cwd: string                       // 目标项目根（OpenCode 在此读 AGENTS.md / docs）
  input?: string                    // 用户输入 / 工单 / 需求文本
  selection?: string                // 编辑器选区（预留）
  vars: Record<string, string>      // 触发时携带的变量
}

export interface RunResult {
  text: string                      // 汇总的文本产出
  structured?: any                  // 当 capability.schema 存在时的结构化产出
  raw?: any                         // 原始响应（排查用）
}

export interface Capability {
  id: string                        // "review" | "locate" | ...
  name: string
  description: string
  triggers: Trigger[]
  agent?: string                    // 用哪个 OpenCode Agent（Plane-1，.opencode/agent/*.md）
  model?: string                    // 可覆盖模型，如 "intranet/qwen2.5-coder-32b"
  permission?: PermissionPolicy
  schema?: any                      // JSON Schema：需要结构化产出时提供
  buildPrompt(ctx: RunContext): any[]                  // 返回 message parts 数组
  onResult(res: RunResult, ctx: RunContext): void | Promise<void>
}
