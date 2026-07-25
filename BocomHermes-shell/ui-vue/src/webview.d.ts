// Electron <webview> 自定义标签类型(vite.config isCustomElement 放行)
// 必须是模块(含 import)才能以「增补」方式并入 vue 类型,不能像 env.d.ts 那样全局覆盖。
import 'vue'

declare module 'vue' {
  export interface GlobalComponents {
    /** webview 事件(dom-ready/ipc-message/destroyed)一律 addEventListener 挂,不走 v-on */
    webview: any
  }
}

export {}
