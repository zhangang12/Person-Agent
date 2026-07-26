<script setup lang="ts">
// chat 页根组件:标题栏 + 权限 sticky 摘要钉 + 对话流 + 输入条 + 成果抽屉 + 压缩续聊确认框。
// Esc 中断本轮(忙时);Y/A/N 权限审批快捷键(输入框聚焦时不抢,高危无 A)。
// wf/orch/shard 卡不走新页(cardImpl 开关在主进程侧强制 legacy):占位说明兜底,不留死路。
import { onMounted, onBeforeUnmount } from 'vue'
import { s, boot, abort, pendingPerms, replyPerm, compactCore } from './store'
import TitleBar from './TitleBar.vue'
import FeedView from './FeedView.vue'
import ComposerBar from './ComposerBar.vue'
import ArtDrawer from './ArtDrawer.vue'
import SubAgentRail from './SubAgentRail.vue'
import WfBar from './WfBar.vue'
import ShardPanel from './ShardPanel.vue'
import StatusLine from './StatusLine.vue'
import KDialog from '../components/KDialog.vue'

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && s.busy) { abort(); return }
  // Y/A/N:有权限条待批时快捷键批复第一条;输入态(textarea/input/可编辑)不抢字母键
  if (!pendingPerms.value.length) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return
  const first = pendingPerms.value[0]
  const k = e.key.toLowerCase()
  if (k === 'y') replyPerm(first, 'once')
  else if (k === 'a' && !first.highRisk) replyPerm(first, 'always')   // 高危没有「总是」—— 危险操作不许养成快捷键习惯
  else if (k === 'n') replyPerm(first, 'reject')
}
onMounted(() => {
  document.addEventListener('keydown', onKey)
  boot()
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

function scrollToPerm() {
  const el = document.querySelector('.permbar')
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' })
}
</script>

<template>
  <div class="chatcard">
    <span class="hl"></span>
    <TitleBar />
    <div v-if="s.unsupportedMode" class="unsupported">
      <p>本卡类型（{{ s.unsupportedMode }}）暂未迁移到新对话页。</p>
      <p class="sub">工作流 / 编排 / 分片卡仍由旧版卡片承载（cardImpl 开关强制 legacy）。当前页未连接引擎，可直接关闭。</p>
    </div>
    <template v-else>
      <!-- 权限 sticky 摘要钉:批准条被流式顶出视口后,输入框上方仍有一枚钉;点击滚回批准条 -->
      <button v-if="pendingPerms.length" class="permsticky" @click="scrollToPerm">
        ⏸ 待批准:{{ pendingPerms[0].tool }}{{ pendingPerms.length > 1 ? '(共 ' + pendingPerms.length + ' 项)' : '' }} —— 引擎在等你
      </button>
      <WfBar />
      <ShardPanel />
      <!-- 看门狗第二级横幅(绕圈提醒后仍不纠偏):判死权给人 —— 中止本轮 / 知道了 -->
      <div v-if="s.wdBanner" class="wdbanner">
        <span>⚠ 可能在绕圈：连续多轮反复读同一批文件、计划无进展（已提醒仍未纠偏）。判死权在你 ——</span>
        <button class="wd-x" @click="abort(); s.wdBanner = false">中止本轮</button>
        <button class="wd-ok" @click="s.wdBanner = false">知道了</button>
      </div>
      <FeedView />
      <StatusLine />
      <ComposerBar />
      <ArtDrawer />
      <SubAgentRail />
      <KDialog
        :open="s.compactAsk"
        title="压缩续聊"
        desc="让模型把本段对话总结成「接力摘要」，然后开一段新会话继续 —— 结论、路径、未完成事项都会带过去，上下文占用回到起点。原对话内容会从本卡清空（引擎侧历史仍在，可从卡坞找回）。"
        confirm-text="压缩并续聊"
        @update:open="(v) => (s.compactAsk = v)"
        @confirm="compactCore"
      />
    </template>
  </div>
</template>
