import { LocalFallback } from './local-fallback.ts'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GatewayConfig {
  port: number
  configDir: string                                   // config/ 目录路径，持久化 mcp-backends.json
  getRoleForSession: (sessionKey: string) => { role: string; persona: string } | undefined
  getToolWhitelist: (persona: string) => string[]   // 返回通配符列表
  getSharedTools: () => string[]                     // 公用白名单
  fallback?: LocalFallback                           // MCP 全断降级通道
}

interface BackendEntry {
  name: string
  url: string
  description?: string
  builtin?: boolean   // true = 代码硬注册，不可通过工具移除
}

interface ToolMapping {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  backend: string   // backend name
  annotations?: Record<string, unknown>
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport
  server: Server
  lastAccessAt: number
}

interface TemporaryGrant {
  toolName: string
  sessionKey: string
  expiresAt: number
}

// ─── Backend:Tool Matcher ────────────────────────────────────────────────────

/**
 * 权限格式: "backend:tool"
 *   - "*" 或 "*:*"  → 所有后端所有工具
 *   - "sia-core:*"  → sia-core 后端所有工具
 *   - "sia-core:symbiont_remember" → 精确匹配
 *   - 向后兼容: "symbiont_*" (不含冒号) → 按工具名前缀匹配（旧格式）
 */
export function matchesPattern(backendName: string, toolName: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '*:*') return true

  if (pattern.includes(':')) {
    const [bPat, tPat] = pattern.split(':', 2)
    // 匹配后端名
    const backendMatch = bPat === '*' || bPat === backendName
    if (!backendMatch) return false
    // 匹配工具名
    if (tPat === '*') return true
    if (tPat.endsWith('*')) return toolName.startsWith(tPat.slice(0, -1))
    return tPat === toolName
  }

  // 向后兼容：不含冒号的旧格式，按工具名匹配
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1))
  return pattern === toolName
}

function isToolAllowed(backendName: string, toolName: string, patterns: string[]): boolean {
  return patterns.some(p => matchesPattern(backendName, toolName, p))
}

// ─── MCP Gateway ─────────────────────────────────────────────────────────────

export class McpGateway {
  private config: GatewayConfig
  private backends = new Map<string, BackendEntry>()
  private toolMap = new Map<string, ToolMapping>()    // tool name → mapping
  private sessions = new Map<string, SessionEntry>()
  private backendClients = new Map<string, { client: Client; transport: StreamableHTTPClientTransport }>()
  private temporaryGrants = new Map<string, TemporaryGrant>()
  private httpServer: HttpServer | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private _started = false
  private _refreshing: Promise<void> | null = null

  // Session 不设 TTL — CC 连接与 Symbiont Core 同生命周期，只在 CC 主动 DELETE 或 Gateway stop 时清理
  private static readonly CLEANUP_INTERVAL = 5 * 60 * 1000   // 5 min（仅清理临时授权）

  constructor(config: GatewayConfig) {
    this.config = config
  }

  // ─── Backend Registration ──────────────────────────────────────────────

  private static readonly BACKENDS_FILE = 'mcp-backends.json'

  registerBackend(name: string, url: string, options?: { description?: string; builtin?: boolean }): void {
    this.backends.set(name, { name, url, description: options?.description, builtin: options?.builtin })
    // 异步刷新工具列表并通知 clients
    this.refreshToolMap().then(() => {
      this.notifyToolsChanged()
    }).catch(err => {
      console.error(`[mcp-gateway] failed to refresh tools after registering ${name}:`, err)
    })
  }

  /**
   * 添加第三方后端并持久化。返回发现的工具列表。
   */
  async addBackend(name: string, url: string, description?: string): Promise<{ tools: string[] }> {
    const existing = this.backends.get(name)
    if (existing?.builtin) throw new Error(`"${name}" 是内置后端，不可覆盖`)
    this.backends.set(name, { name, url, description })
    this.saveBackends()
    try {
      await this.refreshToolMap()
    } catch (err) {
      console.error(`[mcp-gateway] failed to refresh tools for "${name}":`, err)
    }
    this.notifyToolsChanged()
    const tools = Array.from(this.toolMap.values()).filter(t => t.backend === name).map(t => t.name)
    return { tools }
  }

