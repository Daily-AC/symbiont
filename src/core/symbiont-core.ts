import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { CCBroker } from './cc-broker.ts'
import { EventStore } from './event-store.ts'
import { SessionManager } from './session.ts'
import { WorkerManager } from './worker-manager.ts'
import { ForkManager } from './fork-manager.ts'
import { CronScheduler, type CronJob } from './cron-scheduler.ts'
import { WorkspaceManager } from './workspace-manager.ts'
import { MemoryBridge } from '../memory/memory-bridge.ts'
import { CognitionEngine } from '../memory/cognition.ts'
import { loadPersona, type PersonaConfig } from '../persona/loader.ts'
import { loadUser, type UserProfile } from '../user/loader.ts'
import { Logger } from './logger.ts'
import { createSymbiontMcpServer, type SiaMcpServerHandle } from './symbiont-mcp-server.ts'
import { createToolHandlers } from './mcp-tool-handlers.ts'
import { handleCronTrigger } from './cron-handler.ts'
import { McpGateway } from './mcp-gateway.ts'
import { LocalFallback } from './local-fallback.ts'
import { loadSharedCapabilities } from './capability-config.ts'
import { PersonaRegistry } from '../persona/registry.ts'
import { MemoryDB } from '../memory/db.ts'
import { MemoryExtractor } from '../memory/extractor.ts'
import { MemoryLifecycle } from '../memory/lifecycle.ts'
import { Connector } from '../memory/connector.ts'
import { EmbeddingClient } from '../memory/embedding-client.ts'
import { Settler } from '../memory/settler.ts'
import { Compiler } from '../memory/compiler.ts'
import { SSEManager } from '../api/sse-manager.ts'

export interface SymbiontCoreConfig {
  dataDir: string
  personaPackDir: string
  userDir: string
}

const GATEWAY_PORT = 18090

/**
 * Symbiont Core — 依赖注入容器。
 *
 * 持有所有子系统的实例，提供给 Router 和 Interface 层使用。
 * Router 只做消息路由，不直接管理子系统生命周期。
 */
export class SymbiontCore {
  readonly config: SymbiontCoreConfig
  readonly logger: Logger
  readonly broker: CCBroker
  readonly eventStore: EventStore
  readonly sessionManager: SessionManager
  readonly workerManager: WorkerManager
  readonly forkManager: ForkManager
  readonly cronScheduler: CronScheduler
  readonly workspaceManager: WorkspaceManager
  readonly memoryBridge: MemoryBridge
  readonly cognitionEngine: CognitionEngine
  readonly persona: PersonaConfig
  readonly user: UserProfile
  readonly personaRegistry: PersonaRegistry
  readonly memoryDB: MemoryDB
  readonly memoryExtractor: MemoryExtractor
  readonly memoryLifecycle: MemoryLifecycle
  readonly embeddingClient: EmbeddingClient
  readonly settler: Settler
  readonly compiler: Compiler
  readonly sseManager: SSEManager
  private _instanceThrottleTimer: ReturnType<typeof setTimeout> | null = null
  private _connector: Connector
  get connector(): Connector { return this._connector }
  private mcpServer: SiaMcpServerHandle | null = null
  private _gateway: McpGateway | null = null
  private _router: { sendTo: (sessionKey: string, message: string) => Promise<string>; getSession: (key: string) => any; getAllSessions: () => Array<{ sessionKey: string }>; rotateSession: (sessionKey: string, summaryFile?: string) => Promise<void> } | null = null
  private _sendFeishuMessage: ((chatId: string, text: string) => Promise<void>) | null = null

