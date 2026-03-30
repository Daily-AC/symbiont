import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/core/session.ts'
import { EventStore } from '../src/core/event-store.ts'
import { MemoryDB } from '../src/memory/db.ts'

/**
 * Tests for the Router.getOrCreateSession recovery logic.
 *
 * Since Router has heavy dependencies (SymbiontCore, Broker, etc.), we extract and
 * test the key decision logic that the 3 bug fixes rely on:
 *   Bug 2: active sessions should also be recoverable (not just sleeping)
 *   Bug 3: ccSessionId null → pass undefined to broker (not null)
 *
 * We test with real SessionManager + EventStore and stub the rest.
 */
describe('Router session recovery logic', () => {
  let dir: string
  let sessionMgr: SessionManager
  let eventStore: EventStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-test-'))
    sessionMgr = new SessionManager(dir)
    const db = new MemoryDB(join(dir, 'memory-sqlite'))
    eventStore = new EventStore(db)
  })

  /**
   * Simulate the recovery decision from router.getOrCreateSession lines 69-98.
   * Returns the options that would be passed to broker.getOrCreate.
   * Also returns logType to mirror the session-recovered vs session-created distinction.
   */
  function simulateRecovery(sessionKey: string) {
    const latestSession = sessionMgr.getLatestBySessionKey(sessionKey)
      ?? sessionMgr.getLatest()

    if (latestSession && (latestSession.state === 'sleeping' || latestSession.state === 'active')) {
      sessionMgr.wake(latestSession.sessionId)

      const events = eventStore.getLatestSummary(latestSession.sessionId, 10)
      const recoveryPrompt = events.length > 0
        ? `[recovery context]`
        : undefined

      return {
        recovered: true,
        logType: 'session-recovered' as const,
        siaSessionId: latestSession.sessionId,
        previousState: latestSession.state,
        brokerOptions: {
          sessionId: latestSession.ccSessionId ?? undefined,  // Bug 3: null → undefined
          recoveryPrompt,
        },
      }
    }

    // No session to recover — would create new
    return { recovered: false, logType: 'session-created' as const }
  }

  // ---- Bug 2 fix: active state sessions are recoverable ----

  it('recovers a sleeping session', () => {
    const s = sessionMgr.create('persona', 'chat-1')
    sessionMgr.updateCCSessionId(s.sessionId, 'cc-123')
    sessionMgr.sleep(s.sessionId, 'chat-1')

    const result = simulateRecovery('chat-1')
    assert.ok(result.recovered, 'sleeping session should be recovered')
    assert.equal(result.siaSessionId, s.sessionId)
    assert.equal(result.brokerOptions!.sessionId, 'cc-123')
  })

  it('recovers an active session (Bug 2 fix — crash left session active)', () => {
    const s = sessionMgr.create('persona', 'chat-1')
    sessionMgr.updateCCSessionId(s.sessionId, 'cc-456')
    // Session stays active (simulates crash — never got to sleep)

    const result = simulateRecovery('chat-1')
    assert.ok(result.recovered, 'active session should also be recovered')
    assert.equal(result.siaSessionId, s.sessionId)
    assert.equal(result.brokerOptions!.sessionId, 'cc-456')
  })

  // ---- Bug 3 fix: null ccSessionId → undefined (not pass null to broker) ----

  it('passes undefined sessionId to broker when ccSessionId is null (Bug 3 fix)', () => {
    // Session created but CC never assigned (crash before updateCCSessionId)
    const s = sessionMgr.create('persona', 'chat-1')
    // Don't call updateCCSessionId — ccSessionId stays null

    const result = simulateRecovery('chat-1')
    assert.ok(result.recovered)
    assert.equal(result.brokerOptions!.sessionId, undefined,
      'null ccSessionId should become undefined, not null')
  })

  // ---- Recovery with event context ----

  it('includes recovery prompt when events exist', () => {
    const s = sessionMgr.create('persona', 'chat-1')
    sessionMgr.updateCCSessionId(s.sessionId, 'cc-789')
    sessionMgr.sleep(s.sessionId, 'chat-1')

    // Add some events
    eventStore.append({ type: 'chat', sessionId: s.sessionId, data: { role: 'user', content: 'hello' } })
    eventStore.append({ type: 'chat', sessionId: s.sessionId, data: { role: 'assistant', content: 'hi' } })

    const result = simulateRecovery('chat-1')
    assert.ok(result.recovered)
    assert.ok(result.brokerOptions!.recoveryPrompt, 'should have recovery prompt when events exist')
  })

  it('no recovery prompt when no events', () => {
    const s = sessionMgr.create('persona', 'chat-1')
    sessionMgr.sleep(s.sessionId, 'chat-1')

    const result = simulateRecovery('chat-1')
    assert.ok(result.recovered)
    assert.equal(result.brokerOptions!.recoveryPrompt, undefined)
  })

  // ---- Fallback to getLatest when no session matches key ----

  it('falls back to getLatest when no session matches the key', () => {
    const s = sessionMgr.create('persona', 'other-key')
    sessionMgr.updateCCSessionId(s.sessionId, 'cc-fallback')
    sessionMgr.sleep(s.sessionId, 'other-key')

    // Query with a different key — getLatestBySessionKey returns undefined,
    // but getLatest returns the session because it has a ccSessionId
    const result = simulateRecovery('new-key')
    assert.ok(result.recovered)
    assert.equal(result.siaSessionId, s.sessionId)
  })

  // ---- Log type distinction: session-recovered vs session-created ----

  it('logs session-recovered (not session-created) when recovering a sleeping session', () => {
    const s = sessionMgr.create('persona', 'chat-1')
    sessionMgr.updateCCSessionId(s.sessionId, 'cc-123')
    sessionMgr.sleep(s.sessionId, 'chat-1')

    const result = simulateRecovery('chat-1')
    assert.equal(result.logType, 'session-recovered', 'recovery path should log session-recovered')
    assert.notEqual(result.logType, 'session-created', 'recovery path must NOT log session-created')
  })

  it('logs session-recovered when recovering an active (crash-leftover) session', () => {
    const s = sessionMgr.create('persona', 'chat-1')
    sessionMgr.updateCCSessionId(s.sessionId, 'cc-456')
    // Session stays active — simulates crash

    const result = simulateRecovery('chat-1')
    assert.equal(result.logType, 'session-recovered')
    assert.equal(result.previousState, 'active', 'should record previous state as active')
  })

  it('logs session-created when no session exists to recover', () => {
    // No prior sessions created
    const result = simulateRecovery('brand-new-key')
    assert.equal(result.logType, 'session-created', 'new session path should log session-created')
    assert.equal(result.recovered, false)
  })
})

