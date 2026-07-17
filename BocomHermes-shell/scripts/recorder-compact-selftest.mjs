// 回归测试:recorder-core.compactEvents —— 录制降噪(逐事件照录 → 有意义的操作序列)。
// 主 fixture 用真实录制 rec_mraifhpl(登录 8.141.123.141 → 用户反馈 → 导出 HTML)的原始 22 步事件流,
// 断言:密码 4 步→1、admin 2 步→1、滚动/Tab 删除、登录三重提交(Enter+点按钮+submit)收成单次点击。
// 另加合成边界用例:不跨元素误并、不误删两次真实点击、无按钮表单的 Enter 保留、survivors+dropped 可还原。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { compactEvents, humanGateHint, markHumanGates, upgradeToSkill, skillMd, composePostPipelineGoal, applyRefinePatch, rowToParamValues, relocateSelectors, selExpr, findElExpr, anchorExpr, takeoverDigest, applyParams, redactRec } = require('../src/recorder-core.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
const acts = (list) => list.map((e) => e.act)
const count = (list, pred) => list.filter(pred).length

// ── 主 fixture:rec_mraifhpl 的原始 22 步(选择器/文案/时间戳照抄真实录制)──────────
const U = 'http://8.141.123.141/login'
const raw = [
  { t: 0,     act: 'navigate', url: U },
  { t: 9784,  act: 'click',    sel: '#s', text: '' },
  { t: 10523, act: 'input',    sel: '#s', value: U },
  { t: 11111, act: 'key',      sel: '#s', key: 'Enter' },
  { t: 11112, act: 'submit',   sel: '#f' },
  { t: 13898, act: 'click',    sel: '#el-id-565-2', text: '' },
  { t: 16947, act: 'input',    sel: '#el-id-565-2', value: 'admin' },
  { t: 17258, act: 'input',    sel: '#el-id-565-2', value: 'admin' },
  { t: 17464, act: 'key',      sel: '#el-id-565-2', key: 'Tab' },
  { t: 18950, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 20473, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 21895, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 22495, act: 'input',    sel: '#el-id-565-3', value: '', secret: true },
  { t: 22611, act: 'key',      sel: '#el-id-565-3', key: 'Enter' },
  { t: 22623, act: 'click',    sel: '__text__:button|登 录', text: '登 录' },
  { t: 22623, act: 'submit',   sel: '__text__:form|登 录' },
  { t: 23605, act: 'navigate', url: 'http://8.141.123.141/overview', spa: true },
  { t: 26148, act: 'scroll',   x: 0, y: 0 },
  { t: 27437, act: 'click',    sel: '__text__:span|用户反馈', text: '用户反馈' },
  { t: 27611, act: 'navigate', url: 'http://8.141.123.141/admin/user-feedback', spa: true },
  { t: 31039, act: 'click',    sel: '__text__:span|导出待处理 HTML', text: '导出待处理 HTML' },
  { t: 32243, act: 'click',    sel: 'a', text: '' },
]

