<!--
  QuickInput · 快捷输入层(S1)
  契约:desktop.html W1 注释 + screens.html S1 输入容器 —— 视图区顶部居中浮层,
  20px 圆角(全系统唯一特许值) + bg-primary 底 + 0.5px sep 边 + shadow.inputDefault;
  唤起 150ms ease-out scale(.97→1)(v-if 重挂载即重播,等价 legacy 强制 reflow);
  遮罩点击/Esc 关闭;Enter = 收起 + 发卡收口同路径开新会话;⌃⇧V 预填剪贴板(主进程推送);
  发送钮 28px 正圆,按压 scale(0.92)(S1 spec)。
  设计稿 S1 的模型 chip / 技能 chip / 附件钮无 IPC 通道,归 P2(见报告)。
-->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { store, closeQuick, submitQuick } from './store'

const ta = ref<HTMLTextAreaElement | null>(null)

function qiAuto() {   // 单行起,随内容自动长高(120px 上限由 CSS max-height 兜,超出滚动)
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}
function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitQuick() }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeQuick() }
}
function onMaskDown(ev: MouseEvent) { if (ev.target === ev.currentTarget) closeQuick() }   // 点击遮罩关闭

watch(() => store.quick.open, async (v) => {
  if (!v) return
  await nextTick()
  qiAuto()
  const el = ta.value
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
})
</script>

<template>
  <div v-if="store.quick.open" id="quickMask" @mousedown="onMaskDown">
    <div id="quickIn" @mousedown.stop>
      <textarea
        ref="ta"
        v-model="store.quick.text"
        rows="1"
        placeholder="问点什么,Enter 即开新会话…"
        @input="qiAuto"
        @keydown="onKey"
      ></textarea>
      <div id="qiBar">
        <span id="qiHint"><span>Enter 发送</span><span>Shift+Enter 换行</span><span>Esc 关闭</span><span>⌃⇧V 带入剪贴板</span></span>
        <span class="sp"></span>
        <button class="k-send" title="发送(Enter)" @click="submitQuick">
          <svg class="ic s16" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
#quickMask {
  position: absolute; inset: 0; z-index: 50; display: flex; align-items: flex-start; justify-content: center;
  background: rgba(0, 0, 0, 0.15); animation: qk-fade 0.15s ease-out;
}
@keyframes qk-fade { from { opacity: 0; } }
#quickIn {
  margin-top: 72px; width: min(560px, calc(100% - 64px)); border-radius: 20px; padding: 12px 16px 9px;
  background: var(--bg-primary); border: 0.5px solid var(--sep); box-shadow: var(--shadow-input);
  animation: qk-in 0.15s ease-out;
}
@keyframes qk-in { from { opacity: 0; transform: scale(0.97); } }
#quickIn textarea {
  display: block; width: 100%; box-sizing: border-box; border: none; outline: none; resize: none;
  background: transparent; color: var(--label-1); font: var(--b2); font-size: 13.5px; line-height: 20px;
  max-height: 120px; overflow-y: auto; padding: 2px 0;
}
#quickIn textarea::placeholder { color: var(--label-4); }
#qiBar { margin-top: 6px; display: flex; align-items: center; gap: 12px; }
#qiHint { font-size: 11px; color: var(--label-3); display: flex; gap: 12px; }
.sp { flex: 1; }
.k-send {
  width: 28px; height: 28px; border-radius: 50%; background: var(--brand); color: var(--brand-text);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  transition: transform var(--btn-press-dur) var(--ez-out);
}
.k-send:active { transform: scale(0.92); }   /* S1 spec:发送钮按压 scale(0.92) */
</style>
