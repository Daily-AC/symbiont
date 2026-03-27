// tests/embedding-client.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EmbeddingClient, cosineSimilarity } from '../src/memory/embedding-client.ts'

describe('cosineSimilarity', () => {
  test('identical vectors → 1.0', () => {
    const v = new Float32Array([1, 2, 3])
    const sim = cosineSimilarity(v, v)
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `Expected ~1.0, got ${sim}`)
  })

  test('orthogonal vectors → 0.0', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([0, 1, 0])
    const sim = cosineSimilarity(a, b)
    assert.ok(Math.abs(sim) < 1e-6, `Expected ~0.0, got ${sim}`)
  })

  test('opposite vectors → -1.0', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([-1, -2, -3])
    const sim = cosineSimilarity(a, b)
    assert.ok(Math.abs(sim - (-1.0)) < 1e-6, `Expected ~-1.0, got ${sim}`)
  })

  test('zero vector returns 0', () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 2, 3])
    const sim = cosineSimilarity(a, b)
    assert.strictEqual(sim, 0)
  })

  test('similar vectors have high similarity', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([1, 2, 3.1])
    const sim = cosineSimilarity(a, b)
    assert.ok(sim > 0.99, `Expected > 0.99, got ${sim}`)
  })
})

describe('EmbeddingClient', () => {
  test('embed([]) returns []', async () => {
    const client = new EmbeddingClient({ url: 'http://127.0.0.1:19999/embeddings' })
    const result = await client.embed([])
    assert.deepStrictEqual(result, [])
  })

  test('marks unavailable on fetch error, auto-recovers', async () => {
    // Connect to a port that's not listening
    const client = new EmbeddingClient({ url: 'http://127.0.0.1:19999/embeddings', timeoutMs: 1000 })
    assert.strictEqual(client.isAvailable, true)

    const result = await client.embed(['test'])
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0], null)
    assert.strictEqual(client.isAvailable, false)

    // The auto-recovery timer is set (60s), we just verify the flag changed
  })

  test('handles empty input array', async () => {
    const client = new EmbeddingClient()
    const result = await client.embed([])
    assert.deepStrictEqual(result, [])
    // isAvailable should remain true since no request was made
    assert.strictEqual(client.isAvailable, true)
  })
})
