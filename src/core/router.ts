import type { SymbiontCore } from './symbiont-core.ts'
import type { ForkSession } from './fork-manager.ts'
import type { WorkerTask, WorkerResult } from './worker.ts'
import type { ExperienceCard } from '../memory/types.ts'
import type { TimelineEntry, SiaEvent } from './event-store.ts'
import { isWritable } from '../persona/manifest.ts'
import { recall } from '../memory/recall.ts'

export interface RouterSession {
  sessionKey: string
  instanceId: string
  symbiontSessionId: string
  activeForkId: string | null
  turnCount: number
}

/**
 * Router — 消息路由（多会话版）。
 *
 * 每个 sessionKey 对应一个独立的 CC 实例和 Symbiont 会话。
 * 所有会话按需创建，调用方需显式传递 sessionKey。
 */
export class Router {
  static TERMINAL_KEY = 'terminal'

  private core: SymbiontCore
  private sessions: Map<string, RouterSession> = new Map()
  private textHandlers: Map<string, (text: string) => void> = new Map()
  private pushHandlers: Map<string, (text: string) => void> = new Map()
  private listeners: Map<string, { event: string; handler: (...args: any[]) => void; instanceId: string }> = new Map()
  private topicCreator?: (parentSessionKey: string, title: string) => Promise<{ sessionKey: string; threadId: string }>
  private rotatingKeys: Set<string> = new Set()
  private rotateWaiters: Map<string, Array<() => void>> = new Map()
  // NOTE: 并发多会话时有竞态风险（MCP 共享，无法区分调用方）。单用户场景下可接受。
  private lastActiveSessionKey: string = Router.TERMINAL_KEY
  private cognitionCheckInterval: number = 10
  private _ready = false
  private _readyResolvers: Array<() => void> = []

  // broker 级别的 listener 引用，用于 stop() 时清理
  private usageHandler: ((instanceId: string, usage: { inputTokens: number; contextWindow: number }) => void) | null = null
  private lateResultHandler: ((instanceId: string, text: string) => void) | null = null

  get isReady(): boolean { return this._ready }

