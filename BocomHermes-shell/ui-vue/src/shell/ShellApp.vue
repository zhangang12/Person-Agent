<!--
  ShellApp · 主窗口 shell(P1 Vue 重写,平移 ui/shell.html 全部行为)
  布局契约(desktop.html W1):38px 标题栏 + 主区(228px 侧栏 + 视图区) + 28px 状态栏;
  白底浅色单主题;视图区四容器同时只显一个,webview 懒创建且保活(切走只是隐藏)。
  对话空态(interactions.html 08):给一个可照抄的例句 + 快捷键 chip,而不是一句「暂无数据」。
  W1 右栏 264px 上下文面板:preload 无整组数据通道,本阶段不做,归 P2(见报告)。
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { KButton, KChip, KDialog, KToaster } from '../components'
import TitleBar from './TitleBar.vue'
import SideBar from './SideBar.vue'
import StatusBar from './StatusBar.vue'
import QuickInput from './QuickInput.vue'
import { store, PRELOAD_URL, bindWv, spawnChat, closeChat, wireShell, viewSrc, viewWv } from './store'

onMounted(() => { wireShell() })

// 有 webview 的会话(收养条目无 webview,不占视图区)
const wvChats = computed(() => store.chats.filter((c) => c.hasWv))

function onConfirmClose() {
  const key = store.confirmCloseKey
  store.confirmCloseKey = ''
  if (key) closeChat(key, true)
}
</script>

<template>
  <div id="shell">
    <TitleBar />

    <div id="body">
      <SideBar />

      <main id="main">
        <!-- 对话视图:每会话一个 webview 保活(切走仅隐藏);右栏 = W1 上下文面板(可收起) -->
        <section class="view" :class="{ on: store.view === 'chat' }">
          <div class="chatcol">
            <div v-if="!store.chats.length" id="chatEmpty">
              <div class="eg">
                试试:「月度结息金额和核心系统对不上,帮我看下 <code>InterestCalc.monthly()</code> 的逻辑」
              </div>
              <div class="shortcuts">
                <KChip class="sc">粘贴截图提问 ⌃⇧S</KChip>
                <KChip class="sc">带入剪贴板 ⌃⇧V</KChip>
              </div>
              <KButton class="big" @click="spawnChat({ title: '新会话' })">
                <svg class="ic" style="width: 14px; height: 14px; stroke-width: 2.4" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                新建对话
              </KButton>
            </div>
            <webview
              v-for="c in wvChats" :key="c.key"
              :src="c.src"
              :preload="PRELOAD_URL"
              class="chat-wv"
              :style="{ display: store.view === 'chat' && c.key === store.activeKey ? 'flex' : 'none' }"
              :ref="(el: any) => bindWv(c.key, el)"
            ></webview>
          </div>
        </section>

        <!-- 编排 / 动态工作流 / 邮件 / 设置 / 知识库 / 技能中心视图:webview 懒创建且保活 -->
        <section v-for="v in (['orch', 'wf', 'mail', 'settings', 'kb', 'skills'] as const)" :key="v" class="view" :class="{ on: store.view === v }">
          <webview
            v-if="store.visited.includes(v)"
            :src="viewSrc(v)"
            :preload="PRELOAD_URL"
            class="chat-wv"
            :ref="(el: any) => { if (el) { viewWv[v] = el; if (v === 'settings') el.addEventListener('dom-ready', () => { el.__kbReady = true }) } }"
          ></webview>
        </section>

        <!-- 快捷输入层(S1):⌃⇧Space 唤起 -->
        <QuickInput />
      </main>
    </div>

    <StatusBar />

    <!-- 运行中会话关闭确认闸(legacy 直接关;此处仅对 busy 会话加一道确认,见报告) -->
    <KDialog
      :open="!!store.confirmCloseKey"
      title="关闭运行中的会话?"
      desc="该会话的任务还在运行,关闭将中止任务并清理会话上下文。确定关闭?"
      confirm-text="关闭"
      destructive
      @confirm="onConfirmClose"
      @update:open="store.confirmCloseKey = ''"
    />
    <KToaster />
  </div>
</template>

<style>
/* 全局(本页是顶层窗口自身):实底 + body 无 padding + 满高 */
html, body { height: 100%; background: var(--bg-primary); }
body { padding: 0; }
#app { height: 100%; }
</style>

<style scoped>
#shell { height: 100%; display: grid; grid-template-rows: 38px 1fr 28px; }
#body { display: grid; grid-template-columns: 228px 1fr; min-height: 0; }
#main { min-width: 0; min-height: 0; position: relative; }
.view { position: absolute; inset: 0; display: none; flex-direction: column; }
.view.on { display: flex; }
.chatcol { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.chat-wv { flex: 1; min-height: 0; display: flex; border: none; }

/* 对话空态(设计稿空态契约:可照抄的例句 + 快捷键入口) */
#chatEmpty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 0 40px; }
#chatEmpty .eg { font-size: 13px; color: var(--label-3); line-height: 1.8; text-align: center; max-width: 460px; }
#chatEmpty .eg code {
  font-family: var(--font-mono); font-size: 12px; background: var(--fill-1);
  padding: 1px 6px; border-radius: 5px; color: var(--label-2);
}
#chatEmpty .shortcuts { display: flex; gap: 8px; }
#chatEmpty .sc { height: 24px; font: var(--c1); pointer-events: none; }
#chatEmpty .big { height: 34px; padding: 0 20px; }
</style>
