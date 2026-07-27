<!--
  SideBar · 主窗口侧栏(228px)
  契约:desktop.html W1 —— bg-secondary 底 + 0.5px sep 右边;分组小标 c2 label-4 + 大写字距;
  选中行 = fills.f2;状态点沿用会话染色(blue/green/orange/purple,按 sid hash)。
  会话行全状态:默认/悬停/选中/未读(蓝点+加粗)/运行中(转圈)/编排徽标/拖出半透明。
  分组:会话(·项目名) → 历史 → 导航(对话/任务编排/邮件中心/内嵌浏览器) → 资源(技能中心/知识库) → 设置(钉底)。
  「对话」项为 legacy 保留(设计稿无此项,但无会话时从别的视图回对话区需要它,零功能丢失)。
  任务编排角标 = 运行中工作流数(真数据,wf-running-count 轮询,与状态栏同源)。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { KBadge, KMenu, KSkeleton, KSpinner } from '../components'
import type { KMenuItem } from '../components'
import { store, dotColor, showView, spawnChat, closeChat, pinChat, sessMouseDown, sessClick, refreshHist } from './store'
import type { ChatEntry } from './store'

const projTag = computed(() => (store.projName !== '未选目录' ? ' · ' + store.projName : ''))

// 历史区单条删除:两步确认(✕ → 删?),只摘索引,serve 侧会话与转录不动
const armDel = ref('')
let armTimer: ReturnType<typeof setTimeout> | 0 = 0
function delHist(sid: string) {
  if (armDel.value !== sid) {
    armDel.value = sid
    clearTimeout(armTimer as number)
    armTimer = setTimeout(() => { armDel.value = '' }, 3000)
    return
  }
  clearTimeout(armTimer as number); armDel.value = ''
  try { (window as any).BocomHermes?.historyDelete?.(sid) } catch { /* 静默 */ }
  refreshHist()
}

function dotVar(c: ChatEntry) { return 'var(--' + dotColor(c.sid || c.key) + ')' }

function menuItems(c: ChatEntry): KMenuItem[] {
  return [
    { key: 'pin', label: '钉出为迷你卡', icon: 'M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z' },
    { key: 'close', label: '关闭会话', icon: 'M18 6 6 18M6 6l12 12' },
  ]
}
function onMenu(c: ChatEntry, key: string) {
  if (key === 'pin') pinChat(c.key)
  else if (key === 'close') closeChat(c.key)
}
</script>

