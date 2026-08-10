<script setup lang="ts">
// Feed 条目分发:用户气泡 / 壳层回流条 / 提示行(可带重试钮) / 思考块 / 工具块 / todo 卡 / 权限条 / 提问卡 / AI 气泡
import type { FeedItem, UserItem, ShotItem } from './store'
import { cancelQueuedItem, retryLast, shardJump, submit, retryBoot, openShot } from './store'
import ReasonBlock from './ReasonBlock.vue'
import AnswerBubble from './AnswerBubble.vue'
import ToolBlock from './ToolBlock.vue'
import TodoCard from './TodoCard.vue'
import PermBar from './PermBar.vue'
import QuestionCard from './QuestionCard.vue'

defineProps<{ item: FeedItem }>()
const cancel = (item: FeedItem) => { if (item.kind === 'user') cancelQueuedItem(item as UserItem) }
// 一键继续:发一条【新消息】。刻意不用 retryLast —— 那是把上一条用户消息原样重发,模型会从头再做一遍,
// 与"接着上次停下的地方继续"正好相反(旧页 ui/card.html:1138 本来就是发新消息)。
const cont = (msg: string) => submit(msg, [])
const asShot = (i: FeedItem) => i as ShotItem
// 比 4:3 还高就算长图 → 会被 max-height 裁掉一截,要明确告诉用户"这不是全部"。
// 常见的 16:10 页面截图(0.625)不算,免得每张图都挂一条噪音。
const isTall = (i: FeedItem) => { const s = i as ShotItem; return s.w > 0 && s.h / s.w > 0.75 }
</script>

<template>
  <!-- 壳层直发注入(card-inject 带 origin):分片回流 / 编排闸 / 系统提醒 —— 左对齐机器条,
       与用户气泡形态分明。它确实会触发新回合(所以还是 user 条目),但不该长得像"用户说的话"。
       带 shardId 的可点:直接跳该片镜像视图。 -->
  <div
    v-if="item.kind === 'user' && item.origin"
    class="msg-sys" :class="[item.origin, { queued: item.queued, clickable: !!item.shardId }]"
    :title="item.shardId ? '点我看这个分片的实时会话' : ''"
    @click="item.shardId && shardJump(item.shardId)"
  >
    <span class="sy-tag">{{ item.origin === 'orch' ? '分片回流' : '壳层' }}</span>
    <span class="sy-text">{{ item.text }}</span>
    <span v-if="item.shardId" class="sy-go">查看 →</span>
    <button v-if="item.queued" class="qtag" title="取消这条排队消息" @click.stop="cancel(item)">排队中 · 点此取消</button>
  </div>
  <!-- 用户气泡:右对齐灰底,最大宽 80%;排队中半透明 + 可取消 -->
  <div v-else-if="item.kind === 'user'" class="msg-u" :class="{ queued: item.queued }">
    <span class="u-text">{{ item.text }}</span>
    <button v-if="item.queued" class="qtag" title="取消这条排队消息" @click="cancel(item)">排队中 · 点此取消</button>
  </div>
  <!-- 分诊/提示行(不是一轮对话,只是过程播报);retry=带「重试本轮」(重发上一条),contMsg=带「继续执行」(发新消息) -->
  <div v-else-if="item.kind === 'note'" class="note" :class="{ muted: item.muted }">
    <span>{{ item.text }}</span>
    <button v-if="item.retry" class="retrybtn" @click="retryLast">重试本轮</button>
    <button v-else-if="item.contMsg" class="retrybtn" @click="cont(item.contMsg)">继续执行</button>
    <button v-else-if="item.retryBoot" class="retrybtn" @click="retryBoot()">重试连接</button>
  </div>
  <!-- Agent 截的图:壳层直推的缩略图,点开原图。刻意不做灯箱/画廊 —— 这里要的只是"看一眼页面长什么样" -->
  <figure v-else-if="item.kind === 'shot'" class="shot">
    <!-- 长图【满宽 + 裁高】,不是等比缩到 420 高 —— 目检发现 1280×4200 的整页截图等比缩完只剩 128px 宽的细条,
         什么都看不清。要的是"页面顶部那一屏,看得清",剩下的点开原图。 -->
    <div
      v-if="asShot(item).src" class="shot-frame" :class="{ clipped: isTall(item) }"
      :title="'点击打开原图 · ' + asShot(item).path" @click="openShot(asShot(item).path)"
    >
      <img :src="asShot(item).src" class="shot-img" :alt="asShot(item).label || '页面截图'" />
      <span v-if="isTall(item)" class="shot-more">长图已裁 · 点击看全图</span>
    </div>
    <!-- 缩略图没生成出来时,也要说清"图是有的、在哪儿":只剩两个标签的话用户不知道发生了什么 -->
    <div v-else class="shot-nothumb">缩略图没生成出来(图已存盘)—— 点「打开原图」看</div>
    <figcaption class="shot-cap">
      <span class="shot-tag">Agent 截图</span>
      <span v-if="asShot(item).label" class="shot-label">{{ asShot(item).label }}</span>
      <span v-if="asShot(item).w" class="shot-dim">{{ asShot(item).w }}×{{ asShot(item).h }}{{ asShot(item).full ? ' 整页' : '' }}</span>
      <button class="shot-open" @click="openShot(asShot(item).path)">打开原图</button>
    </figcaption>
  </figure>
  <ReasonBlock v-else-if="item.kind === 'reason'" :item="item" />
  <ToolBlock v-else-if="item.kind === 'tool'" :item="item" />
  <TodoCard v-else-if="item.kind === 'todo'" :item="item" />
  <PermBar v-else-if="item.kind === 'perm'" :item="item" />
  <QuestionCard v-else-if="item.kind === 'question'" :item="item" />
  <AnswerBubble v-else-if="item.kind === 'ai'" :item="item" />
</template>
