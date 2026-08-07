'use strict'
// ══════════════════════════════════════════════════════════════════════════════
// 决策器 · 模型在整套编排里【唯一】出现的地方
//
// 只有两个决策点:plan(拆图)与 replan(每个节点收官后:加片/撤片/收口/问用户)。
// onFail、用户插话、收口全是 replan 的 event 变体 —— 内网弱模型上,提示词模板数 = 出错面,5 段砍成 2 段。
//
// 【三条结构性设计,每条都在解一个具体的坑】
//
// ① headless one-shot,而不是"再开一张 Agent 卡"
//    决策要能在 replay 里完整回放、要能超时掐断、要不累积上下文。开卡就意味着:占并发位、被看门狗盯、
//    被交棒逻辑接管、卡关了决策就丢。这里一次决策 = 建会话 → 发一条 → 拿终答 → 删会话。
//
// ② 【故意不往 S.sessionInfo 里登记这段会话】—— 这是本文件最反直觉、也最重要的一行"没写的代码"
//    session.js 的 onPermission 对查不到 si 的会话一律 reject,而且这个早退【排在 AUTO_ALLOW 之前】。
//    于是决策会话调任何需要审批的工具都会被拒 —— 包括 run_workflow / run_orchestration。
//    别人眼里这是"无头会话没有工具"的缺陷,在这里正好是我们要的【结构性工具防火墙】:
//    决策器只能思考,不能动手,零新代码。真正的 grounding 走 kind:'probe' 的工人节点
//    (真卡、真工具、真沙箱、结论进账本、还能被 replan 撤回),而不是让决策器自己去 grep。
//
// ③ 没有 JSON schema 强约束这回事
//    opencode serve 的 sendMessage body 只有 {parts, agent?, model?, providerID?, modelID?},
//    全仓 grep 不到 response_format / json_schema。所以底座是:
//      窄提示词 → extractJson(平衡括号扫描) → coerce(宽进) → validate(严出) → 同会话窄重问一次 → 四级降级。
//    降级梯的每一级都有确定性动作,绝不"拿不到就默认收口"(那是代码替模型宣布完事,最严重的一种死板)。
//
// 依赖全部注入(oc / S / log / model),测试直接塞假 oc。
// ══════════════════════════════════════════════════════════════════════════════
const SCHEMA = require('./schema')
const RENDER = require('./render')

// 内网弱模型做规划 reasoning 长、且每次决策都是全新会话(无 KV 缓存,全量 prefill 首轮基线)——
// 任何固定预算都会被慢端点打穿(决策留痕 plan(不合法:timeout),连续两次就转人工,把"慢"误判成"不合法")。
// 所以默认【不限时】(0):模型多慢都等完,用户在面板上可随时中止整个 run。想设限用 knobs.orchDecideTimeoutSec(秒,>0 生效)。
const TIMEOUT = { plan: 0, replan: 0 }
// 提示词末行(dbgTriage 生产已验证有效):弱模型很吃这一句
const TAIL = '\n\n只输出 JSON,不要调用任何工具,不要解释,不要用 markdown 代码围栏包裹。'
const RETRY_ASK = '你上次的输出不合法:{ERR}。请只重新输出一个合法 JSON,不要解释。'

function str(x) { return x === null || x === undefined ? '' : String(x) }

/**
 * makeDecider({ oc, S, log, timeoutOf }) → decide(point, ctx) → Promise<result>
 *   result = { ok:true, data, raw } | { ok:false, invalid:'timeout'|'schemaFail'|'transport', errors[], raw }
 *   ctx = { run, event, nodeId, dir, model, survey }
 *     ★ survey(目录量级事实:N 个文件/总字节/顶层分布)由 index.js 用代码算好传进来 ——
 *       不让模型估量级,也就不需要给它工具。规程里那 181 字的"片数演算 + 反例"整块消失。
 *   timeoutOf(point) 返回毫秒;【0/负数 = 不限时】(默认),此时 invalid:'timeout' 不再可能出现。
 */
