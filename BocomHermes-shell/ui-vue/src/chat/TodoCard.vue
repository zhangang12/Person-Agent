<script setup lang="ts">
// todowrite 一等公民清单卡(不折叠):☒◐⊘☐ 三记号 + meta N/M;非终态标题带「· 更新中…」。
// model=null 时 store 侧整卡隐藏,这里只管渲染。
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
      <span class="td-mark">{{ r.mark }}</span>
      <span class="td-text">{{ r.text }}</span>
    </div>
  </div>
</template>