  constructor(config: SymbiontCoreConfig) {
    this.config = config
    this.logger = new Logger(join(config.dataDir, 'logs'))

    this.persona = loadPersona(config.personaPackDir)
    this.user = loadUser(config.userDir)

    this.memoryDB = new MemoryDB(join(config.dataDir, 'memory-sqlite'))
    this.eventStore = new EventStore(this.memoryDB)
    this.sessionManager = new SessionManager(join(config.dataDir, 'sessions'))
    this.broker = new CCBroker({ maxConcurrent: { main: 5, specialist: 10, worker: 20 } })
    this.workspaceManager = new WorkspaceManager(join(config.dataDir, '..'), this.logger)
    this.workerManager = new WorkerManager({
      broker: this.broker,
      eventStore: this.eventStore,
      workspaceManager: this.workspaceManager,
      sessionManager: this.sessionManager,
      persona: this.persona,
      user: this.user,
      db: this.memoryDB,
    })
    this.forkManager = new ForkManager(this.broker, this.eventStore, this.memoryDB)

    this.cronScheduler = new CronScheduler(config.dataDir, {
      logger: this.logger,
      onTrigger: (job: CronJob, runId: string) => {
        handleCronTrigger(this, job, runId)
        this.sseManager.broadcast('cron', {
          jobs: this.cronScheduler.listJobs(),
          running: this.cronScheduler.isRunning,
        })
      },
      onComplete: () => {
        this.sseManager.broadcast('cron', {
          jobs: this.cronScheduler.listJobs(),
          running: this.cronScheduler.isRunning,
        })
      },
    })

    this.memoryBridge = new MemoryBridge(
      join(config.dataDir, 'shared-memory'),
      this.persona.memoryDir,
    )
    this.cognitionEngine = new CognitionEngine(
      this.memoryBridge.getPersonalStore(),
      join(config.dataDir, 'cognition'),
    )

    this.personaRegistry = new PersonaRegistry()
    this.personaRegistry.scan(join(config.dataDir, '..', 'persona-packs'))

    this.embeddingClient = new EmbeddingClient()
    this.settler = new Settler({ logger: this.logger, db: this.memoryDB })
    this.compiler = new Compiler({
      db: this.memoryDB,
      logger: this.logger,
      personaDir: config.personaPackDir,
      ccMemoryDir: join(config.dataDir, 'cc-memory'),
      personaPacksDir: join(config.dataDir, '..', 'persona-packs'),
    })
    this._connector = new Connector({ db: this.memoryDB, embeddingClient: this.embeddingClient, logger: this.logger })
    this.memoryExtractor = new MemoryExtractor(this.memoryDB, this.broker, this.logger, { persona: this.persona, connector: this._connector })
    this.memoryLifecycle = new MemoryLifecycle(this.memoryDB, this.logger, { connector: this._connector })

    this.sseManager = new SSEManager()
    this.sseManager.setOverviewProvider(() => this.getOverviewData())
    this.sseManager.startHeartbeat()

    // 记忆活动回调 → SSE 广播
    this.memoryDB.onActivity = (type, detail) => {
      this.sseManager.broadcast('activity', { type, detail, timestamp: new Date().toISOString() })
    }

    // 接入 CCBroker 事件：实例状态变化、退出时推送
    this.broker.on('instance.state', () => {
      this.sseManager.broadcast('instance', this.getInstancesData())
    })
    this.broker.on('instance.exit', () => {
      setTimeout(() => this.sseManager.broadcast('instance', this.getInstancesData()), 100)
    })
    this.broker.on('instance.created', () => {
      this.sseManager.broadcast('instance', this.getInstancesData())
    })
    // usage / activity 事件频繁，节流 2 秒推送一次
    const throttledInstanceBroadcast = () => {
      if (!this._instanceThrottleTimer) {
        this._instanceThrottleTimer = setTimeout(() => {
          this._instanceThrottleTimer = null
          this.sseManager.broadcast('instance', this.getInstancesData())
        }, 2000)
      }
    }
    this.broker.on('instance.usage', throttledInstanceBroadcast)
    this.broker.on('instance.activity', throttledInstanceBroadcast)
    // Per-instance text streaming → SSE (for web terminal)
    this.broker.on('instance.text', (instanceId: string, text: string) => {
      this.sseManager.broadcast('instance.output', { instanceId, text })
    })
    this.broker.on('instance.stderr', (instanceId: string, text: string) => {
      this.sseManager.broadcast('instance.output', { instanceId, text, stream: 'stderr' })
    })

    this.logger.info('core', 'initialized', { persona: this.persona.manifest?.name })
  }

  /** 注入飞书消息发送能力（由 index.ts 提供） */
  setFeishuSender(sender: (chatId: string, text: string) => Promise<void>): void {
    this._sendFeishuMessage = sender
  }

  /** 发送飞书通知（公开接口，供 cron-handler 等模块使用） */
  async sendFeishuNotification(chatId: string, text: string): Promise<void> {
    if (!this._sendFeishuMessage) {
      this.logger.warn('core', 'feishu-sender-not-set', { chatId })
      return
    }
    await this._sendFeishuMessage(chatId, text)
  }

