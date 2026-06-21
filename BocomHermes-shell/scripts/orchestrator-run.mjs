// 编排器 · 真实联调（对着一个已在跑的 serve）。用法：
//   node scripts/orchestrator-run.mjs "你的目标" [baseURL]
//   默认 baseURL=http://127.0.0.1:4096。先确保 serve 在跑：opencode/bocomcode serve --port 4096
// 注意：会真实多次调用模型；子任务保持小一点以便快速验证。零依赖(内置 fetch)。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { orchestrate } = require('../orchestrator.js')

const GOAL = process.argv[2] || '用三句话分别介绍：什么是单元测试、集成测试、端到端测试。'
const BASE = process.argv[3] || 'http://127.0.0.1:4096'

function pickText(j) {
  const out = []
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (o.type === 'text' && typeof o.text === 'string') out.push(o.text); for (const k in o) walk(o[k]) }
  walk(j)
  return out.map((s) => s.trim()).filter(Boolean).join('\n').trim()
}
async function jpost(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : undefined } catch {}
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${t.slice(0, 160)}`)
  return j
}
const sidOf = (j) => j && (j.id || (j.data && j.data.id) || (j.info && j.info.id))

// 一次 run = 新建一个会话发一条消息（生产里就是 openCodeRunner 干的事）
const run = async (prompt, meta) => {
  const sid = sidOf(await jpost('/session', { title: 'orch:' + (meta.kind || '') }))
  if (!sid) throw new Error('createSession 失败')
  return pickText(await jpost(`/session/${sid}/message`, { parts: [{ type: 'text', text: prompt }] }))
}

console.log('目标:', GOAL)
console.log('serve:', BASE, '\n')
const res = await orchestrate(GOAL, {
  run, maxConcurrency: 2, maxRounds: 3, maxTasks: 8, maxBatch: 4,
  onPlan: (round, plan) => console.log(`\n[规划 第${round}轮] done=${plan.done} 任务=${plan.tasks.map((t) => t.id + '(' + t.role + (t.deps.length ? '←' + t.deps.join(',') : '') + ')').join(' ')}`),
  onTaskStart: (t) => console.log('  ▶ 开始 ' + t.id + '：' + t.goal),
  onTaskDone: (t, out) => console.log('  ✓ 完成 ' + t.id + '（' + out.length + ' 字）'),
  onTaskError: (t, e) => console.log('  ✗ 失败 ' + t.id + '：' + (e && e.message || e)),
})

console.log('\n===== 最终成果 =====\n')
console.log(res.final)
console.log(`\n（轮数 ${res.rounds} · 任务 ${res.tasks.length} · done=${res.done}${res.unmet.length ? ' · 未满足依赖 ' + res.unmet.join(',') : ''}）`)
