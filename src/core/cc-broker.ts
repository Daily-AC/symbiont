import { EventEmitter } from 'node:events'
import { CCProcess } from './cc-process.ts'
import type { CCMessage, CCProcessOptions, CCProcessState } from './types.ts'

export type CCRole = 'main' | 'specialist' | 'worker'

export interface InstanceActivity {
  ts: string        // 北京时间
  type: string      // 'tool_use' | 'text' | 'result' | 'thinking'
  detail: string    // 如 "Read src/core/broker.ts" 或 "编辑文件..."
}

const MAX_ACTIVITIES = 10

export interface InstanceUsage {
  inputTokens: number
  contextWindow: number
  model?: string
}

export interface CCInstance {
  id: string
  role: CCRole
  process: CCProcess
  createdAt: number
  lastActiveAt: number
  sessionKey?: string
  description?: string
  /** 专员的父实例 ID（只有 specialist 有） */
  parentId?: string
  /** 最近 N 条活动 */
  activities: InstanceActivity[]
  /** 最新 token 用量 */
  usage?: InstanceUsage
}

export interface CCBrokerOptions {
  /** 各角色最大并发数 */
  maxConcurrent?: Partial<Record<CCRole, number>>
  /** 僵尸检测间隔 ms，默认 30s */
  watchdogIntervalMs?: number
}

/**
 * CC 实例池管理器
 *
 * 参考 Team Anya 的 CCBroker：
 * - 按角色管理实例（main / worker）
 * - 按角色并发控制
 * - 僵尸检测
 * - 统一事件总线
 */
export class CCBroker extends EventEmitter {
  private instances: Map<string, CCInstance> = new Map()
  private sessionKeyIndex: Map<string, string> = new Map()  // sessionKey → instanceId
  private maxConcurrent: Record<CCRole, number>
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private watchdogIntervalMs: number

  constructor(options: CCBrokerOptions = {}) {
    super()
    this.maxConcurrent = {
      main: options.maxConcurrent?.main ?? 5,
      specialist: options.maxConcurrent?.specialist ?? 10,
      worker: options.maxConcurrent?.worker ?? 3,
    }
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 30000
    this.startWatchdog()
  }

  /**
   * 创建并启动一个 CC 实例。
   */
  async spawn(role: CCRole, options: CCProcessOptions, description?: string): Promise<CCInstance> {
    // 并发控制
    const currentCount = this.getCountByRole(role)
    const limit = this.maxConcurrent[role]
    if (currentCount >= limit) {
      throw new Error(`Max concurrent ${role} instances (${limit}) reached, current: ${currentCount}`)
    }

    const id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    // 自动选择 CC 通信模式：环境变量 SYMBIONT_CC_MODE=print 强制 print 模式
    const mode = options.mode ?? (process.env.SYMBIONT_CC_MODE === 'print' ? 'print' : 'ws') as 'ws' | 'print'
    const cc = new CCProcess({ ...options, mode })

    const instance: CCInstance = { id, role, process: cc, createdAt: Date.now(), lastActiveAt: Date.now(), description, activities: [] }
    this.instances.set(id, instance)

    // 转发事件
    cc.on('exit', (code: number) => {
      this.emit('instance.exit', id, code)
      // 工人执行完自动清理
      if (role === 'worker') {
        this.instances.delete(id)
      }
    })
    cc.on('error', (err: Error) => this.emit('instance.error', id, err))
    cc.on('rate_limited', (msg: unknown) => this.emit('instance.rate_limited', id, msg))
    cc.on('state-change', (state: CCProcessState) => this.emit('instance.state', id, state))
    cc.on('text', (text: string) => this.emit('instance.text', id, text))
    cc.on('stderr', (text: string) => { this.emit('instance.stderr', instance.id, text) })
    cc.on('late-result', (text: string) => this.emit('instance.late-result', id, text))
    cc.on('usage', (usage: { inputTokens: number; contextWindow: number; model?: string }) => {
      // 直接覆盖（inputTokens 已经是 input + cache_creation + cache_read 的总和，代表当前上下文大小）
      instance.usage = usage
      this.emit('instance.usage', id, usage)
    })

    // 解析 CC 消息流，提取活动信息
    cc.on('message', (msg: CCMessage) => {
      this.trackActivity(instance, msg)
    })

    // 如果有 sessionId，用 connectWithFallback 自动处理 resume 失败
    if (options.sessionId) {
      await cc.connectWithFallback(options.recoveryPrompt)
    } else {
      await cc.connect()
    }
    this.emit('instance.created', id)
    return instance
  }

