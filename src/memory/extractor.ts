import type { MemoryDB } from './db.ts'
import type { CCBroker } from '../core/cc-broker.ts'
import type { Logger } from '../core/logger.ts'
import type { PersonaConfig } from '../persona/loader.ts'
import type { Connector } from './connector.ts'

const EXTRACT_PROMPT = `Analyze this conversation and extract knowledge worth remembering long-term.
Only extract "lessons learned" and "successful strategies" — not casual chat.
If nothing is worth remembering, respond with exactly: SKIP

For each item, output one JSON object per line:
{"content": "one sentence lesson", "scene": "when this applies", "tags": ["tag1", "tag2"], "confidence": 0.7}

Conversation:
`

/**
 * Memory Extractor — hook into conversation flow, auto-extract experience cards.
 *
 * Called after each conversation turn (or batch of turns).
 * Uses a lightweight CC worker to analyze and extract.
 */
export class MemoryExtractor {
  private db: MemoryDB
  private broker: CCBroker
  private logger: Logger
  private pendingTurns: Array<{ role: string; content: string; sessionId: string }> = []
  private extractionInterval: number
  private persona?: PersonaConfig
  private connector?: Connector

  constructor(db: MemoryDB, broker: CCBroker, logger: Logger, options?: { extractionInterval?: number; persona?: PersonaConfig; connector?: Connector }) {
    this.db = db
    this.broker = broker
    this.logger = logger
    this.extractionInterval = options?.extractionInterval ?? 5
    this.persona = options?.persona
    this.connector = options?.connector
  }

  /**
   * Record a conversation turn. Triggers extraction when enough turns accumulate.
   */
  recordTurn(role: string, content: string, sessionId: string): void {
    this.pendingTurns.push({ role, content, sessionId })
    if (this.pendingTurns.length >= this.extractionInterval) {
      this.extract().catch(err => {
        this.logger.error('extractor', 'extract-failed', { error: (err as Error).message })
      })
    }
  }

  /**
   * Force extraction of pending turns.
   */
  async extract(): Promise<number> {
    if (this.pendingTurns.length === 0) return 0

    const turns = [...this.pendingTurns]
    this.pendingTurns = []

    const conversation = turns.map(t => `${t.role}: ${t.content}`).join('\n')
    const sessionId = turns[turns.length - 1].sessionId

    try {
      // Load persona's soul prompt so the extraction worker has context for judging what to remember
      const soulContext = this.persona?.soulPrompt
        ? `${this.persona.soulPrompt}\n\n---\nYou are now acting as a memory organizer. Use your understanding to judge what's worth remembering.\n`
        : 'You are a memory extraction worker. '
      const instance = await this.broker.spawn('worker', {
        systemPrompt: soulContext + 'Output JSON only.',
        idleTimeoutMs: 0,
      }, 'memory-extraction')

      const { result } = await this.broker.sendPrompt(instance.id, EXTRACT_PROMPT + conversation)
      await this.broker.destroy(instance.id)

      if (result.trim() === 'SKIP' || result.trim().startsWith('SKIP')) {
        this.logger.info('extractor', 'skip', { turns: turns.length })
        return 0
      }

      // Parse extracted cards
      let count = 0
      for (const line of result.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('{')) continue
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed.content && parsed.tags) {
            const sourceUri = `event://${sessionId}/#${Math.max(0, turns.length - 5)}-#${turns.length}`
            const card = this.db.addCard({
              content: parsed.content,
              scene: parsed.scene ?? '',
              tags: parsed.tags,
              confidence: parsed.confidence ?? 0.7,
              source: [sourceUri],
              connections: [],
              owner: this.persona?.manifest?.name ?? 'default',
            })
            if (this.connector) {
              const connections = await this.connector.connect(card)
              if (connections > 0) {
                this.logger.info('memory', 'auto-connected', { cardId: card.id.slice(0, 8), connections })
              }
            }
            count++
          }
        } catch { /* skip unparseable lines */ }
      }

      this.logger.info('extractor', 'extracted', { turns: turns.length, cards: count })
      return count
    } catch (err) {
      this.logger.error('extractor', 'failed', { error: (err as Error).message })
      // Put turns back for retry
      this.pendingTurns.unshift(...turns)
      return 0
    }
  }

  getPendingCount(): number {
    return this.pendingTurns.length
  }
}