  /**
   * 移除第三方后端并持久化。内置后端不可移除。
   */
  removeBackend(name: string): boolean {
    const entry = this.backends.get(name)
    if (!entry) return false
    if (entry.builtin) return false
    this.backends.delete(name)
    for (const [toolName, mapping] of this.toolMap) {
      if (mapping.backend === name) this.toolMap.delete(toolName)
    }
    this.saveBackends()
    this.notifyToolsChanged()
    return true
  }

  unregisterBackend(name: string): void {
    this.backends.delete(name)
    for (const [toolName, mapping] of this.toolMap) {
      if (mapping.backend === name) this.toolMap.delete(toolName)
    }
    this.notifyToolsChanged()
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  private get backendsFilePath(): string {
    return join(this.config.configDir, McpGateway.BACKENDS_FILE)
  }

  /** 启动时加载第三方后端配置 */
  loadBackends(): void {
    const filePath = this.backendsFilePath
    if (!existsSync(filePath)) return
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      const backends: Array<{ name: string; url: string; description?: string }> = data.backends ?? []
      for (const b of backends) {
        this.backends.set(b.name, { name: b.name, url: b.url, description: b.description })
      }
      console.log(`[mcp-gateway] loaded ${backends.length} third-party backend(s) from config`)
    } catch (err) {
      console.error('[mcp-gateway] failed to load mcp-backends.json:', err)
    }
  }

