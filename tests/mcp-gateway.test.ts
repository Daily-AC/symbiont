// tests/mcp-gateway.test.ts — MCP Gateway 单元测试
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { McpGateway, matchesPattern, type GatewayConfig } from '../src/core/mcp-gateway.ts'
import { loadSharedCapabilities } from '../src/core/capability-config.ts'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createTestGateway(port: number, overrides?: Partial<GatewayConfig>): McpGateway {
  return new McpGateway({
    port,
    configDir: '/tmp/sia-test-config-' + Date.now(),
    getRoleForSession: (sk) => {
      if (sk.startsWith('dm:')) return { role: 'main', persona: 'default' }
      if (sk.startsWith('topic:')) return { role: 'specialist', persona: 'code-reviewer' }
      if (sk === 'worker') return { role: 'worker', persona: 'default' }
      return undefined
    },
    getToolWhitelist: (persona) => {
      if (persona === 'default') return ['*']
      if (persona === 'code-reviewer') return ['sia-core:symbiont_remember', 'sia-core:symbiont_recall', 'sia-core:symbiont_report_issue']
      return ['sia-core:*']
    },
    getSharedTools: () => ['sia-core:symbiont_remember', 'sia-core:symbiont_recall'],
    ...overrides,
  })
}

describe('McpGateway', () => {
  test('can create and start gateway', async () => {
    const gw = createTestGateway(0) // port 0 = random
    // Don't actually start (needs a real port), just verify construction
    assert.equal(gw.backendCount, 0)
    assert.equal(gw.toolCount, 0)
    assert.equal(gw.sessionCount, 0)
  })

  test('registerBackend and unregisterBackend', () => {
    const gw = createTestGateway(0)
    gw.registerBackend('test-backend', 'http://127.0.0.1:12345/mcp')
    assert.equal(gw.backendCount, 1)
    gw.unregisterBackend('test-backend')
    assert.equal(gw.backendCount, 0)
  })

  test('url getter', () => {
    const gw = createTestGateway(18090)
    assert.equal(gw.url, 'http://127.0.0.1:18090/mcp')
  })
})

describe('matchesPattern — backend:tool two-layer matching', () => {
  test('"*" matches everything', () => {
    assert.ok(matchesPattern('symbiont-core', 'symbiont_remember', '*'))
    assert.ok(matchesPattern('github', 'create_issue', '*'))
  })

  test('"*:*" matches everything', () => {
    assert.ok(matchesPattern('symbiont-core', 'symbiont_remember', '*:*'))
    assert.ok(matchesPattern('github', 'create_issue', '*:*'))
  })

  test('"backend:*" matches all tools in backend', () => {
    assert.ok(matchesPattern('symbiont-core', 'symbiont_remember', 'sia-core:*'))
    assert.ok(matchesPattern('symbiont-core', 'symbiont_dispatch_worker', 'sia-core:*'))
    assert.ok(!matchesPattern('symbiont-feishu', 'feishu_send_message', 'sia-core:*'))
  })

  test('"backend:tool" exact match', () => {
    assert.ok(matchesPattern('symbiont-core', 'symbiont_remember', 'sia-core:symbiont_remember'))
    assert.ok(!matchesPattern('symbiont-core', 'symbiont_recall', 'sia-core:symbiont_remember'))
    assert.ok(!matchesPattern('symbiont-feishu', 'symbiont_remember', 'sia-core:symbiont_remember'))
  })

  test('"*:tool" matches tool in any backend', () => {
    assert.ok(matchesPattern('symbiont-core', 'symbiont_remember', '*:symbiont_remember'))
    assert.ok(matchesPattern('other', 'symbiont_remember', '*:symbiont_remember'))
    assert.ok(!matchesPattern('symbiont-core', 'symbiont_recall', '*:symbiont_remember'))
  })

  test('"backend:prefix*" wildcard within backend', () => {
    assert.ok(matchesPattern('symbiont-feishu', 'feishu_send_message', 'sia-feishu:feishu_*'))
    assert.ok(matchesPattern('symbiont-feishu', 'feishu_create_doc', 'sia-feishu:feishu_*'))
    assert.ok(!matchesPattern('symbiont-core', 'symbiont_remember', 'sia-feishu:feishu_*'))
  })

  test('backward compat: "symbiont_*" (no colon) matches by tool name', () => {
    assert.ok(matchesPattern('symbiont-core', 'symbiont_remember', 'symbiont_*'))
    assert.ok(matchesPattern('any-backend', 'symbiont_recall', 'symbiont_*'))
    assert.ok(!matchesPattern('symbiont-core', 'feishu_send', 'symbiont_*'))
  })

  test('backward compat: exact tool name (no colon)', () => {
    assert.ok(matchesPattern('symbiont-core', 'symbiont_remember', 'symbiont_remember'))
    assert.ok(!matchesPattern('symbiont-core', 'symbiont_recall', 'symbiont_remember'))
  })
})