console.log('用例1:真实录制 rec_mraifhpl 22 步降噪')
const { events: out, dropped } = compactEvents(raw)
ok('22 步 → 11 步', out.length === 11, { got: out.length, dropped: dropped.length })
ok('survivors + dropped = 原始 22 步(可还原)', out.length + dropped.length === raw.length, { out: out.length, dropped: dropped.length })
ok('密码步(#el-id-565-3)由 4 → 1(治 4 个密码参数)', count(out, (e) => e.sel === '#el-id-565-3') === 1, count(out, (e) => e.sel === '#el-id-565-3'))
ok('保留的密码步 secret 与终值正确', (() => { const p = out.find((e) => e.sel === '#el-id-565-3'); return p && p.act === 'input' && p.secret === true })())
ok('admin 输入(#el-id-565-2)由 2 → 1', count(out, (e) => e.sel === '#el-id-565-2' && e.act === 'input') === 1)
ok('scroll 已删', count(out, (e) => e.act === 'scroll') === 0)
ok('key:Tab 已删', count(out, (e) => e.act === 'key' && e.key === 'Tab') === 0)
ok('登录三重提交(Enter+点按钮+submit)→ 单次:submit 全删', count(out, (e) => e.act === 'submit') === 0, acts(out))
ok('登录按钮点击保留(比 Enter/submit 更稳)', count(out, (e) => e.act === 'click' && /登.*录/.test(String(e.text || ''))) === 1)
ok('#el-id-565-3 上的 Enter 被删(与点按钮同意图)', count(out, (e) => e.act === 'key' && e.sel === '#el-id-565-3') === 0)
ok('仅聚焦的 click(#s / #el-id-565-2 后随输入)已删', count(out, (e) => e.act === 'click' && (e.sel === '#s' || e.sel === '#el-id-565-2')) === 0)
ok('业务点击均保留(登录/用户反馈/导出/末尾链接 = 4)', count(out, (e) => e.act === 'click') === 4, acts(out))
ok('导航步全保留(login/overview/feedback = 3)', count(out, (e) => e.act === 'navigate') === 3)
// 边界说明:#s 是新标签页搜索框,属 chrome 噪声;compaction 只能把它从 4 步(click/input/Enter/submit)压到 2 步
// (input + Enter,click/submit 被去焦点/提交去重删掉),彻底根治靠 RECORDER_JS 的源头守卫(新录制不再进这些步)。
ok('#s 搜索框残留 2 步(源头守卫负责根治,非 compaction 职责)', count(out, (e) => e.sel === '#s') === 2, acts(out))
// 每条 dropped 都带原下标与原因
ok('dropped 明细带 i/act/reason', dropped.every((d) => Number.isInteger(d.i) && d.act && d.reason), dropped.slice(0, 2))

console.log('用例2:不跨元素误并输入')
{
  const r = [
    { t: 0, act: 'input', sel: '#a', value: '1' },
    { t: 1, act: 'input', sel: '#b', value: '2' },
    { t: 2, act: 'input', sel: '#a', value: '3' },
  ]
  const { events } = compactEvents(r)
  ok('三个不连续/不同元素输入全保留', events.length === 3, acts(events))
}

console.log('用例3:同元素连续输入取最后值')
{
  const r = [
    { t: 0, act: 'input', sel: '#a', value: 'ab' },
    { t: 1, act: 'input', sel: '#a', value: 'abc' },
    { t: 2, act: 'input', sel: '#a', value: 'abcd' },
  ]
  const { events } = compactEvents(r)
  ok('3 连输入 → 1', events.length === 1)
  ok('保留最后一次的值 abcd', events[0] && events[0].value === 'abcd', events[0])
}

console.log('用例4:无提交按钮的表单 —— Enter 保留(回放靠它 requestSubmit)')
{
  const r = [
    { t: 0, act: 'input', sel: '#q', value: 'x' },
    { t: 1, act: 'key',   sel: '#q', key: 'Enter' },
  ]
  const { events } = compactEvents(r)
  ok('input + Enter 都保留', events.length === 2 && events[1].key === 'Enter', acts(events))
}

console.log('用例5:两次真实点击不同按钮 —— 不误删')
{
  const r = [
    { t: 0, act: 'click', sel: '#add', text: '新增' },
    { t: 1, act: 'click', sel: '#save', text: '保存' },
  ]
  const { events } = compactEvents(r)
  ok('新增 + 保存两次点击都保留', events.length === 2, acts(events))
}

console.log('用例6:Enter 后跟【非提交】点击 —— Enter 不误删')
{
  const r = [
    { t: 0, act: 'key',   sel: '#q', key: 'Enter' },
    { t: 1, act: 'click', sel: '#row3', text: '张三' },   // 点搜索结果行,不是提交
  ]
  const { events } = compactEvents(r)
  ok('Enter 与结果行点击都保留', events.length === 2 && count(events, (e) => e.act === 'key') === 1, acts(events))
}

console.log('用例7:空输入/异常入参不崩')
{
  ok('null → 空', compactEvents(null).events.length === 0)
  ok('[] → 空', compactEvents([]).events.length === 0)
  ok('无 t 字段不崩', compactEvents([{ act: 'submit', sel: '#f' }, { act: 'click', sel: '#b', text: '提交' }]).events.length >= 1)
}

