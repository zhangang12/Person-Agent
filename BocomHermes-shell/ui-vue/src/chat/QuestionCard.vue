<script setup lang="ts">
// 交互提问卡:单选点够即提交;多选勾选后「✓ 选定」;custom 给文本输入(Enter 提交);
// 「跳过」= 拒绝(等价 TUI 的 Esc);答完/拒完定格 doneText 留痕。
import { ref } from 'vue'
import { sendQuestion, rejectQuestion } from './store'
import { quizCanSend } from './lib/perm'
import type { QuestionItem } from './store'

const props = defineProps<{ item: QuestionItem }>()
// 点选态按问题序存 labels;写回 item.answers 后由 quizCanSend 判齐
const picks = ref<string[][]>(props.item.questions.map(() => []))
const locked = ref<boolean[]>(props.item.questions.map(() => false))

function pick(qi: number, label: string, multiple: boolean) {
  if (props.item.sent || locked.value[qi]) return
  if (multiple) {
    const arr = picks.value[qi]
    const i = arr.indexOf(label)
    if (i >= 0) arr.splice(i, 1); else arr.push(label)
  } else {
    picks.value[qi] = [label]
    trySend()
  }
}
function confirmMulti(qi: number) {
  if (props.item.sent || !picks.value[qi].length) return
  locked.value[qi] = true
  trySend()
}
function customEnter(qi: number, e: KeyboardEvent) {
  const v = String((e.target as HTMLInputElement).value || '').trim()
  if (!v || props.item.sent) return
  picks.value[qi] = [v]
  ;(e.target as HTMLInputElement).disabled = true
  trySend()
}
function trySend() {
  props.item.answers = picks.value
  if (quizCanSend(props.item.answers, props.item.questions)) sendQuestion(props.item)
}
</script>

<template>
  <div class="qcard">
    <template v-if="!item.sent">
      <div class="qc-head">模型在等你回答</div>
      <div v-for="(q, qi) in item.questions" :key="qi" class="qc-sec">
        <div class="qc-q"><span v-if="q.header" class="qc-tag">{{ q.header }}</span>{{ q.question }}</div>
        <button
          v-for="op in (q.options || [])" :key="op.label"
          class="qc-opt" :class="{ on: picks[qi].includes(op.label || '') }"
          @click="pick(qi, op.label || '', !!q.multiple)"
        >
          {{ op.label }}
          <span v-if="op.description" class="qc-desc">{{ op.description }}</span>
        </button>
        <button v-if="q.multiple" class="qc-confirm" :disabled="!picks[qi].length" @click="confirmMulti(qi)">✓ 选定</button>
        <input v-if="q.custom" class="qc-custom" placeholder="或输入自定义回答,Enter 提交" @keydown.enter="customEnter(qi, $event)">
      </div>
      <button class="qc-skip" @click="rejectQuestion(item)">跳过(拒绝回答)</button>
    </template>
    <div v-else class="qc-done">{{ item.doneText }}</div>
  </div>
</template>
