<script setup lang="ts">
// 权限审批条:常规橙 / 高危红(设计稿 S3 分级);高危【移除「总是允许」】;
// Y/A/N 键盘快捷键(ChatApp 全局键,这里给提示);编辑预检黄牌(miss.region)+ 迷你 diff(红删绿增)。
import { computed } from 'vue'
import { replyPerm } from './store'
import { permActions } from './lib/perm'
import type { PermDecision } from './lib/perm'
import type { PermItem } from './store'

const props = defineProps<{ item: PermItem }>()
const actions = computed(() => permActions(props.item.highRisk))
const diffLines = computed(() => String(props.item.diff || '').split('\n').filter((l) => l.trim()))
const keyHint = computed(() => props.item.highRisk ? 'Y 允许一次 · N 拒绝' : 'Y 允许一次 · A 总是 · N 拒绝')
function reply(d: PermDecision) { replyPerm(props.item, d) }
</script>

<template>
  <div class="permbar" :class="{ high: item.highRisk }">
    <div class="pb-head">
      <span class="pb-tool">{{ item.tool }}</span>
      <span v-if="item.highRisk" class="pb-risk">高危操作</span>
    </div>
    <div v-if="item.detail" class="pb-detail">{{ item.detail }}</div>
    <div v-if="item.miss" class="pb-miss">
      ⚠ 编辑预检:oldString 与文件实际内容不符(放行多半白撞 —— 建议拒绝,让它先读文件再改)
      <pre v-if="item.miss.region">{{ item.miss.region }}</pre>
    </div>
    <pre v-if="diffLines.length" class="pb-diff"><div v-for="(l, i) in diffLines" :key="i" :class="l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : ''">{{ l }}</div></pre>
    <div class="pb-acts">
      <button v-if="actions.includes('once')" class="pb-btn ok" @click="reply('once')">允许一次</button>
      <button v-if="actions.includes('always')" class="pb-btn" @click="reply('always')">总是</button>
      <button class="pb-btn no" @click="reply('reject')">拒绝</button>
      <span class="pb-hint">{{ keyHint }}</span>
    </div>
  </div>
</template>
