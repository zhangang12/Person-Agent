<script setup lang="ts">
// 任务编排页(从 legacy dock 抽出):只做一件事 —— 组合 SKILL 与内置能力,串成多步任务链开跑。
// ?mode=pipe(默认,技能串接)/ ?mode=wf(动态工作流:复杂目标 → 主控预检拆片并行;模板 chips 引导)。
// 两形态共享:排队位 + 工作流列表 + 详情双栏(列表按形态过滤:pipe 只看编排,wf 看工作流/主控)。
import { ref, onMounted, onBeforeUnmount } from 'vue'

const BH = (): any => (window as any).BocomHermes
const pageMode = (new URLSearchParams(location.search).get('mode') === 'wf') ? 'wf' : 'pipe'
const isWf = pageMode === 'wf'
const pageTitle = isWf ? '动态工作流' : '任务编排'
const pageSub = isWf ? '复杂目标 → 主控预检路由:装得下派单卡,装不下拆多片并行干' : '组合技能与能力,串成多步任务链'

// ── 发起区:目标 + 积木(wf=模板 / pipe=技能+内置能力) ──
const goal = ref('')
const projName = ref('')
// 落盘路径(发起时拼进描述的【落盘要求】:产出文档/中间过程文档;localStorage 记住偏好)
const outDir = ref(localStorage.getItem('orch.outDir') || 'docs/pipeline/')
const wipDir = ref(localStorage.getItem('orch.wipDir') || 'docs/_wip/')
async function pickOutDir() {
  try {
    const r = await BH()?.pickDir?.({ title: '选择【产出文档】落盘目录', defaultPath: outDir.value })
    if (r && !r.canceled && r.dir) { outDir.value = r.dir; localStorage.setItem('orch.outDir', r.dir) }
  } catch { /* 静默 */ }
}
async function pickWipDir() {
  try {
    const r = await BH()?.pickDir?.({ title: '选择【中间过程文档】落盘目录', defaultPath: wipDir.value })
    if (r && !r.canceled && r.dir) { wipDir.value = r.dir; localStorage.setItem('orch.wipDir', r.dir) }
  } catch { /* 静默 */ }
}
async function pickProj() {   // 项目路径切换(全局默认仓;发起的工作流对它说话)
  try {
    const p = await BH()?.pickProject?.()
    if (p) projName.value = p
  } catch { /* 静默 */ }
}
// wf 模板(动态工作流引导:探索成文/评审/排查,goalPrefix 预置)
const wfTpls = ref<{ id?: string; name?: string; hint?: string; goalPrefix?: string }[]>([])
async function loadWfTpls() {
  if (!isWf) return
  try { wfTpls.value = (await BH()?.wfTemplates?.()) || [] } catch { /* 静默 */ }
}
// pipe 积木:录制的技能 + 内置能力
const skills = ref<{ id?: string; name?: string; title?: string }[]>([])
async function loadSkills() {
  if (isWf) return
  try { skills.value = (await BH()?.skillsList?.()) || [] } catch { /* 静默 */ }
}
function applySkill(sk: { id?: string; name?: string; title?: string }) {
  applyPhrase('运行技能「' + (sk.name || sk.title || sk.id || '') + '」')
}

// 内置能力积木(自然语言短语,拼进描述)
const BUILTINS = [
  { n: '读文档', p: '读取导出的文件核对数据', t: '读 Excel/CSV/Word/PDF 为文本(doc_read)' },
  { n: '发邮件', p: '把结果整理成邮件发给 〈收件人邮箱〉', t: '经发件箱缓发,可撤销(mail_send)' },
  { n: '搜邮件', p: '搜索相关邮件', t: '按发件人/主题/正文检索(mail_search)' },
  { n: '读附件', p: '读取邮件附件内容', t: '邮件附件文本化(mail_get_attachment_text)' },
  { n: '批量跑技能', p: '按数据表逐行批量运行技能「〈技能名〉」', t: '数据集循环回放(skill_run_batch)' },
  { n: '加待办', p: '把待跟进事项加入待办', t: '登记待办提醒(todo_add)' },
]
function applyPhrase(p: string) {
  goal.value = goal.value ? goal.value.replace(/[，。；;\s]+$/, '') + '，然后' + p : p
}

