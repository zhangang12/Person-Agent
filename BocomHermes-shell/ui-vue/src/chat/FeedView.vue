<script setup lang="ts">
// 对话流容器:滚动守卫(贴底 ≤80px 才跟随流式;离底弹「最新」)+ 展示层回收占位
// + 富结果动作分发(wireActions:copy/extlink 内建;open/todo/apply 接桥;run 移交第二棒)。
import { ref, watch, nextTick, onMounted } from 'vue'
import { s, visibleGroups, addNote, turnToEl } from './store'
import type { FeedItem, ToolGrp } from './store'
import { wireActions } from './rich'
import { DANGER } from './lib/perm'
import { BH } from './bridge'
import MessageItem from './MessageItem.vue'
import ToolGroup from './ToolGroup.vue'

const feedEl = ref<HTMLElement | null>(null)
const jump = ref(false)
const asGrp = (g: FeedItem | ToolGrp): ToolGrp => g as ToolGrp

const nearBottom = () => {
  const el = feedEl.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
function scrollFeed(force: boolean) {
  const el = feedEl.value
  if (!el) return
  if (force || nearBottom()) { el.scrollTop = el.scrollHeight; jump.value = false }
  else jump.value = true   // 离底又来了新内容 → 提示有更新
}
function onScroll() { jump.value = !nearBottom() }
function toBottom() {
  const el = feedEl.value
  if (el) { el.scrollTop = el.scrollHeight; jump.value = false }
}

// 新条目(离散动作)= 强制到底;条目内容变化(流式增量)= 守卫跟随
let lastLen = 0
watch(visibleGroups, async (list) => {
  const force = list.length !== lastLen
  lastLen = list.length
  await nextTick()
  scrollFeed(force)
}, { deep: true })

onMounted(() => {
  // 富结果动作:事件委托在 feed 根;raw 从 DOM 还原(rich.ts 内建)
  if (feedEl.value) {
    wireActions(feedEl.value, {
      open: (file, line) => { try { BH()?.openLoc?.(file, line) } catch { /* 静默 */ } },
      todo: async ({ urgency, from, text, mailIdx, mailMsgId }, btn) => {
        const b = btn as HTMLButtonElement
        const orig = b.textContent; b.disabled = true; b.textContent = '保存中…'
        try {
          const r = await BH()?.todoAdd?.({ urgency, from, text, source: 'email', mailIdx: mailIdx || null, mailMsgId: mailMsgId || null })
          if (r) { b.textContent = '已加入 ✓'; b.classList.add('done'); BH()?.notifyTodosUpdated?.() }
          else { b.textContent = '已存在'; b.classList.add('done') }
        } catch { b.textContent = orig; b.disabled = false }
      },
      apply: async ({ raw }, btn) => {
        if (s.busy) return
        const b = btn as HTMLButtonElement
        const orig = b.innerHTML; b.textContent = '应用中…'; b.disabled = true
        try {
          const results = (await BH()?.applyDiff?.(raw)) || []
          const failed = results.filter((r: any) => !r.ok)
          if (failed.length === 0) {
            const names = results.map((r: any) => String(r.file).split(/[/\\]/).pop()).join('、')
            b.textContent = '已写入 ✓ ' + names; b.classList.add('done')
          } else {
            b.innerHTML = orig; b.disabled = false
            addNote('应用失败：' + failed.map((r: any) => r.file + '：' + r.error).join('\n'))
          }
        } catch (e: any) {
          b.innerHTML = orig; b.disabled = false
          addNote('应用出错：' + ((e && e.message) || e))
        }
      },
      // run(命令块重跑,P2b):破坏性命令客户端二次确认(最终仍走 bash 权限条,这里只防误触);
      // 输出渲染进块下 details.rout(target 轮,不占新气泡),重跑刷新输出
      run: async ({ raw }, btn) => {
        if (s.busy) return
        const b = btn as HTMLButtonElement
        if (DANGER.test(raw) && b.dataset.armed !== '1') {
          const o = b.textContent; b.dataset.armed = '1'; b.textContent = '危险·再点确认'; b.classList.add('danger')
          setTimeout(() => { if (b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = o; b.classList.remove('danger') } }, 4000)
          return
        }
        b.dataset.armed = ''; b.classList.remove('danger')
        const orig = b.innerHTML; b.textContent = '运行中…'; b.disabled = true
        const blk = b.closest('.rblk')
        if (!blk) { b.innerHTML = orig; b.disabled = false; return }
        const old = blk.querySelector(':scope > .rout'); if (old) old.remove()
        const out = document.createElement('details'); out.className = 'rout'; out.open = true
        out.innerHTML = '<summary>输出</summary><div class="ai routbody md"></div>'
        blk.appendChild(out)
        const body = out.querySelector('.routbody') as HTMLElement
        const ok = await turnToEl('请运行下面这条命令并把输出原样返回：\n\n```bash\n' + raw + '\n```', body)
        if (ok) { b.textContent = '已运行 ✓'; b.classList.add('done') }
        else { b.innerHTML = orig; b.disabled = false }
      },    })
  }
})
</script>

<template>
  <div class="feedwrap">
    <div ref="feedEl" class="feed" @scroll="onScroll">
      <div v-if="s.archived" class="note muted capnote">⋯ 已收纳 {{ s.archived }} 条早期消息(展示层回收,内容没丢 —— 重新打开本卡可从历史恢复)</div>
      <template v-for="g in visibleGroups" :key="g.id">
        <ToolGroup v-if="g.kind === 'toolgrp'" :tools="asGrp(g).tools" />
        <MessageItem v-else :item="g as FeedItem" />
      </template>
    </div>
    <button v-show="jump" class="jumpbtn" @click="toBottom">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>最新
    </button>
  </div>
</template>
