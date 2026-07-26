<!--
  KTooltip · 工具提示
  契约(interactions.html 03 / 动效规格表):
  - toastPc 恒定深底、白字、radius.md、无阴影;max-width 240px;箭头 10×4
  - 首次 300ms 延迟;已有提示开过(暖态 1.5s 内)后续即时
  - 125ms ez-out scale(.97→1),变换原点挂在触发侧
  用法:包触发器 <KTooltip content="..."><button/></KTooltip>
-->
<script lang="ts">
// 模块级暖态(非组件实例状态):任一 tooltip 关过后 1.5s 内,下一条即时出现(契约:首开 300ms,后续即时)
let tipWarmUntil = 0
</script>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

interface Props {
  content: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** 首开延迟(ms),契约 300 */
  delay?: number
}
const props = withDefaults(defineProps<Props>(), { placement: 'top', delay: 300 })

const wrap = ref<HTMLElement | null>(null)
const show = ref(false)
const pos = ref({ x: 0, y: 0 })
let timer: ReturnType<typeof setTimeout> | null = null

function computePos() {
  const el = wrap.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const GAP = 8 // 触发器边缘到箭头尖的间距
  // 视口钳制:触发器贴右/左边缘时,fixed+translate(-50%) 会把气泡挤到窗口外被裁成竖条(实测)——
  // 钳在 [130, innerWidth-130](max-width 240 的一半+边距),保证气泡完整;箭头仍指触发器中心方向。
  const clampX = (x: number) => Math.max(130, Math.min(window.innerWidth - 130, x))
  if (props.placement === 'top') pos.value = { x: clampX(r.left + r.width / 2), y: r.top - GAP }
  else if (props.placement === 'bottom') pos.value = { x: clampX(r.left + r.width / 2), y: r.bottom + GAP }
  else if (props.placement === 'left') pos.value = { x: r.left - GAP, y: r.top + r.height / 2 }
  else pos.value = { x: r.right + GAP, y: r.top + r.height / 2 }
}

function open() {
  if (!props.content) return
  computePos()
  show.value = true
  tipWarmUntil = Date.now() + 1500
}
function onEnter() {
  if (!props.content) return
  const d = Date.now() < tipWarmUntil ? 0 : props.delay
  if (timer) clearTimeout(timer)
  timer = setTimeout(open, d)
}
function onLeave() {
  if (timer) { clearTimeout(timer); timer = null }
  show.value = false
  tipWarmUntil = Date.now() + 1500
}
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <span ref="wrap" class="k-tip-wrap" @mouseenter="onEnter" @mouseleave="onLeave" @focusin="onEnter" @focusout="onLeave">
    <slot />
    <Teleport to="body">
      <Transition :name="'k-tip'">
        <div
          v-if="show"
          class="k-tip"
          :class="'p-' + placement"
          role="tooltip"
          :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
        >{{ content }}</div>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.k-tip-wrap { display: inline-flex; }
.k-tip {
  position: fixed; z-index: var(--z-tooltip); background: var(--toast-bg); color: #fff;
  border-radius: var(--r-md); padding: 8px 12px; font: var(--b2); max-width: 240px;
  pointer-events: none; /* 禁阴影(契约) */
}
/* 箭头 10×4(border 5px 三角),随方向翻面 */
.k-tip::after { content: ""; position: absolute; border: 5px solid transparent; }
.k-tip.p-top { transform: translate(-50%, -100%); }
.k-tip.p-top::after { left: 50%; bottom: -4px; margin-left: -5px; border-top-color: var(--toast-bg); border-bottom: none; }
.k-tip.p-bottom { transform: translate(-50%, 0); }
.k-tip.p-bottom::after { left: 50%; top: -4px; margin-left: -5px; border-bottom-color: var(--toast-bg); border-top: none; }
.k-tip.p-left { transform: translate(-100%, -50%); }
.k-tip.p-left::after { right: -4px; top: 50%; margin-top: -5px; border-left-color: var(--toast-bg); border-right: none; }
.k-tip.p-right { transform: translate(0, -50%); }
.k-tip.p-right::after { left: -4px; top: 50%; margin-top: -5px; border-right-color: var(--toast-bg); border-left: none; }

/* 125ms ez-out scale(.97→1),原点挂触发侧 */
.k-tip-enter-active, .k-tip-leave-active { transition: opacity var(--tooltip-dur) var(--ez-out), scale var(--tooltip-dur) var(--ez-out); }
.k-tip-enter-from, .k-tip-leave-to { opacity: 0; scale: 0.97; }
.k-tip.p-top { transform-origin: bottom center; }
.k-tip.p-bottom { transform-origin: top center; }
.k-tip.p-left { transform-origin: right center; }
.k-tip.p-right { transform-origin: left center; }
</style>
