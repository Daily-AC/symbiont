import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CardStore } from './card-store.ts'

export interface CognitionCandidate {
  id: string
  tag: string
  sourceCards: string[]
  proposedContent: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

export class CognitionEngine {
  private cardStore: CardStore
  private candidates: CognitionCandidate[] = []
  private file: string

  constructor(cardStore: CardStore, dataDir: string) {
    this.cardStore = cardStore
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'cognition.jsonl')
    this.loadCandidates()
  }

  private loadCandidates(): void {
    if (!existsSync(this.file)) return
    this.candidates = readFileSync(this.file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  }

  private saveCandidates(): void {
    writeFileSync(this.file, this.candidates.map(c => JSON.stringify(c)).join('\n') + '\n')
  }

  /**
   * 扫描所有标签，找到 >= threshold 张活跃卡片的标签。
   */
  scan(threshold = 5): string[] {
    const tagCounts = new Map<string, number>()
    for (const card of this.cardStore.all()) {
      if (card.archived) continue
      for (const tag of card.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
      }
    }
    return [...tagCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([tag]) => tag)
  }

  /**
   * 手动添加认知候选（用于测试或 CC 生成后写入）。
   */
  addCandidate(partial: { tag: string; sourceCards: string[]; proposedContent: string }): CognitionCandidate {
    const candidate: CognitionCandidate = {
      ...partial,
      id: `cog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    this.candidates.push(candidate)
    this.saveCandidates()
    return candidate
  }

  approve(id: string): void {
    const c = this.candidates.find(x => x.id === id)
    if (c) {
      c.status = 'approved'
      this.saveCandidates()
    }
  }

  reject(id: string): void {
    const c = this.candidates.find(x => x.id === id)
    if (c) {
      c.status = 'rejected'
      this.saveCandidates()
    }
  }

  getPending(): CognitionCandidate[] {
    return this.candidates.filter(c => c.status === 'pending')
  }

  getApproved(): CognitionCandidate[] {
    return this.candidates.filter(c => c.status === 'approved')
  }
}
