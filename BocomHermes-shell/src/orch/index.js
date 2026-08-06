'use strict'
// ══════════════════════════════════════════════════════════════════════════════
// 编排装配层 · 全案【唯一】允许碰 Electron / S / fs / 时钟的文件
//
// run.js 是纯状态机:它只返回"意图"(effects),自己不做任何 IO。本文件把这些意图变成真事,
// 并把执行结果作为【新事件】回灌 applyEvent。这条回灌闭环是整个设计的关键 ——
// 状态机永远不知道"外面"发生了什么,它只认事件;于是它才能被 replay 逐行断言。
//
// 【它取代了什么】
// 老的"LLM 主控卡"已整体删除:那版把编排控制流序列化成中文塞进一张会说话的卡(6.5k 常驻规程),
// 再指望模型把壳层已经知道的账(派了几片、齐没齐、第几轮、缺哪些签名)重记一遍,
// 于是围绕它长出十几道兜底闸去纠正它。现在编排是代码持有的状态机,模型只在 plan/replan 两点做判断。
//
// 【面板卡仍是一张注册在案的 orch 卡】
// 看起来多余,其实是硬需求:mirrorToOrch(分片会话镜像回流)第一行就是
// `const oreg = S.wfRegistry.get(String(oref.id)); if (!oreg) return`,
// card-cleanup 的级联杀看 `wfCardByWc.get(wcId).kind==='orch'`,session.js 的 shardSnapshot 同理。
// 面板卡不进这三张表,分片镜像会当场变空、关面板不再杀工人。所以它照常建卡、照常建一段会话 ——
// 只是那段会话【永远不发消息】(编排不再是"跟一个 Agent 聊天")。
//
// 【计时器探活】轮末静默到点 ≠ 落定:doArm 到点先查工人是否还真活着(卡在启动/有回合在飞/卡片忙/
// 静默窗内内容还在动),活着就续命一轮 —— 内网慢端点轮间空隙常超 45s,把"慢"误判成"干完了"会按
// 空磁盘 evalExit 出 artifacts/noEmpty 零产出,错杀慢工。窗口旋钮 = knobs.orchSilentSec(默认 45s);
// 续命上限由 stall(15min)与 30min 挂死看门狗收,探活只管"别冤枉慢"。
// ══════════════════════════════════════════════════════════════════════════════
const path = require('path')
const fs = require('fs')
const RUN = require('./run')
const NODES = require('./nodes')
const RENDER = require('./render')
const { makeJournal } = require('./journal')
const SHAPE = require('./shapes')   // 只用它的发现归一/去重(结构化上报要在进状态机之前就把噪音滤掉)

const SURVEY_MAX_FILES = 4000
const SURVEY_SKIP = /^(node_modules|\.git|dist|build|out|coverage|\.next|\.venv|__pycache__|target|vendor|\.idea|\.vscode)$/i
const SURVEY_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|vue|py|java|go|rs|rb|php|cs|c|h|cpp|hpp|kt|swift|sql|json|md|ya?ml|html?|css|less|scss)$/i
const CMD_TIMEOUT_MS = 120000
const CMD_MAXBUF = 8 * 1024 * 1024

function str(x) { return x === null || x === undefined ? '' : String(x) }
function arr(x) { return Array.isArray(x) ? x : [] }
function num(x) { const n = +x; return Number.isFinite(n) ? n : 0 }

/**
 * makeOrch(deps) → S.orch
 * deps: { S, oc, log, app, spawnCard, spawnWorkflow, wcById, BrowserWindow, Notification, decide }
 *   decide 可注入假实现(replay 用 fakeDecide),这是 decide.js 接口设计的第一约束
 */
