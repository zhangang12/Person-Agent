<script setup lang="ts">
// 标题栏骨架:对齐设计稿 S2(拖动柄 → 会话色点 → 标题 → 项目名 → chips → 保活 → 窗口控件)
// 本棒:静态标题/项目/模型文本(cardInit 回包)+ 窗口控件;chips 交互是第二棒挂载点:
//   data-slot="model" → 模型选择菜单;data-slot="ctx" → 上下文用量 chip(s.ctxUsedChars 已备);
//   data-slot="hb"    → 保活灯(引擎心跳推送接线在第二棒)。
// embedded 模式:去窗口控件(宿主窗口的系统边框负责)。
import { ref, computed } from 'vue'
import { s } from './store'
import { BH } from './bridge'

// 会话色点:按 session 哈希取 hue(与旧页 applyCardTint 同算法),多卡并行一眼区分
const tintHue = computed(() => {
  let h = 0
  for (const c of String(s.sessionId || '')) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
})
const tintStyle = computed(() => ({ background: `hsl(${tintHue.value} 70% 48%)` }))

const pinOn = ref(false)
async function onPin() {
  try { pinOn.value = !!(await BH()?.togglePin?.()) } catch { /* 静默 */ }
}
const call = (fn: 'closeSelf' | 'minimizeSelf' | 'toggleMaximize') => {
  try { (BH() as any)?.[fn]?.() } catch { /* 静默 */ }
}
</script>

<template>
  <div class="k-hd">
    <span class="k-grip" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><circle cx="8" cy="6" r="1.1"/><circle cx="8" cy="12" r="1.1"/><circle cx="8" cy="18" r="1.1"/><circle cx="13" cy="6" r="1.1"/><circle cx="13" cy="12" r="1.1"/><circle cx="13" cy="18" r="1.1"/></svg></span>
    <span class="dot" :style="tintStyle" aria-hidden="true"></span>
    <span class="k-title"><span v-if="s.done" class="done-tick">✓</span>{{ s.title }}</span>
    <span v-if="s.project" class="k-dir">{{ s.project }}</span>
    <span class="sp"></span>
    <span class="k-chip" data-slot="model" :title="'当前模型：' + s.modelLabel">{{ s.modelLabel }}</span>
    <span class="k-chip" data-slot="ctx" hidden></span>
    <span class="dot hb-dot" data-slot="hb" title="引擎保活"></span>
    <template v-if="!s.embedded">
      <button class="ibtn" :class="{ on: pinOn }" :title="pinOn ? '已置顶（点击取消）' : '置顶'" aria-label="置顶" @click="onPin"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1.2 5.2L17 12v2H7v-2l3.2-2.8z"/><path d="M12 14v6"/></svg></button>
      <button class="ibtn" title="最大化 / 还原" aria-label="最大化" @click="call('toggleMaximize')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>
      <button class="ibtn" title="最小化" aria-label="最小化" @click="call('minimizeSelf')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
      <button class="ibtn" title="关闭" aria-label="关闭" @click="call('closeSelf')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </template>
  </div>
</template>
