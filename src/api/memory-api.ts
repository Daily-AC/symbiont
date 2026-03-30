import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryDB } from '../memory/db.ts'
import type { SymbiontCore } from '../core/symbiont-core.ts'
import { updateManifestField } from '../persona/manifest.ts'
import { loadSharedCapabilities, updateSharedCapabilities } from '../core/capability-config.ts'

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '', size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return }
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export function generateSessionValue(token: string): string {
  return createHmac('sha256', token).update('symbiont-session').digest('hex')
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {}
  const header = req.headers.cookie ?? ''
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key) cookies[key] = rest.join('=')
  }
  return cookies
}

function checkAuth(req: IncomingMessage): boolean {
  const token = process.env.SYMBIONT_DASHBOARD_TOKEN
  if (!token) return true // no token configured → skip auth (local dev)

  // Path 1: Bearer token (API/curl)
  const authHeader = req.headers.authorization ?? ''
  if (authHeader === `Bearer ${token}`) return true

  // Path 2: Session cookie (browser)
  const cookies = parseCookies(req)
  const sessionCookie = cookies['symbiont_session']
  if (sessionCookie && sessionCookie === generateSessionValue(token)) return true

  return false
}

export async function handleMemoryAPI(req: IncomingMessage, res: ServerResponse, db: MemoryDB, core?: SymbiontCore): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost`)
  const path = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true }

  // Login endpoint — no auth required
  if (path === '/api/login' && req.method === 'POST') {
    const body = await readBody(req)
    const { password } = JSON.parse(body)
    const token = process.env.SYMBIONT_DASHBOARD_TOKEN

    if (!token || password === token) {
      const sessionValue = token ? generateSessionValue(token) : 'dev'
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `symbiont_session=${sessionValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
      })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'wrong password' }))
    }
    return true
  }

  // Logout endpoint — no auth required
  if (path === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'symbiont_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  // Token auth for mutating requests (localhost releases exempt — has own IP check)
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    const isLocalhostRelease = path === '/api/releases' && req.method === 'POST'
    if (!isLocalhostRelease && !checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return true
    }
  }

  const json = (data: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (path === '/api/cards' && req.method === 'GET') {
    const tag = url.searchParams.get('tag') ?? undefined
    const q = url.searchParams.get('q') ?? undefined
    const status = url.searchParams.get('status')
    const owner = url.searchParams.get('owner') ?? undefined
    const archived = status === 'archived' ? true : status === 'active' ? false : undefined
    json(db.searchCards({ keyword: q, tags: tag ? [tag] : undefined, archived, owner }))
    return true
  }

  if (path.startsWith('/api/cards/') && req.method === 'GET') {
    const id = path.split('/')[3]
    const card = db.getCard(id)
    if (!card) { res.writeHead(404); res.end(); return true }
    const connections = db.getConnections(id)
    json({ ...card, connectionDetails: connections })
    return true
  }

  if (path === '/api/graph' && req.method === 'GET') {
    json(db.getGraphData())
    return true
  }

  if (path === '/api/connections' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500)
    json(db.getAllConnections(limit))
    return true
  }

  // Edit card
  if (path.startsWith('/api/cards/') && req.method === 'PUT') {
    const id = path.split('/')[3]
    try {
      const body = await readBody(req)
      const updates = JSON.parse(body)
      const card = db.updateCard(id, updates)
      json(card ?? { error: 'not found' })
      if (core?.sseManager) {
        core.sseManager.broadcast('memory', { action: 'updated', cardId: id })
        core.sseManager.broadcast('graph', { action: 'changed' })
      }
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  // Delete card
  if (path.startsWith('/api/cards/') && req.method === 'DELETE') {
    const id = path.split('/')[3]
    db.deleteCard(id)
    json({ deleted: id })
    if (core?.sseManager) {
      core.sseManager.broadcast('memory', { action: 'deleted', cardId: id })
      core.sseManager.broadcast('graph', { action: 'changed' })
    }
    return true
  }

  if (path === '/api/feedback' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const { card_id, verdict, comment } = JSON.parse(body)
      const fb = db.addFeedback(card_id, verdict, comment)
      json(fb)
      if (core?.sseManager) core.sseManager.broadcast('memory', { action: 'feedback' })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  if (path === '/api/activity' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50') || 50, 1000)
    json(db.getActivity(limit))
    return true
  }

  if (path.match(/^\/api\/events\/[^/]+$/) && req.method === 'GET') {
    const sessionId = decodeURIComponent(path.split('/')[3])
    json(db.getEvents(sessionId))
    return true
  }

  if (path === '/api/status' && req.method === 'GET') {
    json(db.getStats())
    return true
  }

  if (path === '/api/cognitions' && req.method === 'GET') {
    const status = url.searchParams.get('status') ?? undefined
    json(db.getCognitions(status))
    return true
  }

  // ---- System-wide endpoints (require core) ----

  if (core && path === '/api/instances' && req.method === 'GET') {
    const instances = core.broker.status()
    // 补充 siaSessionId（从 SessionManager 按 sessionKey 查找）
    const enriched = instances.map(inst => {
      const session = inst.sessionKey ? core.sessionManager.getLatestBySessionKey(inst.sessionKey) : undefined
      return { ...inst, siaSessionId: session?.sessionId ?? null }
    })
    json(enriched)
    return true
  }

  if (core && path.match(/^\/api\/conversation\/[^/]+$/) && req.method === 'GET') {
    const siaSessionId = decodeURIComponent(path.split('/')[3])
    const events = core.eventStore.read(siaSessionId)
    // 只返回 chat 类型事件（用户和助手消息）
    const chatEvents = events
      .filter(e => e.type === 'chat')
      .map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        role: e.data.role as string,
        content: e.data.content as string,
        blocks: e.data.blocks ?? null,
      }))
    json(chatEvents)
    return true
  }

  if (core && path === '/api/cron' && req.method === 'GET') {
    const jobs = core.cronScheduler.listJobs()
    json({ jobs, running: core.cronScheduler.isRunning })
    return true
  }

  if (core && path.startsWith('/api/cron/runs') && req.method === 'GET') {
    const jobId = url.searchParams.get('jobId') ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200)
    json(core.cronScheduler.getRuns(jobId, limit))
    return true
  }

  if (core && path === '/api/settler' && req.method === 'GET') {
    json({
      status: core.settler.settleStatus,
    })
    return true
  }

  if (core && path === '/api/embedding' && req.method === 'GET') {
    json({
      available: core.embeddingClient.isAvailable,
      url: 'http://127.0.0.1:8000/embeddings',
    })
    return true
  }

  if (core && path === '/api/overview' && req.method === 'GET') {
    const memStats = db.getStats()
    const instances = core.broker.status()
    json({
      uptime: process.uptime(),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      persona: core.persona.manifest?.name ?? 'unknown',
      instances: instances.length,
      instancesActive: instances.filter((i: any) => i.state === 'running').length,
      cron: { running: core.cronScheduler.isRunning, jobs: core.cronScheduler.jobCount },
      settler: core.settler.settleStatus,
      embedding: core.embeddingClient.isAvailable,
      memoryStats: memStats,
    })
    return true
  }

  // ---- Wishes ----

  if (path === '/api/wishes' && req.method === 'GET') {
    const status = url.searchParams.get('status') ?? undefined
    json(db.getWishes(status))
    return true
  }

  if (path === '/api/wishes' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const { title, reason, priority } = JSON.parse(body)
      if (!title) { res.writeHead(400); res.end('title is required'); return true }
      const wish = db.addWish(title, reason, priority)
      json(wish)
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  if (path.startsWith('/api/wishes/') && req.method === 'PUT') {
    const id = path.split('/')[3]
    try {
      const body = await readBody(req)
      const updates = JSON.parse(body)
      const wish = db.updateWish(id, updates)
      if (!wish) { res.writeHead(404); res.end('Not found'); return true }
      json(wish)
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  // ---- Tasks ----

  if (path === '/api/tasks' && req.method === 'GET') {
    const status = url.searchParams.get('status') ?? undefined
    const assignee = url.searchParams.get('assignee') ?? undefined
    const filter: { status?: string; assignee?: string } = {}
    if (status) filter.status = status
    if (assignee) filter.assignee = assignee
    json(db.listTasks(filter))
    return true
  }

  if (path === '/api/tasks' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const data = JSON.parse(body)
      if (!data.title) { res.writeHead(400); res.end('title is required'); return true }
      const task = db.addTask(data)
      json(task)
      if (core?.sseManager) core.sseManager.broadcast('task', { action: 'created', task })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  if (path.startsWith('/api/tasks/') && req.method === 'PUT') {
    const id = path.split('/')[3]
    try {
      const body = await readBody(req)
      const updates = JSON.parse(body)
      const task = db.updateTask(id, updates)
      if (!task) { res.writeHead(404); res.end('Not found'); return true }
      json(task)
      if (core?.sseManager) core.sseManager.broadcast('task', { action: 'updated', task })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  if (path.startsWith('/api/tasks/') && req.method === 'DELETE') {
    const id = path.split('/')[3]
    const deleted = db.deleteTask(id)
    if (!deleted) { res.writeHead(404); res.end('Not found'); return true }
    json({ deleted: id })
    if (core?.sseManager) core.sseManager.broadcast('task', { action: 'deleted', id })
    return true
  }

  // ---- Issues ----

  if (path === '/api/issues' && req.method === 'GET') {
    const status = url.searchParams.get('status') ?? undefined
    json(db.getIssues(status))
    return true
  }

  if (path === '/api/issues' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const { title, description, severity, created_by } = JSON.parse(body)
      if (!title) { res.writeHead(400); res.end('title is required'); return true }
      const issue = db.addIssue(title, description, severity, created_by)
      json(issue)
      if (core?.sseManager) core.sseManager.broadcast('issue', { action: 'created', issue })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  if (path.startsWith('/api/issues/') && req.method === 'PUT') {
    const id = path.split('/')[3]
    try {
      const body = await readBody(req)
      const updates = JSON.parse(body)
      const issue = db.updateIssue(id, updates)
      if (!issue) { res.writeHead(404); res.end('Not found'); return true }
      json(issue)
      if (core?.sseManager) core.sseManager.broadcast('issue', { action: 'updated', issue })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  // ---- Personas ----

  if (core && path === '/api/personas' && req.method === 'GET') {
    const personas: Array<Record<string, unknown>> = []

    // primary persona
    const mainManifest = core.persona.manifest
    if (mainManifest) {
      personas.push({
        name: mainManifest.name,
        description: mainManifest.description,
        role: 'main',
        tags: [],
        mcp: mainManifest.mcp ?? { tools: [] },
        skills: mainManifest.skills ?? { include: [] },
      })
    }

    // persona-packs via registry (use entries() to get full PersonaPack with persona.manifest)
    for (const pack of core.personaRegistry.entries()) {
      personas.push({
        key: pack.name,  // 目录名，用于 API 调用
        name: pack.manifest.name,
        description: pack.manifest.description,
        role: 'specialist',
        tags: pack.manifest.tags ?? [],
        mcp: pack.persona.manifest?.mcp ?? { tools: [] },
        skills: pack.persona.manifest?.skills ?? { include: [] },
      })
    }

    json(personas)
    return true
  }

  // ---- MCP Status ----

  if (core && path === '/api/mcp-status' && req.method === 'GET') {
    const gw = core.gateway
    if (!gw) {
      json({ gateway: null, backends: [] })
    } else {
      // Fetch backend details from gateway admin endpoint
      let backends: Array<{ name: string; url: string; tools: string[] }> = []
      try {
        const resp = await fetch(`http://127.0.0.1:${gw.port}/admin/backends`, { signal: AbortSignal.timeout(3000) })
        if (resp.ok) backends = await resp.json() as typeof backends
      } catch (err) { console.warn('[api] failed to fetch gateway backends:', err) }

      json({
        gateway: {
          port: gw.port,
          url: gw.url,
          backends: gw.backendCount,
          tools: gw.toolCount,
          sessions: gw.sessionCount,
        },
        backends,
      })
    }
    return true
  }

  // ---- Skills ----

  if (core && path === '/api/skills' && req.method === 'GET') {
    const siaRoot = join(core.config.dataDir, '..')
    const skillsDir = join(siaRoot, 'skills')
    const skills: Array<{ name: string; hasSkillMd: boolean; path: string }> = []

    if (existsSync(skillsDir)) {
      try {
        const entries = readdirSync(skillsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const skillPath = join(skillsDir, entry.name)
          const hasSkillMd = existsSync(join(skillPath, 'SKILL.md'))
          skills.push({ name: entry.name, hasSkillMd, path: skillPath })
        }
      } catch { /* ignore read errors */ }
    }

    json(skills)
    return true
  }

  // ---- Persona Management (PUT) ----

  if (core && path.match(/^\/api\/personas\/[^/]+\/mcp-tools$/) && req.method === 'PUT') {
    const personaName = path.split('/')[3]
    try {
      const body = await readBody(req)
      const { values } = JSON.parse(body)
      if (!Array.isArray(values)) { res.writeHead(400); res.end('values must be an array'); return true }
      const packsDir = join(core.config.dataDir, '..', 'persona-packs')
      const packDir = join(packsDir, personaName)
      if (!existsSync(packDir)) { res.writeHead(404); res.end('Persona not found'); return true }
      updateManifestField(packDir, 'mcp.tools', values)
      core.personaRegistry.rescan()
      if (core.gateway) core.gateway.notifyToolsChanged()
      json({ ok: true, persona: personaName, field: 'mcp.tools', values })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end(String(e)) }
    }
    return true
  }

  if (core && path.match(/^\/api\/personas\/[^/]+\/skills$/) && req.method === 'PUT') {
    const personaName = path.split('/')[3]
    try {
      const body = await readBody(req)
      const { values } = JSON.parse(body)
      if (!Array.isArray(values)) { res.writeHead(400); res.end('values must be an array'); return true }
      const packsDir = join(core.config.dataDir, '..', 'persona-packs')
      const packDir = join(packsDir, personaName)
      if (!existsSync(packDir)) { res.writeHead(404); res.end('Persona not found'); return true }
      updateManifestField(packDir, 'skills.include', values)
      core.personaRegistry.rescan()
      json({ ok: true, persona: personaName, field: 'skills.include', values })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end(String(e)) }
    }
    return true
  }

  // ---- Shared Capabilities ----

  if (core && path === '/api/shared-capabilities' && req.method === 'GET') {
    const configDir = join(core.config.dataDir, '..', 'config')
    json(loadSharedCapabilities(configDir))
    return true
  }

  if (core && path === '/api/shared-capabilities' && req.method === 'PUT') {
    try {
      const body = await readBody(req)
      const { field, values } = JSON.parse(body)
      if (!field || !Array.isArray(values)) { res.writeHead(400); res.end('field and values required'); return true }
      const configDir = join(core.config.dataDir, '..', 'config')
      updateSharedCapabilities(configDir, field, values)
      if (core.gateway) core.gateway.notifyToolsChanged()
      json({ ok: true, field, values })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end(String(e)) }
    }
    return true
  }

  // ---- Capabilities (merged view) ----

  if (core && path.match(/^\/api\/capabilities\/[^/]+$/) && req.method === 'GET') {
    const personaName = path.split('/')[3]
    const configDir = join(core.config.dataDir, '..', 'config')
    const sharedCaps = loadSharedCapabilities(configDir)
    const pack = core.personaRegistry.get(personaName)
    const manifest = pack?.persona.manifest ?? (personaName === (core.persona.manifest?.name ?? 'default') ? core.persona.manifest : null)
    if (!manifest) { res.writeHead(404); res.end('Persona not found'); return true }
    const tools = [...new Set([...sharedCaps.mcp.always_available, ...(manifest.mcp?.tools ?? [])])]
    const skills = [...new Set([...sharedCaps.skills.always_available, ...(manifest.skills?.include ?? [])])]
    json({ persona: personaName, tools, skills })
    return true
  }

  // ---- Gateway Grants ----

  if (core && path === '/api/gateway/grant' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const { session_key, tool_name, duration_minutes } = JSON.parse(body)
      if (!session_key || !tool_name) { res.writeHead(400); res.end('session_key and tool_name required'); return true }
      const gw = core.gateway
      if (!gw) { res.writeHead(503); res.end('Gateway not running'); return true }
      gw.grantTool(session_key, tool_name, (duration_minutes ?? 60) * 60 * 1000)
      json({ ok: true, session_key, tool_name, duration_minutes: duration_minutes ?? 60 })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end(String(e)) }
    }
    return true
  }

  if (core && path === '/api/gateway/revoke' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const { session_key, tool_name } = JSON.parse(body)
      if (!session_key || !tool_name) { res.writeHead(400); res.end('session_key and tool_name required'); return true }
      const gw = core.gateway
      if (!gw) { res.writeHead(503); res.end('Gateway not running'); return true }
      const revoked = gw.revokeTool(session_key, tool_name)
      json({ ok: revoked, session_key, tool_name })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end(String(e)) }
    }
    return true
  }

  // ---- Releases ----

  if (path === '/api/releases' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20') || 20, 1000)
    json(db.getReleases(limit))
    return true
  }

  if (path === '/api/releases' && req.method === 'POST') {
    // Only allow from localhost (deploy scripts call via ssh → 127.0.0.1)
    const remoteAddr = req.socket.remoteAddress ?? ''
    if (!remoteAddr.includes('127.0.0.1') && !remoteAddr.includes('::1')) {
      res.writeHead(403); res.end('Forbidden: releases can only be created from localhost'); return true
    }
    try {
      const body = await readBody(req)
      const { version, commits, git_hash } = JSON.parse(body)
      if (!version) { res.writeHead(400); res.end('version is required'); return true }
      const release = db.addRelease(version, commits ?? [], git_hash)
      json(release)
      if (core?.sseManager) core.sseManager.broadcast('release', { action: 'created', release })
    } catch (e) {
      if ((e as Error).message === 'body too large') { res.writeHead(413); res.end('Body too large'); }
      else { res.writeHead(400); res.end('Invalid JSON') }
    }
    return true
  }

  return false
}
