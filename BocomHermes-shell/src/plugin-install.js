// 【read-spill 插件自动安装】把 plugin/read-spill.js 拷进 opencode 全局插件目录
// (~/.config/opencode/plugin/,opencode 启动自动加载,无需改 opencode.jsonc)——
// 插件在 serve 的 tool.execute.after 钩子上把 read/grep 大输出外溢落盘(128k 上下文治理的关键硬机制,
// 详见插件文件头注释)。每次启动覆盖式拷贝 = 自更新(壳层升版插件跟着升);拷贝源在 asar 内也能读(Electron 补过 fs)。
'use strict'
module.exports = function initPluginInstall(ctx) {
  const { app, path, fs, log } = ctx
  function autoInstall() {
    try {
      const src = path.join(app.getAppPath(), 'plugin', 'read-spill.js')
      const dstDir = path.join(app.getPath('home'), '.config', 'opencode', 'plugin')
      const dst = path.join(dstDir, 'read-spill.js')
      const body = fs.readFileSync(src)   // 源不在(老包)静默跳过,不打扰启动
      const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(body)
      if (same) return { ok: true, already: true }
      fs.mkdirSync(dstDir, { recursive: true })
      fs.writeFileSync(dst, body)
      log('read-spill 插件已安装 → ' + dst + '(若已有外部 serve 在跑,需重启 serve 才生效)')
      return { ok: true, path: dst }
    } catch (e) { log('read-spill 插件安装跳过: ' + e.message); return { ok: false, error: e.message } }
  }
  return { autoInstall }
}
