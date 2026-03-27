/**
 * HTTP client for the local BGE-M3 embedding server (Infinity).
 * Provides embedding generation with graceful degradation.
 */

const DEFAULT_URL = 'http://127.0.0.1:8000/embeddings'
const DEFAULT_MODEL = 'BAAI/bge-m3'

export interface EmbeddingClientOptions {
  url?: string
  model?: string
  timeoutMs?: number
}

export class EmbeddingClient {
  private url: string
  private model: string
  private timeoutMs: number
  private available: boolean = true
  private lastError: string | null = null

  constructor(options?: EmbeddingClientOptions) {
    this.url = options?.url ?? DEFAULT_URL
    this.model = options?.model ?? DEFAULT_MODEL
    this.timeoutMs = options?.timeoutMs ?? 10000
  }

  get isAvailable(): boolean { return this.available }

  /**
   * Generate embeddings for texts. Returns null for each text if service unavailable.
   */
  async embed(texts: string[]): Promise<Array<Float32Array | null>> {
    if (texts.length === 0) return []

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)

      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, model: this.model }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        this.markUnavailable(`HTTP ${res.status}`)
        return texts.map(() => null)
      }

      const data = await res.json() as { results?: number[][]; data?: Array<{ embedding: number[] }> }
      // Infinity v2 returns {results: [[...]]}; OpenAI format returns {data: [{embedding: [...]}]}
      const vectors = data.results ?? data.data?.map(d => d.embedding) ?? []

      this.available = true
      this.lastError = null

      return vectors.map(v => v ? new Float32Array(v) : null)
    } catch (err: any) {
      this.markUnavailable(err.message)
      return texts.map(() => null)
    }
  }

  /**
   * Generate embedding for a single text.
   */
  async embedOne(text: string): Promise<Float32Array | null> {
    const results = await this.embed([text])
    return results[0] ?? null
  }

  private markUnavailable(reason: string): void {
    this.available = false
    this.lastError = reason
    // Auto-retry after 60 seconds
    setTimeout(() => { this.available = true }, 60000).unref()
  }
}

/**
 * Cosine similarity between two Float32Array vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