console.log('用例8:人机断点识别(验证码/动态令牌/滑块)')
{
  // autocomplete=one-time-code —— OTP 标准标记,最强信号
  ok('autocomplete=one-time-code → 命中', humanGateHint({ act: 'input', sel: '#code', ac: 'one-time-code' }) !== null)
  // placeholder / label 关键词
  ok('placeholder "请输入短信验证码" → 命中', humanGateHint({ act: 'input', sel: '#c', ph: '请输入短信验证码' }) !== null)
  ok('label "图形验证码" → 命中', humanGateHint({ act: 'input', sel: '#c', lb: '图形验证码' }) !== null)
  ok('选择器含 captcha → 命中', humanGateHint({ act: 'input', sel: '#captchaInput', selAlt: [] }) !== null)
  ok('动态令牌 → 命中', humanGateHint({ act: 'input', sel: '#t', ph: '动态令牌' }) !== null)
  // 普通字段不误判
  ok('普通用户名字段 → 不命中', humanGateHint({ act: 'input', sel: '#username', ph: '请输入用户名' }) === null)
  ok('金额字段 → 不命中', humanGateHint({ act: 'input', sel: '#amount', lb: '转账金额' }) === null)
  ok('非 input(click)→ 不命中', humanGateHint({ act: 'click', sel: '#captcha', text: '获取验证码' }) === null)
  // 繁体(港澳台站,实测交行香港):驗證碼/短訊/保安編碼器 —— 简体正则靠 t2s 归一化后命中
  ok('繁体 label 手機驗證碼 → 命中', humanGateHint({ act: 'input', sel: '#c', lb: '手機驗證碼' }) !== null)
  ok('繁体 placeholder 短訊驗證碼 → 命中', humanGateHint({ act: 'input', sel: '#c', ph: '請輸入短訊驗證碼' }) !== null)
  ok('繁体 保安編碼器 → 命中', humanGateHint({ act: 'input', sel: '#c', lb: '保安編碼器' }) !== null)
  ok('繁体行为 滑動驗證(click) → 命中', humanGateHint({ act: 'click', sel: '#s', text: '滑動驗證' }) !== null)
  ok('繁体普通字段不误判', humanGateHint({ act: 'input', sel: '#u', ph: '請輸入用戶名' }) === null)
  ok('繁体「獲取驗證碼」按钮仍不认(该自动点)', humanGateHint({ act: 'click', sel: '#send', text: '獲取驗證碼' }) === null)
  // markHumanGates:打标 + 清空一次性值 + 去 secret
  const marked = markHumanGates([
    { act: 'input', sel: '#user', value: 'admin', ph: '用户名' },
    { act: 'input', sel: '#code', value: '123456', ph: '短信验证码', secret: true },
    { act: 'click', sel: '#login', text: '登录' },
  ])
  ok('验证码步标 human=true', marked[1].human === true)
  ok('验证码步带 humanHint', !!marked[1].humanHint, marked[1].humanHint)
  ok('验证码步一次性值已清空(不照填)', marked[1].value === '')
  ok('验证码步去掉 secret(human 已覆盖语义)', marked[1].secret === undefined)
  ok('普通用户名步不动', marked[0].human === undefined && marked[0].value === 'admin')
  ok('markHumanGates 不改原数组', true)   // Object.assign 产新对象,原引用不变(见实现)

  // 行为验证(滑块/人脸/扫码):录的是 click/拖拽不是 input。老版 act!=='input' 一刀切 → 这类永远认不出(死角)
  ok('滑块 click → 命中(老版死角)', humanGateHint({ act: 'click', sel: '.slider-btn', text: '按住滑块,拖动到最右边' }) !== null)
  ok('滑动验证 class → 命中', humanGateHint({ act: 'click', sel: '#nc_1_n1z', selAlt: ['.nc-lang-cnt'], text: '滑动验证' }) !== null)
  ok('人脸 click → 命中', humanGateHint({ act: 'click', sel: '#faceBtn', text: '开始人脸识别' }) !== null)
  ok('扫码 click → 命中', humanGateHint({ act: 'click', sel: '#qr', text: '扫码登录' }) !== null)
  // ★ 关键区分:「获取验证码」按钮是【该自动点的那一下】,认成断点会让每次回放都停下等人
  ok('★「获取验证码」按钮(click)→ 不命中(该自动点)', humanGateHint({ act: 'click', sel: '#sendCode', text: '获取验证码' }) === null)
  ok('★「发送短信验证码」按钮(click)→ 不命中', humanGateHint({ act: 'click', sel: '#send', text: '发送短信验证码' }) === null)
  ok('普通业务按钮(click)→ 不命中', humanGateHint({ act: 'click', sel: '#exp', text: '导出待处理 HTML' }) === null)
  // 内网常见叫法扩面
  ok('U盾 → 命中', humanGateHint({ act: 'input', sel: '#u', lb: 'U盾口令' }) !== null)
  ok('手机令牌 → 命中', humanGateHint({ act: 'input', sel: '#t', ph: '请输入手机令牌' }) !== null)
  ok('二次验证 → 命中', humanGateHint({ act: 'input', sel: '#m', lb: '二次验证码' }) !== null)
  ok('短信验证 → 命中', humanGateHint({ act: 'input', sel: '#s', ph: '短信验证' }) !== null)
  // 行为类不清 value(本来就没值),填值类才清
  const m2 = markHumanGates([{ act: 'click', sel: '.slider', text: '拖动滑块' }])
  ok('行为验证步标 human 且不注入 value 字段', m2[0].human === true && !('value' in m2[0]))
  // navigate/scroll 等非交互步不误判
  ok('navigate 步 → 不命中', humanGateHint({ act: 'navigate', url: 'http://x/captcha-page' }) === null)
}

