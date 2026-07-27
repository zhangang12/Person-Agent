// AGENTS.md 生成器自测(零依赖,不连真 serve)
// 测什么:① 检测器(node+vitest / maven+spring / python+pytest / go / Makefile)② 草稿内容(命令/待确认/无编造)
//        ③ 写入:新建创建 / 人工旧文件备份+追加 / 我们生成的段重复写入幂等替换
// 跑法: node scripts/agent-md-selftest.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n) } else { fail++; console.log('  ✗ ' + n) } }

const handlers = {}
require('../src/agent-md.js')({ app: { getPath: () => os.tmpdir() }, path, fs, ipcMain: { handle: (n, f) => { handlers[n] = f } }, log: () => {} })
const draft = (dir) => handlers['agent-md-draft'](null, dir)
const write = (dir, content) => handlers['agent-md-write'](null, { dir, content })

function mkproj(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-md-' + name + '-'))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

// ── ① Node + vitest 项目 ──
{
  const dir = mkproj('node', {
    'package.json': JSON.stringify({ name: 'web-app', scripts: { build: 'vite build', dev: 'vite', test: 'vitest run', typecheck: 'tsc --noEmit' }, devDependencies: { vitest: '^4.0.0', vue: '^3.0.0' } }),
  })
  const r = draft(dir)
  ok('node 项目起草成功', r.ok === true)
  ok('构建/测试/dev 命令检出', r.draft.includes('`npm run build`') && r.draft.includes('`npm test`') && r.draft.includes('`npm run dev`'))
  ok('vitest 单测语法检出', r.draft.includes('npx vitest run <文件路径>'))
  ok('含前端自验段(vue 栈)', r.draft.includes('## 前端自验'))
  ok('含验证纪律(不许声称完成)', r.draft.includes('不许声称完成'))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── ② Maven + Spring 项目 ──
{
  const dir = mkproj('maven', { 'pom.xml': '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>', 'mvnw': '#!/bin/sh' })
  const r = draft(dir)
  ok('maven 项目起草成功', r.ok === true)
  ok('mvnw 命令检出(./mvnw test)', r.draft.includes('`./mvnw test`'))
  ok('单测语法 -Dtest=<类名>', r.draft.includes('-Dtest=<类名> test'))
  ok('spring-boot:run 检出', r.draft.includes('spring-boot:run'))
  ok('含后端自验段(java 栈)', r.draft.includes('## 后端自验'))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── ③ Python + pytest / Go 项目 ──
{
  const dir = mkproj('python', { 'pytest.ini': '[pytest]\n' })
  const r = draft(dir)
  ok('pytest 检出', r.draft.includes('`pytest`') && r.draft.includes("pytest -k '<关键字>'"))
  fs.rmSync(dir, { recursive: true, force: true })
  const dir2 = mkproj('go', { 'go.mod': 'module x\n' })
  const r2 = draft(dir2)
  ok('go test 检出', r2.draft.includes('`go test ./...`') && r2.draft.includes('go test -run <名字>'))
  fs.rmSync(dir2, { recursive: true, force: true })
}

// ── ④ 检测不到的不编造(写待确认) ──
{
  const dir = mkproj('empty', { 'src/x.txt': 'hello' })
  const r = draft(dir)
  ok('空项目也起草成功(不炸)', r.ok === true)
  ok('构建命令缺席 → 待确认不编造', r.draft.includes('（待确认'))
  ok('无前端段(无 dev 线索)', !r.draft.includes('## 前端自验'))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── ⑤ 写入:新建 → 人工旧文件备份+追加 → 我们的段幂等替换 ──
{
  const dir = mkproj('write', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^4.0.0' } }) })
  const d = draft(dir)
  const w1 = write(dir, d.draft)
  ok('新建写入(created)', w1.ok && w1.action === 'created' && fs.existsSync(path.join(dir, 'AGENTS.md')))
  ok('写入内容带标记注释', fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('<!-- BocomHermes:agents-md -->'))

  const w2 = write(dir, d.draft + '\n(手改一笔)')
  ok('我们生成的段:重复写入幂等替换(replaced-section)', w2.ok && w2.action === 'replaced-section')
  ok('替换后包含手改内容', fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('手改一笔'))

  // 人工旧文件:先写入一个不带标记的人工版
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 人工说明书\n别动我的内容\n')
  const w3 = write(dir, d.draft)
  ok('人工旧文件:备份+追加(appended)', w3.ok && w3.action === 'appended' && w3.backup && fs.existsSync(w3.backup))
  const final = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
  ok('追加模式保人工内容+生成段在尾部', final.startsWith('# 人工说明书') && final.includes('<!-- BocomHermes:agents-md -->') && final.indexOf('人工说明书') < final.indexOf('BocomHermes:agents-md'))
  ok('备份内容与人工版一致', fs.readFileSync(w3.backup, 'utf8') === '# 人工说明书\n别动我的内容\n')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── ⑥ autoEnsure 自动插入:无文件直接生成 / 人工文件不碰 / 我们的段自动刷新 ──
{
  const init = require('../src/agent-md.js')
  const inst = init({ app: { getPath: () => os.tmpdir() }, path, fs, ipcMain: { handle: () => {} }, log: () => {} })
  // 无文件 → 直接生成
  const d1 = mkproj('auto1', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^4.0.0' } }) })
  const r1 = inst.autoEnsure(d1)
  ok('autoEnsure 无文件 → created', r1.ok && r1.action === 'created' && fs.existsSync(path.join(d1, 'AGENTS.md')))
  // 我们的段 → 自动刷新(幂等)
  fs.writeFileSync(path.join(d1, 'AGENTS.md'), '<!-- BocomHermes:agents-md -->\n旧内容\n')
  const r2 = inst.autoEnsure(d1)
  const body2 = fs.readFileSync(path.join(d1, 'AGENTS.md'), 'utf8')
  ok('autoEnsure 我们的段 → 幂等刷新(replaced-section)', r2.ok && r2.action === 'replaced-section' && !body2.includes('旧内容') && body2.includes('npm test'))
  // 人工文件 → 不碰(skipped)
  const d2 = mkproj('auto2', { 'AGENTS.md': '# 人工写的,别碰\n' })
  const r3 = inst.autoEnsure(d2)
  ok('autoEnsure 人工文件 → 跳过不碰', r3.ok && r3.skipped === 'human-file' && fs.readFileSync(path.join(d2, 'AGENTS.md'), 'utf8') === '# 人工写的,别碰\n')
  fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true })
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
