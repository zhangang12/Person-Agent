<!--
  ShellApp · 主窗口 shell(P1 Vue 重写,平移 ui/shell.html 全部行为)
  布局契约(desktop.html W1):38px 标题栏 + 主区(228px 侧栏 + 视图区) + 28px 状态栏;
  白底浅色单主题;视图区四容器同时只显一个,webview 懒创建且保活(切走只是隐藏)。
  对话空态(interactions.html 08):给一个可照抄的例句 + 快捷键 chip,而不是一句「暂无数据」。
  W1 右栏 264px 上下文面板:preload 无整组数据通道,本阶段不做,归 P2(见报告)。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { KButton, KChip, KDialog, KToaster } from '../components'
import TitleBar from './TitleBar.vue'
import SideBar from './SideBar.vue'
import StatusBar from './StatusBar.vue'
import QuickInput from './QuickInput.vue'
import { store, PRELOAD_URL, bindWv, spawnChat, closeChat, wireShell, viewSrc, viewWv, toggleSplit, setSplitW, pushSplit, sideWNow } from './store'

onMounted(() => { wireShell() })

// 有 webview 的会话(收养条目无 webview,不占视图区)
const wvChats = computed(() => store.chats.filter((c) => c.hasWv))

// ── 侧栏宽度拖拽(2026-07 评审要求):拖右缘 168~420px,localStorage 持久化 ──
// 注意:拖动经过 webview 时鼠标事件会被 guest 进程吃掉 → 拖拽期间盖一层透明罩,事件全落在本页。
const SBW_KEY = 'bh.sbw'
const clampW = (v: number) => Math.min(420, Math.max(168, Math.round(v) || 228))
const sbw = ref(clampW(+(localStorage.getItem(SBW_KEY) || 228)))
const sbDragging = ref(false)
function sbDragStart(e: MouseEvent) {
  const x0 = e.clientX, w0 = sbw.value
  sbDragging.value = true
  const move = (ev: MouseEvent) => { sbw.value = clampW(w0 + ev.clientX - x0) }
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    sbDragging.value = false
    try { localStorage.setItem(SBW_KEY, String(sbw.value)) } catch {}
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ── 同屏分栏:对话在左、内嵌浏览器在右 ──────────────────────────────────────
// 拖拽实现照抄侧栏那套(spDragging 期间盖透明罩)—— webview 会吃掉经过它的鼠标事件,不罩住就断线。
const spDragging = ref(false)
function spDragStart(e: MouseEvent) {
  const x0 = e.clientX, w0 = store.splitW
  spDragging.value = true
  const move = (ev: MouseEvent) => {
    const max = window.innerWidth - sideWNow() - 360   // 右边至少给浏览器留 360,再窄没法看
    setSplitW(Math.min(Math.max(360, w0 + ev.clientX - x0), Math.max(360, max)))
  }
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    spDragging.value = false
    setSplitW(store.splitW, true)     // 落定才写 localStorage,拖动过程不写
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
// 窗口大小变了要重报:主进程按内容区现算几何,不重报就会留下一条错位的边
onMounted(() => { window.addEventListener('resize', () => { if (store.splitW > 0) pushSplit() }) })

function onConfirmClose() {
  const key = store.confirmCloseKey
  store.confirmCloseKey = ''
  if (key) closeChat(key, true)
}
</script>

<template>
  <div id="shell">
    <TitleBar />

    <div id="body" :style="{ gridTemplateColumns: sbw + 'px 1fr' }">
      <SideBar />

      <!-- 侧栏右缘拖拽柄 -->
      <div id="sbResizer" :class="{ on: sbDragging }" :style="{ left: (sbw - 3) + 'px' }" title="拖拽调整侧栏宽度" @mousedown.prevent="sbDragStart"></div>
      <!-- 拖拽期透明罩:webview 会吃掉经过它的鼠标事件,罩住整窗保证拖拽不断线 -->
      <div v-if="sbDragging" id="sbDragMask"></div>

      <main id="main">
        <!-- 对话视图:每会话一个 webview 保活(切走仅隐藏);右栏 = W1 上下文面板(可收起) -->
        <section class="view" :class="{ on: store.view === 'chat' }">
          <!-- 同屏分栏:开着时对话只占左边 splitW,右边那块留给内嵌浏览器(原生视图,由主进程贴上来) -->
          <div class="chatcol" :style="store.splitW > 0 ? { flex: '0 0 ' + store.splitW + 'px', maxWidth: store.splitW + 'px' } : null">
            <!-- 开关:并排看浏览器。放在 shell 这一层 —— 对话本体是 webview,塞不进去 -->
            <button class="splitbtn" :class="{ on: store.splitW > 0 }"
              :title="store.splitW > 0 ? '关掉并排浏览器(对话铺满)' : '在对话旁边打开内嵌浏览器(一边聊一边看它点页面)'"
              @click="toggleSplit()">{{ store.splitW > 0 ? '⇤ 关闭浏览器' : '⇥ 并排浏览器' }}</button>
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
          <!-- 分隔条:拖它调对话/浏览器的比例(拖动期透明罩见下,防 webview 吃事件) -->
          <div v-if="store.splitW > 0" class="spResizer" :class="{ on: spDragging }"
            :style="{ left: (sbw + store.splitW - 3) + 'px' }" title="拖拽调整对话与浏览器的比例"
            @mousedown.prevent="spDragStart"></div>
          <div v-if="spDragging" id="sbDragMask"></div>
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
#body { display: grid; grid-template-columns: 228px 1fr; min-height: 0; position: relative; }
#main { min-width: 0; min-height: 0; position: relative; }

/* 侧栏右缘拖拽柄:默认隐形,hover/拖拽中亮一条 accent 细线 */
#sbResizer { position: absolute; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 40; }
#sbResizer::after { content: ''; position: absolute; top: 0; bottom: 0; left: 2px; width: 2px; background: transparent; transition: background .15s; }
#sbResizer:hover::after, #sbResizer.on::after { background: var(--blue); opacity: .55; }
#sbDragMask { position: fixed; inset: 0; z-index: 999; cursor: col-resize; }
.view { position: absolute; inset: 0; display: none; flex-direction: column; }
.view.on { display: flex; }
.chatcol { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
/* 同屏分栏 */
.splitbtn { position: absolute; top: 6px; right: 8px; z-index: 6; height: 24px; padding: 0 10px;
  border: 1px solid var(--line, #e3e6ee); border-radius: 12px; background: #fff; color: #5b6376;
  font-size: 12px; cursor: pointer; opacity: .72; }
.splitbtn:hover { opacity: 1; }
.splitbtn.on { background: #eef3ff; border-color: #c7d8ff; color: #2f5fd0; opacity: 1; }
.spResizer { position: absolute; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 7; }
.spResizer:hover, .spResizer.on { background: rgba(47, 95, 208, .18); }
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
