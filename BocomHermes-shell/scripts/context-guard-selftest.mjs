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
 *   ⑨ 读图后历史净化:后面有 assistant 文本结论的图片 part → 文本占位(保留 id);
 *      最后一条(还没结论)不动;非图片 file 不动;幂等逐字节稳定;结论被压缩掉也不还原;
 *      BOCOMHERMES_CTX_GUARD_IMG_PURGE=0 关闭
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
  ok('纪律块被追加到尾部', output.system.length === 3 && output.system[2].includes('上下文纪律(192k)'))
  ok('原有元素原样未动', output.system[0] === '原始系统提示A' && output.system[1] === '原始系统提示B')
  await hooks['experimental.chat.system.transform']({ model: {} }, output)
  ok('重复调用不重复追加(去重)', output.system.length === 3)
  ok('纪律块含如实汇报与委派纪律', output.system[2].includes('如实汇报') && output.system[2].includes('委派纪律'))
  const hooks96 = await loadPluginWithEnv({ BOCOMHERMES_CTX_LIMIT_K: '96' })
  const o96 = { system: [] }
  await hooks96['experimental.chat.system.transform']({ model: {} }, o96)
  ok('口径环境变量生效(BOCOMHERMES_CTX_LIMIT_K=96)', o96.system[0] && o96.system[0].includes('上下文纪律(96k)'))
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

