<script setup lang="ts">
// Feed 条目分发:用户气泡 / 提示行(可带重试钮) / 思考块 / 工具块 / todo 卡 / 权限条 / 提问卡 / AI 气泡
import type { FeedItem, UserItem } from './store'
import { cancelQueuedItem, retryLast } from './store'
import ReasonBlock from './ReasonBlock.vue'
import AnswerBubble from './AnswerBubble.vue'
import ToolBlock from './ToolBlock.vue'
import TodoCard from './TodoCard.vue'
import PermBar from './PermBar.vue'
import QuestionCard from './QuestionCard.vue'

defineProps<{ item: FeedItem }>()
const cancel = (item: FeedItem) => { if (item.kind === 'user') cancelQueuedItem(item as UserItem) }
</script>

<template>
  <!-- 用户气泡:右对齐灰底,最大宽 80%;排队中半透明 + 可取消 -->
  <div v-if="item.kind === 'user'" class="msg-u" :class="{ queued: item.queued }">
    <span class="u-text">{{ item.text }}</span>
    <button v-if="item.queued" class="qtag" title="取消这条排队消息" @click="cancel(item)">排队中 · 点此取消</button>
  </div>
  <!-- 分诊/提示行(不是一轮对话,只是过程播报);retry=带「重试本轮」 -->
  <div v-else-if="item.kind === 'note'" class="note" :class="{ muted: item.muted }">
    <span>{{ item.text }}</span>
    <button v-if="item.retry" class="retrybtn" @click="retryLast">重试本轮</button>
  </div>
  <ReasonBlock v-else-if="item.kind === 'reason'" :item="item" />
  <ToolBlock v-else-if="item.kind === 'tool'" :item="item" />
  <TodoCard v-else-if="item.kind === 'todo'" :item="item" />
  <PermBar v-else-if="item.kind === 'perm'" :item="item" />
  <QuestionCard v-else-if="item.kind === 'question'" :item="item" />
  <AnswerBubble v-else-if="item.kind === 'ai'" :item="item" />
</template>
