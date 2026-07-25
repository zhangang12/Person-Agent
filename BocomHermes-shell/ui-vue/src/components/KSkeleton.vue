<!--
  KSkeleton · 骨架屏
  契约:interactions.html .skl —— shimmer 1.4s 线性,fill-1/fill-2 双色渐变扫光,不用 spinner
-->
<script setup lang="ts">
interface Props {
  /** 宽,默认 100%;可传 px 数或任意 CSS 长度 */
  width?: number | string
  /** 高(px),契约示例 11-14px 文本行 / 34px 块 */
  height?: number
  /** 行数(多行时每行间隔 10px,末行宽 75%) */
  lines?: number
}
withDefaults(defineProps<Props>(), { width: '100%', height: 12, lines: 1 })

function w(v: number | string) { return typeof v === 'number' ? v + 'px' : v }
</script>

<template>
  <div class="k-skl-wrap" :style="{ width: w(width) }">
    <div
      v-for="i in lines" :key="i"
      class="k-skl"
      :style="{ height: height + 'px', width: i === lines && lines > 1 ? '75%' : '100%' }"
    />
  </div>
</template>

<style scoped>
.k-skl-wrap { display: flex; flex-direction: column; gap: 10px; }
.k-skl {
  border-radius: var(--r-sm);
  background: linear-gradient(90deg, var(--fill-1) 25%, var(--fill-2) 50%, var(--fill-1) 75%);
  background-size: 200% 100%;
  animation: k-skl-shim var(--skl-dur) linear infinite;
}
@keyframes k-skl-shim { to { background-position: -200% 0; } }
</style>
