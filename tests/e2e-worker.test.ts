/**
 * Suite 3 — Worker Chain E2E Tests
 *
 * Tests: sync worker dispatch + result, fork/merge events in timeline,
 *        async worker returns task ID immediately, async result injected via pushHandler.
 *
 * Run: node --experimental-strip-types --test tests/e2e-worker.test.ts
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SymbiontCore } from '../src/core/symbiont-core.ts'
import { Router } from '../src/core/router.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DATA = join(__dirname, '..', 'data', '_test_worker_' + Date.now())
const personaDir = join(__dirname, '..', 'persona-xiaoxi')
const userDir = join(__dirname, '..', 'user')

let router: Router

describe('E2E: Worker Chain', { timeout: 180_000 }, () => {
  before(async () => {
    const core = new SymbiontCore({ dataDir: TEST_DATA, personaPackDir: personaDir, userDir })
    router = new Router(core)
    await router.initialize()
    // Send one message to establish the session (so lastActiveSessionKey is set)
    const warmup = await router.sendTo(Router.TERMINAL_KEY, 'say OK')
    console.log(`  [warmup] "${warmup.slice(0, 60)}"`)
  })

  after(async () => {
    await router.stop()
    if (existsSync(TEST_DATA)) {
      rmSync(TEST_DATA, { recursive: true })
      console.log(`\nCleaned up: ${TEST_DATA}`)
    }
    setTimeout(() => process.exit(0), 1000).unref()
  })

  // 1. sync worker returns result
  test('sync worker returns result', async () => {
    const result = await router.dispatchWorker('Reply with exactly: SYNC_WORKER_OK')
    console.log(`  [sync worker] "${result.slice(0, 80)}"`)
    assert.ok(result.length > 0, 'result should not be empty')
    assert.ok(!result.startsWith('[工人失败]'), `worker should not fail, got: ${result.slice(0, 100)}`)
  })

  // 2. sync worker creates fork + merge events in timeline
  test('sync worker creates fork + merge events in timeline', () => {
    const timeline = router.getTimeline(Router.TERMINAL_KEY)
    const forkEntry = timeline.find(e => e.type === 'fork')
    assert.ok(forkEntry, 'timeline should contain a fork event')
    assert.ok(forkEntry!.childSessionId, 'fork event should have childSessionId')
    assert.ok(forkEntry!.summary.includes('分叉'), `fork summary should contain "分叉", got: ${forkEntry!.summary}`)

    const mergeEntry = timeline.find(e => e.type === 'merge')
    assert.ok(mergeEntry, 'timeline should contain a merge event')
    assert.ok(mergeEntry!.childSessionId, 'merge event should have childSessionId')
    assert.ok(mergeEntry!.summary.includes('合流'), `merge summary should contain "合流", got: ${mergeEntry!.summary}`)
  })

  // 3. async worker returns task ID immediately
  test('async worker returns task ID immediately', async () => {
    const result = await router.dispatchWorker(
      'Reply with exactly: ASYNC_WORKER_OK',
      undefined,
      true, // isAsync
    )
    console.log(`  [async worker] "${result.slice(0, 100)}"`)
    assert.ok(result.includes('worker-'), `result should contain task ID with "worker-", got: ${result}`)
    assert.ok(result.includes('任务ID'), `result should contain "任务ID", got: ${result}`)
  })

  // 4. async worker result injected via pushHandler
  test('async worker result injected via pushHandler', async () => {
    let pushReceived: string | null = null

    // Register pushHandler to capture the injected result
    router.setPushHandlerFor('terminal', (text: string) => {
      pushReceived = text
    })

    // Dispatch async worker
    const taskResponse = await router.dispatchWorker(
      'Reply with exactly one word: PUSH_TEST_OK',
      undefined,
      true, // isAsync
    )
    console.log(`  [async dispatch] "${taskResponse.slice(0, 100)}"`)
    assert.ok(taskResponse.includes('worker-'), 'should get task ID back')

    // Poll for pushHandler to fire (max 60s, 1s interval)
    const deadline = Date.now() + 60_000
    while (!pushReceived && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000))
    }

    console.log(`  [pushHandler result] "${(pushReceived ?? '(none)').slice(0, 100)}"`)
    assert.ok(pushReceived, 'pushHandler should have been called with the worker result')
    assert.ok((pushReceived as string).length > 0, 'push message should not be empty')

    // Clean up handler
    router.removePushHandlerFor('terminal')
  })
})