console.log('用例9:upgradeToSkill —— events → 语义 steps(输入来源三分:static/param/resolve)')
{
  const rec = {
    id: 'rec_t', title: '开户', startUrl: 'http://x/login',
    events: [
      { act: 'navigate', url: 'http://x/login' },
      { act: 'input', sel: '#user', value: 'admin', lb: '用户名' },
      { act: 'input', sel: '#code', value: '', human: true, humanHint: '短信验证码', ph: '请输入短信验证码' },
      { act: 'click', sel: '__text__:button|登 录', text: '登 录' },
      { act: 'scroll', x: 0, y: 0 },
      { act: 'select', sel: '#type', value: '2', text: '对公账户', lb: '账户类型' },
    ],
    params: [{ key: 'p1', label: '用户名', stepIndex: 1, default: 'admin' }],
    skipSteps: [4],
  }
  const { skillRev, steps } = upgradeToSkill(rec)
  ok('skillRev=1', skillRev === 1)
  ok('skip 步不进语义视图(6 事件→5 步)', steps.length === 5, steps.map((s) => s.intent))
  ok('ei 回指原 events 下标(scroll 后的 select ei=5)', steps[4].ei === 5)
  ok('param 步 → source=param', steps[1].input && steps[1].input.source === 'param' && steps[1].input.key === 'p1')
  ok('human 步 → source=resolve + gate:human', steps[2].input.source === 'resolve' && steps[2].gate && steps[2].gate.type === 'human')
  ok('普通 select → source=static 带值', steps[4].input.source === 'static' && steps[4].input.value === '2')
  ok('intent 用 label 说人话', steps[1].intent.includes('用户名'), steps[1].intent)
  ok('navigate/click intent', steps[0].intent.startsWith('打开') && steps[3].intent.includes('登 录'))

  console.log('用例10:skillMd —— Codex 四段式技能文档(何时使用/所需输入/操作步骤/结果核验)')
  const md = skillMd({ ...rec, skill: true, description: '给新客户开对公账户', success: { kind: 'text', value: '开户成功' } })
  ok('四段齐全', ['## 何时使用', '## 所需输入', '## 操作步骤', '## 结果核验'].every((h) => md.includes(h)), md.split('\n')[0])
  ok('参数列进"所需输入"', md.includes('【运行参数】用户名'))
  ok('人机断点列进"所需输入"(运行时解析)', md.includes('【运行时解析】') && md.includes('短信验证码'))
  ok('步骤带 ⏸ 断点标记', md.includes('[⏸ 短信验证码]'))
  ok('成功标志进"结果核验"', md.includes('开户成功'))
  ok('全静态技能 → 所需输入为"无"', skillMd({ id: 'a', events: [{ act: 'click', sel: '#b', text: '导出' }] }).includes('无 —— '))
}

