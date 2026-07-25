// KToaster 的状态存储与 useToast 组合式 API
// 契约(interactions.html 04):五型 success/error/warning/info/loading;
// 顶中栈,最多叠 3 条(超出挤出最旧);3s 自隐(error 5s,loading 常驻待 dismiss);
// action 槽(如「撤回」)。
import { reactive } from 'vue'

export type KToastType = 'success' | 'error' | 'warning' | 'info' | 'loading'

export interface KToastAction {
  label: string
  onClick: () => void
}

export interface KToastItem {
  id: number
  type: KToastType
  message: string
  /** 自隐时长(ms);0 = 常驻(loading 默认) */
  duration: number
  action?: KToastAction
  /** 退场动画标记(260ms 后真删) */
  leaving?: boolean
}

/** 契约默认值 */
export const TOAST_DURATION: Record<KToastType, number> = {
  success: 3000, error: 5000, warning: 3000, info: 3000, loading: 0,
}
export const TOAST_MAX = 3

/** 全局单例栈(每窗口一份;顶中) */
export const toastStack = reactive<KToastItem[]>([])

let seq = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function dismiss(id: number) {
  const t = toastStack.find((x) => x.id === id)
  if (!t || t.leaving) return
  const timer = timers.get(id)
  if (timer) { clearTimeout(timer); timers.delete(id) }
  t.leaving = true
  // 退场仅 fade,260ms(契约),动画结束真删
  setTimeout(() => {
    const i = toastStack.findIndex((x) => x.id === id)
    if (i >= 0) toastStack.splice(i, 1)
  }, 260)
}

function push(type: KToastType, message: string, opts?: { duration?: number; action?: KToastAction }): number {
  const t: KToastItem = {
    id: ++seq, type, message,
    duration: opts?.duration ?? TOAST_DURATION[type],
    action: opts?.action,
  }
  toastStack.push(t)
  // 最多叠 3 条:超出挤出最旧(优先挤非 loading)
  while (toastStack.filter((x) => !x.leaving).length > TOAST_MAX) {
    const victim = toastStack.find((x) => !x.leaving && x.type !== 'loading') || toastStack.find((x) => !x.leaving)
    if (!victim) break
    dismiss(victim.id)
  }
  if (t.duration > 0) timers.set(t.id, setTimeout(() => dismiss(t.id), t.duration))
  return t.id
}

export function useToast() {
  return {
    success: (message: string, opts?: { duration?: number; action?: KToastAction }) => push('success', message, opts),
    error: (message: string, opts?: { duration?: number; action?: KToastAction }) => push('error', message, opts),
    warning: (message: string, opts?: { duration?: number; action?: KToastAction }) => push('warning', message, opts),
    info: (message: string, opts?: { duration?: number; action?: KToastAction }) => push('info', message, opts),
    /** 返回 id,dismiss(id) 关闭 */
    loading: (message: string, opts?: { duration?: number; action?: KToastAction }) => push('loading', message, opts),
    dismiss,
  }
}
