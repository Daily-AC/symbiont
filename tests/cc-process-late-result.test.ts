import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CCProcess } from '../src/core/cc-process.ts'

describe('CCProcess late-result handling', () => {
  it('should emit late-result when result arrives after pendingPrompt resolved', () => {
    const cc = new CCProcess()
    const routeMessage = (cc as any).routeMessage.bind(cc)
    const lateResults: string[] = []
    cc.on('late-result', (text: string) => lateResults.push(text))

    // 模拟 sendPrompt 设置 pendingPrompt
    ;(cc as any).pendingPrompt = {
      resolve: () => {},
      reject: () => {},
      result: '',
      textParts: [],
    }

    // 第一个 result → resolve pendingPrompt
    routeMessage({ type: 'result', result: 'first reply' })
    assert.equal((cc as any).pendingPrompt, null, 'pendingPrompt should be null after first result')
    assert.equal(lateResults.length, 0, 'no late-result on first result')

    // 第二个 result → pendingPrompt 已 null → emit late-result
    routeMessage({ type: 'result', result: 'second reply' })
    assert.equal(lateResults.length, 1)
    assert.equal(lateResults[0], 'second reply')

    // 第三个 result → 再次 emit
    routeMessage({ type: 'result', result: 'third reply' })
    assert.equal(lateResults.length, 2)
    assert.equal(lateResults[1], 'third reply')
  })

  it('should not emit late-result for empty result', () => {
    const cc = new CCProcess()
    const routeMessage = (cc as any).routeMessage.bind(cc)
    const lateResults: string[] = []
    cc.on('late-result', (text: string) => lateResults.push(text))

    // pendingPrompt 已经是 null（没有 pending 请求）
    routeMessage({ type: 'result', result: '' })
    assert.equal(lateResults.length, 0)

    routeMessage({ type: 'result', result: undefined })
    assert.equal(lateResults.length, 0)
  })

  it('should not call processNextInQueue on late-result', () => {
    const cc = new CCProcess()
    const routeMessage = (cc as any).routeMessage.bind(cc)
    let processNextCalled = 0
    const origProcess = (cc as any).processNextInQueue.bind(cc)
    ;(cc as any).processNextInQueue = () => { processNextCalled++; origProcess() }

    // 设置 pendingPrompt
    ;(cc as any).pendingPrompt = {
      resolve: () => {},
      reject: () => {},
      result: '',
      textParts: [],
    }

    // 第一个 result → processNextInQueue 被调用
    routeMessage({ type: 'result', result: 'first' })
    assert.equal(processNextCalled, 1, 'processNextInQueue called on first result')

    // 第二个 result (late) → processNextInQueue 不应再被调用
    routeMessage({ type: 'result', result: 'late' })
    assert.equal(processNextCalled, 1, 'processNextInQueue NOT called on late-result')
  })

  it('should resolve pendingPrompt with first result text', () => {
    const cc = new CCProcess()
    const routeMessage = (cc as any).routeMessage.bind(cc)
    let resolvedResult = ''

    ;(cc as any).pendingPrompt = {
      resolve: (v: any) => { resolvedResult = v.result },
      reject: () => {},
      result: '',
      textParts: ['fallback text'],
    }

    routeMessage({ type: 'result', result: 'actual result' })
    assert.equal(resolvedResult, 'actual result')
  })

  it('should use textParts as fallback when result is empty', () => {
    const cc = new CCProcess()
    const routeMessage = (cc as any).routeMessage.bind(cc)
    let resolvedResult = ''

    ;(cc as any).pendingPrompt = {
      resolve: (v: any) => { resolvedResult = v.result },
      reject: () => {},
      result: '',
      textParts: ['part1 ', 'part2'],
    }

    routeMessage({ type: 'result', result: '' })
    assert.equal(resolvedResult, 'part1 part2')
  })
})

describe('CCProcess WS close handling', () => {
  it('should reject pendingPrompt on WS close when no partial result', () => {
    const cc = new CCProcess()
    let rejectedError: Error | null = null

    ;(cc as any).pendingPrompt = {
      resolve: () => { assert.fail('should not resolve') },
      reject: (err: Error) => { rejectedError = err },
      result: '',
      textParts: [],
    }
    ;(cc as any).messageQueue = []

    // 模拟 WS close
    const wsCloseHandler = () => {
      ;(cc as any).ws = null
      const pending = (cc as any).pendingPrompt
      if (pending) {
        ;(cc as any).pendingPrompt = null
        const partialResult = pending.result || pending.textParts.join('')
        if (partialResult) {
          pending.resolve({ result: partialResult, sessionId: null })
        } else {
          pending.reject(new Error('WebSocket closed while waiting for CC response'))
        }
      }
    }
    wsCloseHandler()

    assert.ok(rejectedError, 'should have rejected')
    assert.match(rejectedError!.message, /WebSocket closed/)
  })

  it('should resolve pendingPrompt with partial result on WS close', () => {
    const cc = new CCProcess()
    let resolvedResult = ''

    ;(cc as any).pendingPrompt = {
      resolve: (v: any) => { resolvedResult = v.result },
      reject: () => { assert.fail('should not reject') },
      result: 'partial answer',
      textParts: [],
    }
    ;(cc as any).messageQueue = []

    // 模拟 WS close — 有 partial result 时应 resolve
    const pending = (cc as any).pendingPrompt
    ;(cc as any).pendingPrompt = null
    const partialResult = pending.result || pending.textParts.join('')
    if (partialResult) {
      pending.resolve({ result: partialResult, sessionId: null })
    }

    assert.equal(resolvedResult, 'partial answer')
  })

  it('should reject queued messages on WS close', () => {
    const cc = new CCProcess()
    const rejectedErrors: Error[] = []

    ;(cc as any).pendingPrompt = null
    ;(cc as any).messageQueue = [
      { prompt: 'msg1', resolve: () => {}, reject: (e: Error) => rejectedErrors.push(e) },
      { prompt: 'msg2', resolve: () => {}, reject: (e: Error) => rejectedErrors.push(e) },
    ]

    // 模拟 WS close 清理队列
    for (const q of (cc as any).messageQueue) {
      q.reject(new Error('WebSocket closed'))
    }
    ;(cc as any).messageQueue = []

    assert.equal(rejectedErrors.length, 2)
    assert.match(rejectedErrors[0].message, /WebSocket closed/)
    assert.equal((cc as any).messageQueue.length, 0)
  })

  it('should not double-resolve when WS close and process exit both fire', () => {
    const cc = new CCProcess()
    let resolveCount = 0

    ;(cc as any).pendingPrompt = {
      resolve: () => { resolveCount++ },
      reject: () => {},
      result: 'answer',
      textParts: [],
    }

    // WS close 先触发
    const pending1 = (cc as any).pendingPrompt
    ;(cc as any).pendingPrompt = null
    pending1.resolve({ result: pending1.result, sessionId: null })

    // process exit 后触发 — pendingPrompt 已经是 null
    const pending2 = (cc as any).pendingPrompt
    assert.equal(pending2, null, 'pendingPrompt should be null')
    // 不会再 resolve

    assert.equal(resolveCount, 1, 'should only resolve once')
  })
})
