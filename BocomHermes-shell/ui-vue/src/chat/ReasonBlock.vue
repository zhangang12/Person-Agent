<script setup lang="ts">
// 思考块:details/summary,流式期实时刷新 body 并滚到底;答完不折叠不移除(open 保持,
// 历史每一轮的思考链路都留在对话流里可回看);历史回放默认折叠。
import { ref, watch, nextTick } from 'vue'
import type { ReasonItem } from './store'

const props = defineProps<{ item: ReasonItem }>()
const bodyEl = ref<HTMLElement | null>(null)
watch(() => props.item.body, async () => {
  await nextTick()
  const el = bodyEl.value
  if (el) el.scrollTop = el.scrollHeight
})
function onToggle(e: Event) {
  props.item.open = (e.target as HTMLDetailsElement).open
}
</script>

<template>
  <details class="k-think" :open="item.open" @toggle="onToggle">
    <summary><svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>思考过程</summary>
    <div ref="bodyEl" class="body">{{ item.body }}</div>
  </details>
</template>