  /** 设置 Router 引用 */
  setRouter(router: { sendTo: (sessionKey: string, message: string) => Promise<string>; getSession: (key: string) => any; getAllSessions: () => Array<{ sessionKey: string }>; rotateSession: (sessionKey: string, summaryFile?: string) => Promise<void> }): void {
    this._router = router
  }

  /** 获取 Router（供外部模块使用） */
  get router() { return this._router }

  startCron(): void {
    const resetCount = this.cronScheduler.resetCircuitBreakers()
    if (resetCount > 0) {
      this.logger.info('cron', 'reset-circuit-breakers-on-startup', { count: resetCount })
    }
    this.cronScheduler.start()
  }

  /** 启动 MCP Server，返回 URL 供注入到 workspace/.mcp.json */
  async startMcpServer(router: { dispatchWorker: Function; createForkFor: Function; completeForkFor: Function }): Promise<string> {
    const handler = createToolHandlers(this, router as any)
    this.mcpServer = await createSymbiontMcpServer(handler, this.logger)

    // 创建 MCP Gateway 并注册 symbiont-core 后端
    const configDir = join(this.config.dataDir, '..', 'config')
    const sharedCaps = loadSharedCapabilities(configDir)

    const fallback = new LocalFallback(this.config.dataDir)

    this._gateway = new McpGateway({
      port: GATEWAY_PORT,
      configDir,
      fallback,
      getRoleForSession: (sk: string) => {
        // 从 sessionManager 查找 session 的 persona
        const siaSession = this.sessionManager.getLatestBySessionKey(sk)
        if (siaSession) {
          return { role: 'user', persona: siaSession.personaPack }
        }
        // Session 未创建时（CC 刚连接 Gateway），默认用主 persona 的权限
        return { role: 'main', persona: this.persona.manifest?.name ?? 'default' }
      },
      getToolWhitelist: (persona: string) => {
        const pack = this.personaRegistry.get(persona)
        if (pack) return pack.persona.manifest?.mcp?.tools ?? []
        // 主角色用自己的配置
        if (persona === (this.persona.manifest?.name ?? 'default')) {
          return this.persona.manifest?.mcp?.tools ?? []
        }
        // 未知 persona → 空白名单（只有 shared 工具可用）
        return []
      },
      getSharedTools: () => {
        return sharedCaps.mcp.always_available
      },
    })

    // 注册内置后端到 gateway
    this._gateway.registerBackend('symbiont-core', this.mcpServer.url, { builtin: true })

    // 启动 gateway（失败时降级直连模式）
    try {
      await this._gateway.start()
      this.logger.info('core', 'mcp-gateway-started', { port: GATEWAY_PORT, url: this._gateway.url })
      this.workspaceManager.registerMcp('symbiont', this._gateway.url)
      // 加载第三方持久化后端
      this._gateway.loadBackends()
      // 注册启动前排队的内置后端（如飞书）
      for (const pending of this._pendingBackends) {
        this._gateway.registerBackend(pending.name, pending.url, { builtin: true })
        this.logger.info('core', 'gateway-backend-registered-deferred', pending)
      }
      this._pendingBackends = []
      // 刷新所有后端的工具列表（包括第三方 + 内置）
      await this._gateway.refreshToolMap()
      this._gateway.notifyToolsChanged()
      this.logger.info('core', 'gateway-tools-ready', { tools: this._gateway.toolCount })
    } catch (err) {
      this.logger.warn('core', 'mcp-gateway-failed', { port: GATEWAY_PORT, error: String(err) })
      console.error(`[mcp-gateway] failed to start on port ${GATEWAY_PORT}, falling back to direct connection`)
      // 降级：直接注册 symbiont-core MCP URL
      this.workspaceManager.registerMcp('symbiont-core', this.mcpServer.url)
    }
    // Recovery 已移到 index.ts（router ready 之后执行，确保 MCP Gateway 就绪）

    return this.mcpServer.url
  }

  /**
   * 注册额外的后端 MCP server 到 Gateway。
   * 如果 Gateway 还没启动，缓存到 pendingBackends，启动后自动注册。
   */
  private _pendingBackends: Array<{ name: string; url: string }> = []

  registerGatewayBackend(name: string, url: string): void {
    if (!this._gateway || !this._gateway.port) {
      this._pendingBackends.push({ name, url })
      this.logger.info('core', 'gateway-backend-queued', { name, url })
      return
    }
    this._gateway.registerBackend(name, url, { builtin: true })
    this.logger.info('core', 'gateway-backend-registered', { name, url })
  }

