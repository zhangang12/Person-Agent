<!--
  KIconBtn · 图标钮
  契约:design.css .ibtn —— 28×28 方框(光学对齐),默认 label-3,hover fill-2 + label-1
-->
<script setup lang="ts">
interface Props {
  /** 边长(px),契约 28 */
  size?: number
  disabled?: boolean
  /** 无障碍标签(图标钮无文字,必填) */
  label: string
}
withDefaults(defineProps<Props>(), { size: 28, disabled: false })
const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>()
</script>

<template>
  <button
    class="k-ibtn"
    :style="{ width: size + 'px', height: size + 'px' }"
    :disabled="disabled || undefined"
    :aria-label="label"
    :title="label"
    @click="emit('click', $event)"
  ><slot /></button>
</template>

<style scoped>
.k-ibtn {
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r-sm); color: var(--label-3);
  transition: background-color var(--hover-dur) ease, color var(--hover-dur) ease;
}
.k-ibtn:hover { background: var(--fill-2); color: var(--label-1); }
.k-ibtn:disabled { color: var(--label-4); pointer-events: none; }
</style>
