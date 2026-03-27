// tests/active-tasks.test.ts — active_tasks 持久化与恢复
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'

describe('active_tasks CRUD', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbiont-active-tasks-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('addActiveTask and getActiveTasks', () => {
    db.addActiveTask('w1', 'worker', '部署新版本', 'xiaoxi', 'session-123')
    db.addActiveTask('f1', 'fork', '调试问题', undefined, 'session-456')

    const all = db.getActiveTasks()
    assert.equal(all.length, 2)

    const running = db.getActiveTasks('running')
    assert.equal(running.length, 2)
    assert.equal(running[0].id, 'w1')
    assert.equal(running[0].type, 'worker')
    assert.equal(running[0].description, '部署新版本')
    assert.equal(running[0].persona, 'xiaoxi')
    assert.equal(running[0].parent_session_key, 'session-123')
    assert.equal(running[1].id, 'f1')
    assert.equal(running[1].persona, undefined)
  })

  test('removeActiveTask', () => {
    db.removeActiveTask('w1')
    const remaining = db.getActiveTasks()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].id, 'f1')
  })

  test('markTaskInterrupted', () => {
    db.addActiveTask('w2', 'worker', '另一个任务')
    db.markTaskInterrupted('w2')

    // f1 is still running, w2 is interrupted
    const running = db.getActiveTasks('running')
    assert.equal(running.length, 1)
    assert.equal(running[0].id, 'f1')

    const interrupted = db.getActiveTasks('interrupted')
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0].id, 'w2')
    assert.equal(interrupted[0].status, 'interrupted')
  })

  test('addActiveTask with metadata', () => {
    db.addActiveTask('w3', 'worker', '带元数据的任务', undefined, undefined, { retryCount: 1 })
    const tasks = db.getActiveTasks()
    const w3 = tasks.find(t => t.id === 'w3')
    assert.ok(w3)
    assert.equal(JSON.parse(w3.metadata!).retryCount, 1)
  })

  test('addActiveTask replaces existing (INSERT OR REPLACE)', () => {
    db.addActiveTask('w3', 'worker', '更新后的描述')
    const tasks = db.getActiveTasks()
    const w3 = tasks.find(t => t.id === 'w3')
    assert.ok(w3)
    assert.equal(w3.description, '更新后的描述')
  })

  test('getActiveTasks without filter returns all', () => {
    const all = db.getActiveTasks()
    assert.ok(all.length >= 2) // f1(running), w2(interrupted), w3(running)
  })
})

describe('restart recovery simulation', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbiont-recovery-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('simulate restart: mark running as interrupted, then process', () => {
    // 模拟重启前有 2 个 worker + 1 个 fork 在运行
    db.addActiveTask('w-pre-1', 'worker', 'worker任务1', 'xiaoxi', 'dm-1')
    db.addActiveTask('w-pre-2', 'worker', 'worker任务2', undefined, 'dm-2')
    db.addActiveTask('f-pre-1', 'fork', 'fork任务1', undefined, 'dm-3')

    // 模拟重启后的恢复逻辑
    // Step 1: 标记所有 running → interrupted
    const runningTasks = db.getActiveTasks('running')
    assert.equal(runningTasks.length, 3)
    for (const task of runningTasks) {
      db.markTaskInterrupted(task.id)
    }

    // Step 2: 验证没有 running 的了
    assert.equal(db.getActiveTasks('running').length, 0)

    // Step 3: 处理 interrupted
    const interrupted = db.getActiveTasks('interrupted')
    assert.equal(interrupted.length, 3)

    for (const task of interrupted) {
      if (task.type === 'worker') {
        // 模拟重新 dispatch 后移除
        db.removeActiveTask(task.id)
      } else if (task.type === 'fork') {
        // fork 直接移除
        db.removeActiveTask(task.id)
      }
    }

    // Step 4: 确认全部清理完成
    assert.equal(db.getActiveTasks().length, 0)
  })

  test('persistence across db reopen', () => {
    // 写入一些任务
    db.addActiveTask('persist-1', 'worker', '持久化测试')
    db.close()

    // 重新打开
    db = new MemoryDB(dir)
    const tasks = db.getActiveTasks()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, 'persist-1')
    assert.equal(tasks[0].description, '持久化测试')
  })
})
