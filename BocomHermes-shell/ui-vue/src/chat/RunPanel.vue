<script setup lang="ts">
// 编排面板(新引擎的主界面)—— 替代"一张会跟你聊天的主控卡"。
//
// 旧主控卡是一条对话流:进度靠壳层往里注入中文、批准靠渲染端嗅 todowrite、"齐没齐"靠模型自己数。
// 这里全部换成【看得见的事实】:阶段条 + 节点表(状态/波次/补做次数/卡在等谁/哪一项没过)+ 决策留痕。
// 面板只读:批准 / 插话 / 中止 / 重试都是 IPC 显式转移,唯一真相源在主进程,本地一个字段都不回写。
import { computed, ref } from 'vue'
import { s, runApprove, runReject, runNote, runAbort, runResume, runRetryNode, shardJump } from './store'
import type { RunNodeView } from './store'

const note = ref('')
const showDecisions = ref(false)

const run = computed(() => s.run)
const c = computed(() => (s.run && s.run.counts) || { total: 0, verified: 0, running: 0, queued: 0, pending: 0, failed: 0, skipped: 0 })
const PHASE_TEXT: Record<string, string> = {
  planning: '规划中', 'awaiting-approval': '等你批准', executing: '执行中',
  'awaiting-user': '等你拿主意', suspended: '已中断(可续跑)', done: '已完成', failed: '失败', cancelled: '已取消',
}
const phaseText = computed(() => PHASE_TEXT[String(run.value?.phase)] || String(run.value?.phase || ''))
const ICON: Record<string, string> = {
  verified: '✅', running: '⏳', queued: '🕐', pending: '○', settled: '◐',
  failed: '⚠', skipped: '⊘', cancelled: '⊘', rejected: '↻',
}
const KIND_TEXT: Record<string, string> = { work: '', probe: '勘察', verify: '验证', check: '检查', reduce: '收口' }

// 进度条:已验 / 总数。失败与跳过也算"不再动了",单独用颜色区分
const pct = computed(() => (c.value.total ? Math.round((c.value.verified / c.value.total) * 100) : 0))
const busyDecision = computed(() => !!run.value?.pendingDecision)

function nodeTip(n: RunNodeView): string {
  const bits: string[] = []
  if (n.deps.length) bits.push('依赖 ' + n.deps.join('、'))
  if (n.attempt) bits.push('第 ' + (n.attempt + 1) + ' 次重做')
  if (n.patches) bits.push('补做 ' + n.patches + ' 次')
  if (n.reason) bits.push('原因:' + n.reason)
  if (n.droppedReason) bits.push(n.droppedReason)
  if (n.files.length) bits.push('产出:' + n.files.slice(0, 3).join('、'))
  return bits.join(' · ')
}
function submitNote() {
  const t = note.value.trim()
  if (!t) return
  note.value = ''
  runNote(t)
}
</script>

