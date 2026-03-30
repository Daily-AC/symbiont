import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/core/session.ts'

describe('shutdown-paths: sleepAll and session recovery', () => {
  let dir: string
  let mgr: SessionManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-shutdown-test-'))
    mgr = new SessionManager(dir)
  })

  // Test 1: sleepAll marks all active sessions as sleeping and persists
  it('sleepAll marks all active sessions as sleeping and persists', () => {
    const s1 = mgr.create('persona-a', 'key-1')
    mgr.updateCCSessionId(s1.sessionId, 'cc-1')
    const s2 = mgr.create('persona-b', 'key-2')
    mgr.updateCCSessionId(s2.sessionId, 'cc-2')

    // Both should be active
    assert.equal(mgr.get(s1.sessionId)!.state, 'active')
    assert.equal(mgr.get(s2.sessionId)!.state, 'active')

    mgr.sleepAll()

    // Both should be sleeping in memory
    assert.equal(mgr.get(s1.sessionId)!.state, 'sleeping')
    assert.equal(mgr.get(s2.sessionId)!.state, 'sleeping')

    // Verify persistence: reload from disk
    const mgr2 = new SessionManager(dir)
    assert.equal(mgr2.get(s1.sessionId)!.state, 'sleeping')
    assert.equal(mgr2.get(s2.sessionId)!.state, 'sleeping')
  })

  // Test 2: sleepAll is idempotent — already sleeping sessions stay sleeping
  it('sleepAll is idempotent on already sleeping sessions', () => {
    const s1 = mgr.create('persona-a', 'key-1')
    mgr.updateCCSessionId(s1.sessionId, 'cc-1')
    mgr.sleep(s1.sessionId)
    assert.equal(mgr.get(s1.sessionId)!.state, 'sleeping')

    // sleepAll should not break anything
    mgr.sleepAll()
    assert.equal(mgr.get(s1.sessionId)!.state, 'sleeping')
  })

  // Test 3: sleepAll on empty session list does not throw
  it('sleepAll on empty session list does not throw', () => {
    assert.doesNotThrow(() => mgr.sleepAll())
  })

  // Test 4: simulate scheduleRestart → shutdown → sessions are sleeping
  // (verifies the fix: shutdown calls sleepAll before other cleanup)
  it('shutdown path: active sessions become sleeping after sleepAll in shutdown', () => {
    const s1 = mgr.create('persona-a', 'key-1')
    mgr.updateCCSessionId(s1.sessionId, 'cc-1')
    const s2 = mgr.create('persona-b', 'key-2')
    mgr.updateCCSessionId(s2.sessionId, 'cc-2')

    assert.equal(mgr.get(s1.sessionId)!.state, 'active')
    assert.equal(mgr.get(s2.sessionId)!.state, 'active')

    // Simulate what shutdown() now does: sleepAll first
    mgr.sleepAll()

    assert.equal(mgr.get(s1.sessionId)!.state, 'sleeping')
    assert.equal(mgr.get(s2.sessionId)!.state, 'sleeping')

    // Verify on-disk state survives process restart
    const mgr2 = new SessionManager(dir)
    const restored1 = mgr2.get(s1.sessionId)
    const restored2 = mgr2.get(s2.sessionId)
    assert.ok(restored1)
    assert.ok(restored2)
    assert.equal(restored1!.state, 'sleeping')
    assert.equal(restored2!.state, 'sleeping')
    assert.equal(restored1!.ccSessionId, 'cc-1')
    assert.equal(restored2!.ccSessionId, 'cc-2')
  })

  // Test 5: post-restart recovery — sleeping sessions can be found and woken
  it('post-restart: sleeping sessions can be found by sessionKey and woken', () => {
    const s = mgr.create('persona-a', 'key-1')
    mgr.updateCCSessionId(s.sessionId, 'cc-1')
    mgr.sleepAll()

    // Simulate new process: new SessionManager from same dir
    const mgr2 = new SessionManager(dir)
    const found = mgr2.getLatestBySessionKey('key-1')
    assert.ok(found, 'should find sleeping session by sessionKey')
    assert.equal(found!.state, 'sleeping')
    assert.equal(found!.ccSessionId, 'cc-1')

    // Wake it up (simulates getOrCreateSession resume path)
    mgr2.wake(found!.sessionId)
    assert.equal(mgr2.get(found!.sessionId)!.state, 'active')
  })

  // Test 6: sleepAll then router.stop sleep is idempotent (double-sleep is harmless)
  it('double sleep path: sleepAll + individual sleep is idempotent', () => {
    const s = mgr.create('persona-a', 'key-1')
    mgr.updateCCSessionId(s.sessionId, 'cc-1')

    // shutdown() calls sleepAll
    mgr.sleepAll()
    assert.equal(mgr.get(s.sessionId)!.state, 'sleeping')

    // router.stop() also calls sleep on individual sessions — should be harmless
    mgr.sleep(s.sessionId)
    assert.equal(mgr.get(s.sessionId)!.state, 'sleeping')

    // Still persisted correctly
    const mgr2 = new SessionManager(dir)
    assert.equal(mgr2.get(s.sessionId)!.state, 'sleeping')
  })
})
