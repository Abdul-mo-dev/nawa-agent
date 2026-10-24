import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteEmbeddingProfiles } from '../src/main/remote-models/embeddings'
import { DEFAULT_RAG_SETTINGS, type RagSettings } from '../src/shared/rag-api'
import type { RemoteEmbeddingProfile } from '../src/shared/remote-models-api'

let directory: string, active: RagSettings
const keyBytes = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'test',
  encryptString(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', keyBytes, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decryptString(value: Buffer) {
    const cipher = createDecipheriv('aes-256-gcm', keyBytes, value.subarray(0, 12))
    cipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
  },
}
const rag = {
  settings: vi.fn(async () => ({ settings: active, hasKey: true, databasePath: 'test.sqlite' })),
  save: vi.fn(async (settings: RagSettings, _key?: string) => {
    active = settings
    return rag.settings()
  }),
  test: vi.fn(async (_settings: unknown, _key?: string) => ({
    dimensions: 3,
    message: 'verified',
  })),
  models: vi.fn(async (_settings: unknown, _key?: string) => ['embedding-model']),
}
const profile: RemoteEmbeddingProfile = {
  id: 'remote-alpha',
  name: 'Remote embedding',
  baseUrl: 'https://models.example/v1',
  model: 'embedding-model',
  modelRevision: 'v1',
  dimensions: 3,
  maxInputTokens: 8192,
  documentPrefix: 'document: ',
  queryPrefix: 'query: ',
  allowRemote: true,
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nawa-remote-embedding-'))
  active = { ...DEFAULT_RAG_SETTINGS }
  vi.clearAllMocks()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
const service = () => new RemoteEmbeddingProfiles(directory, storage, rag)
it('persists multiple named connections, encrypts keys, and lists only key-presence flags after restart', async () => {
  let api = service(),
    state = await api.list()
  state = await api.save(profile, state.revision, 'alpha-secret')
  state = await api.save(
    { ...profile, id: 'remote-beta', name: 'Second server', baseUrl: 'https://other.example/v1' },
    state.revision,
    'beta-secret',
  )
  const disk = await readFile(join(directory, 'remote-models/embedding-profiles-v1.json'), 'utf8')
  expect(disk).not.toContain('alpha-secret')
  expect(disk).not.toContain('beta-secret')
  api = service()
  expect(await api.list()).toEqual(state)
  expect(state.profiles.map((item) => item.hasKey)).toEqual([true, true])
  expect(JSON.stringify(state)).not.toContain('secret')
})
it('tests and applies the selected profile with its own key, prefixes, model and context without changing other profiles', async () => {
  const api = service()
  let state = await api.save(profile, (await api.list()).revision, 'alpha-secret')
  state = await api.save(
    { ...profile, id: 'remote-beta', name: 'Other model', model: 'another-model' },
    state.revision,
    'beta-secret',
  )
  await api.test(state.profiles[0])
  expect(rag.test).toHaveBeenLastCalledWith(
    expect.objectContaining({
      model: 'embedding-model',
      documentPrefix: 'document: ',
      tokenizer: 'conservative',
    }),
    'alpha-secret',
  )
  await api.models({ ...state.profiles[1], model: '' })
  expect(rag.models).toHaveBeenLastCalledWith(expect.anything(), 'beta-secret')
  await api.models({ ...state.profiles[1], model: '', allowRemote: false })
  expect(rag.models).toHaveBeenLastCalledWith(
    expect.objectContaining({ enabled: false, allowRemote: true, timeoutMs: 5000 }),
    'beta-secret',
  )
  const before = await api.list()
  await api.apply('remote-beta', before.revision)
  expect(rag.save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      model: 'another-model',
      allowRemote: true,
      maxInputTokens: 8192,
      dimensions: 3,
    }),
    'beta-secret',
  )
  expect(await api.list()).toEqual(before)
})
it('retains keys on edits, keeps profile order, and requires new credentials when changing servers', async () => {
  const api = service()
  let state = await api.save(profile, (await api.list()).revision, 'alpha-secret')
  state = await api.save({ ...profile, id: 'remote-beta', name: 'Other' }, state.revision, '')
  state = await api.save({ ...profile, name: 'Renamed' }, state.revision)
  expect(state.profiles.map((item) => item.id)).toEqual(['remote-alpha', 'remote-beta'])
  await api.test(state.profiles[0])
  expect(rag.test).toHaveBeenLastCalledWith(expect.anything(), 'alpha-secret')
  await expect(
    api.save({ ...profile, baseUrl: 'https://changed.example/v1' }, state.revision),
  ).rejects.toThrow('server address changed')
  state = await api.save({ ...profile, baseUrl: 'https://changed.example/v1' }, state.revision, '')
  expect(state.profiles[0].hasKey).toBe(false)
})
it('rejects conflicting edits and concurrent stale saves instead of losing profiles', async () => {
  const api = service(),
    initial = await api.list()
  const first = api.save(profile, initial.revision, '')
  const second = api.save({ ...profile, id: 'remote-beta' }, initial.revision, '')
  await first
  await expect(second).rejects.toThrow('profiles changed')
  await expect(api.remove(profile.id, initial.revision)).rejects.toThrow('profiles changed')
  expect((await api.list()).profiles).toHaveLength(1)
})
it('requires explicit remote consent and secure storage for nonempty keys', async () => {
  const api = service(),
    initial = await api.list()
  await expect(api.save({ ...profile, allowRemote: false }, initial.revision, '')).rejects.toThrow(
    'Explicitly allow',
  )
  const insecure = new RemoteEmbeddingProfiles(
    directory,
    { ...storage, getSelectedStorageBackend: () => 'basic_text' },
    rag,
  )
  await expect(insecure.save(profile, initial.revision, 'secret')).rejects.toThrow(
    'Secure OS storage',
  )
  expect((await api.list()).profiles).toEqual([])
  await expect(
    api.save(
      { ...profile, baseUrl: 'https://user:password@models.example/v1' },
      initial.revision,
      '',
    ),
  ).rejects.toThrow('credentials')
})
it('preserves an API base path supplied by a remote provider', async () => {
  const api = service(),
    baseUrl = 'https://models.example/proxy/openai'
  const saved = await api.save({ ...profile, baseUrl }, (await api.list()).revision, '')
  expect(saved.profiles[0].baseUrl).toBe(baseUrl)
  await api.test(saved.profiles[0])
  expect(rag.test).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl }), '')
})
it('protects the active connection and deletes inactive profiles and their saved credentials', async () => {
  const api = service(),
    state = await api.save(profile, (await api.list()).revision, 'secret')
  await api.apply(profile.id, state.revision)
  await expect(api.remove(profile.id, state.revision)).rejects.toThrow('active profile')
  active = { ...active, enabled: false }
  expect((await api.remove(profile.id, state.revision)).profiles).toEqual([])
  expect(
    await readFile(join(directory, 'remote-models/embedding-profiles-v1.json'), 'utf8'),
  ).not.toContain('encryptedKey')
})