<template>
  <div v-if="run" class="runpanel">
    <!-- 阶段条:一眼看出"现在卡在哪一步、该谁动" -->
    <div class="rp-hd">
      <span class="rp-phase" :class="run.phase">{{ phaseText }}</span>
      <span class="rp-goal" :title="run.goal">{{ run.goal }}</span>
      <span class="sp"></span>
      <span v-if="busyDecision" class="rp-thinking" :title="'正在做 ' + run.pendingDecision!.point + ' 决策'">◌ 正在想下一步</span>
      <span class="rp-wave" :title="'第几波节点 —— 小批 replan 真的发生了没有,看这个数'">第 {{ run.wave }} 波</span>
    </div>

    <!-- 进度 -->
    <div class="rp-bar" :title="'已验 ' + c.verified + ' / 共 ' + c.total">
      <div class="rp-fill" :style="{ width: pct + '%' }"></div>
    </div>
    <div class="rp-counts">
      <span>{{ c.verified }}/{{ c.total }} 已验</span>
      <span v-if="c.running" class="run">{{ c.running }} 在跑</span>
      <span v-if="c.queued" class="queued">{{ c.queued }} 排队</span>
      <span v-if="c.pending" class="pending">{{ c.pending }} 待办</span>
      <span v-if="c.failed" class="failed">{{ c.failed }} 失败</span>
      <span v-if="c.skipped" class="skipped">{{ c.skipped }} 跳过</span>
    </div>

    <!-- 要用户动手的两种情形:批准方案 / 回答问题。都是明确的 phase,不是猜的 -->
    <div v-if="run.phase === 'awaiting-approval'" class="rp-ask">
      <span class="rp-asktext">方案已出({{ c.total }} 个节点)—— 看一眼,没问题就开跑</span>
      <button class="rp-go" @click="runApprove()">开始执行</button>
      <button class="rp-alt" @click="runReject('请重新拆一版')">重新拆</button>
    </div>
    <div v-else-if="run.phase === 'awaiting-user'" class="rp-ask warn">
      <span class="rp-asktext">{{ run.ask?.question || '编排停下来等你拿主意 —— 在下面说一句就能继续' }}</span>
      <button v-for="o in (run.ask?.options || [])" :key="o" class="rp-alt" @click="runNote(o)">{{ o }}</button>
    </div>
    <div v-else-if="run.phase === 'suspended'" class="rp-ask">
      <span class="rp-asktext">上次没跑完(重启中断)—— 已按磁盘产出复核过进度,可以接着跑</span>
      <button class="rp-go" @click="runResume()">续跑</button>
    </div>

    <!-- 节点表:这就是"编排的账本",不再存在模型脑子里 -->
    <div class="rp-nodes">
      <div v-for="n in run.nodes" :key="n.id" class="rp-node" :class="n.state" :title="nodeTip(n)">
        <span class="rn-ic">{{ ICON[n.state] || '·' }}</span>
        <span class="rn-title">{{ n.title }}</span>
        <span v-if="KIND_TEXT[n.kind]" class="rn-kind">{{ KIND_TEXT[n.kind] }}</span>
        <span v-if="n.patches" class="rn-tag patch" :title="'退出检查差一截,已在原卡补做 ' + n.patches + ' 次(没有重开卡)'">补{{ n.patches }}</span>
        <span v-if="n.attempt" class="rn-tag redo" :title="'补不动,整片重做过 ' + n.attempt + ' 次'">重{{ n.attempt }}</span>
        <span v-if="n.exitReport.length" class="rn-tag bad" :title="n.exitReport.map((x) => x.kind + ':' + x.detail).join('\n')">{{ n.exitReport.map((x) => x.kind).join('/') }}</span>
        <!-- 撤掉/失败必须【当场说明白为什么】,不能只塞 tooltip:
             一排灰掉的 ⊘ 看上去跟"坏了没跑"一模一样,而它其实是"你自己让重拆时撤的"(实测用户第一反应是"分片没出来")。 -->
        <span v-if="n.state === 'skipped' && n.droppedReason" class="rn-why">— {{ n.droppedReason }}</span>
        <span v-else-if="n.state === 'failed' && n.reason" class="rn-why bad">— {{ n.reason }}</span>
        <span class="sp"></span>
        <button v-if="n.cardId" class="rn-go" title="看这个节点的实时会话" @click="shardJump(String(n.cardId))">查看 →</button>
        <button v-if="n.state === 'failed'" class="rn-retry" title="再给它一次机会(加一次重做预算)" @click="runRetryNode(n.id)">重试</button>
      </div>
      <div v-if="!run.nodes.length" class="rp-empty">
        {{ run.phase === 'planning' ? '正在拆解目标…' : '还没有节点' }}
      </div>
    </div>

    <!-- 决策留痕:它每一步为什么这么决定,可查 -->
    <div v-if="run.decisions.length" class="rp-dec">
      <button class="rp-dechd" @click="showDecisions = !showDecisions">
        {{ showDecisions ? '▾' : '▸' }} 决策留痕({{ run.decisions.length }} 次)
      </button>
      <div v-if="showDecisions" class="rp-declist">
        <div v-for="(d, i) in run.decisions.slice().reverse()" :key="i" class="rp-decrow" :class="{ bad: !!d.invalid }">
          <span class="dc-pt">{{ d.point }}</span>
          <span class="dc-why">{{ d.invalid ? '(不合法:' + d.invalid + ')' : d.why }}</span>
        </div>
      </div>
    </div>

    <!-- 成果 -->
    <div v-if="run.result && run.result.summary" class="rp-result">
      <div class="rr-sum">{{ run.result.summary }}</div>
      <div v-if="run.result.deliverables?.length" class="rr-files">
        <span v-for="f in run.result.deliverables" :key="f" class="rr-file">{{ f }}</span>
      </div>
      <div v-if="run.result.gaps?.length" class="rr-gaps">
        遗留缺口:{{ run.result.gaps.map((g: any) => (g && g.text) || g).join(' · ') }}
      </div>
    </div>

    <!-- 插话:用户随时可以改主意。有在飞决策时会排到下一次决策带上,不丢 -->
    <div v-if="!['done', 'cancelled', 'failed'].includes(run.phase)" class="rp-say">
      <input
        v-model="note" class="rp-input"
        :placeholder="busyDecision ? '正在想下一步 —— 你现在说的会带进下一次决策' : '插一句(改计划 / 加一片 / 让它收口)'"
        @keydown.enter="submitNote"
      />
      <button class="rp-send" :disabled="!note.trim()" @click="submitNote">发送</button>
      <button class="rp-stop" title="中止整个编排(在跑的节点一并停掉)" @click="runAbort()">中止</button>
    </div>
  </div>
</template>
