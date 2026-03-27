export class MessageDedup {
  private seen: Set<string> = new Set()
  private maxSize: number

  constructor(maxSize = 10000) {
    this.maxSize = maxSize
  }

  isDuplicate(messageId: string): boolean {
    if (this.seen.has(messageId)) return true
    this.seen.add(messageId)
    if (this.seen.size > this.maxSize) {
      const entries = [...this.seen]
      this.seen = new Set(entries.slice(entries.length / 2))
    }
    return false
  }
}
