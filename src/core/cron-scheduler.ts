import { Cron } from 'croner'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from './logger.ts'

export interface CronJob {
  id: string
  name: string
  /** 标准 cron 表达式（5 字段或 6 字段含秒） */
  schedule: string
  /** 时区，默认 Asia/Shanghai */
  timezone?: string
  /** 执行器类型 */
  executor: 'cc' | 'native'
  /** cc 执行器的 prompt */
  prompt?: string
  /** native 执行器的函数名 */
  handler?: string
  /** 是否启用 */
  enabled: boolean
  /** 重叠策略：skip = 跳过 */
  overlapPolicy?: 'skip' | 'allow'
  /** 连续失败次数（熔断用） */
  consecutiveFailures?: number
  /** 最大连续失败数（达到后自动禁用） */
  maxFailures?: number
  /** 创建时间 */
  createdAt: string
  /** 最近一次成功完成时间（用于重启补偿） */
  lastCompletedAt?: string
}

export interface CronRun {
  id: string
  jobId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  result?: string
  error?: string
  startedAt: string
  completedAt?: string
  duration?: number
}

export interface CronSchedulerDeps {
  logger: Logger
  /** 触发时的回调，由上层处理实际执行 */
  onTrigger: (job: CronJob, runId: string) => void
  /** 运行完成后的回调（可选） */
  onComplete?: (run: CronRun) => void
}

/**
 * Cron 调度器 — 基础设施层。
 *
 * 参考 Team Anya 的 CronScheduler：
 * - croner 库解析 cron 表达式
 * - JSONL 持久化（不用数据库，大道至简）
 * - 重叠策略（skip/allow）
 * - 自动熔断（连续失败 N 次停止触发）
 * - 动态增删改
 */
export class CronScheduler {
  private crons: Map<string, Cron> = new Map()
  private jobs: Map<string, CronJob> = new Map()
  private activeRuns: Map<string, CronRun> = new Map()
  private deps: CronSchedulerDeps
  private jobsFile: string
  private runsFile: string
  private running = false

  constructor(dataDir: string, deps: CronSchedulerDeps) {
    const cronDir = join(dataDir, 'cron')
    mkdirSync(cronDir, { recursive: true })
    this.jobsFile = join(cronDir, 'jobs.jsonl')
    this.runsFile = join(cronDir, 'runs.jsonl')
    this.deps = deps
    this.loadJobs()
  }

  /** 启动调度器：注册所有 enabled 的 job */
  start(): void {
    this.compensateMissedJobs()
    for (const job of this.jobs.values()) {
      if (job.enabled) this.registerCron(job)
    }
    this.running = true
    this.deps.logger.info('cron', 'started', { jobCount: this.jobs.size })
  }

  /** 停止调度器 */
  stop(): void {
    for (const [, cron] of this.crons) cron.stop()
    this.crons.clear()
    this.running = false
    this.deps.logger.info('cron', 'stopped')
  }

