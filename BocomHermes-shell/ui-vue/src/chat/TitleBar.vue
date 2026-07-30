<script setup lang="ts">
// 标题栏(设计稿 S2):拖动柄 → 会话色点 → 标题 → 项目名 → chips(模型菜单/ctx 用量) → verbose → 成果 → 保活灯 → 窗口控件
// ctx chip:<5% 隐藏;<60% 绿 / 60-80% 橙 / >80% 红(设计稿口径);点击 = 压缩续聊确认(KDialog 挂 ChatApp)。
// embedded 模式:去窗口控件(宿主窗口的系统边框负责)。
import { ref, computed, onMounted } from 'vue'
import { s, toggleVerbose, listModels, setModel, listAgents, setAgent, subToggle, subRunningCount, pickProject, setSessionTitle, togglePermMode } from './store'
import { ctxPctVal, ctxLevel, ctxChipText, ctxChipTitle } from './lib/ctxchip'
import { BH } from './bridge'
import KMenu from '../components/KMenu.vue'
import KBadge from '../components/KBadge.vue'

// 会话色点:按 session 哈希取 4 色轮换(blue/green/orange/purple,设计稿 S2/interactions §4),多卡并行一眼区分
const TINTS = ['#1783ff', '#16c456', '#ff9500', '#985ffb']
const tintStyle = computed(() => {
  let h = 0
  for (const c of String(s.sessionId || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return { background: TINTS[h % TINTS.length] }
})

// ── 模型菜单(chip → KMenu;60s 缓存走 store.listModels) ──
const modelItems = ref<{ key: string; label: string; checked?: boolean }[]>([])
async function loadModels() {
  const ms = await listModels()
  modelItems.value = ms.map((m: any) => ({
    key: m.providerID + '/' + m.modelID,
    label: m.name || (m.providerID + '/' + m.modelID),
    checked: (m.providerID + '/' + m.modelID) === s.modelKey,
  }))
}
function onModelSelect(key: string) { setModel(key) }

// ── Agent 菜单(chip → KMenu;60s 缓存走 store.listAgents;空清单=老 serve 不显示) ──
const agentItems = ref<{ key: string; label: string; checked?: boolean }[]>([])
const hasAgents = ref(false)
async function loadAgents() {
  const as = await listAgents()
  hasAgents.value = as.length > 1   // 只有默认 build 一个也没必要给切换
  agentItems.value = [{ key: '', label: '默认（build）', checked: !s.agentName },
    ...as.map((a: any) => ({ key: a.name, label: a.name + (a.description ? ' · ' + String(a.description).slice(0, 40) : ''), checked: a.name === s.agentName }))]
}
function onAgentSelect(key: string) { setAgent(key) }
onMounted(() => { loadAgents() })   // 开卡即探一次清单(空=老 serve 藏入口;OMO 装的插件 Agent 一并列出)

// ── ctx 用量 chip(实测优先,估算 ~ 前缀;点击 → 压缩续聊确认) ──
const ctxPct = computed(() => ctxPctVal(s.ctxRealTokens, s.ctxUsedChars, s.ctxLimitTokens))
const ctxLv = computed(() => ctxLevel(ctxPct.value))
const ctxText = computed(() => ctxChipText(ctxPct.value, s.ctxRealTokens != null))
const ctxTitle = computed(() => ctxChipTitle(s.ctxRealTokens, s.ctxUsedChars, s.ctxLimitTokens, s.ctxCacheHit, ctxPct.value))

// ── 保活灯:ok=绿 / false=红 / null(未收到过心跳)=灰 ──
const hbCls = computed(() => (s.hb.ok == null ? 'gray' : s.hb.ok ? 'ok' : 'bad'))
const hbTitle = computed(() => '引擎保活' + (s.hb.port ? ' · :' + s.hb.port : '') + (s.hb.at ? ' · 心跳 ' + s.hb.at : ''))

const pinOn = ref(false)
async function onPin() {
  try { pinOn.value = !!(await BH()?.togglePin?.()) } catch { /* 静默 */ }
}
const call = (fn: 'closeSelf' | 'minimizeSelf' | 'toggleMaximize') => {
  try { (BH() as any)?.[fn]?.() } catch { /* 静默 */ }
}
// 标题内联改名:点击标题 → 输入态(Enter 保存 / Esc 取消 / 失焦保存);手改后首轮自动命名不再覆盖
const editing = ref(false)
const editText = ref('')
const editEl = ref<HTMLInputElement | null>(null)
function startEdit() {
  editText.value = s.title
  editing.value = true
  setTimeout(() => { try { editEl.value && editEl.value.select() } catch { /* 静默 */ } }, 0)
}
function commitEdit() {
  const v = editText.value.trim()
  editing.value = false
  if (v) setSessionTitle(v, { manual: true })
}
</script>

<template>
  <div class="k-hd">
    <span class="k-grip" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><circle cx="8" cy="6" r="1.1"/><circle cx="8" cy="12" r="1.1"/><circle cx="8" cy="18" r="1.1"/><circle cx="13" cy="6" r="1.1"/><circle cx="13" cy="12" r="1.1"/><circle cx="13" cy="18" r="1.1"/></svg></span>
    <span class="dot" :style="tintStyle" aria-hidden="true"></span>
    <input
      v-if="editing" ref="editEl" v-model="editText" class="k-title-edit"
      @keydown.enter="commitEdit" @keydown.esc="editing = false" @blur="commitEdit"
    >
    <span v-else class="k-title" title="点击改名" @click="startEdit"><span v-if="s.done" class="done-tick">✓</span>{{ s.title }}</span>
    <span v-if="s.project" class="k-dir projchip" :title="'点击切换本卡对话的代码仓库 · ' + (s.dir || '')" @click="pickProject">📁 {{ s.project }}</span>
    <span class="sp"></span>
    <KMenu :items="modelItems" placement="bottom-end" @select="onModelSelect" @update:open="(v) => v && loadModels()">
      <span class="k-chip clickable" :title="'当前模型：' + s.modelLabel + '(点击切换)'">{{ s.modelLabel }}</span>
    </KMenu>
    <KMenu v-if="hasAgents || s.agentName" :items="agentItems" placement="bottom-end" @select="onAgentSelect" @update:open="(v) => v && loadAgents()">
      <span class="k-chip clickable agentchip" :class="{ accent: !!s.agentName }" :title="'当前 Agent：' + (s.agentName || 'build') + '(点击切换 · OMO 插件 Agent 也在此列)'">{{ s.agentName || 'build' }}</span>
    </KMenu>
    <span class="k-chip clickable permchip" :class="{ auto: s.permMode === 'auto' }"
          :title="s.permMode === 'auto' ? '本会话权限：自动放行（写文件/执行命令不再弹框 · deny 红线兜底 · edit 预检生效 · 放行记审计 · 只影响本卡）｜点击切回逐次确认' : '本会话权限：逐次确认（写文件/执行命令逐次弹框批准）｜点击切到自动放行（只影响本卡）'"
          @click="togglePermMode">{{ s.permMode === 'auto' ? '自动放行' : '逐次确认' }}</span>
    <span v-if="ctxLv !== 'hidden'" class="k-chip ctxchip clickable" :class="ctxLv" :title="ctxTitle" @click="s.compactAsk = true">{{ ctxText }}</span>
    <button class="ibtn" :class="{ on: s.verbose }" title="过程详情(verbose):工具块自动展开入参/结果" aria-label="过程详情" @click="toggleVerbose">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
    </button>
    <button v-if="s.subAgents.length" class="ibtn artbtn" :class="{ on: s.subOpen }" title="子 Agent:点任意一个看它的思考 / 工具 / 产出全程" aria-label="子 Agent" @click="subToggle()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>
      <KBadge v-if="subRunningCount()" type="green" class="artbadge">{{ subRunningCount() }}</KBadge>
    </button>
    <button class="ibtn artbtn" :class="{ on: s.artOpen }" title="成果抽屉:最终结论 + 产出文件" aria-label="成果抽屉" @click="s.artOpen = !s.artOpen">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
      <KBadge v-if="s.artFiles.length" type="blue" class="artbadge">{{ s.artFiles.length }}</KBadge>
    </button>
    <span class="dot hb-dot" :class="hbCls" :title="hbTitle"></span>
    <template v-if="!s.embedded">
      <button class="ibtn" :class="{ on: pinOn }" :title="pinOn ? '已置顶（点击取消）' : '置顶'" aria-label="置顶" @click="onPin"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1.2 5.2L17 12v2H7v-2l3.2-2.8z"/><path d="M12 14v6"/></svg></button>
      <button class="ibtn" title="最大化 / 还原" aria-label="最大化" @click="call('toggleMaximize')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>
      <button class="ibtn" title="最小化" aria-label="最小化" @click="call('minimizeSelf')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg></button>
      <button class="ibtn" title="关闭" aria-label="关闭" @click="call('closeSelf')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </template>
  </div>
</template>
