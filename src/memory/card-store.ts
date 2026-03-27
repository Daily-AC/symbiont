import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ExperienceCard } from './types.ts'

export class CardStore {
  private file: string
  private cards: ExperienceCard[] = []

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'cards.jsonl')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    this.cards = readFileSync(this.file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  }

  private save(): void {
    writeFileSync(this.file, this.cards.map(c => JSON.stringify(c)).join('\n') + '\n')
  }

  add(card: Omit<ExperienceCard, 'id' | 'createdAt' | 'lastUsed'>): ExperienceCard {
    // SHA-256 去重：相同 content + scene 视为重复，更新而非新增
    const hash = this.contentHash(card.content, card.scene)
    const existing = this.cards.find(c => !c.archived && this.contentHash(c.content, c.scene) === hash)
    if (existing) {
      // 更新已有卡片（提升置信度，合并标签）
      existing.lastUsed = new Date().toISOString()
      existing.confidence = Math.min(1, +(existing.confidence + 0.1).toFixed(2))
      existing.tags = [...new Set([...existing.tags, ...card.tags])]
      if (card.source?.length) existing.source.push(...card.source)
      this.save()
      return existing
    }

    const full: ExperienceCard = {
      ...card,
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    }
    this.cards.push(full)
    this.save()
    return full
  }

  private contentHash(content: string, scene: string): string {
    return createHash('sha256').update(`${content}||${scene}`).digest('hex').slice(0, 16)
  }

  search(query: { tags?: string[]; keyword?: string }): ExperienceCard[] {
    return this.cards.filter(card => {
      if (card.archived) return false
      if (query.tags?.length) {
        const hasTag = query.tags.some(t => card.tags.includes(t))
        if (!hasTag) return false
      }
      if (query.keyword) {
        const kw = query.keyword.toLowerCase()
        if (!card.content.toLowerCase().includes(kw) &&
            !card.scene.toLowerCase().includes(kw)) return false
      }
      return true
    })
  }

  get(id: string): ExperienceCard | undefined {
    return this.cards.find(c => c.id === id)
  }

  touch(id: string): void {
    const card = this.get(id)
    if (card) {
      card.lastUsed = new Date().toISOString()
      card.confidence = Math.min(1, +(card.confidence + 0.08).toFixed(2))
      this.save()
    }
  }

  all(): ExperienceCard[] {
    return this.cards
  }

  /**
   * 置信度衰减。距离 lastUsed 每 7 天，confidence -= 0.05。
   * 低于 0.1 的标记 archived。
   */
  decay(): { decayed: number; archived: string[] } {
    const now = Date.now()
    let decayed = 0
    const archived: string[] = []

    for (const card of this.cards) {
      if (card.archived) continue

      const daysSinceUsed = (now - new Date(card.lastUsed).getTime()) / (24 * 3600 * 1000)
      if (daysSinceUsed < 7) continue

      const periods = Math.floor(daysSinceUsed / 7)
      const reduction = periods * 0.05
      card.confidence = Math.max(0, +(card.confidence - reduction).toFixed(2))
      decayed++

      if (card.confidence < 0.1) {
        card.archived = true
        archived.push(card.id)
      }
    }

    this.save()
    return { decayed, archived }
  }
}