function makeDecider(deps) {
  const d = deps || {}
  const oc = d.oc
  const S = d.S || {}
  const log = typeof d.log === 'function' ? d.log : () => {}
  const timeoutOf = typeof d.timeoutOf === 'function' ? d.timeoutOf : (p) => (p in TIMEOUT ? TIMEOUT[p] : 0)

  // 渲染签名以 render.js 为准:renderPlan(run, facts) / renderReplan(run, ev)
  // facts = index.js 用代码算出的目录量级事实(N 个文件/总字节/顶层分布)—— 不让模型估量级,
  // 也就不需要给它工具,规程里那 181 字的"片数演算 + 反例"整块消失
  function render(point, ctx) {
    return point === 'plan'
      ? RENDER.renderPlan(ctx.run, ctx.survey, ctx.event)   // event 透传:壳层判定拆窄了、打回重问时,渲染层据此加一段硬约束
      : RENDER.renderReplan(ctx.run, { event: ctx.event, nodeId: ctx.nodeId })
  }

  // 判不合法时把【模型原文】落进日志。
  // ★这是本轮排障最卡的一处:decide 只把 raw 塞进返回值,没人写出来 ——
  //   于是真机报 schemaFail 时,能看到的只有"nodes 是空数组"这类【对解析结果的描述】,
  //   而本文件开头早就写明:思考段里的草稿对象会抢答,报出来的错常常与模型实际干的事毫无关系。
  //   查不到原文 = 每一次 schemaFail 都只能靠猜。原文按行截断落日志,不落盘(存档里已有 decisions 留痕)。
  function dumpRaw(point, why, errors, raw) {
    try {
      const t = str(raw).replace(/\r/g, '')
      const head = t.slice(0, 1200)
      const tail = t.length > 2000 ? '\n…(中间省略 ' + (t.length - 2000) + ' 字)…\n' + t.slice(-800) : ''
      log('[orch-decide] ' + point + ' ' + why + ' —— 模型原文(' + t.length + ' 字):\n' + head + tail)
    } catch { /* 排障用的东西不许把主流程带崩 */ }
  }

  async function ask(serve, sid, text, model, ms) {
    if (!(ms > 0)) return oc.sendMessage(serve, sid, text, model)   // 默认不限时:慢模型等到底,面板可中止
    let timer = null
    try {
      return await Promise.race([
        oc.sendMessage(serve, sid, text, model),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  // 缺口覆盖上下文:交给 schema.validate 判"模型说 done 的时候有没有把账认全"
  function coverageCtx(c) {
    const run = (c && c.run) || {}
    const gaps = ((run.ledger || {}).gaps || []).map((g) => (g && g.text) || String(g || '')).filter(Boolean)
    const unverified = ((run.nodes) || [])
      .filter((n) => n && (n.result || {}).unverified)
      .map((n) => n.id)
    return { gaps, unverified }
  }

  return async function decide(point, ctx) {
    const c = ctx || {}
    const dir = str(c.dir)
    const model = c.model || null
    const ms = timeoutOf(point)
    let serve = null, sid = ''
    try {
      serve = await oc.ensureServe(dir, S.handlers, log)
      sid = await oc.createSession(serve, '编排决策·' + point, dir, (S.settings && S.settings.orchDecideAgent) || undefined)
      if (!sid) return { ok: false, invalid: 'transport', errors: ['createSession 没返回会话 id'] }
      // ★ 这里【不写】S.sessionInfo.set(sid, ...) —— 见文件头 ②,是刻意的工具防火墙,别"顺手补上"

      let raw = await ask(serve, sid, render(point, c) + TAIL, model, ms)
      // ctx 必须传:validate 的 done:true 分支要靠它做【缺口覆盖硬校验】——
      // final.gaps 得逐条覆盖账本里的 gaps 与"没有验证证据的节点"。不传 ctx 这条校验恒空过,
      // 于是"代码保证信息不丢、动作权归模型"就只剩一句口号(死代码,真跑也看不出来)。
      const vctx = coverageCtx(c)
      let obj = SCHEMA.coerce(point, SCHEMA.extractJson(raw, point))
      let v = SCHEMA.validate(point, obj, vctx)
      if (!v.ok) {
        // 降级第 2 级:同会话窄重问一次 —— 上下文还在,是最便宜的纠错通道(比重开一段会话准得多)
        log('[orch-decide] ' + point + ' 首答不合法,同会话重问一次:' + v.errors.slice(0, 2).join(';'))
        dumpRaw(point, '首答不合法', v.errors, raw)
        raw = await ask(serve, sid, RETRY_ASK.replace('{ERR}', v.errors.join(';')) + TAIL, model, ms)
        obj = SCHEMA.coerce(point, SCHEMA.extractJson(raw, point))
        v = SCHEMA.validate(point, obj, vctx)
      }
      if (v.ok) return { ok: true, data: obj, raw: str(raw).slice(0, 4000) }
      log('[orch-decide] ' + point + ' 重问后仍不合法:' + v.errors.slice(0, 3).join(';'))
      dumpRaw(point, '重问后仍不合法', v.errors, raw)
      return { ok: false, invalid: 'schemaFail', errors: v.errors, raw: str(raw).slice(0, 4000) }
    } catch (e) {
      const why = /timeout/i.test(str(e && e.message)) ? 'timeout' : 'transport'
      // 超时必须 abort:不掐掉的话那个回合还在 serve 上跑,占着并发、烧着 token,而我们已经不要它的答案了
      // (旧的 dbgTriage 有 race 没 abort,在飞请求就那么泄漏着 —— 这里补上)
      if (serve && sid) { try { await oc.abort(serve, sid) } catch { /* 已经没了就算了 */ } }
      log('[orch-decide] ' + point + ' ' + why + ':' + str(e && e.message))
      return { ok: false, invalid: why, errors: [str(e && e.message)] }
    } finally {
      // 会话即用即删:一次编排会做几十次决策,不删会在 serve 上堆出几十段死会话
      if (serve && sid && typeof oc.deleteSession === 'function') {
        try { await oc.deleteSession(serve, sid) } catch { /* 删不掉不影响正确性 */ }
      }
    }
  }
}

module.exports = { makeDecider, TIMEOUT, TAIL }
