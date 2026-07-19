'use strict'
// 容错 JSON 解析：先剥 <think>，再试 ```json 围栏 / 整段 / 第一个 {...}。
// 原属 orchestrator.js(legacy 编排引擎,已退役删除);reqanalysis/reqplan 仍在用,抽成独立小模块。
// 结构化输出实测不可靠 → 一律"提示只输出 JSON + 容错解析 + 重试"。
function extractJson(text) {
  let t = String(text || '')
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<\/?think>/gi, ' ')
  const cands = []
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) cands.push(fence[1])
  cands.push(t)
  const brace = t.match(/\{[\s\S]*\}/); if (brace) cands.push(brace[0])
  for (const c of cands) { try { return JSON.parse(c.trim()) } catch {} }
  return null
}

module.exports = { extractJson }
