import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'

describe('Persona Memory Isolation', () => {
  let db: MemoryDB
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sia-isolation-'))
    db = new MemoryDB(tempDir)
  })

  it('should add card with default owner default', () => {
    const card = db.addCard({
      content: 'test card', scene: 'test', tags: ['test'],
      confidence: 0.7, source: [], connections: [], owner: 'default',
    })
    assert.strictEqual(card.owner, 'default')
  })

  it('should add card with explicit owner', () => {
    const card = db.addCard({
      content: 'reviewer note', scene: 'code-review', tags: ['review'],
      confidence: 0.8, source: [], connections: [], owner: 'code-reviewer',
    }, 'code-reviewer')
    assert.strictEqual(card.owner, 'code-reviewer')
  })

  it('scope=self: only returns own cards', () => {
    db.addCard({ content: 'test card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    db.addCard({ content: 'reviewer card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'code-reviewer' }, 'code-reviewer')
    db.addCard({ content: 'shared card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'shared' }, 'shared')

    const results = db.searchCards({ scope: 'self', owner: 'default' })
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].content, 'test card')
  })

  it('scope=shared: only returns shared cards', () => {
    db.addCard({ content: 'test card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    db.addCard({ content: 'shared card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'shared' }, 'shared')

    const results = db.searchCards({ scope: 'shared' })
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].content, 'shared card')
  })

  it('scope=all: returns all cards (CEO privilege)', () => {
    db.addCard({ content: 'test card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    db.addCard({ content: 'reviewer card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'code-reviewer' }, 'code-reviewer')
    db.addCard({ content: 'shared card', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [], owner: 'shared' }, 'shared')

    const results = db.searchCards({ scope: 'all' })
    assert.strictEqual(results.length, 3)
  })

  it('scope takes priority over owner', () => {
    db.addCard({ content: 'test card', scene: 'test', tags: [], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    db.addCard({ content: 'shared card', scene: 'test', tags: [], confidence: 0.7, source: [], connections: [], owner: 'shared' }, 'shared')

    // scope=shared should override owner=default
    const results = db.searchCards({ scope: 'shared', owner: 'default' })
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].owner, 'shared')
  })

  it('no scope, no owner: returns all cards (backward compat)', () => {
    db.addCard({ content: 'card1', scene: 'test', tags: [], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    db.addCard({ content: 'card2', scene: 'test', tags: [], confidence: 0.7, source: [], connections: [], owner: 'code-reviewer' }, 'code-reviewer')

    const results = db.searchCards({})
    assert.strictEqual(results.length, 2)
  })

  it('updateCard can change owner to shared', () => {
    const card = db.addCard({ content: 'personal insight', scene: 'test', tags: ['insight'], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    assert.strictEqual(card.owner, 'default')

    const updated = db.updateCard(card.id, { owner: 'shared' })
    assert.ok(updated)
    assert.strictEqual(updated!.owner, 'shared')
  })

  it('getAllEmbeddings filters by owner', () => {
    db.addCard({ content: 'test card', scene: 'test', tags: [], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    db.addCard({ content: 'reviewer card', scene: 'test', tags: [], confidence: 0.7, source: [], connections: [], owner: 'code-reviewer' }, 'code-reviewer')

    const xAll = db.getAllEmbeddings('default')
    assert.strictEqual(xAll.length, 1)

    const allEmb = db.getAllEmbeddings()
    assert.strictEqual(allEmb.length, 2)
  })

  it('keyword search respects scope', () => {
    db.addCard({ content: 'proxy settings tip', scene: 'deploy', tags: ['docker'], confidence: 0.7, source: [], connections: [], owner: 'default' }, 'default')
    db.addCard({ content: 'proxy config shared', scene: 'deploy', tags: ['docker'], confidence: 0.7, source: [], connections: [], owner: 'shared' }, 'shared')

    const selfResults = db.searchCards({ keyword: 'proxy', scope: 'self', owner: 'default' })
    assert.strictEqual(selfResults.length, 1)
    assert.strictEqual(selfResults[0].owner, 'default')

    const sharedResults = db.searchCards({ keyword: 'proxy', scope: 'shared' })
    assert.strictEqual(sharedResults.length, 1)
    assert.strictEqual(sharedResults[0].owner, 'shared')
  })
})
