/**
 * Symbiont 全量 E2E 自动化测试
 *
 * 覆盖：EventStore, SessionManager, CardStore, PersonaLoader,
 *       CCProcess, WorkerManager, CognitionEngine, Router
 *
 * 运行: node --experimental-strip-types tests/e2e.test.ts
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EventStore } from '../src/core/event-store.ts'
import { SessionManager } from '../src/core/session.ts'
import { CardStore } from '../src/memory/card-store.ts'
import { loadPersona } from '../src/persona/loader.ts'
import { CCProcess } from '../src/core/cc-process.ts'
import { SymbiontCore } from '../src/core/symbiont-core.ts'
import { Router } from '../src/core/router.ts'
import { WorkerManager } from '../src/core/worker-manager.ts'
import { CognitionEngine } from '../src/memory/cognition.ts'
import { MemoryBridge } from '../src/memory/memory-bridge.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DATA = join(__dirname, '..', 'data', '_test_' + Date.now())

// ============================================================
// 1. EventStore
// ============================================================
describe('EventStore', () => {
  const dir = join(TEST_DATA, 'events')
  let store: EventStore

  before(() => { store = new EventStore(dir) })

  test('append and read events', () => {
    const evt = store.append({
      type: 'chat', sessionId: 'test-session-1',
      data: { role: 'user', content: 'hello' },
    })
    assert.ok(evt.id.startsWith('evt-'))
    assert.ok(evt.timestamp)
    const events = store.read('test-session-1')
    assert.equal(events.length, 1)
    assert.equal(events[0].data.content, 'hello')
  })

  test('append multiple events', () => {
    store.append({ type: 'chat', sessionId: 'test-session-1', data: { role: 'assistant', content: 'hi' } })
    store.append({ type: 'memory', sessionId: 'test-session-1', data: { cardId: 'card-1' } })
    assert.equal(store.read('test-session-1').length, 3)
  })

  test('getLatestSummary returns last N', () => {
    const latest = store.getLatestSummary('test-session-1', 2)
    assert.equal(latest.length, 2)
  })

  test('read non-existent session returns empty', () => {
    assert.equal(store.read('non-existent').length, 0)
  })

  test('JSONL file exists on disk', () => {
    assert.ok(existsSync(join(dir, 'test-session-1.jsonl')))
  })

  // fork/merge 事件溯源
  test('fork and merge events create traceable index', () => {
    store.appendFork('main-1', 'worker-1', 'refactor plugin')
    store.append({ type: 'chat', sessionId: 'worker-1', data: { role: 'assistant', content: 'done refactoring' } })
    store.appendMerge('main-1', 'worker-1', 'plugin refactored successfully')

    const mainEvents = store.read('main-1')
    const forkEvent = mainEvents.find(e => e.type === 'fork')
    assert.ok(forkEvent)
    assert.equal(forkEvent!.data.childSessionId, 'worker-1')

    const mergeEvent = mainEvents.find(e => e.type === 'merge')
    assert.ok(mergeEvent)
    assert.equal(mergeEvent!.data.summary, 'plugin refactored successfully')

    // 通过索引拉取子事件流原文
    const childEvents = store.read('worker-1')
    assert.ok(childEvents.length > 0)
  })

  test('getForks returns fork events', () => {
    const forks = store.getForks('main-1')
    assert.ok(forks.length >= 1)
    assert.equal(forks[0].type, 'fork')
  })

  test('getChildEvents retrieves child event stream via fork index', () => {
    const store3 = new EventStore(join(TEST_DATA, 'events3'))
    store3.appendFork('parent-1', 'child-1', 'task A')
    store3.append({ type: 'chat', sessionId: 'child-1', data: { role: 'assistant', content: 'done' } })
    store3.appendMerge('parent-1', 'child-1', 'task A completed')

    const childEvents = store3.getChildEvents('parent-1', 'child-1')
    assert.ok(childEvents.length > 0)
    assert.equal(childEvents[0].data.content, 'done')

    // 不存在的 fork 返回空
    assert.equal(store3.getChildEvents('parent-1', 'no-such-child').length, 0)
  })

  test('resolveSource parses event URI', () => {
    const store4 = new EventStore(join(TEST_DATA, 'events4'))
    for (let i = 0; i < 5; i++) {
      store4.append({ type: 'chat', sessionId: 'src-test', data: { idx: i } })
    }
    const resolved = store4.resolveSource('event://src-test/#1-#3')
    assert.equal(resolved.length, 3)
    assert.equal(resolved[0].data.idx, 1)
    assert.equal(resolved[2].data.idx, 3)

    // 无效 URI 返回空
    assert.equal(store4.resolveSource('invalid').length, 0)
  })

  test('getTimeline shows concise view', () => {
    const store2 = new EventStore(join(TEST_DATA, 'events2'))
    store2.append({ type: 'chat', sessionId: 's1', data: { role: 'user', content: '这是一段很长的消息'.repeat(10) } })
    store2.appendFork('s1', 'w1', 'do something')
    store2.appendMerge('s1', 'w1', 'done')

    const timeline = store2.getTimeline('s1')
    assert.equal(timeline.length, 3)
    assert.ok(timeline[0].summary.length <= 60)
    assert.equal(timeline[1].type, 'fork')
    assert.equal(timeline[1].childSessionId, 'w1')
  })
})

// ============================================================
// 2. SessionManager
// ============================================================
describe('SessionManager', () => {
  const dir = join(TEST_DATA, 'sessions')
  let manager: SessionManager

  before(() => { manager = new SessionManager(dir) })

  test('create session', () => {
    const session = manager.create('xiaoxi')
    assert.ok(session.sessionId.startsWith('symbiont-'))
    assert.equal(session.personaPack, 'xiaoxi')
    assert.equal(session.state, 'active')
    assert.equal(session.ccSessionId, null)
  })

  test('get session', () => {
    const created = manager.create('xiaoxi')
    const retrieved = manager.get(created.sessionId)
    assert.ok(retrieved)
    assert.equal(retrieved!.sessionId, created.sessionId)
  })

  test('update CC session ID', () => {
    const session = manager.create('xiaoxi')
    manager.updateCCSessionId(session.sessionId, 'cc-uuid-123')
    assert.equal(manager.get(session.sessionId)!.ccSessionId, 'cc-uuid-123')
  })

  test('sleep and wake', () => {
    const session = manager.create('xiaoxi')
    manager.sleep(session.sessionId)
    assert.equal(manager.get(session.sessionId)!.state, 'sleeping')
    manager.wake(session.sessionId)
    assert.equal(manager.get(session.sessionId)!.state, 'active')
  })

  test('getActive returns an active session', () => {
    manager.create('xiaoxi')
    const active = manager.getActive()
    assert.ok(active)
    assert.equal(active!.state, 'active')
  })

  test('persistence - reload from disk', () => {
    const session = manager.create('xiaoxi')
    manager.updateCCSessionId(session.sessionId, 'persist-test')
    const manager2 = new SessionManager(dir)
    const reloaded = manager2.get(session.sessionId)
    assert.ok(reloaded)
    assert.equal(reloaded!.ccSessionId, 'persist-test')
  })
})

// ============================================================
// 3. CardStore
// ============================================================
describe('CardStore', () => {
  const dir = join(TEST_DATA, 'memory')
  let store: CardStore

  before(() => { store = new CardStore(dir) })

  test('add card', () => {
    const card = store.add({
      content: '飞书容器不能设全局 HTTP_PROXY',
      scene: 'Docker 部署飞书 Bot',
      tags: ['feishu', 'docker', 'proxy'],
      confidence: 0.7,
      source: ['event://test/1'],
      connections: [],
    })
    assert.ok(card.id.startsWith('card-'))
    assert.equal(card.confidence, 0.7)
  })

  test('search by tag', () => {
    store.add({
      content: 'Mihomo 代理需要 UFW 放行',
      scene: '服务器配置',
      tags: ['proxy', 'ufw'],
      confidence: 0.6,
      source: [], connections: [],
    })
    assert.equal(store.search({ tags: ['feishu'] }).length, 1)
    assert.equal(store.search({ tags: ['proxy'] }).length, 2)
  })

  test('search by keyword (case insensitive)', () => {
    assert.equal(store.search({ keyword: 'ufw' }).length, 1)
  })

  test('touch increases confidence', () => {
    const card = store.all()[0]
    const oldConf = card.confidence
    store.touch(card.id)
    assert.ok(store.get(card.id)!.confidence > oldConf)
  })

  test('persistence - reload from disk', () => {
    assert.equal(new CardStore(dir).all().length, 2)
  })

  // 置信度衰减
  test('decay reduces confidence over time', () => {
    const card = store.add({
      content: 'old knowledge', scene: 'test', tags: ['decay-test'],
      confidence: 0.3, source: [], connections: [],
    })
    // 手动设置 lastUsed 为 30 天前
    const target = store.all().find(c => c.id === card.id)!
    target.lastUsed = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    store['save']()

    const result = store.decay()
    assert.ok(result.decayed > 0)
    assert.ok(store.get(card.id)!.confidence < 0.3)
  })

  test('decay archives very low confidence cards', () => {
    const card = store.add({
      content: 'will be archived', scene: 'test', tags: ['archive-test'],
      confidence: 0.08, source: [], connections: [],
    })
    const target = store.all().find(c => c.id === card.id)!
    target.lastUsed = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()
    store['save']()

    const result = store.decay()
    assert.ok(result.archived.includes(card.id))
    assert.equal(store.get(card.id)!.archived, true)
  })

  test('search excludes archived cards', () => {
    const active = store.search({ tags: ['archive-test'] })
    assert.equal(active.length, 0)  // archived 的不应出现
  })
})

// ============================================================
// 4. Persona Loader
// ============================================================
describe('Persona Loader', () => {
  const packDir = join(__dirname, '..', 'persona-xiaoxi')

  test('soul + voice merged into soulPrompt', () => {
    const persona = loadPersona(packDir)
    assert.ok(persona.soulPrompt.includes('小希'))
    assert.ok(persona.soulPrompt.includes('使命'))
    assert.ok(persona.soulPrompt.includes('表达规范'))
  })

  test('persona is identity only — no skills or hands', () => {
    const persona = loadPersona(packDir)
    // persona = 身份，不是能力。skills/hands 由 CC 原生管理。
    assert.ok(!('skillDirs' in persona))
    assert.ok(!('hands' in persona))
  })

  test('manifest is loaded with permissions', () => {
    const persona = loadPersona(packDir)
    assert.ok(persona.manifest)
    assert.equal(persona.manifest!.name, 'xiaoxi')
    assert.ok(persona.manifest!.permissions.writable.length > 0)
    assert.ok(persona.manifest!.permissions.protected.length > 0)
  })

  test('memoryDir points to persona memory/', () => {
    const persona = loadPersona(packDir)
    assert.ok(persona.memoryDir.endsWith('persona-xiaoxi/memory'))
  })
})

// ============================================================
// 5. CognitionEngine（纯逻辑，不调 CC）
// ============================================================
describe('CognitionEngine', () => {
  const dir = join(TEST_DATA, 'cognition')
  let cardStore: CardStore
  let engine: CognitionEngine

  before(() => {
    cardStore = new CardStore(join(dir, 'memory'))
    // 添加 5 张同标签的卡片
    for (let i = 0; i < 5; i++) {
      cardStore.add({
        content: `docker experience ${i}`,
        scene: 'server', tags: ['docker'],
        confidence: 0.5, source: [], connections: [],
      })
    }
    // 添加 2 张另一个标签
    for (let i = 0; i < 2; i++) {
      cardStore.add({
        content: `git tip ${i}`,
        scene: 'dev', tags: ['git'],
        confidence: 0.6, source: [], connections: [],
      })
    }
    engine = new CognitionEngine(cardStore, dir)
  })

  test('scan finds tags with >= threshold cards', () => {
    const tags = engine.scan(5)
    assert.ok(tags.includes('docker'))
    assert.ok(!tags.includes('git'))  // only 2 cards
  })

  test('scan with lower threshold', () => {
    const tags = engine.scan(2)
    assert.ok(tags.includes('docker'))
    assert.ok(tags.includes('git'))
  })

  test('manual candidate approve/reject', () => {
    engine.addCandidate({
      tag: 'docker',
      sourceCards: ['c1', 'c2'],
      proposedContent: 'Docker best practices',
    })
    const pending = engine.getPending()
    assert.equal(pending.length, 1)

    engine.approve(pending[0].id)
    assert.equal(engine.getPending().length, 0)
    assert.equal(engine.getApproved().length, 1)
  })
})

// ============================================================
// 5b. MemoryBridge（共享 + 私有）
// ============================================================
describe('MemoryBridge', () => {
  const sharedDir = join(TEST_DATA, 'shared-mem')
  const personalDir = join(TEST_DATA, 'personal-mem')
  let bridge: MemoryBridge

  before(() => { bridge = new MemoryBridge(sharedDir, personalDir) })

  test('add to personal by default', () => {
    bridge.add({ content: 'personal exp', scene: 's', tags: ['t'], confidence: 0.5, source: [], connections: [] })
    assert.equal(bridge.getPersonalStore().all().length, 1)
    assert.equal(bridge.getSharedStore().all().length, 0)
  })

  test('add to shared explicitly', () => {
    bridge.add({ content: 'shared exp', scene: 's', tags: ['t'], confidence: 0.5, source: [], connections: [] }, 'shared')
    assert.equal(bridge.getSharedStore().all().length, 1)
  })

  test('search merges both sources', () => {
    const results = bridge.search({ tags: ['t'] })
    assert.equal(results.length, 2)
  })

  test('all merges both sources', () => {
    assert.equal(bridge.all().length, 2)
  })
})

// ============================================================
// 6. CCProcess — 真实 CC 调用
// ============================================================
describe('CCProcess - real CC', () => {
  test('single query returns response', async () => {
    const cc = new CCProcess({
      systemPrompt: 'You are a test bot. Reply with exactly: TEST_OK',
    })
    const { result, sessionId } = await cc.query('say TEST_OK')
    console.log(`  [CC] result: "${result.slice(0, 80)}"`)
    assert.ok(result.length > 0)
    assert.ok(sessionId)
  })

  test('resume preserves context', async () => {
    const cc = new CCProcess({
      systemPrompt: 'You are a test bot. Remember everything. Reply briefly.',
    })
    const r1 = await cc.query('The secret code is PINEAPPLE42. Remember it.')
    console.log(`  [CC Round 1] "${r1.result.slice(0, 80)}"`)
    assert.ok(r1.sessionId)

    cc.setSessionId(r1.sessionId!)
    const r2 = await cc.query('What is the secret code I told you?')
    console.log(`  [CC Round 2] "${r2.result.slice(0, 80)}"`)
    assert.ok(r2.result.toUpperCase().includes('PINEAPPLE42'))
  })
})

// ============================================================
// 7. WorkerManager — 真实 CC 工人派遣
// ============================================================
describe('WorkerManager', () => {
  const dir = join(TEST_DATA, 'worker')

  test('dispatch worker and get result', async () => {
    const { CCBroker } = await import('../src/core/cc-broker.ts')
    const broker = new CCBroker({ maxConcurrent: { main: 1, worker: 3 } })
    const es = new EventStore(join(dir, 'events'))
    const wm = new WorkerManager({
      broker,
      eventStore: es,
      workspaceManager: null as any,
      sessionManager: null as any,
      persona: null as any,
      user: null as any,
    })
    const result = await wm.dispatch({
      id: 'test-w1',
      description: 'Reply with exactly: WORKER_OK',
      systemPrompt: 'You are a worker bot. Do exactly what is asked.',
      parentSessionId: 'parent-1',
    })
    console.log(`  [Worker] result: "${result.result.slice(0, 80)}"`)
    assert.ok(result.success)
    assert.ok(result.result.length > 0)
    assert.ok(result.duration > 0)
    await broker.shutdown()
  })

  test('worker creates fork-merge event chain', async () => {
    const es = new EventStore(join(dir, 'events'))
    const mainEvents = es.read('parent-1')

    const fork = mainEvents.find(e => e.type === 'fork')
    assert.ok(fork, 'should have fork event')

    const merge = mainEvents.find(e => e.type === 'merge')
    assert.ok(merge, 'should have merge event')
    assert.ok((merge!.data.summary as string).length > 0)
  })

  test('respects max concurrent limit', async () => {
    // 直接测试 CCBroker 的并发限制（不走 WorkerManager 的异步 dispatch）
    const { CCBroker } = await import('../src/core/cc-broker.ts')
    const broker = new CCBroker({ maxConcurrent: { main: 0, worker: 1 } })
    // 第一个工人
    const inst = await broker.spawn('worker', {
      systemPrompt: 'Reply briefly.',
      idleTimeoutMs: 0,
    })
    // 第二个应该被拒
    await assert.rejects(
      () => broker.spawn('worker', { systemPrompt: 'Reply briefly.', idleTimeoutMs: 0 }),
      /Max concurrent worker/
    )
    await broker.shutdown()
  })
})

// ============================================================
// 8. Router 集成测试（完整链路）
// ============================================================
describe('Router - integration', () => {
  const dataDir = join(TEST_DATA, 'router')
  const personaDir = join(__dirname, '..', 'persona-xiaoxi')
  let router: Router

  const userDir = join(__dirname, '..', 'user')

  before(async () => {
    const core = new SymbiontCore({ dataDir, personaPackDir: personaDir, userDir })
    router = new Router(core)
    await router.initialize()
  })

  after(async () => {
    await router.stop()
  })

  test('send message and get reply', async () => {
    const reply = await router.sendTo(Router.TERMINAL_KEY, 'say hello in one word')
    console.log(`  [Router] reply: "${reply.slice(0, 80)}"`)
    assert.ok(reply.length > 0)
  })

  test('events are logged', () => {
    const eventsDir = join(dataDir, 'events')
    assert.ok(existsSync(eventsDir))
    const files = readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'))
    assert.ok(files.length > 0)
    const content = readFileSync(join(eventsDir, files[0]), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    assert.ok(lines.length >= 2)
  })

  test('session is persisted with ccSessionId', () => {
    const sessions = JSON.parse(readFileSync(join(dataDir, 'sessions', 'sessions.json'), 'utf-8'))
    assert.ok(sessions.length > 0)
    assert.ok(sessions[0].ccSessionId)
  })

  test('dispatch worker via router', async () => {
    const result = await router.dispatchWorker('Reply with exactly: ROUTED_WORKER_OK')
    console.log(`  [Router Worker] "${result.slice(0, 80)}"`)
    assert.ok(result.length > 0)
    assert.ok(!result.startsWith('[工人失败]'))
  })

  test('memory card lifecycle via router', () => {
    const card = router.addMemoryCard({
      content: 'e2e test card', scene: 'testing',
      tags: ['e2e'], confidence: 0.5, source: [], connections: [],
    }, Router.TERMINAL_KEY)
    assert.ok(card.id.startsWith('card-'))
    assert.equal(card.content, 'e2e test card')
  })

  test('get timeline', () => {
    const timeline = router.getTimeline(Router.TERMINAL_KEY)
    assert.ok(timeline.length >= 2)
  })

  test('memory card auto-links to event stream', () => {
    const card = router.addMemoryCard({
      content: 'test auto-link', scene: 'e2e',
      tags: ['link-test'], confidence: 0.5, source: [], connections: [],
    }, Router.TERMINAL_KEY)
    // source 应被自动填充
    assert.ok(card.source.length > 0)
    assert.ok(card.source[0].startsWith('event://'))

    // 应该能通过 source 回溯到事件
    const events = router.resolveCardSource(card)
    assert.ok(events.length > 0)
  })

  test('memory event is recorded in timeline', () => {
    const timeline = router.getTimeline(Router.TERMINAL_KEY)
    const memoryEvent = timeline.find(e => e.type === 'memory')
    assert.ok(memoryEvent, 'should have memory event in timeline')
  })

  test('persona permission check works', () => {
    // writable: voice/, memory/
    assert.equal(router.checkPersonaWritable('voice/style.md'), true)
    assert.equal(router.checkPersonaWritable('memory/cards.jsonl'), true)
    // protected: soul/, manifest.yaml
    assert.equal(router.checkPersonaWritable('soul/identity.md'), false)
    assert.equal(router.checkPersonaWritable('manifest.yaml'), false)
  })

  test('broker status shows main agent', () => {
    const status = router.getBrokerStatus()
    assert.ok(status.length > 0)
    assert.ok(status.some(s => s.role === 'main'))
  })

  test('fork creates specialist and routes messages', async () => {
    // 创建分叉
    const fork = await router.createForkFor(Router.TERMINAL_KEY, 'Help me understand TypeScript generics')
    assert.ok(fork.id.startsWith('fork-'))
    assert.equal(fork.state, 'active')
    assert.equal(router.getSession(Router.TERMINAL_KEY)?.activeForkId, fork.id)

    // 消息路由到专员
    const reply = await router.sendTo(Router.TERMINAL_KEY, 'What are generics?')
    console.log(`  [Specialist] "${reply.slice(0, 80)}"`)
    assert.ok(reply.length > 0)

    // 完成分叉
    await router.completeForkFor(Router.TERMINAL_KEY, 'Learned about TS generics')
    assert.equal(router.getSession(Router.TERMINAL_KEY)?.activeForkId, null)

    // 合流事件应在主时间线
    const timeline = router.getTimeline(Router.TERMINAL_KEY)
    const mergeEvent = timeline.find(e => e.type === 'merge')
    assert.ok(mergeEvent)
  })
})

// ============================================================
// Cleanup
// ============================================================
after(() => {
  if (existsSync(TEST_DATA)) {
    rmSync(TEST_DATA, { recursive: true })
    console.log(`\n✓ Cleaned up test data: ${TEST_DATA}`)
  }
  // 强制退出防止 WS Server 句柄导致进程挂起
  setTimeout(() => process.exit(0), 1000).unref()
})
