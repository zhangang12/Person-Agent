<script setup lang="ts">
// 主控卡分片进度面板(orch):分片进度 N/M 聚合条 + 每片一枚 chip(状态图标+目标);
// 点一片 → 分片视图(就地渲染该片的镜像会话:文本/工具流),「← 主控」返回主区域;
// ⧉ 弹窗兜底:把分片真实隐藏窗亮出来(镜像视图重载后是空缓冲,纯黑盒场景的可见通道,preload 已暴露 shardPop)。
import { computed } from 'vue'
import { s, openShardView, shardMirror, shardVersion, addNote } from './store'
import { BH } from './bridge'
import { renderMarkdown } from './rich'

const doneN = computed(() => s.shards.filter((x) => x.status === 'done' || x.status === 'interrupted').length)
const icon = (st: string) => st === 'done' ? '✅' : st === 'interrupted' ? '⚠' : st === 'running' ? '⏳' : '🕐'
const mirrorItems = computed(() => {
  void shardVersion.value   // 缓冲是普通 Map(不触发响应式):靠版本号依赖让新事件合帧后重算,否则打开视图后定格
  if (!s.shardView) return []
  const m = shardMirror(s.shardView)
  if (!m) return []
  return [...m.values()]
})
function itemHtml(it: any): string {
  if (it.kind === 'tool') return ''
  return renderMarkdown(String(it.text || ''))
}
// ⧉ 弹窗查看该分片的真实窗口(X 收回后台不杀;对齐旧页 card.html:771)
async function popShard(id: string): Promise<void> {
  try {
    const r: any = await (BH() as any)?.shardPop?.(id)
    if (r && r.ok === false) addNote('分片弹窗失败:' + (r.err || '未知原因'))
  } catch (e: any) { addNote('分片弹窗失败:' + ((e && e.message) || e)) }
}
</script>

<template>
  <div v-if="s.orchMode && s.shards.length" class="shardpanel">
    <div class="sp-hd" @click="openShardView('')">
      <span class="sp-title">分片进度 {{ doneN }}/{{ s.shards.length }}</span>
      <span v-if="s.shardView" class="sp-back">← 主控</span>
    </div>
    <div v-if="!s.shardView" class="sp-chips">
      <span v-for="sh in s.shards" :key="sh.id || sh.goal" class="sp-chipwrap">
        <button
          class="sp-chip" :class="sh.status"
          :title="sh.goal + (sh.round ? ' · 第 ' + sh.round + ' 轮' : '')"
          @click="sh.id && openShardView(sh.id)"
        >{{ icon(sh.status) }} {{ sh.goal }}</button>
        <button
          v-if="sh.id" class="sp-pop" title="弹出该分片的窗口(直接看它的实时会话;X 收回后台不杀)"
          @click.stop="popShard(sh.id)"
        >⧉</button>
      </span>
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
