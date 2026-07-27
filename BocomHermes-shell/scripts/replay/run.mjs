// 【L1 golden transcript 回放 · 跑批器】零依赖。
// 测什么：跑 scripts/replay/cases/*.case.mjs 的全部用例(每条用例一套 createWorld 世界:
//   真 opencode.js + 真 session.js + 真 window.js + fake serve),输出 ✓/✗ 与失败详情,退出码表成败。
// 怎么跑：npm run replay:test；单跑一条:node scripts/replay/run.mjs 01；看壳层日志:REPLAY_VERBOSE=1。
// 用例契约:cases/*.case.mjs 默认导出 { name, transcript?(同名 .jsonl 文件名 | JSONL 字符串 | 行数组),
//   mode?('manual'|'auto'), timeScale?, settings?, async run(world) }——断言经 harness 的 ok/expectSeq 等
//   直接调(计数全局汇总);run 里 throw = 该用例记一笔 fail 并继续下一条。
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createWorld, assertCounts, resetAsserts, ok } from './harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CASES_DIR = path.join(HERE, 'cases')

async function main() {
  const filter = process.argv[2] || ''
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.case.mjs') && (!filter || f.includes(filter))).sort()
  if (!files.length) { console.log('cases/ 下没有匹配的用例' + (filter ? '(过滤:' + filter + ')' : '')); process.exit(1) }
  let caseFail = 0
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(CASES_DIR, f)).href)
    const def = mod.default || mod
    console.log('\n用例:' + (def.name || f) + '  [' + f + ']')
    resetAsserts()
    // transcript:省略 → 找同名 .jsonl;字符串若以换行/{ 开头按 JSONL 内容,否则按 cases/ 下的文件名
    let transcript = def.transcript
    if (transcript === undefined) {
      const guess = path.join(CASES_DIR, f.replace(/\.case\.mjs$/, '.jsonl'))
      if (fs.existsSync(guess)) transcript = fs.readFileSync(guess, 'utf8')
    } else if (typeof transcript === 'string' && /\.jsonl\s*$/i.test(transcript.trim())) {
      transcript = fs.readFileSync(path.join(CASES_DIR, transcript.trim()), 'utf8')
    }
    let world = null
    try {
      world = await createWorld({ transcript, mode: def.mode, timeScale: def.timeScale, settings: def.settings, quiet: true })
      await def.run(world)
    } catch (e) {
      ok('用例异常中止: ' + (e && e.message || e), false, e && e.stack && String(e.stack).split('\n').slice(0, 4))
    } finally {
      if (world) await world.teardown()
    }
    const c = assertCounts()
    if (c.fail) caseFail++
    console.log('  —— 本用例 ' + c.pass + ' passed, ' + c.fail + ' failed')
  }
  // 全局汇总:任何一条断言失败/用例异常 → 退出码 1
  const total = assertCounts()
  console.log('\n' + (caseFail === 0 ? '✅ 全部用例通过' : '❌ 有失败用例(' + caseFail + ' 条)'))
  process.exit(caseFail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('run.mjs 异常中止:', e); process.exit(1) })
