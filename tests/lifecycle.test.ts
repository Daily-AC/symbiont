import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupLifecycle } from '../src/core/lifecycle.ts'

describe('setupLifecycle', () => {
  // Track listeners we add so we can clean up
  const addedListeners: { event: string; fn: Function }[] = []
  let origOn: typeof process.on
  let origExit: typeof process.exit

  beforeEach(() => {
    origOn = process.on.bind(process)
    origExit = process.exit

    // Override process.on to track registered listeners
    const realOn = process.on.bind(process)
    // @ts-expect-error - monkey-patching for test
    process.on = (event: string, fn: Function) => {
      addedListeners.push({ event, fn: fn as Function })
      return realOn(event, fn as any)
    }

    // Mock process.exit to prevent actually exiting
    // @ts-expect-error - mock
    process.exit = (_code?: number) => { /* no-op */ }
  })

  afterEach(() => {
    // Remove all listeners we added
    for (const { event, fn } of addedListeners) {
      process.removeListener(event, fn as any)
    }
    addedListeners.length = 0
    process.exit = origExit
    process.on = origOn
  })

  it('registers SIGINT, SIGTERM, uncaughtException, and unhandledRejection handlers', () => {
    const stubRouter = { stop: async () => {} }
    const stubLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    setupLifecycle(stubRouter as any, stubLogger as any)

    const events = addedListeners.map(l => l.event)
    assert.ok(events.includes('SIGINT'), 'should register SIGINT')
    assert.ok(events.includes('SIGTERM'), 'should register SIGTERM')
    assert.ok(events.includes('uncaughtException'), 'should register uncaughtException')
    assert.ok(events.includes('unhandledRejection'), 'should register unhandledRejection')
  })

  // ---- Bug 1 fix: uncaughtException calls router.stop() ----

  it('uncaughtException handler calls router.stop()', async () => {
    let stopCalled = false
    const stubRouter = {
      stop: async () => { stopCalled = true },
    }
    const stubLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    setupLifecycle(stubRouter as any, stubLogger as any)

    // Find the uncaughtException handler
    const handler = addedListeners.find(l => l.event === 'uncaughtException')
    assert.ok(handler, 'uncaughtException handler should be registered')

    // Invoke it directly with a fake error
    handler!.fn(new Error('test crash'))

    // router.stop() is async, give it a tick
    await new Promise(resolve => setTimeout(resolve, 50))

    assert.ok(stopCalled, 'router.stop() should be called on uncaughtException')
  })

  it('unhandledRejection handler logs the reason', () => {
    let loggedReason: string | undefined
    const stubRouter = { stop: async () => {} }
    const stubLogger = {
      info: () => {},
      warn: () => {},
      error: (_mod: string, _evt: string, data?: any) => {
        if (_evt === 'unhandled-rejection') loggedReason = data?.reason
      },
    }

    setupLifecycle(stubRouter as any, stubLogger as any)

    const handler = addedListeners.find(l => l.event === 'unhandledRejection')
    assert.ok(handler)

    handler!.fn('some rejection reason')
    assert.equal(loggedReason, 'some rejection reason')
  })
})
