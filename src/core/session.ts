import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface SessionState {
  sessionId: string
  sessionKey?: string
  personaPack: string
  ccSessionId: string | null
  state: 'active' | 'sleeping' | 'ended'
  lastActive: string
}

export class SessionManager {
  private dir: string
  private sessions: Map<string, SessionState> = new Map()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    this.loadAll()
  }

  private file(): string {
    return join(this.dir, 'sessions.json')
  }

  private loadAll(): void {
    if (!existsSync(this.file())) return
    const data = JSON.parse(readFileSync(this.file(), 'utf-8')) as SessionState[]
    for (const s of data) {
      this.sessions.set(s.sessionId, s)
    }
  }

  private saveAll(): void {
    writeFileSync(this.file(), JSON.stringify([...this.sessions.values()], null, 2))
  }

  create(personaPack: string, sessionKey?: string): SessionState {
    const session: SessionState = {
      sessionId: `symbiont-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      personaPack,
      ccSessionId: null,
      state: 'active',
      lastActive: new Date().toISOString(),
    }
    this.sessions.set(session.sessionId, session)
    // 不立即保存 — 等 ccSessionId 更新后再保存，避免脏数据
    return session
  }

  /** 更新后才保存（确保 ccSessionId 有值） */

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }

  updateCCSessionId(sessionId: string, ccSessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.ccSessionId = ccSessionId
      s.lastActive = new Date().toISOString()
      this.saveAll()
    }
  }

  updateSessionKey(sessionId: string, sessionKey: string): void {
    const s = this.sessions.get(sessionId)
    if (s && s.sessionKey !== sessionKey) {
      s.sessionKey = sessionKey
      this.saveAll()
    }
  }

  sleep(sessionId: string, sessionKey?: string): void {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.state = 'sleeping'
      if (sessionKey) s.sessionKey = sessionKey
      this.saveAll()
    }
  }

  end(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.state = 'ended'
      this.saveAll()
    }
  }

  sleepAll(): void {
    let count = 0
    for (const s of this.sessions.values()) {
      if (s.state !== 'sleeping') count++
      s.state = 'sleeping'
    }
    this.saveAll()
    console.log(`[session] sleep-all: slept=${count} total=${this.sessions.size}`)
  }

  wake(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.state = 'active'
      s.lastActive = new Date().toISOString()
      this.saveAll()
    }
  }

  getActive(): SessionState | undefined {
    return [...this.sessions.values()].find(s => s.state === 'active')
  }

  getLatestBySessionKey(sessionKey: string): SessionState | undefined {
    const sorted = [...this.sessions.values()]
      .filter(s => s.sessionKey === sessionKey)  // 不要求 ccSessionId — 崩溃后可能为 null
      .sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
    return sorted[0]
  }

  getLatest(): SessionState | undefined {
    const sorted = [...this.sessions.values()]
      .filter(s => s.ccSessionId)  // 只返回有 ccSessionId 的（可 resume 的）
      .sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
    return sorted[0]
  }
}
