// 自测:src/writescope.js(分片写归属)—— 解析格式、范围匹配、越界判定。跑法:npm run scope:test
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { parseWriteScope, matchScope, bashWriteTargets, parseContract } = require('../src/writescope.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

console.log('用例1:解析写归属行')
{
  const g1 = '[orch:OC-ab12]\n分析采购模块\n写归属: backend/app/routers/purchase_mgmt_router.py, backend/app/models.py'
  const s1 = parseWriteScope(g1)
  ok('两行式 goal 解析出 2 项', s1.length === 2 && s1[0] === 'backend/app/routers/purchase_mgmt_router.py', s1)
  ok('无写归属行 → 空(不设闸)', parseWriteScope('分析 models 的业务逻辑').length === 0)
  ok('顿号/中文冒号/尾斜杠也认', parseWriteScope('写归属：src/a/, src/b、src/c/').join('|') === 'src/a|src/b|src/c', parseWriteScope('写归属：src/a/, src/b、src/c/'))
}

console.log('用例2:范围匹配')
{
  const scope = ['backend/app/routers', 'backend/app/models.py']
  ok('目录内文件命中', matchScope(scope, '/repo', 'backend/app/routers/sales_router.py') === true)
  ok('目录本身命中', matchScope(scope, '/repo', 'backend/app/routers') === true)
  ok('精确文件命中', matchScope(scope, '/repo', 'backend/app/models.py') === true)
  ok('同前缀兄弟文件不算(routers2 不蹭 routers)', matchScope(scope, '/repo', 'backend/app/routers2/x.py') === false)
  ok('越界文件拒绝', matchScope(scope, '/repo', 'backend/app/schemas.py') === false)
  ok('.. 逃逸拒绝', matchScope(scope, '/repo', '../secret/x.py') === false)
  ok('绝对路径在归属内也命中', matchScope(scope, '/repo', '/repo/backend/app/routers/a.py') === true)
  ok('空归属 → 全放行', matchScope([], '/repo', 'anything/at/all.py') === true)
}

console.log('用例3:bash 写目标提取(bash 写文件过归属闸)')
{
  ok('重定向 > 命中', bashWriteTargets('cat <<EOF > src/a.py\n...\nEOF').join() === 'src/a.py', bashWriteTargets('cat <<EOF > src/a.py'))
  ok('追加 >> 命中', bashWriteTargets('echo hi >> logs/b.txt').join() === 'logs/b.txt')
  ok('stderr 重定向 2> 不算写目标', bashWriteTargets('pytest 2> err.log').length === 0, bashWriteTargets('pytest 2> err.log'))
  ok('fd 复制 >& 不算', bashWriteTargets('echo x >&2').length === 0)
  ok('引号路径剥引号', bashWriteTargets('cat > "src/my file.py"').join() === 'src/my file.py', bashWriteTargets('cat > "src/my file.py"'))
  ok('tee / tee -a 命中', bashWriteTargets('echo x | tee -a out.log').join() === 'out.log', bashWriteTargets('echo x | tee -a out.log'))
  ok('sed -i 取末位目标(GNU)', bashWriteTargets("sed -i 's/a/b/' src/c.py").join() === 'src/c.py', bashWriteTargets("sed -i 's/a/b/' src/c.py"))
  ok('sed -i 带 macOS 备份后缀也命中', bashWriteTargets("sed -i '' 's/a/b/' src/d.py").join() === 'src/d.py', bashWriteTargets("sed -i '' 's/a/b/' src/d.py"))
  ok('复合命令多目标全收', bashWriteTargets('echo a > x.txt && echo b >> y.txt').join('|') === 'x.txt|y.txt', bashWriteTargets('echo a > x.txt && echo b >> y.txt'))
  ok('纯读命令无目标', bashWriteTargets('ls -la && grep -r foo src/').length === 0)
  ok('含 $/`/~ 的目标跳过(不硬猜)', bashWriteTargets('echo x > $OUT/f.txt; echo y > ~/g.txt').length === 0, bashWriteTargets('echo x > $OUT/f.txt; echo y > ~/g.txt'))
  // 引号内的 > 不是重定向(剥引号段再扫描):grep "a->b" / node -e "console.log('x>y')" 曾被误当写目标越界拒
  ok('双引号内的 > 不算(grep "a->b")', bashWriteTargets('grep "a->b" src/f.js').length === 0, bashWriteTargets('grep "a->b" src/f.js'))
  ok('嵌套引号内的 > 不算(node -e "...\'x>y\'...")', bashWriteTargets(`node -e "console.log('x>y')"`).length === 0, bashWriteTargets(`node -e "console.log('x>y')"`))
  ok('引号段剥了,引号外真重定向仍命中', bashWriteTargets('node -e "console.log(1)" > out.log').join() === 'out.log', bashWriteTargets('node -e "console.log(1)" > out.log'))
  // 空设备白名单:npm test > /dev/null(与 Windows NUL)惯用法不该被归属闸误杀
  ok('> /dev/null 不算写目标', bashWriteTargets('npm test > /dev/null 2>&1').length === 0, bashWriteTargets('npm test > /dev/null 2>&1'))
  ok('> NUL/nul(大小写不敏感)不算写目标', bashWriteTargets('npm test > NUL').length === 0 && bashWriteTargets('type x > nul').length === 0, bashWriteTargets('npm test > NUL'))
  // GNU sed 备份后缀 -i.bak(选项串带 .)也要认
  ok('sed -i.bak(GNU 备份后缀)命中', bashWriteTargets("sed -i.bak 's/a/b/' src/e.py").join() === 'src/e.py', bashWriteTargets("sed -i.bak 's/a/b/' src/e.py"))
}

console.log('用例4:契约签名解析(收官缺口核对)')
{
  const g = '[orch:OC-ab12]\n实现采购接口\n写归属: src/purchase.py\n契约: create_order(), class OrderSvc, GET /api/orders'
  const c = parseContract(g)
  ok('契约行解析出 3 个签名', c.length === 3, c)
  ok('尾括号剥掉(foo() → foo)', c[0] === 'create_order', c)
  ok('class/端点原样保留', c[1] === 'class OrderSvc' && c[2] === 'GET /api/orders', c)
  ok('无契约行 → 空(不设检)', parseContract('实现采购接口').length === 0)
  ok('中文冒号+顿号也认', parseContract('契约：fnA、fnB()').join('|') === 'fnA|fnB', parseContract('契约：fnA、fnB()'))
}

console.log('用例N:工具入参里的文件路径提取(别名表)—— fork 换个入参名不能让落盘全隐形')
{
  const { filePathOf, TOOL_PATH_KEYS } = require('../src/writescope.js')
  // 病灶:壳层好几处靠"偷看 write/edit 入参"拿落盘路径(编排产出清单/成果抽屉/edit 预检/read 水位),
  // 原来各处各写一串 `inp.filePath || inp.path || inp.filename`。opencode 用 filePath,
  // 但 Anthropic 系工具用 file_path,别的 fork 还有 target_file —— 换个名字就【全部隐形】:
  // 落盘明明成功,产出清单却是空的 → 编排判零产出 → 整节点重跑。
  ok('opencode 口径 filePath', filePathOf({ filePath: 'src/a.ts' }) === 'src/a.ts')
  ok('★Anthropic 口径 file_path(原来取不到)', filePathOf({ file_path: '/proj/docs/a.md' }) === '/proj/docs/a.md')
  ok('★target_file 也认', filePathOf({ target_file: 'docs/b.md' }) === 'docs/b.md')
  ok('path / file / filename 兼容', filePathOf({ path: 'p' }) === 'p' && filePathOf({ file: 'f' }) === 'f' && filePathOf({ filename: 'n' }) === 'n')
  ok('入参是 JSON 字符串也认(轮询通道会把 input 序列化)', filePathOf('{"file_path":"x.md"}') === 'x.md')
  ok('取不到给空串,不是 undefined/null(调用方都按空串判)', filePathOf({ foo: 1 }) === '' && filePathOf(null) === '' && filePathOf('不是json') === '')
  ok('空白值不算数(有键但没填 → 继续找下一个别名)', filePathOf({ filePath: '   ', file_path: 'real.md' }) === 'real.md')
  ok('两边空白裁掉', filePathOf({ filePath: '  a.md  ' }) === 'a.md')
  ok('按别名表顺序取第一个命中', filePathOf({ file_path: 'B', filePath: 'A' }) === 'A', TOOL_PATH_KEYS[0])

  // ★跨运行时契约:渲染端 import 不到 src/,只能各留一份实现 —— 两份别名表必须一字不差,
  //   否则会出现"主进程记到了产出、成果抽屉却看不见"这种各说各话(本仓踩过同类问题多次)。
  const fs2 = require('fs'), url = require('url')
  const ts = fs2.readFileSync(new URL('../ui-vue/src/chat/lib/tool.ts', import.meta.url), 'utf8')
  const m = ts.match(/export const TOOL_PATH_KEYS = \[([^\]]*)\]/)
  ok('渲染端也导出了 TOOL_PATH_KEYS', !!m)
  const uiKeys = m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : []
  ok('★两份别名表完全一致(主进程 vs 渲染端)', JSON.stringify(uiKeys) === JSON.stringify(TOOL_PATH_KEYS), { ui: uiKeys, main: TOOL_PATH_KEYS })
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
