/**
 * Smoke Test — 验证 Symbiont Core 改完代码后系统可运行。
 *
 * 不依赖真实 CC 进程，只验证纯数据组件的集成。
 *
 * 运行: node --experimental-strip-types --test tests/smoke.test.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SymbiontCore } from '../src/core/symbiont-core.ts'
import { SessionManager } from '../src/core/session.ts'
import { EventStore } from '../src/core/event-store.ts'
import { MemoryDB } from '../src/memory/db.ts'

// ---- 测试隔离目录 ----
const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DIR = mkdtempSync(join(tmpdir(), 'symbiont-smoke-'))
const DATA_DIR = join(TEST_DIR, 'data')

// ============================================================
// 1. SymbiontCore 能启动
// ============================================================
describe('Smoke: SymbiontCore 启动', () => {
  let core: SymbiontCore

  it('用测试配置初始化 SymbiontCore 不报错', () => {
    core = new SymbiontCore({
      dataDir: join(DATA_DIR, 'core1'),
      personaPackDir: join(__dirname, '..', 'persona-example'),
      userDir: join(__dirname, '..', 'user'),
    })
    assert.ok(core)
    assert.ok(core.eventStore)
    assert.ok(core.sessionManager)
    assert.ok(core.memoryBridge)
    assert.ok(core.cognitionEngine)
    assert.ok(core.persona)
    assert.ok(core.user)
    assert.ok(core.broker)
  })

  it('persona 已正确加载', () => {
    assert.ok(core.persona.manifest)
    assert.equal(core.persona.manifest!.name, 'echo')
  })

  it('getSystemStatus 返回有效快照', () => {
    const status = core.getSystemStatus()
    assert.ok(status.uptime >= 0)
    assert.ok(typeof status.memoryMB === 'number')
    assert.equal(status.persona, 'echo')
  })

  after(async () => {
    await core.shutdown()
  })
})

// ============================================================
// 2. SessionManager 持久化正常
// ============================================================
describe('Smoke: SessionManager 持久化', () => {
  const sessDir = join(DATA_DIR, 'sessions-persist')

  it('创建 session → 重新加载后能恢复', () => {
    // 创建并写入
    const mgr1 = new SessionManager(sessDir)
    const session = mgr1.create('echo', 'test-key')
    mgr1.updateCCSessionId(session.sessionId, 'cc-123')

    // 重新加载
    const mgr2 = new SessionManager(sessDir)
    const reloaded = mgr2.get(session.sessionId)
    assert.ok(reloaded, '重新加载后应能找到 session')
    assert.equal(reloaded!.ccSessionId, 'cc-123')
    assert.equal(reloaded!.personaPack, 'echo')
    assert.equal(reloaded!.state, 'active')
  })

  it('sleep 后重新加载仍为 sleeping', () => {
    const mgr1 = new SessionManager(sessDir)
    const session = mgr1.create('echo', 'sleep-key')
    mgr1.updateCCSessionId(session.sessionId, 'cc-sleep')
    mgr1.sleep(session.sessionId)

    const mgr2 = new SessionManager(sessDir)
    const reloaded = mgr2.get(session.sessionId)
    assert.ok(reloaded)
    assert.equal(reloaded!.state, 'sleeping')
  })
})

// ============================================================
// 3. Router.stop() 能正常 sleep 所有 sessions
// ============================================================
describe('Smoke: Router.stop() 优雅关闭', () => {
  it('stop 后所有 session 变为 sleeping', async () => {
    const dataDir = join(DATA_DIR, 'router-stop')
    const core = new SymbiontCore({
      dataDir,
      personaPackDir: join(__dirname, '..', 'persona-example'),
      userDir: join(__dirname, '..', 'user'),
    })

    // 手动创建几个 session 来模拟 Router 的行为
    const s1 = core.sessionManager.create('echo', 'key-1')
    core.sessionManager.updateCCSessionId(s1.sessionId, 'cc-1')
    const s2 = core.sessionManager.create('echo', 'key-2')
    core.sessionManager.updateCCSessionId(s2.sessionId, 'cc-2')

    // 验证初始状态
    assert.equal(core.sessionManager.get(s1.sessionId)!.state, 'active')
    assert.equal(core.sessionManager.get(s2.sessionId)!.state, 'active')

    // 模拟 Router.stop() 的 sleep 逻辑
    core.sessionManager.sleep(s1.sessionId, 'key-1')
    core.sessionManager.sleep(s2.sessionId, 'key-2')

    assert.equal(core.sessionManager.get(s1.sessionId)!.state, 'sleeping')
    assert.equal(core.sessionManager.get(s2.sessionId)!.state, 'sleeping')

    await core.shutdown()
  })
})

// ============================================================
// 4. 重启后 session 恢复
// ============================================================
describe('Smoke: 重启后 session 恢复', () => {
  const dataDir = join(DATA_DIR, 'restart-recover')

  it('stop → 重建 SessionManager → 找到 sleeping sessions', async () => {
    // Phase 1: 创建并 sleep
    const core1 = new SymbiontCore({
      dataDir,
      personaPackDir: join(__dirname, '..', 'persona-example'),
      userDir: join(__dirname, '..', 'user'),
    })

    const s1 = core1.sessionManager.create('echo', 'feishu')
    core1.sessionManager.updateCCSessionId(s1.sessionId, 'cc-feishu-1')
    const s2 = core1.sessionManager.create('echo', 'terminal')
    core1.sessionManager.updateCCSessionId(s2.sessionId, 'cc-terminal-1')

    // 模拟 stop
    core1.sessionManager.sleep(s1.sessionId, 'feishu')
    core1.sessionManager.sleep(s2.sessionId, 'terminal')
    await core1.shutdown()

    // Phase 2: 重启 — 新建 SymbiontCore，验证 session 恢复
    const core2 = new SymbiontCore({
      dataDir,
      personaPackDir: join(__dirname, '..', 'persona-example'),
      userDir: join(__dirname, '..', 'user'),
    })

    // 应该能通过 sessionKey 找到之前的 sleeping session
    const recovered1 = core2.sessionManager.getLatestBySessionKey('feishu')
    assert.ok(recovered1, '应能找到 feishu session')
    assert.equal(recovered1!.state, 'sleeping')
    assert.equal(recovered1!.ccSessionId, 'cc-feishu-1')

    const recovered2 = core2.sessionManager.getLatestBySessionKey('terminal')
    assert.ok(recovered2, '应能找到 terminal session')
    assert.equal(recovered2!.state, 'sleeping')
    assert.equal(recovered2!.ccSessionId, 'cc-terminal-1')

    // wake 后状态正确
    core2.sessionManager.wake(recovered1!.sessionId)
    assert.equal(core2.sessionManager.get(recovered1!.sessionId)!.state, 'active')

    await core2.shutdown()
  })
})

// ============================================================
// 5. EventStore 能读写
// ============================================================
describe('Smoke: EventStore 读写', () => {
  let store: EventStore

  before(() => {
    const db = new MemoryDB(join(DATA_DIR, 'events-smoke-sqlite'))
    store = new EventStore(db)
  })

  it('追加事件并查询', () => {
    const evt = store.append({
      type: 'chat',
      sessionId: 'smoke-session',
      data: { role: 'user', content: 'smoke test message' },
    })
    assert.ok(evt.id.startsWith('evt-'))
    assert.ok(evt.timestamp)

    const events = store.read('smoke-session')
    assert.equal(events.length, 1)
    assert.equal(events[0].data.content, 'smoke test message')
  })

  it('追加多条后 getLatestSummary 正确', () => {
    store.append({ type: 'chat', sessionId: 'smoke-session', data: { role: 'assistant', content: 'reply 1' } })
    store.append({ type: 'chat', sessionId: 'smoke-session', data: { role: 'user', content: 'msg 2' } })
    store.append({ type: 'chat', sessionId: 'smoke-session', data: { role: 'assistant', content: 'reply 2' } })

    const latest = store.getLatestSummary('smoke-session', 2)
    assert.equal(latest.length, 2)
  })

  it('空 session 返回空数组', () => {
    assert.equal(store.read('nonexistent').length, 0)
  })

  it('fork/merge 事件链正常', () => {
    store.appendFork('smoke-parent', 'smoke-child', 'smoke task')
    store.append({ type: 'chat', sessionId: 'smoke-child', data: { role: 'assistant', content: 'done' } })
    store.appendMerge('smoke-parent', 'smoke-child', 'task completed')

    const parentEvents = store.read('smoke-parent')
    assert.ok(parentEvents.find(e => e.type === 'fork'))
    assert.ok(parentEvents.find(e => e.type === 'merge'))

    const childEvents = store.getChildEvents('smoke-parent', 'smoke-child')
    assert.ok(childEvents.length > 0)
  })
})

// ============================================================
// Cleanup
// ============================================================
after(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true })
  }
})
