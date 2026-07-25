<!--
  KChip · 操作片(快捷键提示/轻入口)
  契约:design.css .chip —— 高 28px / 0.5px sep 描边 / icon-label 间距 4px / hover fill-1
-->
<script setup lang="ts">
interface Props {
  /** 可点击(渲染 button);否则纯展示 span */
  clickable?: boolean
  disabled?: boolean
}
withDefaults(defineProps<Props>(), { clickable: false, disabled: false })
const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>()
</script>

<template>
  <component
    :is="clickable ? 'button' : 'span'"
    class="k-chip"
    :disabled="clickable && disabled ? true : undefined"
    @click="emit('click', $event)"
  ><slot /></component>
</template>

<style scoped>
.k-chip {
  display: inline-flex; align-items: center; gap: var(--s1); height: 28px; padding: 0 10px;
  border: 0.5px solid var(--sep); border-radius: var(--r-sm); font: var(--b2); color: var(--label-2);
  background: transparent; transition: background-color var(--hover-dur) ease, color var(--hover-dur) ease;
}
.k-chip:hover { background: var(--fill-1); color: var(--label-1); }
.k-chip:disabled { color: var(--label-4); pointer-events: none; }
</style>
