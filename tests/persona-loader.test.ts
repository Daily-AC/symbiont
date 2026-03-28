import { describe, it } from 'node:test'
import assert from 'node:assert'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPersona } from '../src/persona/loader.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('PersonaLoader', () => {
  const packDir = join(__dirname, '..', 'persona-example')

  it('should load soul prompt from persona pack', () => {
    const config = loadPersona(packDir)
    assert.ok(config.soulPrompt.includes('Echo'))
    assert.ok(config.soulPrompt.includes('companion'))
  })

  it('should have memoryDir pointing to persona memory', () => {
    const config = loadPersona(packDir)
    assert.ok(config.memoryDir.includes('persona-example'))
    assert.ok(config.memoryDir.includes('memory'))
  })

  it('should load manifest with permissions', () => {
    const config = loadPersona(packDir)
    assert.ok(config.manifest)
    assert.strictEqual(config.manifest!.name, 'echo')
    assert.ok(config.manifest!.permissions.writable.includes('voice/'))
    assert.ok(config.manifest!.permissions.protected.includes('soul/'))
  })
})
