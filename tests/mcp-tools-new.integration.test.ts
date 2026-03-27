// tests/mcp-tools-new.test.ts — MCP 工具层测试（新增工具）
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 解析 MCP Streamable HTTP 响应（可能是 JSON 或 SSE）
 */
async function parseMcpResponse(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const text = await res.text()
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '))
    for (const line of dataLines.reverse()) {
      try { return JSON.parse(line.slice(6)) } catch { /* try next */ }
    }
    throw new Error(`No valid JSON in SSE response: ${text.slice(0, 200)}`)
  }
  return res.json()
}

/** MCP session helper: initialize + notify + call tool */
async function mcpCall(baseUrl: string, toolName: string, args: Record<string, unknown>): Promise<any> {
  // Initialize
  const initRes = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }),
  })
  const sessionId = initRes.headers.get('mcp-session-id')
  await parseMcpResponse(initRes)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  }

  // Initialized notification
  await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })

  // Call tool
  const res = await fetch(baseUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }),
  })
  return parseMcpResponse(res)
}

function createStubHandler() {
  const tasks: Map<string, Record<string, unknown>> = new Map()
  const wishes: Array<{ id: string; title: string; reason?: string; priority?: string }> = []
  let memoryCards: Array<{ id: string; content: string; scene: string; tags: string[]; confidence: number }> = []
  let lastUpdateCall: { id: string; updates: Record<string, unknown> } | null = null

  return {
    dispatchWorker: async () => 'done',
    createFork: async () => ({ id: 'fork-1' }),
    completeFork: async () => {},
    addMemoryCard: async (content: string, scene: string, tags: string[], confidence: number) => {
      const id = `card-test-${Date.now()}`
      memoryCards.push({ id, content, scene, tags, confidence })
      return id
    },
    updateMemoryCard: async (id: string, updates: Record<string, unknown>) => {
      lastUpdateCall = { id, updates }
      return `已更新卡片 ${id}`
    },
    getMemoryCards: async () => memoryCards.map(c => ({ ...c })),
    decayMemory: async () => ({ decayed: 0, archived: 0 }),
    scanCognition: async () => [],
    getSystemStatus: () => ({}),
    getInstances: () => [],
    getCronJobs: () => [],
    addCronJob: () => ({ id: 'cron-1' }),
    removeCronJob: () => true,
    getLogs: () => [],
    listPersonas: () => [],
    killInstance: () => true,
    compile: () => 'compiled',
    beginSettle: () => ({ prompt: 'settle', usage: 0 }),
    addWish: (title: string, reason?: string, priority?: string) => {
      const id = `wish-test-${Date.now()}`
      wishes.push({ id, title, reason, priority })
      return { id, title }
    },
    taskAdd: (title: string, description?: string, assignee?: string, priority?: string, due_date?: string) => {
      const id = `task-test-${Date.now()}`
      const task = { id, title, description, assignee: assignee ?? 'xiaoxi', status: 'todo', priority: priority ?? 'normal', due_date, created_at: new Date().toISOString() }
      tasks.set(id, task)
      return task
    },
    taskUpdate: (id: string, updates: Record<string, unknown>) => {
      const task = tasks.get(id)
      if (!task) return undefined
      Object.assign(task, updates)
      return task
    },
    taskList: (status?: string, assignee?: string) => {
      let result = [...tasks.values()]
      if (status) result = result.filter(t => t.status === status)
      if (assignee) result = result.filter(t => t.assignee === assignee)
      return result
    },

    // test helpers
    _getWishes: () => wishes,
    _getLastUpdate: () => lastUpdateCall,
  }
}

