// tests/tasks-wishes.test.ts — 任务板 + 许愿池 DB 层测试
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'

describe('Tasks', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-tasks-test-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('addTask creates task with defaults', () => {
    const task = db.addTask({ title: '修复飞书引用消息' })
    assert.ok((task.id as string).startsWith('task-'))
    assert.equal(task.title, '修复飞书引用消息')
    assert.equal(task.status, 'todo')
    assert.equal(task.assignee, 'default')
    assert.equal(task.priority, 'normal')
    assert.equal(task.completed_at, undefined)
  })

  test('addTask with all fields', () => {
    const task = db.addTask({
      title: '交报告',
      description: '季度报告',
      assignee: 'user',
      priority: 'high',
      due_date: '2026-03-25',
      created_by: 'default',
    })
    assert.equal(task.assignee, 'user')
    assert.equal(task.priority, 'high')
    assert.equal(task.due_date, '2026-03-25')
    assert.equal(task.created_by, 'default')
  })

  test('updateTask changes status', () => {
    const task = db.addTask({ title: '测试任务' })
    const updated = db.updateTask(task.id as string, { status: 'doing' })
    assert.equal(updated?.status, 'doing')
    assert.equal(updated?.completed_at, null)
  })

  test('updateTask to done fills completed_at', () => {
    const task = db.addTask({ title: '即将完成' })
    const updated = db.updateTask(task.id as string, { status: 'done' })
    assert.equal(updated?.status, 'done')
    assert.ok(updated?.completed_at, 'completed_at should be set')
  })

  test('updateTask from done to todo clears completed_at', () => {
    const task = db.addTask({ title: '返工' })
    db.updateTask(task.id as string, { status: 'done' })
    const updated = db.updateTask(task.id as string, { status: 'todo' })
    assert.equal(updated?.status, 'todo')
    assert.equal(updated?.completed_at, null)
  })

  test('updateTask returns undefined for nonexistent id', () => {
    const result = db.updateTask('task-nonexistent', { status: 'done' })
    assert.equal(result, undefined)
  })

  test('updateTask changes title and priority', () => {
    const task = db.addTask({ title: '旧标题', priority: 'low' })
    const updated = db.updateTask(task.id as string, { title: '新标题', priority: 'urgent' })
    assert.equal(updated?.title, '新标题')
    assert.equal(updated?.priority, 'urgent')
  })

  test('listTasks returns all', () => {
    const all = db.listTasks()
    assert.ok(all.length >= 4)
  })

  test('listTasks filters by status', () => {
    const todos = db.listTasks({ status: 'todo' })
    assert.ok(todos.every(t => t.status === 'todo'))
  })

  test('listTasks filters by assignee', () => {
    const filtered = db.listTasks({ assignee: 'user' })
    assert.ok(filtered.every(t => t.assignee === 'user'))
    assert.ok(filtered.length >= 1)
  })

  test('listTasks orders by priority', () => {
    // Clear and insert known tasks
    db.addTask({ title: 'low task', priority: 'low' })
    db.addTask({ title: 'urgent task', priority: 'urgent' })
    const all = db.listTasks()
    const urgentIdx = all.findIndex(t => t.title === 'urgent task')
    const lowIdx = all.findIndex(t => t.title === 'low task')
    assert.ok(urgentIdx < lowIdx, 'urgent should come before low')
  })

  test('deleteTask removes task', () => {
    const task = db.addTask({ title: '待删除' })
    const deleted = db.deleteTask(task.id as string)
    assert.equal(deleted, true)
    const result = db.updateTask(task.id as string, { status: 'done' })
    assert.equal(result, undefined)
  })

  test('deleteTask returns false for nonexistent', () => {
    assert.equal(db.deleteTask('task-nope'), false)
  })
})

describe('Wishes', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-wishes-test-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('addWish creates wish with defaults', () => {
    const wish = db.addWish('学会画画')
    assert.ok(wish.id.startsWith('wish-'))
    assert.equal(wish.title, '学会画画')
    assert.equal(wish.status, 'pending')
    assert.equal(wish.priority, 'normal')
  })

  test('addWish with reason and priority', () => {
    const wish = db.addWish('接入日程 API', '想帮user管理日程', 'high')
    assert.equal(wish.reason, '想帮user管理日程')
    assert.equal(wish.priority, 'high')
  })

  test('getWishes returns all', () => {
    const all = db.getWishes()
    assert.ok(all.length >= 2)
  })

  test('getWishes filters by status', () => {
    const pending = db.getWishes('pending')
    assert.ok(pending.every(w => w.status === 'pending'))
    assert.ok(pending.length >= 2)
  })

  test('updateWish changes status', () => {
    const wish = db.addWish('想要新功能')
    const updated = db.updateWish(wish.id, { status: 'accepted' })
    assert.equal(updated?.status, 'accepted')
  })

  test('updateWish adds comment', () => {
    const wish = db.addWish('想要飞书日历')
    const updated = db.updateWish(wish.id, { comment: '好主意，下周做', status: 'accepted' })
    assert.equal(updated?.comment, '好主意，下周做')
    assert.equal(updated?.status, 'accepted')
  })

  test('updateWish returns undefined for nonexistent', () => {
    assert.equal(db.updateWish('wish-nope', { status: 'done' }), undefined)
  })

  test('updateWish to done', () => {
    const wish = db.addWish('实现任务板')
    db.updateWish(wish.id, { status: 'accepted' })
    const done = db.updateWish(wish.id, { status: 'done' })
    assert.equal(done?.status, 'done')
  })

  test('updateWish to rejected with comment', () => {
    const wish = db.addWish('想要 root 权限')
    const rejected = db.updateWish(wish.id, { status: 'rejected', comment: '太危险了' })
    assert.equal(rejected?.status, 'rejected')
    assert.equal(rejected?.comment, '太危险了')
  })
})
