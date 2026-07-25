<!--
  KDot · 状态圆点
  契约:design.css .dot —— 6px 正圆,色随 currentColor(会话染色 blue/green/orange/purple)
-->
<script setup lang="ts">
interface Props {
  /** 语义色,映射令牌变量;默认跟随父级文字色 */
  color?: 'blue' | 'green' | 'orange' | 'purple' | 'danger' | 'yellow' | 'inherit'
}
withDefaults(defineProps<Props>(), { color: 'inherit' })
</script>

<template>
  <span class="k-dot" :class="color !== 'inherit' ? 'c-' + color : ''" />
</template>

<style scoped>
.k-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; display: inline-block; }
.k-dot.c-blue { background: var(--blue); }
.k-dot.c-green { background: var(--green); }
.k-dot.c-orange { background: var(--orange); }
.k-dot.c-purple { background: var(--purple); }
.k-dot.c-danger { background: var(--danger); }
.k-dot.c-yellow { background: var(--yellow); }
</style>
