import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  test: vi.fn(),
  index: vi.fn(),
  indexSelected: vi.fn(),
  statuses: vi.fn(),
  clear: vi.fn(),
  search: vi.fn(),
  tools: vi.fn(),
  worker: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'rag-service-fixture' },
  ipcMain: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'os_crypt',
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))
vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/main/directory-actions/file-safety', async () => ({
  ...(await vi.importActual<typeof import('../src/main/directory-actions/file-safety')>(
    '../src/main/directory-actions/file-safety',
  )),
  authorizePath: vi.fn(),
  regularFile: vi.fn(),
  hashFile: async () => 'verified-hash',
}))
vi.mock('../src/main/rag/worker?modulePath', () => ({ default: 'worker-fixture.js' }))
vi.mock('node:worker_threads', () => ({
  Worker: class {
    constructor() {
      mocks.worker()
      throw new Error('Unexpected local worker')
    }
  },
}))
vi.mock('../src/main/rag/myagent', () => ({
  MyAgentRag: class {
    test = mocks.test
    index = mocks.index
    indexSelected = mocks.indexSelected
    statuses = mocks.statuses
    clear = mocks.clear
    search = mocks.search
    tools = mocks.tools
  },
}))
import { RagService } from '../src/main/rag/service'
import { profileId } from '../src/main/rag/config'
const workspace = join(tmpdir(), 'nawa-rag-service-fixture', 'Documents')
const selectedFile = join(workspace, 'file.txt')
const outsideFile = join(tmpdir(), 'nawa-rag-service-fixture', 'Elsewhere', 'file.txt')
const settings = { ...DEFAULT_RAG_SETTINGS, backend: 'myagent' as const, model: '', enabled: true }
const saved = (backend: 'local' | 'myagent' = 'myagent') => ({
  settings: { ...settings, backend, model: backend === 'local' ? 'embedding-model' : '' },
  encryptedKey: Buffer.from('private-service-key').toString('base64'),
})
const service = () => new RagService({ roots: async () => [workspace], isHomeSender: () => true })
it('exposes setup failures for only the selected files and clears them after a successful retry', async () => {
  mocks.readFile.mockResolvedValue(
    JSON.stringify({ ...saved(), settings: { ...settings, enabled: false } }),
  )
  const other = join(workspace, 'other.txt'),
    s = service()
  mocks.statuses.mockImplementation(async (_settings, paths: string[]) =>
    paths.map((path) => ({ path, status: 'not-indexed', chunks: 0 })),
  )
  try {
    await expect(s.indexSelected(1, workspace, [selectedFile], true)).rejects.toThrow(
      'Choose an embedding model',
    )
    expect(await s.statuses([selectedFile, other])).toEqual([
      expect.objectContaining({
        path: selectedFile,
        status: 'failed',
        error: expect.stringContaining('Choose an embedding model'),
      }),
      { path: other, status: 'not-indexed', chunks: 0 },
    ])
    await s.save(settings)
    mocks.indexSelected.mockResolvedValueOnce({
      running: false,
      embedded: 1,
      files: [{ path: selectedFile, status: 'embedded' }],
    })
    await s.indexSelected(1, workspace, [selectedFile], true)
    await vi.waitFor(() => expect(s.progress().running).toBe(false))
    expect((await s.statuses([selectedFile]))[0]).toEqual({
      path: selectedFile,
      status: 'not-indexed',
      chunks: 0,
    })
  } finally {
    s.stop()
  }
})

