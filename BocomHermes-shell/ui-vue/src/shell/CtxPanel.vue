<!--
  CtxPanel · 对话视图右栏上下文面板(desktop.html W1,264px,可整体收起)
  四段:会话(ctx 真值+模型)/ 任务进展(wf 注册表按 sid 对当前会话:状态/todo 进度/当前步/diff)/
  产出文件(wf 落盘清单 top6)/ 项目知识(条数)。数据全部有真实来源:chat-ctx 回写 + wf-list 5s 轮询
  + knowledge-list 60s 轮询;普通会话(非工作流)任务段给空态,不虚构。
-->
<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { store } from './store'

const BH = (): any => (window as any).BocomHermes
// 默认收起:普通对话下它只有"暂无+重复信息"(用户实测突兀);手动开合的偏好照旧记忆;
// 从没手动选过(stored=null)且当前会话出现工作流进展(wfItem)时,自动展开一次 —— 有内容才挣这块地。
const stored = localStorage.getItem('shell.ctxpanel')
const open = ref(stored === '1')
let manual = stored !== null
watch(open, (v) => {
  manual = true
  try { localStorage.setItem('shell.ctxpanel', v ? '1' : '0') } catch { /* 静默 */ }
})

const chat = computed(() => store.chats.find((c) => c.key === store.activeKey) || null)
const ctx = computed(() => (store.chatCtx && store.chatCtx.key === store.activeKey ? store.chatCtx : null))
const ctxPct = computed(() => (ctx.value && ctx.value.limit ? Math.min(100, Math.round((ctx.value.tokens / ctx.value.limit) * 100)) : 0))
const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n))

// 任务进展:wf-list 5s 轮询,按 sid 对当前会话
const wfItem = ref<any>(null)
const knCount = ref(-1)   // -1 = 还没拉到
let timer: ReturnType<typeof setInterval> | null = null
let knTimer: ReturnType<typeof setInterval> | null = null
async function poll() {
  if (!open.value || store.view !== 'chat') return
  try {
    const r = await BH()?.wfList?.()
    const items = (r && r.items) || []
    const c = chat.value
    wfItem.value = (c && c.sid && items.find((x: any) => x.sid === c.sid)) || null
  } catch { /* 静默 */ }
}
async function pollKn() {
  if (!open.value || !store.projDir) { knCount.value = -1; return }
  try {
    const r = await BH()?.knowledgeList?.(store.projDir)
    knCount.value = (r && r.ok && r.stats && typeof r.stats.total === 'number') ? r.stats.total : 0
  } catch { /* 静默 */ }
}
onMounted(() => {
  poll(); pollKn()
  timer = setInterval(poll, 5000)
  knTimer = setInterval(pollKn, 60000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer); if (knTimer) clearInterval(knTimer) })
watch([() => store.activeKey, open], () => { poll(); pollKn() })
watch(wfItem, (w) => { if (w && !manual) open.value = true })   // 有真进展才自动展开(没手动选过开合时)

const stPill = (w: any) => w.status === 'running' ? (w.busy ? '进行中' : '待操作') : w.status === 'done' ? '已完成' : w.status === 'interrupted' ? '中断' : '存档'
const pct = (w: any) => (w.todoTotal > 0 ? Math.round((100 * (w.todoDone || 0)) / w.todoTotal) : -1)
</script>

