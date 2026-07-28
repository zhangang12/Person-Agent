<script setup lang="ts">
// AI 气泡 · 流式渲染器(本棒最大技术点)
// 防 O(n²) 与文本选择不炸的实现:
//   - 已冻结段 segs:push-only,子元素 v-once + props 不变 → Vue 不重渲、DOM 节点不被重写;
//   - 尾巴区 tail:唯一随流式更新的 computed,每帧重渲 markdown;
//   - 收尾:finalHtml 全量 renderMarkdown 一次 + 复制/重答钮(流式中不挂,免被逐帧冲掉)。
// 「已中断」角标:半截气泡与正常完成一眼区分;error 纯文案态红字。
import { computed } from 'vue'
import { renderMarkdown } from './rich'
import { regen } from './store'
import type { AiItem } from './store'
import { vFoldCode } from './directives'

const props = defineProps<{ item: AiItem }>()
const tailHtml = computed(() => renderMarkdown(props.item.tail))

let copied = false
function copyRaw(e: MouseEvent) {
  e.stopPropagation()
  try { navigator.clipboard.writeText(props.item.raw || '') } catch { /* 静默 */ }
  const b = e.currentTarget as HTMLElement
  if (!copied) { copied = true; b.classList.add('ok'); setTimeout(() => { b.classList.remove('ok'); copied = false }, 1200) }
}
function onRegen(e: MouseEvent) {
  e.stopPropagation()
  if (props.item.retryText) regen(props.item.retryText, props.item.retryFiles)
}
</script>

<style scoped>
/* 小球头像三层动画:halo 呼吸 / rim 环慢转 / 星星闪烁(transform-box 保 svg 内元素变换原点正确)
   streaming(live) 时整体加速 —— 头像即状态指示器 */
.a-avatar .av-halo { animation: avBreath 3.6s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.a-avatar .av-rim { animation: avSpin 10s linear infinite; transform-box: fill-box; transform-origin: center; }
.a-avatar .av-star { animation: avTwinkle 2.6s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.a-avatar .av-star.s2 { animation-delay: 1.1s; }
.a-avatar .av-eye { animation: avBlink 4.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.a-avatar .av-eye.e2 { animation-delay: .06s; }
.a-avatar.live .av-halo { animation-duration: 1.4s; }
.a-avatar.live .av-rim { animation-duration: 2.8s; }
.a-avatar.live .av-star { animation-duration: 1.2s; }
@keyframes avBreath { 0%, 100% { opacity: .5; transform: scale(.94); } 50% { opacity: 1; transform: scale(1.07); } }
@keyframes avSpin { to { transform: rotate(360deg); } }
@keyframes avTwinkle { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.1); } }
@keyframes avBlink { 0%, 90%, 100% { transform: scaleY(1); } 95% { transform: scaleY(.08); } }
</style>

<template>
  <div class="msg-a" :class="{ aborted: item.status === 'aborted', err: item.status === 'error' }">
    <!-- 小球头像(桌面图标全套语言:halo 光晕+渐变 rim 环+高光+双星;三层动画:呼吸/慢转/闪烁;
         状态感知:streaming 时加速脉动,完成归平静) -->
    <div class="a-avatar" :class="{ live: item.status === 'streaming' }" aria-hidden="true">
      <svg width="30" height="30" viewBox="0 0 64 64">
        <defs>
          <radialGradient id="avbg" cx="42%" cy="37%" r="70%"><stop offset="0%" stop-color="#13243f"/><stop offset="55%" stop-color="#0a1120"/><stop offset="100%" stop-color="#05070f"/></radialGradient>
          <radialGradient id="avhalo" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#2bb6ff" stop-opacity=".58"/><stop offset="55%" stop-color="#3a6bff" stop-opacity=".18"/><stop offset="100%" stop-color="#3a6bff" stop-opacity="0"/></radialGradient>
          <linearGradient id="avrim" x1="0" y1=".5" x2="1" y2=".5"><stop offset="0%" stop-color="#5cf0ff"/><stop offset="22%" stop-color="#1ea7ff" stop-opacity=".25"/><stop offset="50%" stop-color="#0a1024" stop-opacity="0"/><stop offset="78%" stop-color="#6f7bff" stop-opacity=".3"/><stop offset="100%" stop-color="#8aa0ff"/></linearGradient>
          <radialGradient id="avspec" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#e3f7ff" stop-opacity=".9"/><stop offset="100%" stop-color="#e3f7ff" stop-opacity="0"/></radialGradient>
        </defs>
        <circle class="av-halo" cx="32" cy="32" r="30" fill="url(#avhalo)"/>
        <circle cx="32" cy="32" r="24" fill="url(#avbg)"/>
        <circle class="av-rim" cx="32" cy="32" r="24" fill="none" stroke="url(#avrim)" stroke-width="3" stroke-linecap="round" stroke-dasharray="100 52"/>
        <ellipse cx="24" cy="21" rx="9" ry="6" fill="url(#avspec)" opacity=".45" transform="rotate(-28 24 21)"/>
        <ellipse class="av-eye e1" cx="24" cy="30" rx="3.4" ry="5.4" fill="#fff"/>
        <ellipse class="av-eye e2" cx="40" cy="30" rx="3.4" ry="5.4" fill="#fff"/>
        <path class="av-star s1" d="M48 8l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#eafaff"/>
        <path class="av-star s2" d="M17 45l1.4 3.4 3.4 1.4-3.4 1.4L17 54.2l-1.4-3.4-3.4-1.4 3.4-1.4z" fill="#dff4ff" opacity=".85"/>
      </svg>
    </div>
    <div class="a-body">
      <!-- 收尾/回放:全量渲一次 + 长代码折叠 -->
      <div v-if="item.finalHtml" class="md final-md" v-html="item.finalHtml" v-fold-code></div>
      <!-- 流式中:冻结段(keyed + v-memo:props 不变子树跳过补丁,节点不重写) + 尾巴区(每帧重渲) + 光标 + 占位符 -->
      <template v-else-if="item.status === 'streaming'">
        <span v-for="seg in item.segs" :key="seg.id" v-memo="[seg.html]" class="frozen-seg md" v-html="seg.html"></span>
        <div v-if="item.tail" class="md tail-md" v-html="tailHtml"></div>
        <span class="streamcursor" aria-hidden="true"></span>
        <div v-if="!item.segs.length && !item.tail" class="ph">{{ item.plainText || '思考中…' }}</div>
      </template>
      <!-- 纯文案态:出错 / 空答 / 只有思考 / boot 占位 -->
      <div v-else class="plaintext">{{ item.plainText }}</div>

      <span v-if="item.status === 'aborted'" class="aborttag">已中断</span>
      <button
        v-if="(item.status === 'done' || item.status === 'aborted') && item.raw"
        class="msgact copybtn" title="复制" @click="copyRaw"
      ><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      <button
        v-if="item.status === 'done' && item.retryText"
        class="msgact regenbtn" title="重新回答（把同样的问题再问一遍）" @click="onRegen"
      ><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v5h-5"/></svg></button>
    </div>
  </div>
</template>
