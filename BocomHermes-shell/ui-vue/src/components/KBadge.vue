<!--
  KBadge · 徽标
  契约:design.css .badge —— 高 16px / 圆角 full / c2 字阶,五色 green/red/orange/blue/gray
-->
<script setup lang="ts">
interface Props {
  type?: 'green' | 'red' | 'orange' | 'blue' | 'gray'
}
withDefaults(defineProps<Props>(), { type: 'gray' })
</script>

<template>
  <span class="k-badge" :class="type"><slot /></span>
</template>

<style scoped>
.k-badge {
  display: inline-flex; align-items: center; gap: 3px; height: 16px; padding: 0 6px;
  border-radius: var(--r-full); font: var(--c2); font-weight: 500;
}
.k-badge.green { background: var(--green-10); color: var(--green); }
.k-badge.red { background: var(--red-10); color: var(--danger); }
.k-badge.orange { background: var(--orange-10); color: var(--orange); }
.k-badge.blue { background: var(--blue-10); color: var(--blue); }
.k-badge.gray { background: var(--fill-2); color: var(--label-2); }
</style>
