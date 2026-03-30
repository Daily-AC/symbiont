// tests/api-tasks-wishes.test.ts — REST API 层测试（任务板 + 许愿池）
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { handleMemoryAPI } from '../src/api/memory-api.ts'

function startTestServer(db: MemoryDB): Promise<{ server: Server; base: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      if (!handleMemoryAPI(req, res, db)) {
        res.writeHead(404); res.end()
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, base: `http://127.0.0.1:${addr.port}` })
    })
  })
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = res.status === 200 ? await res.json() : await res.text()
  return { status: res.status, data }
}

async function put(base: string, path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = res.status === 200 ? await res.json() : await res.text()
  return { status: res.status, data }
}

async function get(base: string, path: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`)
  const data = res.status === 200 ? await res.json() : await res.text()
  return { status: res.status, data }
}

async function del(base: string, path: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, { method: 'DELETE' })
  const data = res.status === 200 ? await res.json() : await res.text()
  return { status: res.status, data }
}

// ---- Tasks API ----

describe('Tasks API', () => {
  let db: MemoryDB
  let dir: string
  let server: Server
  let base: string

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sia-api-tasks-'))
    db = new MemoryDB(dir)
    const s = await startTestServer(db)
    server = s.server; base = s.base
  })
  after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('POST /api/tasks creates task', async () => {
    const { status, data } = await post(base, '/api/tasks', { title: '修复飞书', assignee: 'default', priority: 'high' })
    assert.equal(status, 200)
    assert.ok(data.id.startsWith('task-'))
    assert.equal(data.title, '修复飞书')
    assert.equal(data.status, 'todo')
    assert.equal(data.priority, 'high')
  })

  test('POST /api/tasks requires title', async () => {
    const { status } = await post(base, '/api/tasks', { description: 'no title' })
    assert.equal(status, 400)
  })

  test('POST /api/tasks rejects invalid JSON', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.equal(res.status, 400)
  })

  test('GET /api/tasks returns all tasks', async () => {
    const { status, data } = await get(base, '/api/tasks')
    assert.equal(status, 200)
    assert.ok(Array.isArray(data))
    assert.ok(data.length >= 1)
  })

  test('GET /api/tasks?status=todo filters', async () => {
    const { data } = await get(base, '/api/tasks?status=todo')
    assert.ok(data.every((t: any) => t.status === 'todo'))
  })

  test('GET /api/tasks?assignee=user filters', async () => {
    await post(base, '/api/tasks', { title: 'user的任务', assignee: 'user' })
    const { data } = await get(base, '/api/tasks?assignee=user')
    assert.ok(data.every((t: any) => t.assignee === 'user'))
    assert.ok(data.length >= 1)
  })

  test('PUT /api/tasks/:id updates task', async () => {
    const { data: task } = await post(base, '/api/tasks', { title: '待更新' })
    const { status, data } = await put(base, `/api/tasks/${task.id}`, { status: 'doing' })
    assert.equal(status, 200)
    assert.equal(data.status, 'doing')
  })

  test('PUT /api/tasks/:id to done fills completed_at', async () => {
    const { data: task } = await post(base, '/api/tasks', { title: '快完成' })
    const { data } = await put(base, `/api/tasks/${task.id}`, { status: 'done' })
    assert.equal(data.status, 'done')
    assert.ok(data.completed_at)
  })

  test('PUT /api/tasks/:id returns 404 for nonexistent', async () => {
    const { status } = await put(base, '/api/tasks/task-nope', { status: 'done' })
    assert.equal(status, 404)
  })

  test('DELETE /api/tasks/:id deletes task', async () => {
    const { data: task } = await post(base, '/api/tasks', { title: '待删除' })
    const { status, data } = await del(base, `/api/tasks/${task.id}`)
    assert.equal(status, 200)
    assert.equal(data.deleted, task.id)
  })

  test('DELETE /api/tasks/:id returns 404 for nonexistent', async () => {
    const { status } = await del(base, '/api/tasks/task-nope')
    assert.equal(status, 404)
  })

  test('OPTIONS /api/tasks returns CORS headers', async () => {
    const res = await fetch(`${base}/api/tasks`, { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.ok(res.headers.get('access-control-allow-origin'))
  })
})

// ---- Wishes API ----

describe('Wishes API', () => {
  let db: MemoryDB
  let dir: string
  let server: Server
  let base: string

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sia-api-wishes-'))
    db = new MemoryDB(dir)
    const s = await startTestServer(db)
    server = s.server; base = s.base
  })
  after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('POST /api/wishes creates wish', async () => {
    const { status, data } = await post(base, '/api/wishes', { title: '学画画', reason: '想给user画头像', priority: 'high' })
    assert.equal(status, 200)
    assert.ok(data.id.startsWith('wish-'))
    assert.equal(data.title, '学画画')
    assert.equal(data.status, 'pending')
    assert.equal(data.priority, 'high')
  })

  test('POST /api/wishes requires title', async () => {
    const { status } = await post(base, '/api/wishes', { reason: 'no title' })
    assert.equal(status, 400)
  })

  test('POST /api/wishes rejects invalid JSON', async () => {
    const res = await fetch(`${base}/api/wishes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    })
    assert.equal(res.status, 400)
  })

  test('GET /api/wishes returns all', async () => {
    const { status, data } = await get(base, '/api/wishes')
    assert.equal(status, 200)
    assert.ok(Array.isArray(data))
    assert.ok(data.length >= 1)
  })

  test('GET /api/wishes?status=pending filters', async () => {
    const { data } = await get(base, '/api/wishes?status=pending')
    assert.ok(data.every((w: any) => w.status === 'pending'))
  })

  test('PUT /api/wishes/:id updates status and comment', async () => {
    const { data: wish } = await post(base, '/api/wishes', { title: '想要日历' })
    const { status, data } = await put(base, `/api/wishes/${wish.id}`, { status: 'accepted', comment: '下周做' })
    assert.equal(status, 200)
    assert.equal(data.status, 'accepted')
    assert.equal(data.comment, '下周做')
  })

  test('PUT /api/wishes/:id returns 404 for nonexistent', async () => {
    const { status } = await put(base, '/api/wishes/wish-nope', { status: 'done' })
    assert.equal(status, 404)
  })

  test('PUT /api/wishes/:id rejects invalid JSON', async () => {
    const { data: wish } = await post(base, '/api/wishes', { title: 'test' })
    const res = await fetch(`${base}/api/wishes/${wish.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'nope',
    })
    assert.equal(res.status, 400)
  })

  test('full lifecycle: create → accept → done', async () => {
    const { data: wish } = await post(base, '/api/wishes', { title: '完整流程测试' })
    assert.equal(wish.status, 'pending')

    const { data: accepted } = await put(base, `/api/wishes/${wish.id}`, { status: 'accepted', comment: '批准' })
    assert.equal(accepted.status, 'accepted')

    const { data: done } = await put(base, `/api/wishes/${wish.id}`, { status: 'done' })
    assert.equal(done.status, 'done')
    assert.equal(done.comment, '批准') // comment preserved

    // Verify filtered list
    const { data: doneList } = await get(base, '/api/wishes?status=done')
    assert.ok(doneList.some((w: any) => w.id === wish.id))
  })
})
