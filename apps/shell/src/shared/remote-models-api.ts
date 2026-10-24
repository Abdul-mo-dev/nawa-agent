import type { RagSettingsView } from './rag-api'

export const REMOTE_EMBEDDING_CHANNEL = 'nawa:remote-embeddings:v1'
export const REMOTE_EMBEDDING_CHANGED = 'nawa:remote-embeddings:changed'
export interface RemoteEmbeddingProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  modelRevision: string
  dimensions: number
  maxInputTokens: number
  documentPrefix: string
  queryPrefix: string
  allowRemote: boolean
}
export interface RemoteEmbeddingView extends RemoteEmbeddingProfile {
  hasKey: boolean
}
export interface RemoteEmbeddingSnapshot {
  revision: string
  profiles: RemoteEmbeddingView[]
}
export interface RemoteEmbeddingApi {
  list(): Promise<RemoteEmbeddingSnapshot>
  save(
    profile: RemoteEmbeddingProfile,
    revision: string,
    apiKey?: string,
  ): Promise<RemoteEmbeddingSnapshot>
  remove(id: string, revision: string): Promise<RemoteEmbeddingSnapshot>
  apply(id: string, revision: string): Promise<RagSettingsView>
  test(
    profile: RemoteEmbeddingProfile,
    apiKey?: string,
  ): Promise<{ dimensions: number; message: string }>
  models(profile: RemoteEmbeddingProfile, apiKey?: string): Promise<string[]>
  onChanged(callback: () => void): () => void
}
declare global {
  interface Window {
    nawaRemoteEmbeddings: RemoteEmbeddingApi
  }
}