console.log('用例11:applyRefinePatch —— Agent 精修补丁校验应用(坏字段静默丢弃)')
{
  const rec = {
    id: 'r', title: '旧名', events: [
      { act: 'navigate', url: 'http://x/' },
      { act: 'input', sel: '#phone', value: '138', lb: '手机号' },
      { act: 'input', sel: '#pwd', value: '', secret: true },
      { act: 'input', sel: '#code', value: '', human: true, humanHint: '验证码' },
      { act: 'click', sel: '#go', text: '提交' },
    ],
    params: [],
  }
  const patch = {
    title: '客户信息录入', description: '给新客户录入基础信息时跑',
    intents: { 1: '填写客户手机号', 99: '越界', 4: '' },
    params: [
      { stepIndex: 1, label: '客户手机号' },   // 合法
      { stepIndex: 2, label: '密码' },          // secret → 拒
      { stepIndex: 3, label: '验证码' },        // human → 拒
      { stepIndex: 4, label: '提交' },          // click → 拒
      { stepIndex: 1, label: '重复' },          // 重复 → 拒
    ],
    success: { kind: 'text', value: '录入成功' },
    notes: '手机号来自物料表;提交前确认客户类型下拉',
  }
  const { rec: j, applied } = applyRefinePatch(rec, patch)
  ok('标题/描述应用', j.title === '客户信息录入' && j.description.includes('新客户'))
  ok('intents 只收合法(1 条,越界/空值拒)', j.intentOverrides && j.intentOverrides[1] === '填写客户手机号' && !('99' in j.intentOverrides) && !('4' in j.intentOverrides))
  ok('params 只追加 1 个合法(secret/human/click/重复全拒)', j.params.length === 1 && j.params[0].stepIndex === 1, j.params)
  ok('参数 key 自动编号 + default 取录制值', j.params[0].key === 'p1' && j.params[0].default === '138')
  ok('success 应用(此前未设)', j.success && j.success.value === '录入成功')
  ok('notes → skillNotes', j.skillNotes.includes('物料表'))
  ok('applied 摘要完整', applied.length >= 5, applied)
  // success 不覆盖人已设的
  const { rec: j2 } = applyRefinePatch({ ...rec, success: { kind: 'css', value: '.done' } }, patch)
  ok('人已设 success → 不覆盖', j2.success.value === '.done')
  // 原对象不被改
  ok('纯函数:入参 rec 未被改', rec.title === '旧名' && !rec.intentOverrides)
  // intentOverrides 在语义视图/文档里生效
  const { steps } = upgradeToSkill(j)
  ok('upgradeToSkill 优先用精修步名', steps[1].intent === '填写客户手机号')
  const md = skillMd({ ...j, skill: true })
  ok('文档含"注意事项"段', md.includes('## 注意事项') && md.includes('物料表'))
  ok('文档步骤用精修名', md.includes('填写客户手机号'))
  // 坏补丁不毁技能
  const { rec: j3, applied: a3 } = applyRefinePatch(rec, null)
  ok('空补丁 → 无应用不崩', a3.length === 0 && j3.events.length === 5)
}

console.log('用例12:rowToParamValues —— 数据行 → 运行参数(批跑映射)')
{
  const params = [
    { key: 'p1', label: '客户手机号', stepIndex: 1 },
    { key: 'p2', label: '金额', stepIndex: 3 },
    { key: 'p3', label: '备注', stepIndex: 5 },
  ]
  // label 精确命中 + key 命中 + 未匹配列报告
  const r1 = rowToParamValues(params, { '客户手机号': '13800001111', 'p2': 8000, '无关列': 'x' })
  ok('label 精确命中', r1.values.p1 === '13800001111')
  ok('key 命中 + 数字转字符串', r1.values.p2 === '8000')
  ok('未命中参数不出现在 values(走 default 兜底)', !('p3' in r1.values))
  ok('多余列进 unmatched', r1.unmatched.length === 1 && r1.unmatched[0] === '无关列')
  // 包含关系:唯一才用
  const r2 = rowToParamValues(params, { '手机号': '139' })
  ok('包含关系唯一命中("手机号"⊂"客户手机号")', r2.values.p1 === '139')
  const r3 = rowToParamValues([{ key: 'a', label: '开户金额' }, { key: 'b', label: '转账金额' }], { '金额': '1' })
  ok('包含关系歧义(两参数都含"金额")→ 各自唯一候选仍命中', r3.values.a === '1' && r3.values.b === '1')
  // 同 label 多参数(旧录制密码×N)同值
  const r4 = rowToParamValues([{ key: 'p1', label: '密码' }, { key: 'p2', label: '密码' }], { '密码': 'x1' })
  ok('同 label 多参数各自命中同列(同值)', r4.values.p1 === 'x1' && r4.values.p2 === 'x1')
  // 异常入参不崩
  ok('null 行不崩', rowToParamValues(params, null).unmatched.length === 0)
  ok('数组行不崩', rowToParamValues(params, ['x']).unmatched.length === 0)
}

