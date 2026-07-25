// shell 入口(P0 占位):验证 tokens → 组件 → 桥 链路;P1 重写为真正主窗口应用
import { createApp } from 'vue'
import '../styles/tokens.css'
import '../styles/base.css'
import ShellApp from './ShellApp.vue'

createApp(ShellApp).mount('#app')
