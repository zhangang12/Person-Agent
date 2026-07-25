<!--
  LabApp · 组件实验室(验收物 / 活样式 guide)
  布局照 docs/ui-design/interactions.html;矩阵用 ui-vue/src/components 真实组件渲染。
  hover/按压静态仿真走组件内置的 is-hover/is-active/sim-hov 演示类。
  每节附 spec 小注(变量/参数来源)。静态仿真帧(menu 静态列/tip/coach/dlg)在注里标明。
-->
<script setup lang="ts">
import { ref } from 'vue'
import {
  KButton, KIconBtn, KChip, KBadge, KDot, KSeg, KToggle,
  KToaster, KToastItem, KDialog, KTooltip, KMenu, KSpinner, KSkeleton,
  useToast,
} from '../components'
import type { KMenuItem } from '../components'

const toast = useToast()

/* ── 活 demo 状态 ── */
const segVal = ref('orch')
const tglA = ref(true)
const tglB = ref(false)
const dlgOpen = ref(false)
const dlgDangerOpen = ref(false)
const menuItems: KMenuItem[] = [
  { key: 'new', label: '新建对话卡', icon: '<path d="M12 5v14M5 12h14"/>' },
  { key: 'rename', label: '重命名', icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>' },
  { key: 'pin', label: '置顶卡片', icon: '<path d="M12 17V3M7 8l5-5 5 5M5 21h14"/>', checked: true },
  { key: 'export', label: '导出记录(暂无内容)', icon: '<path d="M12 3v12M6 11l6 6 6-6M4 21h16"/>', disabled: true },
]
const menuStaticOpen = ref(true)
function onMenuSelect(key: string) { toast.info(`菜单选中:${key}`) }
function fireLoading() {
  const id = toast.loading('正在回放技能 · 第 4/12 步')
  setTimeout(() => { toast.dismiss(id); toast.success('回放完成 · 12/12') }, 2400)
}
</script>

<template>
  <div class="board">
    <header class="b-head">
      <h1 class="b-title">组件实验室 · 交互与动效</h1>
      <p class="b-sub">Vue3 组件库全状态矩阵。事实源:<code>docs/ui-design/design.css</code>(令牌)与
        <code>docs/ui-design/interactions.html</code>(契约)。矩阵用真实组件渲染;瞬态以
        <code>is-hover/is-active/sim-hov</code> 演示类定格。本页同时是活样式 guide。</p>
    </header>

    <!-- ═══ 01 按钮矩阵 ═══ -->
    <section class="b-sec">
      <h2 class="b-sec-t"><span class="no">01</span>按钮 · 状态矩阵</h2>
      <p class="b-sec-d">44/32/26 三档高,primary/secondary/outline + danger;按压 scale(0.97) 120ms ez-out;禁用降不透明度不改配色。</p>
      <div class="mx">
        <div class="hd"><div>变体</div><div>默认</div><div>悬停</div><div>按压(定格)</div><div>加载</div><div>禁用</div></div>
        <div class="rw"><div class="rn">primary</div>
          <div class="cell"><KButton>开始执行</KButton></div>
          <div class="cell"><KButton class="is-hover">开始执行</KButton></div>
          <div class="cell"><KButton class="is-active">开始执行</KButton></div>
          <div class="cell"><KButton loading>执行中</KButton></div>
          <div class="cell"><KButton disabled>开始执行</KButton></div></div>
        <div class="rw"><div class="rn">secondary</div>
          <div class="cell"><KButton variant="secondary">取消自动</KButton></div>
          <div class="cell"><KButton variant="secondary" class="is-hover">取消自动</KButton></div>
          <div class="cell"><KButton variant="secondary" class="is-active">取消自动</KButton></div>
          <div class="cell"><KButton variant="secondary" loading>处理中</KButton></div>
          <div class="cell"><KButton variant="secondary" disabled>取消自动</KButton></div></div>
        <div class="rw"><div class="rn">outline</div>
          <div class="cell"><KButton variant="outline">查看计划</KButton></div>
          <div class="cell"><KButton variant="outline" class="is-hover">查看计划</KButton></div>
          <div class="cell"><KButton variant="outline" class="is-active">查看计划</KButton></div>
          <div class="cell"><KButton variant="outline" loading>打开中</KButton></div>
          <div class="cell"><KButton variant="outline" disabled>查看计划</KButton></div></div>
        <div class="rw"><div class="rn">danger</div>
          <div class="cell"><KButton danger>删除</KButton></div>
          <div class="cell"><KButton variant="outline" danger>拒绝</KButton></div>
          <div class="cell"><KButton danger class="is-active">删除</KButton></div>
          <div class="cell"><KButton variant="outline" danger loading>拒绝</KButton></div>
          <div class="cell"><KButton variant="outline" danger disabled>拒绝</KButton></div></div>
        <div class="rw"><div class="rn">档位</div>
          <div class="cell"><KButton size="lg">44 · 大号</KButton></div>
          <div class="cell"><KButton size="md">32 · 标准</KButton></div>
          <div class="cell"><KButton size="sm">26 · 小</KButton></div>
          <div class="cell"><KIconBtn label="演示图标钮"><svg class="ic" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 12l6-6"/></svg></KIconBtn></div>
          <div class="cell"><KChip clickable>操作片 ⌃⇧V</KChip></div></div>
      </div>
      <ul class="spec">
        <li>spec:高/圆角/字阶 <code>--r-md|--r-lg|--r-sm · --b2-em|--t2-em|--c1-em</code>(design.css .btn/.s44/.s26)</li>
        <li>spec:按压 <code>--btn-press-scale(0.97) · --btn-press-dur(120ms) · --ez-out</code>;loading spinner <code>KSpinner 12px currentColor</code></li>
        <li>spec:底色 <code>--brand|--fill-1|--sep;danger=--danger</code>;禁用 <code>--label-4</code></li>
      </ul>
    </section>

    <!-- ═══ 02 开关 / 分段 / 输入 ═══ -->
    <section class="b-sec">
      <h2 class="b-sec-t"><span class="no">02</span>开关 / 分段 / 输入 · 状态矩阵</h2>
      <p class="b-sec-d">开关严格按 toggle.md:轨道 32×18(sm),滑块恒正圆,on 轨道 = labels.primary;悬停滑块缩 2px 并向 active 边微移。</p>
      <div class="shot wrap">
        <div class="state-col"><div class="row"><KToggle :model-value="false" /><span>关 · 默认</span></div><div class="lbl">轨道 fills.f3 · 滑块 14px</div></div>
        <div class="state-col"><div class="row"><KToggle :model-value="false" class="sim-hov" /><span>关 · 悬停</span></div><div class="lbl">滑块缩至 12px(sim-hov 定格)</div></div>
        <div class="state-col"><div class="row"><KToggle :model-value="true" /><span>开 · 默认</span></div><div class="lbl">轨道 labels.primary</div></div>
        <div class="state-col"><div class="row"><KToggle :model-value="true" class="sim-hov" /><span>开 · 悬停</span></div><div class="lbl">滑块 12px,停右缘</div></div>
        <div class="state-col"><div class="row"><KToggle :model-value="false" disabled /><span class="dis-t">禁用</span></div><div class="lbl">整体 opacity 0.4</div></div>
        <div class="state-col"><div class="row"><KToggle :model-value="true" disabled /><span class="dis-t">开 · 禁用</span></div><div class="lbl">轨道退为 fills.f2</div></div>
        <div class="state-col"><div class="row"><KToggle v-model="tglA" label="可交互" /><span>可交互</span></div><div class="lbl">点击切换,200ms ez-out</div></div>
        <div class="state-col"><div class="row"><KToggle v-model="tglB" size="lg" label="lg 演示" /><span>lg · 44×24</span></div><div class="lbl">等比放大 · 待设计确认</div></div>
      </div>
      <div class="shot wrap" style="align-items:flex-start">
        <div class="state-col">
          <KSeg v-model="segVal" :options="[
            { value: 'auto', label: '自动' },
            { value: 'orch', label: '任务编排' },
            { value: 'wf', label: '动态工作流' },
          ]" />
          <div class="lbl">分段:轨 fills.f2 / 选中浮起(白底 + 0 1px 3px 8% 影)· 150ms 换背景</div>
        </div>
        <div class="state-col" style="min-width:280px">
          <div class="inputbox focus"><textarea rows="1">聚焦态:0.5px 边换 kimiBlue</textarea></div>
          <div class="lbl">focus 用色不用影:阴影保持 inputDefault(输入容器未组件化,静态仿真,P1 候选)</div>
        </div>
        <div class="state-col" style="min-width:240px">
          <div class="inputbox" style="opacity:0.5"><textarea rows="1" placeholder="引擎失连时输入禁用" /></div>
          <div class="lbl">禁用:整体 50% 不透明度,placeholder 仍在</div>
        </div>
      </div>
      <ul class="spec">
        <li>spec:开关 <code>--fill-3 / --label-1 / --fill-2(开+禁用)</code>,滑块 <code>#fff 恒正圆</code>,动效 <code>--toggle-dur(200ms) --ez-out</code></li>
        <li>spec:分段 <code>--fill-2 轨 · --r-lg · 项 32px/min 52px · --hover-dur(150ms)</code></li>
        <li>spec:输入 <code>--bg-primary · 0.5px --sep · --shadow-input · focus 边 --blue</code></li>
      </ul>
    </section>

    <!-- ═══ 03 菜单 / Tooltip / CoachMark / Dialog ═══ -->
    <section class="b-sec">
      <h2 class="b-sec-t"><span class="no">03</span>菜单 / 工具提示 / 对话框</h2>
      <p class="b-sec-d">菜单即时、Tooltip 被动、Dialog 必须二选一;同一时刻全屏只有一个 mask。</p>
      <div class="shot wrap" style="align-items:flex-start;gap:40px">
        <div class="state-col">
          <KMenu v-model:open="menuStaticOpen" :items="menuItems" @select="onMenuSelect">
            <KButton variant="outline" size="sm">菜单(已展开)</KButton>
          </KMenu>
          <div class="lbl">菜单:36px 行高 / radius.md 项 / hover fills.f1 / 选中尾置 18px 勾 / 禁用 40%</div>
        </div>
        <div class="state-col">
          <KMenu :items="menuItems" placement="bottom-start" @select="onMenuSelect">
            <KButton variant="secondary" size="sm">活菜单 · 点击展开</KButton>
          </KMenu>
          <div class="lbl">活 demo:弹出 150ms scale(.95→1),点外/Esc/选中关闭</div>
        </div>
        <div class="state-col" style="gap:20px">
          <div class="state-col" style="align-items:center;gap:14px">
            <div class="tip-static">上下文用量 · 已用 42%,真实 token 计量</div>
            <KTooltip content="上下文用量 · 已用 42%,真实 token 计量">
              <KIconBtn label="用量详情"><svg class="ic" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 12l6-6"/></svg></KIconBtn>
            </KTooltip>
          </div>
          <div class="lbl">Tooltip:上为静态帧,下为活组件(悬停 300ms 首开,已开一条后续即时);toastPc 底/无阴影/箭头 10×4/max 240px</div>
        </div>
        <div class="state-col">
          <div class="coach">
            <div class="coach-t"><svg class="ic" style="width:24px;height:24px" viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>技能可以接编排</div>
            <div style="font:var(--b2)">回放完成后,顺手点「下载后→编排」,结果直接进工作流。</div>
            <div class="coach-ft">
              <span style="font:var(--c1-em);color:rgba(255,255,255,0.56)">1/2</span>
              <button class="coach-btn">我知道了</button>
            </div>
          </div>
          <div class="lbl">CoachMark:radius.xl / padding 16 / 步骤指示 + 单动作(静态仿真,未组件化 · 待设计确认)</div>
        </div>
      </div>
      <div class="shot">
        <div class="dlg-wrap">
          <div class="dlg-bg">
            <KSkeleton :height="14" width="60%" />
            <KSkeleton :height="14" width="80%" />
            <KSkeleton :height="14" width="45%" />
          </div>
          <div class="dlg-mask"></div>
          <div class="dlg-static">
            <div class="t">删除这张卡片?</div>
            <div class="d">「信贷管理系统 · loan-web」的会话历史将一并清除,知识库条目不受影响。此操作不可撤销。</div>
            <div class="ft">
              <KButton variant="secondary">取消</KButton>
              <KButton danger>删除</KButton>
            </div>
          </div>
        </div>
        <div class="lbl" style="margin-top:10px">Dialog(静态带 mask 帧):恒宽 360px / radius.xl / 无关闭钮 / 破坏性初始焦点落取消 / 点 mask = 安全动作</div>
        <div class="row" style="margin-top:12px">
          <KButton variant="secondary" @click="dlgOpen = true">活 Dialog · 常规</KButton>
          <KButton variant="outline" danger @click="dlgDangerOpen = true">活 Dialog · 破坏性</KButton>
        </div>
      </div>
      <ul class="spec">
        <li>spec:菜单 <code>min 140px · max 240px · --bg-tertiary · 0.5px --sep · --shadow-small · padding 8px</code>,弹出 <code>--menu-dur(150ms)</code></li>
        <li>spec:Tooltip <code>--toast-bg · --r-md · --tooltip-dur(125ms) scale(.97→1) · --tooltip-delay(300ms) · --z-tooltip</code></li>
        <li>spec:Dialog <code>360px · --r-xl · --bg-secondary · --mask · --z-dialog · --dialog-dur(180ms) scale(.96→1)</code></li>
      </ul>
    </section>

    <!-- ═══ 04 Toast 矩阵 ═══ -->
    <section class="b-sec">
      <h2 class="b-sec-t"><span class="no">04</span>Toast · 五型 + 动作</h2>
      <p class="b-sec-d">底恒定 toastPc #2b2b2b,语义全靠 20px 图标色;顶中进场 350ms / 退场 260ms;最多叠 3 条;3s 自隐(错误 5s)。</p>
      <div class="shot wrap" style="gap:16px">
        <KToastItem type="success" message="工作流已完成 · 5/5" />
        <KToastItem type="error" message="引擎连接中断,正在重连" />
        <KToastItem type="warning" message="知识条目「费率表」锚点失效,已隔离" />
        <KToastItem type="info" message="压缩完成:释放 61% 上下文" />
        <KToastItem type="loading" message="正在回放技能 · 第 4/12 步" />
        <KToastItem type="warning" message="《利率调整通知》已发" action-label="撤回" @action="toast.info('已撤回')" />
      </div>
      <div class="row" style="margin-top:12px">
        <KButton size="sm" @click="toast.success('工作流已完成 · 5/5')">success</KButton>
        <KButton size="sm" variant="secondary" @click="toast.error('引擎连接中断,正在重连')">error(5s)</KButton>
        <KButton size="sm" variant="secondary" @click="toast.warning('知识条目锚点失效,已隔离')">warning</KButton>
        <KButton size="sm" variant="secondary" @click="toast.info('压缩完成:释放 61% 上下文')">info</KButton>
        <KButton size="sm" variant="secondary" @click="fireLoading">loading→success</KButton>
        <KButton size="sm" variant="outline" @click="toast.success('《利率调整通知》已发', { action: { label: '撤回', onClick: () => toast.info('已撤回') } })">带动作</KButton>
      </div>
      <ul class="spec">
        <li>spec:静态行用 <code>KToastItem</code>(无计时器);活栈 <code>KToaster + useToast</code>,顶中 fixed,<code>--z-toast</code></li>
        <li>spec:进 <code>--toast-in-dur(350ms) translateY(-8px)→0</code>,出 <code>--toast-out-dur(260ms) 仅 fade</code>;上限 <code>TOAST_MAX=3</code></li>
      </ul>
    </section>

    <!-- ═══ 05 动效规格表 ═══ -->
    <section class="b-sec">
      <h2 class="b-sec-t"><span class="no">05</span>动效规格表</h2>
      <p class="b-sec-d">只动 transform 与 opacity;禁 ease-in、禁弹跳;prefers-reduced-motion 下全部退化为瞬时(base.css 全局降级)。</p>
      <div class="mo">
        <div class="h">场景</div><div class="h">时长</div><div class="h">缓动</div><div class="h">变换与说明</div>
        <div class="n">卡片入场</div><div>180ms</div><div><code>ez-out</code></div><div>opacity 0→1 + scale(0.96→1),从屏幕边缘出现时叠加 12px 位移</div>
        <div class="n">权限条弹出</div><div>200ms</div><div><code>ez-out</code></div><div>scale(0.97→1) + opacity</div>
        <div class="n">按钮按压</div><div>120ms</div><div><code>ez-out</code></div><div>scale(0.97);松开 160ms 回弹(KButton 已实现)</div>
        <div class="n">菜单弹出</div><div>150ms</div><div><code>ez-out</code></div><div>scale(0.95→1) + opacity,原点挂触发角(KMenu 已实现)</div>
        <div class="n">Tooltip</div><div>125ms</div><div><code>ez-out</code></div><div>scale(0.97→1);首次 300ms 延迟,后续即时(KTooltip 已实现)</div>
        <div class="n">Dialog / Modal</div><div>180ms</div><div><code>ez-out</code></div><div>内容 scale(0.96→1),mask 同步 fade(KDialog 已实现)</div>
        <div class="n">子 Agent 侧栏</div><div>300ms</div><div><code>ez-drawer</code></div><div>translateX 24px→0 + opacity(P1 待做)</div>
        <div class="n">Toast 进 / 出</div><div>350 / 260ms</div><div><code>ez-out</code></div><div>顶中 translateY(-8px)→0;退场仅 fade(KToaster 已实现)</div>
        <div class="n">开关滑动</div><div>150–200ms</div><div><code>ease-out</code></div><div>滑块 translateX;悬停缩放 100–150ms(KToggle 已实现)</div>
        <div class="n">流式光标</div><div>1.06s</div><div><code>steps(1)</code></div><div>8×16 块 opacity 闪烁(P1 待做)</div>
        <div class="n">完成闪框</div><div>600ms ×1</div><div><code>ez-out</code></div><div>卡框 0→2px green 光晕后消散(P1 待做)</div>
      </div>
    </section>

    <!-- ═══ 06 徽标 / 圆点 / 骨架屏 ═══ -->
    <section class="b-sec">
      <h2 class="b-sec-t"><span class="no">06</span>徽标 / 圆点 / 骨架屏</h2>
      <p class="b-sec-d">加载态用骨架不用 spinner;骨架形状预告内容结构,shimmer 1.4s。</p>
      <div class="shot wrap">
        <div class="state-col">
          <div class="row">
            <KBadge type="green">正常</KBadge><KBadge type="red">失连</KBadge><KBadge type="orange">预警</KBadge>
            <KBadge type="blue">运行中</KBadge><KBadge type="gray">已归档</KBadge>
          </div>
          <div class="lbl">KBadge:高 16px / 圆角 full / c2 / 五色 10% 底 + 实色字</div>
        </div>
        <div class="state-col">
          <div class="row">
            <KDot color="blue" /><KDot color="green" /><KDot color="orange" /><KDot color="purple" /><KDot />
          </div>
          <div class="lbl">KDot:6px 正圆;会话染色 blue/green/orange/purple,默认随文字色</div>
        </div>
        <div class="state-col" style="width:280px">
          <KSkeleton :height="12" width="55%" />
          <KSkeleton :height="12" :lines="3" />
          <KSkeleton :height="34" />
          <div class="lbl">KSkeleton:fill-1/fill-2 扫光,--skl-dur(1.4s) linear</div>
        </div>
        <div class="state-col">
          <div class="row"><KSpinner :size="12" /><KSpinner :size="16" /><KSpinner :size="20" /></div>
          <div class="lbl">KSpinner:12/16/20,仅按钮 loading 与 Toast loading 用</div>
        </div>
      </div>
    </section>

    <!-- ═══ 07 空态 / 错误态 / 加载态 ═══ -->
    <section class="b-sec">
      <h2 class="b-sec-t"><span class="no">07</span>空态 · 错误态 · 加载态</h2>
      <p class="b-sec-d">三种「非正常」时刻:不甩英文堆栈,不装死,现场就能恢复。</p>
      <div class="shot wrap" style="gap:24px;align-items:flex-start">
        <div class="state-col" style="width:280px">
          <div class="k-card">
            <div class="k-hd"><KDot color="blue" />新对话卡</div>
            <div class="k-empty">
              <svg class="ic" style="width:26px;height:26px;color:var(--label-3)" viewBox="0 0 24 24"><path d="M12 3l1.9 5.6 5.6 1.4-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z"/></svg>
              <div style="font:var(--b2-em)">从一句具体的话开始</div>
              <div style="font:var(--c1);color:var(--label-3);line-height:1.7">「看下 monthly() 的计息口径」<br>比「帮我看看代码」有效十倍</div>
              <div class="row" style="justify-content:center;margin-top:4px"><KChip>粘贴截图提问 ⌃⇧S</KChip><KChip>带入剪贴板 ⌃⇧V</KChip></div>
            </div>
          </div>
          <div class="lbl">空态:给一个可照抄的例句,而不是一句「暂无数据」</div>
        </div>
        <div class="state-col" style="width:280px">
          <div class="k-card">
            <div class="k-hd"><KDot color="inherit" style="color:var(--label-4)" />信贷管理 · loan-web<span style="flex:1"></span><KBadge type="red">失连</KBadge></div>
            <div class="k-err">
              <div class="note-r">
                <svg class="ic s16" viewBox="0 0 24 24" style="color:var(--danger)"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
                <span style="flex:1">引擎心跳丢失,已暂停流式输出</span>
                <KButton size="sm" variant="outline" danger>重连</KButton>
              </div>
              <div style="font:var(--c1);color:var(--label-3)">已生成的内容原样保留,重连后从断点续传,不重发整段。</div>
            </div>
          </div>
          <div class="lbl">错误态:说清发生了什么 + 一个恢复动作,内容不丢</div>
        </div>
        <div class="state-col" style="width:280px">
          <div class="k-card">
            <div class="k-hd"><KDot color="blue" />载入历史会话</div>
            <div class="k-err">
              <KSkeleton :height="12" width="55%" />
              <KSkeleton :height="12" />
              <KSkeleton :height="12" width="80%" />
              <KSkeleton :height="34" />
              <div style="font:var(--c1);color:var(--label-3)">shimmer 1.4s,骨架形状预告内容结构</div>
            </div>
          </div>
          <div class="lbl">加载态:骨架屏不用 spinner;形状即预告,减少布局跳动</div>
        </div>
      </div>
    </section>

    <footer class="b-foot">BocomHermes ui-vue · P0 组件实验室 —— 令牌事实源 docs/ui-design/design.css,契约事实源 docs/ui-design/interactions.html</footer>

    <!-- 活组件挂载点 -->
    <KToaster />
    <KDialog v-model:open="dlgOpen" title="归档这条会话?" desc="归档后可在历史里找回,不会删除知识库条目。" confirm-text="归档"
      @confirm="toast.success('已归档')" />
    <KDialog v-model:open="dlgDangerOpen" title="删除这张卡片?" desc="会话历史将一并清除,此操作不可撤销。" confirm-text="删除" destructive
      @confirm="toast.error('已删除(演示)')" />
  </div>