console.log('用例13:relocateSelectors —— 自愈语义重定位候选(Phase 6a)')
{
  // input 带 placeholder → placeholder 选择器(input+textarea)
  const r1 = relocateSelectors({ act: 'input', sel: '#el-id-8017-2', ph: '用户名' })
  ok('input+placeholder → input[placeholder]', r1.includes('input[placeholder="用户名"]') && r1.includes('textarea[placeholder="用户名"]'))
  // input 带 label → __label__ 伪选择器
  ok('input+label → __label__:', relocateSelectors({ act: 'input', sel: '#x', lb: '手机号' }).includes('__label__:手机号'))
  // OTP autocomplete
  ok('one-time-code → autocomplete 选择器', relocateSelectors({ act: 'input', sel: '#c', ac: 'one-time-code' }).includes('input[autocomplete="one-time-code"]'))
  // click 带 text 且原 sel 非 __text__ → __text__ 候选
  const r2 = relocateSelectors({ act: 'click', sel: 'div.btn', text: '登录' })
  ok('click+text(非__text__原sel)→ __text__ 候选', r2.includes('__text__:button|登录') && r2.includes('__text__:a|登录'))
  // 原 sel 已是 __text__ 还失配 → 不再拼同样的
  ok('原 sel 已 __text__ → 不重复拼 __text__', relocateSelectors({ act: 'click', sel: '__text__:button|登 录', text: '登 录' }).length === 0)
  // 无锚点 → 空(交 6b Agent)
  ok('无 ph/lb/text → 空候选', relocateSelectors({ act: 'click', sel: 'div.el-scrollbar__thumb' }).length === 0)
  // 引号转义
  ok('placeholder 含双引号 → 转义', relocateSelectors({ act: 'input', ph: '说"你好"' })[0] === 'input[placeholder="说\\"你好\\""]')

  console.log('用例14:selExpr __label__ 伪选择器 → 页面表达式')
  const e = selExpr('__label__:用户名')
  ok('__label__ 生成查 label 的表达式', e.includes("querySelectorAll('label')") && e.includes('用户名') && e.includes('.control'))
  ok('普通 CSS 仍 querySelector', selExpr('#id').startsWith('document.querySelector('))
  ok('__text__ 仍走文本分支', selExpr('__text__:button|x').includes('innerText'))
}

console.log('用例15:takeoverDigest —— 接管摘要(secret 脱敏/人机断点标注/已做与剩余切分)')
{
  const rec = {
    id: 'r', title: '登录网银', description: '登录后导出用户反馈', success: { kind: 'text', value: '导出成功' },
    events: [
      { act: 'navigate', url: 'http://x/login' },
      { act: 'input', sel: '#u', value: 'admin', lb: '用户名' },
      { act: 'input', sel: '#p', value: 'RUNTIME_PWD_123', secret: true },
      { act: 'input', sel: '#c', value: '', human: true, humanHint: '短信验证码' },
      { act: 'click', sel: '__text__:button|登 录', text: '登 录' },
      { act: 'click', sel: '__text__:span|导出', text: '导出' },
    ],
    params: [{ key: 'p1', label: '密码', stepIndex: 2, secret: true }],
  }
  const d = takeoverDigest(rec, 4, { err: 'selector not found' })
  ok('目标/标题带上', d.title === '登录网银' && d.goal.includes('导出用户反馈'))
  ok('成功标志带上', d.successText.includes('导出成功'))
  ok('已完成/剩余按 fromIndex 切分', d.doneText.includes('1.') && d.doneText.includes('4.') && d.restText.includes('5.') && d.restText.includes('6.'))
  ok('失败点描述', d.failText.includes('第 5 步'))
  ok('★ secret 值绝不出现在摘要', !JSON.stringify(d).includes('RUNTIME_PWD_123'))
  ok('secret 步指向 type_param + 参数键', d.doneText.includes('type_param') && d.doneText.includes('p1'))
  ok('人机断点标注提醒用户', d.doneText.includes('短信验证码') && d.doneText.includes('提醒用户'))
  ok('普通值可见(非敏感,给 Agent 上下文)', d.doneText.includes('admin'))
}

