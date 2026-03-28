/**
 * Suite 7 — Memory Module E2E Tests
 *
 * Tests: CardStore CRUD, MemoryBridge (personal + shared), decay, cognition scan,
 *        source auto-fill, and source resolution — all through Router with real CC.
 *
 * Run: node --experimental-strip-types --test tests/e2e-memory.test.ts
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SymbiontCore } from '../src/core/symbiont-core.ts'
import { Router } from '../src/core/router.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DATA = join(__dirname, '..', 'data', '_test_memory_' + Date.now())
const personaDir = join(__dirname, '..', 'persona-example')
const userDir = join(__dirname, '..', 'user')

const T = Router.TERMINAL_KEY
let core: SymbiontCore
let router: Router

describe('E2E: Memory Module', { timeout: 180_000 }, () => {
  before(async () => {
    core = new SymbiontCore({ dataDir: TEST_DATA, personaPackDir: personaDir, userDir })
    router = new Router(core)
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

  // 1. addMemoryCard stores with correct fields
  test('addMemoryCard stores with correct fields', () => {
    const uniqueContent = `Memory E2E test card ${Date.now()}`
    const card = router.addMemoryCard({
      content: uniqueContent,
      scene: 'e2e test isolation',
      tags: ['e2e-test', 'memory', 'unique'],
      confidence: 0.75,
      source: ['manual://test'],
      connections: [],
    }, T)

    assert.ok(card.id.startsWith('card-'), `id should start with card-, got: ${card.id}`)
    assert.equal(card.content, uniqueContent)
    assert.deepEqual(card.tags, ['e2e-test', 'memory', 'unique'])
    assert.equal(card.confidence, 0.75)
    assert.ok(card.createdAt, 'createdAt should be set')
    assert.ok(card.lastUsed, 'lastUsed should be set')
  })

  // 2. addMemoryCard auto-fills source from event stream
  test('addMemoryCard auto-fills source from event stream', async () => {
    // Send a message to CC first to create events in the session
    const reply = await router.sendTo(T, 'say OK')
    assert.ok(reply.length > 0, 'CC should respond')

    // Now add a card with empty source — Router should auto-fill from event stream
    const card = router.addMemoryCard({
      content: 'auto-source test card',
      scene: 'e2e testing',
      tags: ['auto-source'],
      confidence: 0.6,
      source: [],
      connections: [],
    }, T)

    assert.ok(card.source.length > 0, 'source should be auto-filled')
    assert.ok(card.source[0].startsWith('event://'), `source should be event:// URI, got: ${card.source[0]}`)
  })

  // 3. getMemoryCards by keyword (via core.memoryBridge)
  test('getMemoryCards by keyword', () => {
    // keyword searches content + scene fields
    const results = core.memoryBridge.search({ keyword: 'Memory E2E test card' })
    assert.ok(results.length >= 1, 'should find at least 1 card by keyword in content')
    assert.ok(results.some(c => c.tags.includes('e2e-test')), 'result should contain our test card')
  })

  // 4. getMemoryCards by tags (via core.memoryBridge)
  test('getMemoryCards by tags', () => {
    const results = core.memoryBridge.search({ tags: ['proxy'] })
    assert.ok(results.length >= 1, 'should find at least 1 card by tag "proxy"')
    assert.ok(results.some(c => c.tags.includes('proxy')), 'result should have proxy tag')
  })

  // 5. shared memory isolation
  test('shared memory isolation — addSharedMemoryCard + search returns both', () => {
    const personalCard = router.addMemoryCard({
      content: 'personal memory for isolation test',
      scene: 'testing',
      tags: ['isolation-test'],
      confidence: 0.5,
      source: ['manual://test'],
      connections: [],
    }, T)

    const sharedCard = router.addSharedMemoryCard({
      content: 'shared memory for isolation test',
      scene: 'testing',
      tags: ['isolation-test'],
      confidence: 0.5,
      source: ['manual://test'],
      connections: [],
    })

    assert.ok(personalCard.id !== sharedCard.id, 'should be different cards')

    // memoryBridge.search merges both personal and shared
    const all = core.memoryBridge.search({ tags: ['isolation-test'] })
    assert.ok(all.length >= 2, `should find both personal and shared cards, got ${all.length}`)
    assert.ok(all.some(c => c.id === personalCard.id), 'should include personal card')
    assert.ok(all.some(c => c.id === sharedCard.id), 'should include shared card')
  })

  // 6. decay reduces confidence of unused cards
  test('decay reduces confidence of unused cards', () => {
    // Add a card with low confidence, then manually backdate its lastUsed
    const card = router.addMemoryCard({
      content: 'stale knowledge that should decay',
      scene: 'decay test',
      tags: ['decay-e2e'],
      confidence: 0.3,
      source: ['manual://test'],
      connections: [],
    }, T)

    // Backdate lastUsed to 30 days ago by finding the card in the store
    const allCards = core.memoryBridge.all()
    const target = allCards.find(c => c.id === card.id)!
    target.lastUsed = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

    const result = core.memoryBridge.decay()
    assert.ok(result.decayed > 0, `should have decayed at least 1 card, got ${result.decayed}`)

    // Verify the card's confidence went down
    const afterDecay = core.memoryBridge.search({ tags: ['decay-e2e'] })
    if (afterDecay.length > 0) {
      // Card may have been archived if confidence dropped below 0.1
      assert.ok(afterDecay[0].confidence < 0.3, `confidence should have decreased from 0.3, got ${afterDecay[0].confidence}`)
    } else {
      // Card was archived (confidence dropped below 0.1) — also a valid outcome
      assert.ok(result.archived.includes(card.id), 'card should be in archived list if not found')
    }
  })

  // 7. cognition scan finds clusters
  test('cognition scan finds clusters with >= 5 cards sharing a tag', () => {
    // Add 5+ cards with the same tag
    for (let i = 0; i < 6; i++) {
      router.addMemoryCard({
        content: `cognition cluster test entry ${i} - unique-${Date.now()}-${i}`,
        scene: `cluster scenario ${i}`,
        tags: ['cognition-cluster-e2e'],
        confidence: 0.5,
        source: ['manual://test'],
        connections: [],
      }, T)
    }

    const clusters = core.cognitionEngine.scan(5)
    assert.ok(
      clusters.includes('cognition-cluster-e2e'),
      `scan should find 'cognition-cluster-e2e' tag cluster, got: [${clusters.join(', ')}]`
    )
  })

  // 8. resolveCardSource returns events
  test('resolveCardSource returns events for card with source', () => {
    // The card from test 2 has auto-filled source with event:// URI
    const cards = core.memoryBridge.search({ tags: ['auto-source'] })
    assert.ok(cards.length > 0, 'should find auto-source card')

    const card = cards[0]
    assert.ok(card.source.length > 0, 'card should have source URIs')

    const events = router.resolveCardSource(card)
    assert.ok(events.length > 0, `resolveCardSource should return events, got ${events.length}`)
    assert.ok(events[0].type, 'resolved event should have a type field')
  })
})