</template>

<style scoped>
/* ── 展板骨架(照抄 design.css 展示板类,值全走令牌) ── */
.board { max-width: 1280px; margin: 0 auto; padding: var(--s7) var(--s6) 96px; }
.b-head { margin-bottom: var(--s7); }
.b-title { font: var(--t-largeTitle); }
.b-sub { font: var(--b2); color: var(--label-2); margin-top: var(--s2); max-width: 760px; line-height: 1.7; }
.b-sub code, .spec code { font-size: 11px; background: var(--fill-1); padding: 1px 5px; border-radius: var(--r-xxs); color: var(--label-2); }
.b-sec { margin-top: 56px; }
.b-sec-t { font: var(--t2-em); display: flex; align-items: baseline; gap: var(--s3); }
.b-sec-t .no { font: var(--c1-em); color: var(--blue); letter-spacing: 0.05em; }
.b-sec-d { font: var(--c1); color: var(--label-3); margin-top: var(--s1); line-height: 1.7; max-width: 760px; }
.b-foot { margin-top: 72px; font: var(--c1); color: var(--label-4); }
.spec { font: var(--c1); color: var(--label-3); line-height: 1.8; margin-top: var(--s3); }
.spec li { margin-left: 16px; margin-top: 2px; }
.shot { border: 0.5px solid var(--sep); border-radius: var(--r-xl); background: var(--bg-primary); padding: var(--s5); overflow: hidden; margin-top: var(--s5); }
.shot.wrap { display: flex; gap: 32px; flex-wrap: wrap; }
.row { display: flex; gap: var(--s3); align-items: center; flex-wrap: wrap; }
.state-col { display: flex; flex-direction: column; align-items: flex-start; gap: var(--s3); }
.lbl { font: var(--c2); color: var(--label-4); margin-top: 4px; max-width: 320px; line-height: 1.6; }
.dis-t { color: var(--label-4); }

