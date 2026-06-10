// 测试桩：替代依赖 electron 的模块
export function getDriver() {
  throw new Error('stub')
}
export function isCancelled() {
  return false
}
export function finishJob() {}
export function reportProgress() {}
