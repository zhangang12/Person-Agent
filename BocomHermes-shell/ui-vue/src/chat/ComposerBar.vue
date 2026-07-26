<script setup lang="ts">
// 输入条(composer):#ci textarea(硬兼容点②:宿主 executeJavaScript 填 #ci 并 dispatch input)
// 行为平移:Enter 发送 / Shift+Enter 换行 / IME 组合态不发送 / ↑↓ 翻输入历史(50 条,仅首末行接管)
// 自增高(1~约5行,96px 顶)/ 输入即存草稿、发送即清、续接恢复 / 附件(拖拽文档 getDropPath + 粘贴截图)
// 忙时发送钮变停止钮(cardAbort)。
// 不做(第二棒):"/" 作答技能菜单、快捷指令条(quick chips)。
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { s, submit, abort, saveDraft, addNote } from './store'
import { imeGuard } from './lib/ime'
import { BH } from './bridge'

interface Att { kind: 'image' | 'doc'; name: string; path?: string; mime?: string; dataUrl?: string }

const ci = ref<HTMLTextAreaElement | null>(null)
const value = ref('')
const pendingAtts = ref<Att[]>([])
const dropOn = ref(false)

// ── 自增高(1~约5行) ──
function autoGrow() {
  const el = ci.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 96) + 'px'
}

// ── 输入历史(↑/↓ 翻,50 条顶;翻到某条后一编辑即退出翻阅态) ──
const sentHistory: string[] = []
let histIdx = -1, histDraft = ''
function histNav(d: number): boolean {
  const el = ci.value
  if (!el || !sentHistory.length) return false
  if (histIdx === -1) { if (d > 0) return false; histDraft = value.value; histIdx = sentHistory.length - 1 }
  else { histIdx += d }
  if (histIdx >= sentHistory.length) { histIdx = -1; value.value = histDraft }
  else { histIdx = Math.max(0, histIdx); value.value = sentHistory[histIdx] }
  nextTick(() => { autoGrow(); el.setSelectionRange(el.value.length, el.value.length) })
  return true
}

function onKeydown(e: KeyboardEvent) {
  if (imeGuard(e)) return   // IME 组合态:选字键不发送不翻历史
  const el = ci.value
  if (!el) return
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSubmit(); return }
  if (e.key === 'ArrowUp' && el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes('\n')) {
    if (histNav(-1)) e.preventDefault()
  } else if (e.key === 'ArrowDown' && histIdx !== -1 && el.selectionStart === el.selectionEnd && !el.value.slice(el.selectionEnd).includes('\n')) {
    if (histNav(1)) e.preventDefault()
  }
}

function doSubmit() {
  const v = value.value.trim()
  if (!v && !pendingAtts.value.length) return
  if (v) {
    if (sentHistory[sentHistory.length - 1] !== v) sentHistory.push(v)
    if (sentHistory.length > 50) sentHistory.shift()
  }
  histIdx = -1; histDraft = ''
  const atts = pendingAtts.value.slice()
  value.value = ''
  pendingAtts.value = []
  nextTick(autoGrow)
  submit(v, atts)
}

function onSendBtn() {
  if (s.busy) abort()   // 忙时 = 停止钮
  else doSubmit()
}

// ── 草稿:输入即存(store 内按 cardDraft:sid);续接恢复(boot 写回 s.restoredDraft) ──
watch(value, (v) => { autoGrow(); saveDraft(v); histIdx = -1 })
watch(() => s.restoredDraft, async (d) => {
  if (d && !value.value.trim()) {
    value.value = d
    await nextTick()
    autoGrow()
    addNote('已恢复上次未发送的草稿')
  }
})

// ── 附件:拖拽文档(getDropPath 取路径,read_document 按需读)+ 粘贴截图(dataUrl 多模态) ──
const fileToDataUrl = (file: File) => new Promise<string>((res, rej) => {
  const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file)
})
async function addFile(file: File) {
  const mime = file.type || ''
  if (/^image\//.test(mime)) {
    try {
      const dataUrl = await fileToDataUrl(file)
      pendingAtts.value.push({ kind: 'image', name: file.name || '截图.png', mime, dataUrl })
    } catch { /* 静默 */ }
  } else {
    const fpath = (BH()?.getDropPath && BH()!.getDropPath(file)) || (file as any).path || ''
    if (fpath) pendingAtts.value.push({ kind: 'doc', name: file.name || '文档', path: fpath })
    else addNote('读不到拖入文件的路径')
  }
}
function removeAtt(i: number) { pendingAtts.value.splice(i, 1) }
function onDrag(ev: DragEvent) {
  if (ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files')) { ev.preventDefault(); dropOn.value = true }
}
function onDragLeave(ev: DragEvent) { if (!ev.relatedTarget) dropOn.value = false }
async function onDrop(ev: DragEvent) {
  ev.preventDefault(); dropOn.value = false
  const fs = Array.from((ev.dataTransfer && ev.dataTransfer.files) || [])
  for (const f of fs) await addFile(f)
}
async function onPaste(ev: ClipboardEvent) {
  const items = (ev.clipboardData && ev.clipboardData.items) || []
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type)) {
      const f = it.getAsFile()
      if (f) { ev.preventDefault(); await addFile(f) }
    }
  }
}

onMounted(() => {
  document.addEventListener('dragenter', onDrag)
  document.addEventListener('dragover', onDrag)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop)
  document.addEventListener('paste', onPaste)
  ci.value?.focus()
})
onBeforeUnmount(() => {
  document.removeEventListener('dragenter', onDrag)
  document.removeEventListener('dragover', onDrag)
  document.removeEventListener('dragleave', onDragLeave)
  document.removeEventListener('drop', onDrop)
  document.removeEventListener('paste', onPaste)
})
</script>

<template>
  <div class="composer-wrap">
    <!-- 附件行 -->
    <div v-if="pendingAtts.length" class="att-row">
      <div v-for="(a, i) in pendingAtts" :key="i" class="att">
        <img v-if="a.kind === 'image'" :src="a.dataUrl" alt="" />
        <span v-else class="att-ic">▤</span>
        <span class="an">{{ a.name }}</span>
        <span class="ax" @click="removeAtt(i)">✕</span>
      </div>
    </div>
    <div class="composer">
      <!-- 硬兼容点②:id="ci" 必须保留,宿主 executeJavaScript 填值 + dispatch input -->
      <textarea
        id="ci"
        ref="ci"
        v-model="value"
        rows="1"
        placeholder="继续对话…（Enter 发送 · Shift+Enter 换行 · ↑ 翻输入历史）"
        @keydown="onKeydown"
      ></textarea>
      <button class="send" :class="{ stop: s.busy }" :aria-label="s.busy ? '中断本轮' : '发送'" :title="s.busy ? '中断本轮' : '发送'" @click="onSendBtn">
        <svg v-if="!s.busy" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      </button>
    </div>
    <div class="drop-hint" :class="{ show: dropOn }">松手上传 — 文档解析成文本，图片走多模态识别</div>
  </div>
</template>