  /** 添加 job */
  addJob(job: Omit<CronJob, 'id' | 'createdAt' | 'consecutiveFailures'>): CronJob {
    const full: CronJob = {
      ...job,
      id: `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      consecutiveFailures: 0,
    }
    this.jobs.set(full.id, full)
    this.saveJobs()
    if (this.running && full.enabled) this.registerCron(full)
    this.deps.logger.info('cron', 'job-added', { id: full.id, name: full.name, schedule: full.schedule })
    return full
  }

  /** 删除 job */
  removeJob(id: string): void {
    const cron = this.crons.get(id)
    if (cron) { cron.stop(); this.crons.delete(id) }
    this.jobs.delete(id)
    this.saveJobs()
  }

  /** 启用/禁用 */
  setEnabled(id: string, enabled: boolean): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.enabled = enabled
    if (!enabled) {
      const cron = this.crons.get(id)
      if (cron) { cron.stop(); this.crons.delete(id) }
    } else if (this.running) {
      this.registerCron(job)
    }
    this.saveJobs()
  }

  /** 手动触发 */
  triggerNow(id: string): string | null {
    const job = this.jobs.get(id)
    if (!job) return null
    return this.triggerJob(job)
  }

  /** 标记运行完成 */
  completeRun(runId: string, success: boolean, result?: string): void {
    const run = this.activeRuns.get(runId)
    if (!run) return

    run.status = success ? 'completed' : 'failed'
    run.result = result
    run.completedAt = new Date().toISOString()
    run.duration = Date.now() - new Date(run.startedAt).getTime()
    this.activeRuns.delete(runId)
    this.appendRun(run)

    // 通知上层
    if (this.deps.onComplete) this.deps.onComplete(run)

    // 更新连续失败计数
    const job = this.jobs.get(run.jobId)
    if (job) {
      job.consecutiveFailures = success ? 0 : (job.consecutiveFailures ?? 0) + 1
      if (success) {
        job.lastCompletedAt = new Date().toISOString()
      }
      // 自动熔断
      if (job.consecutiveFailures >= (job.maxFailures ?? 5)) {
        this.deps.logger.warn('cron', 'circuit-break', {
          id: job.id, name: job.name, failures: job.consecutiveFailures,
        })
        this.setEnabled(job.id, false)
      }
      this.saveJobs()
    }
  }

  /** 读取执行历史 */
  getRuns(jobId?: string, limit = 50): CronRun[] {
    if (!existsSync(this.runsFile)) return []
    const content = readFileSync(this.runsFile, 'utf-8').trim()
    if (!content) return []

    const lines = content.split('\n')
    const tail = lines.slice(-500)  // only read last 500 lines

    const runs: CronRun[] = []
    for (const line of tail) {
      if (!line.trim()) continue
      try {
        const run: CronRun = JSON.parse(line)
        if (!jobId || run.jobId === jobId) runs.push(run)
      } catch { /* skip */ }
    }

    runs.reverse()
    return runs.slice(0, limit)
  }

  /** 获取所有 job */
  listJobs(): CronJob[] { return [...this.jobs.values()] }

  /** 获取 job */
  getJob(id: string): CronJob | undefined { return this.jobs.get(id) }

  get isRunning(): boolean { return this.running }
  get jobCount(): number { return this.jobs.size }

  /** 重启时重置所有被熔断的 job，让它们有机会恢复 */
  resetCircuitBreakers(): number {
    let count = 0
    for (const job of this.jobs.values()) {
      if (!job.enabled && (job.consecutiveFailures ?? 0) >= (job.maxFailures ?? 5)) {
        job.enabled = true
        job.consecutiveFailures = 0
        count++
        this.deps.logger?.info('cron', 'circuit-breaker-reset', { id: job.id, name: job.name })
      }
    }
    if (count > 0) this.saveJobs()
    return count
  }

  // ---- 内部 ----

  /** 重启补偿：若上次完成时间超过 2 倍周期，立即触发 */
  private compensateMissedJobs(): void {
    for (const job of this.jobs.values()) {
      if (!job.enabled || !job.lastCompletedAt) continue
      const lastRun = new Date(job.lastCompletedAt).getTime()
      const now = Date.now()
      const intervalMs = this.estimateIntervalMs(job.schedule)
      if (intervalMs <= 0) continue
      if (now - lastRun > intervalMs * 2) {
        this.deps.logger.info('cron', 'compensate-missed', {
          id: job.id, name: job.name, lastRun: job.lastCompletedAt,
        })
        this.triggerJob(job)
      }
    }
  }

  /**
   * 从 cron 表达式估算最小间隔（毫秒）。
   * 只处理常见模式，返回 0 表示无法估算（不补偿）。
   *
   * 支持的模式（5 字段：min hour dom month dow）：
   *   `*\/N * * * *`     → N 分钟
   *   `M *\/N * * *`     → N 小时
   *   `M H * * *`        → 24 小时（固定时刻的每日任务，dom/month/dow 必须全为 *）
   *   `M * * * *`        → 1 小时（固定分钟的每小时任务，dom/month/dow 必须全为 *）
   */
  estimateIntervalMs(schedule: string): number {
    const parts = schedule.trim().split(/\s+/)
    if (parts.length < 5) return 0
    const [min, hour, dom, month, dow] = parts
    const allWild = dom === '*' && month === '*' && dow === '*'

    // `*/N * * * *` — 每 N 分钟
    const everyMinMatch = min.match(/^\*\/(\d+)$/)
    if (everyMinMatch && hour === '*' && allWild) {
      return parseInt(everyMinMatch[1], 10) * 60 * 1000
    }

    // `M */N * * *` — 每 N 小时
    const everyHourMatch = hour.match(/^\*\/(\d+)$/)
    if (everyHourMatch && min.match(/^\d+$/) && allWild) {
      return parseInt(everyHourMatch[1], 10) * 60 * 60 * 1000
    }

    // `M H * * *` — 固定时刻，每日一次（dom/month/dow 全为 *）
    if (min.match(/^\d+$/) && hour.match(/^\d+$/) && allWild) {
      return 24 * 60 * 60 * 1000
    }

    // `M * * * *` — 固定分钟，每小时（dom/month/dow 全为 *）
    if (min.match(/^\d+$/) && hour === '*' && allWild) {
      return 60 * 60 * 1000
    }

    return 0
  }

  private registerCron(job: CronJob): void {
    if (this.crons.has(job.id)) {
      this.crons.get(job.id)!.stop()
    }
    const cron = new Cron(job.schedule, {
      timezone: job.timezone ?? 'Asia/Shanghai',
    }, () => {
      try { this.triggerJob(job) }
      catch (err) { this.deps.logger.error('cron', 'trigger-error', { id: job.id, error: (err as Error).message }) }
    })
    this.crons.set(job.id, cron)
  }

  private triggerJob(job: CronJob): string {
    // 重叠检查
    if (job.overlapPolicy === 'skip') {
      const hasActive = [...this.activeRuns.values()].some(r => r.jobId === job.id)
      if (hasActive) {
        this.deps.logger.info('cron', 'skip-overlap', { id: job.id })
        return ''
      }
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const run: CronRun = {
      id: runId, jobId: job.id,
      status: 'queued', startedAt: new Date().toISOString(),
    }
    this.activeRuns.set(runId, run)
    this.deps.logger.info('cron', 'triggered', { id: job.id, name: job.name, runId })
    this.deps.onTrigger(job, runId)
    return runId
  }

  private loadJobs(): void {
    if (!existsSync(this.jobsFile)) return
    const content = readFileSync(this.jobsFile, 'utf-8').trim()
    if (!content) return
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const job: CronJob = JSON.parse(line)
        this.jobs.set(job.id, job)
      } catch { /* skip invalid lines */ }
    }
  }

  private saveJobs(): void {
    writeFileSync(this.jobsFile, [...this.jobs.values()].map(j => JSON.stringify(j)).join('\n') + '\n')
  }

  private appendRun(run: CronRun): void {
    try {
      appendFileSync(this.runsFile, JSON.stringify(run) + '\n')
    } catch { /* ignore */ }
  }
}
