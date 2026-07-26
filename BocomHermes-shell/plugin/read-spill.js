/**
 * read-spill — opencode 插件:内建 read/grep 大输出「外溢落盘」(128k 上下文治理)
 *
 * 职责:
 *   模型用内建 read/grep 读大文件,一次就能把上下文吃掉几万 token;壳层(Electron 主进程)
 *   拦不到 serve 内部的工具输出,因此在 serve 插件层解决——本插件挂在 opencode 的
 *   `tool.execute.after` 钩子上(该钩子的 output.output 可写,改动会进入会话状态即模型上下文,
 *   已在 opencode 1.17.13 上端到端验证),输出超阈值时把完整内容写到临时文件,
 *   上下文里只留「头部若干行 + 路径 + 总行数/总字符数」,模型需要更多时按提示用
 *   read 带 offset/limit 读落盘文件。
 *
 * 安装(二选一,opencode 启动时自动加载,无需改 opencode.jsonc):
 *   - 项目级:  <项目>/.opencode/plugin/read-spill.js   (只对该目录下的 serve 生效)
 *   - 全局级:  ~/.config/opencode/plugin/read-spill.js (对所有 serve 生效;Windows 即 %USERPROFILE%/.config/opencode/plugin/)
 *   ⚠ 两条硬约束(源码实测,opencode 1.17.13 src/config/plugin.ts):
 *     ① 目录扫描的 glob 是 `{plugin,plugins}/*.{ts,js}` —— 【只认 .ts/.js,不认 .mjs】,
 *        所以本文件必须是 .js(ESM 语法,bun 加载无碍);
 *     ② 模块的每个导出都会被当作插件函数调用(getLegacyPlugins),导出非函数会直接
 *        TypeError 跳过整个文件;导出返回 null 的函数会污染 hooks 表、拖垮全部钩子——
 *        因此本文件【有且仅有一个导出】ReadSpillPlugin,加辅助函数一律不导出。
 *
 * 配置(环境变量,读取时机 = 插件初始化;serve 进程环境;均可省):
 *   BOCOMHERMES_READ_SPILL_MAX    单次阈值(字符),默认 8000;设为 0 或负数 = 关闭单次闸
 *   BOCOMHERMES_READ_SPILL_HEAD   摘要保留头部行数,默认 40
 *   BOCOMHERMES_READ_SPILL_TOOLS  拦截的工具名(逗号分隔,大小写不敏感),默认 "read,grep,bash"(bash 同拦:模型会用 cat 绕开 read)
 *   BOCOMHERMES_READ_SPILL_DIR    落盘目录,默认 <系统 temp>/bocomhermes-read-spill
 *   BOCOMHERMES_READ_SPILL_SESSION_MAX  会话累计桶(第二道闸,字符),默认 40000;0 或负数 = 关闭累计桶。
 *     单次闸管"一次读了个大的",累计桶管"十次 6k 中等输出累计灌爆"(128k 实测病灶):
 *     每次工具输出都计入该会话总账,累计超线后【该会话后续输出一律外溢】(无论单次多小),
 *     替代文本引导"grep 定位后分段精读"。计数只增不减(保守),新会话自然新桶;桶表超 500 会话整表清。
 *   (注意:opencode 是 Windows 原生进程,传 Windows 路径如 C:/...,不要传 Git Bash 的 /c/...)
 *
 * 注入哪些依赖:无(零依赖,只用 node 内置模块);ctx 未使用,纯靠环境变量配置,
 *   方便壳层 spawn serve 时经 env 注入阈值。自测见 scripts/read-spill-selftest.mjs。
 *
 * 兼容性备忘:bocomcode(内网 fork)需确认 ① 插件机制未砍 ② tool.execute.after 的
 *   output.output 改动会回写会话状态(上游已知坑:MCP 工具输出曾在钩子前定型导致
 *   改动不进上下文,sst/opencode #3384 已修;内建工具可改为社区共识与官方手册口径,
 *   且已在本机 opencode 1.17.13 实测通过)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 文件名里不允许出现的字符替换掉(sessionID/callID 理论上安全,防御性处理)
function safeName(s) {
  return String(s || 'anon').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-64)
}

/**
 * 纯逻辑:超阈值则落盘并返回替代文本;未超阈值返回 null(不拦)。
 * 独立函数是为了逻辑清晰;钩子本体只是薄封装。注意:不导出(见文件头约束②)。
 * @param {string} text 工具原始输出
 * @param {{maxChars:number, headLines:number, spillDir:string, sessionID:string, callID:string}} cfg
 * @returns {{file:string, replacement:string}|null}
 */