  /**
   * 按 sessionKey 获取或创建实例。
   * - 已有且存活 → 更新 lastActiveAt，直接返回
   * - 已有且休眠 → 唤醒后返回
   * - 已有但已死 → 清理后重新创建
   * - 达到并发上限 → 驱逐同角色最久未活跃的实例（休眠，不删 sessionKeyIndex）
   * - 不存在 → 创建新实例
   */
  async getOrCreate(sessionKey: string, role: CCRole, options: CCProcessOptions, description?: string): Promise<CCInstance> {
    const existingId = this.sessionKeyIndex.get(sessionKey)

    if (existingId) {
      const existing = this.instances.get(existingId)
      if (existing) {
        // 存活 → 直接返回
        if (existing.process.isAlive()) {
          existing.lastActiveAt = Date.now()
          return existing
        }
        // 休眠 → 唤醒
        if (existing.process.state === 'sleeping') {
          await existing.process.wake()
          if (existing.sessionKey !== sessionKey) {
            this.sessionKeyIndex.delete(existing.sessionKey ?? '')
            existing.sessionKey = sessionKey
            this.sessionKeyIndex.set(sessionKey, existingId)
          }
          existing.lastActiveAt = Date.now()
          return existing
        }
        // 已死 → 清理，fall through 到创建
        await existing.process.dispose()
        this.instances.delete(existingId)
      }
      // instance 已不存在或已清理，移除索引
      this.sessionKeyIndex.delete(sessionKey)
    }

    // 并发控制：如果达到上限，驱逐同角色 LRU
    const currentCount = this.getCountByRole(role)
    const limit = this.maxConcurrent[role]
    if (currentCount >= limit) {
      await this.evictLRU(role)
    }

    // 创建新实例
    const instance = await this.spawn(role, options, description)
    instance.sessionKey = sessionKey
    this.sessionKeyIndex.set(sessionKey, instance.id)
    return instance
  }

  /**
   * 按 sessionKey 查找实例。
   */
  getBySessionKey(sessionKey: string): CCInstance | undefined {
    const id = this.sessionKeyIndex.get(sessionKey)
    if (!id) return undefined
    return this.instances.get(id)
  }

  /**
   * 驱逐指定角色中最久未活跃的实例（休眠它，保留 sessionKeyIndex）。
   */
  private async evictLRU(role: CCRole): Promise<void> {
    const candidates = this.getByRole(role)
      .filter(i => i.process.isAlive() || i.process.state === 'sleeping')
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)

    const victim = candidates[0]
    if (!victim) return

