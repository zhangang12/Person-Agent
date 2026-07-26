<script setup lang="ts">
// 输入条(composer):#ci textarea(硬兼容点②:宿主 executeJavaScript 填 #ci 并 dispatch input)
// 行为平移:Enter 发送 / Shift+Enter 换行 / IME 组合态不发送 / ↑↓ 翻输入历史(50 条,仅首末行接管)
// 自增高(1~约5行,96px 顶)/ 输入即存草稿、发送即清、续接恢复 / 附件(拖拽文档 getDropPath + 粘贴截图)
// 忙时发送钮变停止钮(cardAbort)。
// 第二棒:"/" 作答技能菜单 + 技能 chip、快捷指令条(QUICK + 查看本次改动 + 我的记忆弹层)。
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { s, submit, abort, saveDraft, addNote, addAiStatic, listSkills, setActiveSkill } from './store'
import { imeGuard } from './lib/ime'
import { BH } from './bridge'

interface Att { kind: 'image' | 'doc'; name: string; path?: string; mime?: string; dataUrl?: string }
interface Skill { id: string; name: string; desc?: string; body?: string }

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
  if (slashOpen.value && e.key === 'Escape') { e.preventDefault(); slashOpen.value = false; return }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSubmit(); return }
  if (e.key === 'ArrowUp' && el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes('\n')) {
    if (histNav(-1)) e.preventDefault()
  } else if (e.key === 'ArrowDown' && histIdx !== -1 && el.selectionStart === el.selectionEnd && !el.value.slice(el.selectionEnd).includes('\n')) {
    if (histNav(1)) e.preventDefault()
  }
}

// ── 作答技能('/' 菜单,旧页 skill menu 平移):输入行首 / 唤起,按后续字符过滤;选定挂载为 chip,✕ 卸载 ──
const skills = ref<Skill[]>([])
const slashOpen = ref(false)
const slashFilter = ref('')
let skillsLoaded = false
watch(value, async (v) => {
  const m = v.match(/^\/(\S*)$/)
  if (m) {
    slashFilter.value = m[1]
    slashOpen.value = true
    if (!skillsLoaded) { skillsLoaded = true; skills.value = (await listSkills()) as Skill[] }
  } else if (slashOpen.value) slashOpen.value = false
})
function slashList(): Skill[] {
  const q = slashFilter.value.toLowerCase()
  return skills.value.filter((sk) => !q || sk.name.toLowerCase().includes(q)).slice(0, 8)
}
function pickSkill(sk: Skill) {
  setActiveSkill({ id: sk.id, name: sk.name, desc: sk.desc })
  value.value = ''
  slashOpen.value = false
  nextTick(() => { autoGrow(); ci.value?.focus() })
}
function unloadSkill() { setActiveSkill(null) }

