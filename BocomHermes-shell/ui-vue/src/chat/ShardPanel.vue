<script setup lang="ts">
// 主控卡分片进度面板(orch):分片进度 N/M 聚合条 + 每片一枚 chip(状态图标+目标);
// 点一片 → 分片视图(就地渲染该片的镜像会话:文本/工具流),「← 主控」返回主区域。
import { computed } from 'vue'
import { s, openShardView, shardMirror } from './store'
import { renderMarkdown } from './rich'

const doneN = computed(() => s.shards.filter((x) => x.status === 'done' || x.status === 'interrupted').length)
const icon = (st: string) => st === 'done' ? '✅' : st === 'interrupted' ? '⚠' : st === 'running' ? '⏳' : '🕐'
const mirrorItems = computed(() => {
  if (!s.shardView) return []
  const m = shardMirror(s.shardView)
  if (!m) return []
  return [...m.values()]
})
function itemHtml(it: any): string {
  if (it.kind === 'tool') return ''
  return renderMarkdown(String(it.text || ''))
}
</script>

<template>
  <div v-if="s.orchMode && s.shards.length" class="shardpanel">
    <div class="sp-hd" @click="openShardView('')">
      <span class="sp-title">分片进度 {{ doneN }}/{{ s.shards.length }}</span>
      <span v-if="s.shardView" class="sp-back">← 主控</span>
    </div>
    <div v-if="!s.shardView" class="sp-chips">
      <button
        v-for="sh in s.shards" :key="sh.id || sh.goal"
        class="sp-chip" :class="sh.status"
        :title="sh.goal + (sh.round ? ' · 第 ' + sh.round + ' 轮' : '')"
        @click="sh.id && openShardView(sh.id)"
      >{{ icon(sh.status) }} {{ sh.goal }}</button>
    </div>
    <div v-else class="sp-view">
      <div v-if="!mirrorItems.length" class="sp-empty">这片还没有回流事件(分片刚起步/镜像未至)</div>
      <template v-for="(it, i) in mirrorItems" :key="i">
        <div v-if="it.kind === 'tool'" class="sp-tool">
          <span class="nm">{{ it.text }}</span>
          <span class="ti">{{ it.title || '' }}</span>
          <span class="st" :class="/error|fail/i.test(String(it.error || it.status || '')) ? 'bad' : /complet|success|done/i.test(String(it.status || '')) ? 'ok' : 'run'">●</span>
        </div>
        <div v-else class="sp-text md" v-html="itemHtml(it)"></div>
      </template>
    </div>
  </div>
</template>
