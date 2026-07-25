// shell 入口(P1):主窗口应用 = TitleBar / SideBar / 视图区(webview 保活) / StatusBar / QuickInput
import { createApp } from 'vue'
import '../styles/tokens.css'
import '../styles/base.css'
import ShellApp from './ShellApp.vue'

createApp(ShellApp).mount('#app')
