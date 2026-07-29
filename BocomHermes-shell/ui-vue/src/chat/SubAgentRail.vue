<script setup lang="ts">
// 子 Agent 侧边栏(P2b,旧页 1795-1885 平移):主 Agent 用 task 扇出的子 Agent 列在右抽屉,
// 点任意一个看它的思考/工具/产出全程;扇出自动滑出(本轮没手动关过);徽标=还在跑的个数。
// 轮次选择:本轮=实时窗格;历史轮=清场前拍的只读概要快照(上限 20 轮,saSnaps)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { s, subToggle, subSnapList, pollSubStatus } from './store'
import type { SubAgent } from './store'
import ToolBlock from './ToolBlock.vue'

// 元信息行的秒数需要秒针驱动(运行中 Xs 每秒钟走);同一拍驱动完成态权威轮询(pollSubStatus 内部 5s 节流):
// serve 的 task 完成事件缺 taskChild 时配对不上,子 Agent 一直"运行中"、计时永不封顶(旧页 saTick 平移)
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
onMounted(() => { tick = setInterval(() => { now.value = Date.now(); pollSubStatus() }, 1000) })
onBeforeUnmount(() => { if (tick) clearInterval(tick) })

const snaps = computed(() => subSnapList().slice().reverse())   // 新→旧
const active = computed<SubAgent | null>(() => s.subAgents.find((a) => a.id === s.subActiveId) || s.subAgents[0] || null)

// ── 左缘拖拽拉宽(2026-07 评审要求):往左拖=变宽,320px ~ 卡宽 90%,localStorage 持久化 ──
// 未拖过时跟随 CSS 默认 min(560px, 46%);拖过一次后按像素记。chat 页同进程渲染,无 webview 吃事件问题。
const SUBW_KEY = 'bh.subw'
const subW = ref(+(localStorage.getItem(SUBW_KEY) || 0))
const rsDragging = ref(false)
const railStyle = computed(() => (subW.value > 0 ? { width: subW.value + 'px' } : {}))
function rsStart(e: MouseEvent) {
  const railEl = (e.currentTarget as HTMLElement).parentElement as HTMLElement
  const cardW = (railEl && railEl.parentElement && railEl.parentElement.clientWidth) || window.innerWidth
  const x0 = e.clientX, w0 = (railEl && railEl.offsetWidth) || 560
  rsDragging.value = true
  const move = (ev: MouseEvent) => {
    subW.value = Math.min(Math.max(320, Math.round(w0 + (x0 - ev.clientX))), Math.round(cardW * 0.9))
  }
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    rsDragging.value = false
    try { localStorage.setItem(SUBW_KEY, String(subW.value)) } catch {}
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
const snapItems = computed(() => {
  if (s.subRound === 'cur') return null
  const sn = snaps.value.find((x) => String(x.round) === s.subRound)
  return sn ? { round: sn.round, items: sn.items } : null
})
function meta(a: SubAgent): string {
  void now.value   // 秒针依赖
  return (a.count ? a.count + ' 次调用 · ' : '') + Math.max(0, Math.round(((a.done ? a.doneAt : now.value) - a.t0) / 1000)) + 's' + (a.done ? '' : ' · 运行中')
}
function snapMeta(it: { count: number; ms: number; reads: number }): string {
  return (it.count ? it.count + ' 次调用 · ' : '') + Math.max(0, Math.round(it.ms / 1000)) + 's' + (it.reads ? ' · 读 ' + it.reads : '')
}
</script>

<template>
  <div v-if="s.subOpen" class="subrail" :style="railStyle">
    <!-- 左缘拖拽柄:往左拖=拉宽 -->
    <div class="sr-resize" :class="{ on: rsDragging }" title="拖拽调整宽度" @mousedown.prevent="rsStart"></div>
    <div class="sr-hd">
      <span class="sr-title">子 Agent</span>
      <select v-if="snaps.length" v-model="s.subRound" class="sr-round">
        <option value="cur">本轮</option>
        <option v-for="sn in snaps" :key="sn.round" :value="String(sn.round)">第 {{ sn.round }} 轮</option>
      </select>
      <span class="sr-note">异步活动 · 不占对话流</span>
      <span class="sp"></span>
      <button class="sr-x" title="收起" @click="subToggle(false)">✕</button>
    </div>
    <div class="sr-body">
      <!-- 本轮:实时清单 + 窗格 -->
      <template v-if="!snapItems">
        <div class="sr-list">
          <button
            v-for="a in s.subAgents" :key="a.id"
            class="sr-item" :class="{ on: active && a.id === active.id, err: a.err, done: a.done }"
            @click="s.subActiveId = a.id"
          >
            <span class="si-name">{{ a.name }}</span>
            <span class="si-meta">{{ meta(a) }}</span>
          </button>
          <div v-if="!s.subAgents.length" class="sr-empty">主 Agent 用 task 派子 Agent 并行干活时,这里会列出它们;点任意一个看它的思考 / 工具 / 产出全程</div>
        </div>
        <div v-if="active" class="sr-pane">
          <details v-if="active.reason" class="sa-reason" open>
            <summary>思考过程</summary>
            <div class="sa-rbody">{{ active.reason }}</div>
          </details>
          <div class="sa-tools">
            <ToolBlock v-for="t in active.tools" :key="t.id" :item="t" />
          </div>
          <details v-if="active.outHtml" class="sa-out" open>
            <summary>产出</summary>
            <div class="sa-obody md" v-html="active.outHtml"></div>
          </details>
        </div>
      </template>
      <!-- 历史轮:只读概要快照 -->
      <template v-else>
        <div class="sr-list">
          <div v-for="(it, i) in snapItems.items" :key="i" class="sr-item snap" :class="{ err: it.err, done: !it.err }">
            <span class="si-name">{{ it.name }}</span>
            <span class="si-meta">{{ snapMeta(it) }}</span>
          </div>
        </div>
        <div class="sr-pane">
          <div class="sr-empty">第 {{ snapItems.round }} 轮共派出 {{ snapItems.items.length }} 个子 Agent;历史轮次只保留概要(工具计数/耗时/读文件数/成败)—— 实时思考 / 工具 / 产出请看「本轮」</div>
        </div>
      </template>
    </div>
  </div>
</template>
