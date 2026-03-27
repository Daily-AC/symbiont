import type { MemoryDB } from './db.ts'
import type { ExperienceCard } from './types.ts'
import type { EmbeddingClient } from './embedding-client.ts'
import { cosineSimilarity } from './embedding-client.ts'

export interface RecallResult {
  cards: ExperienceCard[]
  prompt: string  // formatted for injection
}

export interface RecallOptions {
  limit?: number
  embeddingClient?: EmbeddingClient
}

/**
 * Recall — auto-inject relevant memories into CC prompt.
 *
 * Three-path retrieval with RRF fusion:
 * 1. Semantic: embed query → cosine similarity against stored card embeddings
 * 2. Keyword: extract keywords → db.searchCards
 * 3. Graph: 1-hop expansion along connections from top results
 *
 * Graceful degradation: if embedding service unavailable, falls back to keyword + graph.
 */
export async function recall(db: MemoryDB, message: string, options?: RecallOptions): Promise<RecallResult> {
  const limit = options?.limit ?? 5
  const expandLimit = 2
  const embeddingClient = options?.embeddingClient

  // ---- Path 1: Semantic search ----
  const semanticRanking = new Map<string, number>()
  let queryEmbedding: Float32Array | null = null

  if (embeddingClient?.isAvailable) {
    queryEmbedding = await embeddingClient.embedOne(message)
  }

  if (queryEmbedding) {
    const embeddingCache = db.getCachedEmbeddings()
    const scored: Array<{ id: string; score: number }> = []

    for (const [id, embedding] of embeddingCache) {
      const sim = cosineSimilarity(queryEmbedding, embedding)
      if (sim > 0.3) {  // Early pruning: skip low-similarity entries
        scored.push({ id, score: sim })
      }
    }

    // Sort by similarity descending, assign rank positions
    scored.sort((a, b) => b.score - a.score)
    for (let i = 0; i < scored.length; i++) {
      semanticRanking.set(scored[i].id, i)
    }
  }

  // ---- Path 2: Keyword search ----
  const keywordRanking = new Map<string, number>()
  const keywords = message
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 10)

  const seen = new Set<string>()
  const keywordCandidates: ExperienceCard[] = []

  for (const kw of keywords) {
    const results = db.searchCards({ keyword: kw, archived: false, limit: limit * 2 })
    for (const card of results) {
      if (!seen.has(card.id)) {
        seen.add(card.id)
        keywordCandidates.push(card)
      }
    }
  }

  // Sort by confidence descending, assign rank positions
  keywordCandidates.sort((a, b) => b.confidence - a.confidence)
  for (let i = 0; i < keywordCandidates.length; i++) {
    keywordRanking.set(keywordCandidates[i].id, i)
  }

  // ---- RRF fusion (paths 1 + 2) ----
  const rankings: Array<Map<string, number>> = []
  if (semanticRanking.size > 0) rankings.push(semanticRanking)
  if (keywordRanking.size > 0) rankings.push(keywordRanking)

  const fusedScores = rrf(rankings)

  // Also search archived cards' essence for revival
  const archivedHits = db.searchCards({ keyword: message.slice(0, 50), archived: true, limit: 3 })
  for (const card of archivedHits) {
    if (card.essence && !fusedScores.has(card.id)) {
      db.reviveCard(card.id)
      const revived = db.getCard(card.id)
      if (revived) {
        // Give revived cards a small base score so they can appear
        fusedScores.set(revived.id, 0.001)
      }
    }
  }

  // Sort by fused score descending, take top N
  const sortedIds = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(e => e[0])

  const topCards: ExperienceCard[] = []
  for (const id of sortedIds) {
    const card = db.getCard(id)
    if (card) topCards.push(card)
  }

  // ---- Path 3: Graph expansion (1-hop) ----
  const expanded: ExperienceCard[] = [...topCards]
  const expandedIds = new Set(topCards.map(c => c.id))
  let expandCount = 0

  for (const card of topCards) {
    if (expandCount >= expandLimit) break
    const conns = db.getConnections(card.id)
    for (const conn of conns) {
      if (expandCount >= expandLimit) break
      const linkedId = conn.fromId === card.id ? conn.toId : conn.fromId
      if (!expandedIds.has(linkedId)) {
        const linked = db.getCard(linkedId)
        if (linked && !linked.archived && linked.confidence >= 0.4) {
          expandedIds.add(linkedId)
          expanded.push(linked)
          expandCount++
        }
      }
    }
  }

  // Touch all recalled cards
  for (const card of expanded) {
    db.touchCard(card.id)
  }

  // Format prompt
  const prompt = expanded.length > 0
    ? `[相关记忆]\n${expanded.map(c => `- ${c.content} (置信度: ${c.confidence.toFixed(1)}, 场景: ${c.scene})`).join('\n')}\n\n`
    : ''

  return { cards: expanded, prompt }
}

/**
 * Reciprocal Rank Fusion — merges multiple rankings into a unified score.
 * Each ranking maps card_id → rank_position (0-based).
 */
function rrf(rankings: Array<Map<string, number>>, k = 60): Map<string, number> {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    for (const [id, rank] of ranking) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank))
    }
  }
  return scores
}
