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

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
