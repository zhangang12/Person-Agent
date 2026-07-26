// 【插件自动安装】把 plugin/ 下的壳层插件(read-spill + bocomhermes-context-guard)拷进 opencode 全局插件目录
// (~/.config/opencode/plugin/,opencode 启动自动加载,无需改 opencode.jsonc)——
// read-spill:tool.execute.after 钩子上把 read/grep 大输出外溢落盘 + 会话累计桶第二道闸;
// context-guard:历史工具结果清理/系统提示纪律注入/压缩纪律/参数收口/空输出占位符(均详见各文件头注释)。
// 每次启动覆盖式拷贝 = 自更新(壳层升版插件跟着升);拷贝源在 asar 内也能读(Electron 补过 fs)。
'use strict'
module.exports = function initPluginInstall(ctx) {
  const { app, path, fs, log } = ctx
  const PLUGINS = ['read-spill.js', 'bocomhermes-context-guard.js']
  function autoInstall() {
    const out = { ok: true, installed: [] }
    for (const name of PLUGINS) {
      try {
        const src = path.join(app.getAppPath(), 'plugin', name)
        const dstDir = path.join(app.getPath('home'), '.config', 'opencode', 'plugin')
        const dst = path.join(dstDir, name)
        const body = fs.readFileSync(src)   // 源不在(老包)静默跳过,不打扰启动
        const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(body)
        if (same) { out.installed.push({ name, already: true }); continue }
        fs.mkdirSync(dstDir, { recursive: true })
        fs.writeFileSync(dst, body)
        log(name + ' 插件已安装 → ' + dst + '(若已有外部 serve 在跑,需重启 serve 才生效)')
        out.installed.push({ name, path: dst })
      } catch (e) { log(name + ' 插件安装跳过: ' + e.message); out.installed.push({ name, error: e.message }) }
    }
    return out
  }
  return { autoInstall }
}
