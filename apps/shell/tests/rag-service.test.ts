import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn(), test: vi.fn(), index: vi.fn(), statuses: vi.fn(), clear: vi.fn(), search: vi.fn(), tools: vi.fn(), worker: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => 'rag-service-fixture' }, ipcMain: {},
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'os_crypt', encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/main/directory-actions/file-safety', () => ({ authorizePath: vi.fn(), regularFile: vi.fn(), hashFile: async () => 'verified-hash' }))
vi.mock('../src/main/rag/worker?modulePath', () => ({ default: 'worker-fixture.js' }))
vi.mock('node:worker_threads', () => ({ Worker: class { constructor() { mocks.worker(); throw new Error('Unexpected local worker') } } }))
vi.mock('../src/main/rag/myagent', () => ({ MyAgentRag: class { test = mocks.test; index = mocks.index; statuses = mocks.statuses; clear = mocks.clear; search = mocks.search; tools = mocks.tools } }))
import { RagService } from '../src/main/rag/service'
const settings = { ...DEFAULT_RAG_SETTINGS, enabled: true }
const saved = (backend: 'local' | 'myagent' = 'myagent') => ({ settings: { ...settings, backend, model: backend === 'local' ? 'embedding-model' : '' }, encryptedKey: Buffer.from('private-service-key').toString('base64') })
const service = () => new RagService({ roots: async () => ['C:\\Documents'], isHomeSender: () => true })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFile.mockResolvedValue(JSON.stringify(saved()))
  mocks.test.mockResolvedValue({ dimensions: 0, message: 'Connected' })
  mocks.index.mockResolvedValue({ running: false, embedded: 1 })
  mocks.statuses.mockResolvedValue([]); mocks.clear.mockResolvedValue(undefined)
  mocks.tools.mockResolvedValue({ available: true, tools: [], sources: [], warnings: [], total: 0, nextOffset: null })
  mocks.search.mockResolvedValue({ hits: [{ path: 'C:\\Documents\\file.txt', sourceHash: 'verified-hash' }], warnings: [], total: 1 })
})
it('routes MyAgent operations without starting embedding workers or returning credentials', async () => {
  const s = service(), view = await s.settings()
  expect(view.settings.backend).toBe('myagent'); expect(JSON.stringify(view)).not.toContain('private-service-key')
  await s.test(settings)
  expect(mocks.test).toHaveBeenCalledWith(settings, 'private-service-key')
  await s.index(1, 'C:\\Documents', true, true)
  await s.cancel(1)
  await s.statuses(['C:\\Documents\\file.txt'])
  await s.clear('C:\\Documents')
  const fallback = vi.fn()
  expect(await s.searchSelected(1, ['C:\\Documents\\file.txt'], 'question', new AbortController().signal, fallback)).toMatchObject({ backend: 'myagent' })
  expect(mocks.search).toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled()
})
it('does not forward a stored embedding credential to MyAgent when switching backends', async () => {
  mocks.readFile.mockResolvedValue(JSON.stringify(saved('local')))
  const s = service()
  await expect(s.test(settings)).rejects.toThrow('backend or endpoint changed')
  await expect(s.save(settings)).rejects.toThrow('backend or endpoint changed')
  expect(mocks.test).not.toHaveBeenCalled()
  await s.save(settings, 'replacement-service-key')
  expect(mocks.writeFile).toHaveBeenCalled()
  expect((await s.settings()).hasKey).toBe(true)
})
it('requires directory consent and uses the original fallback when RAG is disabled', async () => {
  const s = service()
  await expect(s.index(1, 'C:\\Documents', true, false)).rejects.toThrow('Confirm')
  await s.save({ ...settings, enabled: false })
  const fallback = vi.fn().mockResolvedValue({ hits: [], total: 0, warnings: [] })
  expect(await s.searchSelected(1, [], 'question', new AbortController().signal, fallback)).toMatchObject({ backend: 'local-text' })
  expect(fallback).toHaveBeenCalledOnce(); expect(mocks.search).not.toHaveBeenCalled()
})
it('routes tools through the main-process credential and disables them with local or disabled RAG', async () => {
  const s = service(), signal = new AbortController().signal
  await s.toolsSelected([], 'session', 'catalog', {}, signal)
  expect(mocks.tools).toHaveBeenCalledWith(settings, 'private-service-key', [], 'session', 'catalog', {}, signal)
  await s.save({ ...settings, enabled: false })
  expect(await s.toolsSelected([], 'session', 'catalog', {}, signal)).toMatchObject({ available: false })
  await expect(s.toolsSelected([], 'session', 'execute', {}, signal)).rejects.toThrow('Enable the MyAgent')
  expect(mocks.tools).toHaveBeenCalledTimes(1)
})
it('rejects tool results if the backend is disabled during the request', async () => {
  const s = service()
  mocks.tools.mockImplementationOnce(async () => { await s.save({ ...settings, enabled: false }); return { sources: [] } })
  await expect(s.toolsSelected([], 'session', 'catalog', {}, new AbortController().signal)).rejects.toThrow('settings changed')
})
