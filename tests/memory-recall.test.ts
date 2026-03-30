// tests/memory-recall.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { recall } from '../src/memory/recall.ts'

describe('Recall', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-recall-'))
    db = new MemoryDB(dir)
    // Seed cards
    db.addCard({ content: 'Feishu SDK returns stream for media downloads', scene: 'feishu integration', tags: ['feishu', 'media'], confidence: 0.9, source: [], connections: [] })
    db.addCard({ content: 'Docker proxy breaks WSClient', scene: 'docker deployment', tags: ['docker', 'proxy'], confidence: 0.8, source: [], connections: [] })
    db.addCard({ content: 'SQLite WAL mode improves concurrent reads', scene: 'database', tags: ['sqlite', 'performance'], confidence: 0.7, source: [], connections: [] })
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('recall matches relevant cards by keyword', async () => {
    const result = await recall(db, '飞书文件下载失败怎么办？feishu')
    assert.ok(result.cards.length >= 1)
    assert.ok(result.cards.some(c => c.tags.includes('feishu')))
  })

  test('recall formats prompt with memory context', async () => {
    const result = await recall(db, 'feishu media download')
    assert.ok(result.prompt.startsWith('[相关记忆]'))
    assert.ok(result.prompt.includes('置信度'))
  })

  test('recall returns empty for unrelated query', async () => {
    const result = await recall(db, '今天天气怎么样')
    assert.equal(result.cards.length, 0)
    assert.equal(result.prompt, '')
  })

  test('recall expands along connections', async () => {
    const cardA = db.searchCards({ keyword: 'Feishu SDK' })[0]
    const cardB = db.addCard({ content: 'Feishu image_key vs file_key confusion', scene: 'feishu bug', tags: ['feishu', 'bug'], confidence: 0.85, source: [], connections: [] })
    db.addConnection({ fromId: cardA.id, toId: cardB.id, type: 'supplements', strength: 0.8 })

    const result = await recall(db, 'feishu SDK download')
    assert.ok(result.cards.some(c => c.content.includes('image_key')), 'Should expand to connected card')
  })

  test('recall touches recalled cards', async () => {
    const before = db.searchCards({ keyword: 'SQLite' })[0]
    const confBefore = before.confidence
    await recall(db, 'SQLite database performance')
    const after = db.getCard(before.id)
    assert.ok(after!.confidence > confBefore, 'Confidence should increase after recall')
  })
})