// 步骤预览(多步:按 ，然后/→/；/; 切分,可删可排序)
const steps = ref<string[]>([])
const previewOpen = ref(false)
function splitSteps(text: string): string[] {
  return String(text || '').split(/，然后|→|；|;\s*/).map((s) => s.trim()).filter(Boolean)
}
function openPreview() {
  const ss = splitSteps(goal.value)
  if (ss.length > 1) { steps.value = ss; previewOpen.value = true; return true }
  return false
}
function delStep(i: number) { steps.value.splice(i, 1); if (!steps.value.length) previewOpen.value = false }
function moveStep(i: number, d: number) {
  const j = i + d; if (j < 0 || j >= steps.value.length) return
  const t = steps.value[i]; steps.value[i] = steps.value[j]; steps.value[j] = t
}

// 发起:pipe → mode:'pipeline'(严格带 steps);wf → mode:'wf'(主控多层,不用步骤预览)
const launching = ref(false)
const launchErr = ref('')
async function launch(strictSteps: string[] | null) {
  const v = goal.value.trim()
  if (!v || launching.value) return
  launchErr.value = ''
  // 编排工具体检:缺工具不开空卡
  try {
    const st = await BH()?.orchToolsStatus?.()
    const miss = (st && Array.isArray(st.missing)) ? st.missing : []
    if (miss.length) { launchErr.value = '缺编排工具：' + miss.join('、') + ' —— 完整重启引擎让它带上编排工具，再开跑'; return }
  } catch { /* 静默:体检通道缺席不挡路 */ }
  if (!isWf && !strictSteps && openPreview()) return   // pipeline 多步先预览
  launching.value = true
  try {
    // 落盘要求随描述注入(编排哲学:一切中间成果写文档落盘;路径用户可选,不再写死 docs/)
    const full = v + '\n【落盘要求】最终产出文档写到「' + outDir.value + '」;中间过程文档(分析/核对/临时稿)写到「' + wipDir.value + '」。'
    const payload: any = { title: v.slice(0, 24), msg: full, body: full, disp: v.slice(0, 60), files: [], mode: isWf ? 'wf' : 'pipeline' }
    if (!isWf && strictSteps && strictSteps.length) { payload.steps = strictSteps; payload.strict = true }
    await BH()?.startConversation?.(payload)
    goal.value = ''; steps.value = []; previewOpen.value = false
    setTimeout(loadWf, 800)
  } catch (e: any) { launchErr.value = String((e && e.message) || e) }
  launching.value = false
}

