import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/core/session.ts'

describe('SessionManager', () => {
  let dir: string
  let mgr: SessionManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbiont-test-'))
    mgr = new SessionManager(dir)
  })

  // ---- Bug 3 fix: getLatestBySessionKey matches sessions with ccSessionId === null ----

  it('getLatestBySessionKey returns session even when ccSessionId is null', () => {
    // create() leaves ccSessionId as null (simulates crash before CC assigned)
    const s = mgr.create('persona-a', 'key-1')
    // force save so it persists in memory map (create does NOT call saveAll)
    // but the in-memory map already has it, so getLatestBySessionKey should find it
    const found = mgr.getLatestBySessionKey('key-1')
    assert.ok(found, 'should find session with null ccSessionId')
    assert.equal(found!.sessionId, s.sessionId)
    assert.equal(found!.ccSessionId, null)
  })

  // ---- getLatestBySessionKey returns the most recent by lastActive ----

  it('getLatestBySessionKey returns the latest session by lastActive', () => {
    const s1 = mgr.create('persona-a', 'key-1')
    const s2 = mgr.create('persona-a', 'key-1')
    // Ensure s2 has a strictly later lastActive than s1
    // (both may be created in the same ms, so manually adjust)
    const s1State = mgr.get(s1.sessionId)!
    ;(s1State as any).lastActive = '2020-01-01T00:00:00.000Z'

    const found = mgr.getLatestBySessionKey('key-1')
    assert.ok(found)
    assert.equal(found!.sessionId, s2.sessionId)
  })

  // ---- sleep() changes state to sleeping ----

  it('sleep sets state to sleeping', () => {
    const s = mgr.create('persona-a', 'key-1')
    assert.equal(s.state, 'active')

    mgr.sleep(s.sessionId)
    const updated = mgr.get(s.sessionId)
    assert.equal(updated!.state, 'sleeping')
  })

  // ---- wake() changes state to active ----

  it('wake sets state to active', () => {
    const s = mgr.create('persona-a', 'key-1')
    mgr.sleep(s.sessionId)
    assert.equal(mgr.get(s.sessionId)!.state, 'sleeping')

    mgr.wake(s.sessionId)
    const updated = mgr.get(s.sessionId)
    assert.equal(updated!.state, 'active')
  })

  // ---- persistence: write then reload ----

  it('persists sessions and reloads them', () => {
    const s = mgr.create('persona-a', 'key-1')
    // updateCCSessionId triggers saveAll
    mgr.updateCCSessionId(s.sessionId, 'cc-abc')

    // create a new manager reading from the same dir
    const mgr2 = new SessionManager(dir)
    const loaded = mgr2.get(s.sessionId)
    assert.ok(loaded, 'should load persisted session')
    assert.equal(loaded!.ccSessionId, 'cc-abc')
    assert.equal(loaded!.personaPack, 'persona-a')
    assert.equal(loaded!.sessionKey, 'key-1')
  })

  // ---- sleep also persists sessionKey update ----

  it('sleep persists updated sessionKey', () => {
    const s = mgr.create('persona-a')
    mgr.updateCCSessionId(s.sessionId, 'cc-1') // save first
    mgr.sleep(s.sessionId, 'new-key')

    const mgr2 = new SessionManager(dir)
    const loaded = mgr2.get(s.sessionId)
    assert.equal(loaded!.sessionKey, 'new-key')
    assert.equal(loaded!.state, 'sleeping')
  })
})
