/** Local model administration is available to settings, never to agent tools. */
export const LOCAL_MODELS_CHANNEL = 'nawa:local-models:v1'
export interface ModelArgument {
  enabled: boolean
  name: string
  value: string
}
export interface LocalModelProfile {
  id: string
  name: string
  /** OpenAI model name; old profiles use their stable profile ID. */
  alias?: string
  kind: 'chat' | 'embedding'
  modelPath: string
  port: number
  contextSize: number
  gpuLayers: number | 'auto'
  threads: number
  pooling: 'model' | 'mean' | 'cls' | 'last'
  autoStart: boolean
  arguments: ModelArgument[]
}
export interface LocalModelsConfig {
  executablePath: string
  profiles: LocalModelProfile[]
}
export interface LocalModelRuntime {
  id: string
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
  pid?: number
  error?: string
  logs: string
}
export interface LocalModelFile {
  path: string
  name: string
  bytes: number
}
export interface LocalEngineAsset {
  id: number
  name: string
  bytes: number
  digest: string
  url: string
}
export interface LocalEngineRelease {
  tag: string
  prerelease?: boolean
  assets: LocalEngineAsset[]
}
export interface RemoteModelFile {
  repository: string
  revision: string
  name: string
  bytes: number
  sha256: string
}
export interface LocalModelDownload {
  state: 'idle' | 'downloading' | 'completed' | 'failed' | 'canceled'
  name: string
  received: number
  total: number
  error?: string
}
export interface LocalModelsSnapshot {
  config: LocalModelsConfig
  revision: string
  runtimes: LocalModelRuntime[]
  models: LocalModelFile[]
  engines: string[]
  directory: string
  download: LocalModelDownload
}
export interface LocalModelsApi {
  inspect(): Promise<LocalModelsSnapshot>
  save(config: LocalModelsConfig, revision: string): Promise<LocalModelsSnapshot>
  control(action: 'start' | 'stop' | 'restart', id: string): Promise<LocalModelsSnapshot>
  choosePath(kind: 'engine' | 'model'): Promise<string | null>
  releases(): Promise<LocalEngineRelease>
  installEngine(assetId: number): Promise<void>
  searchModels(query: string): Promise<string[]>
  modelFiles(repository: string): Promise<RemoteModelFile[]>
  downloadModel(repository: string, revision: string, name: string): Promise<void>
  cancelDownload(): Promise<void>
  removeModel(path: string): Promise<LocalModelsSnapshot>
  revealDirectory(): Promise<void>
}
declare global {
  interface Window {
    nawaLocalModels: LocalModelsApi
  }
}
