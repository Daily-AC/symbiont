import type { ExperienceCard, Connection } from './types.ts'
import type { MemoryDB } from './db.ts'
import type { EmbeddingClient } from './embedding-client.ts'
import { cosineSimilarity } from './embedding-client.ts'

export interface ConnectorDeps {
  db: MemoryDB
  embeddingClient?: EmbeddingClient
  logger?: { info: (mod: string, event: string, meta?: any) => void }
}

export class Connector {
  private deps: ConnectorDeps
  constructor(deps: ConnectorDeps) {
    this.deps = deps
  }

  async connect(card: ExperienceCard): Promise<number> {
    const candidates = this.findCandidates(card)
    let connected = 0

    for (const candidate of candidates) {
      const relation = this.analyzeRelation(card, candidate)
      if (!relation) continue

      const existing = this.deps.db.getConnections(card.id)
      if (existing.some(c => c.toId === candidate.id || c.fromId === candidate.id)) continue

      this.deps.db.addConnection({
        fromId: card.id,
        toId: candidate.id,
        type: relation.type,
        strength: relation.strength,
        reason: relation.reason,
      })
      connected++

      // Auto-decay: when an evolves relation is detected, lower the old card's confidence
      if (relation.type === 'evolves') {
        this.deps.db.updateConfidence(
          candidate.id,
          -0.3,
          `被 ${card.id.slice(0, 12)} 迭代，自动衰减 -0.3`,
        )
        this.deps.logger?.info('memory', 'evolves-auto-decay', {
          oldCard: candidate.id.slice(0, 8),
          newCard: card.id.slice(0, 8),
          delta: -0.3,
        })
      }

      this.deps.logger?.info('memory', 'connection-created', {
        from: card.id.slice(0, 8),
        to: candidate.id.slice(0, 8),
        type: relation.type,
        strength: relation.strength,
      })
    }

    return connected
  }

  async scanAll(): Promise<number> {
    const cards = this.deps.db.searchCards({ limit: 200, archived: false })
    let totalConnected = 0
    for (const card of cards) {
      totalConnected += await this.connect(card)
    }
    return totalConnected
  }

  private findCandidates(card: ExperienceCard): ExperienceCard[] {
    const results: Map<string, ExperienceCard> = new Map()

    // 路径 1: 标签搜索
    for (const tag of card.tags) {
      const found = this.deps.db.searchCards({ tags: [tag], limit: 10, archived: false })
      for (const c of found) {
        if (c.id !== card.id) results.set(c.id, c)
      }
    }

    // 路径 2: 关键词搜索
    const keywords = this.extractKeywords(card.content)
    for (const kw of keywords.slice(0, 3)) {
      const found = this.deps.db.searchCards({ keyword: kw, limit: 5, archived: false })
      for (const c of found) {
        if (c.id !== card.id) results.set(c.id, c)
      }
    }

    // 路径 3: 向量相似度 top-K
    if (this.deps.embeddingClient?.isAvailable) {
      const allEmbeddings = this.deps.db.getAllEmbeddings()
      // 找到当前卡片的 embedding
      const cardEntry = allEmbeddings.find(e => e.id === card.id)
      if (cardEntry?.embedding) {
        const scored: Array<{ id: string; score: number }> = []
        for (const entry of allEmbeddings) {
          if (entry.id === card.id || !entry.embedding) continue
          const sim = cosineSimilarity(cardEntry.embedding, entry.embedding)
          if (sim > 0.5) scored.push({ id: entry.id, score: sim })
        }
        scored.sort((a, b) => b.score - a.score)
        for (const { id } of scored.slice(0, 10)) {
          if (!results.has(id)) {
            const c = this.deps.db.getCard(id)
            if (c && !c.archived) results.set(id, c)
          }
        }
      }
    }

    return [...results.values()]
  }

  private analyzeRelation(
    newCard: ExperienceCard,
    existing: ExperienceCard
  ): { type: Connection['type']; strength: number; reason: string } | null {
    const tagOverlap = this.tagOverlapRatio(newCard.tags, existing.tags)
    const kwNew = this.extractKeywords(newCard.content)
    const kwExisting = this.extractKeywords(existing.content)
    const kwOverlap = this.keywordOverlapRatio(kwNew, kwExisting)

    if (newCard.scene === existing.scene && tagOverlap > 0.5) {
      const daysBetween = (new Date(newCard.createdAt).getTime() - new Date(existing.createdAt).getTime()) / 86400000
      if (daysBetween > 1 && newCard.confidence >= existing.confidence) {
        return {
          type: 'evolves',
          strength: Math.min(0.9, tagOverlap + 0.2),
          reason: `同场景「${newCard.scene}」的经验迭代（间隔 ${Math.round(daysBetween)} 天）`,
        }
      }
    }

    if (tagOverlap > 0.3 && this.hasContradiction(newCard.content, existing.content)) {
      return {
        type: 'contradicts',
        strength: 0.7,
        reason: `标签重叠但内容含相反判断`,
      }
    }

    if (tagOverlap >= 0.5 && kwOverlap >= 0.3) {
      return {
        type: 'similar',
        strength: Math.min(0.8, (tagOverlap + kwOverlap) / 2 + 0.2),
        reason: `标签重叠 ${Math.round(tagOverlap * 100)}%，关键词重叠 ${Math.round(kwOverlap * 100)}%`,
      }
    }

    if (tagOverlap >= 0.3 && kwOverlap < 0.2) {
      return {
        type: 'supplements',
        strength: Math.min(0.6, tagOverlap + 0.1),
        reason: `同标签但内容互补（关键词重叠仅 ${Math.round(kwOverlap * 100)}%）`,
      }
    }

    if (tagOverlap > 0.2 && this.hasCausalSignal(newCard.content, existing.content)) {
      return {
        type: 'causal',
        strength: 0.5,
        reason: `内容含因果关系信号`,
      }
    }

    return null
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set(['的', '了', '是', '在', '和', '有', '这', '个', '不', '也',
      'the', 'is', 'at', 'in', 'on', 'and', 'or', 'to', 'a', 'an', 'for', 'with'])
    const words = text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/g) ?? []
    return [...new Set(words.filter(w => !stopWords.has(w.toLowerCase())))]
  }

  private tagOverlapRatio(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0
    const setA = new Set(a)
    const setB = new Set(b)
    const intersection = [...setA].filter(x => setB.has(x)).length
    const union = new Set([...a, ...b]).size
    return union === 0 ? 0 : intersection / union
  }

  private keywordOverlapRatio(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0
    const setA = new Set(a.map(w => w.toLowerCase()))
    const setB = new Set(b.map(w => w.toLowerCase()))
    const intersection = [...setA].filter(x => setB.has(x)).length
    const union = new Set([...setA, ...setB]).size
    return union === 0 ? 0 : intersection / union
  }

  private hasContradiction(textA: string, textB: string): boolean {
    const positivePatterns = /应该|推荐使用|建议|适合|可以使用/
    const negativePatterns = /不应该|不要|避免|不推荐|不建议|不适合|禁止|不可以/
    return (positivePatterns.test(textA) && negativePatterns.test(textB)) ||
           (negativePatterns.test(textA) && positivePatterns.test(textB))
  }

  private hasCausalSignal(textA: string, textB: string): boolean {
    const causalPatterns = /因为|所以|导致|因此|由于|结果|造成|引起|触发|根因/
    return causalPatterns.test(textA) || causalPatterns.test(textB)
  }
}
