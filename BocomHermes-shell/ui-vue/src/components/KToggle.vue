<!--
  KToggle · 开关
  契约(interactions.html 02 / toggle.md 简化):
  - sm:轨道 32×18,滑块 14px 恒正圆,on 态轨道 = labels.primary
  - 悬停:滑块缩 2px 并向 active 边微移(「预压」手感)
  - 禁用:整体 opacity 0.4;on+禁用 轨道退 fills.f2
  - 动效:滑块位移/缩放 200ms ez-out,轨道换色 ≤150ms
  lg(44×24)为等比放大,设计稿未给数值,见 P0 报告「待设计确认」。
-->
<script setup lang="ts">
interface Props {
  modelValue?: boolean
  size?: 'sm' | 'lg'
  disabled?: boolean
  label?: string
}
const props = withDefaults(defineProps<Props>(), {
  modelValue: false, size: 'sm', disabled: false, label: '',
})
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'change', v: boolean): void
}>()

function toggle() {
  if (props.disabled) return
  const v = !props.modelValue
  emit('update:modelValue', v)
  emit('change', v)
}
</script>

<template>
  <button
    class="k-tgl"
    :class="[`s-${size}`, { on: modelValue }]"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label || '开关'"
    :disabled="disabled || undefined"
    @click="toggle"
  ><span class="th" /></button>
</template>

<style scoped>
.k-tgl {
  position: relative; border-radius: var(--r-full); background: var(--fill-3); flex: none;
  transition: background-color var(--hover-dur) ease, opacity var(--hover-dur) ease;
}
.k-tgl .th {
  position: absolute; border-radius: 50%; background: #fff;
  transition: left var(--toggle-dur) var(--ez-out), width var(--toggle-dur) var(--ez-out),
    height var(--toggle-dur) var(--ez-out), top var(--toggle-dur) var(--ez-out);
}
/* sm:32×18,滑块 14px(.sim-hov 为实验室静态仿真类) */
.k-tgl.s-sm { width: 32px; height: 18px; }
.k-tgl.s-sm .th { top: 2px; left: 2px; width: 14px; height: 14px; }
.k-tgl.s-sm.on .th { left: 16px; }
.k-tgl.s-sm:hover .th, .k-tgl.s-sm.sim-hov .th { width: 12px; height: 12px; top: 3px; }
.k-tgl.s-sm.on:hover .th, .k-tgl.s-sm.on.sim-hov .th { left: 18px; }
/* lg:44×24,滑块 20px(等比放大,待设计确认) */
.k-tgl.s-lg { width: 44px; height: 24px; }
.k-tgl.s-lg .th { top: 2px; left: 2px; width: 20px; height: 20px; }
.k-tgl.s-lg.on .th { left: 22px; }
.k-tgl.s-lg:hover .th, .k-tgl.s-lg.sim-hov .th { width: 18px; height: 18px; top: 3px; }
.k-tgl.s-lg.on:hover .th, .k-tgl.s-lg.on.sim-hov .th { left: 24px; }

.k-tgl.on { background: var(--label-1); }
.k-tgl:disabled { opacity: 0.4; pointer-events: none; }
.k-tgl.on:disabled { background: var(--fill-2); }
</style>
