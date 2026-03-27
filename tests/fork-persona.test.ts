import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { ForkSession, ForkConfig } from '../src/core/fork-manager.ts'

describe('Fork persona tracking', () => {
  test('ForkSession includes persona field', () => {
    const session: ForkSession = {
      id: 'fork-test',
      instanceId: 'inst-1',
      eventSessionId: 'evt-1',
      description: 'test fork',
      parentSessionId: 'parent-1',
      state: 'active',
      persona: 'code-reviewer',
    }
    assert.equal(session.persona, 'code-reviewer')
  })

  test('ForkSession persona defaults to undefined', () => {
    const session: ForkSession = {
      id: 'fork-test-2',
      instanceId: 'inst-2',
      eventSessionId: 'evt-2',
      description: 'test fork without persona',
      parentSessionId: 'parent-2',
      state: 'active',
    }
    assert.equal(session.persona, undefined)
  })

  test('ForkConfig accepts persona', () => {
    const config: ForkConfig = {
      description: 'review code',
      parentSessionId: 'parent-1',
      persona: 'code-reviewer',
    }
    assert.equal(config.persona, 'code-reviewer')
  })
})
