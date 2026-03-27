import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PersonaRegistry } from '../src/persona/registry.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKS_DIR = join(__dirname, '..', 'persona-packs')

describe('E2E: Persona Pack Registry', () => {
  const registry = new PersonaRegistry()

  test('scan loads all packs from persona-packs/', () => {
    registry.scan(PACKS_DIR)
    assert.ok(registry.size >= 2, `Should have at least 2 packs, got ${registry.size}`)
    assert.ok(registry.get('default'), 'Should have default pack')
    assert.ok(registry.get('code-reviewer'), 'Should have code-reviewer pack')
  })

  test('match returns code-reviewer for review tasks', () => {
    const pack = registry.match('please review this PR for quality issues')
    assert.ok(pack)
    assert.equal(pack.name, 'code-reviewer')
  })

  test('match returns code-reviewer for tag overlap', () => {
    const pack = registry.match('need help with testing and lint setup')
    assert.ok(pack)
    assert.equal(pack.name, 'code-reviewer')
  })

  test('match returns default for unmatched tasks', () => {
    const pack = registry.match('帮我订机票')
    assert.ok(pack)
    assert.equal(pack.name, 'default')
  })

  test('get returns undefined for non-existent pack', () => {
    assert.equal(registry.get('nonexistent'), undefined)
  })

  test('list returns all manifests', () => {
    const manifests = registry.list()
    assert.ok(manifests.length >= 2)
    assert.ok(manifests.some(m => m.name === 'Code Reviewer'))
  })

  test('persona pack has valid soulPrompt', () => {
    const pack = registry.get('code-reviewer')
    assert.ok(pack?.persona.soulPrompt.includes('Code Reviewer'))
  })
})