// ── ⑨ 读图后历史净化 ──
{
  // u1:文本+已读图片(img1) → a1:结论文本;u2:文本+未读图片(img2)+非图片附件(doc1)
  const mk = () => ([
    { info: { id: 'u1', role: 'user' }, parts: [
      { id: 't1', type: 'text', text: '看这个截图' },
      { id: 'img1', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAA' },
      { id: 'img3', type: 'image', image: '/9j/4AAQSkZJRg==' },
    ] },
    { info: { id: 'a1', role: 'assistant' }, parts: [{ id: 'at1', type: 'text', text: '截图里是登录页,按钮正常。' }] },
    { info: { id: 'u2', role: 'user' }, parts: [
      { id: 't2', type: 'text', text: '再看这张' },
      { id: 'img2', type: 'file', mime: 'image/png', url: 'data:image/png;base64,BBB' },
      { id: 'doc1', type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,CCC' },
    ] },
  ])
  const hooks = await loadPluginWithEnv({})
  const output = { messages: mk() }
  await hooks['experimental.chat.messages.transform']({}, output)
  const img1 = output.messages[0].parts[1]
  ok('① 已读图片(file+mime image/*)被替换为占位且保留 id',
    img1.type === 'text' && img1.text === '[图片已读:结论见下文]' && img1.id === 'img1' && !('url' in img1))
  const img3 = output.messages[0].parts[2]
  ok("①b type==='image' 形状同样被替换(保留 id)", img3.type === 'text' && img3.text === '[图片已读:结论见下文]' && img3.id === 'img3')
  const img2 = output.messages[2].parts[1]
  ok('② 历史最后的图片(后面没有 assistant 文本)不替换', img2.type === 'file' && img2.mime === 'image/png' && img2.url.startsWith('data:image/png'))
  const doc1 = output.messages[2].parts[2]
  ok('④ 非图片 file part(mime=text/plain)不替换', doc1.type === 'file' && doc1.mime === 'text/plain' && doc1.url.startsWith('data:text/plain'))
  const snapshot = JSON.stringify(output.messages)
  await hooks['experimental.chat.messages.transform']({}, output)   // 已净化结果再跑一遍
  ok('③ 再跑一遍输出逐字节相同(幂等)', JSON.stringify(output.messages) === snapshot)
  const fresh = { messages: mk() }
  await hooks['experimental.chat.messages.transform']({}, fresh)   // 同内容新对象走决策记忆
  ok('③b 同内容新对象结果也逐字节相同(同 ID 同决策)', JSON.stringify(fresh.messages) === snapshot)
  // 压缩后 assistant 结论消失:已净化的图片绝不还原
  const compacted = { messages: [mk()[0], mk()[2]] }   // u1(img1/img3) + u2,a1 结论没了
  await hooks['experimental.chat.messages.transform']({}, compacted)
  ok('⑨b 结论被压缩掉后已净化图片不还原', compacted.messages[0].parts[1].type === 'text' && compacted.messages[0].parts[1].text === '[图片已读:结论见下文]')
  const off = await loadPluginWithEnv({ BOCOMHERMES_CTX_GUARD_IMG_PURGE: '0' })
  const o2 = { messages: mk() }
  await off['experimental.chat.messages.transform']({}, o2)
  ok('⑤ BOCOMHERMES_CTX_GUARD_IMG_PURGE=0 关闭净化', o2.messages[0].parts[1].type === 'file' && o2.messages[0].parts[2].type === 'image')
}

// ── ⑥ 短会话(user 消息数 < keepTurns)一条都不许清 ★真跑实锤的回归护栏 ──
// 病灶:轮次边界原来在"不足 N 轮"时写 keepFrom = msgs.length,而清理判据是 `i < keepFrom` ——
// 对每一条都成立,于是【全部】工具结果被清光,意思正好是注释的反面。
// 命中面最狠的是编排工人卡/子 Agent:它们整个生命周期只有 1 条 user 消息(那份 brief),
// 于是从第一次工具调用起就什么都看不见 → 换工具 → 写脚本 → 派子 Agent → 调 run_workflow 开新卡
// (真跑时一口气冒出 6 张脱离编排的卡)。普通对话的前两轮同样中招。
// 老用例全用 ≥3 轮的会话,所以这个 bug 一直没被抓到 —— 这里专测短会话。
{
  const p = await loadPluginWithEnv({})
  for (const turns of [1, 2]) {
    const output = { messages: makeSession(turns, 3000) }
    await p['experimental.chat.messages.transform']({}, output)
    const cleaned = output.messages.filter((m) => m.parts.some((x) => x.type === 'tool' && String(x.state.output).startsWith('[已清理:')))
    ok('★' + turns + ' 轮会话(不足 keepTurns):工具结果一条都不清', cleaned.length === 0)
    ok('  ' + turns + ' 轮会话:内容原样可见', output.messages[1].parts[0].state.output.includes('-文件1内容'))
  }
  // 单 user + 多条 assistant(工人卡的真实形状:一份 brief,之后没人再说话)
  const worker = {
    messages: [
      { info: { id: 'u1', role: 'user' }, parts: [{ id: 'ut1', type: 'text', text: '【总目标】…' }] },
      { info: { id: 'a1', role: 'assistant' }, parts: [{ id: 'w1', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/a.md' }, output: 'A'.repeat(4747) } }] },
      { info: { id: 'a2', role: 'assistant' }, parts: [{ id: 'w2', type: 'tool', tool: 'glob', state: { status: 'completed', input: {}, output: 'B'.repeat(6014) } }] },
      { info: { id: 'a3', role: 'assistant' }, parts: [{ id: 'w3', type: 'tool', tool: 'bash', state: { status: 'completed', input: {}, output: 'C'.repeat(7972) } }] },
    ],
  }
  await p['experimental.chat.messages.transform']({}, worker)
  const survived = worker.messages.slice(1).every((m) => !String(m.parts[0].state.output).startsWith('[已清理:'))
  ok('★工人卡形状(1 条 user + 多轮工具):结果全部保留', survived)
  ok('  工人卡:总量 18k 未触发预算降级(预算 40k)', worker.messages[1].parts[0].state.output.length === 4747)

  // ★同样是工人卡形状,但总量【超】预算 —— 聚合预算必须真的开始降级。
  // 病灶:降级循环的上界写的是 lastUserIdx(最后一条 user 的下标),意思是"本轮永远不动"。
  // 工人卡一辈子只有 1 条 user 消息(下标 0)→ 上界 0 → `i < 0` 一次都不进,预算对它彻底失效;
  // 而工人卡恰恰是几十次工具调用、最容易撑爆上下文的那一类。普通对话里一个超长回合同理被整轮豁免。
  // 上界改成 max(lastUserIdx, msgs.length - PROTECT_TAIL) 后:老的照降,最新 8 条照样安全。
  const bigWorker = { messages: [{ info: { id: 'u1', role: 'user' }, parts: [{ id: 'ut1', type: 'text', text: '【总目标】…' }] }] }
  for (let i = 0; i < 20; i++) {
    bigWorker.messages.push({
      info: { id: 'a' + i, role: 'assistant' },
      parts: [{ id: 'bw' + i, type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/f' + i + '.md' }, output: 'X'.repeat(5000) } }],
    })
  }
  const totalBefore = bigWorker.messages.slice(1).reduce((n, m) => n + m.parts[0].state.output.length, 0)   // 100k > 40k 预算
  await p['experimental.chat.messages.transform']({}, bigWorker)
  const isClean = (m) => String(m.parts[0].state.output).startsWith('[已清理:')
  const totalAfter = bigWorker.messages.slice(1).reduce((n, m) => n + m.parts[0].state.output.length, 0)
  ok('★工人卡超预算(100k > 40k):聚合预算真的降级了(旧代码一条都不降)', totalAfter < totalBefore, { totalBefore, totalAfter })
  ok('  最新 8 条消息受保护(模型当下在推理的那批结果不动)', bigWorker.messages.slice(-8).every((m) => !isClean(m)))
  ok('  从最老开始降(第一条工具结果先被清)', isClean(bigWorker.messages[1]))
  // 保护尾本身就有 8×5000=40k,正好顶着预算线 —— 所以这一档降不到线下是对的,能降的都降了即可
  ok('  保护尾之外的全部降级(尽力而为:尾部撑满预算时降不到线下也不再硬砍)',
    bigWorker.messages.slice(1, -8).every(isClean), totalAfter)

  // 够了就停:预算放宽到 80k,只需砍掉 4 条就够 → 非尾部里应当仍有大量原样保留的,不能一刀切全清
  const p80 = await loadPluginWithEnv({ BOCOMHERMES_CTX_GUARD_BUDGET: '80000' })
  const w80 = { messages: [{ info: { id: 'u1', role: 'user' }, parts: [{ id: 'ut1', type: 'text', text: '【总目标】…' }] }] }
  for (let i = 0; i < 20; i++) {
    w80.messages.push({
      info: { id: 'a' + i, role: 'assistant' },
      parts: [{ id: 'q' + i, type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/g' + i + '.md' }, output: 'Y'.repeat(5000) } }],
    })
  }
  await p80['experimental.chat.messages.transform']({}, w80)
  const after80 = w80.messages.slice(1).reduce((n, m) => n + m.parts[0].state.output.length, 0)
  const cleaned80 = w80.messages.slice(1).filter(isClean).length
  ok('  够了就停:预算 80k 只降到刚过线,不是一刀切', after80 <= 80000 && cleaned80 >= 4 && cleaned80 <= 6, { after80, cleaned80 })
  ok('  停手后中段仍有原样保留的结果', w80.messages.slice(1, -8).some((m) => !isClean(m)))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
