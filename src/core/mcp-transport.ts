import { createServer, type Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

export interface McpHttpServerHandle {
  port: number
  url: string
  close: () => Promise<void>
}

export interface McpHttpServerOptions {
  name: string
  version: string
  setupHandlers: (server: Server, sessionKey?: string) => void
  logger?: { info: (module: string, action: string, meta?: Record<string, unknown>) => void }
}

/**
 * 创建 MCP Streamable HTTP Server。
 *
 * 每个 client session 创建独立的 Server 实例（MCP SDK 限制：一个 Server 只能 connect 一次）。
 * sessionId 在 handleRequest 之后存储（transport 需要处理 initialize 后才有 sessionId）。
 */
export async function createMcpHttpServer(options: McpHttpServerOptions): Promise<McpHttpServerHandle> {
  const MCP_SESSION_TTL = 6 * 3600 * 1000   // 6 hours（覆盖心跳 4h 间隔 + 余量）
  const MCP_CLEANUP_INTERVAL = 5 * 60 * 1000  // every 5 minutes

  const httpServer = createServer()
  const transports = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; lastAccessAt: number }>()

  function createSessionServer(sessionKey?: string): Server {
    const server = new Server(
      { name: options.name, version: options.version },
      { capabilities: { tools: {} } },
    )
    options.setupHandlers(server, sessionKey)
    return server
  }

  httpServer.on('request', async (req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/mcp')) {
      // 从 URL query param 解析 sessionKey（sk）
      const parsedUrl = new URL(req.url, 'http://localhost')
      const sk = parsedUrl.searchParams.get('sk') ?? undefined

      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let entry = sessionId ? transports.get(sessionId) : undefined
      if (!entry) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
        const server = createSessionServer(sk)
        await server.connect(transport)
        entry = { transport, server, lastAccessAt: Date.now() }
      }
      entry.lastAccessAt = Date.now()
      await entry.transport.handleRequest(req, res)
      if (entry.transport.sessionId && !transports.has(entry.transport.sessionId)) {
        transports.set(entry.transport.sessionId, entry)
      }
    } else if (req.method === 'DELETE' && req.url?.startsWith('/mcp')) {
      const sessionId = req.headers['mcp-session-id'] as string
      if (sessionId && transports.has(sessionId)) {
        const e = transports.get(sessionId)!
        await e.transport.close()
        await e.server.close()
        transports.delete(sessionId)
      }
      res.writeHead(200); res.end()
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', sessions: transports.size }))
    } else {
      res.writeHead(404); res.end()
    }
  })

  // 定期清理过期的 MCP session，防止孤儿 session 内存泄漏
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [sid, entry] of transports) {
      if (now - entry.lastAccessAt > MCP_SESSION_TTL) {
        entry.transport.close()
        entry.server.close()
        transports.delete(sid)
        options.logger?.info('mcp', 'session-expired', { sessionId: sid })
      }
    }
  }, MCP_CLEANUP_INTERVAL)
  cleanupTimer.unref()

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
    httpServer.on('error', reject)
  })

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      clearInterval(cleanupTimer)
      for (const e of transports.values()) {
        await e.transport.close()
        await e.server.close()
      }
      transports.clear()
      httpServer.close()
    },
  }
}