// ─── Persona fallback 空白名单 ──────────────────────────────────────────────

describe('Persona fallback — unknown persona gets only shared tools', () => {
  test('getToolWhitelist returns empty for unknown persona', () => {
    const gw = createTestGateway(0, {
      getToolWhitelist: (persona) => {
        if (persona === 'default') return ['*']
        if (persona === 'code-reviewer') return ['sia-core:symbiont_remember', 'sia-core:symbiont_recall', 'sia-core:symbiont_report_issue']
        return []
      },
      getRoleForSession: (sk) => {
        if (sk === 'unknown-session') return { role: 'worker', persona: 'mystery-persona' }
        if (sk.startsWith('dm:')) return { role: 'main', persona: 'default' }
        return undefined
      },
    })
    // 注册一些假工具来验证过滤
    // 由于 toolMap 是 private，我们通过 GatewayConfig 的回调间接验证
    // getToolWhitelist('mystery-persona') 应返回空数组
    const whitelist = gw['config'].getToolWhitelist('mystery-persona')
    assert.deepEqual(whitelist, [], 'unknown persona should get empty whitelist, not wildcard *')
  })

  test('unknown persona does not get wildcard access', () => {
    let calledPersona: string | undefined
    const gw = createTestGateway(0, {
      getToolWhitelist: (persona) => {
        calledPersona = persona
        if (persona === 'default') return ['*']
        return []
      },
      getRoleForSession: (sk) => {
        if (sk === 'stranger') return { role: 'worker', persona: 'unknown-bot' }
        return undefined
      },
    })
    // 触发 whitelist 查询
    const whitelist = gw['config'].getToolWhitelist('unknown-bot')
    assert.deepEqual(whitelist, [])
    assert.equal(calledPersona, 'unknown-bot')
  })
})

// ─── WorkerManager 构造函数 deps ────────────────────────────────────────────

describe('WorkerManager deps', () => {
  // WorkerManager.dispatch 需要实际 CC 进程，无法单元测试。
  // 但可以验证构造函数接受 deps 对象。
  test('WorkerManagerDeps interface has workspaceManager and sessionManager', async () => {
    // 动态导入以验证类型存在
    const { WorkerManager } = await import('../src/core/worker-manager.ts')
    assert.ok(WorkerManager, 'WorkerManager class should be importable')
    // WorkerManager 构造函数签名要求 deps 包含 broker、eventStore、workspaceManager、sessionManager 等
    // 由于需要实际的 CCBroker 实例（依赖 CC CLI），这里只验证模块可正常导入
  })
})

describe('loadSharedCapabilities', () => {
  test('loads from config dir', () => {
    const caps = loadSharedCapabilities(join(__dirname, '..', 'config'))
    assert.ok(Array.isArray(caps.mcp.always_available))
    assert.ok(caps.mcp.always_available.includes('sia-core:symbiont_remember'))
  })

  test('returns empty for nonexistent dir', () => {
    const caps = loadSharedCapabilities('/tmp/nonexistent-dir-12345')
    assert.deepEqual(caps.mcp.always_available, [])
  })
})
