import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  module: string
  event: string
  data?: Record<string, unknown>
  duration?: number
}

/**
 * 结构化日志器。
 *
 * - NDJSON 文件（每天一个：sia-YYYY-MM-DD.ndjson）
 * - SYMBIONT_DEBUG 环境变量控制 stderr 输出
 * - 关键事件始终写文件，debug 级别只在 SYMBIONT_DEBUG 时输出
 */
function beijingTimestamp(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T')
}

export class Logger {
  private dir: string
  private isDebug: boolean

  constructor(dir: string) {
    this.dir = dir
    this.isDebug = !!process.env.SYMBIONT_DEBUG
    mkdirSync(dir, { recursive: true })
  }

  debug(module: string, event: string, data?: Record<string, unknown>): void {
    this.log('debug', module, event, data)
  }

  info(module: string, event: string, data?: Record<string, unknown>): void {
    this.log('info', module, event, data)
  }

  warn(module: string, event: string, data?: Record<string, unknown>): void {
    this.log('warn', module, event, data)
  }

  error(module: string, event: string, data?: Record<string, unknown>): void {
    this.log('error', module, event, data)
  }

  private log(level: LogLevel, module: string, event: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: beijingTimestamp(),
      level, module, event,
      ...(data ? { data } : {}),
    }

    // 写文件（debug 级别除外，除非 SYMBIONT_DEBUG）
    if (level !== 'debug' || this.isDebug) {
      const date = entry.ts.slice(0, 10)
      const file = join(this.dir, `symbiont-${date}.ndjson`)
      try {
        appendFileSync(file, JSON.stringify(entry) + '\n')
      } catch { /* 日志不应阻断主流程 */ }
    }

    // stderr 输出
    if (this.isDebug || level === 'error' || level === 'warn') {
      const prefix = `[${level.toUpperCase()}][${module}]`
      const msg = `${prefix} ${event}${data ? ' ' + JSON.stringify(data) : ''}`
      process.stderr.write(msg + '\n')
    }
  }
}