<template>
  <aside id="side">
    <div id="logo">
      <!-- 品牌标:桌面版悬浮球同款「动态眼睛」(迷你 orb + 眨眼动画,orb 退役后的品牌延续) -->
      <span class="miniorb" aria-hidden="true"><span class="meye"></span><span class="meye"></span></span>
      <b>BocomHermes</b>
    </div>
    <button id="newChat" @click="spawnChat({ title: '新会话' })">
      <svg class="ic" style="width: 13px; height: 13px; stroke-width: 2.4" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
      新建对话
    </button>

    <div class="lab">会话<span v-if="projTag" class="pt">{{ projTag }}</span></div>
    <div id="sideLists">
      <!-- 收养中:骨架屏(加载态契约:shimmer 预告结构,不用 spinner) -->
      <div v-if="store.sessLoading" class="sklbox">
        <KSkeleton :lines="3" :height="12" />
      </div>
      <div
        v-for="c in store.chats" :key="c.key"
        class="sess"
        :class="{ on: c.key === store.activeKey, dragging: store.draggingKey === c.key }"
        @mousedown="sessMouseDown(c.key, $event)"
        @click="sessClick(c.key)"
      >
        <span class="dot" :style="{ background: dotVar(c) }"></span>
        <KSpinner v-if="c.busy" :size="8" class="spin" />
        <span class="t" :class="{ unread: c.unread }" :title="c.title || '新会话'">{{ c.title || '新会话' }}</span>
        <span v-if="c.unread" class="udot" title="已完成,未查看"></span>
        <span v-if="c.wf" class="wfbd">编排</span>
        <button class="pin" title="钉出为独立迷你卡(盯梢此会话)" @click.stop="pinChat(c.key)">
          <svg class="ic" style="width: 11px; height: 11px" viewBox="0 0 24 24"><path d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z"/></svg>
        </button>
        <KMenu :items="menuItems(c)" placement="bottom-end" @select="(k: string) => onMenu(c, k)">
          <button class="more" title="更多操作" @click.stop>
            <svg class="ic" style="width: 12px; height: 12px; fill: currentColor; stroke: none" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
          </button>
        </KMenu>
        <button class="x" title="关闭会话" @click.stop="closeChat(c.key)">×</button>
      </div>

      <!-- 历史区:最近 8 条已关会话(点击带 sid 续接回放;✕ 两步确认删索引) -->
      <template v-if="store.histItems.length">
        <div class="lab">历史</div>
        <div v-for="h in store.histItems" :key="h.id" class="sess hist"
          :title="(h.title || '会话') + (h.project ? '\n' + h.project : '')"
          @click="spawnChat({ sid: h.id, title: h.title || '续接会话' })">
          <span class="t">{{ h.title || '会话' }}</span>
          <button class="x hx" :class="{ arm: armDel === h.id }"
            :title="armDel === h.id ? '再点一次确认删除' : '删除这条历史索引'"
            @click.stop="delHist(h.id)">{{ armDel === h.id ? '删?' : '×' }}</button>
        </div>
      </template>
    </div>

    <div class="lab">导航</div>
    <button class="nav-item" :class="{ on: store.view === 'chat' }" @click="showView('chat')">
      <svg class="ic s16" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>
      对话
    </button>
    <button class="nav-item" :class="{ on: store.view === 'orch' }" @click="showView('orch')">
      <svg class="ic s16" viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>
      任务编排
      <KBadge v-if="store.wf.running" type="orange" class="nb">{{ store.wf.running }}</KBadge>
    </button>
    <button class="nav-item" :class="{ on: store.view === 'wf' }" @click="showView('wf')">
      <svg class="ic s16" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8 7.5 2.5 8M16 7.5l-2.5 8M8.5 6h7"/></svg>
      动态工作流
    </button>
    <button class="nav-item" :class="{ on: store.view === 'mail' }" @click="showView('mail')">
      <svg class="ic s16" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 8 9 5.5L21 8"/></svg>
      邮件中心
    </button>
    <button class="nav-item" @click="showView('browser')">
      <svg class="ic s16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 4 5.7 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.7-4-9s1.5-6.4 4-9z"/></svg>
      内嵌浏览器
    </button>

    <div class="lab">资源</div>
    <button class="nav-item" :class="{ on: store.view === 'skills' }" @click="showView('skills')">
      <svg class="ic s16" viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>
      技能中心
    </button>
    <button class="nav-item" :class="{ on: store.view === 'kb' }" @click="showView('kb')">
      <svg class="ic s16" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>
      知识库
    </button>

    <span class="grow"></span>
    <button class="nav-item" :class="{ on: store.view === 'settings' }" @click="showView('settings')">
      <svg class="ic s16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>
      设置
    </button>
  </aside>
</template>

