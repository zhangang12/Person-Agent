<!--
  KButton · 按钮
  契约(design.css .btn / interactions.html 01):
  - 三档高:lg 44 / md 32(默认) / sm 26;三变体 primary/secondary/outline;danger 修饰
  - 按压 scale(0.97) 120ms ez-out;禁用降不透明度(色退 label-4)不改配色
  - loading:内置 spinner,指针禁用;is-hover/is-active 类为实验室静态仿真用
-->
<script setup lang="ts">
import KSpinner from './KSpinner.vue'

interface Props {
  /** 档位:lg 44px / md 32px / sm 26px */
  size?: 'lg' | 'md' | 'sm'
  variant?: 'primary' | 'secondary' | 'outline'
  danger?: boolean
  loading?: boolean
  disabled?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  size: 'md', variant: 'primary', danger: false, loading: false, disabled: false,
})
const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>()

function onClick(ev: MouseEvent) {
  if (props.disabled || props.loading) { ev.preventDefault(); return }
  emit('click', ev)
}
</script>

<template>
  <button
    class="k-btn"
    :class="[`v-${variant}`, `s-${size}`, { danger, loading }]"
    :disabled="disabled || undefined"
    :aria-busy="loading || undefined"
    @click="onClick"
  >
    <KSpinner v-if="loading" :size="12" class="ld-spin" />
    <slot />
  </button>
</template>

<style scoped>
.k-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--s1);
  border-radius: var(--r-md); font: var(--b2-em); height: 32px; padding: 6px 10px; min-width: 62px;
  transition: background-color var(--hover-dur) ease, transform var(--btn-press-dur) var(--ez-out);
  user-select: none; white-space: nowrap;
}
/* 按压:scale(0.97) 120ms(.is-active 为实验室静态仿真类) */
.k-btn:active, .k-btn.is-active { transform: scale(var(--btn-press-scale)); }

.k-btn.v-primary { background: var(--brand); color: var(--brand-text); }
.k-btn.v-primary:hover, .k-btn.v-primary.is-hover { background: var(--label-1); }
.k-btn.v-secondary { background: var(--fill-1); color: var(--label-1); }
.k-btn.v-secondary:hover, .k-btn.v-secondary.is-hover { background: var(--fill-2); }
.k-btn.v-outline { border: 0.5px solid var(--sep); color: var(--label-1); background: transparent; }
.k-btn.v-outline:hover, .k-btn.v-outline.is-hover { background: var(--fill-1); }

.k-btn.danger.v-primary { background: var(--danger); color: #fff; }
.k-btn.danger.v-primary:hover, .k-btn.danger.v-primary.is-hover { background: var(--danger); }
.k-btn.danger.v-secondary, .k-btn.danger.v-outline { color: var(--danger); }

.k-btn.s-lg { height: 44px; border-radius: var(--r-lg); font: var(--t2-em); padding: 10px 14px; min-width: 72px; }
.k-btn.s-sm { height: 26px; border-radius: var(--r-sm); font: var(--c1-em); padding: 4px 8px; min-width: 52px; }

/* 禁用:降不透明度不改配色(interactions.html 01 文字契约;与 design.css 的
   color:label-4 规则冲突,浅色下 primary 黑底+30%黑字不可读,故以文字契约为准) */
.k-btn:disabled { opacity: 0.4; pointer-events: none; }

/* 加载:指针禁用;primary 保持底色, spinner 用 brand-text 色 */
.k-btn.loading { pointer-events: none; color: var(--label-3); }
.k-btn.v-primary.loading { color: var(--brand-text); opacity: 0.75; }
.k-btn .ld-spin { flex: none; }
</style>
