import { createServer, type Server as HttpServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SymbiontCore } from './symbiont-core.ts'
import { handleMemoryAPI } from '../api/memory-api.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Health + Dashboard HTTP server.
 * Serves /health, /api/* (memory REST API), and / (dashboard HTML).
 */
export async function startHealthServer(core: SymbiontCore, port = 18080): Promise<HttpServer> {
  const server = createServer(async (req, res) => {
    try {
    // Helper: check session cookie validity
    function hasValidSession(): boolean {
      const token = process.env.SYMBIONT_DASHBOARD_TOKEN
      if (!token) return true // no token → no auth needed
      const cookieHeader = req.headers.cookie ?? ''
      const cookies: Record<string, string> = {}
      for (const pair of cookieHeader.split(';')) {
        const [key, ...rest] = pair.trim().split('=')
        if (key) cookies[key] = rest.join('=')
      }
      const expected = createHmac('sha256', token).update('symbiont-session').digest('hex')
      return cookies['symbiont_session'] === expected
    }

    // Login page — no auth required
    if (req.url === '/login') {
      const loginPath = join(__dirname, '..', 'api', 'login.html')
      if (existsSync(loginPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(readFileSync(loginPath, 'utf-8'))
        return
      }
    }

    // SSE endpoint
    if (req.url?.startsWith('/api/sse')) {
      core.sseManager.connect(req, res)
      return
    }

    // Memory + System API routes
    if (req.url?.startsWith('/api/')) {
      if (await handleMemoryAPI(req, res, core.memoryDB, core)) return
    }

    // Static files for dashboard (css, js)
    if (req.url?.startsWith('/static/')) {
      const rawName = req.url.slice(8).split('?')[0]  // strip query string (cache-busting)
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '')
      const staticPath = join(__dirname, '..', 'api', 'static', safeName)
      if (existsSync(staticPath)) {
        const ext = safeName.split('.').pop()
        const mimeTypes: Record<string, string> = { css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', png: 'image/png' }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext ?? ''] ?? 'text/plain', 'Cache-Control': 'no-cache' })
        res.end(readFileSync(staticPath))
        return
      }
    }

    // Health endpoint
    if (req.url === '/health') {
      const status = {
        status: 'ok',
        uptime: process.uptime(),
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
        broker: core.broker.status(),
        cron: {
          running: core.cronScheduler.isRunning,
          jobs: core.cronScheduler.jobCount,
        },
        persona: core.persona.manifest?.name ?? 'unknown',
        mcpServer: core.getMcpServerUrl(),
        memorySqlite: core.memoryDB.getStats(),
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status, null, 2))
      return
    }

    // Dashboard — check auth, redirect to login if needed
    if (req.url === '/' || req.url === '/dashboard') {
      if (!hasValidSession()) {
        res.writeHead(302, { 'Location': '/login' })
        res.end()
        return
      }
      const htmlPath = join(__dirname, '..', 'api', 'dashboard.html')
      if (existsSync(htmlPath)) {
        let html = readFileSync(htmlPath, 'utf-8')
        const v = Date.now()
        html = html.replace('/static/dashboard.css', `/static/dashboard.css?v=${v}`)
        html = html.replace('/static/dashboard.js', `/static/dashboard.js?v=${v}`)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(html)
        return
      }
    }

    res.writeHead(404)
    res.end()
    } catch (err) {
      console.error('[health] request error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      core.logger.info('health', 'started', { port })
      resolve()
    })
  })

  return server
}
