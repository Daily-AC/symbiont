/**
 * Suite 4 — Session Lifecycle E2E Tests
 *
 * Tests: session persistence to sessions.json, stop() marks sleeping,
 *        new router recovers session, invalid sessionId triggers fallback.
 *
 * Run: node --experimental-strip-types --test tests/e2e-session-lifecycle.test.ts
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SymbiontCore } from '../src/core/symbiont-core.ts'
import { Router } from '../src/core/router.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DATA = join(__dirname, '..', 'data', '_test_session_lifecycle_' + Date.now())
const personaDir = join(__dirname, '..', 'persona-example')
const userDir = join(__dirname, '..', 'user')

const sessionsFile = join(TEST_DATA, 'sessions', 'sessions.json')

describe('E2E: Session Lifecycle', { timeout: 180_000 }, () => {
  let core: SymbiontCore
  let router: Router
  let firstSiaSessionId: string
  let firstCcSessionId: string

  // ---- Phase 1: create session, interact, verify persistence ----

  before(async () => {
    core = new SymbiontCore({ dataDir: TEST_DATA, personaPackDir: personaDir, userDir })
    router = new Router(core)
    await router.initialize()
  })

  test('session persists to sessions.json after first interaction', async () => {
    const reply = await router.sendTo(Router.TERMINAL_KEY, 'Reply with exactly: LIFECYCLE_OK')
    console.log(`  [Phase 1] reply: "${reply.slice(0, 80)}"`)
    assert.ok(reply.length > 0, 'should get a non-empty reply')

    // sessions.json should exist now
    assert.ok(existsSync(sessionsFile), 'sessions.json should exist after interaction')

    const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'))
    assert.ok(sessions.length > 0, 'should have at least one session')
    assert.ok(sessions[0].ccSessionId, 'session should have ccSessionId after interaction')
    assert.equal(sessions[0].state, 'active', 'session should be active')

    // capture for later phases
    const routerSession = router.getSession('terminal')
    assert.ok(routerSession, 'router should have terminal session')
    firstSiaSessionId = routerSession!.symbiontSessionId
    firstCcSessionId = sessions[0].ccSessionId
    console.log(`  [Phase 1] symbiontSessionId=${firstSiaSessionId}, ccSessionId=${firstCcSessionId}`)
  })

  // ---- Phase 2: stop() marks sessions as sleeping ----

  test('stop() marks sessions as sleeping with ccSessionId preserved', async () => {
    await router.stop()

    assert.ok(existsSync(sessionsFile), 'sessions.json should still exist')
    const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'))
    const ourSession = sessions.find((s: any) => s.sessionId === firstSiaSessionId)
    assert.ok(ourSession, 'our session should still be in sessions.json')
    assert.equal(ourSession.state, 'sleeping', 'session should be sleeping after stop()')
    assert.equal(ourSession.ccSessionId, firstCcSessionId, 'ccSessionId should be preserved')
    console.log(`  [Phase 2] session sleeping, ccSessionId preserved: ${ourSession.ccSessionId}`)
  })

  // ---- Phase 3: new router recovers session ----

  test('new router recovers session and can interact', async () => {
    // Create a fresh SymbiontCore + Router on the same dataDir
    const core2 = new SymbiontCore({ dataDir: TEST_DATA, personaPackDir: personaDir, userDir })
    const router2 = new Router(core2)
    await router2.initialize()

    // The router should have recovered the session
    const session2 = router2.getSession('terminal')
    assert.ok(session2, 'new router should have a terminal session')
    // The symbiontSessionId should be the same (recovered, not new)
    assert.equal(session2!.symbiontSessionId, firstSiaSessionId,
      'recovered session should have the same symbiontSessionId')

    // Verify we can still interact
    const reply = await router2.sendTo(Router.TERMINAL_KEY, 'Reply with exactly: RECOVERED_OK')
    console.log(`  [Phase 3] recovered reply: "${reply.slice(0, 80)}"`)
    assert.ok(reply.length > 0, 'should get a reply after recovery')

    await router2.stop()
    console.log(`  [Phase 3] recovery test passed`)
  })

  // ---- Phase 4: invalid ccSessionId triggers fallback ----

  test('invalid ccSessionId triggers connectWithFallback', async () => {
    // Corrupt the ccSessionId in sessions.json
    const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'))
    const ourSession = sessions.find((s: any) => s.sessionId === firstSiaSessionId)
    assert.ok(ourSession, 'session should exist')

    // Set an invalid ccSessionId that will fail resume
    ourSession.ccSessionId = 'invalid-uuid-that-does-not-exist-00000000'
    ourSession.state = 'sleeping'

    const { writeFileSync } = await import('node:fs')
    writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2))
    console.log(`  [Phase 4] corrupted ccSessionId to: ${ourSession.ccSessionId}`)

    // Create new router — should trigger connectWithFallback
    const core3 = new SymbiontCore({ dataDir: TEST_DATA, personaPackDir: personaDir, userDir })
    const router3 = new Router(core3)
    await router3.initialize()

    // Should still be able to interact (fallback to new session)
    const reply = await router3.sendTo(Router.TERMINAL_KEY, 'Reply with exactly: FALLBACK_OK')
    console.log(`  [Phase 4] fallback reply: "${reply.slice(0, 80)}"`)
    assert.ok(reply.length > 0, 'should get a reply even with invalid ccSessionId')

    await router3.stop()
    console.log(`  [Phase 4] fallback test passed`)
  })
})

// ---- Cleanup ----
after(() => {
  if (existsSync(TEST_DATA)) {
    rmSync(TEST_DATA, { recursive: true })
    console.log(`\nCleaned up test data: ${TEST_DATA}`)
  }
  // Force exit to avoid WS server handle keeping process alive
  setTimeout(() => process.exit(0), 1000).unref()
})
