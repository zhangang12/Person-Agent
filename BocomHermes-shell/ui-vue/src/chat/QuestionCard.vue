<script setup lang="ts">
// 交互提问卡(设计稿 S3 向导式):一次一问,radio(单选)/checkbox(多选) + 「确认」推进 + 「上一问」回改;
// 选中态 = kimiBlue10 底 + 0.5px blue 边;custom 给自定义文本;「跳过」= 拒绝(等价 TUI 的 Esc);
// 答完/拒完定格 doneText 留痕,历史问题可追溯不凭空消失。
import { ref, computed } from 'vue'
import { sendQuestion, rejectQuestion } from './store'
import { quizCanSend } from './lib/perm'
import type { QuestionItem } from './store'

const props = defineProps<{ item: QuestionItem }>()
const picks = ref<string[][]>(props.item.questions.map(() => []))
const curQi = ref(0)
const customText = ref('')

const cur = computed(() => props.item.questions[curQi.value] || {})
const isLast = computed(() => curQi.value >= props.item.questions.length - 1)
const canConfirm = computed(() => {
  const q: any = cur.value
  if (picks.value[curQi.value] && picks.value[curQi.value].length) return true
  return !!(q && q.custom && customText.value.trim())
})

function pick(label: string) {
  const q: any = cur.value
  if (props.item.sent) return
  if (q && q.multiple) {
    const arr = picks.value[curQi.value]
    const i = arr.indexOf(label)
    if (i >= 0) arr.splice(i, 1); else arr.push(label)
  } else {
    picks.value[curQi.value] = [label]
  }
}
function confirm() {
  if (!canConfirm.value || props.item.sent) return
  const q: any = cur.value
  if (!picks.value[curQi.value].length && q && q.custom && customText.value.trim()) picks.value[curQi.value] = [customText.value.trim()]
  customText.value = ''
  if (!isLast.value) { curQi.value++; return }
  props.item.answers = picks.value
  if (quizCanSend(props.item.answers, props.item.questions)) sendQuestion(props.item)
}
function back() { if (curQi.value > 0) curQi.value-- }
</script>

<template>
  <div class="qcard quiz">
    <template v-if="!item.sent">
      <div class="qc-head">
        模型在等你回答
        <span class="qc-n">{{ cur.multiple ? '多选' : '单选' }} · 第 {{ curQi + 1 }}/{{ item.questions.length }} 问</span>
      </div>
      <div class="qc-q"><span v-if="cur.header" class="qc-tag">{{ cur.header }}</span>{{ cur.question }}</div>
      <button
        v-for="op in (cur.options || [])" :key="op.label"
        class="qc-opt" :class="{ on: picks[curQi].includes(op.label || '') }"
        @click="pick(op.label || '')"
      >
        <span class="qc-mark" :class="cur.multiple ? 'chk' : 'rad'"></span>
        <span class="qc-lb">{{ op.label }}<span v-if="op.description" class="qc-desc">{{ op.description }}</span></span>
      </button>
      <input
        v-if="cur.custom"
        v-model="customText"
        class="qc-custom"
        placeholder="或输入自定义回答,Enter 确认"
        @keydown.enter="confirm"
      >
      <div class="qc-acts">
        <button v-if="curQi > 0" class="qc-btn ghost" @click="back">上一问</button>
        <span class="sp"></span>
        <button class="qc-btn link" @click="rejectQuestion(item)">跳过(拒绝回答)</button>
        <button class="qc-btn pri" :disabled="!canConfirm" @click="confirm">{{ isLast ? '提交' : '确认' }}</button>
      </div>
    </template>
    <div v-else class="qc-done">{{ item.doneText }}</div>
  </div>
</template>
