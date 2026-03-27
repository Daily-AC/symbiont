// tests/e2e-heartbeat.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestCore, createTestLogger } from './helpers.ts'
import { Router } from '../src/core/router.ts'
import { MemoryExtractor } from '../src/memory/extractor.ts'
import { MemoryDB } from '../src/memory/db.ts'
import { CCBroker } from '../src/core/cc-broker.ts'

describe('E2E: Heartbeat DM injection', { timeout: 120_000 }, () => {
  let core: ReturnType<typeof createTestCore>['core']
  let dataDir: string
  let router: Router

  before(async () => {
    const created = createTestCore('heartbeat')
    core = created.core
    dataDir = created.dataDir
    router = new Router(core)
    core.setRouter(router)
    await router.initialize()
  })

  after(async () => {
    await router.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('heartbeat injects message into DM session', async () => {
    // Create a DM session
    const dmSession = await router.getOrCreateSession('dm:test-chat')
    assert.ok(dmSession, 'DM session should be created')
    assert.equal(dmSession.turnCount, 0)

    // Add a cc heartbeat job
    const job = core.cronScheduler.addJob({
      name: 'heartbeat-test',
      schedule: '* * * * *',
      executor: 'cc',
      prompt: 'Say exactly: heartbeat-ack',
      enabled: true,
    })

    // Trigger the heartbeat manually
    const runId = core.cronScheduler.triggerNow(job.id)
    assert.ok(runId, 'triggerNow should return a runId')

    // Wait for the async sendTo to complete (CC needs time to respond)
    await new Promise(resolve => setTimeout(resolve, 30_000))

    // Verify the DM session received a message (turnCount should have increased)
    const updatedSession = router.getSession('dm:test-chat')
    assert.ok(updatedSession, 'DM session should still exist')
    assert.ok(updatedSession.turnCount > 0, `DM session turnCount should have increased, got ${updatedSession.turnCount}`)
  })

  test('heartbeat without DM session falls back to worker without crashing', async () => {
    // Create a fresh core with no DM sessions
    const created2 = createTestCore('heartbeat-nodm')
    const core2 = created2.core
    const router2 = new Router(core2)
    core2.setRouter(router2)
    // Only initialize terminal session (no DM)
    await router2.initialize()

    // Verify no DM sessions exist
    const sessions = router2.getAllSessions()
    assert.ok(!sessions.some(s => s.sessionKey.startsWith('dm:')), 'Should have no DM sessions')

    // Add and trigger heartbeat
    const job = core2.cronScheduler.addJob({
      name: 'heartbeat-no-dm',
      schedule: '* * * * *',
      executor: 'cc',
      prompt: 'Say hi',
      enabled: true,
    })

    // This should not throw
    const runId = core2.cronScheduler.triggerNow(job.id)
    assert.ok(runId, 'triggerNow should return a runId')

    // Give the worker some time
    await new Promise(resolve => setTimeout(resolve, 5_000))

    // Cleanup
    await router2.stop()
    rmSync(created2.dataDir, { recursive: true, force: true })
  })
})

describe('Extractor persona loading', { timeout: 10_000 }, () => {
  let db: MemoryDB
  let broker: CCBroker
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbiont-extractor-persona-'))
    db = new MemoryDB(dir)
    broker = new CCBroker({ maxConcurrent: { main: 1, specialist: 1, worker: 2 } })
  })

  after(async () => {
    await broker.shutdown()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('extractor constructs with persona option', () => {
    const persona = {
      soulPrompt: 'You are Xiaoxi, a helpful assistant.',
      memoryDir: '/tmp/fake-memory',
    } as any

    const extractor = new MemoryExtractor(db, broker, createTestLogger(), {
      persona,
      extractionInterval: 5,
    })

    // Verify construction succeeded by checking it's functional
    assert.equal(extractor.getPendingCount(), 0)

    // Record a turn to verify the extractor works
    extractor.recordTurn('user', 'test message', 'test-session')
    assert.equal(extractor.getPendingCount(), 1)
  })

  test('extractor constructs without persona (default prompt)', () => {
    const extractor = new MemoryExtractor(db, broker, createTestLogger())

    // Verify construction succeeded
    assert.equal(extractor.getPendingCount(), 0)

    // Record a turn to verify the extractor works
    extractor.recordTurn('user', 'test message', 'test-session-2')
    assert.equal(extractor.getPendingCount(), 1)
  })
})
