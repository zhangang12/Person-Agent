<script setup lang="ts">
// todowrite 一等公民清单卡(不折叠,设计稿 S4 三态圆点):
//   完成 = positiveGreen 实底白勾;进行 = blue 环 + 呼吸点(pulse 1.2s,只动 opacity);待办 = fills.f4 描边环。
// 进行行右侧带「进行中」蓝字;标题行 meta N/M + 非终态「· 更新中…」。model=null 时 store 侧整卡隐藏。
import type { TodoItem } from './store'

defineProps<{ item: TodoItem }>()
</script>

<template>
  <div v-if="item.model" class="todocard">
    <div class="td-hd">
      <span class="td-title">任务清单</span>
      <span class="td-meta">{{ item.model.meta }}</span>
      <span v-if="item.updating" class="td-updating">· 更新中…</span>
    </div>
    <div v-for="(r, i) in item.model.rows" :key="i" class="td-row" :class="r.cls">
      <span class="td-dot" :class="r.cls" aria-hidden="true"></span>
      <span class="td-text">{{ r.text }}</span>
      <span v-if="r.cls === 'doing'" class="td-doing">进行中</span>
    </div>
  </div>
</template>
