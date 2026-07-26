// 任务编排页入口:发起区(模式 seg/目标/模板/步骤预览)+ 工作流列表(进度/排队)+ 详情双栏(批准闸/todo/产出/动作)。
// 从 legacy dock.html 抽出重写:不再是塞进 webview 的玻璃卡,与对话/知识库同为 ui-vue 一等视图。
import { createApp } from 'vue'
import '../styles/tokens.css'
import '../styles/base.css'
import './orch.css'
import OrchApp from './OrchApp.vue'

createApp(OrchApp).mount('#app')