  async waitForReady(timeoutMs = 30000): Promise<void> {
    if (this._ready) return
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Router ready timeout')), timeoutMs)
      this._readyResolvers.push(() => { clearTimeout(timer); resolve() })
    })
  }

  private markReady(): void {
    this._ready = true
    this._readyResolvers.forEach(r => r())
    this._readyResolvers = []
  }

  constructor(core: SymbiontCore) {
    this.core = core
    this.setupUsageListener()
    this.setupLateResultListener()
  }

  /**
   * 监听 CC 实例的 late-result 事件（同一 prompt 中后续的 result），
   * 通过 pushHandler 路由到飞书。
   */
  private setupLateResultListener(): void {
    this.lateResultHandler = (instanceId: string, text: string) => {
      const sessionKey = this.findSessionKeyByInstanceId(instanceId)
      if (!sessionKey) return
      const pushHandler = this.pushHandlers.get(sessionKey)
      if (pushHandler) {
        pushHandler(text)
      }
      // 也记录到 EventStore
      const session = this.sessions.get(sessionKey)
      if (session) {
        this.core.eventStore.append({
          type: 'chat', sessionId: session.symbiontSessionId,
          data: { role: 'assistant', content: text },
        })
        this.core.sseManager.broadcast('conversation', {
          sessionId: session.symbiontSessionId,
          message: { role: 'assistant', content: text },
        })
      }
    }
    this.core.broker.on('instance.late-result', this.lateResultHandler)
  }

  /**
   * 监听 CC 实例的 usage 事件，喂给 Settler 实现自动上下文沉淀。
   */
  private setupUsageListener(): void {
    this.usageHandler = (instanceId: string, usage: { inputTokens: number; contextWindow: number }) => {
      // 从 instanceId 反查 sessionKey
      const sessionKey = this.findSessionKeyByInstanceId(instanceId)
      if (!sessionKey) return

      this.core.settler.recordUsage(sessionKey, usage.inputTokens, usage.contextWindow)
      const pct = this.core.settler.getUsagePercent(sessionKey)
      this.core.logger.info('settler', 'usage-recorded', { sessionKey, inputTokens: usage.inputTokens, contextWindow: usage.contextWindow, usagePercent: pct })

      // 检查是否需要沉淀
      if (this.core.settler.shouldSettle(sessionKey)) {
        const settlePrompt = this.core.settler.beginSettle(sessionKey)
        this.core.logger.info('settler', 'auto-settle-triggered', { sessionKey, usagePercent: pct })

        // 沉淀流程：注入 prompt → CC 执行记忆整理 → CC 调 symbiont_settle_done(summary) 触发 rotate
        // summary 由 CC 通过 symbiont_settle_done 的参数直接传入，不再依赖 sendTo 返回值
        this.sendTo(sessionKey, settlePrompt).then(() => {
          this.core.logger.info('settler', 'auto-settle-prompt-sent', { sessionKey })
        }).catch(err => {
          this.core.logger.error('settler', 'auto-settle-failed', { sessionKey, error: String(err) })
          this.core.settler.reset(sessionKey)
        })
      }
    }
    this.core.broker.on('instance.usage', this.usageHandler)
  }

  /**
   * 从 instanceId 反查 sessionKey。
   */
  private findSessionKeyByInstanceId(instanceId: string): string | null {
    for (const [sessionKey, session] of this.sessions) {
      if (session.instanceId === instanceId) return sessionKey
    }
    return null
  }

  setTopicCreator(fn: (parentSessionKey: string, title: string) => Promise<{ sessionKey: string; threadId: string }>): void {
    this.topicCreator = fn
  }

  // ---- 多会话核心 ----

  /**
   * 获取或创建指定 sessionKey 的会话。
   */
  async getOrCreateSession(sessionKey: string, options?: { systemPrompt?: string; description?: string }): Promise<RouterSession> {
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      // 确保 CC 实例还活着（getOrCreate 会处理唤醒）
      const instance = await this.core.broker.getOrCreate(sessionKey, 'main', {
        cwd: this.getWorkspaceDir(sessionKey),
      }, options?.description)
      existing.instanceId = instance.id
      return existing
    }

    // 启动 MCP Server（如果还没启动）
    const mcpUrl = this.core.getMcpServerUrl() ?? await this.core.startMcpServer(this)

    // 每个 session 有独立隔离工作区（借鉴 Team Anya）
    // CLAUDE.md 每次强制覆盖，.mcp.json 补缺，共享目录 symlink
    const ws = this.core.workspaceManager.ensure(
      sessionKey,
      this.core.persona,
      this.core.user,
      options?.description,
    )
    const workspaceDir = ws.dir

    let symbiontSessionId: string
    let instance: Awaited<ReturnType<typeof this.core.broker.getOrCreate>>

    const latestSession = this.core.sessionManager.getLatestBySessionKey(sessionKey)
      ?? this.core.sessionManager.getLatest()
    const { join } = await import('node:path')
    const mcpConfigFiles = [join(workspaceDir, '.mcp.json')]

    if (latestSession && (latestSession.state === 'sleeping' || latestSession.state === 'active')) {
      // 恢复 sleeping/active session — active 可能是崩溃后遗留的
      this.core.sessionManager.wake(latestSession.sessionId)
      // 更新 sessionKey（fallback 恢复时可能 key 不匹配，如 terminal → dm:xxx）
      this.core.sessionManager.updateSessionKey(latestSession.sessionId, sessionKey)
      symbiontSessionId = latestSession.sessionId

      // 从事件流生成 recoveryPrompt（resume 失败或无 ccSessionId 时用来重建上下文）
      const events = this.core.eventStore.getLatestSummary(latestSession.sessionId, 10)
      const recoveryPrompt = events.length > 0
        ? `[上下文恢复] 你正在继续之前的对话。最近的对话摘要：\n${events.map(e => `- ${e.data?.role ?? e.type}: ${String(e.data?.content ?? e.data?.summary ?? '').slice(0, 100)}`).join('\n')}`
        : undefined

      instance = await this.core.broker.getOrCreate(sessionKey, 'main', {
        cwd: workspaceDir,
        sessionId: latestSession.ccSessionId ?? undefined,  // null → undefined，不传无效 sessionId
        mcpConfigFiles,
        recoveryPrompt,
      }, options?.description)
    } else {
      const newSession = this.core.sessionManager.create(this.core.persona.manifest?.name ?? 'default', sessionKey)
      symbiontSessionId = newSession.sessionId
      instance = await this.core.broker.getOrCreate(sessionKey, 'main', {
        cwd: workspaceDir,
        mcpConfigFiles,
      }, options?.description)
    }

    // 监听 text 事件（缓存 listener 引用，防止重复注册泄漏）
    // 当实例 ID 变化时（如崩溃恢复后重建），移除旧 listener 并重新注册
    const listenerKey = `text:${sessionKey}`
    const existingListener = this.listeners.get(listenerKey)
    if (!existingListener || existingListener.instanceId !== instance.id) {
      if (existingListener) {
        this.core.broker.off(existingListener.event, existingListener.handler)
      }
      const handler = (id: string, text: string) => {
        if (id === instance.id) {
          const textHandler = this.textHandlers.get(sessionKey)
          textHandler?.(text)
        }
      }
      this.core.broker.on('instance.text', handler)
      this.listeners.set(listenerKey, { event: 'instance.text', handler, instanceId: instance.id })
    }

    const session: RouterSession = {
      sessionKey,
      instanceId: instance.id,
      symbiontSessionId,
      activeForkId: null,
      turnCount: 0,
    }
    this.sessions.set(sessionKey, session)

    if (latestSession && (latestSession.state === 'sleeping' || latestSession.state === 'active')) {
      this.core.logger.info('router', 'session-recovered', { sessionKey, symbiontSessionId, previousCcSessionId: latestSession.ccSessionId, state: latestSession.state, instanceId: instance.id })
    } else {
      this.core.logger.info('router', 'session-created', { sessionKey, symbiontSessionId, instanceId: instance.id })
    }
    return session
  }

  private getWorkspaceDir(sessionKey: string): string {
    if (sessionKey === Router.TERMINAL_KEY) {
      const ws = this.core.workspaceManager.get('main')
      return ws?.dir ?? process.cwd()
    }
    const ws = this.core.workspaceManager.get(`session-${sessionKey}`)
    return ws?.dir ?? process.cwd()
  }

  /**
   * 向指定会话发送消息。
   */
  async sendTo(sessionKey: string, userMessage: string, options?: { description?: string; _skipRotateWait?: boolean }): Promise<string> {
    // 如果正在 rotate，等待完成再发送（防止并发创建第二个实例）
    if (!options?._skipRotateWait && this.rotatingKeys.has(sessionKey)) {
      this.core.logger.info('router', 'sendTo-waiting-rotate', { sessionKey })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rotate wait timeout (30s)')), 30_000)
        const waiters = this.rotateWaiters.get(sessionKey) ?? []
        waiters.push(() => { clearTimeout(timer); resolve() })
        this.rotateWaiters.set(sessionKey, waiters)
      })
    }
    this.lastActiveSessionKey = sessionKey
    const session = await this.getOrCreateSession(sessionKey, options)

    // 分叉路由
    if (session.activeForkId) {
      try {
        return await this.core.forkManager.sendToFork(session.activeForkId, userMessage)
      } catch {
        session.activeForkId = null
      }
    }

    // 获取当前 CC session ID（用于事件追溯链路）
    const ccInstance = this.core.broker.get(session.instanceId)
    const ccSessionId = ccInstance?.process.getSessionId() ?? null

    this.core.eventStore.append({
      type: 'chat', sessionId: session.symbiontSessionId,
      data: { role: 'user', content: userMessage, ccSessionId },
    })
    this.core.sseManager.broadcast('conversation', {
      sessionId: session.symbiontSessionId,
      message: { role: 'user', content: userMessage },
    })

    try {
      // Auto-inject relevant memories into prompt (3-path: semantic + keyword + graph)
      const recallResult = await recall(this.core.memoryDB, userMessage, {
        limit: 5,
        embeddingClient: this.core.embeddingClient,
      })
      const enrichedMessage = recallResult.prompt + userMessage

      const { result, sessionId: newCcSessionId, blocks } = await this.core.broker.sendPrompt(session.instanceId, enrichedMessage)

      if (newCcSessionId) {
        this.core.sessionManager.updateCCSessionId(session.symbiontSessionId, newCcSessionId)
      }

      this.core.eventStore.append({
        type: 'chat', sessionId: session.symbiontSessionId,
        data: { role: 'assistant', content: result, blocks, ccSessionId: newCcSessionId ?? ccSessionId },
      })
      this.core.sseManager.broadcast('conversation', {
        sessionId: session.symbiontSessionId,
        message: { role: 'assistant', content: result, blocks },
      })

      // Record turns for memory extraction
      this.core.memoryExtractor.recordTurn('user', userMessage, session.symbiontSessionId)
      this.core.memoryExtractor.recordTurn('assistant', result, session.symbiontSessionId)

      session.turnCount++
      if (session.turnCount % this.cognitionCheckInterval === 0) {
        const tags = this.core.cognitionEngine.scan()
        if (tags.length > 0) {
          this.core.logger.info('cognition', 'candidates-found', { tags, sessionKey })
        }
      }

      this.core.logger.info('router', 'query-done', { sessionKey, turns: session.turnCount })
      return result
    } catch (err) {
      const msg = (err as Error).message
      this.core.logger.error('router', 'query-failed', { sessionKey, error: msg })
      return `[错误] ${msg}`
    }
  }

  /**
   * 上下文轮换：销毁旧 CC 实例，创建新 session，把上次总结注入新上下文。
   */
  async rotateSession(sessionKey: string, summaryFile?: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) return
    if (this.rotatingKeys.has(sessionKey)) return // 防止重复 rotate

    this.rotatingKeys.add(sessionKey)

    this.core.logger.info('router', 'rotate-begin', { sessionKey, oldSiaSession: session.symbiontSessionId, summaryFile })

    try {
      // 1. 标记旧 session 为 ended（不是 sleeping，防止被恢复）
      this.core.sessionManager.end(session.symbiontSessionId)

      // 2. 销毁旧 CC 实例
      try {
        await this.core.broker.destroy(session.instanceId)
      } catch { /* 实例可能已停止 */ }

      // 3. 从 sessions map 中移除旧会话
      this.sessions.delete(sessionKey)

      // 4. 等待 3 秒让 CC 进程资源释放干净
      await new Promise(r => setTimeout(r, 3000))

      // 5. 注入总结文件路径到新会话（会触发 getOrCreateSession 创建新实例）
      const recoveryMessage = summaryFile
        ? `[上下文已切换] 上一轮会话的总结文件在: ${summaryFile}\n请先读取该文件了解上下文，然后基于此继续工作。\n\n已准备好接收新消息。`
        : `[上下文已切换] 上一轮会话没有留下总结文件。已准备好接收新消息。`
      const reply = await this.sendTo(sessionKey, recoveryMessage, { _skipRotateWait: true })
      this.core.logger.info('router', 'rotate-complete', { sessionKey, newSiaSession: this.sessions.get(sessionKey)?.symbiontSessionId })

      // 推送到飞书等外部渠道
      const pushHandler = this.pushHandlers.get(sessionKey)
      if (pushHandler) {
        pushHandler(`✅ 上下文已切换（旧会话已沉淀）。\n\n${reply}`)
      }
    } catch (err) {
      this.core.logger.error('router', 'rotate-failed', { sessionKey, error: String(err) })
    } finally {
      // 释放锁，唤醒等待的 sendTo
      this.rotatingKeys.delete(sessionKey)
      const waiters = this.rotateWaiters.get(sessionKey)
      if (waiters) {
        this.rotateWaiters.delete(sessionKey)
        waiters.forEach(resolve => resolve())
      }
    }
  }

  /**
   * 设置指定会话的文本流处理器。
   */
  setTextHandlerFor(sessionKey: string, handler: (text: string) => void): void {
    this.textHandlers.set(sessionKey, handler)
  }

  /**
   * 移除指定会话的文本流处理器。
   */
  removeTextHandlerFor(sessionKey: string): void {
    this.textHandlers.delete(sessionKey)
  }

  setPushHandlerFor(sessionKey: string, handler: (text: string) => void): void {
    this.pushHandlers.set(sessionKey, handler)
  }

  removePushHandlerFor(sessionKey: string): void {
    this.pushHandlers.delete(sessionKey)
  }

  /**
   * 中断指定 sessionKey 的 CC 实例执行（等同于按 ESC）。
   */
  interrupt(sessionKey: string): boolean {
    return this.core.broker.interruptBySessionKey(sessionKey)
  }

  /**
   * 为指定会话创建分叉。
   * 当 options.createTopic 为 true 且已注册 topicCreator 时，会在飞书中创建话题，
   * fork 绑定到话题 session，不影响主对话。
   */
  async createForkFor(sessionKey: string, description: string, options?: { systemPrompt?: string; createTopic?: boolean; persona?: string }): Promise<ForkSession> {
    const session = await this.getOrCreateSession(sessionKey)

    // Resolve persona for fork: explicit name > auto-match > none
    let forkSystemPrompt = options?.systemPrompt
    const resolvedPersonaName = options?.persona
      ?? this.core.personaRegistry.match(description)?.name
      ?? undefined
    if (!forkSystemPrompt && (options?.persona || description)) {
      const pack = options?.persona
        ? this.core.personaRegistry.get(options.persona)
        : this.core.personaRegistry.match(description)
      if (pack) {
        forkSystemPrompt = pack.persona.soulPrompt
      }
    }

    if (options?.createTopic && this.topicCreator) {
      const topic = await this.topicCreator(sessionKey, description)
      const targetSessionKey = topic.sessionKey
      const topicSession = await this.getOrCreateSession(targetSessionKey, { description: `专员话题: ${description}` })
      const forkId = `fork-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const ws = this.core.workspaceManager.ensure(targetSessionKey, this.core.persona, this.core.user, description)

      // Append topic routing info so the specialist sends messages to the thread
      const topicRoutingHint = `\n\n你在飞书话题中工作。发消息时请使用 session_key="${targetSessionKey}"，这样消息会发到话题里而不是私聊。`
      forkSystemPrompt = (forkSystemPrompt ?? '') + topicRoutingHint

      const fork = await this.core.forkManager.createFork({
        description,
        systemPrompt: forkSystemPrompt,
        parentSessionId: session.symbiontSessionId,
        processOptions: { cwd: ws.dir },
        persona: resolvedPersonaName,
      })
      topicSession.activeForkId = fork.id
      this.core.logger.info('router', 'fork-created', { sessionKey, targetSessionKey, forkId: fork.id, description, persona: resolvedPersonaName })
      return fork
    }

    // 原有逻辑（不创建话题时，fork 绑到当前 session）
    const forkId = `fork-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const ws = this.core.workspaceManager.ensure(forkId, this.core.persona, this.core.user, description)
    const fork = await this.core.forkManager.createFork({
      description,
      systemPrompt: forkSystemPrompt,
      parentSessionId: session.symbiontSessionId,
      processOptions: { cwd: ws.dir },
      persona: resolvedPersonaName,
    })
    session.activeForkId = fork.id

    // 注册非话题 fork 到 SessionManager，让 Gateway 能分配正确的工具白名单
    if (resolvedPersonaName) {
      this.core.sessionManager.create(resolvedPersonaName, `fork:${fork.id}`)
    }

    this.core.logger.info('router', 'fork-created', { sessionKey, forkId: fork.id, description, persona: resolvedPersonaName })
    return fork
  }

  /**
   * 完成指定会话的分叉。
   * 如果是话题 fork，把摘要推回父会话。
   */
  async completeForkFor(sessionKey: string, summary: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session?.activeForkId) return
    const fork = this.core.forkManager.getFork(session.activeForkId)
    await this.core.forkManager.completeFork(session.activeForkId, summary)
    this.core.logger.info('router', 'fork-completed', { sessionKey, forkId: session.activeForkId })

    session.activeForkId = null

    // 如果是话题 fork，把摘要推回父会话
    if (fork?.parentSessionId) {
      for (const [parentKey, parentSession] of this.sessions.entries()) {
        if (parentSession.symbiontSessionId === fork.parentSessionId) {
          const pushHandler = this.pushHandlers.get(parentKey)
          if (pushHandler) {
            pushHandler(`📋 **专员完成**: ${fork.description}\n\n${summary}`)
          }
          break
        }
      }
    }
  }

  async initialize(): Promise<void> {
    // 不再预创建 terminal 实例 — 所有会话按需创建（飞书消息到达时）
    // 但 MCP Gateway 需要提前启动，否则 CC 实例没有工具可用
    await this.core.startMcpServer(this)
    this.core.logger.info('router', 'initialized', { mode: 'on-demand' })
    this.markReady()
  }

  // ---- 工人 ----

  async dispatchWorker(description: string, systemPrompt?: string, isAsync?: boolean, persona?: string, callerSessionKeyOverride?: string): Promise<string> {
    const callerSessionKey = callerSessionKeyOverride ?? this.lastActiveSessionKey
    const session = this.sessions.get(callerSessionKey)
    const parentSessionId = session?.symbiontSessionId ?? 'unknown'

    // Persona resolution: explicit name > auto-match > default
    if (!systemPrompt) {
      const pack = persona
        ? this.core.personaRegistry.get(persona)
        : this.core.personaRegistry.match(description)
      if (pack) {
        systemPrompt = pack.persona.soulPrompt
      }
    }

    // Resolve persona name for worker session registration (Gateway needs this to assign correct tools)
    const resolvedPersona = persona
      ?? this.core.personaRegistry.match(description)?.name
      ?? this.core.persona.manifest?.name

    const task: WorkerTask = {
      id: `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description, systemPrompt,
      parentSessionId,
      persona: resolvedPersona,
    }

    if (isAsync) {
      this.core.workerManager.dispatchAsync(task, (result) => {
        this.injectWorkerResult(callerSessionKey, task, result)
      })
      return `工人已异步派遣，任务ID: ${task.id}。完成后会回来汇报。`
    }

    // 同步 worker 加 5 分钟超时，防止阻塞主 CC
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('工人执行超时（5 分钟）')), 5 * 60 * 1000)
    )
    const result = await Promise.race([this.core.workerManager.dispatch(task), timeout])
    return result.success ? result.result : `[工人失败] ${result.result}`
  }

  /**
   * 工人完成后，将结果注入主 CC 实例的对话流，审核后推送给用户。
   */
  private async injectWorkerResult(sessionKey: string, task: WorkerTask, result: WorkerResult): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) {
      this.core.logger.warn('router', 'inject-no-session', { sessionKey, taskId: task.id })
      return
    }

    const truncatedResult = result.result.slice(0, 2000)
    const prompt = result.success
      ? `[工人汇报] 任务「${task.description.slice(0, 50)}」(ID: ${task.id}) 已完成，耗时 ${Math.round((result.duration ?? 0) / 1000)}秒。\n\n结果：\n${truncatedResult}\n\nReview and send to user.`
      : `[工人汇报] 任务「${task.description.slice(0, 50)}」(ID: ${task.id}) 失败。\n错误：${truncatedResult}\n\nPlease notify the user.`

    try {
      const { result: ccReply } = await this.core.broker.sendPrompt(session.instanceId, prompt)

      this.core.eventStore.append({
        type: 'chat', sessionId: session.symbiontSessionId,
        data: { role: 'assistant', content: ccReply },
      })

      const pushHandler = this.pushHandlers.get(sessionKey)
      if (pushHandler) {
        pushHandler(ccReply)
      }

      this.core.logger.info('router', 'worker-result-injected', { sessionKey, taskId: task.id })
    } catch (err) {
      this.core.logger.error('router', 'inject-failed', { sessionKey, taskId: task.id, error: (err as Error).message })
    }
  }

  // ---- 记忆 ----

  addMemoryCard(card: Omit<ExperienceCard, 'id' | 'createdAt' | 'lastUsed'>, sessionKey: string): ExperienceCard {
    const session = this.sessions.get(sessionKey)
    const currentSessionId = session?.symbiontSessionId ?? null

    if (currentSessionId && (!card.source || card.source.length === 0)) {
      const events = this.core.eventStore.read(currentSessionId)
      const lastIdx = events.length - 1
      card = { ...card, source: [`event://${currentSessionId}/#${Math.max(0, lastIdx - 5)}-#${lastIdx}`] }
    }
    const saved = this.core.memoryBridge.add(card)
    if (currentSessionId) {
      this.core.eventStore.append({
        type: 'memory', sessionId: currentSessionId,
        data: { cardId: saved.id, content: saved.content, tags: saved.tags },
      })
    }
    return saved
  }

  addSharedMemoryCard(card: Omit<ExperienceCard, 'id' | 'createdAt' | 'lastUsed'>): ExperienceCard {
    return this.core.memoryBridge.add(card, 'shared')
  }

  // ---- 权限 ----

  checkPersonaWritable(relativePath: string): boolean {
    if (!this.core.persona.manifest) return true
    return isWritable(this.core.persona.manifest, relativePath)
  }

  // ---- 事件回溯（支持 sessionKey 参数） ----

  getTimeline(sessionKey: string = Router.TERMINAL_KEY): TimelineEntry[] {
    const session = this.sessions.get(sessionKey)
    if (!session) return []
    return this.core.eventStore.getTimeline(session.symbiontSessionId)
  }

  getChildEvents(childSessionId: string, sessionKey: string = Router.TERMINAL_KEY): SiaEvent[] {
    const session = this.sessions.get(sessionKey)
    if (!session) return []
    return this.core.eventStore.getChildEvents(session.symbiontSessionId, childSessionId)
  }

  resolveCardSource(card: ExperienceCard): SiaEvent[] {
    if (!card.source || card.source.length === 0) return []
    return card.source.flatMap(uri => this.core.eventStore.resolveSource(uri))
  }

  // ---- 状态 ----

  getBrokerStatus() { return this.core.broker.status() }

  getSession(sessionKey: string): RouterSession | undefined {
    return this.sessions.get(sessionKey)
  }

  getAllSessions(): RouterSession[] {
    return [...this.sessions.values()]
  }

  async stop(): Promise<void> {
    // 休眠所有会话
    for (const session of this.sessions.values()) {
      this.core.sessionManager.sleep(session.symbiontSessionId, session.sessionKey)
      // 休眠 CC 实例
      try {
        await this.core.broker.sleep(session.instanceId)
      } catch {
        // 实例可能已经停止
      }
    }
    // 清理 broker 级别的全局 listener（构造函数中注册的）
    if (this.usageHandler) {
      this.core.broker.off('instance.usage', this.usageHandler)
      this.usageHandler = null
    }
    if (this.lateResultHandler) {
      this.core.broker.off('instance.late-result', this.lateResultHandler)
      this.lateResultHandler = null
    }
    // 清理 per-session 事件监听器
    for (const [, { event, handler }] of this.listeners) {
      this.core.broker.off(event, handler)
    }
    this.listeners.clear()
    this.textHandlers.clear()
    this.pushHandlers.clear()
    this.sessions.clear()

    await this.core.shutdown()
    this.core.logger.info('router', 'stopped', { sessions: 0 })
  }
}