/* ── 按钮矩阵网格(照抄 interactions.html .mx) ── */
.mx { display: grid; gap: 0; margin-top: var(--s4); border: 0.5px solid var(--sep); border-radius: var(--r-lg); overflow: hidden; }
.mx .hd, .mx .rw { display: grid; grid-template-columns: 120px repeat(5, 1fr); align-items: center; }
.mx .hd { background: var(--fill-1); font: var(--c1-em); color: var(--label-2); }
.mx .hd > div, .mx .rw > div { padding: 12px 14px; border-bottom: 0.5px solid var(--sep); }
.mx .rw:last-child > div { border-bottom: none; }
.mx .rw .rn { font: var(--b2-em); }
.mx .cell { display: flex; align-items: center; gap: 8px; min-height: 56px; }

/* ── 输入容器静态仿真(design.css .inputbox,未组件化) ── */
.inputbox { background: var(--bg-primary); border: 0.5px solid var(--sep); border-radius: 20px; box-shadow: var(--shadow-input); }
.inputbox.focus { border-color: var(--blue); }
.inputbox textarea { width: 100%; background: none; border: none; outline: none; font: var(--t2); color: var(--label-1); padding: var(--s3) var(--s4) 0; resize: none; }
.inputbox textarea::placeholder { color: var(--label-4); }

