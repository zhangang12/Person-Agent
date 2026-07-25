<!--
  KToastItem · 单条 Toast(展示件,KToaster 内部使用;实验室静态矩阵直接复用)
  契约:底恒定 toastPc #2b2b2b、白字、20px 表意图标、radius.lg、shadow-small;
  action 槽蓝字 b2-em。
-->
<script setup lang="ts">
import KSpinner from './KSpinner.vue'
import type { KToastType } from './toast'

interface Props {
  type: KToastType
  message: string
  actionLabel?: string
}
withDefaults(defineProps<Props>(), { actionLabel: '' })
const emit = defineEmits<{ (e: 'action'): void }>()
</script>

<template>
  <div class="k-toast" :class="'t-' + type" role="alert">
    <svg v-if="type === 'success'" class="ic s20 t-ic" viewBox="0 0 24 24" style="color:var(--green)"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5.5-6.5"/></svg>
    <svg v-else-if="type === 'error'" class="ic s20 t-ic" viewBox="0 0 24 24" style="color:var(--danger)"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
    <svg v-else-if="type === 'warning'" class="ic s20 t-ic" viewBox="0 0 24 24" style="color:var(--orange)"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4M12 17.5v.01"/></svg>
    <svg v-else-if="type === 'info'" class="ic s20 t-ic" viewBox="0 0 24 24" style="color:var(--blue)"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>
    <KSpinner v-else :size="20" style="color:#fff" />
    <span class="msg">{{ message }}</span>
    <button v-if="actionLabel" class="act" @click="emit('action')">{{ actionLabel }}</button>
    <slot />
  </div>
</template>

<style scoped>
.k-toast {
  display: inline-flex; align-items: center; gap: var(--s2); min-height: 40px; max-width: 360px;
  padding: 10px 12px; border-radius: var(--r-lg); background: var(--toast-bg);
  color: #fff; font: var(--b2); box-shadow: var(--shadow-small);
}
.k-toast .t-ic { flex: none; }
.k-toast .act { color: var(--blue); font: var(--b2-em); padding: 4px; border-radius: var(--r-xxs); flex: none; }
</style>
