<script setup lang="ts">
// 工具组合条:连续工具调用折成一条摘要行(N 次调用 · 名×次数 · 当前/出错/完成),点开才看逐条记录
// (逐条 ToolBlock 仍可再展开入参/结果,task 块跳子 Agent 窗格不变)。verbose 开自动展开(与 ToolBlock 同规)。
// 归组在 store.visibleGroups(连续 tool ≥2 才成组);单条工具不进本组件。
import { ref, computed, watch } from 'vue'
import { s } from './store'
import type { ToolItem } from './store'
import ToolBlock from './ToolBlock.vue'

const props = defineProps<{ tools: ToolItem[] }>()
const open = ref(s.verbose)
watch(() => s.verbose, (v) => { if (v) open.value = true })

const running = computed(() => props.tools.filter((t) => t.state === 'running'))
const errN = computed(() => props.tools.reduce((n, t) => n + (t.state === 'err' ? 1 : 0), 0))
const state = computed(() => (running.value.length ? 'running' : errN.value ? 'err' : 'done'))
const names = computed(() => {
  const byName = new Map<string, number>()
  for (const t of props.tools) byName.set(t.name, (byName.get(t.name) || 0) + 1)
  return [...byName.entries()].slice(0, 4).map(([n, c]) => (c > 1 ? n + ' ×' + c : n)).join(' · ')
})
const cur = computed(() => { const r = running.value; return r.length ? r[r.length - 1] : null })
</script>

<template>
  <div class="toolgrp" :class="[state, { open }]">
    <div class="tg-hd" :title="open ? '收起工具记录' : '展开逐条工具记录'" @click="open = !open">
      <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <span class="tg-count">{{ tools.length }} 次工具调用</span>
      <span class="tg-names">{{ names }}</span>
      <span class="sp"></span>
      <span v-if="cur" class="tg-st running">正在:{{ cur.name }}<template v-if="cur.title"> · {{ cur.title }}</template></span>
      <span v-else-if="errN" class="tg-st err">{{ errN }} 个出错</span>
      <span v-else class="tg-st done">已完成</span>
    </div>
    <div v-if="open" class="tg-body">
      <ToolBlock v-for="t in tools" :key="t.id" :item="t" />
    </div>
  </div>
</template>
