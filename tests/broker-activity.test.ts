// tests/broker-activity.test.ts — CCBroker trackActivity / summarizeToolUse 测试
//
// 跳过说明：
// CCBroker.trackActivity 和 summarizeToolUse 都是 private 方法，
// 无法直接调用测试。CCBroker.spawn 需要实际的 CC CLI 进程，
// 无法在纯单元测试中使用。
//
// 可能的替代方案：
// 1. 将 summarizeToolUse 提取为独立 util 函数
// 2. 通过 broker.status() 间接验证（但 status 需要 spawn 后才有意义）
//
// 目前这些逻辑只能通过 e2e 测试覆盖（见 tests/e2e-*.test.ts）。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('CCBroker trackActivity', () => {
  test.skip('trackActivity is private — needs CC process to test indirectly', () => {
    // CCBroker.spawn() 需要实际安装的 CC CLI，无法在 CI/本地纯单元测试中运行。
    // trackActivity 通过 status() 暴露的 currentActivity 字段可验证，
    // 但 status() 在无活跃实例时返回 idle 状态，没有可测的 activity 数据。
  })

  test.skip('summarizeToolUse is private — cannot test directly', () => {
    // summarizeToolUse 是 CCBroker 的 private 方法，
    // TypeScript 的 private 修饰符在运行时可绕过（(broker as any).summarizeToolUse），
    // 但构造 CCBroker 本身就需要一系列 deps，且方法内部依赖实例状态，
    // 提取为独立函数是更好的做法。
  })
})