describe('MCP new tools', () => {
  it('should list new tools including symbiont_wish, symbiont_task_*, symbiont_update_memory', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const server = await createSymbiontMcpServer(createStubHandler(), createTestLogger())
    after(() => server.close())

    // Initialize
    const initRes = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      }),
    })
    const initBody = await parseMcpResponse(initRes)
    const sessionId = initRes.headers.get('mcp-session-id')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    }

    await fetch(server.url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })

    const toolsRes = await fetch(server.url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    const toolsBody = await parseMcpResponse(toolsRes)
    const toolNames = toolsBody.result.tools.map((t: any) => t.name)

    assert.ok(toolNames.includes('symbiont_wish'), 'should have symbiont_wish')
    assert.ok(toolNames.includes('symbiont_task_add'), 'should have symbiont_task_add')
    assert.ok(toolNames.includes('symbiont_task_update'), 'should have symbiont_task_update')
    assert.ok(toolNames.includes('symbiont_task_list'), 'should have symbiont_task_list')
    assert.ok(toolNames.includes('symbiont_update_memory'), 'should have symbiont_update_memory')
  })

  it('symbiont_wish creates wish', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const handler = createStubHandler()
    const server = await createSymbiontMcpServer(handler, createTestLogger())
    after(() => server.close())

    const body = await mcpCall(server.url, 'symbiont_wish', { title: '学会画画', reason: '想给以琳画头像', priority: 'high' })
    assert.ok(body.result)
    const text = body.result.content[0].text
    assert.ok(text.includes('愿望已许下'), `should contain 愿望已许下, got: ${text}`)
    assert.ok(text.includes('学会画画'))

    assert.equal(handler._getWishes().length, 1)
    assert.equal(handler._getWishes()[0].title, '学会画画')
  })

  it('symbiont_task_add creates task', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const handler = createStubHandler()
    const server = await createSymbiontMcpServer(handler, createTestLogger())
    after(() => server.close())

    const body = await mcpCall(server.url, 'symbiont_task_add', {
      title: '修复飞书引用',
      assignee: 'xiaoxi',
      priority: 'high',
    })
    const text = body.result.content[0].text
    assert.ok(text.includes('任务已创建'), `should contain 任务已创建, got: ${text}`)
    assert.ok(text.includes('修复飞书引用'))
  })

  it('symbiont_task_list lists tasks', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const handler = createStubHandler()
    const server = await createSymbiontMcpServer(handler, createTestLogger())
    after(() => server.close())

    // Add tasks first
    await mcpCall(server.url, 'symbiont_task_add', { title: '任务A' })
    await mcpCall(server.url, 'symbiont_task_add', { title: '任务B' })

    const body = await mcpCall(server.url, 'symbiont_task_list', {})
    const text = body.result.content[0].text
    assert.ok(text.includes('任务A'))
    assert.ok(text.includes('任务B'))
  })

  it('symbiont_task_list returns empty message when no tasks', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const server = await createSymbiontMcpServer(createStubHandler(), createTestLogger())
    after(() => server.close())

    const body = await mcpCall(server.url, 'symbiont_task_list', {})
    const text = body.result.content[0].text
    assert.ok(text.includes('当前没有任务'))
  })

  it('symbiont_task_update updates task', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const handler = createStubHandler()
    const server = await createSymbiontMcpServer(handler, createTestLogger())
    after(() => server.close())

    // Create a task first
    const addBody = await mcpCall(server.url, 'symbiont_task_add', { title: '待更新' })
    const id = addBody.result.content[0].text.match(/task-test-\d+/)?.[0]
    assert.ok(id, 'should extract task id from response')

    const body = await mcpCall(server.url, 'symbiont_task_update', { id, status: 'done' })
    const text = body.result.content[0].text
    assert.ok(text.includes('任务已更新'), `should contain 任务已更新, got: ${text}`)
  })

  it('symbiont_task_update returns error for nonexistent', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const server = await createSymbiontMcpServer(createStubHandler(), createTestLogger())
    after(() => server.close())

    const body = await mcpCall(server.url, 'symbiont_task_update', { id: 'task-nope', status: 'done' })
    const text = body.result.content[0].text
    assert.ok(text.includes('任务不存在'))
  })

  it('symbiont_update_memory calls handler', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const handler = createStubHandler()
    const server = await createSymbiontMcpServer(handler, createTestLogger())
    after(() => server.close())

    const body = await mcpCall(server.url, 'symbiont_update_memory', { id: 'card-123', content: '新内容', confidence: 0.9 })
    const text = body.result.content[0].text
    assert.ok(text.includes('已更新卡片 card-123'))

    const lastCall = handler._getLastUpdate()
    assert.ok(lastCall)
    assert.equal(lastCall.id, 'card-123')
    assert.equal(lastCall.updates.content, '新内容')
    assert.equal(lastCall.updates.confidence, 0.9)
  })

  it('symbiont_recall returns card ids', async () => {
    const { createSymbiontMcpServer } = await import('../src/core/symbiont-mcp-server.ts')
    const { createTestLogger } = await import('./helpers.ts')

    const handler = createStubHandler()
    // Pre-populate a card
    await handler.addMemoryCard('测试内容', '测试场景', ['tag1'], 0.8)

    const server = await createSymbiontMcpServer(handler, createTestLogger())
    after(() => server.close())

    const body = await mcpCall(server.url, 'symbiont_recall', { keyword: '测试' })
    const text = body.result.content[0].text
    assert.ok(text.includes('card-test-'), 'recall should include card id')
    assert.ok(text.includes('测试内容'))
  })
})
