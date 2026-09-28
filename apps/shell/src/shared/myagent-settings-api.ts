/** MyAgent administration is user-controlled and never exposed as an agent tool. */
import type { MyAgentToolDefinition } from './myagent-tools-api'
export const MYAGENT_SETTINGS_CHANNEL = 'nawa:myagent-settings:v1'
export interface MyAgentRoot { id: string; displayName: string; path: string }
export interface MyAgentProvider {
  baseUrl: string; model: string; apiKeyConfigured: boolean; managedLlamaProfileId: string
  contextWindowTokens: number; maximumOutputTokens: number; requestTimeoutSeconds: number
  maximumConcurrentRequests: number
}
export interface MyAgentRagConfiguration {
  roots: MyAgentRoot[]; embeddingBaseUrl: string; embeddingModel: string
  embeddingApiKeyConfigured: boolean; managedLlamaProfileId: string; allowRemoteEmbeddings: boolean
  embeddingBatchSize: number; embeddingRequestTimeoutSeconds: number
  allowedExtensions: string[]; maxFilesPerJob: number; maxFileSizeMb: number
  visualMode: string; visualModel: string; allowRemoteVisualExtraction: boolean
  maxPages: number; extractEmbeddedImages: boolean; renderVisualPages: boolean; maxImagesPerFile: number
  visualExtractionTimeoutSeconds: number; visualExtractionRetryCount: number
  tesseractPath: string; libreOfficePath: string
  [field: string]: unknown
}
export interface MyAgentConfiguration {
  configFileName: string; apiKeyConfigured: boolean; remoteUpdatesEnabled: boolean
  allowUnauthenticatedLoopback: boolean; workspacesRoot: string; skillsRoot: string
  provider: MyAgentProvider; llama: { executablePath: string; profilesPath: string }
  rag: MyAgentRagConfiguration; runtime?: Record<string, unknown>
}
export interface MyAgentHealth {
  status: string; version: string; providerConfigured: boolean; userSetupRequired?: boolean
  capabilities: string[]; components?: { name: string; status: string; enabled?: boolean; available?: boolean | null; detail?: string }[]
}
export interface MyAgentReadiness {
  ready: boolean; status: string; providerBaseUrl?: string | null; model?: string | null
  managedProfileId?: string | null; managedProfileState?: string | null; providerAvailable: boolean; startsOnDemand: boolean
}
export interface MyAgentDiagnostics {
  serverUrl: string; checkedAt: string; health: MyAgentHealth | null; readiness: MyAgentReadiness | null
  warnings: string[]
}
export interface MyAgentDocumentTools {
  serverUrl: string; checkedAt: string; tools: MyAgentToolDefinition[]
  total: number; nextOffset: number | null; filtered: boolean
}
export interface MyAgentDocumentToolRequest { query: string; offset: number; extensions?: string[] }
export interface MyAgentProfile {
  id: string; kind: string; displayName: string; model: string; host: string; port: number
  enabled: boolean; modelConfigured: boolean
}
export interface MyAgentRuntime {
  profileId: string; state: string; displayName: string; error?: string | null
}
export interface MyAgentSnapshot {
  serverUrl: string; health: MyAgentHealth; configuration: MyAgentConfiguration | null
  revision: string; profiles: MyAgentProfile[]; runtimes: MyAgentRuntime[]; warnings: string[]
}
export interface MyAgentConfigPatch {
  provider: Omit<MyAgentProvider, 'apiKeyConfigured'> & { apiKey?: string; clearApiKey?: boolean }
  rag: Pick<MyAgentRagConfiguration, 'roots' | 'embeddingBaseUrl' | 'embeddingModel' | 'managedLlamaProfileId' | 'allowRemoteEmbeddings' | 'embeddingBatchSize' | 'embeddingRequestTimeoutSeconds' | 'allowedExtensions' | 'maxFilesPerJob' | 'maxFileSizeMb' | 'visualMode' | 'visualModel' | 'allowRemoteVisualExtraction' | 'maxPages' | 'extractEmbeddedImages' | 'renderVisualPages' | 'maxImagesPerFile' | 'visualExtractionTimeoutSeconds' | 'visualExtractionRetryCount' | 'tesseractPath' | 'libreOfficePath'> & { embeddingApiKey?: string; clearEmbeddingApiKey?: boolean }
}
export interface MyAgentLaunchSettings { mode: 'service' | 'process'; serverPath: string; configurationDirectory: string }
export interface MyAgentLocalView {
  settings: MyAgentLaunchSettings; serviceState: 'not-installed' | 'running' | 'stopped' | 'pending' | 'unavailable'
  processId: number | null; message?: string
}
export interface MyAgentSaveResult {
  snapshot: MyAgentSnapshot; restartRequired: boolean; restartRequiredSettings: string[]
  applied: boolean; warning?: string
}
export interface MyAgentSettingsApi {
  inspect(): Promise<MyAgentSnapshot>
  diagnostics(): Promise<MyAgentDiagnostics>
  documentTools(request: MyAgentDocumentToolRequest): Promise<MyAgentDocumentTools>
  saveConfiguration(serverUrl: string, revision: string, patch: MyAgentConfigPatch): Promise<MyAgentSaveResult>
  local(): Promise<MyAgentLocalView>
  saveLaunch(settings: MyAgentLaunchSettings): Promise<MyAgentLocalView>
  choosePath(kind: 'server' | 'directory'): Promise<string | null>
  generateKey(): Promise<string>
  control(action: 'start' | 'stop' | 'restart'): Promise<{ message: string }>
  model(action: 'start' | 'stop', profileId: string): Promise<MyAgentRuntime>
}
declare global { interface Window { nawaMyAgent: MyAgentSettingsApi } }