/**
 * Tests that Router.stop() removes broker-level listeners
 * (setupUsageListener + setupLateResultListener) to prevent leaks.
 */
describe('Router listener cleanup on stop()', () => {
  it('removes usage and late-result listeners from broker on stop()', async () => {
    // Minimal broker mock that tracks on/off calls
    const registered: Array<{ event: string; handler: Function }> = []
    const removed: Array<{ event: string; handler: Function }> = []
    const fakeBroker = {
      on(event: string, handler: Function) { registered.push({ event, handler }) },
      off(event: string, handler: Function) { removed.push({ event, handler }) },
    }

    // Minimal core mock — only needs broker, logger, sessionManager, settler, shutdown
    const fakeCore = {
      broker: fakeBroker,
      logger: { info() {}, error() {}, warn() {} },
      sessionManager: { sleep() {} },
      settler: { recordUsage() {}, getUsagePercent() { return 0 }, shouldSettle() { return false } },
      shutdown: async () => {},
    }

    // Import Router and instantiate with fake core
    const { Router } = await import('../src/core/router.ts')
    const router = new (Router as any)(fakeCore)

    // Constructor should have registered 2 broker-level listeners
    const usageReg = registered.filter(r => r.event === 'instance.usage')
    const lateReg = registered.filter(r => r.event === 'instance.late-result')
    assert.equal(usageReg.length, 1, 'should register instance.usage listener')
    assert.equal(lateReg.length, 1, 'should register instance.late-result listener')

    // stop() should remove them
    await router.stop()

    const usageOff = removed.filter(r => r.event === 'instance.usage')
    const lateOff = removed.filter(r => r.event === 'instance.late-result')
    assert.equal(usageOff.length, 1, 'should remove instance.usage listener on stop()')
    assert.equal(lateOff.length, 1, 'should remove instance.late-result listener on stop()')

    // The same handler reference should be used for on and off
    assert.equal(usageOff[0].handler, usageReg[0].handler, 'should remove the exact same usage handler')
    assert.equal(lateOff[0].handler, lateReg[0].handler, 'should remove the exact same late-result handler')
  })
})
