import { CCBroker, type CCInstance } from './cc-broker.ts'
import type { EventStore } from './event-store.ts'
import type { CCProcessOptions } from './types.ts'
import type { MemoryDB } from '../memory/db.ts'

export interface ForkConfig {
  /** 分叉描述（任务/问题域） */
  description: string
  /** 专员的 system prompt（继承主 Agent 的 persona + 追加任务上下文） */
  systemPrompt?: string
  /** 父 Symbiont session ID */
  parentSessionId: string
  /** CC 进程选项 */
  processOptions?: Partial<CCProcessOptions>
  /** Persona Pack 名称（可选，供 Gateway 分配正确的工具白名单） */
  persona?: string
}

export interface ForkSession {
  /** 分叉 ID */
  id: string
  /** 对应的 CCBroker 实例 ID */
  instanceId: string
  /** Symbiont 事件流 session ID */
  eventSessionId: string
  /** 描述 */
  description: string
  /** 父 session ID */
  parentSessionId: string
  /** 状态 */
  state: 'active' | 'completed' | 'abandoned'
  /** 完成摘要 */
  summary?: string
  /** Persona Pack 名称（供 Gateway 分配正确的工具白名单） */
  persona?: string
}

/**
 * 交互分叉管理器（专员）
 *
 * 专员是主 Agent 的分身，处理复杂任务时分叉出来进行深度对话。
 * 完成后生成摘要 + 索引回传主 Agent 的事件流。
 *
 * 规则：
 * - 多个分叉允许，但问题域必须互斥
 * - 树深度 = 2（专员可以派工人但不能再分叉）
 * - 每个分叉是独立的 CC 实例
 */
export class ForkManager {
  private broker: CCBroker
  private eventStore: EventStore
  private db?: MemoryDB
  private forks: Map<string, ForkSession> = new Map()

  constructor(broker: CCBroker, eventStore: EventStore, db?: MemoryDB) {
    this.broker = broker
    this.eventStore = eventStore
    this.db = db
  }

  /**
   * 创建交互分叉（专员）。
   * 分叉出一个独立的 CC 实例，进行深度对话。
   */
  async createFork(config: ForkConfig): Promise<ForkSession> {
    const forkId = `fork-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const eventSessionId = `fork-${forkId}`

    // 在主事件流中记录分叉
    this.eventStore.appendFork(config.parentSessionId, eventSessionId, config.description)

    // 启动专员 CC 实例
    const instance = await this.broker.spawn('specialist', {
      systemPrompt: config.systemPrompt,
      ...config.processOptions,
    }, config.description)

    const fork: ForkSession = {
      id: forkId,
      instanceId: instance.id,
      eventSessionId,
      description: config.description,
      parentSessionId: config.parentSessionId,
      state: 'active',
      persona: config.persona,
    }
    this.forks.set(forkId, fork)
    this.db?.addActiveTask(forkId, 'fork', config.description, undefined, config.parentSessionId)

    return fork
  }

  /**
   * 向专员发送消息（用户 → 专员对话）。
   */
  async sendToFork(forkId: string, message: string): Promise<string> {
    const fork = this.forks.get(forkId)
    if (!fork || fork.state !== 'active') {
      throw new Error(`Fork ${forkId} not found or not active`)
    }

    // 记录到分叉事件流
    this.eventStore.append({
      type: 'chat',
      sessionId: fork.eventSessionId,
      data: { role: 'user', content: message },
    })

    const { result } = await this.broker.sendPrompt(fork.instanceId, message)

    // 记录专员回复
    this.eventStore.append({
      type: 'chat',
      sessionId: fork.eventSessionId,
      data: { role: 'assistant', content: result },
    })

    return result
  }

  /**
   * 完成分叉 — 生成摘要，写回主事件流。
   */
  async completeFork(forkId: string, summary: string): Promise<void> {
    const fork = this.forks.get(forkId)
    if (!fork) throw new Error(`Fork ${forkId} not found`)

    fork.state = 'completed'
    fork.summary = summary

    // 在主事件流中记录合流
    this.eventStore.appendMerge(fork.parentSessionId, fork.eventSessionId, summary)

    // 销毁专员实例
    await this.broker.destroy(fork.instanceId)
    this.db?.removeActiveTask(forkId)
  }

  /**
   * 放弃分叉。
   */
  async abandonFork(forkId: string): Promise<void> {
    const fork = this.forks.get(forkId)
    if (!fork) return

    fork.state = 'abandoned'
    this.eventStore.appendMerge(fork.parentSessionId, fork.eventSessionId, `[放弃] ${fork.description}`)
    await this.broker.destroy(fork.instanceId)
    this.db?.removeActiveTask(forkId)
  }

  /**
   * 获取所有活跃分叉。
   */
  getActiveForks(): ForkSession[] {
    return [...this.forks.values()].filter(f => f.state === 'active')
  }

  /**
   * 获取分叉。
   */
  getFork(forkId: string): ForkSession | undefined {
    return this.forks.get(forkId)
  }

  /**
   * 当前活跃分叉数量。
   */
  getActiveCount(): number {
    return this.getActiveForks().length
  }
}
