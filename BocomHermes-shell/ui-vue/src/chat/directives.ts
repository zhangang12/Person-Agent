// chat 页 · 局部指令:v-fold-code —— 渲染落 DOM 后把 >24 行的 pre 收成 details(收尾/静态才跑)
import { foldLongCode } from './rich'

export const vFoldCode = {
  mounted(el: HTMLElement) { foldLongCode(el) },
}
