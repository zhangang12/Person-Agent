<script setup lang="ts">
// 工具块:同 partID 原地更新(store upsertToolEvent);默认折叠,verbose 开自动展开;
// 完成带「⎿ N 字」摘要;run_workflow 升格高亮;入参/结果截断提示已在 inStr/outStr 里。
// task/delegate_task 带真子会话 id(taskChild)时,点头部跳子 Agent 窗格(不占折叠态)。
// read-spill 外溢(输出过长已外溢/读取量到预算线):给「查看全文」——内容落在临时文件,经 spillRead IPC 读回展示
// (模型上下文里只有头部+路径是刻意的上下文治理,但【用户】不该跟着看不到全文,实测病灶)。
import { watch, ref, computed } from 'vue'
import { s, subJump, shardJump } from './store'
import { BH } from './bridge'
import type { ToolItem } from './store'

const props = defineProps<{ item: ToolItem }>()
// verbose 打开时,所有工具块自动展开(关不强制收回,用户手折的保留)
watch(() => s.verbose, (v) => { if (v) props.item.open = true })
const stateText = { running: '运行中…', done: '完成', err: '出错' } as const
// 头部点击的三种去处:委派 → 子 Agent 窗格;分片派发 → 该片镜像视图;其余 → 折叠/展开
const jumpTip = computed(() =>
  props.item.taskChild || props.item.isTask ? '点我看这个子 Agent 的全程(侧边栏)'
    : props.item.shardId ? '点我看这个分片的实时会话(分片进度面板)' : '')
function onHead() {
  if (props.item.isTask) { subJump(props.item.taskChild || ('ph:' + props.item.partID)); return }
  if (props.item.taskChild) { subJump(props.item.taskChild); return }
  if (props.item.shardId && shardJump(props.item.shardId)) return
  props.item.open = !props.item.open
}

// ── read-spill 外溢检出:从结果文本里抠落盘路径(两种口径:单次超阈值/会话预算线) ──
const spill = computed(() => {
  const t = props.item.outStr || ''
  const m = t.match(/输出过长已外溢[：:]\s*共\s*(\d+)\s*行\s*\/\s*(\d+)\s*字符[，,]\s*完整内容已存\s*([^\s。）)]+)/)
    || t.match(/读取量已到预算线[^:：]*[：:]\s*完整内容已存\s*([^\s。）)]+)/)
  if (!m) return null
  return m[3] ? { lines: m[1], chars: m[2], file: m[3] } : { lines: '', chars: '', file: m[1] }
})
const spillText = ref('')
const spillErr = ref('')
const spillLoading = ref(false)
async function spillOpen() {
  if (!spill.value) return
  if (spillText.value) { spillText.value = ''; return }   // 再点收起
  spillLoading.value = true; spillErr.value = ''
  try {
    const r: any = await BH()?.spillRead?.(spill.value.file)
    if (r && r.text != null) spillText.value = String(r.text)
    else spillErr.value = (r && r.error) || '读取失败'
  } catch (e: any) { spillErr.value = String((e && e.message) || e) } finally { spillLoading.value = false }
}
// 折叠头「全文」钮:只读回不 toggle,读回后自动展开块(用户在外溢块上要的永远是看内容,不是收起)
async function spillOpenFull() {
  if (!spillText.value) await spillOpen()
  props.item.open = true
}
</script>

<template>
  <div class="toolblk" :class="[item.state, { wf: item.isWf, open: item.open }]">
    <div class="tb-hd" :class="{ jumpable: !!item.taskChild || !!item.shardId }" :title="jumpTip" @click="onHead">
      <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <span class="tb-name">{{ item.name }}</span>
      <span v-if="item.title" class="tb-title">{{ item.title }}</span>
      <span v-if="item.shardId" class="tb-shardgo" title="看这个分片的实时会话">#{{ item.shardId }} 查看 →</span>
      <span v-if="item.summary" class="tb-summary">{{ item.summary }}</span>
      <!-- read-spill 外溢:「全文」提到折叠头(默认折叠块里的按钮用户永远发现不了 —— 实测病灶);点了读回并自动展开 -->
      <button v-if="spill" class="tb-spillmini" :disabled="spillLoading" title="输出过长已外溢到临时文件,点我读回全文" @click.stop="spillOpenFull">全文</button>
      <span v-if="item.ms != null" class="tb-ms">{{ item.ms < 1000 ? item.ms + 'ms' : (item.ms / 1000).toFixed(1) + 's' }}</span>
      <span class="tb-state" :class="item.state">{{ stateText[item.state] }}</span>
    </div>
    <div v-if="item.open" class="tb-body">
      <template v-if="item.inStr"><div class="tb-lb">入参</div><pre>{{ item.inStr }}</pre></template>
      <template v-if="item.outStr"><div class="tb-lb">{{ item.hasErr ? '错误' : '结果' }}</div><pre :class="{ err: item.hasErr }">{{ item.outStr }}</pre></template>
      <!-- read-spill 外溢:结果里只有头部+路径,给「查看全文」读回落盘文件 -->
      <div v-if="spill" class="tb-spill">
        <button class="tb-spillbtn" :disabled="spillLoading" @click.stop="spillOpen">
          {{ spillLoading ? '读取中…' : (spillText ? '收起全文' : '查看全文' + (spill.lines ? '（共 ' + spill.lines + ' 行 / ' + spill.chars + ' 字符）' : '')) }}
        </button>
        <div v-if="spillErr" class="tb-spillerr">{{ spillErr }}</div>
        <pre v-if="spillText" class="tb-spillfull">{{ spillText }}</pre>
      </div>
    </div>
  </div>
</template>
