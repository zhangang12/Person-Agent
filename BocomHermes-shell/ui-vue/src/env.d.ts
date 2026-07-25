// ui-vue 环境声明:.vue 模块 + window.BocomHermes 桥类型
// 桥类型按 preload.js 实读签名逐一声明(P0 先覆盖 shell 已用频道),
// 未覆盖的频道由 [key: string]: any 兜底,渐进补齐。

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/** preload.js 暴露的渲染进程唯一 API 面(节选,详见 preload.js 注释) */
interface BocomHermesBridge {
  // ── 主窗口(shell)频道 ────────────────────────────────────────────
  /** 桌面主窗口(shell.html) */
  openMain: () => Promise<any>
  /** 主窗口:热键/托盘切视图 */
  onShellView: (cb: (p: { view: string }) => void) => void
  /** 主窗口:快捷输入层唤起 */
  onShellQuickOpen: (cb: (p: { text?: string }) => void) => void
  /** 主窗口:发卡收口 → 对话视图开/激活会话 */
  onShellSpawn: (cb: (p: { id?: string; title?: string; sid?: string; msg?: string; disp?: any; orch?: any; wf?: any }) => void) => void
  /** 主窗口:会话忙闲转发 */
  onShellSessStatus: (cb: (p: { wcId: number; busy: boolean }) => void) => void
  /** 收回:钉出窗关闭 → 会话回主窗口侧栏 */
  onSessionReattached: (cb: (p: { sid: string }) => void) => void
  /** 活动会话清单(侧栏「会话」区) */
  sessionList: () => Promise<any[]>
  /** 关闭内嵌会话(走卡关闭清理链,幂等) */
  sessionClose: (wcId: number) => Promise<any>
  /** 钉出:内嵌会话 → 独立迷你卡 */
  sessionPinOut: (arg?: { sid?: string; x?: number; y?: number }) => Promise<any>
  /** webview guest → 宿主 shell 回写绑定;顶层窗调用静默吞掉 */
  cardBoundEmit: (meta: Record<string, any>) => void
  // ── 主题 / 项目 / 设置 / 历史 ────────────────────────────────────
  getTheme: () => string
  setTheme: (t: string) => void
  onTheme: (cb: (t: string) => void) => void
  getProject: () => string
  getSettings: () => Record<string, any>
  setSettings: (patch: Record<string, any>) => Promise<any>
  getHistory: () => any[]
  // ── 内嵌浏览器 / 工作流 / 引擎 ──────────────────────────────────
  openBrowser: (url?: string) => Promise<any>
  /** 编排并发真值:{running, max},只读 */
  wfRunningCount: () => Promise<{ running: number; max: number }>
  onServeHealth: (cb: (p: any) => void) => void
  onFillInput: (cb: (text: string) => void) => void
  probeNow: () => Promise<any>

  /** 兜底:未逐一声明的频道(preload.js 为唯一事实源) */
  [key: string]: any
}

interface Window {
  /** preload 桥;纯浏览器/lab 环境下为 undefined,组件不得强依赖 */
  BocomHermes?: BocomHermesBridge
}
