import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestCore } from './helpers.ts'
import type { SymbiontCore } from '../src/core/symbiont-core.ts'
import type { SymbiontMcpToolHandler } from '../src/core/symbiont-mcp-server.ts'
import { SessionMap } from '../src/interface/feishu/session-map.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PERSONA_PACKS_DIR = join(__dirname, '..', 'persona-packs')

/**
 * MCP Tools E2E 测试 — cron CRUD、persona list、显式 persona 派遣。
 *
 * 不启动真实 CC，直接构造 handler 层测试逻辑。
 * handler 的构造方式与 SymbiontCore.startMcpServer 一致（复制其 wiring 逻辑）。
 */

let core: SymbiontCore
let handler: SymbiontMcpToolHandler

/** 记录 dispatchWorker / createForkFor 的调用参数 */
let capturedWorkerCalls: Array<{ description: string; systemPrompt?: string; isAsync?: boolean; persona?: string }>
let capturedForkCalls: Array<{ sessionKey: string; description: string; options?: { systemPrompt?: string; createTopic?: boolean; persona?: string } }>

beforeEach(() => {
  const t = createTestCore('mcp-tools')
  core = t.core

  // Scan real persona-packs directory (SymbiontCore scans dataDir/../persona-packs which is a temp dir)
  core.personaRegistry.scan(PERSONA_PACKS_DIR)

  capturedWorkerCalls = []
  capturedForkCalls = []

  // Mock router — 捕获参数但不真正启动 CC
  const mockRouter = {
    dispatchWorker(desc: string, sp?: string, isAsync?: boolean, persona?: string): Promise<string> {
      capturedWorkerCalls.push({ description: desc, systemPrompt: sp, isAsync, persona })
      return Promise.resolve('worker-done')
    },
    createForkFor(sessionKey: string, desc: string, opts?: { systemPrompt?: string; createTopic?: boolean; persona?: string }): Promise<{ id: string }> {
      capturedForkCalls.push({ sessionKey, description: desc, options: opts })
      return Promise.resolve({ id: 'fork-mock-1' })
    },
    completeForkFor(_sk: string, _summary: string): Promise<void> {
      return Promise.resolve()
    },
  }

  // 构造 handler（与 SymbiontCore.startMcpServer 中的 wiring 保持一致）
  handler = {
    dispatchWorker: (desc, sp, _tools, isAsync, persona) => mockRouter.dispatchWorker(desc, sp, isAsync, persona),
    createFork: (desc, sk, createTopic, persona) => mockRouter.createForkFor(sk ?? 'terminal', desc, { createTopic, persona }),
    completeFork: (summary, sk) => mockRouter.completeForkFor(sk ?? 'terminal', summary),
    addMemoryCard: async (content, scene, tags, confidence) => {
      const card = core.memoryBridge.add({
        content, scene, tags, confidence: confidence ?? 0.7,
        source: [], connections: [],
      })
      return card.id
    },
    getMemoryCards: async (keyword, tags) => {
      const query: { keyword?: string; tags?: string[] } = {}
      if (keyword) query.keyword = keyword
      if (tags?.length) query.tags = tags
      return core.memoryBridge.search(query).map(c => ({
        content: c.content, scene: c.scene, tags: c.tags, confidence: c.confidence,
      }))
    },
    decayMemory: async () => ({ decayed: 0, archived: 0 }),
    scanCognition: async () => [],
    getSystemStatus: () => core.getSystemStatus(),
    getSystemLogs: (lines) => core.getSystemLogs(lines),
    evolve: async () => ({ success: false, result: 'not-in-test' }),
    reload: () => {},
    scheduleRestart: () => {},
    cronAdd: (name, schedule, prompt, options) => {
      const job = core.cronScheduler.addJob({
        name, schedule, executor: 'cc', prompt,
        enabled: true,
        timezone: options?.timezone,
        overlapPolicy: 'skip',
      })
      return { id: job.id }
    },
    cronList: () => {
      return core.cronScheduler.listJobs().map(j => ({
        id: j.id, name: j.name, schedule: j.schedule, enabled: j.enabled,
      }))
    },
    cronRemove: (id) => {
      const job = core.cronScheduler.getJob(id)
      if (!job) return false
      core.cronScheduler.removeJob(id)
      return true
    },
    personaList: () => {
      return core.personaRegistry.list().map(m => ({
        name: m.name, description: m.description, tags: m.tags,
      }))
    },
    personaGet: (name) => {
      return core.personaRegistry.get(name)?.persona.soulPrompt
    },
  }
})

