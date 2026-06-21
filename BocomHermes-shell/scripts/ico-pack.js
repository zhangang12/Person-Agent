'use strict'
// 零依赖 ICO 打包：把若干 PNG 直接打进 .ico（PNG-in-ICO，Windows Vista+ 原生支持）。
// 用法：node scripts/ico-pack.js out.ico big.png ... small.png   （建议按从大到小传）
const fs = require('fs')
const [out, ...pngs] = process.argv.slice(2)
if (!out || !pngs.length) { console.error('usage: node ico-pack.js out.ico a.png b.png ...'); process.exit(1) }

const imgs = pngs.map((p) => {
  const b = fs.readFileSync(p)
  // PNG: 8 字节签名 + IHDR(4 长度 +4 'IHDR' + width(4) + height(4) …) → width@16, height@20
  return { b, w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
})

const count = imgs.length
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)      // reserved
header.writeUInt16LE(1, 2)      // type=1 (icon)
header.writeUInt16LE(count, 4)  // 图片数

const dir = Buffer.alloc(16 * count)
let offset = 6 + 16 * count
imgs.forEach((im, i) => {
  const e = i * 16
  dir.writeUInt8(im.w >= 256 ? 0 : im.w, e + 0)   // 256 用 0 表示
  dir.writeUInt8(im.h >= 256 ? 0 : im.h, e + 1)
  dir.writeUInt8(0, e + 2)        // 调色板色数
  dir.writeUInt8(0, e + 3)        // reserved
  dir.writeUInt16LE(1, e + 4)     // color planes
  dir.writeUInt16LE(32, e + 6)    // bits per pixel
  dir.writeUInt32LE(im.b.length, e + 8)
  dir.writeUInt32LE(offset, e + 12)
  offset += im.b.length
})

fs.writeFileSync(out, Buffer.concat([header, dir, ...imgs.map((i) => i.b)]))
console.log('wrote ' + out + ' (' + count + ' sizes: ' + imgs.map((i) => i.w).join(',') + ')')
