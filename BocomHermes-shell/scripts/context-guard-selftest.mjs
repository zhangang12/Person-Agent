/**
 * bocomhermes-context-guard 插件自测(零依赖,不连真 serve / 真模型)
 *
 * 测什么(对应插件六个钩子):
 *   ① messages.transform:老旧轮次(最近 N 轮之前)的工具结果被替换为占位符;窗口内不动
 *   ② 幂等/KV-cache:同一输入跑两遍结果逐字节相同;已是占位符的绝不二包
 *   ③ 聚合预算:窗口内总量超线 → 最老的也被降级,最新一轮永远不动
 *   ④ system.transform:纪律块尾部追加一次,不重复追加,原有元素不动
 *   ⑤ compacting:context 追加五条纪律,prompt 不被替换;autocontinue 恒 true
 *   ⑥ chat.params:默认不收口;MAX_OUT>0 时钳高保低
 *   ⑦ tool.execute.after:空输出 → 占位符;非空不动;read-spill 外溢文本(非空)不受影响
 *   ⑧ 异常输入静默放行
 * 怎么跑: node scripts/context-guard-selftest.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = path.resolve(import.meta.dirname, '../plugin/bocomhermes-context-guard.js')

let passed = 0
let failed = 0
function ok(name, cond) {
  if (cond) { passed++; console.log(`✓ ${name}`) }
  else { failed++; console.log(`✗ ${name}`) }
}

async function loadPluginWithEnv(env) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === null) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const mod = await import(pathToFileURL(PLUGIN).href)
    const hooks = await mod.ContextGuardPlugin({})
    return hooks
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** 造 N 轮对话:user / assistant(带一个 read 工具 part) 交替 */
function makeSession(turns, outLen = 3000) {
  const msgs = []
  for (let i = 1; i <= turns; i++) {
    msgs.push({ info: { id: 'u' + i, role: 'user' }, parts: [{ id: 'ut' + i, type: 'text', text: '第' + i + '轮问题' }] })
    msgs.push({
      info: { id: 'a' + i, role: 'assistant' },
      parts: [{
        id: 'p' + i, type: 'tool', tool: 'read',
        state: { status: 'completed', input: { filePath: '/src/f' + i + '.ts' }, output: 'X'.repeat(outLen) + '-文件' + i + '内容' },
      }],
    })
  }
  return msgs
}

// ── ① 老旧轮次清理 ──
{
  const hooks = await loadPluginWithEnv({})
  const output = { messages: makeSession(6) }
  await hooks['experimental.chat.messages.transform']({}, output)
  const out = (m, pi) => m.parts[pi].state.output
  ok('第 1-3 轮(最近 3 轮之前)工具结果被清理', [1, 2, 3].every((t) => out(output.messages[(t - 1) * 2 + 1], 0).startsWith('[已清理:')))
  ok('占位符带工具名/路径/原字符数', out(output.messages[1], 0).includes('read /src/f1.ts') && out(output.messages[1], 0).includes('原 30'))
  ok('最近 3 轮(4-6)工具结果全文保留', [4, 5, 6].every((t) => out(output.messages[(t - 1) * 2 + 1], 0).includes('-文件' + t + '内容')))
  ok('user 消息不受影响', output.messages[0].parts[0].text === '第1轮问题')
}

// ── ② 幂等(KV-cache 纪律) ──
{
  const hooks = await loadPluginWithEnv({})
  const a = { messages: makeSession(6) }
  await hooks['experimental.chat.messages.transform']({}, a)
  const snapshot = JSON.stringify(a.messages)
  await hooks['experimental.chat.messages.transform']({}, a)   // 同一(已清理)输入再跑一遍
  ok('再跑一遍输出逐字节相同(同 ID 同决策)', JSON.stringify(a.messages) === snapshot)
  const b = { messages: makeSession(6) }
  await hooks['experimental.chat.messages.transform']({}, b)   // 同内容新对象:确定性占位符仍逐字节相同
  ok('同内容不同对象结果也逐字节相同(确定性生成)', JSON.stringify(b.messages) === snapshot)
}

// ── ③ 聚合预算:窗口内超线,最老降级、最新不动 ──
{
  const hooks = await loadPluginWithEnv({ BOCOMHERMES_CTX_GUARD_BUDGET: '5000' })
  const output = { messages: makeSession(3, 4000) }   // 3 轮 × 4000+ = 12000+ > 5000
  await hooks['experimental.chat.messages.transform']({}, output)
  const o1 = output.messages[1].parts[0].state.output
  const o3 = output.messages[5].parts[0].state.output
  ok('预算超线:窗口内最老轮被降级', o1.startsWith('[已清理:'))
  ok('预算超线:最新一轮永远不动', o3.includes('-文件3内容'))
}