afterEach(async () => {
  core.cronScheduler.stop()
})

// ---- 1. symbiont_cron_add 创建持久化任务 ----

describe('symbiont_cron_add', () => {
  it('should create a persistent cron job', () => {
    const result = handler.cronAdd('叫以琳起床', '0 8 * * *', '叫以琳起床啦', { timezone: 'Asia/Shanghai' })

    assert.ok(result.id, 'should return an id')
    assert.ok(result.id.startsWith('cron-'), 'id should have cron- prefix')

    const jobs = core.cronScheduler.listJobs()
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].name, '叫以琳起床')
    assert.equal(jobs[0].schedule, '0 8 * * *')
    assert.equal(jobs[0].prompt, '叫以琳起床啦')
    assert.equal(jobs[0].enabled, true)
  })
})

// ---- 2. symbiont_cron_list 返回所有任务 ----

describe('symbiont_cron_list', () => {
  it('should return all jobs', () => {
    core.cronScheduler.addJob({ name: 'job-a', schedule: '*/5 * * * *', executor: 'cc', prompt: 'a', enabled: true, overlapPolicy: 'skip' })
    core.cronScheduler.addJob({ name: 'job-b', schedule: '0 12 * * *', executor: 'cc', prompt: 'b', enabled: true, overlapPolicy: 'skip' })

    const list = handler.cronList()
    assert.equal(list.length, 2)

    const names = list.map(j => j.name).sort()
    assert.deepEqual(names, ['job-a', 'job-b'])

    // 每个 item 都有必要字段
    for (const item of list) {
      assert.ok(item.id)
      assert.ok(item.name)
      assert.ok(item.schedule)
      assert.equal(typeof item.enabled, 'boolean')
    }
  })
})

// ---- 3. symbiont_cron_remove 删除任务 ----

describe('symbiont_cron_remove', () => {
  it('should remove an existing job', () => {
    const job = core.cronScheduler.addJob({ name: 'to-remove', schedule: '0 0 * * *', executor: 'cc', prompt: 'x', enabled: true, overlapPolicy: 'skip' })

    assert.equal(core.cronScheduler.listJobs().length, 1)

    const ok = handler.cronRemove(job.id)
    assert.equal(ok, true)
    assert.equal(core.cronScheduler.listJobs().length, 0)
  })

  it('should return false for non-existent job', () => {
    const ok = handler.cronRemove('cron-nonexistent')
    assert.equal(ok, false)
  })
})

// ---- 4. symbiont_persona_list 返回可用角色 ----

describe('symbiont_persona_list', () => {
  it('should return available persona packs including default and code-reviewer', () => {
    const personas = handler.personaList()

    assert.ok(personas.length >= 2, `expected at least 2 personas, got ${personas.length}`)

    const names = personas.map(p => p.name)
    assert.ok(names.includes('Default Worker'), 'should include Default Worker')
    assert.ok(names.includes('Code Reviewer'), 'should include Code Reviewer')

    // code-reviewer 有正确的 tags
    const cr = personas.find(p => p.name === 'Code Reviewer')
    assert.ok(cr, 'code-reviewer pack should exist')
    assert.ok(cr!.tags.includes('code-review'), 'code-reviewer should have code-review tag')
  })
})

// ---- 5. dispatchWorker 显式指定 persona ----

describe('dispatchWorker with explicit persona', () => {
  it('should resolve persona systemPrompt when explicit persona is given', async () => {
    // 直接测试 Router 的 persona 解析逻辑（与 Router.dispatchWorker 一致）
    const personaName = 'code-reviewer'
    const pack = core.personaRegistry.get(personaName)
    assert.ok(pack, `persona pack "${personaName}" should exist`)
    assert.ok(pack!.persona.soulPrompt.length > 0, 'soulPrompt should not be empty')
    assert.ok(pack!.persona.soulPrompt.includes('代码审查'), 'soulPrompt should contain code review content')

    // 模拟 Router.dispatchWorker 的 persona 解析
    let systemPrompt: string | undefined
    if (!systemPrompt) {
      const resolved = personaName
        ? core.personaRegistry.get(personaName)
        : core.personaRegistry.match('some description')
      if (resolved) {
        systemPrompt = resolved.persona.soulPrompt
      }
    }

    assert.ok(systemPrompt, 'systemPrompt should be resolved from persona')
    assert.ok(systemPrompt!.includes('代码审查'), 'systemPrompt should contain code-reviewer soul content')
  })
})