// ── 工作流列表 + 排队(3s 轮询) ──
const items = ref<any[]>([])
const queued = ref<any[]>([])
const sel = ref<any>(null)
const openActs = ref<Record<string, boolean>>({})
let timer: ReturnType<typeof setInterval> | null = null
async function loadWf() {
  try {
    const r = await BH()?.wfList?.()
    let list = (r && r.items) || []
    // 列表按形态过滤:pipe 只看任务编排;wf 看动态工作流/主控多层(分片不进面板,注册表本来就不含)
    list = list.filter((x: any) => isWf ? x.kind !== 'pipeline' : x.kind === 'pipeline')
    items.value = list
    queued.value = isWf ? [] : ((r && r.queued) || [])   // 排队位只在编排形态显示(wf 队列语义在主控卡)
    // 选中项跟随刷新(没有选中默认选第一条 running)
    if (sel.value) { const hit = list.find((x: any) => (x.id || x.archive) === (sel.value.id || sel.value.archive)); sel.value = hit || null }
    if (!sel.value) { const run = list.find((x: any) => x.status === 'running'); if (run) sel.value = run }
  } catch { /* 静默 */ }
}
onMounted(async () => {
  try { projName.value = (await BH()?.getProject?.()) || '' } catch { /* 静默 */ }
  loadSkills(); loadWfTpls()
  loadWf()
  timer = setInterval(loadWf, 3000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const stText = (w: any) => w.status === 'running' ? (w.busy ? '进行中' : '待操作') : w.status === 'done' ? '已完成' : w.status === 'interrupted' ? '中断' : '存档'
const kindText = (w: any) => w.kind === 'orch' ? '主控·多层派发' : w.kind === 'pipeline' ? '任务编排' : '工作流'
const pctOf = (w: any) => (w.todoTotal > 0 ? Math.round((100 * (w.todoDone || 0)) / w.todoTotal) : -1)
const rel = (ts: number) => {
  const d = Date.now() - ts, m = 60000, h = 3600000
  if (d < m) return '刚刚'
  if (d < h) return Math.floor(d / m) + ' 分钟前'
  if (d < 86400000) return Math.floor(d / h) + ' 小时前'
  return Math.floor(d / 86400000) + ' 天前'
}
function pick(w: any) { sel.value = w }
async function cancelQ(q: any) {
  try { await BH()?.wfCancelQueued?.(String(q.goal || '')) } catch { /* 静默 */ }
  loadWf()
}
async function op(w: any, act: string) {
  if (act === 'del') { try { await BH()?.wfDelete?.(w.id) } catch { /* 静默 */ } if (sel.value === w) sel.value = null; loadWf(); return }
  if (act === 'retry') { try { await BH()?.pipelineRetry?.(w.id) } catch { /* 静默 */ } setTimeout(loadWf, 800); return }
  try { await BH()?.wfOpen?.({ id: w.id, archive: w.archive || '', sid: w.sid || '', kind: w.kind, goal: String(w.goal || '').slice(0, 120) }) } catch { /* 静默 */ }
}
</script>

<template>
  <div id="orch">
    <header class="hd">
      <span class="ttl">{{ pageTitle }}</span>
      <span class="sub">{{ pageSub }}</span>
      <span class="sp"></span>
      <span class="proj pick" :title="'工作目录:' + (projName || '未选目录') + '(点击切换 —— 动态工作流对它说话)'" @click="pickProj">📁 {{ projName || '未选目录' }}</span>
      <button class="mini" title="刷新" @click="loadWf">↻</button>
    </header>

    <!-- 发起区 -->
    <div class="launch">
      <textarea v-model="goal" rows="2" :placeholder="isWf ? '描述一个复杂目标(主控先预检:单卡装得下派单卡,装不下拆多片并行)…' : '串一条任务链,如:运行技能「XX导出」,然后核对导出数据,然后把异常项发邮件给张三(多步会自动出步骤预览)'" @keydown.enter.exact.prevent="launch(null)"></textarea>
      <button class="go" :disabled="!goal.trim() || launching" @click="launch(null)">{{ launching ? '…' : '➤' }}</button>
    </div>
    <div v-if="launchErr" class="errline">{{ launchErr }}</div>
    <!-- 落盘路径:产出文档 / 中间过程文档(点 chip 选目录,记住偏好;发起时随描述注入落盘要求) -->
    <div class="pathrow">
      <button class="pathchip" title="最终产出文档落盘目录(点击选择)" @click="pickOutDir">📄 产出:{{ outDir }}</button>
      <button class="pathchip" title="中间过程文档(分析/核对/临时稿)落盘目录(点击选择)" @click="pickWipDir">🧪 中间过程:{{ wipDir }}</button>
    </div>
    <!-- 积木区:wf=引导模板;pipe=你的技能 + 内置能力 -->
    <div v-if="isWf && wfTpls.length" class="tpls">
      <button v-for="t in wfTpls" :key="t.id || t.name" class="tpl" :title="t.hint + '\n目标前缀:' + (t.goalPrefix || '')" @click="goal = (t.goalPrefix || '')">{{ t.name }}</button>
    </div>
    <div v-else-if="!isWf" class="tpls">
      <button v-for="sk in skills" :key="sk.id || sk.name" class="tpl skill" :title="'拼「运行技能『' + (sk.name || sk.title || sk.id) + '』」进描述'" @click="applySkill(sk)">🎬 {{ sk.name || sk.title || sk.id }}</button>
      <button v-for="b in BUILTINS" :key="b.n" class="tpl" :title="b.t + '\n点一下拼进描述(自然语言短语)'" @click="applyPhrase(b.p)">{{ b.n }}</button>
    </div>
    <!-- 步骤预览(pipeline 多步:可删可排序,智能/严格开跑) -->
    <div v-if="previewOpen" class="preview">
      <div class="pv-hd">步骤预览 · 可删可调序<span class="sp"></span><button class="lnk" @click="previewOpen = false">收起</button></div>
      <div class="pv-steps">
        <div v-for="(s, i) in steps" :key="i" class="pv-chip">
          <span class="pv-n">{{ i + 1 }}</span>{{ s }}
          <span class="pv-ops"><button :disabled="i === 0" @click="moveStep(i, -1)">↑</button><button :disabled="i === steps.length - 1" @click="moveStep(i, 1)">↓</button><button @click="delStep(i)">✕</button></span>
        </div>
      </div>
      <div class="pv-acts">
        <button class="pp-btn on" title="整段描述一次交给编排 Agent,由它自己按顺序走" @click="launch(null)">智能模式开跑</button>
        <button class="pp-btn" title="主进程逐步下发,失败即停" @click="launch(steps)">严格模式开跑</button>
      </div>
    </div>

    <!-- 排队位 -->
    <div v-if="queued.length" class="qbar">
      ⏳ {{ queued.length }} 条排队等并发位:
      <span v-for="(q, i) in queued" :key="i" class="qchip">
        {{ String(q.goal || '').slice(0, 26) }}
        <button title="取消排队" @click="cancelQ(q)">✕</button>
      </span>
    </div>

    <!-- 列表 + 详情双栏 -->
    <div class="split">
      <div class="list">
        <div v-if="!items.length" class="empty">还没有工作流记录 —— 在上方描述一个目标发起第一条</div>
        <div
          v-for="w in items" :key="String(w.kind) + (w.id || w.archive)"
          class="wfcard" :class="{ sel: sel && (sel.id || sel.archive) === (w.id || w.archive) }"
          @click="pick(w)"
        >
          <div class="top">
            <span class="dot" :class="w.status"></span>
            <span class="pill" :class="w.status">{{ stText(w) }}</span>
            <span class="goal" :title="w.goal">{{ w.goal }}</span>
          </div>
          <div v-if="pctOf(w) >= 0" class="pbar"><i :style="{ width: pctOf(w) + '%' }"></i></div>
          <div class="meta">
            <span>{{ kindText(w) }}</span><span>{{ rel(w.at) }}</span>
            <span v-if="w.shards">分片 {{ w.shards }}</span>
            <span v-if="w.diff" class="diff">+{{ w.diff.additions }}/-{{ w.diff.deletions }}</span>
          </div>
          <div v-if="w.current && w.status === 'running'" class="cur">正在:{{ w.current }}</div>
        </div>
      </div>
      <div class="detail">
        <div v-if="!sel" class="empty">点左侧一条看详情</div>
        <template v-else>
          <div v-if="sel.kind === 'orch' && sel.planApproved === false && sel.status === 'running'" class="gate">
            <div class="gt">⚡ 批准闸 · 拆分方案待批准</div>
            <div class="gd">主控卡已出拆分方案,批准后各分片才会开跑。</div>
            <button class="gbtn" @click="op(sel, 'open')">去批准</button>
          </div>
          <div class="d-goal">{{ sel.goal }}</div>
          <div class="d-meta">{{ kindText(sel) }} · {{ stText(sel) }}<template v-if="sel.rounds"> · {{ sel.rounds }} 轮</template><template v-if="sel.elapsedMs"> · {{ Math.round(sel.elapsedMs / 1000) }}s</template></div>
          <div class="d-ops">
            <button v-if="sel.live || sel.sid || sel.archive" @click="op(sel, 'open')">{{ sel.live ? '聚焦卡片' : (sel.sid ? '重开会话' : '打开存档') }}</button>
            <button v-if="sel.kind === 'pipeline' && (sel.status === 'running' || sel.status === 'interrupted')" @click="op(sel, 'retry')">↻ 从失败步续跑</button>
            <button class="danger" @click="op(sel, 'del')">删除</button>
          </div>
          <div v-if="(sel.todos || []).length" class="sec">
            <div class="lb">任务清单 {{ sel.todoDone }}/{{ sel.todoTotal }}</div>
            <div v-for="(t, i) in sel.todos" :key="i" class="todo" :class="{ done: /complet/i.test(t.status || ''), doing: /progress|doing/i.test(t.status || '') }"><i></i>{{ t.text }}</div>
          </div>
          <div v-if="(sel.fileList || []).length" class="sec">
            <div class="lb">产出文件</div>
            <div v-for="f in sel.fileList" :key="f" class="file" :title="f">{{ String(f).split(/[\\/]/).slice(-2).join('/') }}</div>
          </div>
          <div v-if="(sel.actions || []).length" class="sec">
            <div class="lb" @click="openActs[sel.id] = !openActs[sel.id]" style="cursor:pointer">动作流水 {{ openActs[sel.id] ? '▾' : '▸' }}</div>
            <template v-if="openActs[sel.id]">
              <div v-for="(a, i) in sel.actions.slice(-12).reverse()" :key="i" class="act"><b>{{ a.kind || '·' }}</b> {{ a.label }}<span v-if="a.detail"> — {{ a.detail }}</span></div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
