import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SiaMcpServer', () => {
  it('should start and respond to /health', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const server = await createSymbiontMcpServer(createStubHandler(), createTestLogger())
    after(() => server.close())

    assert.ok(server.port > 0, 'should bind to a port')
    assert.ok(server.url.includes('/mcp'), 'url should contain /mcp')

    // Health check
    const res = await fetch(`http://127.0.0.1:${server.port}/health`)
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.status, 'ok')
  })

  it('should handle multiple MCP sessions without "Already connected" error', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const server = await createSymbiontMcpServer(createStubHandler(), createTestLogger())
    after(() => server.close())

    // 模拟三个独立的 MCP 客户端 session（不带 session-id 的 initialize）
    // 每次都应该创建新的 transport 并成功连接，不报 "Already connected"
    for (let i = 0; i < 3; i++) {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: i + 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: `test-client-${i}`, version: '1.0.0' },
          },
        }),
      })
      assert.strictEqual(res.status, 200, `session ${i} should respond 200`)
      // Streamable HTTP 可能返回 SSE 或 JSON
      const body = await parseMcpResponse(res)
      assert.ok(body.result, `session ${i} should have result`)
      assert.ok(body.result.serverInfo, `session ${i} should have serverInfo`)
    }
  })

  it('should list tools via MCP protocol', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const server = await createSymbiontMcpServer(createStubHandler(), createTestLogger())
    after(() => server.close())

    // Step 1: Initialize
    const initRes = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    })
    assert.strictEqual(initRes.status, 200)
    const initBody = await parseMcpResponse(initRes)
    assert.ok(initBody.result, 'initialize should have result')
    const sessionId = initRes.headers.get('mcp-session-id')

    // Step 2: Send initialized notification
    await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/initialized',
      }),
    })

    // Step 3: List tools
    const toolsRes = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      }),
    })
    assert.strictEqual(toolsRes.status, 200)
    const toolsBody = await parseMcpResponse(toolsRes)
    assert.ok(toolsBody.result?.tools, 'should have tools array')

    const toolNames = toolsBody.result.tools.map((t: any) => t.name)
    assert.ok(toolNames.includes('symbiont_dispatch_worker'), 'should have symbiont_dispatch_worker')
    assert.ok(toolNames.includes('symbiont_remember'), 'should have symbiont_remember')
    assert.ok(toolNames.includes('symbiont_recall'), 'should have symbiont_recall')
    assert.ok(toolNames.length >= 7, `should have at least 7 tools, got ${toolNames.length}`)
  })
})

describe('SiaMcpServer sessionKey', () => {
  it('should pass sessionKey from URL query param to createFork handler', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    let capturedSk: string | undefined
    const server = await createSymbiontMcpServer(
      createStubHandler({
        onCreateFork: (_desc, sk) => { capturedSk = sk },
      }),
      createTestLogger(),
    )
    after(() => server.close())

    const skUrl = `${server.url}?sk=feishu%3Atopic123`

    // Step 1: Initialize with sk param
    const initRes = await fetch(skUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-sk', version: '1.0.0' },
        },
      }),
    })
    assert.strictEqual(initRes.status, 200)
    const initBody = await parseMcpResponse(initRes)
    assert.ok(initBody.result)
    const sessionId = initRes.headers.get('mcp-session-id')

    // Step 2: Send initialized notification
    await fetch(skUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/initialized',
      }),
    })

    // Step 3: Call symbiont_create_fork
    const forkRes = await fetch(skUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'symbiont_create_fork', arguments: { description: 'test fork' } },
      }),
    })
    assert.strictEqual(forkRes.status, 200)
    const forkBody = await parseMcpResponse(forkRes)
    assert.ok(forkBody.result, 'should have result')

    // Verify sessionKey was passed through
    assert.strictEqual(capturedSk, 'feishu:topic123', 'sessionKey should be decoded from URL')
  })

  it('should work without sessionKey (sk param absent)', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    let capturedSk: string | undefined = 'NOT_CALLED'
    const server = await createSymbiontMcpServer(
      createStubHandler({
        onCreateFork: (_desc, sk) => { capturedSk = sk },
      }),
      createTestLogger(),
    )
    after(() => server.close())

    // Initialize without sk
    const initRes = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-no-sk', version: '1.0.0' },
        },
      }),
    })
    assert.strictEqual(initRes.status, 200)
    const initBody = await parseMcpResponse(initRes)
    assert.ok(initBody.result)
    const sessionId = initRes.headers.get('mcp-session-id')

    // Send initialized
    await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/initialized',
      }),
    })

    // Call symbiont_create_fork
    await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'symbiont_create_fork', arguments: { description: 'test fork' } },
      }),
    })

    // sessionKey should be undefined when no sk param
    assert.strictEqual(capturedSk, undefined, 'sessionKey should be undefined without sk param')
  })
})