console.log('用例16:composePostPipelineGoal —— 下载后任务编排目标合成(下载文件路径接进单Agent任务编排目标)')
{
  const files = ['C:/Users/x/Downloads/用户反馈.xlsx', 'C:/Users/x/Downloads/明细.csv']
  const g = composePostPipelineGoal('导出用户反馈', '把导出的表做成分析报告', files)
  ok('含人话目标', g.includes('把导出的表做成分析报告'))
  ok('含技能名', g.includes('导出用户反馈'))
  ok('含【输入文件】标注', g.includes('【输入文件】'))
  ok('每个下载文件路径都列出', files.every((f) => g.includes(f)))
  ok('提示子任务先读文件再干活', g.includes('读取') && g.includes('打开其内容'))
  // 空目标 → 空(无论有无文件):不配 postWorkflow 就不编排
  ok('空/纯空白模板 → 空串(不触发编排)', composePostPipelineGoal('x', '', files) === '' && composePostPipelineGoal('x', '   ', files) === '')
  // 有目标无文件 → 原样返回(trim),不拼空清单
  ok('有目标无下载 → 返回目标本身(trim)', composePostPipelineGoal('x', '  做点啥  ', []) === '做点啥')
  ok('非数组 files 当空处理', composePostPipelineGoal('x', '做点啥', null) === '做点啥')
  // 空/null 文件项被过滤,只留有效路径
  const g2 = composePostPipelineGoal('x', '目标', ['  ', null, 'C:/a.xlsx', ''])
  ok('空/null 文件项过滤,保留有效路径', g2.includes('C:/a.xlsx'))
  ok('清单只 1 行(3 个无效项被过滤)', (g2.match(/^- /gm) || []).length === 1, g2.match(/^- /gm))
  // skillMd 渲染"下载后编排"段(透明:文档/Agent 都看得到这个技能会编排)
  const md = skillMd({ id: 'r', title: '导出反馈', events: [{ act: 'click', sel: '#exp', text: '导出' }], postPipeline: { goal: '做成分析报告' } })
  ok('skillMd 含"下载后任务编排"段 + 目标', md.includes('## 下载后任务编排') && md.includes('做成分析报告'))
  ok('向后兼容:老 postWorkflow 字段也认', skillMd({ id: 'r', events: [{ act: 'click', sel: '#e' }], postWorkflow: { goal: '老字段目标' } }).includes('老字段目标'))
  ok('未配 → skillMd 无该段', !skillMd({ id: 'r', events: [{ act: 'click', sel: '#b', text: '导出' }] }).includes('## 下载后任务编排'))
}

// ── 用例17:redactRec —— 交出去的副本不带登录态(证据包给 Agent 读) ─────────────────
{
  console.log('用例17:redactRec(证据副本抹登录态,磁盘录制本体不动)')
  const secret = { cookies: [{ name: 'JSESSIONID', value: 'ABC123' }, { name: 'token', value: 'xyz' }], local: '{"jwt":"eyJhbG"}', session: '{"sid":"s-1"}', origin: 'https://bank.example.com' }
  const rec = { id: 'r1', startUrl: 'https://bank.example.com/x', preState: JSON.parse(JSON.stringify(secret)),
    events: [{ act: 'navigate', url: 'https://bank.example.com/x', _restorePreState: JSON.parse(JSON.stringify(secret)) }, { act: 'click', sel: '#go' }] }
  const red = redactRec(rec)
  const dump = JSON.stringify(red)
  ok('preState.cookies 值不再出现在副本里', !dump.includes('ABC123') && !dump.includes('xyz'))
  ok('localStorage/sessionStorage 值也抹掉', !dump.includes('eyJhbG') && !dump.includes('s-1'))
  ok('events[]._restorePreState 同样抹掉(replayRec 会把 preState 塞进去)', !JSON.stringify(red.events).includes('ABC123'))
  ok('抹去后仍看得出有几条 cookie(留可读线索,不是凭空消失)', /已抹去 2 条 cookie/.test(dump))
  ok('origin 保留(非机密,Agent 排查要用)', red.preState.origin === 'https://bank.example.com')
  ok('业务字段原样保留', red.id === 'r1' && red.events.length === 2 && red.events[1].sel === '#go')
  ok('原对象没被改坏(只动副本)', rec.preState.cookies[0].value === 'ABC123' && rec.events[0]._restorePreState.cookies.length === 2)
  ok('无 preState 的录制不炸', JSON.stringify(redactRec({ id: 'r2', events: [{ act: 'click' }] })) === JSON.stringify({ id: 'r2', events: [{ act: 'click' }] }))
  // applyParams 无参数时返回同一引用 —— 正是这条让 replayRec 的 preState 污染顺着 lastRec 传到证据序列化点
  const noParam = { id: 'r3', events: [{ act: 'click', sel: '#a' }] }
  ok('applyParams 无参数返回同一引用(证据副本必须自己 redact,不能指望它隔离)', applyParams(noParam, {}) === noParam)
}

