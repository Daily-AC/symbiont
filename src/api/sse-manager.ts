// src/api/sse-manager.ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { generateSessionValue, parseCookies } from './memory-api.ts'

const MAX_CLIENTS = 20

export class SSEManager {
  private clients: Set<ServerResponse> = new Set()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private overviewFn: (() => unknown) | null = null

  setOverviewProvider(fn: () => unknown): void {
    this.overviewFn = fn
  }

  connect(req: IncomingMessage, res: ServerResponse, token?: string): void {
    const configToken = process.env.SYMBIONT_DASHBOARD_TOKEN
    if (configToken) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const clientToken = url.searchParams.get('token') ?? token

      // Check token query param OR session cookie
      let authed = clientToken === configToken
      if (!authed) {
        const cookies = parseCookies(req)
        authed = cookies['symbiont_session'] === generateSessionValue(configToken)
      }
      if (!authed) {
        res.writeHead(401, { 'Content-Type': 'text/plain' })
        res.end('Unauthorized')
        return
      }
    }

    if (this.clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Too many SSE connections')
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    res.write(`event: connected\ndata: ${JSON.stringify({ clients: this.clients.size + 1 })}\n\n`)

    this.clients.add(res)

    req.on('close', () => {
      this.clients.delete(res)
    })
  }

  broadcast(channel: string, data: unknown): void {
    let payload: string
    try {
      payload = `event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`
    } catch { return }
    for (const client of this.clients) {
      try {
        client.write(payload)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      if (this.clients.size === 0) return
      const overview = this.overviewFn ? this.overviewFn() : { ts: Date.now() }
      this.broadcast('heartbeat', overview)
    }, 30_000)
  }

  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const client of this.clients) {
      try { client.end() } catch { /* ignore */ }
    }
    this.clients.clear()
  }

  get clientCount(): number { return this.clients.size }
}
