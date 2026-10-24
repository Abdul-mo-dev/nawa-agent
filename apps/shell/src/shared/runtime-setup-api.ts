import type { LocalModelProfile } from './local-models-api'

export const RUNTIME_SETUP_CHANNEL = 'nawa:runtime-setup:v1'
export interface RuntimeSetupOptions {
  chatModel: boolean
  embeddingModel: boolean
  runtime: boolean
  office: boolean
  startModels: boolean
  useDefaults: boolean
  backend: 'cuda' | 'cpu' | 'vulkan'
}
export interface RuntimeSetupSnapshot {
  supported: boolean
  offer: boolean
  state: 'idle' | 'installing' | 'ready' | 'failed' | 'canceled'
  stage: string
  received: number
  total: number
  error?: string
  directory: string
  ocr: boolean
  office: string | null
  needsActivation: boolean
  activationKinds: LocalModelProfile['kind'][]
  runtime: string | null
  reuseRuntime: boolean
  profiles: LocalModelProfile[]
}
export interface RuntimeSetupApi {
  inspect(): Promise<RuntimeSetupSnapshot>
  install(options: RuntimeSetupOptions): Promise<RuntimeSetupSnapshot>
  cancel(): Promise<void>
  dismiss(): Promise<void>
  activated(kinds?: LocalModelProfile['kind'][]): Promise<void>
  reveal(): Promise<void>
  openLanguages(): Promise<void>
}
declare global {
  interface Window {
    nawaRuntimeSetup?: RuntimeSetupApi
  }
}