function spillIfTooBig(text, cfg) {
  if (typeof text !== 'string') return null
  if (cfg.maxChars <= 0) return null                    // 0/负数 = 关闭
  if (text.length <= cfg.maxChars) return null
  fs.mkdirSync(cfg.spillDir, { recursive: true })
  const file = path.join(
    cfg.spillDir,
    `${safeName(cfg.sessionID)}-${Date.now()}-${safeName(cfg.callID)}.txt`,
  )
  fs.writeFileSync(file, text, 'utf8')
  const lines = text.split('\n')
  const head = lines.slice(0, cfg.headLines).join('\n')
  const replacement =
    head
    + `\n\n…(输出过长已外溢:共 ${lines.length} 行 / ${text.length} 字符,完整内容已存 ${file}`
    + '。需要更多内容时,用 read 带 offset/limit 读该文件,或 grep 该文件定位行号后再分段读)'
  return { file, replacement }
}

/**
 * 会话累计桶超线后的外溢:无论单次多小一律落盘,替代文本换"预算线"口径(引导 grep 分段精读,别再全文读)。
 * @param {string} text 工具原始输出
 * @param {{spillDir:string, sessionMax:number, sessionID:string, callID:string}} cfg
 * @param {number} bytes 该会话累计字节(计入本次后)
 * @returns {{file:string, replacement:string}|null}
 */
function spillBudgetLine(text, cfg, bytes) {
  if (typeof text !== 'string') return null
  fs.mkdirSync(cfg.spillDir, { recursive: true })
  const file = path.join(
    cfg.spillDir,
    `${safeName(cfg.sessionID)}-${Date.now()}-${safeName(cfg.callID)}.txt`,
  )
  fs.writeFileSync(file, text, 'utf8')
  const replacement =
    `本会话读取量已到预算线(累计 ${bytes} 字符 > 预算 ${cfg.sessionMax}):完整内容已存 ${file}`
    + '。请改用 grep 定位后分段精读,不要再全文读取。'
  return { file, replacement }
}

/** 读取插件配置(环境变量优先,全部有默认值) */
function loadConfig() {
  const maxChars = Number(process.env.BOCOMHERMES_READ_SPILL_MAX ?? 8000)
  const headLines = Number(process.env.BOCOMHERMES_READ_SPILL_HEAD ?? 40)
  const tools = String(process.env.BOCOMHERMES_READ_SPILL_TOOLS || 'read,grep,bash')   // bash 同拦:模型会用 cat 绕开 read(实测),>阈值照样外溢;TUI 快照问题仅影响界面显示(metadata.output 已同步替换)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const spillDir = process.env.BOCOMHERMES_READ_SPILL_DIR
    || path.join(os.tmpdir(), 'bocomhermes-read-spill')
  const sessionMax = Number(process.env.BOCOMHERMES_READ_SPILL_SESSION_MAX ?? 40000)
  return {
    maxChars: Number.isFinite(maxChars) ? maxChars : 8000,
    headLines: Number.isFinite(headLines) && headLines > 0 ? headLines : 40,
    tools,
    spillDir,
    sessionMax: Number.isFinite(sessionMax) ? sessionMax : 40000,
  }
}

/** opencode 插件入口:返回钩子表。本文件唯一导出(约束②)。 */
export const ReadSpillPlugin = async () => {
  const cfg = loadConfig()
  const sessionBuckets = new Map()   // 会话累计桶:sessionID → {bytes};只增不减(保守),超 500 会话整表清(与壳层各 Map 防涨同款)
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (!input || !output) return
        if (!cfg.tools.includes(String(input.tool || '').toLowerCase())) return
        const sid = String(input.sessionID || 'anon')
        const outLen = typeof output.output === 'string' ? output.output.length : 0
        // 第二道闸:累计超线后一律外溢(无论单次多小);第一道闸:单次超阈值外溢
        let overLine = false
        if (cfg.sessionMax > 0 && outLen > 0) {
          let b = sessionBuckets.get(sid)
          if (!b) { b = { bytes: 0 }; sessionBuckets.set(sid, b) }
          if (sessionBuckets.size > 500) sessionBuckets.clear()
          b.bytes += outLen
          overLine = b.bytes > cfg.sessionMax
        }
        const hit = overLine
          ? spillBudgetLine(output.output, { spillDir: cfg.spillDir, sessionMax: cfg.sessionMax, sessionID: sid, callID: input.callID }, sessionBuckets.get(sid).bytes)
          : spillIfTooBig(output.output, {
            maxChars: cfg.maxChars,
            headLines: cfg.headLines,
            spillDir: cfg.spillDir,
            sessionID: input.sessionID,
            callID: input.callID,
          })
        if (!hit) return
        output.output = hit.replacement
        // bash 系工具的 TUI 渲染读 metadata.output 快照(上游 issue #13575),同步替换保持一致
        if (output.metadata && typeof output.metadata.output === 'string'
          && output.metadata.output.length > cfg.maxChars) {
          output.metadata.output = hit.replacement
        }
        // 留痕给壳层/排查:元数据标记本次外溢
        if (output.metadata && typeof output.metadata === 'object') {
          output.metadata.spillFile = hit.file
          output.metadata.spillOriginalChars = fs.statSync(hit.file).size
          if (overLine) output.metadata.spillBudgetLine = true
        }
      } catch {
        // 拦截器绝不能炸掉工具调用本身:任何异常都静默放行原始输出
      }
    },
  }
}
