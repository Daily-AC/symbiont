import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

interface WhitelistEntry {
  chatId: string
  name?: string
  addedAt: string
}

export class Whitelist {
  private entries: Map<string, WhitelistEntry> = new Map()
  private filePath: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.filePath = join(dataDir, 'whitelist.json')
    this.load()
  }

  isAllowed(chatId: string): boolean {
    return this.entries.has(chatId)
  }

  add(chatId: string, name?: string): void {
    this.entries.set(chatId, { chatId, name, addedAt: new Date().toISOString() })
    this.save()
  }

  remove(chatId: string): void {
    this.entries.delete(chatId)
    this.save()
  }

  list(): WhitelistEntry[] {
    return [...this.entries.values()]
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      for (const e of data) this.entries.set(e.chatId, e)
    } catch { /* ignore */ }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify([...this.entries.values()], null, 2))
  }
}
