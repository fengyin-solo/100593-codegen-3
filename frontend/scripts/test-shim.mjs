// Node 测试环境垫片：localStorage 用内存 Map 模拟，window 兜底。
const mem = new Map()
globalThis.localStorage = {
  getItem: (key) => (mem.has(key) ? mem.get(key) : null),
  setItem: (key, value) => mem.set(key, String(value)),
  removeItem: (key) => mem.delete(key),
  clear: () => mem.clear(),
}
if (!globalThis.window) {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    setTimeout: (fn) => setTimeout(fn),
  }
} else {
  globalThis.window.localStorage = globalThis.localStorage
}
