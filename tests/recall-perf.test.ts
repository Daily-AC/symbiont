import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'

describe('Embedding cache', () => {
  let db: MemoryDB
  let tmpDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-perf-test-'))
    db = new MemoryDB(tmpDir)
    // Insert 500 cards with random embeddings (384 dims)
    for (let i = 0; i < 500; i++) {
      const card = db.addCard({
        content: `test card ${i}`, scene: 'perf-test',
        tags: [`tag-${i % 10}`], confidence: 0.5 + Math.random() * 0.5,
        source: [], connections: [], owner: 'xiaoxi',
      }, 'xiaoxi')
      const emb = new Float32Array(384)
      for (let j = 0; j < 384; j++) emb[j] = Math.random() - 0.5
      db.updateEmbedding(card.id, emb)
    }
  })

  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }) })

  test('getCachedEmbeddings returns Map with all embeddings', () => {
    const cache = db.getCachedEmbeddings()
    assert.ok(cache.size >= 500)
    const firstEntry = cache.values().next().value
    assert.ok(firstEntry instanceof Float32Array)
    assert.equal(firstEntry!.length, 384)
  })

  test('getCachedEmbeddings is idempotent (same reference)', () => {
    const cache1 = db.getCachedEmbeddings()
    const cache2 = db.getCachedEmbeddings()
    assert.strictEqual(cache1, cache2) // same Map reference
  })

  test('updateEmbedding updates cache', () => {
    const cache = db.getCachedEmbeddings()
    const firstId = cache.keys().next().value!
    const newEmb = new Float32Array(384).fill(0.42)
    db.updateEmbedding(firstId, newEmb)
    const updated = db.getCachedEmbeddings().get(firstId)!
    assert.ok(Math.abs(updated[0] - 0.42) < 0.001)
  })

  test('invalidateEmbeddingCache forces reload', () => {
    const cache1 = db.getCachedEmbeddings()
    db.invalidateEmbeddingCache()
    const cache2 = db.getCachedEmbeddings()
    assert.notStrictEqual(cache1, cache2) // different Map reference
    assert.ok(cache2.size >= 500) // but same data
  })

  test('archiveCard evicts from cache', () => {
    const cache = db.getCachedEmbeddings()
    const firstId = cache.keys().next().value!
    assert.ok(cache.has(firstId))
    db.archiveCard(firstId, 'test essence')
    assert.ok(!cache.has(firstId))
  })

  test('deleteCard evicts from cache', () => {
    const cache = db.getCachedEmbeddings()
    const ids = [...cache.keys()]
    const targetId = ids[ids.length - 1]
    assert.ok(cache.has(targetId))
    db.deleteCard(targetId)
    assert.ok(!cache.has(targetId))
  })

  test('cached is faster than uncached on repeat calls', () => {
    db.invalidateEmbeddingCache()
    db.getCachedEmbeddings() // warm up

    const start1 = performance.now()
    for (let i = 0; i < 10; i++) db.getCachedEmbeddings()
    const cachedMs = performance.now() - start1

    const start2 = performance.now()
    for (let i = 0; i < 10; i++) db.getAllEmbeddings()
    const uncachedMs = performance.now() - start2

    // Cached should be significantly faster (returns same Map)
    assert.ok(cachedMs < uncachedMs, `Cached ${cachedMs.toFixed(1)}ms should be < uncached ${uncachedMs.toFixed(1)}ms`)
  })
})
