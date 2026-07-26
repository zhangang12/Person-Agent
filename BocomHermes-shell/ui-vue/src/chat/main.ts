// chat 入口(P2a-1):对话卡 Vue 重写 —— 页骨架 + 会话生命周期 + 输入条 + 冻结流式消息流
// 硬兼容点(main.ts 层):
//   ③ 定位变量 gox/goy/gfx/gfy → CSS 变量钉出窗 transform-origin(等价 card.html head 内联脚本);
//   ④ html[data-embed="1"]:embedded=1 时打上,chat.css 统一去悬浮壳三件套(等价 glass.css 覆盖)。
// #ci / card-bound / cardDraft:sid 的兼容在组件与 store 层(见各文件头注释)。
import { createApp } from 'vue'
import '../styles/tokens.css'
import '../styles/base.css'
import './chat.css'
import ChatApp from './ChatApp.vue'

try {
  const p = new URLSearchParams(location.search)
  const d = document.documentElement.style
  ;['gox', 'goy', 'gfx', 'gfy'].forEach((k) => { const v = p.get(k); if (v) d.setProperty('--' + k, v) })
  if (p.get('embedded') === '1') document.documentElement.dataset.embed = '1'
} catch { /* 静默 */ }

createApp(ChatApp).mount('#app')
