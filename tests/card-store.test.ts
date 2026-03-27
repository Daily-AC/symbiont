import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CardStore } from '../src/memory/card-store.ts'

describe('CardStore', () => {
  let store: CardStore
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'symbiont-cards-'))
    store = new CardStore(tempDir)
  })

  it('should add and retrieve cards', () => {
    const card = store.add({
      content: '不能设全局 HTTP_PROXY',
      scene: 'Docker 部署飞书 Bot',
      tags: ['feishu', 'docker'],
      confidence: 0.7,
      source: ['event://main/2026-02-20/#38'],
      connections: [],
    })

    assert.ok(card.id.startsWith('card-'))
    assert.strictEqual(store.all().length, 1)
  })

  it('should search by tag', () => {
    store.add({ content: 'proxy tip', scene: 'docker', tags: ['docker'], confidence: 0.7, source: [], connections: [] })
    store.add({ content: 'feishu tip', scene: 'feishu', tags: ['feishu'], confidence: 0.7, source: [], connections: [] })

    const results = store.search({ tags: ['docker'] })
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].content, 'proxy tip')
  })

  it('should search by keyword', () => {
    store.add({ content: 'use staging first', scene: 'deploy', tags: [], confidence: 0.7, source: [], connections: [] })

    const results = store.search({ keyword: 'staging' })
    assert.strictEqual(results.length, 1)
  })

  it('should increase confidence on touch', () => {
    const card = store.add({ content: 'test', scene: 'test', tags: [], confidence: 0.5, source: [], connections: [] })
    store.touch(card.id)
    assert.strictEqual(store.get(card.id)!.confidence, 0.58)
  })
})
