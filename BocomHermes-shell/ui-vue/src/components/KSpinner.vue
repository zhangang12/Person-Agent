<!--
  KSpinner · 加载指示器
  契约:interactions.html 按钮矩阵 load 态 —— 圆环 1.5px currentColor,顶段透明,0.8s 线性旋转
-->
<script setup lang="ts">
interface Props {
  /** 直径(px),契约场景:按钮内 12 / Toast loading 20 */
  size?: number
}
withDefaults(defineProps<Props>(), { size: 12 })
</script>

<template>
  <span class="k-spin" :style="{ width: size + 'px', height: size + 'px' }" role="status" aria-label="加载中" />
</template>

<style scoped>
.k-spin {
  display: inline-block; flex: none; border-radius: 50%;
  border: 1.5px solid currentColor; border-top-color: transparent;
  animation: k-spin-rot 0.8s linear infinite;
}
@keyframes k-spin-rot { to { transform: rotate(360deg); } }
</style>
