import { createHash } from 'node:crypto'
import { DEFAULT_RAG_SETTINGS, type RagSettings } from '../../shared/rag-api'
export const CHUNKER_VERSION = 'nawa-structure-rag-1.1.0'
export const NATIVE_MODEL = 'Xenova/multilingual-e5-small'
export const NATIVE_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
export function embeddingUrl(base: string): URL {
  const url = new URL(base)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use an HTTP(S) base URL without credentials, a query, or a fragment.')
  }
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\/embeddings$/, '')
  if (!pathname) pathname = '/v1'
  url.pathname = pathname + '/embeddings'
  return url
}
export function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  )
}
/** The shared-files adapter only targets a server on this machine. */
export function myAgentUrl(base: string): string {
  const url = new URL(base)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !isLoopback(url) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  ) {
    throw new Error(
      'Use a localhost MyAgent server URL without credentials or a path, for example http://127.0.0.1:5187.',
    )
  }
  return url.origin
}
export function credentialScope(s: RagSettings): string {
  return s.backend === 'myagent'
    ? `myagent:${myAgentUrl(s.serverUrl)}`
    : s.backend === 'native'
      ? 'native:multilingual-e5-small'
      : `local:${embeddingUrl(s.baseUrl).origin}`
}
export function validateSettings(raw: unknown): RagSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid embedding settings.')
  const r = raw as Record<string, unknown>,
    s = { ...DEFAULT_RAG_SETTINGS }
  // Existing installations retain their local index until explicitly switched.
  if (
    r.backend !== undefined &&
    r.backend !== 'native' &&
    r.backend !== 'local' &&
    r.backend !== 'myagent'
  )
    throw new Error('Invalid RAG backend.')
  // Settings created before backend selection retain their original local endpoint.
  s.backend = r.backend === 'myagent' ? 'myagent' : r.backend === 'native' ? 'native' : 'local'
  if (r.serverUrl !== undefined && typeof r.serverUrl !== 'string')
    throw new Error('Invalid MyAgent server URL.')
  s.serverUrl = typeof r.serverUrl === 'string' ? r.serverUrl.trim() : s.serverUrl
  if (s.backend === 'myagent') s.serverUrl = myAgentUrl(s.serverUrl)
  for (const key of ['enabled', 'allowRemote'] as const) {
    if (typeof r[key] !== 'boolean') throw new Error(`Invalid ${key}.`)
    s[key] = r[key]
  }
  for (const key of [
    'baseUrl',
    'model',
    'modelRevision',
    'documentPrefix',
    'queryPrefix',
  ] as const) {
    if (typeof r[key] !== 'string' || r[key].length > (key.endsWith('Prefix') ? 1024 : 2048))
      throw new Error(`Invalid ${key}.`)
    s[key] = key.endsWith('Prefix') ? r[key] : r[key].trim()
  }
  const bounds: Record<string, [number, number]> = {
    dimensions: [0, 16384],
    maxInputTokens: [128, 32768],
    chunkTokens: [64, 16000],
    overlapTokens: [0, 1000],
    batchSize: [1, 64],
    concurrency: [1, 8],
    timeoutMs: [1000, 300000],
    topK: [1, 24],
    contextChars: [4000, 64000],
  }
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = r[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be ${min}–${max}.`)
    ;(s as unknown as Record<string, unknown>)[key] = value
  }
  if (r.tokenizer !== 'llama.cpp' && r.tokenizer !== 'conservative')
    throw new Error('Invalid tokenizer mode.')
  s.tokenizer = r.tokenizer
  if (s.backend === 'native') {
    s.model = NATIVE_MODEL
    s.modelRevision = NATIVE_MODEL_REVISION
    s.dimensions = 384
    s.documentPrefix = 'passage: '
    s.queryPrefix = 'query: '
    s.tokenizer = 'conservative'
    s.maxInputTokens = 512
    s.chunkTokens = Math.min(s.chunkTokens, 384)
    s.overlapTokens = Math.min(s.overlapTokens, Math.floor(s.chunkTokens / 4))
  }
  if (s.chunkTokens >= s.maxInputTokens || s.overlapTokens >= s.chunkTokens / 2)
    throw new Error(
      'Chunk tokens must be smaller than the input limit; overlap must be less than half the chunk size.',
    )
  if (s.backend === 'local') {
    const url = embeddingUrl(s.baseUrl)
    if (!isLoopback(url) && !s.allowRemote)
      throw new Error(
        'This endpoint is not loopback. Explicitly allow sending text to a LAN/remote embedding server.',
      )
    s.baseUrl = url.toString().replace(/\/embeddings$/, '')
    if (s.enabled && !s.model)
      throw new Error('Enter the model/alias exposed by your embedding server.')
  }
  return s
}
/** A new model, prefix or parsing policy cannot silently reuse incompatible vectors. */
export function profileId(s: RagSettings): string {
  if (s.backend === 'myagent') return hashText(credentialScope(s))
  if (s.backend === 'native')
    return hashText(
      JSON.stringify({
        version: CHUNKER_VERSION,
        model: NATIVE_MODEL,
        revision: NATIVE_MODEL_REVISION,
        dtype: 'q8',
        chunkTokens: s.chunkTokens,
        overlapTokens: s.overlapTokens,
      }),
    )
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: CHUNKER_VERSION,
        baseUrl: embeddingUrl(s.baseUrl).toString(),
        model: s.model,
        revision: s.modelRevision,
        dimensions: s.dimensions,
        documentPrefix: s.documentPrefix,
        queryPrefix: s.queryPrefix,
        tokenizer: s.tokenizer,
        maxInputTokens: s.maxInputTokens,
        chunkTokens: s.chunkTokens,
        overlapTokens: s.overlapTokens,
      }),
    )
    .digest('hex')
}
export const hashText = (s: string): string => createHash('sha256').update(s).digest('hex')
