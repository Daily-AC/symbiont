// tests/memory-db.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'

describe('MemoryDB', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-memdb-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('addCard and getCard', () => {
    const card = db.addCard({ content: 'test card', scene: 'test', tags: ['a', 'b'], confidence: 0.7, source: [], connections: [] })
    assert.ok(card.id.startsWith('card-'))
    const found = db.getCard(card.id)
    assert.equal(found?.content, 'test card')
    assert.deepEqual(found?.tags, ['a', 'b'])
  })

  test('searchCards by keyword', () => {
    db.addCard({ content: 'SQLite is great for embedded', scene: 'database', tags: ['db'], confidence: 0.8, source: [], connections: [] })
    const results = db.searchCards({ keyword: 'SQLite' })
    assert.ok(results.length >= 1)
  })

  test('searchCards by tags', () => {
    const results = db.searchCards({ tags: ['db'] })
    assert.ok(results.length >= 1)
  })

  test('touchCard increases confidence', () => {
    const card = db.addCard({ content: 'touch test', scene: 'test', tags: ['touch'], confidence: 0.5, source: [], connections: [] })
    db.touchCard(card.id)
    const updated = db.getCard(card.id)
    assert.ok(updated!.confidence > 0.5)
  })

  test('addConnection and getConnections', () => {
    const a = db.addCard({ content: 'card A', scene: 'test', tags: ['conn'], confidence: 0.7, source: [], connections: [] })
    const b = db.addCard({ content: 'card B', scene: 'test', tags: ['conn'], confidence: 0.7, source: [], connections: [] })
    db.addConnection({ fromId: a.id, toId: b.id, type: 'causal', strength: 0.8, reason: 'A causes B' })
    const conns = db.getConnections(a.id)
    assert.equal(conns.length, 1)
    assert.equal(conns[0].type, 'causal')
  })

  test('feedback wrong archives card', () => {
    const card = db.addCard({ content: 'wrong card', scene: 'test', tags: ['fb'], confidence: 0.7, source: [], connections: [] })
    db.addFeedback(card.id, 'wrong', 'this is incorrect')
    const updated = db.getCard(card.id)
    assert.equal(updated?.archived, true)
  })

  test('feedback important locks confidence', () => {
    const card = db.addCard({ content: 'important card', scene: 'test', tags: ['fb'], confidence: 0.5, source: [], connections: [] })
    db.addFeedback(card.id, 'important')
    const updated = db.getCard(card.id)
    assert.equal(updated?.confidence, 1.0)
  })

  test('archiveCard with essence', () => {
    const card = db.addCard({ content: 'old knowledge', scene: 'test', tags: ['arc'], confidence: 0.1, source: [], connections: [] })
    db.archiveCard(card.id, 'distilled essence')
    const updated = db.getCard(card.id)
    assert.equal(updated?.archived, true)
    assert.equal(updated?.essence, 'distilled essence')
  })

  test('reviveCard resets confidence to 0.3', () => {
    const cards = db.searchCards({ tags: ['arc'], archived: true })
    assert.ok(cards.length >= 1)
    db.reviveCard(cards[0].id)
    const updated = db.getCard(cards[0].id)
    assert.equal(updated?.archived, false)
    assert.equal(updated?.confidence, 0.3)
  })

  test('getGraphData returns nodes and edges', () => {
    const graph = db.getGraphData()
    assert.ok(graph.nodes.length > 0)
    assert.ok(graph.edges.length > 0)
  })

  test('getStats returns counts', () => {
    const stats = db.getStats()
    assert.ok(stats.total > 0)
    assert.ok(stats.active >= 0)
  })

  test('activity log records operations', () => {
    const activities = db.getActivity(10)
    assert.ok(activities.length > 0)
    assert.ok(activities.some(a => a.type === 'extract'))
  })

  test('addCognition and getCognitions', () => {
    const cog = db.addCognition('docker', 'Docker networking patterns', ['card-1', 'card-2'])
    assert.equal(cog.status, 'pending')
    const all = db.getCognitions('pending')
    assert.ok(all.length >= 1)
  })

  // ── SQLite 事务测试 ──────────────────────────────────────────────────────

  test('updateCard atomically updates content + tags', () => {
    const card = db.addCard({ content: 'transaction test', scene: 'test', tags: ['old-tag'], confidence: 0.5, source: [], connections: [] })
    const updated = db.updateCard(card.id, { content: 'updated content', tags: ['new-tag-1', 'new-tag-2'] })
    assert.ok(updated)
    assert.equal(updated!.content, 'updated content')
    assert.deepEqual(updated!.tags, ['new-tag-1', 'new-tag-2'])
  })

  test('updateCard on nonexistent id with tags throws FK constraint (atomic failure)', () => {
    const fakeId = 'card-nonexistent-999'
    // 更新不存在的卡片的 tags 会触发 FK 约束错误（card_tags.card_id REFERENCES cards(id)），
    // 这正是事务的原子性保证：INSERT card_tags 失败时整个事务回滚，不会留下孤儿数据。
    assert.throws(
      () => db.updateCard(fakeId, { content: 'ghost', tags: ['phantom'] }),
      { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
    )
    // 确认没有孤儿数据
    const found = db.searchCards({ tags: ['phantom'] })
    assert.equal(found.length, 0, 'should not find phantom tag in any card')
  })

  test('updateCard on nonexistent id without tags returns undefined', () => {
    const fakeId = 'card-nonexistent-888'
    // 只更新 content（不涉及 card_tags FK），UPDATE 对不存在的行做 0 changes
    const result = db.updateCard(fakeId, { content: 'ghost' })
    assert.equal(result, undefined, 'should return undefined for nonexistent card')
  })

  test('updateCard content only preserves existing tags', () => {
    const card = db.addCard({ content: 'preserve tags', scene: 'test', tags: ['keep-me'], confidence: 0.7, source: [], connections: [] })
    db.updateCard(card.id, { content: 'new content only' })
    const updated = db.getCard(card.id)
    assert.equal(updated!.content, 'new content only')
    assert.deepEqual(updated!.tags, ['keep-me'], 'tags should remain unchanged')
  })
})
