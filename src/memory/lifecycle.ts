import type { MemoryDB } from './db.ts'
import type { Logger } from '../core/logger.ts'
import type { Connector } from './connector.ts'

/**
 * Memory Lifecycle — compression-driven decay, aggregation, archival.
 *
 * Run periodically (every N hours) as the "memory consolidation" process.
 */
export class MemoryLifecycle {
  private db: MemoryDB
  private logger: Logger
  private gracePeriodDays: number
  private timeoutDays: number
  private connector?: Connector

  constructor(db: MemoryDB, logger: Logger, options?: { gracePeriodDays?: number; timeoutDays?: number; connector?: Connector }) {
    this.db = db
    this.logger = logger
    this.gracePeriodDays = options?.gracePeriodDays ?? 30
    this.timeoutDays = options?.timeoutDays ?? 90
    this.connector = options?.connector
  }

  /**
   * Run full lifecycle cycle.
   */
  run(): { decayed: number; archived: number; aggregated: string[] } {
    const decayed = this.decay()
    const archived = this.archive()
    const aggregated = this.aggregate()
    this.logger.info('lifecycle', 'cycle-complete', { decayed, archived, aggregated: aggregated.length })

    if (this.connector) {
      this.connector.scanAll().then(count => {
        if (count > 0) this.logger.info('memory', 'lifecycle-scan-connections', { new: count })
      }).catch(err => {
        this.logger.error('memory', 'scan-connections-failed', { error: (err as Error).message })
      })
    }

    return { decayed, archived, aggregated }
  }

  /**
   * Compression-driven decay:
   * - Cards with 'evolves' connections: old card -0.3
   * - Cards with 'contradicts' connections: old card -0.5
   * - Time fallback: 90 days unused + no connections → -0.1
   */
  private decay(): number {
    let count = 0
    const now = Date.now()
    const cards = this.db.getAllCards(false)

    for (const card of cards) {
      // Skip locked (confidence = 1.0) and grace period
      if (card.confidence >= 1.0) continue
      const ageMs = now - new Date(card.createdAt).getTime()
      if (ageMs < this.gracePeriodDays * 86400_000) continue

      // Compression-driven: check if newer cards evolve/contradict this one
      const conns = this.db.getConnections(card.id)
      let compressed = false
      // Check connections where this card is the target (being evolved/contradicted)
      for (const conn of conns) {
        const isTarget = conn.toId === card.id
        if (!isTarget) continue
        if (conn.type === 'evolves') {
          this.db.updateConfidence(card.id, -0.3, `Evolved by ${conn.fromId}`)
          compressed = true
          count++
        } else if (conn.type === 'contradicts') {
          this.db.updateConfidence(card.id, -0.5, `Contradicted by ${conn.fromId}`)
          compressed = true
          count++
        }
      }

      // Time fallback: 90 days unused + no connections
      if (!compressed) {
        const daysSinceUsed = (now - new Date(card.lastUsed).getTime()) / 86400_000
        if (daysSinceUsed >= this.timeoutDays && !this.db.hasConnections(card.id)) {
          this.db.updateConfidence(card.id, -0.1, `Unused for ${Math.floor(daysSinceUsed)} days`)
          count++
        }
      }
    }

    return count
  }

  /**
   * Archive low-confidence cards, extract essence.
   */
  private archive(): number {
    let count = 0
    const cards = this.db.getAllCards(false)

    for (const card of cards) {
      if (card.confidence < 0.1 && !this.db.hasConnections(card.id)) {
        // Extract essence (simple: first sentence or first 100 chars)
        const essence = card.content.split(/[。.!！？?]/)[0].slice(0, 100)
        this.db.archiveCard(card.id, essence)
        count++
      }
    }

    return count
  }

  /**
   * Aggregate: find tags with 5+ cards → cognition candidate.
   */
  private aggregate(): string[] {
    const tagCounts = new Map<string, string[]>()
    const cards = this.db.getAllCards(false)

    for (const card of cards) {
      for (const tag of card.tags) {
        const list = tagCounts.get(tag) ?? []
        list.push(card.id)
        tagCounts.set(tag, list)
      }
    }

    const candidates: string[] = []
    for (const [tag, cardIds] of tagCounts) {
      if (cardIds.length >= 5) {
        // Check if cognition already exists for this tag
        const existing = this.db.getCognitions().find(c => c.tag === tag)
        if (!existing) {
          const summaryCards = cardIds.slice(0, 5).map(id => this.db.getCard(id)!.content).join('; ')
          this.db.addCognition(tag, `Pattern: ${summaryCards.slice(0, 200)}`, cardIds)
          candidates.push(tag)
        }
      }
    }

    return candidates
  }
}