  /** 获取 Gateway 实例（供外部查询状态） */
  get gateway(): McpGateway | null { return this._gateway }

  getMcpServerUrl(): string | null {
    return this.mcpServer?.url ?? null
  }

  /** 获取 Gateway URL（CC 实际连接的地址） */
  getGatewayUrl(): string | null {
    return this._gateway?.url ?? null
  }

  /**
   * 获取 MCP Server URL，如果未启动则抛出异常。
   */
  getMcpUrl(): string {
    const url = this.getMcpServerUrl()
    if (!url) throw new Error('MCP Server not started. Call startMcpServer() first.')
    return url
  }

  getOverviewData() {
    const memStats = this.memoryDB.getStats()
    const instances = this.broker.status()
    return {
      uptime: process.uptime(),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      persona: this.persona.manifest?.name ?? 'unknown',
      instances: instances.length,
      instancesActive: instances.filter((i: any) => i.state === 'running').length,
      cron: { running: this.cronScheduler.isRunning, jobs: this.cronScheduler.jobCount },
      settler: this.settler.settleStatus,
      embedding: this.embeddingClient.isAvailable,
      memoryStats: memStats,
    }
  }

  getInstancesData() {
    const instances = this.broker.status()
    return instances.map((inst: any) => {
      const session = inst.sessionKey ? this.sessionManager.getLatestBySessionKey(inst.sessionKey) : undefined
      return { ...inst, symbiontSessionId: session?.sessionId ?? null }
    })
  }

  /**
   * 系统状态快照 — 供 symbiont_system_status MCP 工具和 health endpoint 使用。
   */
  getSystemStatus(): Record<string, unknown> {
    return {
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      broker: this.broker.status(),
      cron: {
        running: this.cronScheduler.isRunning,
        jobs: this.cronScheduler.listJobs().map(j => ({
          name: j.name, schedule: j.schedule, enabled: j.enabled,
          executor: j.executor, handler: j.handler,
        })),
      },
      memory: {
        personal: this.memoryBridge.getPersonalStore().all().length,
        shared: this.memoryBridge.getSharedStore().all().length,
      },
      cognition: {
        pending: this.cognitionEngine.getPending().length,
        approved: this.cognitionEngine.getApproved().length,
      },
      memorySqlite: this.memoryDB.getStats(),
      settler: { status: this.settler.settleStatus },
      mcpServer: this.getMcpServerUrl(),
      mcpGateway: this._gateway ? {
        url: this._gateway.url,
        backends: this._gateway.backendCount,
        tools: this._gateway.toolCount,
        sessions: this._gateway.sessionCount,
      } : null,
      persona: this.persona.manifest?.name ?? 'unknown',
    }
  }

  /**
   * 读取最近 N 行系统日志。
   * 日志文件在 data/logs/symbiont-YYYY-MM-DD.ndjson。
   */
  getSystemLogs(lines = 50): string {
    const logDir = join(this.config.dataDir, 'logs')
    if (!existsSync(logDir)) return '(无日志目录)'

    // 找到最新的日志文件
    const files = readdirSync(logDir)
      .filter(f => f.startsWith('symbiont-') && f.endsWith('.ndjson'))
      .sort()
      .reverse()

    if (files.length === 0) return '(无日志文件)'

    const content = readFileSync(join(logDir, files[0]), 'utf-8')
    const allLines = content.trim().split('\n').filter(Boolean)
    const tail = allLines.slice(-lines)

    return tail.map(line => {
      try {
        const e = JSON.parse(line)
        return `[${e.ts?.slice(11, 19) ?? '?'}][${e.level}][${e.module}] ${e.event}${e.data ? ' ' + JSON.stringify(e.data) : ''}`
      } catch {
        return line
      }
    }).join('\n')
  }

  /**
   * 延迟重启 CC 实例（不重启 Symbiont Core）。
   *
   * 用于加载新的 MCP/skill 配置（不涉及 Symbiont 源码变更的情况）。
   * 延迟 3 秒让当前 MCP 调用完成后再执行。
   */
  reloadInstance(sessionKey: string, reason: string): void {
    this.logger.info('reload', 'scheduled', { sessionKey, reason })

    setTimeout(async () => {
      try {
        const instances = this.broker.status()
          .filter(i => i.role === 'main' && i.state === 'running')

        for (const inst of instances) {
          const ccInstance = this.broker.get(inst.id)
          if (!ccInstance) continue

          this.logger.info('reload', 'restarting', { instanceId: inst.id })
          await ccInstance.process.sleep()
          await ccInstance.process.wake()
          this.logger.info('reload', 'restarted', { instanceId: inst.id })
        }
      } catch (err) {
        this.logger.error('reload', 'failed', { error: (err as Error).message })
      }
    }, 3000)
  }

