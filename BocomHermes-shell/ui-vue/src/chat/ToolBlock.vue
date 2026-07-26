<script setup lang="ts">
// 工具块:同 partID 原地更新(store upsertToolEvent);默认折叠,verbose 开自动展开;
// 完成带「⎿ N 字」摘要;run_workflow 升格高亮;入参/结果截断提示已在 inStr/outStr 里。
// task/delegate_task 带真子会话 id(taskChild)时,点头部跳子 Agent 窗格(不占折叠态)。
import { watch } from 'vue'
import { s, subJump } from './store'
import type { ToolItem } from './store'

const props = defineProps<{ item: ToolItem }>()
// verbose 打开时,所有工具块自动展开(关不强制收回,用户手折的保留)
watch(() => s.verbose, (v) => { if (v) props.item.open = true })
const stateText = { running: '运行中…', done: '完成', err: '出错' } as const
function onHead() {
  if (props.item.taskChild) { subJump(props.item.taskChild); return }
  props.item.open = !props.item.open
}
</script>

<template>
  <div class="toolblk" :class="[item.state, { wf: item.isWf, open: item.open }]">
    <div class="tb-hd" :class="{ jumpable: !!item.taskChild }" :title="item.taskChild ? '点我看这个子 Agent 的全程(侧边栏)' : ''" @click="onHead">
      <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <span class="tb-name">{{ item.name }}</span>
      <span v-if="item.title" class="tb-title">{{ item.title }}</span>
      <span v-if="item.summary" class="tb-summary">{{ item.summary }}</span>
      <span class="tb-state" :class="item.state">{{ stateText[item.state] }}</span>
    </div>
    <div v-if="item.open" class="tb-body">
      <template v-if="item.inStr"><div class="tb-lb">入参</div><pre>{{ item.inStr }}</pre></template>
      <template v-if="item.outStr"><div class="tb-lb">{{ item.hasErr ? '错误' : '结果' }}</div><pre :class="{ err: item.hasErr }">{{ item.outStr }}</pre></template>
    </div>
  </div>
</template>