function makeOrch(deps) {
  const d = deps || {}
  const { S, oc, log, app, spawnCard, spawnWorkflow, wcById, BrowserWindow } = d
  const decide = d.decide
  const journal = makeJournal({ dir: path.join(app.getPath('userData'), 'orch-runs'), log })

  const runs = new Map()        // runId → run(内存主副本;journal 是它的持久投影)
  const timers = new Map()      // effect.key → timeout
  const cardToNode = new Map()  // cardId(String) → { runId, nodeId }
  let seq = 0
  const mkId = (p) => str(p) + (++seq)

  // ── 事件入口:所有状态变化都从这里进 ────────────────────────────────────
  function send(runId, ev) {
    const run = runs.get(str(runId))
    if (!run) return null
    let out
    // capHint = 全局并发余量。状态机自己只知道 run 内并发,不知道别的卡(单工作流/pipeline/别的 run)占了多少位;
    // 不给它这个数,它会把节点置 running 后才在 doDispatch 撞上全局闸,然后那个节点就成了"running 却没有卡"的死节点。
    try { out = RUN.applyEvent(run, Object.assign({ at: Date.now() }, ev), { mkId, capHint: globalCap() }) }
    catch (e) { log('[orch] applyEvent 抛错(' + str(ev && ev.type) + '):' + (e && e.stack || e)); return null }
    runs.set(run.id, out.run)
    // ★每一次状态转移打一行 —— 这不是调试残留,是这套无人值守系统的【唯一可观测面】。
    //   实测教训:一次真跑跑了半小时,整份日志只有一行"[orch] run 创建",节点卡死 11 分钟无从查起,
    //   最后只能去 serve 拉会话原文 + 手读 run.json 才定位。编排是后台跑的,没有日志 = 出了事只能靠猜。
    //   只在真的变了时打(applyEvent 无变化时 effects 为空),空转的 tick 不刷屏。
    if (out.effects.length) {
      const before = run, after = out.run
      const bits = []
      if (before.phase !== after.phase) bits.push('phase ' + before.phase + '→' + after.phase)
      for (const n of after.nodes) {
        const o = arr(before.nodes).find((x) => x.id === n.id)
        if (!o) { bits.push('+' + n.id + '(' + n.kind + ')'); continue }
        if (o.state !== n.state) bits.push(n.id + ' ' + o.state + '→' + n.state + (n.reason ? '(' + n.reason + ')' : ''))
        if (o.attempt !== n.attempt) bits.push(n.id + ' 重做#' + n.attempt)
        if (num(o.patches) !== num(n.patches)) bits.push(n.id + ' 补做#' + num(n.patches))
      }
      const fx = out.effects.filter((e) => e.type !== 'persist' && e.type !== 'ui').map((e) => e.type + (e.nodeId ? ':' + e.nodeId : '')).join(' ')
      if (bits.length || fx) log('[orch] ' + run.id + ' ' + str(ev.type) + (bits.length ? ' | ' + bits.join(', ') : '') + (fx ? ' | fx: ' + fx : ''))
    }
    execAll(out.run, out.effects)
    return out.run
  }

  function execAll(run, effects) {
    for (const fx of arr(effects)) {
      try { exec(run, fx) } catch (e) { log('[orch] effect ' + str(fx && fx.type) + ' 执行失败:' + (e && e.message)) }
    }
  }

  // ── effects 执行 ───────────────────────────────────────────────────────
  function exec(run, fx) {
    switch (str(fx.type)) {
      case 'dispatch': return doDispatch(run, fx)
      case 'patchNode': return doPatch(run, fx)
      case 'cancelNode': return doCancel(run, fx)
      case 'decide': return doDecide(run, fx)
      case 'evalExit': return doEvalExit(run, fx)
      case 'armTimer': return doArm(run, fx)
      case 'clearTimer': return doClear(fx)
      case 'persist': return journal.save(run)
      case 'ui': return pushUi(run)
      case 'notify': return doNotify(run, fx)
      case 'archive': return doArchive(run)
      default: return undefined
    }
  }

  // 这一片该用哪个模型。核实/检查节点是【一两个回合就完】的活(顺着一条证据走一遍、跑一条命令看结果),
  // 而在一次排查里它们往往占一半以上的节点数 —— 全用主模型是纯浪费,内网上还直接翻倍墙钟时间。
  // 【留空即无变化】没配轻活模型的人拿到的还是 run.model,行为与加这个字段之前逐字节相同。
  // 只给 verify/check:probe 要读代码做判断、reduce 要跨片对齐取舍,那两类降档会真的降质量。
  function modelFor(run, n) {
    const k = str(n && n.kind)
    if (k === 'verify' || k === 'check') {
      const light = S.settings && S.settings.modelLight
      if (light && light.modelID) return light
    }
    return run.model || null
  }

  // 派发一个节点 = 开一张工人卡(完全复用现有 spawnWorkflow:隐藏卡 / 写归属沙箱 / 权限自动放行 / 镜像回流全不动)
  function doDispatch(run, fx) {
    const n = findNode(run, fx.nodeId); if (!n) return
    const brief = RENDER.composeNodeBrief(run, n) || n.goal
    n.brief = brief
    const r = spawnWorkflow(brief, modelFor(run, n), {
      runId: run.id, nodeId: n.id,
      dir: str(run.dir) || undefined,   // ★工作目录跟着这个 run 走:spawnWorkflow 原来无条件读 S.settings.projectDir,
                                        //   两个 run 同时跑就会串台(路径与系统提示词一起串,实测)
      backendDir: str(run.backendDir) || undefined,
      title: n.title,                   // 展示名:卡标题 / reg.goal / 分片 chip 用它,不用整段 brief
      // verify 节点没写归属时【代码强制】只读沙箱:session.js 的写归属硬闸口径是"空 = 不设闸",
      // 模型漏写 writeScope 的验证节点就能改项目文件 —— 这是安全退化,不能指望模型自觉
      writeScope: (n.kind === 'verify' && !arr(n.writeScope).length)
        ? [require('os').tmpdir().replace(/\\/g, '/')]
        : arr(n.writeScope),
      contract: arr(n.contract),
      isVerify: n.kind === 'verify',
      alias: run.alias,                 // 兼容垫片:让 pushShardProgress / ShardPanel 照旧认得这一片
    })
    // spawnWorkflow 统一返回 { ok, id, queued, position };排队时 id 为空,节点留在 queued 等下一次 tick
    if (r && r.queued) { log('[orch] ' + n.id + ' 并发满,排队第 ' + r.position + ' 位'); return }
    const cardId = r && r.id != null ? String(r.id) : ''
    if (!cardId) { send(run.id, { type: 'WORKER_CARD_GONE', nodeId: n.id }); return }
    cardToNode.set(cardId, { runId: run.id, nodeId: n.id })
    send(run.id, { type: 'NODE_DISPATCHED', nodeId: n.id, cardId, wcId: regWcId(cardId) })
  }

  // 补做:不重开卡,直接给那张【还活着的】工人卡喂一条"缺这几项"的消息 —— 它的上下文还在
  function doPatch(run, fx) {
    const n = findNode(run, fx.nodeId); if (!n || !n.cardId) return
    const wc = wcById(n.wcId)
    if (!wc) { send(run.id, { type: 'WORKER_CARD_GONE', nodeId: n.id }); return }
    const miss = arr(fx.missing).map((m) => '· ' + str(m.kind) + ':' + str(m.detail)).join('\n')
    const text = '<编排·补做>你上一轮的产出没通过退出检查,差这几项(第 ' + fx.patch + ' 次补做):\n' + miss
      + '\n\n只补这几项,别重做已经做对的部分;补完照原样回报。</编排·补做>'
    try { wc.send('card-inject', { text, disp: '编排要求补做:' + arr(fx.missing).map((m) => str(m.kind)).join('、'), origin: 'orch' }) }
    catch (e) { log('[orch] 补做注入失败:' + e.message) }
  }

  function doCancel(run, fx) {
    const n = findNode(run, fx.nodeId); if (!n) return
    const wcId = n.wcId
    if (wcId != null) {
      try {
        if (S.isCardBusy && S.isCardBusy(wcId)) { /* 正在收尾就别杀,45s 静默计时会兜住 */ }
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.id === wcId)
        if (w) { (S.shardForceClose = S.shardForceClose || new Set()).add(wcId); w.close() }
      } catch (e) { log('[orch] 关工人卡失败:' + e.message) }
    }
    if (n.cardId) cardToNode.delete(String(n.cardId))
  }

  // 决策是异步 effect:结果作为【新事件】回灌,tick 不被它阻塞(一次卡住的 replan 不冻结整个 run)
  function doDecide(run, fx) {
    if (typeof decide !== 'function') { send(run.id, { type: 'DECIDED', decisionId: fx.decisionId, point: fx.point, ok: false, invalid: '没有装配决策器' }); return }
    const ctx = {
      run, event: str(fx.event), nodeId: str(fx.nodeId),
      dir: run.dir, model: run.model || null,
      survey: fx.point === 'plan' ? surveyDir(run.dir) : null,
    }
    Promise.resolve(decide(fx.point, ctx)).then((res) => {
      send(run.id, {
        type: 'DECIDED', decisionId: fx.decisionId, point: fx.point,
        ok: !!(res && res.ok), data: (res && res.data) || {},
        invalid: (res && res.invalid) || '', errors: (res && res.errors) || [], raw: (res && res.raw) || '',
      })
    }).catch((e) => {
      send(run.id, { type: 'DECIDED', decisionId: fx.decisionId, point: fx.point, ok: false, invalid: 'transport', errors: [str(e && e.message)] })
    })
  }

  // 退出检查:要读盘、要跑命令,所以住在这里而不是 run.js
  function doEvalExit(run, fx) {
    doEvalExitAsync(run, fx).catch((e) => log('[orch] evalExit 执行异常:' + (e && e.stack || e)))
  }
  // 零产出回填(2026-08-04,实测:内网慢模型"壳层先判 zero-output,模型随后才答完"):
  // 终答收集挂在回合正常收尾上(session.js wfTurnDone);回合一旦报错/超时,流式明明吐过字、reg.final 却是空的。
  // evalExit 是判零产出的【最后责任点】:判之前回 serve 拉一次会话原文(最后一个 user 之后的全部 assistant 文本,
  // 与 session.js 轮末取终答同口径),拉到就回填进事件 —— 不冤枉慢模型;拉不到(真没产出)照常判。
  async function backfillFinal(run, n) {
    // ★这里原来写的是 `if (!n.sid ...)`,而 n.sid 在生产里【恒为 null】——
    //   唯一能写它的事件是 NODE_DISPATCHED,而它的唯一生产发射点(doDispatch)只带 {nodeId, cardId, wcId},
    //   没有 sid(派卡那一刻卡还没绑会话)。只有 orch-selftest 手写事件时才会带,所以测试一直是绿的。
    //   净效果:这道"判零产出前回 serve 拉会话原文"的最后责任点,真机上一次都没跑过 ——
    //   4243cb5 声称修好的"慢模型晚收官不判零产出",实际从未生效。
    //   隔壁 silentAlive 早就发现并从 S.sessionByWc 补了,但只补了它自己那一处(见 sidOf 的注释)。
    const sid = sidOf(n)
    if (!sid || !oc || typeof oc.getMessages !== 'function') return ''
    try {
      const si = S.sessionInfo && S.sessionInfo.get(sid)
      const serve = (si && si.serve) || (run.dir && typeof oc.ensureServe === 'function' ? await oc.ensureServe(run.dir, S.handlers, log) : null)
      if (!serve) return ''
      const msgs = await oc.getMessages(serve, sid)
      let lastU = -1; arr(msgs).forEach((m, i) => { if (m && m.role === 'user') lastU = i })
      const t = arr(msgs).slice(lastU + 1).filter((m) => m && m.role === 'assistant' && m.text).map((m) => str(m.text)).join('\n').trim()
      if (t) {
        log('[orch] evalExit 回填终答 ' + t.length + ' 字 → ' + n.id + '(慢模型晚收官,不判零产出)')
        try {   // 注册表同步:存档/卡坞/legacy 兜底读的 reg.final 也不落空
          const reg = n.cardId && S.wfRegistry && S.wfRegistry.get(String(n.cardId))
          if (reg && !str(reg.final).trim()) reg.final = t
        } catch {}
      }
      return t
    } catch (e) { log('[orch] evalExit 回填终答失败(' + n.id + '):' + str(e && e.message)); return '' }
  }
  async function doEvalExitAsync(run, fx) {
    const n = findNode(run, fx.nodeId); if (!n) return
    const base = run.dir || (S.settings && S.settings.projectDir) || '.'
    let backfilled = ''
    let evalNode = n
    if (!str(n.result && n.result.final).trim() && !arr(n.result && n.result.files).length) {
      backfilled = await backfillFinal(run, n)
      if (backfilled) evalNode = Object.assign({}, n, { result: Object.assign({}, n.result, { final: backfilled }) })
    }
    const probe = {
      statSync: (p) => fs.statSync(path.resolve(base, p)),
      readFileSync: (p) => fs.readFileSync(path.resolve(base, p), 'utf8'),
      readDirDeep: (p) => readDirDeep(path.resolve(base, p)),
      exec: (cmd) => runCmd(cmd, base),
      // 执行流水(bash 命令轨 + 浏览器动作轨)—— 证据闸的唯一原料。
      // session.js 的 S.wfAction 一直在往 reg.actions 里写,但 evalExit 只认
      // res.actions / n.actions / p.actions(n) 三条路,原来三条都没供 →
      // requireEvidence:true 的节点【永远过不了闸】,unverified 恒 true(真跑才会暴露)。
      actions: (nn) => { try { return arr((S.wfRegistry && S.wfRegistry.get(String(nn && nn.cardId))) ? S.wfRegistry.get(String(nn.cardId)).actions : []) } catch { return [] } },
      // reduce 实质性闸的原料:上游各片声明的产出路径 + 读汇总正文。
      // 判"汇总有没有真读上游"靠的是它有没有引用这些路径 —— 没读过就写不出来。
      readText: (p2) => { try { return fs.readFileSync(path.resolve(base, p2), 'utf8').slice(0, 200000) } catch { return '' } },
      upstreamArtifacts: (() => {
        try {
          const deps = arr(n.deps).map(String)
          const out2 = []
          for (const d of deps) {
            const dn = arr(run.nodes).find((x) => String(x.id) === d)
            for (const a2 of arr(dn && dn.exit && dn.exit.artifacts)) if (a2 && out2.indexOf(String(a2)) < 0) out2.push(String(a2))
          }
          return out2
        } catch { return [] }
      })(),
    }
    let out
    try { out = NODES.evalExit(evalNode, probe) }
    catch (e) { log('[orch] evalExit 抛错:' + e.message); out = { pass: false, report: [{ kind: 'noEmpty', ok: false, detail: '退出检查执行失败:' + e.message }] } }
    const bad = arr(out && out.report).filter((x) => x && !x.ok)
    log('[orch] ' + run.id + ' evalExit ' + n.id + ' → ' + (out && out.pass ? 'PASS' : 'FAIL')
      + (bad.length ? ' 未过: ' + bad.map((x) => str(x.kind) + '(' + str(x.detail).slice(0, 60) + ')').join('; ') : ''))
    send(run.id, {
      type: 'EXIT_RESULT', nodeId: n.id,
      pass: !!(out && out.pass), report: arr(out && out.report),
      verdict: str(out && out.verdict), cmdExit: (out && out.cmdExit != null) ? out.cmdExit : null,
      contractMiss: arr(out && out.contractMiss), unverified: !!(out && out.unverified),
      final: backfilled,   // 回填的终答(run.js 只补空缺):零产出判定以会话原文为准,不看回合收尾成没成功
    })
  }

  // ── 静默到点探活(只探不判)──────────────────────────────────────────────
  // 轮末静默到点 ≠ 落定。内网慢端点的轮间空隙(网关排队/prefill/serve 冷启动)常超 45s,
  // 把"慢"误判成"干完了",就会按空磁盘 evalExit 出 artifacts/noEmpty 零产出 → 错杀慢工、开新卡重烧。
  // 所以 silent 计时器到点先查工人是否还真活着:活着 → 续命一轮;真静了 → 放行 TIMER 给状态机。
  // 活信号全是壳内事实,不多一次网络往返;返回值非空 = 活着的证据(兼作日志)。
  //   ★ sid 现解:n.sid 目前恒 null(doDispatch 时卡还没绑会话),从 S.sessionByWc(wcId→sid)补。
  //   ★ 续命无上限但不失控:真挂死由 stall(15min)与 30min 挂死看门狗收口,探活只管"别冤枉慢"。
  //   ★ 只在节点 running 时续命:其余状态放行 TIMER,由 run.js onTimer 吸收(终态/queued 不该被计时器纠缠)。
  //   ★ "内容在动"比的是【挂计时那一刻】(armedAt),不是 now-窗口 —— 语义是"我开始等静默之后又动过",
  //     顺带让回放(手动拨计时器、墙钟不走)能确定性分辨"挂后动过"与"挂前就在动"。
  function silentMs(fxMs) {
    const k = num(S.settings && S.settings.knobs && S.settings.knobs.orchSilentSec)
    return Math.max(1000, k > 0 ? k * 1000 : (Number(fxMs) || 45000))
  }
  function silentAlive(runId, nodeId, armedAt) {
    const cur = runs.get(str(runId))
    if (!cur) return ''
    const n = findNode(cur, nodeId)
    if (!n || n.state !== 'running') return ''
    const sid = sidOf(n)
    if (n.cardId && !sid) return '卡在启动(会话未绑定)'                    // 慢 serve 冷启动:卡开了会话还没绑上
    try { if (sid && S.turnBusy && S.turnBusy.has(sid)) return '有回合在飞(turnBusy)' } catch {}   // card-send 起手即入册,网关排队/prefill 慢也盖得住
    try { if (n.wcId != null && typeof S.isCardBusy === 'function' && S.isCardBusy(n.wcId)) return '卡片忙(isCardBusy)' } catch {}
    try {
      const si = sid && S.sessionInfo && S.sessionInfo.get(sid)
      const last = si && num(si.lastEventAt)
      // 内容签名打点(轮询重喂不续命):挂了静默计时之后还在动 = turn end 判早了/晚答还在落。
      // ★2s 宽限:轮末收尾的簿记性 onText 会在挂计时后几百毫秒内最后蹭一下签名(实测),
      //   那不是"还在产"——真在流式晚答会一路写越过这条线;收在宽限内的,本来就已静默,该落定。
      if (last && last > num(armedAt) + 2000) return '内容在动(挂计时后 ' + Math.round((last - num(armedAt)) / 1000) + 's 还在写)'
    } catch {}
    return ''
  }

  function doArm(run, fx) {
    doClear(fx)
    const key = str(fx.key)
    const kind = str(fx.kind)
    const ms = kind === 'silent' ? silentMs(fx.ms) : Math.max(1000, Number(fx.ms) || 45000)
    const armedAt = Date.now()
    timers.set(key, setTimeout(() => {
      timers.delete(key)
      if (kind === 'silent') {
        const alive = silentAlive(run.id, fx.nodeId, armedAt)
        if (alive) {
          log('[orch] ' + run.id + ' ' + str(fx.nodeId) + ' 静默到点但工人仍活(' + alive + '),续命 ' + Math.round(ms / 1000) + 's')
          doArm(run, fx)      // 续命:同口径重挂一轮(armedAt 随之刷新);doArm 只用 run.id,闭包里是旧 run 对象无碍
          return
        }
      }
      send(run.id, { type: 'TIMER', nodeId: fx.nodeId, key, kind })
    }, ms))
  }
  function doClear(fx) {
    const key = str(fx.key)
    const t = timers.get(key)
    if (t) { clearTimeout(t); timers.delete(key) }
  }

  // 面板 webContents:内嵌卡建 reg 时 wcId 恒为 null(webview guest 就绪后才由 session-bind 补),
  // createRun 当场取到的 panelWcId 必然是 null —— 只认它的话 run-snapshot 一次都推不出去(实测静默)。
  // 现查一次并回填,顺带把"面板卡重载后 wcId 变了"一并修掉。
  function panelWc(run) {
    if (run.panelWcId != null) { const wc = wcById(run.panelWcId); if (wc) return wc }
    const fresh = regWcId(run.panelCardId)
    if (fresh != null) { run.panelWcId = fresh; return wcById(fresh) }
    return null
  }

  function doNotify(run, fx) {
    log('[orch:' + str(fx.level) + '] ' + str(fx.text))
    const wc = panelWc(run)
    if (wc) { try { wc.send('card-note', { text: str(fx.text), tone: 'muted' }) } catch { /* 面板没了就只留日志 */ } }
  }

  // 存档:复用现有 wfArchive(卡坞/历史面板都读它)。它有 `if (!reg.final) return` 早退,所以必须先写 final
  function doArchive(run) {
    try {
      const reg = run.panelCardId != null && S.wfRegistry ? S.wfRegistry.get(String(run.panelCardId)) : null
      if (!reg) return
      const res = run.result || {}
      reg.final = str(res.summary) || ('编排结束(' + run.phase + '):' + str(run.goal))
      reg.status = run.phase === 'done' ? 'done' : 'interrupted'
      if (typeof S.wfArchive === 'function') S.wfArchive(reg)
    } catch (e) { log('[orch] 存档失败:' + e.message) }
  }

  // 面板投影:run 的只读快照推给面板卡;顺带把节点表映射成伪 todos 喂给卡坞(wf-list 显示 N/M,零改)
  function pushUi(run) {
    const snap = RUN.projectSnapshot(run)
    const wc = panelWc(run)
    if (wc) { try { wc.send('run-snapshot', snap) } catch { /* 面板关了不影响 run */ } }
    try {
      const reg = run.panelCardId != null && S.wfRegistry ? S.wfRegistry.get(String(run.panelCardId)) : null
      if (reg) {
        reg.todos = arr(run.nodes).map((n) => ({
          content: n.title,
          status: n.state === 'verified' ? 'completed' : (n.state === 'running' || n.state === 'settled') ? 'in_progress'
            : (n.state === 'skipped' || n.state === 'cancelled') ? 'cancelled' : n.state === 'failed' ? 'completed' : 'pending',
        }))
        reg.round = run.wave; reg.rounds = run.wave
      }
    } catch { /* 投影失败不影响编排 */ }
  }

  // ── 目录量级实测(代码算,不让模型估)────────────────────────────────
  function surveyDir(dir) {
    const base = str(dir) || (S.settings && S.settings.projectDir) || '.'
    const tops = new Map()
    let n = 0, bytes = 0, tree = []
    const walk = (abs, rel, depth) => {
      if (n >= SURVEY_MAX_FILES) return
      let names = []
      try { names = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
      for (const de of names) {
        if (n >= SURVEY_MAX_FILES) return
        if (de.name.startsWith('.') && de.name !== '.claude') continue
        if (SURVEY_SKIP.test(de.name)) continue
        const childAbs = path.join(abs, de.name)
        const childRel = rel ? rel + '/' + de.name : de.name
        if (de.isDirectory()) {
          if (depth < 2) tree.push('  '.repeat(depth) + childRel + '/')
          walk(childAbs, childRel, depth + 1)
          continue
        }
        if (!SURVEY_EXT.test(de.name)) continue
        let sz = 0
        try { sz = fs.statSync(childAbs).size } catch { continue }
        n++; bytes += sz
        const top = childRel.split('/')[0]
        const t = tops.get(top) || { path: top, n: 0, bytes: 0 }
        t.n++; t.bytes += sz; tops.set(top, t)
      }
    }
    try { walk(base, '', 0) } catch (e) { log('[orch] survey 失败:' + e.message) }
    let readmeHead = ''
    for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
      try { readmeHead = fs.readFileSync(path.join(base, f), 'utf8').split('\n').slice(0, 40).join('\n'); break } catch { /* 换下一个 */ }
    }
    return {
      n, bytes,
      tops: [...tops.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8),
      tree: tree.slice(0, 60).join('\n'),
      readmeHead,
    }
  }

  function readDirDeep(abs) {
    const out = []
    const walk = (p, depth) => {
      if (out.length >= 100 || depth > 4) return
      let st = null
      try { st = fs.statSync(p) } catch { return }
      if (st.isDirectory()) { try { for (const nm of fs.readdirSync(p)) walk(path.join(p, nm), depth + 1) } catch { /* 读不动就跳过 */ } ; return }
      if (st.size > 1024 * 1024) return
      try { out.push(fs.readFileSync(p, 'utf8')) } catch { /* 二进制/权限,跳过 */ }
    }
    walk(abs, 0)
    return out.join('\n')
  }

  // 验证命令实跑:安全过滤沿用 nodes.safeVerifyCmd(shell 元字符黑名单 + 白名单正则),一行没删 ——
  // 命令的作者仍然是模型,只是从报告正文换成了 JSON 字段,信任级别一模一样
  function runCmd(cmd, cwd) {
    const safe = NODES.safeVerifyCmd(cmd)
    if (!safe) return { code: null, skipped: true, reason: '命令未通过安全过滤,跳过实跑' }
    try {
      require('child_process').execSync(safe, { cwd, timeout: CMD_TIMEOUT_MS, maxBuffer: CMD_MAXBUF, stdio: 'pipe', windowsHide: true })
      return { code: 0, out: '' }
    } catch (e) {
      // 环境性失败(超时/缓冲/命令不存在)不算"报告造假",按跳过处理,别拿它去判节点失败
      const envish = e && (e.killed || e.code === 'ENOBUFS' || e.code === 127 || /ENOBUFS|maxBuffer|timed?\s*out/i.test(str(e.message)))
      if (envish) return { code: null, skipped: true, reason: '环境性失败:' + str(e.message).slice(0, 120) }
      return { code: typeof e.status === 'number' ? e.status : 1, out: str(e.stdout || '').slice(0, 4000) }
    }
  }

  // 全局并发余量:与 spawnWorkflow 里那道闸同源(S.wfRunningCount / S.wfConcurrency 由 window.js 挂出),
  // 取不到就返回 Infinity(退回"只看 run 内并发"的老行为,不会更差)
  function globalCap() {
    try {
      if (typeof S.wfRunningCount !== 'function' || typeof S.wfConcurrency !== 'function') return Infinity
      return Math.max(0, S.wfConcurrency() - S.wfRunningCount())
    } catch { return Infinity }
  }

  // 节点的会话 id:n.sid 在生产里恒为 null —— 派卡那一刻卡还没绑会话,而 NODE_DISPATCHED 是在那一刻发的。
  // 真正知道 sid 的是 S.sessionByWc(wcId → sid),card-init 建完会话才写进去。
  // 收敛成一份:此前 silentAlive 自己补了、backfillFinal 没补(于是那道闸真机上从没跑过),
  // 正是"同一件事两份账本、其中一份是空的"这个老毛病。要加第三个用到 sid 的地方,也从这儿取。
  function sidOf(n) {
    if (!n) return null
    return n.sid || (n.wcId != null && S.sessionByWc ? S.sessionByWc.get(n.wcId) : null) || null
  }
  function findNode(run, id) { return arr(run.nodes).find((n) => n.id === str(id)) || null }
  function regWcId(cardId) {
    try { const reg = S.wfRegistry && S.wfRegistry.get(String(cardId)); return reg ? reg.wcId : null } catch { return null }
  }

  // ── 对外 API(window.js / mail.js / IPC 调这些)──────────────────────
  const api = {
    /** run_orchestration 走这里:开面板卡 → 建 run → 起 plan 决策 */
    createRun(goal, opts) {
      const o = opts || {}
      const dir = str(o.dir) || (S.settings && S.settings.projectDir) || ''
      const alias = 'RUN-' + Math.random().toString(36).slice(2, 6)
      const run = RUN.createRun({
        goal: str(goal), dir, backendDir: (S.settings && S.settings.backendDir) || '',
        model: o.model || null, alias,
        concurrency: (S.settings && S.settings.knobs && S.settings.knobs.wfConcurrency) || 4,
      }, { at: Date.now(), mkId })
      // 面板卡:msg 传 null —— 它有会话但【永不发消息】(编排不是"跟一个 Agent 聊天")
      const cardId = spawnCard('编排 · ' + str(goal).slice(0, 20), null, null, str(goal),
        { flash: true, wf: true, orch: true, model: o.model || null, run: run.id })
      run.panelCardId = String(cardId)
      run.panelWcId = regWcId(cardId)
      runs.set(run.id, run)
      // 兼容垫片:让 orchByTag 认得它(ShardPanel / pushShardProgress / 卡坞都按 tag 反查)
      S.orchByTag = S.orchByTag || new Map()
      S.orchByTag.set(alias, { id: String(cardId), at: Date.now(), runId: run.id })
      log('[orch] run 创建 ' + run.id + '(面板卡 ' + cardId + ', alias ' + alias + '):' + str(goal).slice(0, 60))
      send(run.id, { type: 'RUN_START' })
      return { id: run.id, cardId, alias }
    },
    get(runId) { return runs.get(str(runId)) || null },
    list() { return [...runs.values()] },
    byCard(cardId) {
      const hit = cardToNode.get(String(cardId))
      return hit ? { run: runs.get(hit.runId) || null, nodeId: hit.nodeId } : null
    },
    /** 面板卡 → run(window.js 的早退判据用) */
    runOfPanel(cardId) {
      for (const r of runs.values()) if (String(r.panelCardId) === String(cardId)) return r
      return null
    },
    // ── 工人卡回流(window.js 的 wfTurn* 早退点转调这里)────────────────
    onWorkerTurnStart(reg) { route(reg, (r, nodeId) => send(r.id, { type: 'WORKER_TURN_START', nodeId })) },
    onWorkerTurnEnd(reg, snap) {
      route(reg, (r, nodeId) => send(r.id, {
        type: 'WORKER_TURN_END', nodeId,
        final: str(reg.final), files: arr(reg.files), rounds: reg.rounds || 0,
        aborted: !!(snap && snap.aborted),
      }))
    },
    onWorkerTurnError(reg) { route(reg, (r, nodeId) => send(r.id, { type: 'WORKER_TURN_ERROR', nodeId })) },
    onWorkerCardGone(reg) { route(reg, (r, nodeId) => send(r.id, { type: 'WORKER_CARD_GONE', nodeId })) },
    /** 面板卡关闭 = 整个 run 取消(与今天"关主控卡级联杀分片"的语义一致) */
    onPanelCardGone(cardId) {
      const r = api.runOfPanel(cardId)
      if (r) send(r.id, { type: 'PANEL_CARD_GONE' })
    },
    /**
     * 工人调 MCP 工具 report_findings 上报发现(relay → 这里 → 状态机事件)。
     * nodeRef 形如 "<runId>:<nodeId>" —— 由 composeNodeBrief 写进任务指令的【上报凭据】栏。
     * 【为什么带 runId 而不是只认 nodeId】节点 id 是 run 内序号(n1/n2…),跨 run 必撞;
     * 两个工作流同时跑的时候只认 nodeId 会把 A 的发现记到 B 头上 —— 串台这个坑刚修过一次。
     * 返回计数给工具,让工人知道有几条【没被收下】(太笼统/别的片报过了)—— 静默丢弃就退回了老毛病。
     */
    reportFindings(nodeRef, findings) {
      const ref = str(nodeRef).trim()
      const i = ref.lastIndexOf(':')
      if (i <= 0) return { error: 'nodeRef 形如 "<runId>:<nodeId>",请原样抄任务指令里的【上报凭据】' }
      const runId = ref.slice(0, i), nodeId = ref.slice(i + 1)
      const run = runs.get(runId)
      if (!run) return { error: '找不到这条编排(可能已经结束了)' }
      const node = findNode(run, nodeId)
      if (!node) return { error: '这条编排里没有节点 ' + nodeId }
      const raw = arr(findings)
      const clean = SHAPE.normFindings(raw)                       // 太笼统/核不动的在这里被滤掉
      const fresh = SHAPE.dedupeFindings(run, clean)              // 别的片报过的不重复收
      if (fresh.length) send(runId, { type: 'NODE_FINDINGS', nodeId, findings: fresh })
      return { ok: true, accepted: fresh.length, rejected: Math.max(0, raw.length - clean.length), dupes: Math.max(0, clean.length - fresh.length) }
    },
    /**
     * 核实员调 MCP 工具 report_verdict 上报判决。与 reportFindings 同一条链路、同一套 nodeRef。
     * 【为什么 PASS 要多问两句】原来的规矩是"PASS 必须带 Command run 块",本意是挡住"没跑就写 PASS"。
     * 换成工具之后这条不能丢,只是从"全文里搜一个字符串"变成"两个必填字段" ——
     * 说不出自己做了什么、看到了什么,那个 PASS 就是想当然。FAIL/PARTIAL 不设这个门槛:
     * 判 FAIL 本来就常常是因为"没找到证据",要求它拿出证据才能说没证据是自相矛盾。
     */
    reportVerdict(nodeRef, verdict, didWhat, observed) {
      const ref = str(nodeRef).trim()
      const i = ref.lastIndexOf(':')
      if (i <= 0) return { error: 'nodeRef 形如 "<runId>:<nodeId>",请原样抄任务指令里的【上报凭据】' }
      const run = runs.get(ref.slice(0, i))
      if (!run) return { error: '找不到这条编排(可能已经结束了)' }
      const node = findNode(run, ref.slice(i + 1))
      if (!node) return { error: '这条编排里没有节点 ' + ref.slice(i + 1) }
      const v = str(verdict).toUpperCase().trim()
      if (['PASS', 'FAIL', 'PARTIAL'].indexOf(v) < 0) return { error: 'verdict 只能是 PASS / FAIL / PARTIAL' }
      if (v === 'PASS' && (!str(didWhat).trim() || !str(observed).trim())) {
        return { error: '判 PASS 必须同时说清 didWhat(你实际做了什么来核它)与 observed(你看到了什么原文/输出)—— 两样都说不出来的 PASS 是想当然,壳层不收' }
      }
      send(run.id, { type: 'NODE_VERDICT', nodeId: node.id, verdict: v })
      return { ok: true, verdict: v }
    },
    // ── 用户动作(IPC)────────────────────────────────────────────────
    approve(runId, edits) { return send(runId, { type: 'USER_APPROVE', edits: edits || null }) },
    reject(runId, note) { return send(runId, { type: 'USER_REJECT', note: str(note) }) },
    note(runId, text) { return send(runId, { type: 'USER_NOTE', text: str(text) }) },
    abort(runId) { return send(runId, { type: 'USER_ABORT' }) },
    retryNode(runId, nodeId) { return send(runId, { type: 'USER_RETRY', nodeId: str(nodeId) }) },
    resume(runId) { return send(runId, { type: 'USER_RESUME' }) },
    tick(runId) { return send(runId, { type: 'TICK' }) },
    snapshot(runId) { const r = runs.get(str(runId)); return r ? RUN.projectSnapshot(r) : null },
    /** 重启后:把非终态存档读回内存并置 suspended(不自动跑 —— 内网重启常伴随 serve 变更,自动重跑=重复烧钱) */
    restore() {
      let n = 0
      for (const r of journal.list()) {
        if (['done', 'failed', 'cancelled'].indexOf(str(r.phase)) >= 0) continue
        r.phase = 'suspended'
        runs.set(r.id, r); n++
      }
      if (n) log('[orch] 重启恢复 ' + n + ' 条未完成编排(等用户点续跑)')
      try { journal.gc(Date.now()) } catch { /* GC 失败无所谓 */ }
      return n
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      journal.dispose()
    },
    __journal: journal,
  }

  function route(reg, fn) {
    if (!reg || !reg.runId) return
    const r = runs.get(String(reg.runId)); if (!r) return
    const nodeId = str(reg.nodeId) || (cardToNode.get(String(reg.id)) || {}).nodeId
    if (!nodeId) return
    fn(r, nodeId)
  }

  return api
}

module.exports = { makeOrch }
