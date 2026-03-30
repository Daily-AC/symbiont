// tests/issues.test.ts — Issue DB + API 层测试
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { handleMemoryAPI } from '../src/api/memory-api.ts'

// ---- DB Layer ----

describe('Issues DB', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sia-issues-db-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('addIssue creates issue with defaults', () => {
    const issue = db.addIssue('飞书卡片消息无法解析')
    assert.ok(issue.id.startsWith('issue-'))
    assert.equal(issue.title, '飞书卡片消息无法解析')
    assert.equal(issue.status, 'open')
    assert.equal(issue.severity, 'normal')
    assert.equal(issue.created_by, 'default')
  })

  test('addIssue with all fields', () => {
    const issue = db.addIssue('内存泄漏', 'MCP transport 未释放', 'critical', 'system')
    assert.equal(issue.severity, 'critical')
    assert.equal(issue.description, 'MCP transport 未释放')
    assert.equal(issue.created_by, 'system')
  })

  test('getIssues returns all', () => {
    const all = db.getIssues()
    assert.ok(all.length >= 2)
  })

  test('getIssues filters by status', () => {
    const open = db.getIssues('open')
    assert.ok(open.every(i => i.status === 'open'))
    assert.ok(open.length >= 2)
  })

  test('updateIssue changes status', () => {
    const issue = db.addIssue('测试问题')
    const updated = db.updateIssue(issue.id, { status: 'investigating' })
    assert.equal(updated?.status, 'investigating')
  })

  test('updateIssue adds resolution', () => {
    const issue = db.addIssue('已修复的问题')
    const updated = db.updateIssue(issue.id, { status: 'resolved', resolution: '升级了依赖版本' })
    assert.equal(updated?.status, 'resolved')
    assert.equal(updated?.resolution, '升级了依赖版本')
  })

  test('updateIssue changes severity', () => {
    const issue = db.addIssue('严重程度变更')
    const updated = db.updateIssue(issue.id, { severity: 'high' })
    assert.equal(updated?.severity, 'high')
  })

  test('updateIssue returns undefined for nonexistent', () => {
    assert.equal(db.updateIssue('issue-nope', { status: 'resolved' }), undefined)
  })

  test('full lifecycle: open → investigating → resolved', () => {
    const issue = db.addIssue('完整流程')
    assert.equal(issue.status, 'open')

    const inv = db.updateIssue(issue.id, { status: 'investigating' })
    assert.equal(inv?.status, 'investigating')

    const resolved = db.updateIssue(issue.id, { status: 'resolved', resolution: '已修复' })
    assert.equal(resolved?.status, 'resolved')
    assert.equal(resolved?.resolution, '已修复')

    const resolvedList = db.getIssues('resolved')
    assert.ok(resolvedList.some(i => i.id === issue.id))
  })
})

// ---- API Layer ----

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

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, data: res.status === 200 ? await res.json() : await res.text() }
}

async function put(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, data: res.status === 200 ? await res.json() : await res.text() }
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, data: res.status === 200 ? await res.json() : await res.text() }
}

describe('Issues API', () => {
  let db: MemoryDB
  let dir: string
  let server: Server
  let base: string

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sia-issues-api-'))
    db = new MemoryDB(dir)
    const s = await startTestServer(db)
    server = s.server; base = s.base
  })
  after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('POST /api/issues creates issue', async () => {
    const { status, data } = await post(base, '/api/issues', { title: '测试问题', severity: 'high' })
    assert.equal(status, 200)
    assert.ok(data.id.startsWith('issue-'))
    assert.equal(data.status, 'open')
    assert.equal(data.severity, 'high')
  })

  test('POST /api/issues requires title', async () => {
    const { status } = await post(base, '/api/issues', { description: 'no title' })
    assert.equal(status, 400)
  })

  test('GET /api/issues returns all', async () => {
    const { status, data } = await get(base, '/api/issues')
    assert.equal(status, 200)
    assert.ok(Array.isArray(data))
    assert.ok(data.length >= 1)
  })

  test('GET /api/issues?status=open filters', async () => {
    const { data } = await get(base, '/api/issues?status=open')
    assert.ok(data.every((i: any) => i.status === 'open'))
  })

  test('PUT /api/issues/:id updates status and resolution', async () => {
    const { data: issue } = await post(base, '/api/issues', { title: '待解决' })
    const { status, data } = await put(base, `/api/issues/${issue.id}`, { status: 'resolved', resolution: '已修复' })
    assert.equal(status, 200)
    assert.equal(data.status, 'resolved')
    assert.equal(data.resolution, '已修复')
  })

  test('PUT /api/issues/:id returns 404 for nonexistent', async () => {
    const { status } = await put(base, '/api/issues/issue-nope', { status: 'resolved' })
    assert.equal(status, 404)
  })

  test('full API lifecycle', async () => {
    const { data: issue } = await post(base, '/api/issues', { title: 'API 流程测试', severity: 'critical' })
    assert.equal(issue.status, 'open')

    const { data: inv } = await put(base, `/api/issues/${issue.id}`, { status: 'investigating' })
    assert.equal(inv.status, 'investigating')

    const { data: resolved } = await put(base, `/api/issues/${issue.id}`, { status: 'resolved', resolution: 'done' })
    assert.equal(resolved.status, 'resolved')

    const { data: list } = await get(base, '/api/issues?status=resolved')
    assert.ok(list.some((i: any) => i.id === issue.id))
  })
})