// ---- 6. createForkFor 显式指定 persona ----

describe('createForkFor with explicit persona', () => {
  it('should resolve persona soulPrompt for fork when explicit persona is given', () => {
    // 模拟 Router.createForkFor 的 persona 解析逻辑
    const description = '审查这个 PR'
    const personaName = 'code-reviewer'

    let forkSystemPrompt: string | undefined
    if (!forkSystemPrompt && (personaName || description)) {
      const pack = personaName
        ? core.personaRegistry.get(personaName)
        : core.personaRegistry.match(description)
      if (pack) {
        forkSystemPrompt = pack.persona.soulPrompt
      }
    }

    assert.ok(forkSystemPrompt, 'fork systemPrompt should be resolved')
    assert.ok(forkSystemPrompt!.includes('代码审查'), 'fork systemPrompt should come from code-reviewer persona')
  })

  it('should auto-match persona when no explicit name is given', () => {
    const description = 'review this code for quality issues'
    const personaName: string | undefined = undefined

    let forkSystemPrompt: string | undefined
    if (!forkSystemPrompt && (personaName || description)) {
      const pack = personaName
        ? core.personaRegistry.get(personaName)
        : core.personaRegistry.match(description)
      if (pack) {
        forkSystemPrompt = pack.persona.soulPrompt
      }
    }

    // "review" and "code quality" are triggers for code-reviewer
    assert.ok(forkSystemPrompt, 'should auto-match a persona from description triggers')
    assert.ok(forkSystemPrompt!.includes('代码审查'), 'should match code-reviewer for review-related descriptions')
  })
})

// ---- 7. feishu_send_message topic routing ----

describe('feishu_send_message topic routing', () => {
  it('should use replyInThread for topic sessions with anchorMessageId', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'symbiont-test-topic-routing-'))
    const sessionMap = new SessionMap(dataDir)

    // Register a topic session with anchorMessageId
    sessionMap.set({
      sessionKey: 'topic:thread-abc',
      chatId: 'oc_chat123',
      chatType: 'group',
      threadId: 'thread-abc',
      anchorMessageId: 'om_anchor_msg_001',
      lastActive: new Date().toISOString(),
    })

    // Register a normal p2p session (no anchorMessageId)
    sessionMap.set({
      sessionKey: 'p2p:user123',
      chatId: 'oc_chat456',
      chatType: 'p2p',
      lastActive: new Date().toISOString(),
    })

    // Test topic session resolution
    const topicSk = 'topic:thread-abc'
    const topicMapping = sessionMap.get(topicSk)
    assert.ok(topicMapping, 'topic mapping should exist')
    assert.ok(topicMapping!.anchorMessageId, 'topic mapping should have anchorMessageId')
    assert.ok(topicSk.startsWith('topic:'), 'session key should start with topic:')

    // Verify: topic session should route to replyInThread (anchorMessageId + topic: prefix)
    const shouldReplyInThread = !!(topicMapping?.anchorMessageId && topicSk.startsWith('topic:'))
    assert.equal(shouldReplyInThread, true, 'topic session should be detected for replyInThread')

    // Test normal session resolution
    const normalSk = 'p2p:user123'
    const normalMapping = sessionMap.get(normalSk)
    assert.ok(normalMapping, 'normal mapping should exist')
    const shouldReplyInThreadNormal = !!(normalMapping?.anchorMessageId && normalSk.startsWith('topic:'))
    assert.equal(shouldReplyInThreadNormal, false, 'normal session should NOT use replyInThread')

    // Verify chatId fallback for normal sessions
    const chatId = normalMapping?.chatId ?? normalSk
    assert.equal(chatId, 'oc_chat456', 'normal session should resolve to chatId')
  })

  it('should fall back to chatId when session_key is not in sessionMap', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'symbiont-test-topic-fallback-'))
    const sessionMap = new SessionMap(dataDir)

    const unknownSk = 'oc_direct_chat_789'
    const mapping = sessionMap.get(unknownSk)
    assert.equal(mapping, undefined, 'unknown session key should not have mapping')

    // Fallback: use session_key directly as chatId
    const chatId = mapping?.chatId ?? unknownSk
    assert.equal(chatId, 'oc_direct_chat_789', 'should use session_key as chatId fallback')
  })
})