<template>
  <button class="rp-fold" :title="open ? '收起上下文面板' : '展开上下文面板'" @click="open = !open">{{ open ? '›' : '‹' }}</button>
  <aside v-if="open" id="rpanel">
    <div class="rp-sec">
      <div class="rp-lb">会话</div>
      <div class="rp-title">{{ chat ? chat.title : '未选择会话' }}</div>
      <div v-if="ctx && ctx.limit && ctx.tokens > 0" class="rp-ctx">
        <div class="rp-bar"><i :style="{ width: ctxPct + '%' }"></i></div>
        <div class="rp-ctxt">上下文 {{ fmtK(ctx.tokens) }}/{{ fmtK(ctx.limit) }}<template v-if="ctx.model"> · {{ ctx.model }}</template></div>
      </div>
      <div v-else-if="ctx && ctx.model" class="rp-dim">{{ ctx.model }}</div>
      <div v-else class="rp-dim">暂无用量数据</div>
    </div>
    <div class="rp-sec">
      <div class="rp-lb">任务进展</div>
      <template v-if="wfItem">
        <div class="rp-row">
          <span class="rp-pill" :class="wfItem.status">{{ stPill(wfItem) }}</span>
          <span v-if="wfItem.diff" class="rp-diff">+{{ wfItem.diff.additions }}/-{{ wfItem.diff.deletions }}</span>
        </div>
        <div v-if="pct(wfItem) >= 0" class="rp-bar"><i :style="{ width: pct(wfItem) + '%' }"></i></div>
        <div v-if="wfItem.current" class="rp-cur">正在：{{ wfItem.current }}</div>
        <div class="rp-dim">{{ wfItem.todoDone || 0 }}/{{ wfItem.todoTotal || 0 }} 步 · {{ wfItem.rounds || 0 }} 轮<template v-if="wfItem.shards"> · {{ wfItem.shards }} 分片</template></div>
      </template>
      <div v-else class="rp-dim">{{ chat && chat.wf ? '进展数据拉取中…' : '普通对话 · 无任务进展' }}</div>
    </div>
    <div class="rp-sec" v-if="wfItem && (wfItem.fileList || []).length">
      <div class="rp-lb">产出文件</div>
      <div v-for="f in (wfItem.fileList || []).slice(0, 6)" :key="f" class="rp-file" :title="f">{{ String(f).split(/[\\/]/).slice(-2).join('/') }}</div>
      <div v-if="(wfItem.fileList || []).length > 6" class="rp-dim">… 共 {{ wfItem.fileList.length }} 个</div>
    </div>
    <div class="rp-sec">
      <div class="rp-lb">项目知识</div>
      <div class="rp-dim">{{ knCount < 0 ? '读取中…' : knCount + ' 条(治理在设置视图)' }}</div>
    </div>
  </aside>
</template>

<style scoped>
.rp-fold {
  position: absolute; right: 0; top: 42%; z-index: 6; width: 16px; height: 52px;
  border: 0.5px solid var(--sep); border-right: none; border-radius: 8px 0 0 8px;
  background: var(--bg-secondary); color: var(--label-3); cursor: pointer; font-size: 11px;
}
.rp-fold:hover { color: var(--label-1); }
#rpanel {
  width: 264px; flex: none; overflow-y: auto; padding: 12px 12px 16px;
  background: var(--bg-secondary); border-left: 0.5px solid var(--sep);
  display: flex; flex-direction: column; gap: 14px;
}
.rp-sec { display: flex; flex-direction: column; gap: 6px; }
.rp-lb { font: var(--c2); color: var(--label-3); }
.rp-title { font: var(--b2-em); color: var(--label-1); line-height: 1.4; }
.rp-bar { height: 4px; border-radius: 2px; background: var(--fill-2); overflow: hidden; }
.rp-bar i { display: block; height: 100%; background: var(--blue); border-radius: 2px; transition: width .3s; }
.rp-ctxt { font: var(--c1); font-family: var(--font-mono); color: var(--label-2); }
.rp-dim { font: var(--c1); color: var(--label-3); line-height: 1.5; }
.rp-row { display: flex; align-items: center; gap: 8px; }
.rp-pill { font: var(--c2); padding: 1px 8px; border-radius: var(--r-full); border: 0.5px solid var(--sep); color: var(--label-2); }
.rp-pill.running { color: var(--green); border-color: var(--green); }
.rp-pill.interrupted { color: var(--orange); border-color: var(--orange); }
.rp-diff { font: var(--c1); font-family: var(--font-mono); color: var(--green); }
.rp-cur { font: var(--c1); color: var(--orange); }
.rp-file { font: var(--c1); font-family: var(--font-mono); color: var(--blue); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
