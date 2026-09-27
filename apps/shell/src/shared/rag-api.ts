/** Public RAG contract. Secrets never appear in settings returned to the renderer. */
export const RAG_CHANNEL = 'nawa:rag:v1'
export const RAG_CHANGED = 'nawa:rag:changed'
export type RagState = 'not-indexed' | 'embedding' | 'embedded' | 'stale' | 'failed'
export interface RagSettings {
  backend: 'local' | 'myagent'
  serverUrl: string
  enabled: boolean
  baseUrl: string
  model: string
  modelRevision: string
  allowRemote: boolean
  dimensions: number
  documentPrefix: string
  queryPrefix: string
  tokenizer: 'llama.cpp' | 'conservative'
  maxInputTokens: number
  chunkTokens: number
  overlapTokens: number
  batchSize: number
  concurrency: number
  timeoutMs: number
  topK: number
  contextChars: number
}
export const DEFAULT_RAG_SETTINGS: RagSettings = {
  backend: 'myagent', serverUrl: 'http://127.0.0.1:5187',
  enabled: false, baseUrl: 'http://127.0.0.1:8081/v1', model: '', modelRevision: '',
  allowRemote: false, dimensions: 0, documentPrefix: '', queryPrefix: '',
  tokenizer: 'llama.cpp', maxInputTokens: 512, chunkTokens: 384, overlapTokens: 48,
  batchSize: 8, concurrency: 2, timeoutMs: 60000, topK: 8, contextChars: 24000,
}
export interface RagSettingsView { settings: RagSettings; hasKey: boolean; databasePath: string }
export interface RagFileStatus {
  path: string; status: RagState; chunks: number; indexedAt?: number
  sourceHash?: string; error?: string; warnings?: string[]; partial?: boolean
}
export interface RagProgress {
  running: boolean; folder: string; scanned: number; embedded: number; unchanged: number
  failed: number; chunks: number; current: string; message: string; incomplete: boolean
}
export interface RagApi {
  settings(): Promise<RagSettingsView>
  save(settings: RagSettings, apiKey?: string): Promise<RagSettingsView>
  test(settings: RagSettings, apiKey?: string): Promise<{ dimensions: number; message: string }>
  index(folder: string, recursive: boolean, consent: boolean): Promise<RagProgress>
  progress(): Promise<RagProgress>
  cancel(): Promise<void>
  statuses(paths: string[], verify?: boolean): Promise<RagFileStatus[]>
  clear(folder: string): Promise<void>
  onChanged(callback: () => void): () => void
}
declare global { interface Window { nawaRag: RagApi } }
