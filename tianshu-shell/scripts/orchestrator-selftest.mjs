// 编排器自测（假 run，不连真模型）。用法： node scripts/orchestrator-selftest.mjs
import orch from '../orchestrator.js'
const { orchestrate, extractJson } = orch

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

// 1) extractJson：剥 <think>、围栏、裸 JSON、垃圾
console.log('extractJson:')
ok(extractJson('<think>想想</think>```json\n{"tasks":[],"done":true}\n```')?.done === true, '剥 <think> + 围栏')
ok(extractJson('废话前缀 {"tasks":[{"goal":"x"}],"done":false} 后缀')?.tasks?.length === 1, '裸 {...} 抽取')
ok(extractJson('完全不是 json') === null, '垃圾返回 null')

// 2) 编排：并发上限 + 依赖顺序 + 重规划 + 汇总
console.log('orchestrate（并发/依赖/重规划）:')
let active = 0, maxActive = 0
const startedAt = {}
const fakeRun = async (prompt, meta) => {
  if (meta.kind === 'plan') {
    if (meta.round === 1) return '<think>规划</think>\n```json\n' + JSON.stringify({
      tasks: [{ id: 'a', role: 'analyst', goal: 'A' }, { id: 'b', role: 'analyst', goal: 'B' }, { id: 'c', role: 'writer', goal: 'C', deps: ['a'] }],
      done: false,
    }) + '\n```'
    return '{"tasks":[],"done":true}'   // round 2: 收尾
  }
  if (meta.kind === 'reduce') return 'FINAL'
  // work
  startedAt[meta.id] = Date.now()
  active++; maxActive = Math.max(maxActive, active)
  await sleep(60)
  active--
  return '产出-' + meta.id
}

const res = await orchestrate('测试目标', { run: fakeRun, maxConcurrency: 2 })
ok(res.tasks.length === 3, '跑了 3 个子任务')
ok(res.tasks.every((t) => t.output.startsWith('产出-')), '每个任务都有产出')
ok(maxActive <= 2, '并发不超过上限(2)，实测峰值=' + maxActive)
ok(startedAt['c'] >= startedAt['a'], 'c 在依赖 a 之后才开始')
ok(res.done === true && res.rounds === 2, '第 2 轮 done 收尾(rounds=' + res.rounds + ')')
ok(res.final === 'FINAL', 'reduce 汇总被调用')

// 3) 依赖死锁不挂死
console.log('死锁安全:')
const stuckRun = async (prompt, meta) => {
  if (meta.kind === 'plan') return meta.round === 1
    ? '{"tasks":[{"id":"x","goal":"X","deps":["不存在"]}],"done":false}'
    : '{"tasks":[],"done":true}'
  if (meta.kind === 'reduce') return 'DONE'
  return 'out'
}
const r2 = await orchestrate('死锁', { run: stuckRun, maxRounds: 2 })
ok(Array.isArray(r2.unmet) && r2.unmet.includes('x'), '未满足依赖被标记为 unmet，未挂死')
ok(r2.final === 'DONE', '仍能走到 reduce')

console.log(`\n小结：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
