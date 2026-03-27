// tests/memory-lifecycle.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { MemoryLifecycle } from '../src/memory/lifecycle.ts'
import { createTestLogger } from './helpers.ts'

describe('MemoryLifecycle', () => {
  let db: MemoryDB
  let dir: string
  let lifecycle: MemoryLifecycle

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbiont-lifecycle-'))
    db = new MemoryDB(dir)
    lifecycle = new MemoryLifecycle(db, createTestLogger(), { gracePeriodDays: 0, timeoutDays: 0 })
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('evolves connection decays target card', () => {
    const old = db.addCard({ content: 'old approach', scene: 'test', tags: ['decay'], confidence: 0.8, source: [], connections: [] })
    const newer = db.addCard({ content: 'new approach', scene: 'test', tags: ['decay'], confidence: 0.9, source: [], connections: [] })
    db.addConnection({ fromId: newer.id, toId: old.id, type: 'evolves', strength: 0.9 })

    const result = lifecycle.run()
    assert.ok(result.decayed >= 1)
    const updated = db.getCard(old.id)
    assert.ok(updated!.confidence < 0.8, `Should decay, got ${updated!.confidence}`)
  })

  test('contradicts connection strongly decays target', () => {
    const wrong = db.addCard({ content: 'wrong fact', scene: 'test', tags: ['contra'], confidence: 0.7, source: [], connections: [] })
    const correct = db.addCard({ content: 'correct fact', scene: 'test', tags: ['contra'], confidence: 0.9, source: [], connections: [] })
    db.addConnection({ fromId: correct.id, toId: wrong.id, type: 'contradicts', strength: 1.0 })

    lifecycle.run()
    const updated = db.getCard(wrong.id)
    assert.ok(updated!.confidence <= 0.2, `Should strongly decay, got ${updated!.confidence}`)
  })

  test('archive low-confidence unconnected cards', () => {
    db.addCard({ content: 'very old unused', scene: 'test', tags: ['archive'], confidence: 0.05, source: [], connections: [] })
    const result = lifecycle.run()
    assert.ok(result.archived >= 1)
  })

  test('aggregate creates cognition for 5+ same-tag cards', () => {
    for (let i = 0; i < 6; i++) {
      db.addCard({ content: `pattern card ${i}`, scene: 'test', tags: ['aggregate-test'], confidence: 0.8, source: [], connections: [] })
    }
    const result = lifecycle.run()
    assert.ok(result.aggregated.includes('aggregate-test'))
  })

  test('locked cards (confidence 1.0) are never decayed', () => {
    const locked = db.addCard({ content: 'locked card', scene: 'test', tags: ['locked'], confidence: 0.7, source: [], connections: [] })
    db.addFeedback(locked.id, 'important')
    const evolving = db.addCard({ content: 'evolving card', scene: 'test', tags: ['locked'], confidence: 0.9, source: [], connections: [] })
    db.addConnection({ fromId: evolving.id, toId: locked.id, type: 'evolves', strength: 1.0 })

    lifecycle.run()
    const updated = db.getCard(locked.id)
    assert.equal(updated!.confidence, 1.0, 'Locked card should not decay')
  })
})
