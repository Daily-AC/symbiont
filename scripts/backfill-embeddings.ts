#!/usr/bin/env node
/**
 * Batch-generate embeddings for all cards without embeddings.
 * Requires Infinity embedding server running at EMBEDDING_URL.
 * Run: EMBEDDING_URL=http://home:8000 node --experimental-strip-types scripts/backfill-embeddings.ts
 */
import { join } from 'node:path'
import { MemoryDB } from '../src/memory/db.ts'

const ROOT = join(import.meta.dirname, '..')
const DB_DIR = join(ROOT, 'data', 'memory-sqlite')
const EMBEDDING_URL = process.env.EMBEDDING_URL ?? 'http://127.0.0.1:8000'
const BATCH_SIZE = 32

const db = new MemoryDB(DB_DIR)

// Get all cards without embeddings
const allCards = db.getAllEmbeddings()
const needsEmbedding = allCards.filter(c => !c.embedding)

if (needsEmbedding.length === 0) {
  console.log('All cards already have embeddings')
  process.exit(0)
}

console.log(`Generating embeddings for ${needsEmbedding.length} cards...`)

// Get card content for embedding
const cardContents = new Map<string, string>()
for (const { id } of needsEmbedding) {
  const card = db.getCard(id)
  if (card) {
    // Embed: tags + scene + content
    cardContents.set(id, `${card.tags.join(' ')} ${card.scene}: ${card.content}`)
  }
}

// Batch process
const ids = [...cardContents.keys()]
let processed = 0

for (let i = 0; i < ids.length; i += BATCH_SIZE) {
  const batch = ids.slice(i, i + BATCH_SIZE)
  const texts = batch.map(id => cardContents.get(id)!)

  try {
    const res = await fetch(`${EMBEDDING_URL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, model: 'BAAI/bge-m3' }),
    })

    if (!res.ok) {
      console.error(`Embedding API error: ${res.status} ${await res.text()}`)
      continue
    }

    const data = await res.json() as { data: Array<{ embedding: number[] }> }

    for (let j = 0; j < batch.length; j++) {
      const embedding = new Float32Array(data.data[j].embedding)
      db.updateEmbedding(batch[j], embedding)
      processed++
    }

    console.log(`  ${processed}/${needsEmbedding.length} done`)
  } catch (err) {
    console.error(`Batch ${i}-${i + BATCH_SIZE} failed:`, err)
  }
}

console.log(`Backfill complete: ${processed}/${needsEmbedding.length} embeddings generated`)
db.close()
