/**
 * bocomhermes-context-guard — opencode 插件:128k 上下文治理 + 弱模型纪律注入(合体插件)
 *
 * 职责(六个钩子,全部"只追加/只降级、不破坏";任何异常静默放行,绝不炸掉请求):
 *   ① experimental.chat.messages.transform — 历史工具结果清理(R2):发给 LLM 前,
 *      保最近 N 轮(默认 3)工具结果全文,更早的替换为 `[已清理:read <path>,原 N 字符]` 占位符;
 *      聚合预算:可见工具结果总字符超 BUDGET(默认 40000)时,对窗口内最老的也降级(最新一轮永远不动)。
 *      读图后历史净化(在轮次清理之前执行):后面已有 assistant 文本结论的图片 part
 *      (type 'file' 且 mime 为 image/*,或 type 'image')替换为 `[图片已读:结论见下文]` 文本占位
 *      (保留 id)——多模态验证棒读完图后,base64 不留历史白占上下文,后续非多模态模型也不会再
 *      读到图片 part 而报错;同 ID 同决策('img:' 前缀),绝不还原。
 *      【KV-cache 纪律】清理决策按 partID 记忆:同一 part 任何轮次做相同替换(同 ID 同决策),
 *      已被清理的绝不还原——前缀逐字节稳定才保 prompt 缓存命中(借鉴 CC forkedAgent 克隆注释)。
 *   ② experimental.chat.system.transform — 系统提示纪律注入:往 system 数组【尾部】追加
 *      <上下文纪律(128k)>/<如实汇报>/<委派纪律>(见 SYS_BLOCK)。task 子 Agent 是全新会话,
 *      壳层首发注入管不到它们的系统提示——此钩按 sessionID 无差别生效,补结构性盲区。
 *      只追加不替换(opencode 会把首元素之后的内容并为一块保缓存;去重靠文本标记)。
 *   ③ experimental.session.compacting — 压缩纪律:往 context 追加五条(保留 todo/已读文件清单/
 *      失败证据/下一步逐字引用/增量锚定),不替换 prompt;serve 被动压缩时摘要不再裸奔。
 *   ④ experimental.compaction.autocontinue — 恒 enabled:true(压缩后自动续跑 = 压缩后防停)。
 *   ⑤ chat.params — maxOutputTokens 收口(默认关,BOCOMHERMES_MAX_OUTPUT_TOKENS>0 才钳制;
 *      弱模型输出过长是回合拖沓与 JSON 截断来源之一)。
 *   ⑥ tool.execute.after — 空输出占位符:工具输出为空时替换为 `(X completed with no output)`,
 *      永远别让模型面对"什么都没有"的尾部(借鉴 CC toolResultStorage 空 tool_result 补丁,
 *      与 read-spill 互补:它管大输出,这里管空输出)。
 *
 * 安装:与 read-spill 同路(壳层 src/plugin-install.js 启动时拷贝到 ~/.config/opencode/plugin/)。
 *   两条硬约束同 read-spill:只认 `{plugin,plugins}/*.{ts,js}`;【有且仅有一个导出】。
 *
 * 配置(环境变量,读取时机 = 插件初始化;均可省):
 *   BOCOMHERMES_CTX_GUARD             总开关,默认 1;0 = 全部钩子变 no-op(内网排障逃生门)
 *   BOCOMHERMES_CTX_GUARD_IMG_PURGE   读图后历史净化开关,默认 1;0 = 关闭净化
 *   BOCOMHERMES_CTX_GUARD_KEEP_TURNS  保留全文的最近轮数,默认 3
 *   BOCOMHERMES_CTX_GUARD_BUDGET      可见工具结果聚合预算(字符),默认 40000;0 = 只按轮次清理
 *   BOCOMHERMES_MAX_OUTPUT_TOKENS     maxOutputTokens 钳制,默认 0 = 不收口
 *   BOCOMHERMES_CTX_LIMIT_K           纪律文本里的上下文口径(千 tokens),默认 192(MiniMax M2.5 实测口径;
 *                                     与壳层 knobs.ctxLimitMax 同源——壳层改口径时同步改这个环境变量)
 *
 * 通道验证:forkcheck T4(messages.transform)/T6(system.transform)已在本机 opencode 1.18.3
 *   端到端验证绿;bocomcode fork 需复验(不绿则钩子静默无效,不伤会话)。
 * 依据:external/claude-code-提示词工程借鉴.md §9.2、external/claude-code-借鉴总清单.md B1/B2/B4/B5。
 * 自测:scripts/context-guard-selftest.mjs。
 */
