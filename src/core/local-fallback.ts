// src/core/local-fallback.ts — MCP 全断降级通道
// 当 Gateway proxyToolCall 失败时，关键工具调用暂存到本地 JSONL，后端恢复后重放。

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FallbackEntry {
  tool: string
  args: Record<string, unknown>
  timestamp: number
  sessionKey?: string
}

const CRITICAL_TOOLS = new Set([
  'symbiont_report_issue',
  'symbiont_remember',
  'symbiont_update_memory',
])

export class LocalFallback {
  private readonly filePath: string

  constructor(dataDir: string) {
    const dir = join(dataDir, 'fallback')
    mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'mcp-fallback.jsonl')
  }

  static isCriticalTool(name: string): boolean {
    return CRITICAL_TOOLS.has(name)
  }

  enqueue(tool: string, args: Record<string, unknown>, sessionKey?: string): void {
    const entry: FallbackEntry = { tool, args, timestamp: Date.now(), sessionKey }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n')
  }

  peek(): FallbackEntry[] {
    return this.readEntries()
  }

  drain(): FallbackEntry[] {
    const entries = this.readEntries()
    if (entries.length > 0) {
      // Truncate the file
      writeFileSync(this.filePath, '')
    }
    return entries
  }

  get pendingCount(): number {
    return this.readEntries().length
  }

  private readEntries(): FallbackEntry[] {
    if (!existsSync(this.filePath)) return []
    const content = readFileSync(this.filePath, 'utf-8').trim()
    if (!content) return []
    return content.split('\n').map(line => JSON.parse(line) as FallbackEntry)
  }
}
