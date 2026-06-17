import type { Capability } from "./types.js"

const reg = new Map<string, Capability>()

export function register(c: Capability) {
  if (reg.has(c.id)) throw new Error(`能力 id 重复：${c.id}`)
  reg.set(c.id, c)
}
export function get(id: string) { return reg.get(id) }
export function all() { return [...reg.values()] }
