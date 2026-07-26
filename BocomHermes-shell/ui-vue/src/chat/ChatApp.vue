<script setup lang="ts">
// chat 页根组件:标题栏 + 对话流 + 输入条;Esc 中断本轮(忙时)。
// wf/orch/shard 卡不走新页(第二棒接线):给占位说明,不连引擎、不留死路。
import { onMounted, onBeforeUnmount } from 'vue'
import { s, boot, abort } from './store'
import TitleBar from './TitleBar.vue'
import FeedView from './FeedView.vue'
import ComposerBar from './ComposerBar.vue'

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && s.busy) abort()
}
onMounted(() => {
  document.addEventListener('keydown', onKey)
  boot()
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="chatcard">
    <span class="hl"></span>
    <TitleBar />
    <div v-if="s.unsupportedMode" class="unsupported">
      <p>本卡类型（{{ s.unsupportedMode }}）暂未迁移到新对话页。</p>
      <p class="sub">工作流 / 编排 / 分片卡仍由旧版卡片承载（P2a 第二棒接线）。当前页未连接引擎，可直接关闭。</p>
    </div>
    <template v-else>
      <FeedView />
      <ComposerBar />
    </template>
  </div>
</template>