// ── 快捷指令条(旧页 QUICK 平移,在这个数组里增删即可迭代) ──
const QUICK = [
  { label: '✓ 批准方案 → 改', text: '批准方案。请按你刚才的计划用编辑工具完成修改;改完调 repro_assert/repro_self_review 登记,再简要总结改了什么。我改完后会自动用 git diff 把改动展示给我看。', highlight: true },
  { label: '改成可应用 diff', text: '把你上面给出的修改整理成统一 diff：用 ```diff 围栏，包含 +++/--- 文件头和 @@ 行号，便于我一键应用到对应文件。' },
  { label: '补单元测试', text: '为刚才的改动补充单元测试，覆盖正常路径与边界场景。' },
  { label: '加中文注释', text: '给刚才的代码补上必要的中文注释，解释关键逻辑，但不要改变行为。' },
  { label: '查风险', text: '审视刚才的改动是否存在空指针、并发、SQL 注入、事务边界等风险，逐条列出（必改/建议）并给修法。' },
  { label: '解释代码', text: '用简洁的中文解释上面的代码：目的是什么，关键步骤，有哪些潜在的坑。' },
  { label: '写提交信息', text: '根据刚才的改动，给我一条符合 Conventional Commits 规范的 git commit message（中文描述）。' },
  { label: '排查报错', text: '帮我分析这个报错的根因，给出最可能的修法，优先考虑内网环境下的常见原因。' },
]
function runQuick(q: { label: string; text: string }) { if (!s.busy) submit(q.text, []) }
// 查看本次改动:git diff 当 ```diff 注入 AI 气泡(富结果自动渲红绿+可应用)
async function showDiff() {
  if (s.busy) return
  try {
    const d = await BH()?.currentDiff?.()
    addAiStatic('## 本次 session 的改动 (git diff)\n\n```diff\n' + String(d || '(无)').slice(0, 50000) + '\n```')
  } catch (e: any) { addNote('拉 diff 失败:' + ((e && e.message) || e)) }
}
// 我的记忆:内联编辑弹层(不能用 window.prompt —— Electron 渲染进程不实现它)
const memOpen = ref(false)
const memText = ref('')
const memSaving = ref(false)
async function openMemory() {
  try { memText.value = (await BH()?.memoryRead?.()) || '' } catch (e: any) { addNote('读取记忆失败：' + ((e && e.message) || e)); return }
  memOpen.value = true
}
async function saveMemory() {
  memSaving.value = true
  try { await BH()?.memoryWrite?.(memText.value); memOpen.value = false; addNote('✓ 记忆已更新，下一张新卡起生效。') }
  catch (e: any) { addNote('保存记忆失败：' + ((e && e.message) || e)) }
  memSaving.value = false
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
    <!-- 快捷指令条(常用追问模板 + 查看本次改动 + 我的记忆) -->
    <div class="quickbar">
      <button v-for="q in QUICK" :key="q.label" class="qchip" :class="{ go: q.highlight }" :title="q.text" @click="runQuick(q)">{{ q.label }}</button>
      <button class="qchip" title="取当前 session 的 git diff(前端+后端目录),用富结果格式显示" @click="showDiff">查看本次改动</button>
      <button class="qchip" title="查看 / 编辑个人记忆（每张新卡会自动注入）" @click="openMemory">我的记忆</button>
    </div>
    <!-- 技能 chip('/' 菜单挂载的作答技能,✕ 卸载) -->
    <div v-if="s.activeSkill" class="att-row">
      <div class="att skillchip">
        <span class="att-ic">✦</span>
        <span class="an">{{ s.activeSkill.name }}</span>
        <span class="ax" title="卸载技能" @click="unloadSkill">✕</span>
      </div>
    </div>
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
        placeholder="继续对话…（Enter 发送 · Shift+Enter 换行 · / 作答技能 · ↑ 翻输入历史）"
        @keydown="onKeydown"
      ></textarea>
      <button class="send" :class="{ stop: s.busy }" :aria-label="s.busy ? '中断本轮' : '发送'" :title="s.busy ? '中断本轮' : '发送'" @click="onSendBtn">
        <svg v-if="!s.busy" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      </button>
      <!-- 作答技能 slash 菜单(行首 / 唤起) -->
      <div v-if="slashOpen && slashList().length" class="slashmenu">
        <div v-for="sk in slashList()" :key="sk.id" class="slashitem" @mousedown.prevent="pickSkill(sk)">
          <span class="sl-name">{{ sk.name }}</span>
          <span v-if="sk.desc" class="sl-desc">{{ sk.desc }}</span>
        </div>
      </div>
    </div>
    <div class="drop-hint" :class="{ show: dropOn }">松手上传 — 文档解析成文本，图片走多模态识别</div>
    <!-- 我的记忆弹层(内联编辑;Electron 无 window.prompt) -->
    <div v-if="memOpen" class="mempop" @click.self="memOpen = false">
      <div class="membox">
        <div class="memttl">个人记忆（每张新卡自动注入，留空即清除）</div>
        <textarea v-model="memText" class="memta" placeholder="例如：我是信贷系统后端开发，回答优先给 Java 示例…"></textarea>
        <div class="memrow">
          <button class="rbtn-ghost" @click="memOpen = false">取消</button>
          <button class="rbtn-primary" :disabled="memSaving" @click="saveMemory">{{ memSaving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
