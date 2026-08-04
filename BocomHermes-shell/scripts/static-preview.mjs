// 构建产物静态预览服务(零依赖)。
// 本项目的 UI 是 vite-plugin-singlefile 出的【单文件 HTML】,正常运行走 Electron 的 file://,
// 所以仓里没有任何 HTTP dev server —— ui:dev 只是 watch 构建,npm start 起的是 Electron。
// 但产物本身零外部请求,用 http 端上也能渲染,便于:
//   · 在浏览器面板里看组件实验室(lab.html)/ 对话卡骨架(chat.html)的样式
//   · 给浏览器 E2E 一个稳定、离线、不碰真业务系统的靶子页
// 注意:这些页面没有 window.BocomHermes 桥,交互是空的 —— 只看样式与结构,别当功能验收。
// 用法: node scripts/static-preview.mjs [--port 5199] [--dir ui/dist]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }
const port = +argOf('--port', '5199') || 5199
const root = path.resolve(repo, argOf('--dir', 'ui/dist'))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

const server = http.createServer((req, res) => {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { rel = '/' }
  if (rel === '/' || rel === '') {
    // 目录页:列出可预览的页面,省得记文件名
    let files = []
    try { files = fs.readdirSync(root).filter((f) => f.endsWith('.html')).sort() } catch {}
    const li = files.map((f) => `<li><a href="/${f}">${f}</a></li>`).join('')
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(`<meta charset="utf-8"><title>BocomHermes 构建产物预览</title>`
      + `<h1>构建产物预览</h1><p>目录:<code>${root}</code></p><ul>${li || '<li>(没有 html —— 先跑 npm run ui:build)</li>'}</ul>`)
    return
  }
  // 路径围栏:只许读 root 内的文件(realpath 后比对,防 .. 穿越与符号链接逃逸)
  const abs = path.resolve(root, '.' + rel)
  let real
  try { real = fs.realpathSync(abs) } catch { res.writeHead(404).end('not found'); return }
  if (real !== root && !real.startsWith(root + path.sep)) { res.writeHead(403).end('forbidden'); return }
  let st
  try { st = fs.statSync(real) } catch { res.writeHead(404).end('not found'); return }
  if (st.isDirectory()) { res.writeHead(404).end('not found'); return }
  res.writeHead(200, { 'content-type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream' })
  fs.createReadStream(real).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log('静态预览已启动: http://localhost:' + port + '  (根目录 ' + root + ')')
})
