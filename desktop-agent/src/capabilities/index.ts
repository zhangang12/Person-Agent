import { register } from "../registry.js"
import { review } from "./review.js"
import { locate } from "./locate.js"

// 扩展点：新增能力 = 在本目录加一个实现 Capability 的文件，并在此 register。
export function loadCapabilities() {
  register(review)
  register(locate)
}