it('retains fatal worker failures after completion and while another file is indexed', async () => {
  mocks.readFile.mockResolvedValue(JSON.stringify(saved('local')))
  const s = service(),
    other = join(workspace, 'other.txt')
  const request = vi
    .spyOn(s as never, 'request')
    .mockRejectedValueOnce(new Error('Embedding worker could not load the model.'))
    .mockResolvedValueOnce(null as never)
    .mockResolvedValue([{ path: selectedFile, status: 'embedded', chunks: 8 }] as never)
  try {
    await s.indexSelected(1, workspace, [selectedFile], true)
    await vi.waitFor(() => expect(s.progress().running).toBe(false))
    expect(s.progress().files).toEqual([
      { path: selectedFile, status: 'failed', error: 'Embedding worker could not load the model.' },
    ])
    expect((await s.statuses([selectedFile]))[0]).toMatchObject({
      status: 'failed',
      error: 'Embedding worker could not load the model.',
    })
    request.mockResolvedValueOnce({
      running: false,
      embedded: 1,
      files: [{ path: other, status: 'embedded' }],
    } as never)
    await s.indexSelected(1, workspace, [other], true)
    await vi.waitFor(() => expect(s.progress().running).toBe(false))
    expect((await s.statuses([selectedFile]))[0].error).toBe(
      'Embedding worker could not load the model.',
    )
  } finally {
    s.stop()
  }
})

it('does not leak failed-attempt diagnostics into a different embedding profile or cleared scope', async () => {
  const s = service()
  mocks.indexSelected.mockRejectedValueOnce(new Error('MyAgent authentication failed.'))
  mocks.statuses.mockResolvedValue([{ path: selectedFile, status: 'not-indexed', chunks: 0 }])
  try {
    await s.indexSelected(1, workspace, [selectedFile], true)
    await vi.waitFor(() => expect(s.progress().running).toBe(false))
    expect((await s.statuses([selectedFile]))[0].status).toBe('failed')
    await s.save({ ...settings, serverUrl: 'http://127.0.0.1:5999' }, '')
    expect((await s.statuses([selectedFile]))[0].error).toBeUndefined()
    expect(s.progress().files).toBeUndefined()
    await s.save(settings, '')
    await s.clear(workspace)
    expect((await s.statuses([selectedFile]))[0].error).toBeUndefined()
    expect(s.progress().files).toBeUndefined()
  } finally {
    s.stop()
  }
})

