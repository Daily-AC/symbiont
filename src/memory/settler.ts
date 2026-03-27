import type { MemoryDB } from './db.ts'

export interface SettlerDeps {
  logger: { info: (mod: string, event: string, meta?: any) => void; warn: (mod: string, event: string, meta?: any) => void; error: (mod: string, event: string, meta?: any) => void }
  db: MemoryDB
}

export type SettleStatus = 'idle' | 'in_progress'

/**
 * Settler — 上下文沉淀调度器。
 *
 * 核心逻辑：
 * 1. 每次 CC 返回 usage 时 recordUsage
 * 2. usage >= threshold 时 shouldSettle 返回 true
 * 3. 调用方（router 或 MCP）调 beginSettle 获取 prompt
 * 4. CC 执行完 prompt 后调用方调 completeSettle
 * 5. completeSettle 重置状态，允许下次再触发
 *
 * 防卡死：
 * - beginSettle 启动 5 分钟超时计时器
 * - 超时后自动 reset，恢复可触发状态
 * - 不使用 'done' 状态——沉淀完成后回到 idle，允许再次触发
 */
export class Settler {
  private deps: SettlerDeps
  private threshold: number
  private sessionStatus: Map<string, SettleStatus> = new Map()
  private tokenUsage: Map<string, { current: number; total: number }> = new Map()
  private timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private lastSettleTime: Map<string, number> = new Map()  // 冷却期：上次沉淀完成时间

  private static COOLDOWN_MS = 10 * 60 * 1000  // 10 分钟冷却

  constructor(deps: SettlerDeps, options?: { threshold?: number }) {
    this.deps = deps
    this.threshold = options?.threshold ?? 0.40
  }

  get settleStatus(): SettleStatus {
    for (const s of this.sessionStatus.values()) {
      if (s === 'in_progress') return 'in_progress'
    }
    return 'idle'
  }

  recordUsage(sessionKey: string, inputTokens: number, contextWindowSize: number): void {
    this.tokenUsage.set(sessionKey, { current: inputTokens, total: contextWindowSize })
  }

  /**
   * 是否应该沉淀？
   * 条件：usage >= threshold 且当前不在沉淀中
   */
  shouldSettle(sessionKey: string): boolean {
    if (this.sessionStatus.get(sessionKey) === 'in_progress') return false
    // 冷却期：上次沉淀完成后 10 分钟内不再触发
    const lastTime = this.lastSettleTime.get(sessionKey)
    if (lastTime && (Date.now() - lastTime) < Settler.COOLDOWN_MS) return false
    const usage = this.tokenUsage.get(sessionKey)
    if (!usage || usage.total === 0) return false
    return (usage.current / usage.total) >= this.threshold
  }

  getUsagePercent(sessionKey: string): number {
    const usage = this.tokenUsage.get(sessionKey)
    if (!usage || usage.total === 0) return 0
    return Math.round((usage.current / usage.total) * 100)
  }

  /**
   * 开始沉淀。返回 settle prompt。
   * 启动 5 分钟超时保护。
   */
  beginSettle(sessionKey: string): string {
    this.sessionStatus.set(sessionKey, 'in_progress')
    const pct = this.getUsagePercent(sessionKey)
    this.deps.logger.info('settler', 'begin', { sessionKey, usage: pct })

    this.deps.db.logActivity('settle', undefined, JSON.stringify({
      sessionKey, status: 'in_progress', startedAt: new Date().toISOString(),
    }))

    // 超时保护：5 分钟没 complete 自动 reset
    this.clearTimeout(sessionKey)
    const timer = setTimeout(() => {
      if (this.sessionStatus.get(sessionKey) === 'in_progress') {
        this.deps.logger.warn('settler', 'timeout-reset', { sessionKey })
        this.sessionStatus.delete(sessionKey)
        this.timeoutTimers.delete(sessionKey)
      }
    }, 5 * 60 * 1000)
    this.timeoutTimers.set(sessionKey, timer)

    return `【上下文沉淀】我的上下文使用量已达 ${pct}%，需要整理记忆后开新会话。

请执行以下步骤：
1. 回顾这次会话的重要内容，用 symbiont_remember 把值得长期记住的经验存下来
2. 在工作区写一份会话总结文件（如 session-summary.md），包含：做了什么、未完成的事、关键决策、当前状态
3. 回顾最近积累的经验，如果发现有规律性的认知，用 symbiont_compile 写入长期知识
4. 调用 symbiont_settle_done，传入总结文件的绝对路径（summary_file 参数）

注意：总结文件是新会话恢复上下文的唯一来源，请写得完整。你可以自由决定记什么、不记什么。`
  }

  /**
   * 标记沉淀完成。回到 idle 状态，允许下次再触发。
   */
  completeSettle(sessionKey: string): void {
    this.clearTimeout(sessionKey)
    this.sessionStatus.delete(sessionKey)
    this.tokenUsage.delete(sessionKey)  // 清除旧 usage，防止冷却期后误触发
    this.lastSettleTime.set(sessionKey, Date.now())
    this.deps.logger.info('settler', 'complete', { sessionKey })

    this.deps.db.logActivity('settle', undefined, JSON.stringify({
      sessionKey, status: 'done', completedAt: new Date().toISOString(),
    }))
  }

  /**
   * 重置状态（用于错误恢复）。
   */
  reset(sessionKey?: string): void {
    if (sessionKey) {
      this.clearTimeout(sessionKey)
      this.sessionStatus.delete(sessionKey)
      this.deps.logger.info('settler', 'reset', { sessionKey })
    }
  }

  private clearTimeout(sessionKey: string): void {
    const existing = this.timeoutTimers.get(sessionKey)
    if (existing) {
      clearTimeout(existing)
      this.timeoutTimers.delete(sessionKey)
    }
  }
}
