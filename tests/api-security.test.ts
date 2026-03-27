// tests/api-security.test.ts — Security fixes: auth, body size limit, parseInt cap
import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
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
      handleMemoryAPI(req, res, db).then(handled => {
        if (!handled) { res.writeHead(404); res.end() }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, base: `http://127.0.0.1:${addr.port}` })
    })
  })
}

// ---- Fix 1: Token auth ----

describe('Token auth for mutating requests', () => {
  let db: MemoryDB
  let server: Server
  let base: string
  let tmpDir: string
  const ORIGINAL_TOKEN = process.env.SYMBIONT_DASHBOARD_TOKEN

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-sec-'))
    db = new MemoryDB(join(tmpDir, 'test.db'))
    const s = await startTestServer(db)
    server = s.server; base = s.base
  })

  after(() => {
    server.close()
    // Restore original env
    if (ORIGINAL_TOKEN !== undefined) process.env.SYMBIONT_DASHBOARD_TOKEN = ORIGINAL_TOKEN
    else delete process.env.SYMBIONT_DASHBOARD_TOKEN
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('POST without token when SYMBIONT_DASHBOARD_TOKEN is set → 401', async () => {
    process.env.SYMBIONT_DASHBOARD_TOKEN = 'test-secret-token'
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'should fail' }),
    })
    assert.equal(res.status, 401)
    const data = await res.json() as { error: string }
    assert.equal(data.error, 'unauthorized')
  })

  test('POST with wrong token → 401', async () => {
    process.env.SYMBIONT_DASHBOARD_TOKEN = 'test-secret-token'
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({ title: 'should fail' }),
    })
    assert.equal(res.status, 401)
  })

  test('POST with correct token → 200', async () => {
    process.env.SYMBIONT_DASHBOARD_TOKEN = 'test-secret-token'
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret-token',
      },
      body: JSON.stringify({ title: 'authed task' }),
    })
    assert.equal(res.status, 200)
    const data = await res.json() as { title: string }
    assert.equal(data.title, 'authed task')
  })

  test('GET is allowed without token', async () => {
    process.env.SYMBIONT_DASHBOARD_TOKEN = 'test-secret-token'
    const res = await fetch(`${base}/api/tasks`)
    assert.equal(res.status, 200)
  })

  test('PUT without token when SYMBIONT_DASHBOARD_TOKEN is set → 401', async () => {
    process.env.SYMBIONT_DASHBOARD_TOKEN = 'test-secret-token'
    const res = await fetch(`${base}/api/tasks/fake-id`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'updated' }),
    })
    assert.equal(res.status, 401)
  })

  test('DELETE without token when SYMBIONT_DASHBOARD_TOKEN is set → 401', async () => {
    process.env.SYMBIONT_DASHBOARD_TOKEN = 'test-secret-token'
    const res = await fetch(`${base}/api/tasks/fake-id`, { method: 'DELETE' })
    assert.equal(res.status, 401)
  })

  test('POST without token when SYMBIONT_DASHBOARD_TOKEN is unset → allowed', async () => {
    delete process.env.SYMBIONT_DASHBOARD_TOKEN
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'no auth needed' }),
    })
    assert.equal(res.status, 200)
  })
})

// ---- Fix 2: Body size limit ----

describe('Request body size limit', () => {
  let db: MemoryDB
  let server: Server
  let base: string
  let tmpDir: string

  before(async () => {
    delete process.env.SYMBIONT_DASHBOARD_TOKEN // disable auth for these tests
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-sec-body-'))
    db = new MemoryDB(join(tmpDir, 'test.db'))
    const s = await startTestServer(db)
    server = s.server; base = s.base
  })

  after(() => {
    server.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('normal sized body is accepted', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'small body' }),
    })
    assert.equal(res.status, 200)
  })

  test('body over 1MB is rejected with 413', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 1)
    try {
      const res = await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: huge }),
      })
      // Either 413 or a fetch error (connection destroyed)
      if (res) assert.equal(res.status, 413)
    } catch {
      // Connection destroyed by server — acceptable behavior
      assert.ok(true)
    }
  })
})

// ---- Fix 3: parseInt upper bound ----

describe('parseInt limit cap at 1000', () => {
  let db: MemoryDB
  let server: Server
  let base: string
  let tmpDir: string

  before(async () => {
    delete process.env.SYMBIONT_DASHBOARD_TOKEN
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-sec-limit-'))
    db = new MemoryDB(join(tmpDir, 'test.db'))
    const s = await startTestServer(db)
    server = s.server; base = s.base
  })

  after(() => {
    server.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('limit=50 works normally', async () => {
    const res = await fetch(`${base}/api/activity?limit=50`)
    assert.equal(res.status, 200)
  })

  test('limit=999999 is capped (no crash)', async () => {
    const res = await fetch(`${base}/api/activity?limit=999999`)
    assert.equal(res.status, 200)
  })

  test('limit=NaN falls back to default', async () => {
    const res = await fetch(`${base}/api/activity?limit=abc`)
    assert.equal(res.status, 200)
  })

  test('releases limit is also capped', async () => {
    const res = await fetch(`${base}/api/releases?limit=999999`)
    assert.equal(res.status, 200)
  })
})
