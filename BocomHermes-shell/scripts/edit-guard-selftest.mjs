/**
 * edit-guard 插件自测(零依赖,不连真 serve / 真模型)
 *
 * 测什么:
 *   ① read 登记后 edit 放行;② 未读 edit 抛错(文案含"先 read");③ multiedit 同闸
 *   ④ write 新文件放行;⑤ write 已存在且未读过抛错;⑥ write 已存在已读过放行
 *   ⑦ glob/grep 不算"读过"(CC 同口径);⑧ 开关 0 = 全放行;⑨ 会话隔离(别的会话没读过也拦)
 *   ⑩ 插件异常输入静默放行不抛错(非拦停类)
 * 怎么跑: node scripts/edit-guard-selftest.mjs   (npm run editguard:test)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EditGuardPlugin } from '../plugin/edit-guard.js'

let passed = 0, failed = 0
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')) }
}

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-guard-test-'))
const existFile = path.join(TEST_DIR, 'exist.ts').replace(/\\/g, '/')
fs.writeFileSync(existFile, 'export const a = 1\n')

async function load(env) {
  const old = { ...process.env }
  Object.assign(process.env, env)
  const hooks = await EditGuardPlugin()
  process.env = old
  return hooks
}
const read = (h, sid, fp) => h['tool.execute.after']({ tool: 'read', sessionID: sid, args: { filePath: fp } }, { output: 'x' })
const edit = (h, sid, fp) => h['tool.execute.before']({ tool: 'edit', sessionID: sid, args: { filePath: fp, oldString: 'a', newString: 'b' } }, {})
const write = (h, sid, fp) => h['tool.execute.before']({ tool: 'write', sessionID: sid, args: { filePath: fp, content: 'x' } }, {})
const medit = (h, sid, fp) => h['tool.execute.before']({ tool: 'multiedit', sessionID: sid, args: { filePath: fp } }, {})
const threw = async (fn) => { try { await fn(); return null } catch (e) { return e } }

// ①② 未读 edit 拦,读后 edit 放
{
  const h = await load({ BOCOMHERMES_EDIT_GUARD: '1' })
  const e1 = await threw(() => edit(h, 'ses_1', existFile))
  ok('未读 edit 抛错拦截', !!e1 && /edit-guard/.test(e1.message) && /先用 read/.test(e1.message), e1 && e1.message)
  await read(h, 'ses_1', existFile)
  const e2 = await threw(() => edit(h, 'ses_1', existFile))
  ok('read 登记后 edit 放行', !e2, e2 && e2.message)
  // ③ multiedit 同闸
  const e3 = await threw(() => medit(h, 'ses_1', path.join(TEST_DIR, 'other.ts')))
  ok('multiedit 未读同闸拦截', !!e3 && /edit-guard/.test(e3.message))
  // ⑨ 会话隔离
  const e4 = await threw(() => edit(h, 'ses_2', existFile))
  ok('会话隔离:别的会话没读过也拦', !!e4)
}
// ④⑤⑥ write 规则
{
  const h = await load({ BOCOMHERMES_EDIT_GUARD: '1' })
  const newFile = path.join(TEST_DIR, 'brand-new.ts')
  ok('write 新文件放行', !(await threw(() => write(h, 'ses_3', newFile))))
  const e5 = await threw(() => write(h, 'ses_3', existFile))
  ok('write 已存在且未读过抛错', !!e5 && /edit-guard/.test(e5.message))
  await read(h, 'ses_3', existFile)
  ok('write 已存在已读过放行', !(await threw(() => write(h, 'ses_3', existFile))))
}
// ⑦ glob/grep 不算读过
{
  const h = await load({ BOCOMHERMES_EDIT_GUARD: '1' })
  await h['tool.execute.after']({ tool: 'glob', sessionID: 'ses_4', args: { pattern: '*.ts' } }, { output: existFile })
  const e = await threw(() => edit(h, 'ses_4', existFile))
  ok('glob 命中不算"读过"(CC 同口径,只认 read)', !!e && /edit-guard/.test(e.message))
}
// ⑧ 开关 0 = 全放行
{
  const h = await load({ BOCOMHERMES_EDIT_GUARD: '0' })
  ok('开关 0:未读 edit 也放行', !(await threw(() => edit(h, 'ses_5', existFile))))
}
// ⑩ 异常输入静默放行
{
  const h = await load({ BOCOMHERMES_EDIT_GUARD: '1' })
  let pass = true
  try {
    await h['tool.execute.before'](null, {})
    await h['tool.execute.before']({ tool: 'edit' }, {})
    await h['tool.execute.after'](null, {})
  } catch { pass = false }
  ok('异常输入静默放行不抛错(非拦停类)', pass)
}

fs.rmSync(TEST_DIR, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
