<!--
  KMenu · 菜单
  契约(interactions.html 03 / 动效规格表):
  - 宽 140-240px;项高 36px、radius.md、hover = fills.f1;选中尾置 18px 勾;禁用 40% 不透明
  - 弹出 150ms ez-out scale(.95→1) + opacity,变换原点挂触发角
  - 点击外 / Esc / 选中后关闭
  用法:<KMenu :items="..."><触发器</KMenu>,@select(key)
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

export interface KMenuItem {
  key: string
  label: string
  /** svg path 片段(innerHTML),如 'M20 6 9 17l-5-5' */
  icon?: string
  /** 选中态:尾置 18px 勾 */
  checked?: boolean
  disabled?: boolean
}

interface Props {
  items: KMenuItem[]
  /** 面板相对触发器的落点 */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start'
  /** 受控展开(v-model:open);不传则内部自管 */
  open?: boolean
}
const props = withDefaults(defineProps<Props>(), { placement: 'bottom-start', open: undefined })
const emit = defineEmits<{
  (e: 'select', key: string): void
  (e: 'update:open', open: boolean): void
}>()

const wrap = ref<HTMLElement | null>(null)
const innerOpen = ref(false)
const open = computed({
  get: () => (props.open !== undefined ? props.open : innerOpen.value),
  set: (v) => { innerOpen.value = v; emit('update:open', v) },
})
const pos = ref({ x: 0, y: 0 })

function computePos() {
  const r = wrap.value?.getBoundingClientRect()
  if (!r) return
  const GAP = 4
  if (props.placement === 'bottom-start') pos.value = { x: r.left, y: r.bottom + GAP }
  else if (props.placement === 'bottom-end') pos.value = { x: r.right, y: r.bottom + GAP }
  else pos.value = { x: r.left, y: r.top - GAP }
}
function setOpen(v: boolean) {
  if (open.value === v) return
  open.value = v
  if (v) computePos()
}
function toggle() { setOpen(!open.value) }
function pick(it: KMenuItem) {
  if (it.disabled) return
  emit('select', it.key)
  setOpen(false)
}
function onDocDown(ev: Event) {
  if (!open.value) return
  const t = ev.target as Node
  if (wrap.value && !wrap.value.contains(t) && !(t instanceof HTMLElement && t.closest('.k-menu-panel'))) setOpen(false)
}
function onDocKey(ev: KeyboardEvent) {
  if (open.value && ev.key === 'Escape') setOpen(false)
}
// 展开期间视口变化(resize/任意层 scroll)重算位置,防止面板漂移
function onRelayout() { if (open.value) computePos() }
document.addEventListener('pointerdown', onDocDown, true)
document.addEventListener('keydown', onDocKey)
window.addEventListener('resize', onRelayout)
document.addEventListener('scroll', onRelayout, true)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onDocKey)
  window.removeEventListener('resize', onRelayout)
  document.removeEventListener('scroll', onRelayout, true)
})
</script>

<template>
  <span ref="wrap" class="k-menu-wrap" @click="toggle">
    <slot />
    <Teleport to="body">
      <Transition name="k-menu">
        <div
          v-if="open"
          class="k-menu-panel"
          :class="'p-' + placement"
          role="menu"
          :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
          @click.stop
        >
          <button
            v-for="it in items" :key="it.key"
            class="k-mi"
            :class="{ dis: it.disabled }"
            role="menuitem"
            :disabled="it.disabled || undefined"
            @click="pick(it)"
          >
            <svg v-if="it.icon" class="ic" viewBox="0 0 24 24" v-html="it.icon" />
            <span class="lb">{{ it.label }}</span>
            <svg v-if="it.checked" class="ic ck" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
          </button>
        </div>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.k-menu-wrap { display: inline-flex; }
.k-menu-panel {
  position: fixed; z-index: var(--z-modal); min-width: 140px; max-width: 240px;
  background: var(--bg-tertiary); border: 0.5px solid var(--sep); border-radius: var(--r-lg);
  box-shadow: var(--shadow-small); padding: 8px;
}
.k-menu-panel.p-bottom-end { transform: translateX(-100%); }
.k-menu-panel.p-top-start { transform: translateY(-100%); }
.k-mi {
  display: flex; align-items: center; gap: 4px; width: 100%; height: 36px; padding: 8px;
  border-radius: var(--r-md); font: var(--b2); color: var(--label-1); text-align: left;
}
.k-mi:hover { background: var(--fill-1); }
.k-mi .lb { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k-mi .ck { margin-left: auto; flex: none; }
.k-mi.dis, .k-mi:disabled { color: var(--label-4); pointer-events: none; }
.k-mi.dis svg, .k-mi:disabled svg { opacity: 0.4; }

/* 150ms ez-out scale(.95→1) + opacity,原点挂触发角 */
.k-menu-enter-active, .k-menu-leave-active { transition: opacity var(--menu-dur) var(--ez-out), scale var(--menu-dur) var(--ez-out); }
.k-menu-enter-from, .k-menu-leave-to { opacity: 0; scale: 0.95; }
.k-menu-panel.p-bottom-start { transform-origin: top left; }
.k-menu-panel.p-bottom-end { transform-origin: top right; }
.k-menu-panel.p-top-start { transform-origin: bottom left; }
</style>
