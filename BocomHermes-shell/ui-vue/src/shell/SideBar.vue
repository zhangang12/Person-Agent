<!--
  SideBar · VSCode 式两段侧栏(方案 A,2026-07-29)
  左:图标轨道 48px —— 七个功能视图纯图标(当前视图高亮 accent 条 + hover 底 + tooltip)
  右:会话面板 flex 1 —— 品牌标 + 新建按钮 + 项目会话列表 + 历史分组
  被侧栏拖拽调整宽度时,图标轨道宽度不变,仅会话面板随面板总宽缩放。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { KMenu, KSkeleton, KSpinner } from '../components'
import type { KMenuItem } from '../components'
import { store, dotColor, showView, spawnChat, closeChat, pinChat, sessMouseDown, sessClick, refreshHist, toggleSplit } from './store'
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
    { key: 'pin',  label: '钉出为迷你卡', icon: 'M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z' },
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
    <!-- ══ 左 · 图标轨道 48px ══ -->
    <nav id="sbIcons">
      <div class="icon" :class="{ on: store.view === 'chat' }" title="对话（Ctrl+Shift+Space）" @click="showView('chat')">
        <svg class="ic" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>
      </div>
      <div class="icon" :class="{ on: store.view === 'orch' }" title="任务编排" @click="showView('orch')">
        <svg class="ic" viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>
        <span v-if="store.wf.running" class="nbdot">{{ store.wf.running }}</span>
      </div>
      <div class="icon" :class="{ on: store.view === 'wf' }" title="动态工作流" @click="showView('wf')">
        <svg class="ic" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8 7.5 2.5 8M16 7.5l-2.5 8M8.5 6h7"/></svg>
      </div>
      <div class="icon" :class="{ on: store.view === 'mail' }" title="邮件中心" @click="showView('mail')">
        <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 8 9 5.5L21 8"/></svg>
      </div>
      <div class="icon" :class="{ on: store.splitW > 0 }" :title="store.splitW > 0 ? '关闭浏览器面板' : '在对话旁边打开浏览器'" @click="store.splitW > 0 ? toggleSplit(false) : showView('browser')">
        <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 4 5.7 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.7-4-9s1.5-6.4 4-9z"/></svg>
      </div>
      <div class="icon" :class="{ on: store.view === 'skills' }" title="技能中心" @click="showView('skills')">
        <svg class="ic" viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>
      </div>
      <div class="icon" :class="{ on: store.view === 'kb' }" title="知识库" @click="showView('kb')">
        <svg class="ic" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>
      </div>

      <span class="igrow"></span>
      <div class="icon" :class="{ on: store.view === 'settings' }" title="设置" @click="showView('settings')">
        <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>
      </div>
    </nav>

    <!-- ══ 右 · 会话面板 flex 1 ══ -->
    <div id="sbPanel">
      <div id="logo"><b>BocomHermes</b></div>
      <button id="newChat" @click="spawnChat({ title: '新会话' })">
        <svg class="ic" style="width: 13px; height: 13px; stroke-width: 2.4" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        新建对话
      </button>

      <div class="lab">会话<span v-if="projTag" class="pt">{{ projTag }}</span></div>
      <div id="sideLists">
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
          <button class="pin" title="钉出为独立迷你卡" @click.stop="pinChat(c.key)">
            <svg class="ic" style="width: 11px; height: 11px" viewBox="0 0 24 24"><path d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z"/></svg>
          </button>
          <KMenu :items="menuItems(c)" placement="bottom-end" @select="(k: string) => onMenu(c, k)">
            <button class="more" title="更多操作" @click.stop>
              <svg class="ic" style="width: 12px; height: 12px; fill: currentColor; stroke: none" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
            </button>
          </KMenu>
          <button class="x" title="关闭会话" @click.stop="closeChat(c.key)">×</button>
        </div>

        <!-- 历史区 -->
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
    </div>
  </aside>
</template>

<style scoped>
/* ══ 整栏:flex row · 左轨+右板 ══ */
#side {
  display: flex; flex-direction: row; overflow: hidden;
  background: var(--bg-secondary); border-right: 0.5px solid var(--sep);
}

/* ══ 图标轨道 48px ══ */
#sbIcons {
  flex: none; width: 48px; display: flex; flex-direction: column; align-items: center;
  gap: 2px; padding: 6px 0; overflow: hidden;
}
#sbIcons .icon {
  position: relative; width: 38px; height: 38px; display: flex; align-items: center; justify-content: center;
  border-radius: var(--r-sm); cursor: pointer; color: var(--label-3); transition: color .15s;
}
#sbIcons .icon:hover { background: var(--fill-1); color: var(--label-1); }
#sbIcons .icon.on { color: var(--blue); }
/* 当前视图 accent 条(左缘 3px) */
#sbIcons .icon.on::before {
  content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px;
  border-radius: 0 2px 2px 0; background: var(--blue);
}
#sbIcons .ic { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
/* 编排运行中角标(superscript) */
#sbIcons .nbdot {
  position: absolute; top: 2px; right: 2px; min-width: 14px; height: 14px; line-height: 14px;
  border-radius: 7px; background: var(--orange); color: #fff; font-size: 9px; font-weight: 600;
  text-align: center; padding: 0 3px;
}
#sbIcons .igrow { flex: 1; }

/* ══ 会话面板 flex 1 ══ */
#sbPanel {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
  padding: 10px 8px 10px 4px; overflow: hidden;
}
#logo { display: flex; align-items: center; gap: 8px; padding: 4px 8px 12px; font: var(--b1-em); color: var(--blue); }
#logo b { color: var(--label-1); font-weight: 600; }

#newChat {
  margin: 0 4px 10px; width: calc(100% - 8px); height: 30px; border-radius: var(--r-sm); cursor: pointer;
  background: var(--brand); color: var(--brand-text); font: var(--c1-em);
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: transform var(--btn-press-dur) var(--ez-out);
}
#newChat:hover { filter: brightness(1.08); }
#newChat:active { transform: scale(var(--btn-press-scale)); }

.lab { font: var(--c2); color: var(--label-4); letter-spacing: 0.08em; padding: 10px 8px 4px; }
.lab .pt { text-transform: uppercase; }
#sideLists { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.sklbox { padding: 6px 8px; }

/* ── 会话行(从旧 SideBar 平移,样式不变) ── */
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
.sess .x.hx.arm { display: inline-flex; width: auto; padding: 0 5px; color: var(--danger); font-size: 11px; font-weight: 600; }
.sess:hover :deep(.k-menu-wrap) .more { display: inline-flex; }
.sess .pin:hover, .sess .x:hover, .sess .more:hover { background: var(--fill-3); color: var(--label-1); }
.sess :deep(.k-menu-wrap) { flex: none; display: none; }
.sess:hover :deep(.k-menu-wrap) { display: inline-flex; }
</style>

<style>
/* 拖出幻影(全局,scoped 够不着) */
.dragGhost {
  position: fixed; z-index: 99; pointer-events: none; padding: 5px 10px; border-radius: 7px;
  background: var(--bg-secondary); border: 0.5px solid var(--sep); font-size: 12px; color: var(--label-1);
  box-shadow: var(--shadow-small); white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis;
}
</style>
