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

<template>
  <div class="msg-a" :class="{ aborted: item.status === 'aborted', err: item.status === 'error' }">
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
</template>
