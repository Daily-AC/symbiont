import { join } from 'node:path'
import type { CCBroker } from './cc-broker.ts'
import type { EventStore } from './event-store.ts'
import type { WorkerTask, WorkerResult } from './worker.ts'
import type { WorkspaceManager } from './workspace-manager.ts'
import type { SessionManager } from './session.ts'
import type { PersonaConfig } from '../persona/loader.ts'
import type { UserProfile } from '../user/loader.ts'
import type { MemoryDB } from '../memory/db.ts'

export interface WorkerManagerDeps {
  broker: CCBroker
  eventStore: EventStore
  workspaceManager: WorkspaceManager
  sessionManager: SessionManager
  persona: PersonaConfig
  user: UserProfile
  db?: MemoryDB
}

/**
 * 工人管理器 — 使用 SymbiontCore 注入的 Broker 和 EventStore。
 */
export class WorkerManager {
  private broker: CCBroker
  private eventStore: EventStore
  private workspaceManager: WorkspaceManager
  private sessionManager: SessionManager
  private persona: PersonaConfig
  private user: UserProfile
  private db?: MemoryDB

  constructor(deps: WorkerManagerDeps) {
    this.broker = deps.broker
    this.eventStore = deps.eventStore
    this.workspaceManager = deps.workspaceManager
    this.sessionManager = deps.sessionManager
    this.persona = deps.persona
    this.user = deps.user
    this.db = deps.db
  }

  async dispatch(task: WorkerTask): Promise<WorkerResult> {
    const start = Date.now()
    const workerSessionId = `worker-${task.id}`

    this.eventStore.appendFork(task.parentSessionId, workerSessionId, task.description)
    this.db?.addActiveTask(task.id, 'worker', task.description, task.persona, task.parentSessionId)

    try {
      // 为 worker 创建隔离工作区（含 .mcp.json），确保 worker CC 能连 MCP Gateway
      const spawnOptions: Parameters<CCBroker['spawn']>[1] = {
        systemPrompt: task.systemPrompt ?? 'You are a worker agent. Complete the assigned task concisely.',
        cwd: task.cwd,
        idleTimeoutMs: 0,
      }

      if (this.workspaceManager) {
        const workerPersona = task.persona
          ? { ...this.persona, manifest: { ...this.persona.manifest, name: task.persona } as any }
          : this.persona
        const ws = this.workspaceManager.ensure(
          workerSessionId,
          workerPersona,
          this.user,
          task.description,
        )
        spawnOptions.cwd = ws.dir
        spawnOptions.mcpConfigFiles = [join(ws.dir, '.mcp.json')]
      }

      // 注册 worker session 到 sessionManager，这样 Gateway 能通过 sessionKey 识别 persona
      if (this.sessionManager) {
        const personaName = task.persona ?? this.persona.manifest?.name ?? 'default'
        this.sessionManager.create(personaName, workerSessionId)
      }

      const instance = await this.broker.spawn('worker', spawnOptions, task.description)

      const { result } = await this.broker.sendPrompt(instance.id, task.description)

      this.eventStore.append({
        type: 'chat',
        sessionId: workerSessionId,
        data: { role: 'assistant', content: result },
      })

      const workerResult: WorkerResult = {
        taskId: task.id,
        success: true,
        result,
        sessionId: instance.process.getSessionId(),
        duration: Date.now() - start,
      }

      this.eventStore.appendMerge(task.parentSessionId, workerSessionId, result.slice(0, 200))
      await this.broker.destroy(instance.id)
      this.db?.removeActiveTask(task.id)

      return workerResult
    } catch (err) {
      const errorMsg = (err as Error).message
      this.eventStore.appendMerge(task.parentSessionId, workerSessionId, `[失败] ${errorMsg.slice(0, 150)}`)
      this.db?.removeActiveTask(task.id)
      return {
        taskId: task.id,
        success: false,
        result: errorMsg,
        sessionId: null,
        duration: Date.now() - start,
      }
    }
  }

  /**
   * 异步派遣：立刻返回 taskId，工人在后台跑，完成后调 onComplete。
   */
  dispatchAsync(task: WorkerTask, onComplete: (result: WorkerResult) => void): string {
    this.dispatch(task).then(onComplete).catch(err => {
      onComplete({
        taskId: task.id,
        success: false,
        result: (err as Error).message,
        sessionId: null,
        duration: 0,
      })
    })
    return task.id
  }

  getActiveCount(): number {
    return this.broker.getByRole('worker').length
  }

  async shutdown(): Promise<void> {
    // Broker 生命周期由 SymbiontCore 管理，这里不 shutdown
  }
}