  /**
   * 延迟重启 Symbiont Core 进程本身。
   *
   * 用于 evolve 合并新代码后、或 symbiont_reload 需要加载新 Symbiont 源码时。
   * 依赖 systemd Restart=always 自动拉起新进程。
   * 延迟 5 秒让当前 MCP/飞书响应先返回。
   */
  scheduleRestart(reason: string): void {
    this.logger.info('restart', 'scheduled', { reason, delayMs: 5000 })

    setTimeout(async () => {
      this.logger.info('restart', 'executing', { reason })
      await this.shutdown()
      process.exit(0)  // systemd Restart=always 会自动拉起
    }, 5000)
  }

  /**
   * 恢复中断的任务 — 重启后调用。
   *
   * 1. 把所有 running 的任务标记为 interrupted（重启意味着它们中断了）
   * 2. worker 任务 → 重新 dispatch
   * 3. fork 任务 → 记录日志 + 移除（不重新创建）
   */
  async recoverInterruptedTasks(): Promise<void> {
    // 1. 标记所有 running → interrupted
    const runningTasks = this.memoryDB.getActiveTasks('running')
    for (const task of runningTasks) {
      this.memoryDB.markTaskInterrupted(task.id)
    }

    this.logger.info('recovery', 'check-interrupted', { markedCount: runningTasks.length })

    // 2. 处理 interrupted 任务
    const interrupted = this.memoryDB.getActiveTasks('interrupted')
    if (interrupted.length === 0) {
      this.logger.info('recovery', 'no-interrupted-tasks')
      return
    }

    this.logger.info('recovery', 'found-interrupted-tasks', { count: interrupted.length })

    for (const task of interrupted) {
      if (task.type === 'worker') {
        this.logger.info('recovery', 'redispatch-worker', { id: task.id, description: task.description })
        this.workerManager.dispatchAsync({
          id: task.id + '-retry',
          description: task.description + ' [重启后重试]',
          parentSessionId: task.parent_session_key ?? 'terminal',
          persona: task.persona ?? undefined,
        }, (result) => {
          this.memoryDB.removeActiveTask(task.id)
          this.logger.info('recovery', 'worker-redispatched', { id: task.id, success: result.success })
        })
      } else if (task.type === 'fork') {
        this.logger.warn('recovery', 'fork-interrupted', { id: task.id, description: task.description })
        this.memoryDB.removeActiveTask(task.id)
      }
    }
  }

  /**
   * 自进化：在 git worktree 隔离环境中修改 Symbiont 源码。
   *
   * 流程：worktree 创建 → 工人在副本中改代码+跑测试 → 通过则合并 → 失败则丢弃
   */
  async evolve(description: string): Promise<{ success: boolean; result: string }> {
    const siaRoot = join(this.config.dataDir, '..')
    const branchName = `evolve-${Date.now()}`
    const worktreeDir = join(siaRoot, '.worktrees', branchName)
    const startTime = Date.now()

    this.logger.info('evolve', 'start', { description, branchName })

    try {
      // 确保是 git 仓库
      if (!existsSync(join(siaRoot, '.git'))) {
        const ret = { success: false, result: 'Symbiont 目录不是 git 仓库，无法使用 worktree 隔离' }
        this.appendEvolveLog({ branchName, description, success: ret.success, result: ret.result, startTime })
        return ret
      }

      // 创建 worktree
      execSync(`git worktree add -b ${branchName} "${worktreeDir}"`, { cwd: siaRoot, stdio: 'pipe' })
      this.logger.info('evolve', 'worktree-created', { dir: worktreeDir })

      // 派工人在 worktree 中执行改动
      const workerResult = await this.workerManager.dispatch({
        id: `evolve-${branchName}`,
        description: [
          `你正在 Symbiont 平台的 git worktree 隔离副本中工作。`,
          `任务：${description}`,
          ``,
          `规则：`,
          `1. 修改代码实现任务`,
          `2. 完成后运行测试：node --experimental-strip-types --test tests/*.test.ts`,
          `3. 测试全部通过才算成功`,
          `4. 用 git add + git commit 提交你的改动`,
          `5. 只输出最终结果：成功/失败 + 简要说明`,
        ].join('\n'),
        cwd: worktreeDir,
        parentSessionId: 'evolve',
      })

      if (workerResult.success) {
        // 测试通过 → 合并到主分支
        try {
          execSync(`git merge ${branchName} --no-edit`, { cwd: siaRoot, stdio: 'pipe' })
          this.logger.info('evolve', 'merged', { branchName })
        } catch (mergeErr) {
          try { execSync(`git merge --abort`, { cwd: siaRoot, stdio: 'pipe' }) } catch { /* no merge in progress */ }
          this.logger.warn('evolve', 'merge-conflict', { branchName })
          const ret = { success: false, result: `工人完成了改动但合并冲突：${(mergeErr as Error).message}` }
          this.appendEvolveLog({ branchName, description, success: ret.success, result: ret.result, startTime })
          return ret
        }
      }

      // 清理 worktree
      try {
        execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: siaRoot, stdio: 'pipe' })
        execSync(`git branch -D ${branchName}`, { cwd: siaRoot, stdio: 'pipe' })
      } catch { /* 清理失败不影响结果 */ }

