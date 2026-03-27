// tests/settler.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { Settler } from '../src/memory/settler.ts'

function makeLogger() {
  const logs: Array<{ level: string; mod: string; event: string; meta?: any }> = []
  return {
    logs,
    info(mod: string, event: string, meta?: any) { logs.push({ level: 'info', mod, event, meta }) },
    error(mod: string, event: string, meta?: any) { logs.push({ level: 'error', mod, event, meta }) },
  }
}

describe('Settler', () => {
  let db: MemoryDB
  let tmpDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-settler-test-'))
    db = new MemoryDB(tmpDir)
  })
  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }) })

  test('shouldSettle returns false when no usage recorded', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    assert.strictEqual(settler.shouldSettle('session-1'), false)
  })

  test('shouldSettle returns false when under threshold', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('session-2', 39000, 100000) // 39% (threshold is 40%)
    assert.strictEqual(settler.shouldSettle('session-2'), false)
  })

  test('shouldSettle returns true when at threshold (50%)', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('session-3', 50000, 100000) // exactly 50%
    assert.strictEqual(settler.shouldSettle('session-3'), true)
  })

  test('shouldSettle returns true when above threshold', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('session-4', 80000, 100000) // 80%
    assert.strictEqual(settler.shouldSettle('session-4'), true)
  })

  test('recordUsage tracks per-session usage', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('s-a', 20000, 100000)
    settler.recordUsage('s-b', 60000, 100000)
    assert.strictEqual(settler.shouldSettle('s-a'), false)
    assert.strictEqual(settler.shouldSettle('s-b'), true)
  })

  test('getUsagePercent returns correct percentage', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('s-pct', 75000, 100000)
    assert.strictEqual(settler.getUsagePercent('s-pct'), 75)
  })

  test('getUsagePercent returns 0 for unknown session', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    assert.strictEqual(settler.getUsagePercent('nonexistent'), 0)
  })

  test('beginSettle returns settle prompt and logs activity', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('s-settle', 60000, 100000)

    const prompt = settler.beginSettle('s-settle')
    assert.ok(prompt.includes('上下文沉淀'))
    assert.ok(prompt.includes('60%'))
    assert.strictEqual(settler.settleStatus, 'in_progress')

    // Check logger was called
    assert.ok(logger.logs.some(l => l.mod === 'settler' && l.event === 'begin'))

    // Check activity was logged to db
    const activity = db.getActivity(10)
    assert.ok(activity.some(a => a.type === 'settle' && a.detail.includes('in_progress')))
  })

  test('completeSettle resets state', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('s-complete', 60000, 100000)
    settler.beginSettle('s-complete')

    settler.completeSettle('s-complete')
    assert.strictEqual(settler.settleStatus, 'idle')  // 完成后无活跃沉淀
    // Usage should be cleared for this session
    assert.strictEqual(settler.getUsagePercent('s-complete'), 0)

    // Check activity logged
    const activity = db.getActivity(10)
    assert.ok(activity.some(a => a.type === 'settle' && a.detail.includes('done')))
  })

  test('reset clears status', () => {
    const logger = makeLogger()
    const settler = new Settler({ logger, db })
    settler.recordUsage('s-reset', 60000, 100000)
    settler.beginSettle('s-reset')
    assert.strictEqual(settler.settleStatus, 'in_progress')

    settler.reset('s-reset')
    assert.strictEqual(settler.settleStatus, 'idle')
  })
})
