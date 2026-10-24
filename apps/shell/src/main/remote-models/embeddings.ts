import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiKeyStorage } from '@genoffice/electron-utils/ai-settings-store'
import { DEFAULT_RAG_SETTINGS, type RagSettings } from '../../shared/rag-api'
import type {
  RemoteEmbeddingProfile,
  RemoteEmbeddingSnapshot,
} from '../../shared/remote-models-api'
import { validateSettings } from '../rag/config'
import type { RagService } from '../rag/service'

interface SavedProfile {
  profile: RemoteEmbeddingProfile
  encryptedKey: string
}
type Rag = Pick<RagService, 'settings' | 'save' | 'test' | 'models'>
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export function remoteEmbeddingSettings(
  profile: RemoteEmbeddingProfile,
  current = DEFAULT_RAG_SETTINGS,
): RagSettings {
  const chunkTokens = Math.min(current.chunkTokens, profile.maxInputTokens - 1)
  return validateSettings({
    ...current,
    backend: 'local',
    enabled: true,
    baseUrl: profile.baseUrl,
    model: profile.model,
    modelRevision: profile.modelRevision,
    dimensions: profile.dimensions,
    documentPrefix: profile.documentPrefix,
    queryPrefix: profile.queryPrefix,
    maxInputTokens: profile.maxInputTokens,
    allowRemote: profile.allowRemote,
    tokenizer: 'conservative',
    chunkTokens,
    overlapTokens: Math.min(current.overlapTokens, Math.floor(chunkTokens / 4)),
  })
}
function normalize(raw: unknown, requireModel = true): RemoteEmbeddingProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid embedding profile.')
  const p = raw as RemoteEmbeddingProfile
  if (
    typeof p.id !== 'string' ||
    !/^remote-[a-zA-Z0-9-]{1,112}$/.test(p.id) ||
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    p.name.length > 160
  )
    throw new Error('Enter a profile name and valid identity.')
  const settings = validateSettings({
    ...DEFAULT_RAG_SETTINGS,
    ...p,
    backend: 'local',
    enabled: requireModel,
    tokenizer: 'conservative',
    chunkTokens: Math.min(384, p.maxInputTokens - 1),
    overlapTokens: Math.min(48, Math.floor((p.maxInputTokens - 1) / 4)),
  })
  return {
    id: p.id,
    name: p.name.trim(),
    baseUrl: settings.baseUrl,
    model: settings.model,
    modelRevision: settings.modelRevision,
    dimensions: settings.dimensions,
    maxInputTokens: settings.maxInputTokens,
    documentPrefix: settings.documentPrefix,
    queryPrefix: settings.queryPrefix,
    allowRemote: settings.allowRemote,
  }
}
export class RemoteEmbeddingProfiles {
  private file: string
  private mutations: Promise<unknown> = Promise.resolve()
  constructor(
    directory: string,
    private storage: AiKeyStorage,
    private rag: Rag,
  ) {
    this.file = join(directory, 'remote-models/embedding-profiles-v1.json')
  }
  private async read(): Promise<{ revision: string; profiles: SavedProfile[] }> {
    let bytes: string
    try {
      bytes = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { revision: digest(''), profiles: [] }
      throw error
    }
    if (Buffer.byteLength(bytes) > 2 * 1024 ** 2)
      throw new Error('Embedding profile storage is too large.')
    const data = JSON.parse(bytes) as { version: number; profiles: SavedProfile[] }
    if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 64)
      throw new Error('Invalid embedding profile storage.')
    const ids = new Set<string>()
    const profiles = data.profiles.map((row) => {
      const profile = normalize(row.profile)
      if (
        ids.has(profile.id) ||
        typeof row.encryptedKey !== 'string' ||
        row.encryptedKey.length > 65536
      )
        throw new Error('Invalid embedding profile storage.')
      ids.add(profile.id)
      return { profile, encryptedKey: row.encryptedKey }
    })
    return { revision: digest(bytes), profiles }
  }
  private async checked(revision: unknown) {
    const current = await this.read()
    if (typeof revision !== 'string' || revision !== current.revision)
      throw new Error('Remote profiles changed. Reload them before saving.')
    return current
  }
  private secure() {
    if (
      !this.storage.isEncryptionAvailable() ||
      this.storage.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw new Error('Secure OS storage is unavailable. No API key was saved.')
  }
  private async key(profile: RemoteEmbeddingProfile, replacement?: string): Promise<string> {
    if (replacement !== undefined) {
      if (
        typeof replacement !== 'string' ||
        replacement.length > 8192 ||
        /[\0\r\n]/.test(replacement)
      )
        throw new Error('Invalid API key.')
      return replacement.trim()
    }
    const previous = (await this.read()).profiles.find((row) => row.profile.id === profile.id)
    if (!previous?.encryptedKey) return ''
    if (previous.profile.baseUrl !== profile.baseUrl)
      throw new Error('The server address changed. Re-enter or explicitly remove its API key.')
    this.secure()
    return this.storage.decryptString(Buffer.from(previous.encryptedKey, 'base64'))
  }
  private async write(profiles: SavedProfile[]) {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await mkdir(dirname(this.file), { recursive: true })
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, profiles }, null, 2), {
        mode: 0o600,
        flag: 'wx',
      })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(work, work)
    this.mutations = result.catch(() => undefined)
    return result
  }
  async list(): Promise<RemoteEmbeddingSnapshot> {
    const current = await this.read()
    return {
      revision: current.revision,
      profiles: current.profiles.map((row) => ({ ...row.profile, hasKey: !!row.encryptedKey })),
    }
  }
  save(raw: unknown, revision: unknown, replacement?: string): Promise<RemoteEmbeddingSnapshot> {
    return this.transaction(async () => {
      const current = await this.checked(revision),
        profile = normalize(raw),
        key = await this.key(profile, replacement)
      if (key) this.secure()
      const row = {
        profile,
        encryptedKey: key ? this.storage.encryptString(key).toString('base64') : '',
      }
      const exists = current.profiles.some((item) => item.profile.id === profile.id)
      const profiles = exists
        ? current.profiles.map((item) => (item.profile.id === profile.id ? row : item))
        : [...current.profiles, row]
      if (profiles.length > 64) throw new Error('Use at most 64 embedding profiles.')
      await this.write(profiles)
      return this.list()
    })
  }
  remove(id: unknown, revision: unknown): Promise<RemoteEmbeddingSnapshot> {
    return this.transaction(async () => {
      const current = await this.checked(revision)
      const selected = current.profiles.find((row) => row.profile.id === id)
      if (!selected) throw new Error('Profile no longer exists.')
      const active = (await this.rag.settings()).settings
      if (
        active.enabled &&
        active.backend === 'local' &&
        active.baseUrl.replace(/\/+$/, '') === selected.profile.baseUrl &&
        active.model === selected.profile.model
      )
        throw new Error(
          'Choose another embedding connection or disable file search before removing its active profile.',
        )
      await this.write(current.profiles.filter((row) => row.profile.id !== id))
      return this.list()
    })
  }
  apply(id: unknown, revision: unknown) {
    return this.transaction(async () => {
      const current = await this.checked(revision),
        row = current.profiles.find((item) => item.profile.id === id)
      if (!row) throw new Error('Profile no longer exists.')
      const settings = remoteEmbeddingSettings(row.profile, (await this.rag.settings()).settings)
      return this.rag.save(settings, await this.key(row.profile))
    })
  }
  async test(raw: unknown, replacement?: string) {
    const profile = normalize(raw)
    return this.rag.test(remoteEmbeddingSettings(profile), await this.key(profile, replacement))
  }
  async models(raw: unknown, replacement?: string) {
    const profile = normalize(raw, false)
    const settings = {
      ...DEFAULT_RAG_SETTINGS,
      ...profile,
      backend: 'local' as const,
      enabled: false,
      tokenizer: 'conservative' as const,
      chunkTokens: Math.min(384, profile.maxInputTokens - 1),
      overlapTokens: Math.min(48, Math.floor((profile.maxInputTokens - 1) / 4)),
    }
    return this.rag.models(settings, await this.key(profile, replacement))
  }
}