  /** 保存第三方后端配置（排除 builtin） */
  private saveBackends(): void {
    const backends: Array<{ name: string; url: string; description?: string }> = []
    for (const entry of this.backends.values()) {
      if (!entry.builtin) {
        backends.push({ name: entry.name, url: entry.url, description: entry.description })
      }
    }
    mkdirSync(this.config.configDir, { recursive: true })
    const tmpPath = this.backendsFilePath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify({ backends }, null, 2))
    renameSync(tmpPath, this.backendsFilePath)
  }

  // ─── Tool Map Refresh ──────────────────────────────────────────────────

  /**
   * 从所有后端 server 拉取工具列表，构建 toolName → backend 映射。
   * 使用 MCP Client SDK 正式连接后端，通过 initialize + listTools 获取。
   */
  async refreshToolMap(): Promise<void> {
    // Dedup concurrent refreshes
    if (this._refreshing) return this._refreshing
    this._refreshing = this._doRefreshToolMap()
    try { await this._refreshing } finally { this._refreshing = null }
  }

  private async _doRefreshToolMap(): Promise<void> {
    const newMap = new Map<string, ToolMapping>()

    for (const backend of this.backends.values()) {
      try {
        const tools = await this.fetchToolsFromBackend(backend)
        for (const tool of tools) {
          newMap.set(tool.name, {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as Record<string, unknown>,
            backend: backend.name,
            annotations: tool.annotations as Record<string, unknown> | undefined,
          })
        }
      } catch (err) {
        console.error(`[mcp-gateway] failed to fetch tools from backend "${backend.name}" (${backend.url}):`, err)
      }
    }

    this.toolMap = newMap

    // 后端恢复后，重放降级队列中的关键工具调用
    // NOTE: 重放调用跳过 isToolAllowedForSession，因为入队时已通过权限检查。
    if (this.config.fallback && this.config.fallback.pendingCount > 0 && newMap.size > 0) {
      const entries = this.config.fallback.peek()
      if (entries.length > 0) {
        const failed: typeof entries = []
        const results = await Promise.allSettled(
          entries.map(async (entry) => {
            const mapping = newMap.get(entry.tool)
            if (!mapping) {
              // 工具不存在于任何后端，视为失败保留
              failed.push(entry)
              return
            }
            await this.proxyToolCall(mapping.backend, entry.tool, entry.args, entry.sessionKey)
          }),
        )
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'rejected') {
            failed.push(entries[i])
            console.error(`[mcp-gateway] fallback replay failed for "${entries[i].tool}":`, (results[i] as PromiseRejectedResult).reason)
          }
        }
        // 先清空文件，再把失败的重新入队
        this.config.fallback.drain()
        for (const entry of failed) {
          this.config.fallback.enqueue(entry.tool, entry.args, entry.sessionKey)
        }
        console.log(`[mcp-gateway] replayed ${entries.length - failed.length}/${entries.length} queued fallback call(s)`)
      }
    }
  }

  /**
   * 使用 MCP Client SDK 连接后端 server 并获取工具列表。
   */
  private async fetchToolsFromBackend(backend: BackendEntry): Promise<Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: Record<string, unknown>
  }>> {
    const client = new Client({ name: 'symbiont-gateway', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(backend.url))

    try {
      await client.connect(transport)
      const result = await client.listTools()
      return result.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations as Record<string, unknown> | undefined,
      }))
    } finally {
      try { await transport.close() } catch { /* ignore */ }
    }
  }

  // ─── Tool Call Proxy ───────────────────────────────────────────────────

  /**
   * 代理工具调用到对应的后端 server。
   * 使用 MCP Client SDK 创建临时连接，转发 callTool 请求。
   */
  /**
   * 获取或创建到后端的长连接 client。
   * 连接失败时自动清理缓存，下次调用重新连接。
   */
  private async getBackendClient(backendName: string, sessionKey?: string): Promise<Client> {
    const cacheKey = `${backendName}:${sessionKey ?? '_'}`
    const cached = this.backendClients.get(cacheKey)
    if (cached) return cached.client

    const backend = this.backends.get(backendName)
    if (!backend) throw new Error(`Backend "${backendName}" not found`)

    const url = new URL(backend.url)
    if (sessionKey) url.searchParams.set('sk', sessionKey)

    const client = new Client({ name: 'symbiont-gateway', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(url)

    await client.connect(transport)
    this.backendClients.set(cacheKey, { client, transport })
    return client
  }

  private async proxyToolCall(
    backendName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    sessionKey?: string,
  ): Promise<{ content: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean }> {
    const backend = this.backends.get(backendName)
    if (!backend) {
      return {
        content: [{ type: 'text', text: `Backend "${backendName}" not found` }],
        isError: true,
      }
    }

    // 自动重试：首次失败后清理缓存 client 再试一次（处理 session 过期、连接断开等瞬态故障）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await this.getBackendClient(backendName, sessionKey)
        const result = await client.callTool({ name: toolName, arguments: args })
        return result as { content: Array<{ type: string; text?: string }>; isError?: boolean }
      } catch (err) {
        const cacheKey = `${backendName}:${sessionKey ?? '_'}`
        const cached = this.backendClients.get(cacheKey)
        if (cached) {
          try { await cached.transport.close() } catch { /* ignore */ }
          this.backendClients.delete(cacheKey)
        }

        if (attempt === 0) {
          // 首次失败 → 清理缓存后重试
          console.log(`[mcp-gateway] ${toolName} failed (attempt 1), retrying: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }

        // 二次失败 → 降级或报错
        if (this.config.fallback && LocalFallback.isCriticalTool(toolName)) {
          this.config.fallback.enqueue(toolName, args ?? {}, sessionKey)
          return {
            content: [{ type: 'text', text: `[degraded] Tool "${toolName}" call queued for replay when backend recovers.` }],
            isError: false,
          }
        }

        return {
          content: [{ type: 'text', text: `Tool call failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    }
    // unreachable, but TypeScript needs it
    return { content: [{ type: 'text', text: 'unexpected' }], isError: true }
  }

  // ─── Session Helpers ───────────────────────────────────────────────────

  private getFilteredTools(sessionKey?: string): Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: Record<string, unknown>
  }> {
    const allTools = Array.from(this.toolMap.values())

    if (!sessionKey) {
      const shared = this.config.getSharedTools()
      return allTools
        .filter(t => isToolAllowed(t.backend, t.name, shared))
        .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
    }

    const sessionInfo = this.config.getRoleForSession(sessionKey)
    if (!sessionInfo) {
      const shared = this.config.getSharedTools()
      return allTools
        .filter(t => isToolAllowed(t.backend, t.name, shared))
        .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
    }

    // 合并公用白名单 + persona 白名单
    const shared = this.config.getSharedTools()
    const personaTools = this.config.getToolWhitelist(sessionInfo.persona)
    const merged = [...shared, ...personaTools]

    const filtered = allTools
      .filter(t => isToolAllowed(t.backend, t.name, merged))
      .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))

    // 追加临时授权的工具
    const grantedNames = this.getTemporaryGrants(sessionKey)
    const filteredNames = new Set(filtered.map(t => t.name))
    for (const grantedName of grantedNames) {
      if (!filteredNames.has(grantedName)) {
        const tool = this.toolMap.get(grantedName)
        if (tool) {
          filtered.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })
        }
      }
    }

    return filtered
  }

  private isToolAllowedForSession(toolName: string, sessionKey?: string): boolean {
    const mapping = this.toolMap.get(toolName)
    const backendName = mapping?.backend ?? ''
    if (!sessionKey) {
      return isToolAllowed(backendName, toolName, this.config.getSharedTools())
    }
    const sessionInfo = this.config.getRoleForSession(sessionKey)
    if (!sessionInfo) {
      return isToolAllowed(backendName, toolName, this.config.getSharedTools())
    }
    const shared = this.config.getSharedTools()
    const personaTools = this.config.getToolWhitelist(sessionInfo.persona)
    const merged = [...shared, ...personaTools]
    if (isToolAllowed(backendName, toolName, merged)) return true
    // 检查临时授权
    return this.getTemporaryGrants(sessionKey).includes(toolName)
  }

  // ─── MCP Server Per Session ────────────────────────────────────────────

  private createSessionServer(sessionKey?: string): Server {
    const server = new Server(
      { name: 'symbiont-gateway', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.getFilteredTools(sessionKey)
      return { tools }
    })

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      // 权限检查
      if (!this.isToolAllowedForSession(name, sessionKey)) {
        return {
          content: [{ type: 'text' as const, text: `Tool "${name}" is not available for this session.` }],
          isError: true,
        }
      }

      // 查找工具所属 backend
      const mapping = this.toolMap.get(name)
      if (!mapping) {
        return {
          content: [{ type: 'text' as const, text: `Tool "${name}" not found in any backend.` }],
          isError: true,
        }
      }

      // 代理到后端
      return this.proxyToolCall(mapping.backend, name, args, sessionKey)
    })

    return server
  }

  // ─── HTTP Server ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._started) return

    // 初始刷新工具列表
    await this.refreshToolMap()

    const httpServer = createServer()
    this.httpServer = httpServer

    httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await this.handleRequest(req, res)
      } catch (err) {
        console.error('[mcp-gateway] request error:', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      }
    })

    // 定期清理过期的临时授权（session 不清理，与 CC 同生命周期）
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, grant] of this.temporaryGrants) {
        if (now - grant.expiresAt > 0) this.temporaryGrants.delete(key)
      }
    }, McpGateway.CLEANUP_INTERVAL)
    this.cleanupTimer.unref()

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(this.config.port, '127.0.0.1', () => {
        console.log(`[mcp-gateway] listening on port ${this.config.port}`)
        resolve()
      })
      httpServer.on('error', reject)
    })

    this._started = true
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', `http://localhost:${this.config.port}`)
    const pathname = parsedUrl.pathname

    // Health endpoint
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        backends: Array.from(this.backends.keys()),
        tools: this.toolMap.size,
        sessions: this.sessions.size,
      }))
      return
    }

    // MCP endpoint
    if (pathname === '/mcp' || pathname.startsWith('/mcp?')) {
      const sk = parsedUrl.searchParams.get('sk') ?? undefined

      if (req.method === 'POST') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        let entry = sessionId ? this.sessions.get(sessionId) : undefined

        if (!entry) {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
          const server = this.createSessionServer(sk)
          await server.connect(transport)
          entry = { transport, server, lastAccessAt: Date.now() }
        }

        entry.lastAccessAt = Date.now()
        await entry.transport.handleRequest(req, res)

        if (entry.transport.sessionId && !this.sessions.has(entry.transport.sessionId)) {
          this.sessions.set(entry.transport.sessionId, entry)
        }
      } else if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string
        if (sessionId && this.sessions.has(sessionId)) {
          const entry = this.sessions.get(sessionId)!
          await entry.transport.close()
          await entry.server.close()
          this.sessions.delete(sessionId)
        }
        res.writeHead(200)
        res.end()
      } else {
        res.writeHead(405)
        res.end()
      }
      return
    }

    // Admin: list backends
    if (req.method === 'GET' && pathname === '/admin/backends') {
      const backends = Array.from(this.backends.entries()).map(([name, b]) => ({
        name,
        url: b.url,
        tools: Array.from(this.toolMap.values()).filter(t => t.backend === name).map(t => t.name),
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(backends, null, 2))
      return
    }

    // Admin: list temporary grants
    if (req.method === 'GET' && pathname === '/admin/grants') {
      const now = Date.now()
      const grants: Array<{ sessionKey: string; toolName: string; expiresAt: number; remainingMs: number }> = []
      for (const [, grant] of this.temporaryGrants) {
        if (grant.expiresAt > now) {
          grants.push({ sessionKey: grant.sessionKey, toolName: grant.toolName, expiresAt: grant.expiresAt, remainingMs: grant.expiresAt - now })
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(grants, null, 2))
      return
    }

    // Admin: refresh tools
    if (req.method === 'POST' && pathname === '/admin/refresh') {
      await this.refreshToolMap()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tools: this.toolMap.size }))
      return
    }

    res.writeHead(404)
    res.end()
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    for (const entry of this.sessions.values()) {
      entry.transport.close().catch(() => {})
      entry.server.close().catch(() => {})
    }
    this.sessions.clear()
    this.temporaryGrants.clear()

    for (const cached of this.backendClients.values()) {
      cached.transport.close().catch(() => {})
    }
    this.backendClients.clear()

    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }

    this._started = false
    console.log('[mcp-gateway] stopped')
  }

  /**
   * 通知所有已连接的 client 刷新工具列表。
   * 向每个 session 的 server 发送 notifications/tools/list_changed。
   */
  notifyToolsChanged(): void {
    for (const entry of this.sessions.values()) {
      entry.server.sendToolListChanged().catch(err => {
        console.error('[mcp-gateway] failed to send tools/list_changed:', err)
      })
    }
  }

  /**
   * 返回所有后端及其工具列表（供 MCP 工具查询）。
   */
  getBackendList(): Array<{ name: string; url: string; tools: string[] }> {
    return Array.from(this.backends.entries()).map(([name, b]) => ({
      name,
      url: b.url,
      tools: Array.from(this.toolMap.values()).filter(t => t.backend === name).map(t => t.name),
    }))
  }

  // ─── Temporary Grants ──────────────────────────────────────────────────

  grantTool(sessionKey: string, toolName: string, durationMs: number = 3600000): void {
    const key = `${sessionKey}:${toolName}`
    this.temporaryGrants.set(key, { toolName, sessionKey, expiresAt: Date.now() + durationMs })
    this.notifyToolsChanged()
  }

  revokeTool(sessionKey: string, toolName: string): boolean {
    const key = `${sessionKey}:${toolName}`
    const existed = this.temporaryGrants.delete(key)
    if (existed) this.notifyToolsChanged()
    return existed
  }

  getTemporaryGrants(sessionKey: string): string[] {
    const now = Date.now()
    const result: string[] = []
    for (const [key, grant] of this.temporaryGrants) {
      if (grant.sessionKey === sessionKey) {
        if (grant.expiresAt > now) {
          result.push(grant.toolName)
        } else {
          this.temporaryGrants.delete(key)
        }
      }
    }
    return result
  }

  // ─── Getters ───────────────────────────────────────────────────────────

  get port(): number { return this.config.port }
  get url(): string { return `http://127.0.0.1:${this.config.port}/mcp` }
  get backendCount(): number { return this.backends.size }
  get toolCount(): number { return this.toolMap.size }
  get sessionCount(): number { return this.sessions.size }
}

