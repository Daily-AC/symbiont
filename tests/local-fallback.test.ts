// tests/local-fallback.test.ts — LocalFallback 降级通道单元测试
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalFallback } from '../src/core/local-fallback.ts'

describe('LocalFallback', () => {
  let tmpDir: string
  let fallback: LocalFallback

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sia-fallback-test-'))
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('isCriticalTool', () => {
    test('recognizes critical tools', () => {
      assert.ok(LocalFallback.isCriticalTool('symbiont_report_issue'))
      assert.ok(LocalFallback.isCriticalTool('symbiont_remember'))
      assert.ok(LocalFallback.isCriticalTool('symbiont_update_memory'))
    })

    test('rejects non-critical tools', () => {
      assert.ok(!LocalFallback.isCriticalTool('symbiont_recall'))
      assert.ok(!LocalFallback.isCriticalTool('symbiont_dispatch_worker'))
      assert.ok(!LocalFallback.isCriticalTool('random_tool'))
    })
  })

  describe('enqueue and drain', () => {
    test('enqueue stores entries and drain returns them in order', () => {
      fallback = new LocalFallback(tmpDir)
      fallback.enqueue('symbiont_remember', { key: 'greeting', value: 'hello' })
      fallback.enqueue('symbiont_report_issue', { title: 'bug', body: 'oops' })

      assert.equal(fallback.pendingCount, 2)

      const entries = fallback.drain()
      assert.equal(entries.length, 2)
      assert.equal(entries[0].tool, 'symbiont_remember')
      assert.deepEqual(entries[0].args, { key: 'greeting', value: 'hello' })
      assert.equal(entries[1].tool, 'symbiont_report_issue')
      assert.deepEqual(entries[1].args, { title: 'bug', body: 'oops' })

      // After drain, pendingCount is 0
      assert.equal(fallback.pendingCount, 0)
    })

    test('drain on empty returns empty array', () => {
      fallback = new LocalFallback(tmpDir)
      const entries = fallback.drain()
      assert.equal(entries.length, 0)
    })

    test('entries have timestamp', () => {
      fallback = new LocalFallback(tmpDir)
      const before = Date.now()
      fallback.enqueue('symbiont_remember', { key: 'test' })
      const after = Date.now()

      const entries = fallback.drain()
      assert.ok(entries[0].timestamp >= before)
      assert.ok(entries[0].timestamp <= after)
    })
  })

  describe('peek', () => {
    test('peek returns entries without consuming them', () => {
      fallback = new LocalFallback(tmpDir)
      fallback.enqueue('symbiont_update_memory', { id: '1', content: 'updated' })

      const peeked = fallback.peek()
      assert.equal(peeked.length, 1)
      assert.equal(fallback.pendingCount, 1)  // still there

      const drained = fallback.drain()
      assert.equal(drained.length, 1)
      assert.equal(fallback.pendingCount, 0)
    })
  })

  describe('JSONL persistence', () => {
    test('entries survive new instance (same dir)', () => {
      const persistDir = mkdtempSync(join(tmpdir(), 'sia-fallback-persist-'))
      try {
        const fb1 = new LocalFallback(persistDir)
        fb1.enqueue('symbiont_remember', { key: 'persist-test' })
        assert.equal(fb1.pendingCount, 1)

        // New instance reads from same file
        const fb2 = new LocalFallback(persistDir)
        assert.equal(fb2.pendingCount, 1)
        const entries = fb2.drain()
        assert.equal(entries[0].tool, 'symbiont_remember')
        assert.deepEqual(entries[0].args, { key: 'persist-test' })

        // File should be cleared after drain
        const fb3 = new LocalFallback(persistDir)
        assert.equal(fb3.pendingCount, 0)
      } finally {
        rmSync(persistDir, { recursive: true, force: true })
      }
    })

    test('JSONL file is created in fallback subdir', () => {
      const persistDir = mkdtempSync(join(tmpdir(), 'sia-fallback-file-'))
      try {
        const fb = new LocalFallback(persistDir)
        fb.enqueue('symbiont_remember', { key: 'file-check' })
        const filePath = join(persistDir, 'fallback', 'mcp-fallback.jsonl')
        assert.ok(existsSync(filePath))
        const content = readFileSync(filePath, 'utf-8').trim()
        const parsed = JSON.parse(content)
        assert.equal(parsed.tool, 'symbiont_remember')
      } finally {
        rmSync(persistDir, { recursive: true, force: true })
      }
    })
  })
})
