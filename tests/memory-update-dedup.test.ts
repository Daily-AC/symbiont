// tests/memory-update-dedup.test.ts — updateCard + evolves衰减 + 去重检查
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { Connector } from '../src/memory/connector.ts'

describe('updateCard', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-update-test-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('updateCard changes content', () => {
    const card = db.addCard({ content: '旧内容', scene: 'test', tags: ['a'], confidence: 0.7, source: [], connections: [] })
    const updated = db.updateCard(card.id, { content: '新内容' })
    assert.equal(updated?.content, '新内容')
    assert.equal(updated?.scene, 'test') // unchanged
  })

  test('updateCard changes scene', () => {
    const card = db.addCard({ content: '内容', scene: '旧场景', tags: ['b'], confidence: 0.7, source: [], connections: [] })
    const updated = db.updateCard(card.id, { scene: '新场景' })
    assert.equal(updated?.scene, '新场景')
  })

  test('updateCard changes tags', () => {
    const card = db.addCard({ content: '内容', scene: 'test', tags: ['old1', 'old2'], confidence: 0.7, source: [], connections: [] })
    const updated = db.updateCard(card.id, { tags: ['new1', 'new2', 'new3'] })
    assert.deepEqual(updated?.tags, ['new1', 'new2', 'new3'])
  })

  test('updateCard changes confidence', () => {
    const card = db.addCard({ content: '内容', scene: 'test', tags: ['c'], confidence: 0.5, source: [], connections: [] })
    const updated = db.updateCard(card.id, { confidence: 0.9 })
    assert.equal(updated?.confidence, 0.9)
  })

  test('updateCard with multiple fields', () => {
    const card = db.addCard({ content: '内容', scene: 'test', tags: ['d'], confidence: 0.5, source: [], connections: [] })
    const updated = db.updateCard(card.id, { content: '新内容', scene: '新场景', confidence: 0.8 })
    assert.equal(updated?.content, '新内容')
    assert.equal(updated?.scene, '新场景')
    assert.equal(updated?.confidence, 0.8)
    assert.deepEqual(updated?.tags, ['d']) // unchanged
  })

  test('updateCard returns undefined for nonexistent id', () => {
    const result = db.updateCard('card-nonexistent', { content: '不存在' })
    assert.equal(result, undefined)
  })
})

describe('Evolves auto-decay', () => {
  let db: MemoryDB
  let connector: Connector
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-decay-test-'))
    db = new MemoryDB(dir)
    connector = new Connector({ db })
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('evolves connection decays old card confidence by 0.3', async () => {
    const old = db.addCard({
      content: 'cron 任务需要加超时', scene: 'cron修复',
      tags: ['cron', '定时任务'], confidence: 0.8, source: [], connections: [],
    })
    // Backdate old card so daysBetween > 1
    db.updateCreatedAt(old.id, new Date(Date.now() - 7 * 86400000).toISOString())

    const fresh = db.addCard({
      content: 'cron 任务加了 3 分钟超时和熔断恢复', scene: 'cron修复',
      tags: ['cron', '定时任务'], confidence: 0.9, source: [], connections: [],
    })

    await connector.connect(fresh)

    // Check evolves connection exists
    const conns = db.getConnections(fresh.id)
    const evolves = conns.find(c => c.type === 'evolves')
    assert.ok(evolves, 'should create evolves connection')

    // Check old card confidence was decayed
    const oldUpdated = db.getCard(old.id)!
    assert.ok(oldUpdated.confidence <= 0.5, `old confidence should be decayed to ~0.5, got ${oldUpdated.confidence}`)
    assert.ok(oldUpdated.confidence >= 0.4, `old confidence should be >= 0.4 (0.8 - 0.3 = 0.5, but clamped), got ${oldUpdated.confidence}`)
  })

  test('evolves decay clamps to 0', async () => {
    const old = db.addCard({
      content: '低置信度记忆', scene: '衰减测试',
      tags: ['衰减', '测试'], confidence: 0.1, source: [], connections: [],
    })
    db.updateCreatedAt(old.id, new Date(Date.now() - 7 * 86400000).toISOString())

    const fresh = db.addCard({
      content: '取代低置信度记忆的新版本', scene: '衰减测试',
      tags: ['衰减', '测试'], confidence: 0.8, source: [], connections: [],
    })

    await connector.connect(fresh)

    const oldUpdated = db.getCard(old.id)!
    assert.ok(oldUpdated.confidence >= 0, 'confidence should not go below 0')
    assert.ok(oldUpdated.confidence <= 0.1, `confidence should be clamped, got ${oldUpdated.confidence}`)
  })
})

describe('updateConfidence', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-conf-test-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('updateConfidence adds delta', () => {
    const card = db.addCard({ content: '测试', scene: 'test', tags: ['t'], confidence: 0.5, source: [], connections: [] })
    db.updateConfidence(card.id, 0.2)
    assert.equal(db.getCard(card.id)!.confidence, 0.7)
  })

  test('updateConfidence subtracts delta', () => {
    const card = db.addCard({ content: '测试2', scene: 'test', tags: ['t'], confidence: 0.5, source: [], connections: [] })
    db.updateConfidence(card.id, -0.3)
    const updated = db.getCard(card.id)!
    // 0.5 - 0.3 = 0.2
    assert.ok(Math.abs(updated.confidence - 0.2) < 0.01, `expected ~0.2, got ${updated.confidence}`)
  })

  test('updateConfidence clamps to 0', () => {
    const card = db.addCard({ content: '测试3', scene: 'test', tags: ['t'], confidence: 0.1, source: [], connections: [] })
    db.updateConfidence(card.id, -0.5)
    assert.equal(db.getCard(card.id)!.confidence, 0)
  })

  test('updateConfidence clamps to 1', () => {
    const card = db.addCard({ content: '测试4', scene: 'test', tags: ['t'], confidence: 0.9, source: [], connections: [] })
    db.updateConfidence(card.id, 0.5)
    assert.equal(db.getCard(card.id)!.confidence, 1.0)
  })
})
