/**
 * Suite 2 — Fork Specialist Chain E2E Tests
 *
 * Tests: createForkFor with topic creation, fork-to-topic binding,
 *        DM isolation, completeForkFor push summary, multiple concurrent forks.
 *
 * Run: node --experimental-strip-types --test tests/e2e-fork.test.ts
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SymbiontCore } from '../src/core/symbiont-core.ts'
import { Router } from '../src/core/router.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DATA = join(__dirname, '..', 'data', '_test_fork_' + Date.now())
const personaDir = join(__dirname, '..', 'persona-example')
const userDir = join(__dirname, '..', 'user')

let router: Router
let core: SymbiontCore

/** Track topicCreator calls */
const topicCreatorCalls: Array<{ parentSessionKey: string; title: string }> = []

/** Track push handler messages per session key */
const pushMessages: Map<string, string[]> = new Map()

let topicCounter = 0

describe('E2E: Fork Specialist Chain', { timeout: 180_000 }, () => {
  before(async () => {
    core = new SymbiontCore({ dataDir: TEST_DATA, personaPackDir: personaDir, userDir })
    router = new Router(core)

    // Register mock topicCreator — returns fake topic sessionKeys
    router.setTopicCreator(async (parentSessionKey: string, title: string) => {
      topicCounter++
      const sessionKey = `topic-${topicCounter}`
      topicCreatorCalls.push({ parentSessionKey, title })
      return { sessionKey, threadId: `thread-${topicCounter}` }
    })

    // Register pushHandler on terminal to capture fork completion summaries
    pushMessages.set(Router.TERMINAL_KEY, [])
    router.setPushHandlerFor(Router.TERMINAL_KEY, (text: string) => {
      pushMessages.get(Router.TERMINAL_KEY)!.push(text)
    })

    await router.initialize()
  })

  after(async () => {
    await router.stop()
    if (existsSync(TEST_DATA)) {
      rmSync(TEST_DATA, { recursive: true })
      console.log(`\nCleaned up: ${TEST_DATA}`)
    }
    setTimeout(() => process.exit(0), 1000).unref()
  })

  // 1. createForkFor with createTopic — topicCreator called, fork active
  test('createForkFor with createTopic calls topicCreator and returns active fork', async () => {
    const fork = await router.createForkFor(Router.TERMINAL_KEY, 'Investigate TS generics', {
      createTopic: true,
    })
    assert.ok(fork.id.startsWith('fork-'), `fork id should start with fork-, got: ${fork.id}`)
    assert.equal(fork.state, 'active')
    assert.equal(fork.description, 'Investigate TS generics')

    // topicCreator should have been called once
    assert.equal(topicCreatorCalls.length, 1)
    assert.equal(topicCreatorCalls[0].parentSessionKey, Router.TERMINAL_KEY)
    assert.equal(topicCreatorCalls[0].title, 'Investigate TS generics')

    console.log(`  [Fork] id=${fork.id}, state=${fork.state}`)
  })

  // 2. fork binds to topic session, not DM
  test('fork binds to topic session, terminal has no activeForkId', () => {
    const terminalSession = router.getSession(Router.TERMINAL_KEY)
    assert.ok(terminalSession, 'terminal session should exist')
    assert.equal(terminalSession!.activeForkId, null,
      'terminal session should NOT have activeForkId (fork is on topic)')

    const topicSession = router.getSession('topic-1')
    assert.ok(topicSession, 'topic session should exist')
    assert.ok(topicSession!.activeForkId, 'topic session should have activeForkId')

    console.log(`  [Binding] terminal.activeForkId=${terminalSession!.activeForkId}, topic-1.activeForkId=${topicSession!.activeForkId}`)
  })

  // 3. DM not affected by fork — send to terminal works, gets reply from main CC
  test('DM not affected by fork — terminal send works normally', async () => {
    const reply = await router.sendTo(Router.TERMINAL_KEY, 'Reply with exactly: MAIN_CC_OK')
    console.log(`  [Terminal] reply: "${reply.slice(0, 100)}"`)
    assert.ok(reply.length > 0, 'terminal should still respond')
    // Should NOT be routed through fork (terminal has no activeForkId)
    assert.ok(!reply.includes('[错误]'), 'should not be an error')
  })

  // 4. completeForkFor pushes summary via pushHandler on parent session
  test('completeForkFor pushes summary to parent via pushHandler', async () => {
    const topicSession = router.getSession('topic-1')
    assert.ok(topicSession?.activeForkId, 'topic should have active fork')

    const forkId = topicSession!.activeForkId!
    const summary = 'TS generics allow type-safe reusable components'

    await router.completeForkFor('topic-1', summary)

    // Verify fork is completed
    const fork = core.forkManager.getFork(forkId)
    assert.ok(fork, 'fork should still exist in forkManager')
    assert.equal(fork!.state, 'completed')
    assert.equal(fork!.summary, summary)

    // topic session activeForkId should be cleared
    const topicAfter = router.getSession('topic-1')
    assert.equal(topicAfter!.activeForkId, null, 'topic activeForkId should be null after completion')

    // pushHandler on terminal should have received the summary
    const terminalPushes = pushMessages.get(Router.TERMINAL_KEY)!
    assert.ok(terminalPushes.length > 0, 'pushHandler should have been called')
    const lastPush = terminalPushes[terminalPushes.length - 1]
    assert.ok(lastPush.includes(summary), `push message should contain summary, got: "${lastPush.slice(0, 120)}"`)

    console.log(`  [Push] received: "${lastPush.slice(0, 100)}"`)
  })

  // 5. Multiple forks — two createForkFor calls, each on separate topic, no conflict
  test('multiple forks coexist on different topic sessions', async () => {
    const fork2 = await router.createForkFor(Router.TERMINAL_KEY, 'Research Deno permissions', {
      createTopic: true,
    })
    const fork3 = await router.createForkFor(Router.TERMINAL_KEY, 'Debug Docker networking', {
      createTopic: true,
    })

    assert.equal(fork2.state, 'active')
    assert.equal(fork3.state, 'active')
    assert.notEqual(fork2.id, fork3.id, 'fork IDs should differ')

    // Each should be on its own topic session
    const topic2 = router.getSession('topic-2')
    const topic3 = router.getSession('topic-3')
    assert.ok(topic2, 'topic-2 session should exist')
    assert.ok(topic3, 'topic-3 session should exist')
    assert.equal(topic2!.activeForkId, fork2.id)
    assert.equal(topic3!.activeForkId, fork3.id)

    // Terminal should still have no activeForkId
    const terminal = router.getSession(Router.TERMINAL_KEY)
    assert.equal(terminal!.activeForkId, null, 'terminal unaffected by topic forks')

    // Total sessions: terminal + topic-1 + topic-2 + topic-3
    const allSessions = router.getAllSessions()
    assert.ok(allSessions.length >= 4, `should have at least 4 sessions, got ${allSessions.length}`)

    // Active forks count
    const activeForks = core.forkManager.getActiveForks()
    assert.ok(activeForks.length >= 2, `should have at least 2 active forks, got ${activeForks.length}`)

    console.log(`  [Multi] sessions=${allSessions.length}, activeForks=${activeForks.length}`)

    // Cleanup: complete both
    await router.completeForkFor('topic-2', 'Deno uses --allow-read etc.')
    await router.completeForkFor('topic-3', 'Use docker network inspect')

    assert.equal(router.getSession('topic-2')!.activeForkId, null)
    assert.equal(router.getSession('topic-3')!.activeForkId, null)

    // Should have received two more pushes
    const terminalPushes = pushMessages.get(Router.TERMINAL_KEY)!
    assert.ok(terminalPushes.length >= 3, `should have at least 3 pushes, got ${terminalPushes.length}`)

    console.log(`  [Multi] total pushes=${terminalPushes.length}`)
  })
})
