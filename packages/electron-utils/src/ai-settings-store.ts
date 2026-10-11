import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { saveFileWithStagingSync } from './atomic-write'

export const PROTECTED_AI_KEY_PREFIX = 'nawa-safe:v1:'

export interface AiKeyStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Only credential fields are transformed; provider and model metadata stays readable. */
function transformKeys(value: JsonObject, transform: (key: string) => string): JsonObject {
  const result = structuredClone(value)
  const config = (candidate: unknown) => {
    if (object(candidate) && typeof candidate.apiKey === 'string')
      candidate.apiKey = transform(candidate.apiKey)
  }
  config(result)
  for (const group of [
    result.providers,
    object(result.media) && result.media.providers,
    object(result.search) && result.search.providers,
  ]) {
    if (object(group)) for (const entry of Object.values(group)) config(entry)
  }
  if (Array.isArray(result.chatModels))
    for (const profile of result.chatModels) {
      if (object(profile)) config(profile.config)
    }
  if (Array.isArray(result.customEndpoints))
    for (const endpoint of result.customEndpoints) config(endpoint)
  if (object(result.fileSearch) && object(result.fileSearch.keys)) {
    for (const [endpoint, key] of Object.entries(result.fileSearch.keys)) {
      if (typeof key === 'string') result.fileSearch.keys[endpoint] = transform(key)
    }
  }
  return result
}

/** Non-Electron tools may read non-secret preferences, but cannot use protected keys. */
export function withoutProtectedAiKeys<T extends object>(settings: T): T {
  return transformKeys(settings as JsonObject, (key) =>
    key.startsWith(PROTECTED_AI_KEY_PREFIX) ? '' : key,
  ) as T
}

export function createAiSettingsStore(storage: AiKeyStorage) {
  const revision = (path: string): string =>
    createHash('sha256')
      .update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0))
      .digest('hex')
  const secure = () => {
    if (
      !storage.isEncryptionAvailable() ||
      storage.getSelectedStorageBackend?.() === 'basic_text'
    ) {
      throw new Error('Secure OS storage is unavailable. AI API keys were not saved.')
    }
  }
  const write = (path: string, settings: object, expectedRevision?: string): void => {
    if (expectedRevision !== undefined && revision(path) !== expectedRevision) {
      throw new Error(
        'AI settings changed in another editor. Reload current settings before saving.',
      )
    }
    const protectedSettings = transformKeys(settings as JsonObject, (key) => {
      if (!key) return ''
      if (key.startsWith(PROTECTED_AI_KEY_PREFIX)) throw new Error('Invalid AI API key value.')
      secure()
      return PROTECTED_AI_KEY_PREFIX + storage.encryptString(key).toString('base64')
    })
    delete protectedSettings.settingsRevision
    delete protectedSettings.selectedChatModelId
    mkdirSync(dirname(path), { recursive: true })
    saveFileWithStagingSync(path, JSON.stringify(protectedSettings, null, 2), { mode: 0o600 })
  }
  const read = <T extends object>(path: string, fallback: T): T => {
    if (!existsSync(path)) return fallback
    const stored = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!object(stored)) throw new Error('AI settings file must contain an object.')
    let legacyKey = false
    const settings = transformKeys(stored, (key) => {
      if (!key) return ''
      if (!key.startsWith(PROTECTED_AI_KEY_PREFIX)) {
        legacyKey = true
        return key
      }
      secure()
      return storage.decryptString(Buffer.from(key.slice(PROTECTED_AI_KEY_PREFIX.length), 'base64'))
    }) as T
    // Migrate legacy plaintext credentials as soon as a main process reads them.
    if (legacyKey) write(path, settings)
    return settings
  }
  return { read, write, revision }
}
