<script setup lang="ts">
// 主控卡分片进度面板(orch):分片进度 N/M(含排队片)聚合条 + 每片一枚 chip(状态图标+目标);
// 点一片 → 分片视图(就地渲染该片的镜像会话),「← 主控」返回主区域;
// ⧉ 弹窗兜底:把分片真实隐藏窗亮出来(镜像视图重载后是空缓冲,纯黑盒场景的可见通道,preload 已暴露 shardPop)。
//
// 视图升级(2026-07):原来一条事件一行纯文本 —— 工具只印个名字、看不到状态/入参/结果,
// 分片主 Agent 与它自己 task 出去的子 Agent 输出还平铺在同一列(谁说的话分不出来)。现在:
//   · 工具行带状态点 + 耗时位 + 可展开入参/结果(与主对话流的工具块同口径,截断规则复用 lib/tool);
//   · 子 Agent 事件缩进并挂「↳ 名字」前缀,与该片主 Agent 的输出泾渭分明;
//   · reasoning 收进折叠块,不再和正文混排。
import { computed, reactive } from 'vue'
import { s, openShardView, shardMirror, shardVersion, addNote } from './store'
import { BH } from './bridge'
import { renderMarkdown } from './rich'
import { toolState, toolStateText, fmtInput, fmtOutput, truncIn, truncOut, toolLabel } from './lib/tool'
import type { ToolState } from './lib/tool'

const doneN = computed(() => s.shards.filter((x) => x.status === 'done' || x.status === 'interrupted').length)
const queuedN = computed(() => s.shards.filter((x) => x.status === 'queued').length)
const icon = (st: string) => st === 'done' ? '✅' : st === 'interrupted' ? '⚠' : st === 'running' ? '⏳' : '🕐'
const cur = computed(() => s.shards.find((x) => x.id === s.shardView) || null)

// 展开态按 partID 记(切片/重算不丢);Set 不是响应式的,用 reactive 记录
const openKeys = reactive(new Set<string>())
const toggle = (k: string) => { openKeys.has(k) ? openKeys.delete(k) : openKeys.add(k) }

interface Row {
  key: string
  type: 'tool' | 'text' | 'reason'
  sub: boolean
  who: string
  name: string
  title: string
  state: ToolState
  inStr: string
  outStr: string
  html: string
}
const rows = computed<Row[]>(() => {
  void shardVersion.value   // 缓冲是普通 Map(不触发响应式):靠版本号依赖让新事件合帧后重算,否则打开视图后定格
  if (!s.shardView) return []
  const m = shardMirror(s.shardView)
  if (!m) return []
  const out: Row[] = []
  let i = 0
  for (const [k, it] of m) {
    const key = k || 'i' + (i++)
    const sub = !!it.sub
    const who = sub ? (String(it.agentName || '') || '子 Agent') : ''
    if (it.kind === 'tool') {
      const inFull = fmtInput(it.input)
      const outFull = fmtOutput(it as { output?: unknown; error?: unknown })
      const ti = truncIn(inFull), to = truncOut(outFull)
      out.push({
        key, type: 'tool', sub, who,
        name: toolLabel(it.text), title: String(it.title || '').slice(0, 120),
        state: it.error ? 'err' : toolState(it.status),
        inStr: ti.text + (ti.tip ? '\n' + ti.tip : ''),
        outStr: to.text + (to.tip ? '\n' + to.tip : ''),
        html: '',
      })
      continue
    }
    const body = String(it.text || '')
    if (!body.trim()) continue
    out.push({
      key, type: it.kind === 'reasoning' ? 'reason' : 'text', sub, who,
      name: '', title: '', state: 'done', inStr: '', outStr: '',
      html: it.kind === 'reasoning' ? '' : renderMarkdown(body),
    })
    if (it.kind === 'reasoning') out[out.length - 1].inStr = body   // 思考原文走 pre,不过 markdown
  }
  return out
})

// ⧉ 弹窗查看该分片的真实窗口(X 收回后台不杀;对齐旧页 card.html:771)
async function popShard(id: string): Promise<void> {
  try {
    const r: any = await (BH() as any)?.shardPop?.(id)
    if (r && r.ok === false) addNote('分片弹窗失败:' + (r.err || '未知原因'))
  } catch (e: any) { addNote('分片弹窗失败:' + ((e && e.message) || e)) }
}
</script>

