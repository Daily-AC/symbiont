// tests/phase4-management.test.ts — Phase 4 管理工具测试
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { McpGateway, type GatewayConfig } from '../src/core/mcp-gateway.ts'
import { loadManifest, updateManifestField } from '../src/persona/manifest.ts'
import { loadSharedCapabilities, updateSharedCapabilities } from '../src/core/capability-config.ts'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function createTempDir(): string {
  const dir = join(tmpdir(), 'symbiont-phase4-test-' + randomUUID().slice(0, 8))
  mkdirSync(dir, { recursive: true })
  return dir
}

// ─── Gateway Temporary Grants ────────────────────────────────────────────────

describe('Gateway Temporary Grants', () => {
  function createTestGateway(): McpGateway {
    return new McpGateway({
      port: 0,
      getRoleForSession: (sk) => {
        if (sk === 'worker-1') return { role: 'worker', persona: 'default' }
        if (sk === 'main') return { role: 'main', persona: 'xiaoxi' }
        return undefined
      },
      getToolWhitelist: (persona) => {
        if (persona === 'xiaoxi') return ['*']
        return ['symbiont_remember', 'symbiont_recall']
      },
      getSharedTools: () => ['symbiont_remember', 'symbiont_recall'],
    })
  }

  test('grantTool adds temporary grant', () => {
    const gw = createTestGateway()
    gw.grantTool('worker-1', 'symbiont_evolve', 60000)
    const grants = gw.getTemporaryGrants('worker-1')
    assert.ok(grants.includes('symbiont_evolve'))
  })

  test('revokeTool removes grant', () => {
    const gw = createTestGateway()
    gw.grantTool('worker-1', 'symbiont_evolve', 60000)
    assert.ok(gw.revokeTool('worker-1', 'symbiont_evolve'))
    assert.deepEqual(gw.getTemporaryGrants('worker-1'), [])
  })

  test('revokeTool returns false for non-existent grant', () => {
    const gw = createTestGateway()
    assert.equal(gw.revokeTool('worker-1', 'symbiont_evolve'), false)
  })

  test('expired grants are cleaned up', () => {
    const gw = createTestGateway()
    // Grant with 0ms duration (already expired)
    gw.grantTool('worker-1', 'symbiont_evolve', 0)
    // getTemporaryGrants should clean up expired
    const grants = gw.getTemporaryGrants('worker-1')
    assert.deepEqual(grants, [])
  })

  test('grants are session-scoped', () => {
    const gw = createTestGateway()
    gw.grantTool('worker-1', 'symbiont_evolve', 60000)
    gw.grantTool('worker-2', 'symbiont_cron_add', 60000)
    assert.deepEqual(gw.getTemporaryGrants('worker-1'), ['symbiont_evolve'])
    assert.deepEqual(gw.getTemporaryGrants('worker-2'), ['symbiont_cron_add'])
  })
})

// ─── updateManifestField ─────────────────────────────────────────────────────

describe('updateManifestField', () => {
  let tempDir: string

  before(() => {
    tempDir = createTempDir()
    writeFileSync(join(tempDir, 'manifest.yaml'), `name: Test Pack
description: Test persona
tags:
  - test

mcp:
  tools:
    - "symbiont_remember"
    - "symbiont_recall"

skills:
  include:
    - "code-review"
`)
  })

  after(() => {
    rmSync(tempDir, { recursive: true })
  })

  test('updates mcp.tools', () => {
    updateManifestField(tempDir, 'mcp.tools', ['symbiont_*', 'feishu_*'])
    const manifest = loadManifest(tempDir)
    assert.ok(manifest)
    assert.deepEqual(manifest.mcp?.tools, ['symbiont_*', 'feishu_*'])
  })

  test('updates skills.include', () => {
    updateManifestField(tempDir, 'skills.include', ['deploy', 'security-audit'])
    const manifest = loadManifest(tempDir)
    assert.ok(manifest)
    assert.deepEqual(manifest.skills?.include, ['deploy', 'security-audit'])
  })

  test('updates to empty list', () => {
    updateManifestField(tempDir, 'skills.include', [])
    const manifest = loadManifest(tempDir)
    assert.ok(manifest)
    // Empty list should result in no skills
    assert.ok(!manifest.skills?.include || manifest.skills.include.length === 0)
  })

  test('throws for missing manifest', () => {
    assert.throws(() => {
      updateManifestField('/tmp/nonexistent-pack-12345', 'mcp.tools', ['test'])
    })
  })
})

// ─── updateSharedCapabilities ────────────────────────────────────────────────

describe('updateSharedCapabilities', () => {
  let tempDir: string

  before(() => {
    tempDir = createTempDir()
    writeFileSync(join(tempDir, 'shared-capabilities.json'), JSON.stringify({
      mcp: { always_available: ['symbiont_remember'] },
      skills: { always_available: [] },
    }, null, 2))
  })

  after(() => {
    rmSync(tempDir, { recursive: true })
  })

  test('updates mcp.always_available', () => {
    updateSharedCapabilities(tempDir, 'mcp.always_available', ['symbiont_remember', 'symbiont_recall', 'symbiont_request_tool'])
    const caps = loadSharedCapabilities(tempDir)
    assert.deepEqual(caps.mcp.always_available, ['symbiont_remember', 'symbiont_recall', 'symbiont_request_tool'])
  })

  test('updates skills.always_available', () => {
    updateSharedCapabilities(tempDir, 'skills.always_available', ['commit', 'review-pr'])
    const caps = loadSharedCapabilities(tempDir)
    assert.deepEqual(caps.skills.always_available, ['commit', 'review-pr'])
  })

  test('preserves other fields when updating one', () => {
    updateSharedCapabilities(tempDir, 'mcp.always_available', ['symbiont_remember'])
    const caps = loadSharedCapabilities(tempDir)
    // skills should still have the values from previous test
    assert.deepEqual(caps.skills.always_available, ['commit', 'review-pr'])
  })
})

// ─── Real persona-packs validation ───────────────────────────────────────────

describe('Persona packs skills.include restored', () => {
  const siaRoot = join(import.meta.dirname!, '..')

  test('code-reviewer has correct skills', () => {
    const manifest = loadManifest(join(siaRoot, 'persona-packs', 'code-reviewer'))
    assert.ok(manifest)
    assert.ok(manifest.skills?.include?.includes('code-review'), 'should include code-review')
    assert.ok(manifest.skills?.include?.includes('security-audit'), 'should include security-audit')
    assert.ok(!manifest.skills?.include?.includes('*'), 'should not include wildcard *')
  })

  test('default has empty skills', () => {
    const manifest = loadManifest(join(siaRoot, 'persona-packs', 'default'))
    assert.ok(manifest)
    assert.ok(!manifest.skills?.include || manifest.skills.include.length === 0, 'default should have no skills')
  })

  test('frontend has correct skills', () => {
    const manifest = loadManifest(join(siaRoot, 'persona-packs', 'frontend'))
    assert.ok(manifest)
    assert.ok(manifest.skills?.include?.includes('frontend-design'), 'should include frontend-design')
    assert.ok(!manifest.skills?.include?.includes('*'), 'should not include wildcard *')
  })

  test('code-reviewer mcp tools preserved', () => {
    const manifest = loadManifest(join(siaRoot, 'persona-packs', 'code-reviewer'))
    assert.ok(manifest)
    assert.ok(manifest.mcp?.tools?.includes('symbiont_remember'))
    assert.ok(manifest.mcp?.tools?.includes('symbiont_recall'))
    assert.ok(manifest.mcp?.tools?.includes('symbiont_report_issue'))
  })
})
