// tests/recall.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { recall } from '../src/memory/recall.ts'
import type { ExperienceCard } from '../src/memory/types.ts'

type CardInput = Omit<ExperienceCard, 'id' | 'createdAt' | 'lastUsed'>

function makeCardInput(overrides: Partial<CardInput> = {}): CardInput {
  return {
    content: '默认内容',
    scene: 'test',
    tags: ['测试'],
    confidence: 0.8,
    source: [],
    connections: [],
    ...overrides,
  }
}

/** Mock embedding client that returns pre-computed vectors */
function makeMockEmbeddingClient(vectorMap: Map<string, Float32Array>) {
  return {
    isAvailable: true,
    async embedOne(text: string): Promise<Float32Array | null> {
      return vectorMap.get(text) ?? null
    },
    async embed(texts: string[]): Promise<Array<Float32Array | null>> {
      return texts.map(t => vectorMap.get(t) ?? null)
    },
  }
}

function makeUnavailableEmbeddingClient() {
  return {
    isAvailable: false,
    async embedOne(_text: string): Promise<Float32Array | null> { return null },
    async embed(texts: string[]): Promise<Array<Float32Array | null>> { return texts.map(() => null) },
  }
}

describe('recall', () => {
  let db: MemoryDB
  let tmpDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-recall-test-'))
    db = new MemoryDB(tmpDir)
  })
  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }) })

  test('recall with no cards returns empty', async () => {
    const result = await recall(db, '随机查询')
    assert.deepStrictEqual(result.cards, [])
    assert.strictEqual(result.prompt, '')
  })

  test('recall with keyword match finds relevant cards', async () => {
    db.addCard(makeCardInput({ content: '服务器部署需要检查端口配置', tags: ['服务器', '部署'], scene: '运维' }))
    db.addCard(makeCardInput({ content: 'React 组件渲染优化', tags: ['前端', 'React'], scene: '开发' }))

    const result = await recall(db, '服务器部署')
    assert.ok(result.cards.length >= 1)
    assert.ok(result.cards.some(c => c.content.includes('服务器部署')))
    assert.ok(result.prompt.includes('[相关记忆]'))
  })

  test('recall with embedding match finds semantically similar cards', async () => {
    const card = db.addCard(makeCardInput({
      content: 'Docker 容器需要限制内存使用',
      tags: ['docker', '容器'],
      scene: '运维',
    }))
    // Store an embedding for this card
    const cardVec = new Float32Array([0.9, 0.1, 0.0])
    db.updateEmbedding(card.id, cardVec)

    // Query vector very similar to card vector
    const queryVec = new Float32Array([0.85, 0.15, 0.0])
    const vectorMap = new Map<string, Float32Array>()
    vectorMap.set('容器内存限制', queryVec)

    const mockClient = makeMockEmbeddingClient(vectorMap)
    const result = await recall(db, '容器内存限制', { embeddingClient: mockClient as any })
    assert.ok(result.cards.some(c => c.content.includes('Docker 容器')))
  })

  test('recall falls back to keyword-only when embedding unavailable', async () => {
    db.addCard(makeCardInput({ content: 'SQLite WAL 模式提升并发性能', tags: ['数据库', 'SQLite'], scene: '优化' }))

    const mockClient = makeUnavailableEmbeddingClient()
    const result = await recall(db, 'SQLite WAL', { embeddingClient: mockClient as any })
    assert.ok(result.cards.some(c => c.content.includes('SQLite WAL')))
  })

  test('recall performs graph expansion on connected cards', async () => {
    const cardA = db.addCard(makeCardInput({
      content: '图扩展主卡片',
      tags: ['graph', '测试图'],
      scene: '图测试',
      confidence: 0.9,
    }))
    const cardB = db.addCard(makeCardInput({
      content: '图扩展连接卡片',
      tags: ['其他标签'],
      scene: '图测试',
      confidence: 0.8,
    }))
    db.addConnection({ fromId: cardA.id, toId: cardB.id, type: 'similar', strength: 0.8 })

    const result = await recall(db, '图扩展主卡片 graph 测试图')
    // Should find cardA by keyword, then expand to cardB via connection
    const ids = result.cards.map(c => c.id)
    assert.ok(ids.includes(cardA.id), 'Should include primary card')
    assert.ok(ids.includes(cardB.id), 'Should include connected card via graph expansion')
  })

  test('recall respects limit parameter', async () => {
    // Add many cards
    for (let i = 0; i < 10; i++) {
      db.addCard(makeCardInput({
        content: `限制测试卡片 ${i}`,
        tags: ['限制测试'],
        scene: '限制',
      }))
    }

    const result = await recall(db, '限制测试', { limit: 3 })
    assert.ok(result.cards.length <= 3 + 2, 'Should respect limit (plus up to 2 graph expansions)')
  })

  test('recall touches recalled cards (confidence boost)', async () => {
    const card = db.addCard(makeCardInput({
      content: '触摸测试卡片 unique-touch-test',
      tags: ['触摸测试'],
      scene: '触摸',
      confidence: 0.5,
    }))

    const originalConfidence = card.confidence
    await recall(db, '触摸测试卡片 unique-touch-test')

    const updated = db.getCard(card.id)
    assert.ok(updated !== undefined)
    assert.ok(updated!.confidence > originalConfidence, `Expected confidence boost: ${updated!.confidence} > ${originalConfidence}`)
  })

  test('RRF fusion merges results from multiple paths correctly', async () => {
    // Card that appears in both keyword and semantic paths should rank higher
    const bothPaths = db.addCard(makeCardInput({
      content: 'RRF融合测试 双路径命中',
      tags: ['RRF', '融合'],
      scene: 'RRF测试',
      confidence: 0.9,
    }))
    const keywordVec = new Float32Array([0.8, 0.2, 0.0])
    db.updateEmbedding(bothPaths.id, keywordVec)

    const keywordOnly = db.addCard(makeCardInput({
      content: 'RRF融合测试 仅关键词命中',
      tags: ['RRF', '融合'],
      scene: 'RRF测试',
      confidence: 0.5,
    }))

    const queryVec = new Float32Array([0.75, 0.25, 0.0])
    const vectorMap = new Map<string, Float32Array>()
    vectorMap.set('RRF融合测试', queryVec)

    const mockClient = makeMockEmbeddingClient(vectorMap)
    const result = await recall(db, 'RRF融合测试', { embeddingClient: mockClient as any, limit: 10 })

    // Both should appear
    const ids = result.cards.map(c => c.id)
    assert.ok(ids.includes(bothPaths.id), 'Dual-path card should appear')
    // The dual-path card should rank higher (appear earlier)
    if (ids.includes(keywordOnly.id)) {
      const dualIdx = ids.indexOf(bothPaths.id)
      const kwIdx = ids.indexOf(keywordOnly.id)
      assert.ok(dualIdx < kwIdx, 'Dual-path card should rank higher than keyword-only card')
    }
  })
})
