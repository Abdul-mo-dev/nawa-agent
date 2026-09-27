import { setTimeout as sleep } from 'node:timers/promises'
import type { RagSettings } from '../../shared/rag-api'
import { embeddingUrl, hashText } from './config'
export interface EmbeddingVector { vector: Float32Array; dimensions: number }
export class EmbeddingClient {
  private counts = new Map<string, number>()
  constructor(private settings: RagSettings, private key = '', private signal?: AbortSignal) {}
  private async request(url: URL, body: unknown): Promise<unknown> {
    const encoded = JSON.stringify(body)
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error('Embedding request exceeds 8 MiB; lower the batch size.')
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(this.settings.timeoutMs)
      const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) }, body: encoded })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) { await sleep(300 * 2 ** attempt, undefined, { signal: this.signal }); continue }
        throw new Error(`Embedding server HTTP ${response.status}. Check the endpoint, embedding model, pooling and context size. Response bodies are not logged.`)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty embedding response.')
      const parts: Uint8Array[] = []; let bytes = 0
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 32 * 1024 * 1024) throw new Error('Embedding response exceeds 32 MiB.'); parts.push(part.value) }
      } finally { await reader.cancel().catch(() => undefined) }
      return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
    }
  }
  async countTokens(text: string): Promise<number> {
    if (this.settings.tokenizer === 'conservative') return Buffer.byteLength(text, 'utf8') + 8
    const key = hashText(text), cached = this.counts.get(key)
    if (cached !== undefined) return cached
    const url = embeddingUrl(this.settings.baseUrl)
    url.pathname = url.pathname.replace(/\/v1\/embeddings$/, '/tokenize')
    const result = await this.request(url, { content: text, add_special: true, model: this.settings.model }) as { tokens?: unknown }
    if (!Array.isArray(result.tokens) || !result.tokens.every(n => typeof n === 'number' && Number.isInteger(n))) throw new Error('Invalid /tokenize response. Use conservative mode only for a server without the llama.cpp tokenizer endpoint.')
    // Small reserve covers pooling/template special-token differences between endpoints.
    const count = result.tokens.length + 4
    if (this.counts.size > 4096) this.counts.clear()
    this.counts.set(key, count)
    return count
  }
  async embed(inputs: string[], expectedDimensions = this.settings.dimensions): Promise<EmbeddingVector[]> {
    if (!inputs.length) return []
    this.signal?.throwIfAborted()
    const data = await this.request(embeddingUrl(this.settings.baseUrl), { model: this.settings.model, input: inputs, encoding_format: 'float' }) as { data?: unknown }
    if (!Array.isArray(data.data) || data.data.length !== inputs.length) throw new Error('Embedding response count does not match the batch.')
    const result: EmbeddingVector[] = new Array(inputs.length)
    let dimensions = expectedDimensions
    for (const value of data.data as Array<{ index?: unknown; embedding?: unknown }>) {
      const index = value.index
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= inputs.length || result[index]) throw new Error('Missing, duplicated or invalid embedding index.')
      if (!Array.isArray(value.embedding) || !value.embedding.length || value.embedding.length > 16384 || !value.embedding.every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error('Embedding vector is empty, non-finite, nested or oversized.')
      if (!dimensions) dimensions = value.embedding.length
      if (value.embedding.length !== dimensions) throw new Error(`Embedding dimension changed: expected ${dimensions}, received ${value.embedding.length}. Choose a new model revision and re-index.`)
      const norm = Math.sqrt(value.embedding.reduce((sum: number, n: number) => sum + n * n, 0))
      if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('Embedding server returned a zero/invalid vector. Verify that an embedding model and pooling are enabled.')
      result[index] = { vector: Float32Array.from(value.embedding, (n: number) => n / norm), dimensions }
    }
    return result
  }
}
/** Small bounded pool shared by all embedding batches of a file. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length); let next = 0, failure: unknown
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (failure === undefined) {
      const index = next++
      if (index >= items.length) return
      try { result[index] = await fn(items[index]!, index) } catch (error) { failure = error; return }
    }
  }))
  if (failure !== undefined) throw failure
  return result
}
