// 自测:src/writescope.js(分片写归属)—— 解析格式、范围匹配、越界判定。跑法:npm run scope:test
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { parseWriteScope, matchScope } = require('../src/writescope.js')

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

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
