import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventStore } from '../src/core/event-store.ts'
import { MemoryDB } from '../src/memory/db.ts'
import { SessionMap } from '../src/interface/feishu/session-map.ts'

describe('EventStore (SQLite)', () => {
  let store: EventStore
  let db: MemoryDB

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sia-robust-'))
    db = new MemoryDB(tempDir)
    store = new EventStore(db)
  })

  it('should append and read events with data preserved', () => {
    store.append({ type: 'chat', sessionId: 'sess-1', data: { role: 'user', content: 'hello' } })
    store.append({ type: 'chat', sessionId: 'sess-1', data: { role: 'assistant', content: 'world' } })

    const events = store.read('sess-1')
    assert.strictEqual(events.length, 2)
    assert.strictEqual(events[0].data.content, 'hello')
    assert.strictEqual(events[0].data.role, 'user')
    assert.strictEqual(events[1].data.content, 'world')
  })

  it('should isolate events by sessionId', () => {
    store.append({ type: 'chat', sessionId: 'a', data: { content: 'in-a' } })
    store.append({ type: 'chat', sessionId: 'b', data: { content: 'in-b' } })

    assert.strictEqual(store.read('a').length, 1)
    assert.strictEqual(store.read('b').length, 1)
    assert.strictEqual(store.read('a')[0].data.content, 'in-a')
  })

  it('should return empty array for non-existent session', () => {
    assert.deepStrictEqual(store.read('no-such'), [])
  })

  it('appendFork and getForks', () => {
    store.appendFork('parent', 'child-1', 'task A')
    store.appendFork('parent', 'child-2', 'task B')
    store.append({ type: 'chat', sessionId: 'parent', data: { content: 'normal' } })

    const forks = store.getForks('parent')
    assert.strictEqual(forks.length, 2)
    assert.strictEqual(forks[0].data.childSessionId, 'child-1')
  })

  it('getLatestSummary returns last N events', () => {
    for (let i = 0; i < 20; i++) {
      store.append({ type: 'chat', sessionId: 's', data: { content: `msg-${i}` } })
    }
    const latest = store.getLatestSummary('s', 5)
    assert.strictEqual(latest.length, 5)
    assert.strictEqual(latest[0].data.content, 'msg-15')
  })

  it('getTimeline produces correct summaries', () => {
    store.append({ type: 'chat', sessionId: 's', data: { role: 'user', content: 'hello world' } })
    store.appendFork('s', 'child', 'do something')
    store.appendMerge('s', 'child', 'done')

    const timeline = store.getTimeline('s')
    assert.strictEqual(timeline.length, 3)
    assert.ok(timeline[0].summary.includes('hello'))
    assert.ok(timeline[1].summary.includes('分叉'))
    assert.ok(timeline[2].summary.includes('合流'))
  })
})

describe('SessionMap cleanup', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sia-sessmap-'))
  })

  it('should remove entries older than maxAgeDays', () => {
    const map = new SessionMap(tempDir)
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const newDate = new Date().toISOString()

    // Directly inject test data
    ;(map as any).mappings.set('old-session', { chatId: 'c1', lastActive: oldDate })
    ;(map as any).mappings.set('new-session', { chatId: 'c2', lastActive: newDate })
    ;(map as any).save()

    const removed = map.cleanup(7)
    assert.strictEqual(removed, 1)
    assert.strictEqual((map as any).mappings.size, 1)
    assert.ok((map as any).mappings.has('new-session'))
  })

  it('should return 0 when nothing to clean', () => {
    const map = new SessionMap(tempDir)
    const now = new Date().toISOString()
    ;(map as any).mappings.set('recent', { chatId: 'c1', lastActive: now })
    ;(map as any).save()

    assert.strictEqual(map.cleanup(7), 0)
  })

  it('should persist cleanup to disk', () => {
    const map = new SessionMap(tempDir)
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    ;(map as any).mappings.set('ancient', { sessionKey: 'ancient', chatId: 'c1', chatType: 'p2p', lastActive: oldDate })
    ;(map as any).mappings.set('fresh', { sessionKey: 'fresh', chatId: 'c2', chatType: 'p2p', lastActive: new Date().toISOString() })
    ;(map as any).save()

    map.cleanup(7)

    // Reload from disk
    const map2 = new SessionMap(tempDir)
    assert.strictEqual((map2 as any).mappings.size, 1)
    assert.ok((map2 as any).mappings.has('fresh'))
  })

  it('should not save when nothing removed', () => {
    const map = new SessionMap(tempDir)
    assert.strictEqual(map.cleanup(), 0)
  })

  it('should support custom maxAgeDays', () => {
    const map = new SessionMap(tempDir)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    ;(map as any).mappings.set('mid', { chatId: 'c1', lastActive: threeDaysAgo })
    ;(map as any).save()

    assert.strictEqual(map.cleanup(7), 0)  // 7 days → not cleaned
    assert.strictEqual(map.cleanup(2), 1)  // 2 days → cleaned
  })
})
