<script setup lang="ts">
// 状态行(Claude Code 式,旧页 1270-1301 平移):忙时实时显示【✻ 正在跑什么 + 已耗时 + Esc 中断】,
// 完成短显 ✓ 耗时(3.5s 自动隐);已按 Esc = 「正在停止…(等引擎收尾)」。
// 挂在 s.busy 上:所有进出忙态的路径(turn/turnToEl/压缩/boot)自然带上,不用逐处埋点。
import { ref, watch, onBeforeUnmount } from 'vue'
import { s } from './store'

const secs = ref(0)
const doneSecs = ref(-1)   // ≥0 = 短显「✓ 完成 · Ns」
let t0 = 0
let tick: ReturnType<typeof setInterval> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

watch(() => s.busy, (b) => {
  if (b) {
    t0 = Date.now(); secs.value = 0; doneSecs.value = -1
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (!tick) tick = setInterval(() => { secs.value = Math.floor((Date.now() - t0) / 1000) }, 500)
  } else {
    if (tick) { clearInterval(tick); tick = null }
    if (t0) {
      doneSecs.value = Math.round((Date.now() - t0) / 1000)
      hideTimer = setTimeout(() => { doneSecs.value = -1 }, 3500)
      t0 = 0
    }
  }
}, { immediate: true })
onBeforeUnmount(() => { if (tick) clearInterval(tick); if (hideTimer) clearTimeout(hideTimer) })
</script>

<template>
  <div v-if="s.busy || doneSecs >= 0" class="statusline" :class="{ ok: doneSecs >= 0 && !s.busy }">
    <template v-if="s.busy">
      <span class="sl-spin">✻</span>
      <span class="sl-main">{{ s.aborting ? '正在停止…（等引擎收尾，几秒内结束）' : s.runAct }}</span>
      <span class="sl-time">{{ secs }}s</span>
      <span v-if="!s.aborting" class="sl-esc">Esc 中断</span>
    </template>
    <template v-else>✓ 完成 · {{ doneSecs }}s</template>
  </div>
</template>