// ── 纪律文本(终稿,docs/整改实施计划-内网opencode×弱模型.md 附录 A/B) ──
// 口径随 knobs.ctxLimitMax 同步(当前 192k,M2.5 实测):插件读不到壳层设置,经 BOCOMHERMES_CTX_LIMIT_K 注入(读取时机 = 插件初始化)
function sysBlockOf(cfg) {
  return '<上下文纪律(' + cfg.ck + ')>你的上下文窗口约 ' + cfg.ck + ' tokens，省着用：① 按需精读，不通读整个模块——单次 read ≤400 行（带 offset/limit），grep 先收窄路径与类型；深读大片文件用 task 派子 Agent（它有独立 ' + cfg.ck + '）。② task/delegate_task 指令只写目标+文件路径+边界+回报格式，严禁贴文件原文/大段代码。③ 子 Agent 结论一律落盘成文档，回报只给一句话+路径。</上下文纪律>\n'
    + '<如实汇报>跑过验证再说"完成"；没法验证就明说"还没验证"；失败贴原始输出，不许粉饰成成功；确认通过的也直说，不要防御性打折扣。</如实汇报>\n'
    + '<委派纪律>委派指令=目标+路径+边界+回报格式；回报要自包含（结论带 文件:行号）；不偷看子 Agent 的中间过程，不编造未收到的回报。</委派纪律>\n'
    // 语言纪律(P1.5,2026-07-29):首发注入只在第一条用户消息,后面轮次被 serve 英文系统提示+OMO 英文提醒压回去(实测:
    // 第一轮思考中文、第二轮起又跑英文)。system 尾注每条请求都带,且 task 子 Agent 的全新会话也覆盖(首发注入管不到它们)。
    + '<语言纪律>回答用中文，【思考过程（reasoning）也一律用中文输出】；代码、命令、标识符保持原文。</语言纪律>'
}
const COMPACT_RULES = [
  '- 保留 todo 计划清单原样逐条及其当前状态',
  '- 保留已读文件清单（路径 + 一句"读到了什么"），新上下文直接采信不重读',
  '- 保留失败证据：已尝试与已排除路径，各附一句原因',
  '- "下一步"逐字引用最近对话原话，防止意图漂移',
  '- 增量更新摘要：保留仍然成立的事实，删除过期事实，合并新事实',
]

const CLEAN_MARK = '[已清理:'
const IMG_MARK = '[图片已读:结论见下文]'

/** 提取 tool part 的输出字符串所在位置(state.output 优先,兼容扁平 output) */
function toolOut(p) {
  if (p && p.state && typeof p.state.output === 'string') return { get: () => p.state.output, set: (v) => { p.state.output = v } }
  if (p && typeof p.output === 'string') return { get: () => p.output, set: (v) => { p.output = v } }
  return null
}
/** 生成占位符(确定性:同输入必同文,保 KV-cache);read-spill 外溢过的结果把落盘路径一并保留 */
function makePlaceholder(p, text) {
  const toolName = String(p.tool || (p.state && p.state.tool) || 'tool')
  const inp = (p.state && p.state.input) || p.input || {}
  const hint = String(inp.filePath || inp.path || inp.command || inp.pattern || '').slice(0, 120)
  const spill = String(text).match(/完整内容已存 (\S+?)(?:。|$)/)
  return CLEAN_MARK + toolName + (hint ? ' ' + hint : '') + ',原 ' + text.length + ' 字符'
    + (spill ? ',全文在 ' + spill[1] : '') + ',历史工具结果已被上下文治理清理]'
}
function roleOf(m) { return String((m && m.info && m.info.role) || (m && m.role) || '') }

