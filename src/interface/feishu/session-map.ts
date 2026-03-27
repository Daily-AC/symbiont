import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionMapping {
  sessionKey: string
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
  /** Root message ID of the thread anchor — used for replying into the thread */
  anchorMessageId?: string
  ccSessionId?: string
  ccInstanceId?: string
  lastActive: string
}

export class SessionMap {
  private mappings: Map<string, SessionMapping> = new Map()
  private filePath: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.filePath = join(dataDir, 'session-map.json')
    this.load()
  }

  get(sessionKey: string): SessionMapping | undefined {
    return this.mappings.get(sessionKey)
  }

  set(mapping: SessionMapping): void {
    this.mappings.set(mapping.sessionKey, mapping)
    this.save()
  }

  findByChatId(chatId: string): SessionMapping | undefined {
    for (const m of this.mappings.values()) {
      if (m.chatId === chatId && !m.threadId) return m
    }
    return undefined
  }

  findByThreadId(threadId: string): SessionMapping | undefined {
    for (const m of this.mappings.values()) {
      if (m.threadId === threadId) return m
    }
    return undefined
  }

  updateCCSessionId(sessionKey: string, ccSessionId: string): void {
    const m = this.mappings.get(sessionKey)
    if (m) {
      m.ccSessionId = ccSessionId
      m.lastActive = new Date().toISOString()
      this.save()
    }
  }

  updateCCInstanceId(sessionKey: string, ccInstanceId: string | undefined): void {
    const m = this.mappings.get(sessionKey)
    if (m) {
      m.ccInstanceId = ccInstanceId
      m.lastActive = new Date().toISOString()
      this.save()
    }
  }

  clearInstance(sessionKey: string): void {
    this.updateCCInstanceId(sessionKey, undefined)
  }

  clearAllInstances(): void {
    for (const m of this.mappings.values()) {
      m.ccInstanceId = undefined
    }
    this.save()
  }

  /**
   * 获取 owner 的 chatId — 最近活跃的 p2p 会话。
   * 用于系统通知（如重启完成）。
   */
  getOwnerChatId(): string | null {
    let latest: SessionMapping | null = null
    for (const m of this.mappings.values()) {
      if (m.chatType !== 'p2p') continue
      if (!latest || m.lastActive > latest.lastActive) latest = m
    }
    return latest?.chatId ?? null
  }

  all(): SessionMapping[] {
    return [...this.mappings.values()]
  }

  /**
   * 清理超过 maxAgeDays 天未活跃的会话映射。
   * 返回被清理的条目数。
   */
  cleanup(maxAgeDays = 7): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [key, m] of this.mappings) {
      if (new Date(m.lastActive).getTime() < cutoff) {
        this.mappings.delete(key)
        removed++
      }
    }
    if (removed > 0) this.save()
    return removed
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      for (const m of data) {
        this.mappings.set(m.sessionKey, m)
      }
    } catch { /* ignore corrupted file */ }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify([...this.mappings.values()], null, 2))
  }
}
