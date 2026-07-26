<!--
  TitleBar · 主窗口标题栏(38px)
  契约:desktop.html W1 —— bg-secondary 底 + 0.5px sep 下边;整栏拖动,按钮 no-drag;
  mac 红绿灯 hiddenInset 占位 82px;右侧引擎 chip(22px,与状态栏引擎灯同源)。
  设计稿标题栏的主题 ibtn(太阳图标)不落地:浅色单主题已锁定、切换机制退役(见报告)。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { KTooltip } from '../components'
import { store } from './store'

const isMac = /mac/i.test(navigator.platform || '')

const chipText = computed(() => {
  const st = store.engine
  if (st.state === 'ok') return '引擎 :' + st.port
  if (st.state === 'down') return '引擎失连'
  return '引擎未连接'
})
const chipTip = '引擎连接状态(保活心跳推送,与状态栏引擎灯同源)'
// 视图感知标题(设计稿 desktop W1-W4:标题栏显示当前视图名)
const viewTitle = computed(() => ({ chat: '对话', orch: '任务编排', mail: '邮件', settings: '设置', kb: '项目知识库' } as Record<string, string>)[store.view] || '')
</script>

<template>
  <header id="tbar" :class="{ mac: isMac }">
    <span class="tt">BocomHermes</span>
    <span v-if="viewTitle" class="vtt">{{ viewTitle }}</span>
    <span class="sp"></span>
    <KTooltip :content="chipTip" placement="bottom">
      <span class="chip" :class="{ ok: store.engine.state === 'ok' }">
        <span class="dot"></span>{{ chipText }}
      </span>
    </KTooltip>
  </header>
</template>

<style scoped>
#tbar {
  display: flex; align-items: center; gap: 9px; padding: 0 14px;
  background: var(--bg-secondary); border-bottom: 0.5px solid var(--sep);
  -webkit-app-region: drag;
}
#tbar.mac { padding-left: 82px; }   /* mac 红绿灯 hiddenInset 占位 */
.tt { font-size: 13px; font-weight: 600; color: var(--label-2); }
.vtt { font-size: 11px; color: var(--label-3); background: var(--fill-2); border-radius: var(--r-full); padding: 2px 9px; }
.sp { flex: 1; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px;
  border-radius: var(--r-full); background: var(--fill-1); border: 0.5px solid var(--sep);
  font: var(--c1-em); color: var(--label-3); white-space: nowrap; -webkit-app-region: no-drag;
}
.chip.ok { color: var(--label-2); }
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--label-3); flex: none; }
.chip.ok .dot { background: var(--green); }
</style>
