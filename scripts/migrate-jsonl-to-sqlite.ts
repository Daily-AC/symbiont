#!/usr/bin/env node
/**
 * One-time migration: persona memory cards.jsonl -> SQLite
 * Run: node --experimental-strip-types scripts/migrate-jsonl-to-sqlite.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryDB } from '../src/memory/db.ts'

const ROOT = join(import.meta.dirname, '..')
const JSONL_PATH = join(ROOT, 'persona-example', 'memory', 'cards.jsonl')
const DB_DIR = join(ROOT, 'data', 'memory-sqlite')

if (!existsSync(JSONL_PATH)) {
  console.log('No cards.jsonl found, nothing to migrate')
  process.exit(0)
}

const db = new MemoryDB(DB_DIR)
const lines = readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean)

let migrated = 0
let skipped = 0

for (const line of lines) {
  try {
    const card = JSON.parse(line)
    // Check if card already exists (by content hash)
    const existing = db.searchCards({ keyword: card.content?.slice(0, 50), limit: 1 })
    if (existing.length > 0 && existing[0].content === card.content) {
      skipped++
      continue
    }
    db.addCard({
      content: card.content,
      scene: card.scene ?? 'migrated',
      tags: card.tags ?? [],
      confidence: card.confidence ?? 0.5,
      source: card.source ?? [],
      connections: card.connections ?? [],
    })
    migrated++
  } catch (err) {
    console.error(`Failed to parse line: ${line.slice(0, 80)}...`, err)
  }
}

console.log(`Migration complete: ${migrated} migrated, ${skipped} skipped (already exist), ${lines.length} total`)
db.close()