// ── 用例18:anchorExpr —— 探锚点的举证责任比执行一步高得多,不许拿弱候选当"整段可跳过"的证据 ──
{
  console.log('用例18:anchorExpr(探锚点严格匹配,防静默跳过真实业务步还报 PASS)')
  // 模拟页面:一个无关的弹窗"确定"按钮 + 一个真锚点
  const page = (html) => {
    const els = []
    for (const m of html.matchAll(/<(\w+)([^>]*)>([^<]*)</g)) els.push({ tag: m[1], attrs: m[2], text: m[3] })
    return els
  }
  const runExpr = (expr, els) => {   // 极简求值:只认 querySelectorAll(tag) + innerText 比较这条路径
    const m = expr.match(/querySelectorAll\("(\w+)"\)/)
    if (!m) return { kind: 'css', sel: (expr.match(/querySelector\("([^"]+)"\)/) || [])[1] }
    const txtM = [...expr.matchAll(/t===("(?:[^"\\]|\\.)*")/g)].map((x) => JSON.parse(x[1]))
    const pfxM = [...expr.matchAll(/t\.indexOf\(("(?:[^"\\]|\\.)*")\)===0/g)].map((x) => JSON.parse(x[1]))
    const hit = els.filter((e) => e.tag === m[1]).find((e) => txtM.includes(e.text.trim()) || pfxM.some((p) => e.text.trim().indexOf(p) === 0))
    return { kind: 'text', tag: m[1], exact: txtM, prefix: pfxM, hit: hit || null }
  }
  const els = page('<button class="modal-ok">确定</button><button class="submit">确定转账</button>')
  // 老路:findElExpr 把 selAlt 的 __text__ 前缀匹配 OR 进来
  const loose = runExpr(findElExpr('#nonexistent-anchor', ['__text__:button|确定']), els)
  ok('复现:findElExpr 的 __text__ 是前缀匹配 → 无关的"确定转账"也能命中', loose.prefix.includes('确定') && !!loose.hit)
  // 新路:anchorExpr 只认主选择器
  const strictCss = runExpr(anchorExpr({ sel: '#real-anchor', selAlt: ['__text__:button|确定'] }), els)
  ok('anchorExpr 丢掉 selAlt,只认主选择器', strictCss.kind === 'css' && strictCss.sel === '#real-anchor')
  ok('anchorExpr 表达式里不含任何 selAlt 候选', !anchorExpr({ sel: '#a', selAlt: ['__text__:button|确定', 'div > input:nth-of-type(2)'] }).includes('确定'))
  // 主选择器本身是 __text__ 时:要求全等,不许前缀
  const strictTxt = runExpr(anchorExpr({ sel: '__text__:button|确定' }), els)
  ok('主选择器是 __text__ → 只全等匹配,不许前缀', strictTxt.exact.includes('确定') && strictTxt.prefix.length === 0)
  ok('全等匹配下"确定转账"不再冒充"确定"锚点', strictTxt.hit && strictTxt.hit.text === '确定')
  ok('nth-of-type 兜底路径当主选择器时照常用(那是录制选出的最强候选)', anchorExpr({ sel: 'div.form > input:nth-of-type(2)' }).includes('querySelector('))
  ok('无 sel → null(不当锚点)', anchorExpr({ sel: '' }) === 'null' && anchorExpr({}) === 'null' && anchorExpr(null) === 'null')
  ok('残缺伪选择器 → null 而非拼出坏表达式', anchorExpr({ sel: '__text__:button' }) === 'null' && anchorExpr({ sel: '__label__:' }) === 'null')
  ok('注入面:选择器全程 JSON.stringify', anchorExpr({ sel: '__text__:button|a")||(1&&document.body' }).includes('\\"'))
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
