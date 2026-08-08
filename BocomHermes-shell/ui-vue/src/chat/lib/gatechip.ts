// 退出检查(闸门)在节点表上怎么显示 —— 纯函数,便于逐例断言。
//
// 【为什么单独抽出来】真机 2026-08-08:用户看着面板问"怎么这么多报错",而其中一部分根本不是报错。
// 原来的模板是这么写的:
//   <span v-if="n.exitReport.length" class="rn-tag bad">{{ n.exitReport.map(x => x.kind).join('/') }}</span>
// 两处都错:
//   ① 不按 ok 过滤 —— exitReport 里【通过的闸也在里面】,一起被列出来;
//   ② 样式恒为 bad —— 通过的闸也被染成失败色。
// 真实例子(盘上 n28):exitReport = [artifacts ok:false, noEmpty ok:true「有回报」]
//   → 面板显示一个红 chip「artifacts/noEmpty」,让人以为两道都崩了,其实 noEmpty 是绿的。
// 闸门判得对,面板把它说错了 —— 而"看起来到处在报错"会直接压垮人对整套系统的信任,
// 比少显示一条信息贵得多。

export type GateItem = { kind?: string; ok?: boolean; detail?: string }

/** 真正没过的闸(通过的不算)。空数组 = 这片没有失败的闸,chip 不该出现。 */
export function failedGates(report: unknown): GateItem[] {
  if (!Array.isArray(report)) return []
  return report.filter((x): x is GateItem => !!x && typeof x === 'object' && (x as GateItem).ok === false)
}

/** chip 上的文字:只列没过的闸。没有就返回 ''(模板据此隐藏)。 */
export function gateChipText(report: unknown): string {
  return failedGates(report).map((x) => String(x.kind || '?')).join('/')
}

/**
 * tooltip:逐条列出【全部】闸门与结论,过的打 ✓、没过打 ✗ 并带原因。
 * chip 只显示失败项,但 hover 要能看到全貌 —— 否则"哪几道查过了"这个信息就丢了。
 */
export function gateChipTip(report: unknown): string {
  if (!Array.isArray(report)) return ''
  return report
    .filter((x) => !!x && typeof x === 'object')
    .map((x: GateItem) => (x.ok ? '✓ ' : '✗ ') + String(x.kind || '?') + (x.detail ? ':' + String(x.detail) : ''))
    .join('\n')
}
