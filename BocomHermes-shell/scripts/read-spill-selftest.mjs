/**
 * read-spill 插件自测(零依赖,不连真 serve / 真模型)
 *
 * 测什么:
 *   plugin/read-spill.js 的 tool.execute.after 钩子行为——
 *   ① 小输出不拦(原样放行、不落盘)
 *   ② 超阈值输出:完整内容写临时文件 + 钩子输出被替换为「头部 + 摘要 + 路径」
 *   ③ 落盘临时文件内容完整可读(逐字节等于原始输出)
 *   ④ 非目标工具(如 bash)不拦
 *   ⑤ 阈值环境变量(BOCOMHERMES_READ_SPILL_MAX)生效;0 = 关闭
 *   ⑥ metadata.output 快照同步替换 + spillFile 元数据留痕
 * 怎么跑: node scripts/read-spill-selftest.mjs   (npm run readspill:test)
 *
 * 说明:钩子无法离线验证的部分(serve 是否真调用钩子、改动是否进模型上下文)
 * 由端到端验证覆盖,见交付报告;这里通过调用插件入口拿到真实钩子表来驱动,
 * 覆盖的是插件自身的全部逻辑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = path.resolve(import.meta.dirname, '../plugin/read-spill.js')
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'read-spill-test-'))

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
    const hooks = await mod.ReadSpillPlugin({})
    return hooks
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function bigText(lines = 500, lineLen = 40) {
  const arr = []
  for (let i = 1; i <= lines; i++) arr.push(`LINE-${String(i).padStart(4, '0')} ` + 'x'.repeat(lineLen))
  return arr.join('\n')
}

// ── ① 小输出不拦 ──
{
  const hooks = await loadPluginWithEnv({ BOCOMHERMES_READ_SPILL_DIR: TEST_DIR })
  const output = { title: 'read', output: 'short content', metadata: {} }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_1', callID: 'c1' }, output)
  ok('小输出原样放行', output.output === 'short content')
  ok('小输出不落盘', fs.readdirSync(TEST_DIR).length === 0)
}

// ── ② 超阈值:写盘 + 返回摘要 ──
{
  const hooks = await loadPluginWithEnv({ BOCOMHERMES_READ_SPILL_DIR: TEST_DIR })
  const original = bigText(500, 40) // ≈ 23500 字符 > 8000
  const output = { title: 'read', output: original, metadata: {} }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_2', callID: 'c2' }, output)
  ok('超阈值输出被替换为短摘要', output.output.length < 3000)
  ok('摘要保留头部行(前 40 行内)', output.output.startsWith('LINE-0001') && output.output.includes('LINE-0040'))
  ok('摘要不包含头部之后的内容', !output.output.includes('LINE-0041'))
  ok('摘要含总行数/总字符数', output.output.includes('共 500 行') && output.output.includes(`${original.length} 字符`))
  ok('摘要含落盘路径与分段读取提示', output.output.includes(TEST_DIR) && output.output.includes('offset/limit'))
  ok('临时文件已写入', fs.readdirSync(TEST_DIR).some((f) => f.includes('ses_2') && f.includes('c2')))
}

// ── ③ 落盘文件完整可读 ──
{
  const hooks = await loadPluginWithEnv({ BOCOMHERMES_READ_SPILL_DIR: TEST_DIR })
  const original = bigText(300, 60)
  const output = { title: 'read', output: original, metadata: {} }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_3', callID: 'c3' }, output)
  const file = fs.readdirSync(TEST_DIR).find((f) => f.includes('ses_3'))
  const onDisk = fs.readFileSync(path.join(TEST_DIR, file), 'utf8')
  ok('临时文件内容与原始输出逐字节一致', onDisk === original)
  ok('临时文件行数完整', onDisk.split('\n').length === 300)
  ok('metadata 留痕 spillFile 指向落盘文件', output.metadata.spillFile === path.join(TEST_DIR, file))
}

// ── ④ 非目标工具不拦 ──
{
  const hooks = await loadPluginWithEnv({ BOCOMHERMES_READ_SPILL_DIR: TEST_DIR })
  const original = bigText(500, 40)
  const output = { title: 'bash', output: original, metadata: {} }
  await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_4', callID: 'c4' }, output)
  ok('非目标工具(bash)大输出不拦', output.output === original)
  ok('grep 在默认拦截清单内', await (async () => {
    const o = { title: 'grep', output: original, metadata: {} }
    await hooks['tool.execute.after']({ tool: 'grep', sessionID: 'ses_4b', callID: 'c4b' }, o)
    return o.output !== original
  })())
}

// ── ⑤ 阈值可配 + 0 关闭 ──
{
  const hooks = await loadPluginWithEnv({
    BOCOMHERMES_READ_SPILL_DIR: TEST_DIR,
    BOCOMHERMES_READ_SPILL_MAX: '100',
  })
  const text = 'a'.repeat(200) // 200 字符 > 100
  const output = { title: 'read', output: text, metadata: {} }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_5', callID: 'c5' }, output)
  ok('自定义阈值(100)生效', output.output !== text && output.output.includes('共 1 行'))

  const off = await loadPluginWithEnv({
    BOCOMHERMES_READ_SPILL_DIR: TEST_DIR,
    BOCOMHERMES_READ_SPILL_MAX: '0',
  })
  const o2 = { title: 'read', output: bigText(500, 40), metadata: {} }
  await off['tool.execute.after']({ tool: 'read', sessionID: 'ses_5b', callID: 'c5b' }, o2)
  ok('阈值 0 = 插件关闭(大输出也不拦)', o2.output.length > 8000)
}

// ── ⑥ metadata.output 快照同步替换 ──
{
  const hooks = await loadPluginWithEnv({ BOCOMHERMES_READ_SPILL_DIR: TEST_DIR })
  const original = bigText(500, 40)
  const output = { title: 'read', output: original, metadata: { output: original } }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_6', callID: 'c6' }, output)
  ok('metadata.output 快照同步替换', output.metadata.output === output.output && output.metadata.output.length < 3000)
}

// ── ⑦ 异常输入不炸(钩子必须静默放行) ──
{
  const hooks = await loadPluginWithEnv({ BOCOMHERMES_READ_SPILL_DIR: TEST_DIR })
  let threw = false
  try {
    await hooks['tool.execute.after']({ tool: 'read', sessionID: 's', callID: 'c' }, { title: '', output: undefined, metadata: null })
    await hooks['tool.execute.after'](null, null)
  } catch { threw = true }
  ok('异常输入静默放行不抛错', !threw)
}

fs.rmSync(TEST_DIR, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
