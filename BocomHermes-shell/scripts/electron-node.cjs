// 用 Electron 内嵌 Node 跑脚本:系统 Node 20.15 不支持 require(esm)(vitest 4 / vite 7 需要 20.19+),
// Electron 34 内嵌 Node v20.19.1 刚好够。跨平台:require('electron') 解析出二进制绝对路径。
// 用法:node scripts/electron-node.cjs <script> [args...](ui:test / ui:build / ui:typecheck 共用)
'use strict'
const { spawnSync } = require('child_process')
const electron = require('electron')
const args = process.argv.slice(2)
if (!args.length) { console.error('usage: node scripts/electron-node.cjs <script> [args...]'); process.exit(2) }
const r = spawnSync(electron, args, { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
process.exit(r.status == null ? 1 : r.status)
