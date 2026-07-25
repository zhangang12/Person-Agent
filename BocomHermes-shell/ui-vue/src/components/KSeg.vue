<!--
  KSeg · 分段控件
  契约(design.css .seg / interactions.html 02):
  - 轨道 fills.f2、radius.lg、padding s1;项高 32px、min-width 52px、150ms 换背景
  - 选中块「浮起」:浅色下白底 + 0 1px 3px rgba(0,0,0,0.08) 投影
-->
<script setup lang="ts">
export interface KSegOption {
  value: string
  label: string
  disabled?: boolean
}

interface Props {
  options: KSegOption[]
  modelValue?: string
}
withDefaults(defineProps<Props>(), { modelValue: '' })
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'change', v: string): void
}>()

function pick(o: KSegOption) {
  if (o.disabled) return
  emit('update:modelValue', o.value)
  emit('change', o.value)
}
</script>

<template>
  <div class="k-seg" role="tablist">
    <button
      v-for="o in options" :key="o.value"
      role="tab"
      :aria-selected="o.value === modelValue"
      :class="{ on: o.value === modelValue }"
      :disabled="o.disabled || undefined"
      @click="pick(o)"
    >{{ o.label }}</button>
  </div>
</template>

<style scoped>
.k-seg {
  display: inline-flex; gap: var(--s1); background: var(--fill-2);
  border-radius: var(--r-lg); padding: var(--s1);
}
.k-seg > button {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--s1);
  min-width: 52px; height: 32px; padding: 6px 12px; border-radius: var(--r-sm);
  font: var(--b2); color: var(--label-1); transition: background-color var(--hover-dur) ease;
}
.k-seg > button.on { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.k-seg > button:disabled { color: var(--label-4); pointer-events: none; }
</style>