    if (victim.process.isAlive()) {
      await victim.process.sleep()
    }
    // 注意：不删除 sessionKeyIndex，下次 getOrCreate 时可以唤醒
  }

  /**
   * 获取实例。
   */
  get(id: string): CCInstance | undefined {
    return this.instances.get(id)
  }

  /**
   * 获取指定角色的所有实例。
   */
  getByRole(role: CCRole): CCInstance[] {
    return [...this.instances.values()].filter(i => i.role === role)
  }

  /**
   * 获取主 Agent 实例（最多一个）。
   */
  getMain(): CCInstance | undefined {
    return this.getByRole('main')[0]
  }

  /**
   * 获取指定角色的活跃实例数。
   */
  getCountByRole(role: CCRole): number {
    return this.getByRole(role).filter(i => i.process.isAlive() || i.process.state === 'sleeping').length
  }

  /**
   * 向指定实例发送消息。发送前检查健康。
   */
  async sendPrompt(id: string, prompt: string): Promise<{ result: string; sessionId: string | null; blocks: Array<unknown> }> {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Instance ${id} not found`)

    // 僵尸检测
    if (!instance.process.isAlive() && instance.process.state !== 'sleeping') {
      throw new Error(`Instance ${id} is not alive (state=${instance.process.state})`)
    }

    instance.lastActiveAt = Date.now()
    return instance.process.query(prompt)
  }

  /**
   * 休眠指定实例。
   */
  async sleep(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) return
    await instance.process.sleep()
  }

  /**
   * 中断指定 sessionKey 的 CC 实例执行（等同于 ESC）。
   */
  interruptBySessionKey(sessionKey: string): boolean {
    const id = this.sessionKeyIndex.get(sessionKey)
    if (!id) return false
    const instance = this.instances.get(id)
    if (!instance) return false
    return instance.process.interrupt()
  }

  /**
   * 唤醒指定实例。
   */
  async wake(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) return
    await instance.process.wake()
  }

  /**
   * 销毁指定实例。
   */
  async destroy(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) return
    await instance.process.dispose()
    this.instances.delete(id)
    // 清理 sessionKeyIndex
    if (instance.sessionKey) {
      this.sessionKeyIndex.delete(instance.sessionKey)
    }
  }

  /**
   * 销毁所有实例。
   */
  async shutdown(): Promise<void> {
    this.stopWatchdog()
    const ids = [...this.instances.keys()]
    await Promise.all(ids.map(id => this.destroy(id)))
  }

  /**
   * 获取所有实例状态概览。
   */
  status(): Array<{ id: string; role: CCRole; state: CCProcessState; sessionId: string | null; sessionKey?: string; description?: string; parentId?: string; createdAt: number; activities: InstanceActivity[]; usage?: InstanceUsage }> {
    return [...this.instances.values()].map(i => ({
      id: i.id,
      role: i.role,
      state: i.process.state,
      sessionId: i.process.getSessionId(),
      sessionKey: i.sessionKey,
      description: i.description,
      usage: i.usage,
      parentId: i.parentId,
      createdAt: i.createdAt,
      activities: i.activities,
    }))
  }

  // ---- 活动追踪 ----

  private trackActivity(instance: CCInstance, msg: CCMessage): void {
    // result 消息标记为最终回复
    if (msg.type === 'result' && typeof msg.result === 'string' && msg.result.length > 10) {
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T')
      const preview = msg.result.slice(0, 80).replace(/\n/g, ' ')
      this.pushActivity(instance, { ts, type: 'reply', detail: preview })
      return
    }

    const content = msg.message?.content
    if (!content || !Array.isArray(content)) return

    const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T')

    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolName = (block as any).name ?? 'unknown'
        const input = (block as any).input ?? {}
        const detail = this.summarizeToolUse(toolName, input)
        this.pushActivity(instance, { ts, type: 'tool_use', detail })
      } else if (block.type === 'text' && block.text) {
        if (block.text.length > 20) {
          const preview = block.text.slice(0, 80).replace(/\n/g, ' ')
          this.pushActivity(instance, { ts, type: 'text', detail: preview })
        }
      }
    }
  }

  private summarizeToolUse(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case 'Read': return `读 ${input.file_path ?? '?'}`
      case 'Edit': return `编辑 ${input.file_path ?? '?'}`
      case 'Write': return `写 ${input.file_path ?? '?'}`
      case 'Bash': return `执行 ${(input.command as string ?? '').slice(0, 60)}`
      case 'Grep': return `搜索 "${input.pattern ?? '?'}"`
      case 'Glob': return `查找 ${input.pattern ?? '?'}`
      case 'Agent': return `派 agent: ${(input.description as string ?? '').slice(0, 40)}`
      default:
        // MCP 工具
        if (name.startsWith('symbiont_')) return `调用 ${name}`
        if (name.startsWith('feishu_')) return `飞书 ${name.replace('feishu_', '')}`
        return `工具 ${name}`
    }
  }

  private pushActivity(instance: CCInstance, activity: InstanceActivity): void {
    instance.activities.push(activity)
    if (instance.activities.length > MAX_ACTIVITIES) {
      instance.activities.shift()
    }
    this.emit('instance.activity', instance.id)
  }

  // ---- 僵尸检测 ----

  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      for (const [id, instance] of this.instances) {
        const { process: cc } = instance
        // 标记为 running 但实际已死
        if (cc.state === 'running' && !cc.isAlive()) {
          this.emit('instance.zombie', id)
          // Zombie instances can't be recovered — clean up and let upper layer rebuild
          try { cc.cleanup() } catch {}
          this.instances.delete(id)
          this.emit('instance.exit', id, 1, 'zombie-cleaned')
        }
      }
    }, this.watchdogIntervalMs)
    if (this.watchdogTimer && typeof this.watchdogTimer === 'object' && 'unref' in this.watchdogTimer) {
      this.watchdogTimer.unref()
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }
}
