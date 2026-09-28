import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { MyAgentConfiguration, MyAgentConfigPatch, MyAgentLaunchSettings } from '../../shared/myagent-settings-api'

export const revision = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected MyAgent settings.')
  return value as Record<string, unknown>
}
const text = (value: unknown, name: string, max = 4096): string => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}.`)
  return value.trim()
}
const number = (value: unknown, name: string, min: number, max: number): number => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${name} (${min}–${max}).`)
  return value as number
}
const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('Invalid MyAgent option.'); return value }
export function sanitize<T>(value: T, secrets: string[] = []): T {
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return secrets.filter(Boolean).reduce((s, key) => s.replaceAll(key, '[redacted]'), input)
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([key]) => !/(?:api[_-]?key|password|secret|accessToken|refreshToken)$/i.test(key)).map(([key, item]) => [key, walk(item)]))
    return input
  }
  return walk(value) as T
}
export function launchSettings(raw: unknown): MyAgentLaunchSettings {
  const r = object(raw)
  if (r.mode !== 'service' && r.mode !== 'process') throw new Error('Choose Windows service or server process.')
  const serverPath = text(r.serverPath, 'server path'), configurationDirectory = text(r.configurationDirectory, 'configuration directory')
  if (serverPath && (!isAbsolute(serverPath) || !/[/\\]MyAgent\.Server\.(exe|dll)$/i.test(serverPath))) throw new Error('Choose MyAgent.Server.exe or MyAgent.Server.dll using an absolute path.')
  if (!isAbsolute(configurationDirectory)) throw new Error('Choose an absolute configuration directory.')
  return { mode: r.mode, serverPath, configurationDirectory }
}
export function updateConfiguration(current: MyAgentConfiguration, raw: unknown): Record<string, unknown> {
  const r = object(raw), p = object(r.provider), a = object(r.rag)
  const endpoint = (value: unknown, name: string): string => {
    const result = text(value, name)
    if (result) { const url = new URL(result); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error(`Invalid ${name}.`) }
    return result
  }
  const credential = (value: unknown): string | undefined => value === undefined ? undefined : text(value, 'provider key', 8192)
  if (!Array.isArray(a.roots) || a.roots.length > 256) throw new Error('At most 256 shared RAG folders are supported.')
  const ids = new Set<string>()
  const roots = a.roots.map(rawRoot => {
    const root = object(rawRoot), id = text(root.id, 'folder ID', 128), path = text(root.path, 'folder path'), displayName = text(root.displayName, 'folder name', 256)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ids.has(id.toLowerCase()) || !displayName || !isAbsolute(path)) throw new Error('Each RAG folder needs a unique ID, name, and absolute local path.')
    ids.add(id.toLowerCase()); return { id, displayName, path }
  })
  if (!Array.isArray(a.allowedExtensions) || !a.allowedExtensions.length || a.allowedExtensions.length > 100 || a.allowedExtensions.some(e => typeof e !== 'string' || !/^\.[a-zA-Z0-9]+$/.test(e))) throw new Error('Use file extensions such as .pdf, .docx, and .xlsx.')
  if (!['None', 'AssetsOnly', 'OcrOnly', 'VlmCaption', 'VlmDetailed', 'OcrAndVlm'].includes(text(a.visualMode, 'visual mode'))) throw new Error('Choose a supported visual extraction mode.')
  const provider: MyAgentConfigPatch['provider'] = {
    baseUrl: endpoint(p.baseUrl, 'chat API URL'), model: text(p.model, 'chat model', 512),
    managedLlamaProfileId: text(p.managedLlamaProfileId, 'chat runtime ID', 256),
    contextWindowTokens: number(p.contextWindowTokens, 'context window', 0, 10000000),
    maximumOutputTokens: number(p.maximumOutputTokens, 'output token limit', 0, 1000000),
    requestTimeoutSeconds: number(p.requestTimeoutSeconds, 'chat timeout', 1, 3600),
    maximumConcurrentRequests: number(p.maximumConcurrentRequests, 'chat concurrency', 1, 64),
    ...(p.apiKey !== undefined ? { apiKey: credential(p.apiKey) } : {}),
    ...(p.clearApiKey !== undefined ? { clearApiKey: boolean(p.clearApiKey) } : {}),
  }
  if (provider.apiKey && provider.clearApiKey) throw new Error('Replace or remove the chat provider key, not both.')
  if ((provider.contextWindowTokens === 0) !== (provider.maximumOutputTokens === 0) || provider.contextWindowTokens > 0 && provider.maximumOutputTokens >= provider.contextWindowTokens) throw new Error('Configure both token limits, with output smaller than context, or set both to zero.')
  const rag = {
    ...current.rag, roots, embeddingBaseUrl: endpoint(a.embeddingBaseUrl, 'embedding API URL'),
    embeddingModel: text(a.embeddingModel, 'embedding model', 512), managedLlamaProfileId: text(a.managedLlamaProfileId, 'embedding runtime ID', 256),
    allowRemoteEmbeddings: boolean(a.allowRemoteEmbeddings),
    embeddingBatchSize: number(a.embeddingBatchSize, 'embedding batch size', 1, 1000),
    embeddingRequestTimeoutSeconds: number(a.embeddingRequestTimeoutSeconds, 'embedding timeout', 1, 3600),
    maxFilesPerJob: number(a.maxFilesPerJob, 'files per indexing job', 1, 10000),
    maxFileSizeMb: number(a.maxFileSizeMb, 'file size limit', 1, 10240),
    allowedExtensions: [...new Set(a.allowedExtensions.map(e => (e as string).toLowerCase()))],
    visualMode: text(a.visualMode, 'visual mode'), visualModel: text(a.visualModel, 'visual model', 512),
    allowRemoteVisualExtraction: boolean(a.allowRemoteVisualExtraction),
    maxPages: number(a.maxPages, 'page limit', 0, 10000),
    extractEmbeddedImages: boolean(a.extractEmbeddedImages), renderVisualPages: boolean(a.renderVisualPages),
    maxImagesPerFile: number(a.maxImagesPerFile, 'image limit', 0, 10000),
    visualExtractionTimeoutSeconds: number(a.visualExtractionTimeoutSeconds, 'visual extraction timeout', 1, 3600),
    visualExtractionRetryCount: number(a.visualExtractionRetryCount, 'visual extraction retries', 0, 20),
    tesseractPath: text(a.tesseractPath, 'Tesseract path'), libreOfficePath: text(a.libreOfficePath, 'LibreOffice path'),
    ...(a.embeddingApiKey !== undefined ? { embeddingApiKey: credential(a.embeddingApiKey) } : {}),
    ...(a.clearEmbeddingApiKey !== undefined ? { clearEmbeddingApiKey: boolean(a.clearEmbeddingApiKey) } : {}),
  }
  if (rag.embeddingApiKey && rag.clearEmbeddingApiKey) throw new Error('Replace or remove the embedding key, not both.')
  delete (rag as Partial<typeof rag>).embeddingApiKeyConfigured
  return { workspacesRoot: current.workspacesRoot, skillsRoot: current.skillsRoot, provider, llama: current.llama, rag, ...(current.runtime ? { runtime: current.runtime } : {}) }
}