<style scoped>
#side {
  display: flex; flex-direction: column; gap: 2px; padding: 10px 8px; overflow: hidden;
  background: var(--bg-secondary); border-right: 0.5px solid var(--sep);
}
#logo { display: flex; align-items: center; gap: 8px; padding: 4px 8px 12px; font: var(--b1-em); color: var(--blue); }
#logo b { color: var(--label-1); font-weight: 600; }
/* 品牌标:桌面版悬浮球同款「动态眼睛」—— 迷你 orb(深色玻璃+呼吸光晕) + 双眼(4s 眨眼,双眼错峰) */
.miniorb {
  flex: none; width: 30px; height: 26px; border-radius: 10px; position: relative;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  background: #0d1020;
  box-shadow: -6px 1px 12px rgba(0,230,255,.4), 6px -1px 12px rgba(60,80,255,.35), inset -3px 0 8px rgba(0,200,255,.08), inset 3px 0 8px rgba(60,60,255,.06);
  animation: orb-breathe 3.5s ease-in-out infinite;
}
.miniorb .meye {
  width: 4px; height: 8px; border-radius: 2px; background: #fff;
  box-shadow: 0 0 5px rgba(255,255,255,.9);
  transition: all .35s cubic-bezier(.34,1.56,.64,1);
  animation: meye-blink 4s ease-in-out infinite;
}
.miniorb .meye:nth-child(2) { animation-delay: .07s; }
@keyframes orb-breathe {
  0%, 100% { box-shadow: -6px 1px 12px rgba(0,230,255,.4), 6px -1px 12px rgba(60,80,255,.35), inset -3px 0 8px rgba(0,200,255,.08), inset 3px 0 8px rgba(60,60,255,.06); }
  50% { box-shadow: -8px 1px 16px rgba(0,230,255,.6), 8px -1px 16px rgba(60,80,255,.5), inset -4px 0 10px rgba(0,200,255,.14), inset 4px 0 10px rgba(60,60,255,.1); }
}
@keyframes meye-blink { 0%, 88%, 100% { transform: scaleY(1); } 94% { transform: scaleY(.08); } }
#newChat {
  margin: 0 4px 10px; width: calc(100% - 8px); height: 30px; border-radius: var(--r-sm); cursor: pointer;
  background: var(--brand); color: var(--brand-text); font: var(--c1-em);
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: transform var(--btn-press-dur) var(--ez-out);
}
#newChat:hover { filter: brightness(1.08); }
#newChat:active { transform: scale(var(--btn-press-scale)); }
.lab { font: var(--c2); color: var(--label-4); letter-spacing: 0.08em; padding: 10px 8px 4px; }
.lab .pt { text-transform: uppercase; }   /* 设计稿分组小标项目名大写(仅影响拉丁字符) */
#sideLists { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.sklbox { padding: 6px 8px; }

.sess {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: var(--r-sm);
  font: var(--b2); color: var(--label-1); cursor: pointer; user-select: none;
}
.sess:hover { background: var(--fill-1); }
.sess.on { background: var(--fill-2); }
.sess.dragging { opacity: 0.45; }
.sess .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.sess .spin { color: var(--label-3); }
.sess .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .t.unread { font-weight: 600; }
.sess .udot { width: 6px; height: 6px; border-radius: 50%; background: var(--blue); flex: none; }
.sess .wfbd {
  flex: none; font-size: 9.5px; color: var(--blue); border: 0.5px solid var(--blue);
  border-radius: 4px; padding: 0 4px; line-height: 14px;
}
/* 行尾操作(pin/more/x):hover 现身 */
.sess .pin, .sess .x {
  flex: none; width: 16px; height: 16px; border-radius: 4px; background: transparent; color: var(--label-3);
  cursor: pointer; display: none; align-items: center; justify-content: center; font-size: 12px; line-height: 1; padding: 0;
}
.sess .more {
  flex: none; width: 16px; height: 16px; border-radius: 4px; background: transparent; color: var(--label-3);
  cursor: pointer; display: none; align-items: center; justify-content: center; padding: 0;
}
.sess:hover .pin, .sess:hover .x { display: inline-flex; }
.sess .x.hx { display: none; }
.sess.hist:hover .x.hx { display: inline-flex; }
.sess .x.hx.arm { display: inline-flex; width: auto; padding: 0 5px; color: var(--danger); font-size: 10px; font-weight: 600; }
.sess:hover :deep(.k-menu-wrap) .more { display: inline-flex; }
.sess .pin:hover, .sess .x:hover, .sess .more:hover { background: var(--fill-3); color: var(--label-1); }
.sess :deep(.k-menu-wrap) { flex: none; display: none; }
.sess:hover :deep(.k-menu-wrap) { display: inline-flex; }

.nav-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: none; border-radius: var(--r-sm);
  background: transparent; font: var(--b2); color: var(--label-2); cursor: pointer; text-align: left; width: 100%;
}
.nav-item:hover { background: var(--fill-1); }
.nav-item.on { background: var(--fill-2); color: var(--label-1); }
.nav-item svg { flex: none; }
.nav-item .nb { margin-left: auto; }
.grow { flex: 1; }
</style>

<style>
/* 拖出幻影(append 到 body, scoped 够不着,全局一份) */
.dragGhost {
  position: fixed; z-index: 99; pointer-events: none; padding: 5px 10px; border-radius: 7px;
  background: var(--bg-secondary); border: 0.5px solid var(--sep); font-size: 12px; color: var(--label-1);
  box-shadow: var(--shadow-small); white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis;
}
</style>
