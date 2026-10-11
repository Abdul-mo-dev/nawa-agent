import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAiSettingsStore,
  withoutProtectedAiKeys,
  type AiKeyStorage,
} from '../src/ai-settings-store'

const directories: string[] = []
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nawa-ai-settings-'))
  directories.push(dir)
  return join(dir, 'ai-settings.json')
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const storage: AiKeyStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'os_crypt',
  encryptString: (value) => Buffer.from(`protected:${value}`),
  decryptString: (value) => value.toString().replace(/^protected:/, ''),
}

const settings = () => ({
  provider: 'custom',
  apiKey: 'legacy-secret',
  providers: { custom: { model: 'local', apiKey: 'chat-secret' } },
  chatModels: [{ id: 'writer', config: { model: 'writer', apiKey: 'profile-secret' } }],
  customEndpoints: [{ id: 'secondary', model: 'local', apiKey: 'endpoint-secret' }],
  media: { providers: { openai: { apiKey: 'media-secret' } } },
  search: { providers: { tavily: { apiKey: 'search-secret' } } },
  language: 'ar',
  fileSearch: {
    rerank: true,
    endpoint: 'openrouter',
    keys: { openrouter: 'rerank-secret', custom: '' },
  },
})

describe('protected AI settings', () => {
  it('protects every credential field and restores the editable settings', () => {
    const path = fixture(),
      store = createAiSettingsStore(storage),
      value = settings()
    store.write(path, value)
    const disk = readFileSync(path, 'utf8')
    for (const secret of [
      'legacy-secret',
      'chat-secret',
      'profile-secret',
      'endpoint-secret',
      'media-secret',
      'search-secret',
      'rerank-secret',
    ]) {
      expect(disk).not.toContain(secret)
    }
    expect(store.read(path, {})).toEqual(value)
    const publicSettings = withoutProtectedAiKeys(JSON.parse(disk)) as ReturnType<typeof settings>
    expect(publicSettings.providers.custom.apiKey).toBe('')
    expect(publicSettings.chatModels[0].config.apiKey).toBe('')
    expect(publicSettings.customEndpoints[0].apiKey).toBe('')
    expect(publicSettings.media.providers.openai.apiKey).toBe('')
    expect(publicSettings.search.providers.tavily.apiKey).toBe('')
    expect(publicSettings.fileSearch.keys.openrouter).toBe('')
    expect(publicSettings.language).toBe('ar')
  })

  it('migrates existing plaintext keys on first read', () => {
    const path = fixture(),
      value = settings()
    writeFileSync(path, JSON.stringify(value))
    expect(createAiSettingsStore(storage).read(path, {})).toEqual(value)
    expect(readFileSync(path, 'utf8')).not.toContain('chat-secret')
  })

  it('keeps the previous file when secure storage is unavailable', () => {
    const path = fixture(),
      store = createAiSettingsStore(storage)
    store.write(path, settings())
    const original = readFileSync(path, 'utf8')
    const unavailable = createAiSettingsStore({ ...storage, isEncryptionAvailable: () => false })
    expect(() => unavailable.write(path, settings())).toThrow('Secure OS storage is unavailable')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('rejects a stale full-settings save without replacing newer edits', () => {
    const path = fixture(),
      store = createAiSettingsStore(storage)
    store.write(path, settings())
    const staleRevision = store.revision(path)
    store.write(
      path,
      { ...settings(), provider: 'openai', settingsRevision: staleRevision },
      staleRevision,
    )
    const newerFile = readFileSync(path, 'utf8')
    expect(newerFile).not.toContain('settingsRevision')
    expect(() => store.write(path, settings(), staleRevision)).toThrow(
      'AI settings changed in another editor',
    )
    expect(readFileSync(path, 'utf8')).toBe(newerFile)
  })

  it('reports malformed JSON instead of replacing stored settings with defaults', () => {
    const path = fixture()
    writeFileSync(path, '{broken')
    expect(() => createAiSettingsStore(storage).read(path, {})).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})
