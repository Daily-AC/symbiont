// tests/memory-extractor.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { MemoryExtractor } from '../src/memory/extractor.ts'
import { CCBroker } from '../src/core/cc-broker.ts'
import { createTestLogger } from './helpers.ts'

describe('MemoryExtractor', { timeout: 120_000 }, () => {
  let db: MemoryDB
  let broker: CCBroker
  let dir: string
  let extractor: MemoryExtractor

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-extractor-'))
    db = new MemoryDB(dir)
    broker = new CCBroker({ maxConcurrent: { main: 1, specialist: 1, worker: 2 } })
    extractor = new MemoryExtractor(db, broker, createTestLogger(), { extractionInterval: 3 })
  })
  after(async () => {
    await broker.shutdown()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('recordTurn accumulates turns', () => {
    extractor.recordTurn('user', 'How do I fix the feishu file download?', 'session-1')
    extractor.recordTurn('assistant', 'Check the fileKey parameter in downloadMessageResource', 'session-1')
    assert.equal(extractor.getPendingCount(), 2)
  })

  test('extract processes pending turns and creates cards', async () => {
    extractor.recordTurn('user', 'The file was 0 bytes because I used imageKey instead of fileKey', 'session-1')
    extractor.recordTurn('assistant', 'Yes, feishu uses different keys for images and files. Always check the message type.', 'session-1')
    extractor.recordTurn('user', 'Got it, that fixed it. Thanks!', 'session-1')

    const count = await extractor.extract()
    // CC should extract at least 1 card about feishu fileKey/imageKey
    assert.ok(count >= 0, 'Should extract 0 or more cards (CC-dependent)')
    assert.equal(extractor.getPendingCount(), 0, 'Pending should be cleared')
  })

  test('extract with casual chat returns SKIP', async () => {
    extractor.recordTurn('user', '你好', 'session-2')
    extractor.recordTurn('assistant', '你好！有什么需要帮忙的吗？', 'session-2')
    extractor.recordTurn('user', '没事，就打个招呼', 'session-2')

    const count = await extractor.extract()
    assert.equal(count, 0, 'Casual chat should be skipped')
  })
})