/* ── Tooltip / CoachMark 静态帧(契约照抄,活组件在旁) ── */
.tip-static { position: relative; background: var(--toast-bg); color: #fff; border-radius: var(--r-md); padding: 8px 12px; font: var(--b2); max-width: 240px; }
.tip-static::after { content: ""; position: absolute; left: 50%; bottom: -4px; margin-left: -5px; border: 5px solid transparent; border-top-color: var(--toast-bg); border-bottom: none; }
.coach { width: 240px; background: var(--toast-bg); color: #fff; border-radius: var(--r-xl); padding: 16px; display: flex; flex-direction: column; gap: 12px; position: relative; }
.coach::before { content: ""; position: absolute; left: 50%; top: -4px; margin-left: -5px; border: 5px solid transparent; border-bottom-color: var(--toast-bg); border-top: none; }
.coach-t { display: flex; align-items: center; gap: 8px; font: var(--t2-em); }
.coach-ft { display: flex; align-items: center; justify-content: space-between; }
.coach-btn { background: rgba(255,255,255,0.1); color: #fff; height: 26px; border-radius: var(--r-sm); font: var(--c1-em); padding: 4px 8px; min-width: 52px; }

/* ── Dialog 静态带 mask 帧(契约照抄;活组件用 KDialog) ── */
.dlg-wrap { position: relative; border-radius: var(--r-lg); overflow: hidden; background: var(--bg-ground); border: 0.5px solid var(--sep); min-height: 240px; display: flex; align-items: center; justify-content: center; }
.dlg-bg { position: absolute; inset: 0; padding: 20px; opacity: 0.4; display: flex; flex-direction: column; gap: 10px; }
.dlg-mask { position: absolute; inset: 0; background: var(--mask); }
.dlg-static { position: relative; width: 360px; background: var(--bg-secondary); border-radius: var(--r-xl); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.dlg-static .t { font: var(--t2-em); }
.dlg-static .d { font: var(--b2); line-height: 20px; }
.dlg-static .ft { display: flex; gap: 8px; justify-content: flex-end; }

/* ── 动效规格表(照抄 interactions.html .mo) ── */
.mo { display: grid; grid-template-columns: 150px 90px 190px 1fr; border: 0.5px solid var(--sep); border-radius: var(--r-lg); overflow: hidden; margin-top: var(--s4); }
.mo > div { padding: 10px 14px; border-bottom: 0.5px solid var(--sep); font: var(--c1); color: var(--label-2); }
.mo .h { background: var(--fill-1); font: var(--c1-em); color: var(--label-1); }
.mo .n { font: var(--b2-em); color: var(--label-1); }
.mo code { font-size: 11px; }

/* ── 三态样板卡(design.css .panel 衍生,实验室本地) ── */
.k-card { width: 100%; background: var(--bg-primary-90); border: 0.5px solid var(--sep); border-radius: var(--r-lg); overflow: hidden; }
.k-hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 0.5px solid var(--sep); font: var(--c1-em); }
.k-empty { padding: 24px 16px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.k-err { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.note-r { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--r-md); background: var(--red-10); border: 0.5px solid var(--danger); font: var(--c1); }
</style>