describe('WorkspaceManager MCP URL with sessionKey', () => {
  it('should write MCP URL with sk query param in .mcp.json', async () => {
    const { WorkspaceManager } = await import('../src/core/workspace-manager.ts')
    const { createTestLogger } = await import('./helpers.ts')
    const { loadPersona } = await import('../src/persona/loader.ts')
    const { loadUser } = await import('../src/user/loader.ts')
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))

    const tmpDir = mkdtempSync(join(tmpdir(), 'sia-ws-test-'))
    after(() => rmSync(tmpDir, { recursive: true }))

    const wm = new WorkspaceManager(tmpDir, createTestLogger())
    wm.registerMcp('symbiont-core', 'http://127.0.0.1:12345/mcp')

    const persona = loadPersona(join(__dirname, '..', 'persona-example'))
    const user = loadUser(join(__dirname, '..', 'user'))

    // Ensure workspace with sessionKey
    const ws = wm.ensure('feishu:topic123', persona, user, 'test task')
    const mcpJson = JSON.parse(readFileSync(join(ws.dir, '.mcp.json'), 'utf-8'))

    assert.ok(mcpJson.mcpServers['symbiont-core'], 'should have sia-core MCP entry')
    const url = mcpJson.mcpServers['symbiont-core'].url
    assert.ok(url.includes('?sk='), 'URL should contain ?sk= param')
    assert.ok(url.includes('feishu%3Atopic123'), 'URL should contain encoded sessionKey')
    assert.strictEqual(url, 'http://127.0.0.1:12345/mcp?sk=feishu%3Atopic123')
  })

  it('should write MCP URL without sk when no sessionKey concept needed', async () => {
    const { WorkspaceManager } = await import('../src/core/workspace-manager.ts')
    const { createTestLogger } = await import('./helpers.ts')
    const { loadPersona } = await import('../src/persona/loader.ts')
    const { loadUser } = await import('../src/user/loader.ts')
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))

    const tmpDir = mkdtempSync(join(tmpdir(), 'sia-ws-test2-'))
    after(() => rmSync(tmpDir, { recursive: true }))

    const wm = new WorkspaceManager(tmpDir, createTestLogger())
    wm.registerMcp('symbiont-core', 'http://127.0.0.1:12345/mcp')

    const persona = loadPersona(join(__dirname, '..', 'persona-example'))
    const user = loadUser(join(__dirname, '..', 'user'))

    // sessionKey is still passed (it's always required in ensure), but verify the URL format
    const ws = wm.ensure('terminal', persona, user)
    const mcpJson = JSON.parse(readFileSync(join(ws.dir, '.mcp.json'), 'utf-8'))

    const url = mcpJson.mcpServers['symbiont-core'].url
    assert.strictEqual(url, 'http://127.0.0.1:12345/mcp?sk=terminal', 'terminal session should also get sk param')
  })
})

/**
 * 解析 MCP Streamable HTTP 响应（可能是 JSON 或 SSE）。
 * SSE 格式：每行 "event: message\ndata: {...}\n\n"
 */
async function parseMcpResponse(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const text = await res.text()
    // 从 SSE 流中提取最后一个 data 行的 JSON
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '))
    for (const line of dataLines.reverse()) {
      try {
        return JSON.parse(line.slice(6))
      } catch { /* try next */ }
    }
    throw new Error(`No valid JSON in SSE response: ${text.slice(0, 200)}`)
  }
  return res.json()
}

function createStubHandler(opts?: { onCreateFork?: (desc: string, sk?: string, createTopic?: boolean) => void }) {
  return {
    dispatchWorker: async () => 'done',
    createFork: async (desc: string, sk?: string, createTopic?: boolean) => {
      opts?.onCreateFork?.(desc, sk, createTopic)
      return { id: 'fork-1' }
    },
    completeFork: async () => {},
    addMemoryCard: async () => 'card-1',
    updateMemoryCard: async () => 'updated',
    getMemoryCards: async () => [],
    decayMemory: async () => ({ decayed: 0, archived: 0 }),
    scanCognition: async () => [],
    getSystemStatus: () => ({}),
    getSystemLogs: () => '',
    evolve: async () => ({ success: true, result: 'ok' }),
    reload: () => {},
    scheduleRestart: () => {},
    cronAdd: () => ({ id: 'cron-1' }),
    cronList: () => [],
    cronRemove: () => true,
    personaList: () => [],
    personaGet: () => undefined,
    personaRescan: () => 0,
    listInstances: () => [],
    killInstance: () => false,
    compile: () => 'compiled',
    beginSettle: () => ({ prompt: '', usage: 0 }),
    addWish: () => ({ id: 'wish-1', title: 'test' }),
    wishList: () => [],
    updateWish: () => undefined,
    reportIssue: () => ({ id: 'issue-1', title: 'test' }),
    issueList: () => [],
    updateIssue: () => ({ id: 'issue-1', title: 'test', status: 'investigating' }),
    closeIssue: () => ({ id: 'issue-1', title: 'test', status: 'resolved' }),
    taskAdd: () => ({ id: 'task-1', title: 'test', status: 'todo', assignee: 'default', priority: 'normal' }),
    taskUpdate: () => undefined,
    taskList: () => [],
    changelog: () => [],
  }
}
