import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventStore } from '../src/core/event-store.ts'
import { MemoryDB } from '../src/memory/db.ts'

describe('EventStore', () => {
  let store: EventStore
  let db: MemoryDB

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sia-test-'))
    db = new MemoryDB(tempDir)
    store = new EventStore(db)
  })

  it('should append and read events', () => {
    store.append({ type: 'chat', sessionId: 'test-1', data: { content: 'hello' } })
    store.append({ type: 'chat', sessionId: 'test-1', data: { content: 'world' } })

    const events = store.read('test-1')
    assert.strictEqual(events.length, 2)
    assert.strictEqual(events[0].data.content, 'hello')
    assert.strictEqual(events[1].data.content, 'world')
  })

  it('should return empty array for non-existent session', () => {
    const events = store.read('no-such-session')
    assert.deepStrictEqual(events, [])
  })

  it('should generate unique ids', () => {
    const e1 = store.append({ type: 'chat', sessionId: 's1', data: {} })
    const e2 = store.append({ type: 'chat', sessionId: 's1', data: {} })
    assert.notStrictEqual(e1.id, e2.id)
  })
})