      // evolve 成功后 5 秒延迟重启 Symbiont Core，让新代码生效
      if (workerResult.success) {
        this.scheduleRestart('evolve 合并了新代码，需要重启加载')
      }

      const ret = {
        success: workerResult.success,
        result: workerResult.result.slice(0, 500),
      }
      this.appendEvolveLog({ branchName, description, success: ret.success, result: ret.result, startTime })
      return ret
    } catch (err) {
      // 清理 worktree（容错）
      try {
        execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: siaRoot, stdio: 'pipe' })
        execSync(`git branch -D ${branchName}`, { cwd: siaRoot, stdio: 'pipe' })
      } catch { /* ignore */ }

      const msg = (err as Error).message
      this.logger.error('evolve', 'failed', { description, error: msg })
      const ret = { success: false, result: msg }
      this.appendEvolveLog({ branchName, description, success: ret.success, result: ret.result, startTime })
      return ret
    }
  }

  /**
   * 追加 evolve 执行日志到 data/evolve-log.json。
   * 只保留最近 50 条记录，防止无限增长。
   */
  private appendEvolveLog(opts: {
    branchName: string
    description: string
    success: boolean
    result: string
    startTime: number
  }): void {
    try {
      const logPath = join(this.config.dataDir, 'evolve-log.json')
      let logs: unknown[] = []
      if (existsSync(logPath)) {
        try {
          const raw = readFileSync(logPath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) logs = parsed
        } catch { /* 文件损坏则重置 */ }
      }

      logs.push({
        timestamp: new Date().toISOString(),
        branch: opts.branchName,
        description: opts.description,
        success: opts.success,
        result: opts.result.slice(0, 500),
        duration: Date.now() - opts.startTime,
      })

      // 只保留最近 50 条
      if (logs.length > 50) {
        logs = logs.slice(-50)
      }

      // 确保目录存在
      const dir = this.config.dataDir
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf-8')
    } catch (err) {
      this.logger.error('evolve', 'log-write-failed', { error: (err as Error).message })
    }
  }

  async shutdown(): Promise<void> {
    this.logger.info('core', 'shutting-down')

    // 1. Stop cron scheduler (prevent new jobs from firing)
    this.cronScheduler.stop()
    if (this._instanceThrottleTimer) {
      clearTimeout(this._instanceThrottleTimer)
      this._instanceThrottleTimer = null
    }
    this.sseManager.shutdown()

    // 2. Stop gateway (stop accepting new requests)
    if (this._gateway) this._gateway.stop()

    // 3. Sleep all sessions
    this.sessionManager.sleepAll()

    // 4. Grace period for in-flight requests
    await new Promise(resolve => setTimeout(resolve, 3000))

    // 5. Kill CC processes
    await this.broker.shutdown()

    // 6. Close MCP server
    if (this.mcpServer) await this.mcpServer.close()

    // 7. Close memory DB
    this.memoryDB.close()

    this.logger.info('core', 'shutdown-complete')
  }

  /** 找到飞书 DM session key（dm:开头的 router session） */
  findDmSessionKey(): string | null {
    if (!this._router) return null
    const sessions = this._router.getAllSessions()
    const dm = sessions.find(s => s.sessionKey.startsWith('dm:'))
    return dm?.sessionKey ?? null
  }
}