it('retains changed-source reasons alongside a failed refresh and ignores consent rejection', async () => {
  const s = service()
  mocks.statuses.mockResolvedValue([
    {
      path: selectedFile,
      status: 'stale',
      chunks: 8,
      error: 'File content changed since the last successful embedding.',
    },
  ])
  try {
    await expect(s.indexSelected(1, workspace, [selectedFile], false)).rejects.toThrow('Confirm')
    expect((await s.statuses([selectedFile]))[0].error).not.toContain('Confirm')
    mocks.indexSelected.mockResolvedValueOnce({
      running: false,
      failed: 1,
      files: [
        {
          path: selectedFile,
          status: 'failed',
          error: 'Embedding server HTTP 404: model unavailable.',
        },
      ],
    })
    await s.indexSelected(1, workspace, [selectedFile], true)
    await vi.waitFor(() => expect(s.progress().running).toBe(false))
    expect((await s.statuses([selectedFile]))[0]).toMatchObject({
      status: 'stale',
      error: expect.stringContaining('content changed'),
    })
    expect((await s.statuses([selectedFile]))[0].error).toContain('model unavailable')
  } finally {
    s.stop()
  }
})
it('enrolls successful explicit snapshots and does not widen or re-enroll background refresh', async () => {
  const onIndexed = vi.fn(async () => {})
  const s = new RagService({ roots: async () => [workspace], isHomeSender: () => true, onIndexed })
  mocks.statuses.mockResolvedValue([
    { path: selectedFile, status: 'embedded', sourceHash: 'a'.repeat(64) },
  ])
  await s.indexSelected(1, workspace, [selectedFile], true)
  await vi.waitFor(() =>
    expect(onIndexed).toHaveBeenCalledExactlyOnceWith(
      workspace,
      [{ path: selectedFile, hash: 'a'.repeat(64) }],
      profileId(settings),
    ),
  )
  await vi.waitFor(() => expect(s.progress().running).toBe(false))
  await s.refreshPrepared(
    workspace,
    selectedFile,
    profileId(settings),
    new AbortController().signal,
  )
  expect(onIndexed).toHaveBeenCalledOnce()
  await expect(
    s.refreshPrepared(workspace, selectedFile, 'another-profile', new AbortController().signal),
  ).rejects.toThrow('settings changed')
  expect(mocks.indexSelected).toHaveBeenCalledTimes(2)
  s.stop()
})
it('allows the workspace Stop control to cancel background work and reports incomplete refresh', async () => {
  const onCancelled = vi.fn()
  const s = new RagService({
    roots: async () => [workspace],
    isHomeSender: () => true,
    onCancelled,
  })
  mocks.indexSelected.mockResolvedValueOnce({ running: false, failed: 1 })
  await expect(
    s.refreshPrepared(workspace, selectedFile, profileId(settings), new AbortController().signal),
  ).rejects.toThrow('failed')
  await s.cancel(1)
  expect(onCancelled).toHaveBeenCalledOnce()
  s.stop()
})
it('does not enroll or resume a selected indexing job after the user stops it', async () => {
  const onIndexed = vi.fn(async () => {})
  const s = new RagService({ roots: async () => [workspace], isHomeSender: () => true, onIndexed })
  mocks.statuses.mockResolvedValue([
    { path: selectedFile, status: 'embedded', sourceHash: 'a'.repeat(64) },
  ])
  mocks.indexSelected.mockImplementationOnce(
    async (_settings, _key, _folder, _paths, signal: AbortSignal) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ running: false, incomplete: true }), {
          once: true,
        }),
      ),
  )
  await s.indexSelected(7, workspace, [selectedFile], true)
  await s.cancel(7)
  expect(onIndexed).not.toHaveBeenCalled()
  s.stop()
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFile.mockResolvedValue(JSON.stringify(saved()))
  mocks.test.mockResolvedValue({ dimensions: 0, message: 'Connected' })
  mocks.index.mockResolvedValue({ running: false, embedded: 1 })
  mocks.indexSelected.mockResolvedValue({ running: false, embedded: 1 })
  mocks.statuses.mockResolvedValue([])
  mocks.clear.mockResolvedValue(undefined)
  mocks.tools.mockResolvedValue({
    available: true,
    tools: [],
    sources: [],
    warnings: [],
    total: 0,
    nextOffset: null,
  })
  mocks.search.mockResolvedValue({
    hits: [{ path: selectedFile, sourceHash: 'verified-hash' }],
    warnings: [],
    total: 1,
  })
})
it('discovers local models using the protected endpoint credential and rejects an unapproved remote endpoint', async () => {
  mocks.readFile.mockResolvedValue(JSON.stringify(saved('local')))
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'embedding-model' }] })))
  try {
    const s = service()
    expect(await s.models({ ...DEFAULT_RAG_SETTINGS })).toEqual(['embedding-model'])
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer private-service-key' }),
      }),
    )
    await expect(
      s.models({ ...DEFAULT_RAG_SETTINGS, baseUrl: 'http://192.168.1.2:8081/v1' }),
    ).rejects.toThrow(/loopback|remote/i)
    await expect(s.models({ ...DEFAULT_RAG_SETTINGS, backend: 'myagent' })).rejects.toThrow(
      /llama.cpp endpoint/,
    )
    await expect(
      s.models({ ...DEFAULT_RAG_SETTINGS, baseUrl: 'http://127.0.0.1:8082/v1' }),
    ).rejects.toThrow(/endpoint changed/)
    expect(fetcher).toHaveBeenCalledOnce()
  } finally {
    fetcher.mockRestore()
  }
})
it('routes MyAgent operations without starting embedding workers or returning credentials', async () => {
  const s = service(),
    view = await s.settings()
  expect(view.settings.backend).toBe('myagent')
  expect(JSON.stringify(view)).not.toContain('private-service-key')
  await s.test(settings)
  expect(mocks.test).toHaveBeenCalledWith(settings, 'private-service-key')
  await s.index(1, workspace, true, true)
  await s.cancel(1)
  await s.statuses([selectedFile])
  await s.clear(workspace)
  const fallback = vi.fn()
  expect(
    await s.searchSelected(1, [selectedFile], 'question', new AbortController().signal, fallback),
  ).toMatchObject({ backend: 'myagent' })
  expect(mocks.search).toHaveBeenCalled()
  expect(fallback).not.toHaveBeenCalled()
  expect(mocks.worker).not.toHaveBeenCalled()
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
  await expect(s.index(1, workspace, true, false)).rejects.toThrow('Confirm')
  await s.save({ ...settings, enabled: false })
  const fallback = vi.fn().mockResolvedValue({ hits: [], total: 0, warnings: [] })
  expect(
    await s.searchSelected(1, [], 'question', new AbortController().signal, fallback),
  ).toMatchObject({ backend: 'local-text' })
  expect(fallback).toHaveBeenCalledOnce()
  expect(mocks.search).not.toHaveBeenCalled()
})
it('routes only explicit selected files with consent and protects against empty or expanded scopes', async () => {
  const s = service(),
    paths = [selectedFile]
  await expect(s.indexSelected(1, workspace, paths, false)).rejects.toThrow('Confirm')
  await expect(s.indexSelected(1, workspace, [], true)).rejects.toThrow('1–256')
  await expect(s.indexSelected(1, workspace, [outsideFile], true)).rejects.toThrow('inside')
  expect(mocks.indexSelected).not.toHaveBeenCalled()
  await s.indexSelected(1, workspace, paths, true)
  await s.cancel(1)
  expect(mocks.indexSelected).toHaveBeenCalledWith(
    settings,
    'private-service-key',
    workspace,
    paths,
    expect.any(AbortSignal),
    expect.any(Function),
  )
  expect(mocks.index).not.toHaveBeenCalled()
  expect(mocks.worker).not.toHaveBeenCalled()
  await s.statuses(paths, true)
  expect(mocks.statuses).toHaveBeenCalledWith(settings, paths, 'private-service-key', true)
})
it('routes selected-file refresh to the native worker for local RAG', async () => {
  mocks.readFile.mockResolvedValue(JSON.stringify(saved('local')))
  const s = service(),
    paths = [selectedFile]
  const request = vi
    .spyOn(s as never, 'request')
    .mockResolvedValue({ running: false, embedded: 1 } as never)
  await s.indexSelected(1, workspace, paths, true)
  expect(request).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: 'index',
      folder: workspace,
      paths,
      recursive: false,
    }),
    expect.any(AbortSignal),
    expect.any(Function),
    expect.any(String),
  )
  expect(mocks.indexSelected).not.toHaveBeenCalled()
})
it('switches from MyAgent to on-device embeddings without carrying its service key', async () => {
  const s = service(),
    native = { ...DEFAULT_RAG_SETTINGS, backend: 'native' as const, enabled: true }
  const request = vi
    .spyOn(s as never, 'request')
    .mockResolvedValue({ dimensions: 384, message: 'Ready' } as never)
  await s.save(native)
  expect((await s.settings()).hasKey).toBe(false)
  await s.test(native)
  expect(request).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: 'test',
      apiKey: '',
      settings: expect.objectContaining({
        backend: 'native',
        model: 'Xenova/multilingual-e5-small',
      }),
    }),
  )
  expect(mocks.test).not.toHaveBeenCalled()
})
it('routes tools through the main-process credential and disables them with local or disabled RAG', async () => {
  const s = service(),
    signal = new AbortController().signal
  await s.toolsSelected([], 'session', 'catalog', {}, signal)
  expect(mocks.tools).toHaveBeenCalledWith(
    settings,
    'private-service-key',
    [],
    'session',
    'catalog',
    {},
    signal,
  )
  await s.save({ ...settings, enabled: false })
  expect(await s.toolsSelected([], 'session', 'catalog', {}, signal)).toMatchObject({
    available: false,
  })
  await expect(s.toolsSelected([], 'session', 'execute', {}, signal)).rejects.toThrow(
    'Enable the MyAgent',
  )
  expect(mocks.tools).toHaveBeenCalledTimes(1)
})
it('rejects tool results if the backend is disabled during the request', async () => {
  const s = service()
  mocks.tools.mockImplementationOnce(async () => {
    await s.save({ ...settings, enabled: false })
    return { sources: [] }
  })
  await expect(
    s.toolsSelected([], 'session', 'catalog', {}, new AbortController().signal),
  ).rejects.toThrow('settings changed')
})