// ── ④ system.transform:尾部追加、去重、不动原有 ──
{
  const hooks = await loadPluginWithEnv({})
  const output = { system: ['原始系统提示A', '原始系统提示B'] }
  await hooks['experimental.chat.system.transform']({ model: {} }, output)
  ok('纪律块被追加到尾部', output.system.length === 3 && output.system[2].includes('上下文纪律(128k)'))
  ok('原有元素原样未动', output.system[0] === '原始系统提示A' && output.system[1] === '原始系统提示B')
  await hooks['experimental.chat.system.transform']({ model: {} }, output)
  ok('重复调用不重复追加(去重)', output.system.length === 3)
  ok('纪律块含如实汇报与委派纪律', output.system[2].includes('如实汇报') && output.system[2].includes('委派纪律'))
}

// ── ⑤ compacting + autocontinue ──
{
  const hooks = await loadPluginWithEnv({})
  const output = { context: ['原有上下文'], prompt: 'default prompt' }
  await hooks['experimental.session.compacting']({ sessionID: 's1' }, output)
  ok('context 追加五条压缩纪律', output.context.length === 6 && output.context[5].includes('增量更新摘要'))
  ok('prompt 不被替换', output.prompt === 'default prompt')
  const ac = { enabled: false }
  await hooks['experimental.compaction.autocontinue']({}, ac)
  ok('autocontinue 恒置 true', ac.enabled === true)
}

// ── ⑥ chat.params:默认不收口;MAX_OUT>0 钳高保低 ──
{
  const hooks = await loadPluginWithEnv({})
  const p1 = { maxOutputTokens: 8192 }
  await hooks['chat.params']({}, p1)
  ok('默认(MAX_OUT=0)不收口', p1.maxOutputTokens === 8192)
  const hooks2 = await loadPluginWithEnv({ BOCOMHERMES_MAX_OUTPUT_TOKENS: '4096' })
  const p2 = { maxOutputTokens: 8192 }, p3 = { maxOutputTokens: 2048 }, p4 = {}
  await hooks2['chat.params']({}, p2); await hooks2['chat.params']({}, p3); await hooks2['chat.params']({}, p4)
  ok('高于上限被钳低', p2.maxOutputTokens === 4096)
  ok('低于上限不动', p3.maxOutputTokens === 2048)
  ok('缺省值按上限补', p4.maxOutputTokens === 4096)
}

// ── ⑦ 空输出占位符 ──
{
  const hooks = await loadPluginWithEnv({})
  const o1 = { output: '' }, o2 = { output: '   ' }, o3 = { output: '正常内容' }, o4 = { output: '头部若干行\n…(输出过长已外溢:共 500 行,完整内容已存 /tmp/x.txt)' }
  await hooks['tool.execute.after']({ tool: 'read' }, o1)
  await hooks['tool.execute.after']({ tool: 'bash' }, o2)
  await hooks['tool.execute.after']({ tool: 'read' }, o3)
  await hooks['tool.execute.after']({ tool: 'read' }, o4)
  ok('空串 → 占位符', o1.output === '(read completed with no output)')
  ok('纯空白 → 占位符(带工具名)', o2.output === '(bash completed with no output)')
  ok('非空不动', o3.output === '正常内容')
  ok('read-spill 外溢文本(非空)不受影响', o4.output.includes('输出过长已外溢'))
}

// ── ⑧ 异常输入静默放行 ──
{
  const hooks = await loadPluginWithEnv({})
  let threw = false
  try {
    await hooks['experimental.chat.messages.transform'](null, null)
    await hooks['experimental.chat.messages.transform']({}, { messages: null })
    await hooks['experimental.chat.system.transform'](null, { system: 'not-array' })
    await hooks['experimental.session.compacting'](null, null)
    await hooks['chat.params'](null, null)
    await hooks['tool.execute.after'](null, null)
    const off = await loadPluginWithEnv({ BOCOMHERMES_CTX_GUARD: '0' })
    const o = { system: [] }
    await off['experimental.chat.system.transform']({}, o)
    ok('总开关 0 = 全部 no-op', o.system.length === 0)
  } catch { threw = true }
  ok('异常输入静默放行不抛错', !threw)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
