<!--
  StatusBar · 主窗口状态栏(28px)
  契约:desktop.html W1 —— bg-secondary 底 + 0.5px sep 上边;c1 label-3。
  只显示有真实来源的数据:左 = 项目目录;右 = 引擎保活 / 会话忙闲 / 编排并发 / 主题(锁定浅色,只展示)。
  设计稿的 git 分支(⎇ main)与上下文 token 真值无 IPC 通道,归 P2(见报告)。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { KTooltip } from '../components'
import { store } from './store'

const sessText = computed(() => {
  let busy = 0
  for (const c of store.chats) if (c.busy) busy++
  return { n: store.chats.length, busy }
})
const engText = computed(() => {
  const st = store.engine
  if (st.state === 'ok') return '引擎 :' + st.port
  if (st.state === 'down') return '引擎失连'
  return '未连接'
})
</script>

<template>
  <footer id="sbar">
    <KTooltip :content="store.projDir || '未选目录'" placement="top">
      <span id="sbProj">
        <svg class="ic" style="width: 11px; height: 11px" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
        {{ store.projName }}
      </span>
    </KTooltip>
    <span class="sp"></span>
    <KTooltip content="引擎保活(主进程心跳聚合推送;初始探测拿不到即未连接)" placement="top">
      <span id="sbEng" :class="{ ok: store.engine.state === 'ok' }"><span class="dot"></span>{{ engText }}</span>
    </KTooltip>
    <KTooltip content="活动会话(侧栏会话列表 + 忙闲转发)" placement="top">
      <span id="sbSess">会话 {{ sessText.n }}<span v-if="sessText.busy" class="busyN"> · 忙 {{ sessText.busy }}</span></span>
    </KTooltip>
    <KTooltip content="编排并发:运行中工作流 / 上限(主进程只读 IPC,5s 轮询)" placement="top">
      <span id="sbWf">编排 {{ store.wf.running }}/{{ store.wf.max }}</span>
    </KTooltip>
    <span id="sbTheme">主题 浅色</span>
  </footer>
</template>

<style scoped>
#sbar {
  display: flex; align-items: center; gap: 14px; padding: 0 14px;
  background: var(--bg-secondary); border-top: 0.5px solid var(--sep);
  font: var(--c1); color: var(--label-3);
}
.sp { flex: 1; }
#sbProj { display: inline-flex; align-items: center; gap: 4px; }
#sbEng .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--label-3); margin-right: 5px; }
#sbEng.ok .dot { background: var(--green); }
#sbEng.ok { color: var(--label-2); }
#sbSess .busyN { color: var(--blue); font-weight: 600; }
</style>
