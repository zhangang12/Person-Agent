/**
 * edit-guard — opencode 插件:Read-before-Edit 硬闸(CC 同款纪律:没 Read 过的文件不许 Edit)
 *
 * 职责:
 *   按会话维护"已读文件集合"(read 工具成功返回后,登记归一化路径);tool.execute.before 钩子上:
 *     · edit/multiedit 目标文件未读过 → 抛错拦停(文案明说"先 read 再 edit")
 *     · write 目标【已存在】且未读过 → 同样拦;写新文件一律放行
 *   拦截文案本身就是给模型的纠偏指令。弱模型没看原文就凭空改文件是内网实测高频病灶 ——
 *   提示词叮嘱会忘,壳层机械拦截不会。
 *
 * 形状容错:before 钩不存在/入参形状不符一律静默放行(绝不误拦正常调用);
 *   插件自身异常也静默放行(绝不炸工具调用)。
 *
 * 配置(环境变量,均可省):
 *   BOCOMHERMES_EDIT_GUARD   总开关,默认 1;0 = 关(排障逃生门)
 *
 * 安装:与 read-spill 同路(壳层 src/plugin-install.js 启动拷贝到 ~/.config/opencode/plugin/)。
 *   两条硬约束同 read-spill:只认 `{plugin,plugins}/*.{ts,js}`;【有且仅有一个导出】。
 * 自测:scripts/edit-guard-selftest.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

/** 归一化路径(cwd 相对解析 + 正斜杠 + 小写,Windows 大小写不敏感) */
function norm(p, cwd) {
  try { return path.resolve(cwd || process.cwd(), String(p || '')).replace(/\\/g, '/').toLowerCase() } catch { return String(p || '').toLowerCase() }
}

/** opencode 插件入口:返回钩子表。本文件唯一导出(目录扫描约束②)。 */
export const EditGuardPlugin = async () => {
  const on = String(process.env.BOCOMHERMES_EDIT_GUARD ?? '1') !== '0'
  const reads = new Map()   // sessionID → Set<归一化路径>;超 500 会话整表清(与壳层各 Map 防涨同款)
  const mark = (sid, fp, cwd) => {
    let s = reads.get(sid); if (!s) { s = new Set(); reads.set(sid, s) }
    if (reads.size > 500) reads.clear()
    s.add(norm(fp, cwd))
  }
  return {
    // read 成功后登记已读(工具名兼容大小写;glob/grep 不算"读过" —— CC 同口径,只认 read)
    'tool.execute.after': async (input, output) => {
      try {
        if (!on) return
        if (String((input && input.tool) || '').toLowerCase() !== 'read') return
        const inp = (input && input.args) || {}
        const fp = inp.filePath || inp.path || inp.file
        if (fp && input.sessionID) mark(input.sessionID, fp, process.cwd())
      } catch { /* 静默 */ }
    },
    // edit/write 前置硬闸:未读先拦(抛错 = 取消这次调用)
    'tool.execute.before': async (input, output) => {
      try {
        if (!on) return
        const tool = String((input && input.tool) || '').toLowerCase()
        if (!/^(edit|write|multiedit)$/.test(tool)) return
        const inp = (input && input.args) || {}
        const fp = inp.filePath || inp.path || inp.file
        if (!fp) return
        const cwd = process.cwd()
        const target = norm(fp, cwd)
        const seen = reads.get(input.sessionID)
        if (seen && seen.has(target)) return   // 已读过 → 放行
        if (tool === 'write') {   // write 新文件放行;已存在且未读过才拦
          let exists = false
          try { fs.accessSync(path.resolve(cwd, fp)); exists = true } catch {}
          if (!exists) return
        }
        throw new Error('[edit-guard] 没读过 ' + fp + ' —— 先用 read 读该文件再 ' + tool + '(Read-before-Edit 硬闸:不许凭空改文件)。')
      } catch (e) {
        if (e && /edit-guard/.test(String(e && e.message))) throw e   // 拦停信号原样上抛
        // 其余异常静默放行:插件出错绝不误拦正常调用
      }
    },
  }
}