/** 图片类 part 判定:type==='file' 且 mime 以 image/ 开头,或 type==='image'(serve 两种形状) */
function isImgPart(p) {
  if (!p || typeof p !== 'object') return false
  if (p.type === 'image') return true
  return p.type === 'file' && String(p.mime || '').startsWith('image/')
}
/** 该 part 之后是否存在更新的 assistant 非空文本(在该 part 所属消息之后,含同消息更后的 part) */
function hasLaterAssistantText(msgs, mi, pi) {
  for (let i = mi; i < msgs.length; i++) {
    if (roleOf(msgs[i]) !== 'assistant') continue
    const parts = (msgs[i] && msgs[i].parts) || []
    for (let j = i === mi ? pi + 1 : 0; j < parts.length; j++) {
      const q = parts[j]
      if (q && q.type === 'text' && String(q.text || '').trim()) return true
    }
  }
  return false
}
/** 图片占位 part(确定性同文,保 KV-cache;保留原 part 的 id) */
function imgPlaceholder(p) {
  const ph = { type: 'text', text: IMG_MARK }
  if (p.id) ph.id = p.id
  return ph
}

function loadConfig() {
  const on = String(process.env.BOCOMHERMES_CTX_GUARD ?? '1') !== '0'
  const imgPurge = String(process.env.BOCOMHERMES_CTX_GUARD_IMG_PURGE ?? '1') !== '0'
  const keepTurns = Number(process.env.BOCOMHERMES_CTX_GUARD_KEEP_TURNS ?? 3)
  const budget = Number(process.env.BOCOMHERMES_CTX_GUARD_BUDGET ?? 40000)
  const maxOut = Number(process.env.BOCOMHERMES_MAX_OUTPUT_TOKENS ?? 0)
  const ck = String(Math.max(1, Math.round(Number(process.env.BOCOMHERMES_CTX_LIMIT_K ?? 192) || 192))) + 'k'
  return {
    on,
    imgPurge,
    keepTurns: Number.isFinite(keepTurns) && keepTurns >= 1 ? Math.floor(keepTurns) : 3,
    budget: Number.isFinite(budget) && budget >= 0 ? budget : 40000,
    maxOut: Number.isFinite(maxOut) && maxOut > 0 ? Math.floor(maxOut) : 0,
    ck,
  }
}

