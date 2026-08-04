'use strict'
// ── 卡关闭清理链(波2 从 spawnCard closed 内联体抽出;波3 为探针可测再抽成独立模块)─────────────
// 职责:一张对话卡(独立窗/内嵌 webview/钉出窗)销毁时的全部善后。
// 四条入口:①独立卡窗 closed;②内嵌会话关闭(session-close IPC);③主窗口关闭时对 embedWc 批量;
// ④钉出/收回(opts.detach)——降级版:会话必须活着,只摘这张死 wc 的登记。
// 设计:纯工厂注入依赖(无 electron import,BrowserWindow 由调用方注入),scripts/cleanup-detach-test.mjs 零依赖探针直测。
// detach 逐项对照:abort 会话 / retireIfOrphan / wf 终态+存档 / wfDequeue / orch 级联【跳】(会话与注册表不归这张死 wc 管,
// 重挂由 session.js trackWcSession 按 sid 认领);sessionByWc / cardDir / modelByWc / embedWc / shardWc / busy【摘】(wc 键登记);
// sessionInfo[sid] 不删,仅把这张死 wc 置空(serve/readStat 等会话态保留,重接时 card-init 整体重建;
// 空窗期流事件被 onText 守卫丢弃、权限/提问自动拒 —— 窗口极短,重接后回放补齐);streamBuf/sentPrompt/firstMsgCtx 是 sid 键的会话态,全留。
// browser.js:644-664 的教训在此守:abort 会话 / retireIfOrphan / cardDir / modelByWc / forgetBusy 一项不能漏(全清理分支)。
// 工人卡关卡收官:running 节点直写 interrupted 后,要把"卡没了"这件事通知编排引擎(它按磁盘产出判)
// (注入依赖)—— 不唤醒主控 = 主控死等这片、面板看不到终态。
// 幂等:各 Map 删除重复执行无副作用,wf 注册表项摘除后 wreg 取不到即空转 —— 重复调用安全。win 参数仅保留调用方语义(独立卡窗),清理本身只用 wcId。
module.exports = function makeCardCleanup({ S, oc, log, BrowserWindow, getShardSettleTimers, wfDequeue, forgetBusy, onNodeCardGone, pushShardProgress, onRunCardGone }) {
  return function cleanupCardContext(S2, wcId, win, opts) {
    const detach = !!(opts && opts.detach)
    const shardSettleTimers = getShardSettleTimers()   // 惰性取:装配期该 Map 尚在 TDZ,调用期必已就绪
    const s = S.sessionByWc.get(wcId)
    let oldServe = null
    if (s) {
      if (detach) {
        const si = S.sessionInfo.get(s)
        if (si && si.wc && si.wc.id === wcId) si.wc = null   // detach:死 wc 置空(条目留);abort/删 sid 键表/清 pending 全跳 —— 会话还活着
      } else {
        const si = S.sessionInfo.get(s); if (si) { oldServe = si.serve; oc.abort(si.serve, s) } S.sessionInfo.delete(s); S.streamBuf.delete(s); S.sentPrompt.delete(s); S.firstMsgCtx.delete(s); S.dropPendingPerm(s); S.dropPendingQuestion(s)   // 未答的审批/提问记录随卡清 + reject,别在 pendingPerm/pendingQuestion 里留孤儿,也别让 serve 那侧空等
        // ★这两处原来是 `S.dropPendingPerm && …` / `typeof … === 'function'` 的软调用:dropPendingPerm 压根没实现,短路后静默跳过了一年。
        //   现在两个都在 session.js 里实打实挂上了,直调 —— 真没挂上就当场 TypeError,而不是又悄悄不清理。
      }
    }
    S.sessionByWc.delete(wcId)
    if (S.cardWcById) { for (const [k, v] of S.cardWcById) if (v === wcId) { S.cardWcById.delete(k); break } }   // 卡 id→wcId 反查摘除(键是卡 id;表极小)
    if (S.embedWc) S.embedWc.delete(wcId)   // 内嵌会话登记(波2)随卡清理
    if (S.shardWc) S.shardWc.delete(wcId)   // 分片权限自动放行随卡失效
    if (S.shardForceClose) S.shardForceClose.delete(wcId)   // 销毁白名单随卡清理(弹窗查看后的 X 转隐藏不进这里)
    if (S.cardDir) S.cardDir.delete(wcId)       // per-card 目录/模型状态随卡销毁
    if (S.modelByWc) S.modelByWc.delete(wcId)
    if (S.permModeByWc) S.permModeByWc.delete(wcId)   // per-card 权限模式随卡销毁
    if (S.agentByWc) S.agentByWc.delete(wcId)   // per-card Agent 选择随卡销毁
    // 本卡独占的自起 serve(切过项目的卡)没别的会话引用就退休,不留孤儿进程。detach 天然跳过(oldServe 未取):会话还在 serve 上跑,谈何孤儿
    if (oldServe) {
      const inUseBases = new Set([...S.sessionInfo.values()].map((si) => si.serve && si.serve.base).filter(Boolean))
      try { if (oc.retireIfOrphan(oldServe, inUseBases)) log('card closed: serve ' + oldServe.base + ' 已退休(无会话引用)') } catch {}
    }
    // 工作流卡收尾:注册表落终态 + 落最终存档(关窗不丢,workflow_result 仍可取回)。
    // 终态语义:此前已判 done 保持 done;此前还 running 被关卡 = interrupted(列表/重试据此区分"干完了"与"被掐断")。
    // detach 时 wreg 恒取空(!detach 守卫)→ 收官/存档/摘键/wfDequeue/orch 级联整串跳过(钉出挪窝不收官,重挂由 trackWcSession 认领)
    const wreg = !detach && S.wfCardByWc && S.wfCardByWc.get(wcId)
    if (wreg) { wreg.status = wreg.status === 'done' ? 'done' : 'interrupted'; wreg.elapsedMs = Date.now() - wreg.at; S.wfCardByWc.delete(wcId); try { S.wfArchive && S.wfArchive(wreg) } catch (e2) { log('wf archive err: ' + e2.message) } }
    // 工人卡关闭 = 编排要按磁盘产出判这一节点的收官(直写状态不通知引擎 = 编排死等这个节点)。
    // 判据从"有 parentOrch 且一次性标志未消费"改成"有 runId":新引擎没有一次性标志这种东西,
    // 事件幂等由状态守卫保证(终态节点收到重复事件直接吸收)。回调由装配方注入(window.js)。
    if (wreg && wreg.runId) {
      try { onNodeCardGone && onNodeCardGone(wreg) } catch (e2) { log('orch node gone err: ' + e2.message) }
      try { if (wreg.parentOrch) pushShardProgress && pushShardProgress(wreg.parentOrch) } catch {}
    }
    clearTimeout(shardSettleTimers.get(wcId)); shardSettleTimers.delete(wcId)   // 关窗即埋落定计时:否则计时器到点把 close 写入的 interrupted 覆写回 done(终态写错)
    if (wreg) { try { wfDequeue() } catch {} }   // 关卡腾出并发位 → 排队工作流补位(出队触发点②)
    // 主控关卡 → 它的分片卡(隐藏工人)一并关掉:主控没了分片就是烧 token 的孤儿,不会再有人看它的窗口
    if (wreg && wreg.kind === 'orch' && S.orchByTag && S.wfRegistry) {
      try {
        for (const [tag, oref] of S.orchByTag) {
          if (String(oref.id) !== String(wreg.id)) continue
          for (const r of [...S.wfRegistry.values()].filter((x) => x.parentOrch === tag)) {
            const w2 = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === r.wcId)
            if (w2) { try { (S.shardForceClose = S.shardForceClose || new Set()).add(r.wcId); w2.close() } catch {} }   // 白名单真销毁(否则被 close 拦截转隐藏,杀不掉)
          }
        }
      } catch {}
    }
    // 编排面板卡关闭 → 通知引擎(整个 run 取消)。注入的 onNodeCardGone 只覆盖得到【工人卡】,
    // 面板卡走不到那条路,没有别的注入点够得着 —— 这是本模块为双轨付出的全部代价:两行。
    if (wreg && wreg.runId && typeof onRunCardGone === 'function') { try { onRunCardGone(wreg) } catch {} }
    forgetBusy(wcId)   // 关卡即清"忙",避免球卡在思考态
  }
}
