import type { MemoryDB } from '../memory/db.ts'

export interface SiaEvent {
  id: string
  timestamp: string
  type: 'chat' | 'fork' | 'worker' | 'merge' | 'memory'
  sessionId: string
  data: Record<string, unknown>
}

export interface TimelineEntry {
  timestamp: string
  type: string
  summary: string
  childSessionId?: string
}

/**
 * 事件流存储 — 基于 SQLite（MemoryDB 的 events 表）。
 *
 * 接口与旧版 jsonl EventStore 完全一致，底层改用 SQLite。
 */
export class EventStore {
  private db: MemoryDB

  constructor(db: MemoryDB) {
    this.db = db
  }

  append(event: Omit<SiaEvent, 'id' | 'timestamp'>): SiaEvent {
    const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    this.db.appendEvent({
      sessionId: event.sessionId,
      type: event.type,
      role: event.data.role as string | undefined,
      content: event.data.content as string | undefined,
      ccSessionId: event.data.ccSessionId as string | undefined,
      metadata: event.data,
    })
    return { ...event, id, timestamp }
  }

  appendFork(parentSessionId: string, childSessionId: string, description: string): SiaEvent {
    return this.append({
      type: 'fork',
      sessionId: parentSessionId,
      data: { childSessionId, description },
    })
  }

  appendMerge(parentSessionId: string, childSessionId: string, summary: string): SiaEvent {
    return this.append({
      type: 'merge',
      sessionId: parentSessionId,
      data: { childSessionId, summary },
    })
  }

  getForks(sessionId: string): SiaEvent[] {
    return this.read(sessionId).filter(e => e.type === 'fork')
  }

  read(sessionId: string): SiaEvent[] {
    return this.db.getEventsFull(sessionId)
  }

  getLatestSummary(sessionId: string, n = 10): SiaEvent[] {
    const events = this.read(sessionId)
    return events.slice(-n)
  }

  getChildEvents(parentSessionId: string, childSessionId: string): SiaEvent[] {
    const parentEvents = this.read(parentSessionId)
    const hasFork = parentEvents.some(
      e => e.type === 'fork' && e.data.childSessionId === childSessionId
    )
    if (!hasFork) return []
    return this.read(childSessionId)
  }

  resolveSource(sourceUri: string): SiaEvent[] {
    const match = sourceUri.match(/^event:\/\/([^/]+)\/#(\d+)-#(\d+)$/)
    if (!match) return []
    const [, sessionId, startStr, endStr] = match
    const events = this.read(sessionId)
    const start = parseInt(startStr)
    const end = parseInt(endStr)
    return events.slice(start, end + 1)
  }

  getTimeline(sessionId: string): TimelineEntry[] {
    const events = this.read(sessionId)
    return events.map(e => {
      const entry: TimelineEntry = {
        timestamp: e.timestamp,
        type: e.type,
        summary: '',
      }

      switch (e.type) {
        case 'chat': {
          const content = String(e.data.content ?? '')
          entry.summary = content.length > 50 ? content.slice(0, 50) + '...' : content
          break
        }
        case 'fork':
          entry.summary = `分叉: ${e.data.description}`
          entry.childSessionId = e.data.childSessionId as string
          break
        case 'merge':
          entry.summary = `合流: ${e.data.summary}`
          entry.childSessionId = e.data.childSessionId as string
          break
        case 'worker':
          entry.summary = `工人: ${e.data.action} ${e.data.taskId ?? ''}`
          break
        case 'memory':
          entry.summary = `记忆: ${e.data.cardId ?? ''}`
          break
      }

      return entry
    })
  }
}