<template>
  <div v-if="s.runId && s.shards.length" class="shardpanel">
    <div class="sp-hd" @click="openShardView('')">
      <span class="sp-title">分片进度 {{ doneN }}/{{ s.shards.length }}</span>
      <span v-if="queuedN" class="sp-queued">{{ queuedN }} 片排队中</span>
      <span v-if="s.shardView" class="sp-back">← 主控</span>
    </div>
    <div v-if="!s.shardView" class="sp-chips">
      <span v-for="sh in s.shards" :key="sh.id || sh.goal" class="sp-chipwrap">
        <button
          class="sp-chip" :class="sh.status"
          :title="sh.goal + (sh.round ? ' · 第 ' + sh.round + ' 轮' : '') + (sh.id ? '' : '(排队中,还没拿到并发位)')"
          @click="sh.id && openShardView(sh.id)"
        >{{ icon(sh.status) }} {{ sh.goal }}</button>
        <button
          v-if="sh.id" class="sp-pop" title="弹出该分片的窗口(直接看它的实时会话;X 收回后台不杀)"
          @click.stop="popShard(sh.id)"
        >⧉</button>
      </span>
    </div>
    <div v-else class="sp-view">
      <!-- 分片视图头:这是哪一片、什么状态、跑到第几轮 —— 不写清楚,一堆镜像事件不知道属于谁 -->
      <div v-if="cur" class="sp-vhd">
        <span class="vh-ic">{{ icon(cur.status) }}</span>
        <span class="vh-goal">{{ cur.goal }}</span>
        <span class="vh-meta">#{{ cur.id }}{{ cur.round ? ' · 第 ' + cur.round + ' 轮' : '' }}</span>
        <button class="sp-pop" title="弹出该分片的窗口" @click.stop="popShard(cur.id)">⧉</button>
      </div>
      <div v-if="!rows.length" class="sp-empty">这片还没有回流事件(分片刚起步 / 镜像未至)</div>
      <template v-for="r in rows" :key="r.key">
        <!-- 工具行:状态 + 名称 + 标题,点开看入参/结果。
             行与展开体必须包在同一个 v-if 分支里 —— 拆成两个 v-if 会把下面的 v-else-if/v-else 挂到第二个
             v-if 上,收起状态的工具行会顺带再渲染一条空正文行(实测多出一堆「↳ 名字」空行)。 -->
        <div v-if="r.type === 'tool'" class="sp-toolwrap">
          <div class="sp-tool" :class="{ sub: r.sub, open: openKeys.has(r.key) }" @click="toggle(r.key)">
            <span v-if="r.sub" class="sp-who">↳ {{ r.who }}</span>
            <span class="nm">{{ r.name }}</span>
            <span class="ti">{{ r.title }}</span>
            <span class="st" :class="r.state">{{ toolStateText(r.state) }}</span>
          </div>
          <div v-if="openKeys.has(r.key)" class="sp-toolbody">
            <template v-if="r.inStr"><div class="sp-lb">入参</div><pre>{{ r.inStr }}</pre></template>
            <template v-if="r.outStr"><div class="sp-lb">{{ r.state === 'err' ? '错误' : '结果' }}</div><pre :class="{ err: r.state === 'err' }">{{ r.outStr }}</pre></template>
            <div v-if="!r.inStr && !r.outStr" class="sp-empty">(没有入参/结果)</div>
          </div>
        </div>
        <!-- 思考:默认折叠,不和正文混排 -->
        <details v-else-if="r.type === 'reason'" class="sp-reason" :class="{ sub: r.sub }">
          <summary>{{ r.sub ? '↳ ' + r.who + ' 的思考' : '思考过程' }}</summary>
          <pre>{{ r.inStr }}</pre>
        </details>
        <!-- 正文 -->
        <div v-else class="sp-text md" :class="{ sub: r.sub }">
          <span v-if="r.sub" class="sp-who">↳ {{ r.who }}</span>
          <span v-html="r.html"></span>
        </div>
      </template>
    </div>
  </div>
</template>
