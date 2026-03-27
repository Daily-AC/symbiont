// tests/connector.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Connector } from '../src/memory/connector.ts'
import { MemoryDB } from '../src/memory/db.ts'
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

describe('Connector', () => {
  let db: MemoryDB
  let connector: Connector
  let tmpDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-test-'))
    db = new MemoryDB(tmpDir)
    connector = new Connector({ db })
  })
  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }) })

  test('should create similar connection for cards with overlapping tags', async () => {
    const old = db.addCard(makeCardInput({ tags: ['服务器', '部署', '运维'], content: '服务器部署需要检查端口配置' }))
    const fresh = db.addCard(makeCardInput({ tags: ['服务器', '部署', '监控'], content: '服务器部署后要配置监控告警' }))
    const count = await connector.connect(fresh)
    assert.ok(count >= 1)
    const connections = db.getConnections(fresh.id)
    assert.ok(connections.length >= 1)
  })

  test('should create evolves connection for same-scene cards', async () => {
    const old = db.addCard(makeCardInput({
      tags: ['cron', '定时任务'], content: 'cron 任务需要加超时',
      scene: 'cron修复', confidence: 0.5,
    }))
    // Backdate the old card by 7 days so daysBetween > 1
    db.updateCreatedAt(old.id, new Date(Date.now() - 7 * 86400000).toISOString())
    const fresh = db.addCard(makeCardInput({
      tags: ['cron', '定时任务'], content: 'cron 任务加了 3 分钟超时和熔断恢复',
      scene: 'cron修复', confidence: 0.8,
    }))
    // Re-fetch old card to get updated createdAt for connector analysis
    const oldUpdated = db.getCard(old.id)!
    const count = await connector.connect(fresh)
    assert.ok(count >= 1)
    const connections = db.getConnections(fresh.id)
    const evolves = connections.find(c => c.type === 'evolves')
    assert.ok(evolves !== undefined)
  })

  test('should create contradicts connection for opposing content', async () => {
    const old = db.addCard(makeCardInput({ tags: ['代理', '网络'], content: '应该设置全局 HTTP_PROXY 来解决网络问题' }))
    const fresh = db.addCard(makeCardInput({ tags: ['代理', '网络'], content: '不应该设置全局 HTTP_PROXY，飞书 WSClient 会断' }))
    const count = await connector.connect(fresh)
    assert.ok(count >= 1)
    const connections = db.getConnections(fresh.id)
    const contradicts = connections.find(c => c.type === 'contradicts')
    assert.ok(contradicts !== undefined)
  })

  test('should not create duplicate connections', async () => {
    const old = db.addCard(makeCardInput({ tags: ['测试', '部署'], content: '部署前要跑测试' }))
    const fresh = db.addCard(makeCardInput({ tags: ['测试', '部署'], content: '部署流程必须包含测试步骤' }))
    await connector.connect(fresh)
    const count2 = await connector.connect(fresh)
    assert.strictEqual(count2, 0)
  })

  test('should skip unrelated cards', async () => {
    const old = db.addCard(makeCardInput({ tags: ['前端', 'React'], content: 'React 组件要用 memo 优化' }))
    const fresh = db.addCard(makeCardInput({ tags: ['数据库', 'SQLite'], content: 'SQLite 用 WAL 模式提升并发' }))
    const count = await connector.connect(fresh)
    assert.strictEqual(count, 0)
  })

  test('scanAll should process all active cards', async () => {
    const cards = [
      db.addCard(makeCardInput({ tags: ['A', 'B'], content: '内容关于 A 和 B 的关系' })),
      db.addCard(makeCardInput({ tags: ['A', 'B'], content: '补充说明 A 和 B 的用法' })),
      db.addCard(makeCardInput({ tags: ['C'], content: '完全无关的内容' })),
    ]
    const total = await connector.scanAll()
    assert.ok(total >= 1)
  })
})
