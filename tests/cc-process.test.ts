import { describe, it } from 'node:test'
import assert from 'node:assert'
import { CCProcess } from '../src/core/cc-process.ts'

describe('CCProcess', () => {
  it('should initialize without session id', () => {
    const cc = new CCProcess()
    // CCProcess no longer has getState, it's stateless per-query now
    assert.ok(cc)
  })

  it('should accept session id via options', () => {
    const cc = new CCProcess({ sessionId: 'test-123' })
    assert.ok(cc)
  })

  it('should allow setting session id', () => {
    const cc = new CCProcess()
    cc.setSessionId('new-id')
    assert.ok(cc)
  })

  it('should emit usage event from assistant + result messages', async () => {
    const cc = new CCProcess()
    let emittedUsage: { inputTokens: number; contextWindow: number } | null = null
    cc.on('usage', (usage: { inputTokens: number; contextWindow: number }) => {
      emittedUsage = usage
    })

    const routeMessage = (cc as any).routeMessage.bind(cc)

    // 1. assistant 消息带 usage（单次 API 调用 = 当前上下文大小）
    routeMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 3, cache_creation_input_tokens: 200000, cache_read_input_tokens: 140000, output_tokens: 100 },
      },
    })

    // 2. result 消息带 modelUsage.contextWindow
    routeMessage({
      type: 'result',
      result: 'test response',
      modelUsage: {
        'claude-opus-4-6': { contextWindow: 1000000 },
      },
    })

    assert.ok(emittedUsage, 'usage event should have been emitted')
    // 3 + 200000 + 140000 = 340003
    assert.strictEqual(emittedUsage!.inputTokens, 340003)
    assert.strictEqual(emittedUsage!.contextWindow, 1000000)
  })

  it('should not emit usage event when tokens are zero', () => {
    const cc = new CCProcess()
    let emitted = false
    cc.on('usage', () => { emitted = true })

    const routeMessage = (cc as any).routeMessage.bind(cc)
    routeMessage({
      type: 'result',
      result: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    assert.strictEqual(emitted, false)
  })

  it('should not emit usage event when no usage data in result', () => {
    const cc = new CCProcess()
    let emitted = false
    cc.on('usage', () => { emitted = true })

    const routeMessage = (cc as any).routeMessage.bind(cc)
    routeMessage({
      type: 'result',
      result: 'test',
    })

    assert.strictEqual(emitted, false)
  })

  it('should not emit usage without prior assistant message', () => {
    const cc = new CCProcess()
    let emitted = false
    cc.on('usage', () => { emitted = true })

    const routeMessage = (cc as any).routeMessage.bind(cc)
    // result without prior assistant → no usage event
    routeMessage({
      type: 'result',
      result: 'test',
      modelUsage: {
        'claude-opus-4-6': {
          contextWindow: 1000000,
        },
      },
    })

    assert.strictEqual(emitted, false)
  })
})
