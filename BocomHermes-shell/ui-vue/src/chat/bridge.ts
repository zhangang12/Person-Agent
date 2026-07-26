// chat 页 · preload 桥访问(唯一入口;纯浏览器/stub 环境下可为 undefined,调用方一律 ?. 兜底)
export function BH(): BocomHermesBridge | undefined {
  try { return window.BocomHermes } catch { return undefined }
}