/** opencode 插件入口:返回钩子表。本文件唯一导出(目录扫描约束②)。 */
export const ContextGuardPlugin = async () => {
  const cfg = loadConfig()
  const decisions = new Map()   // partID → 占位符 | null(已是占位符);图片净化键带 'img:' 前缀;同 ID 同决策(KV-cache 纪律),超 5000 整表清

  /** 清理一个 tool part(幂等;返回"省下的字符数") */
  function cleanPart(p) {
    const acc = toolOut(p)
    if (!acc) return 0
    const id = String(p.id || '')
    if (id && decisions.has(id)) {
      const ph = decisions.get(id)
      if (ph === null) return 0
      const saved = acc.get().length - ph.length
      acc.set(ph)
      return Math.max(0, saved)
    }
    const text = acc.get()
    if (text.includes(CLEAN_MARK)) { if (id) decisions.set(id, null); return 0 }   // 已是占位符:决策记忆,绝不二包
    const ph = makePlaceholder(p, text)
    if (decisions.size > 5000) decisions.clear()
    if (id) decisions.set(id, ph)
    acc.set(ph)
    return Math.max(0, text.length - ph.length)
  }

  return {
    // ① 历史工具结果清理 + 聚合预算
    'experimental.chat.messages.transform': async (input, output) => {
      try {
        if (!cfg.on || !output || !Array.isArray(output.messages)) return
        const msgs = output.messages
        // 读图后历史净化(在轮次清理之前):后面已有 assistant 文本结论的图片 part 降级为文本占位。
        // 只记忆"替换"决策("还没读"不记忆——图片首次出现正是没有结论的时候,记住了就永远清不掉);
        // 已决策替换的同 ID 任何轮次都替换,即使结论后来被压缩掉也绝不还原。
        if (cfg.imgPurge) {
          for (let i = 0; i < msgs.length; i++) {
            const parts = (msgs[i] && msgs[i].parts) || []
            for (let j = 0; j < parts.length; j++) {
              const p = parts[j]
              if (!isImgPart(p)) continue   // 已是占位(type 'text')/非图片:天然跳过
              const id = String(p.id || '')
              const key = 'img:' + id
              if (id && decisions.has(key)) { parts[j] = imgPlaceholder(p); continue }   // 同 ID 同决策
              if (!hasLaterAssistantText(msgs, i, j)) continue   // 模型还没读它/还没给结论:不动
              if (decisions.size > 5000) decisions.clear()
              if (id) decisions.set(key, IMG_MARK)
              parts[j] = imgPlaceholder(p)
            }
          }
        }
        // 轮次边界:从后往前数第 N 个 user 消息;它之前的是"已死的历史"
        let keepFrom = msgs.length, seen = 0
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (roleOf(msgs[i]) === 'user') { seen++; if (seen >= cfg.keepTurns) { keepFrom = i; break } }
        }
        if (seen < cfg.keepTurns) keepFrom = msgs.length   // 不足 N 轮:全在窗口内,不按轮次清
        let totalToolChars = 0
        for (let i = 0; i < msgs.length; i++) {
          for (const p of (msgs[i] && msgs[i].parts) || []) {
            if (!p || p.type !== 'tool') continue
            if (i < keepFrom) cleanPart(p)
            const acc = toolOut(p)
            if (acc) totalToolChars += acc.get().length
          }
        }
        // 聚合预算:窗口内总量超线 → 从最老开始降级(最新一轮永远不动)
        if (cfg.budget > 0 && totalToolChars > cfg.budget && keepFrom < msgs.length) {
          let lastUserIdx = msgs.length
          for (let i = msgs.length - 1; i >= 0; i--) { if (roleOf(msgs[i]) === 'user') { lastUserIdx = i; break } }
          for (let i = 0; i < lastUserIdx && totalToolChars > cfg.budget; i++) {
            for (const p of (msgs[i] && msgs[i].parts) || []) {
              if (!p || p.type !== 'tool') continue
              totalToolChars -= cleanPart(p)
              if (totalToolChars <= cfg.budget) break
            }
          }
        }
      } catch { /* 静默:清不动就放行原始历史 */ }
    },
    // ② 系统提示纪律注入(尾部追加,去重靠文本标记)
    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (!cfg.on || !output || !Array.isArray(output.system)) return
        if (!output.system.some((x) => String(x).includes('上下文纪律('))) output.system.push(sysBlockOf(cfg))
      } catch { /* 静默 */ }
    },
    // ③ 压缩纪律(只往 context 追加,不替换 prompt)
    'experimental.session.compacting': async (input, output) => {
      try {
        if (!cfg.on || !output || !Array.isArray(output.context)) return
        output.context.push(...COMPACT_RULES)
      } catch { /* 静默 */ }
    },
    // ④ 压缩后自动续跑(防停)
    'experimental.compaction.autocontinue': async (input, output) => {
      try { if (cfg.on && output) output.enabled = true } catch { /* 静默 */ }
    },
    // ⑤ maxOutputTokens 收口(默认关)
    'chat.params': async (input, output) => {
      try {
        if (!cfg.on || !cfg.maxOut || !output) return
        output.maxOutputTokens = Math.min(output.maxOutputTokens ?? cfg.maxOut, cfg.maxOut)
      } catch { /* 静默 */ }
    },
    // ⑥ 空输出占位符(与 read-spill 互补:它管大输出,这里管空输出)
    'tool.execute.after': async (input, output) => {
      try {
        if (!cfg.on || !output) return
        if (!String(output.output ?? '').trim()) {
          output.output = '(' + String((input && input.tool) || 'tool') + ' completed with no output)'
        }
      } catch { /* 静默 */ }
    },
  }
}
