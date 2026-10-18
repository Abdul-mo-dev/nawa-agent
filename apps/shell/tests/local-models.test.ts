import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalModelsService } from '../src/main/local-models/service'
import { localModelArguments, validateLocalModels } from '../src/shared/local-model-command'
import type { LocalModelProfile, LocalModelsConfig } from '../src/shared/local-models-api'
import { chatConnection, embeddingConnection } from '../src/renderer/src/local-models/connections'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'

let directory: string, model: string, executable: string, service: LocalModelsService
const fakeChild = () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 991,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  child.kill.mockImplementation((signal = 'SIGTERM') => {
    queueMicrotask(() => child.emit('exit', null, signal))
    return true
  })
  return child
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
const profile = (port: number, kind: 'chat' | 'embedding' = 'chat'): LocalModelProfile => ({
  id: 'local-test',
  name: 'Test',
  kind,
  modelPath: model,
  port,
  contextSize: 8192,
  gpuLayers: 0,
  threads: 2,
  pooling: 'mean',
  autoStart: false,
  arguments: [
    { enabled: true, name: '--jinja', value: '' },
    { enabled: false, name: '--batch-size', value: '512' },
  ],
})
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nawa-local-models-'))
  executable = join(directory, 'llama-server.exe')
  model = join(directory, 'test.gguf')
  await writeFile(executable, 'test-only binary placeholder')
  await writeFile(model, Buffer.from([71, 71, 85, 70, 3, 0, 0, 0]))
})
afterEach(async () => {
  service?.dispose()
  await rm(directory, { recursive: true, force: true })
})
it('persists profiles atomically, rejects stale saves, and refuses corrupt settings', async () => {
  service = new LocalModelsService(directory)
  const first = await service.inspect(),
    config = { executablePath: executable, profiles: [profile(await freePort())] }
  const saved = await service.save(config, first.revision)
  expect(JSON.parse(await readFile(join(directory, 'settings-v1.json'), 'utf8'))).toEqual(config)
  await expect(service.save({ ...config, profiles: [] }, first.revision)).rejects.toThrow('changed')
  expect((await new LocalModelsService(directory).inspect()).revision).toBe(saved.revision)
  await writeFile(join(directory, 'settings-v1.json'), '{broken')
  await expect(new LocalModelsService(directory).inspect()).rejects.toThrow('could not be read')
  expect(await readFile(join(directory, 'settings-v1.json'), 'utf8')).toBe('{broken')
})
it('starts a saved profile without a shell, waits for health, bounds logs, and stops only its child', async () => {
  const child = fakeChild(),
    launch = vi.fn(() => child as unknown as ChildProcess)
  let ready = false
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: ready ? 'ok' : 'loading model' }), {
        status: ready ? 200 : 503,
      }),
  )
  service = new LocalModelsService(directory, {
    spawn: launch as unknown as typeof spawn,
    fetch: fetcher,
    pollMs: 5,
  })
  const p = profile(await freePort()),
    first = await service.inspect()
  await service.save({ executablePath: executable, profiles: [p] }, first.revision)
  await service.start(p.id)
  expect((await service.inspect()).runtimes[0].state).toBe('starting')
  expect(launch.mock.calls[0]).toEqual([
    executable,
    localModelArguments(p),
    expect.objectContaining({ shell: false, windowsHide: true }),
  ])
  child.stderr.emit('data', Buffer.from('x'.repeat(40000)))
  expect((await service.inspect()).runtimes[0].logs).toHaveLength(32000)
  await expect(service.start(p.id)).rejects.toThrow('already active')
  const current = await service.inspect()
  await expect(service.save({ ...current.config, profiles: [] }, current.revision)).rejects.toThrow(
    'Stop',
  )
  ready = true
  await vi.waitFor(async () => expect((await service.inspect()).runtimes[0].state).toBe('running'))
  await service.stop(p.id)
  expect((await service.inspect()).runtimes[0].state).toBe('stopped')
  expect(child.kill).toHaveBeenCalledTimes(1)
})
it('reports busy ports and invalid GGUF without spawning a process', async () => {
  const launch = vi.fn(),
    server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const p = profile((server.address() as { port: number }).port)
    service = new LocalModelsService(directory, { spawn: launch })
    const first = await service.inspect()
    await service.save({ executablePath: executable, profiles: [p] }, first.revision)
    await expect(service.start(p.id)).rejects.toThrow('already in use')
    expect(launch).not.toHaveBeenCalled()
    expect((await service.inspect()).runtimes[0].state).toBe('failed')
    await writeFile(model, 'not GGUF')
    await expect(service.start(p.id)).rejects.toThrow('not a supported GGUF')
    expect(launch).not.toHaveBeenCalled()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
it('kills a timed-out runtime, reports failure, and cleans up owned processes on shutdown', async () => {
  const child = fakeChild(),
    launch = vi.fn(() => child as unknown as ChildProcess)
  service = new LocalModelsService(directory, {
    spawn: launch as unknown as typeof spawn,
    fetch: async () => new Response('{}', { status: 503 }),
    readyTimeoutMs: 15,
    pollMs: 5,
  })
  const p = profile(await freePort()),
    first = await service.inspect()
  await service.save({ executablePath: executable, profiles: [p] }, first.revision)
  await service.start(p.id)
  await vi.waitFor(async () =>
    expect((await service.inspect()).runtimes[0]).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('timed out'),
    }),
  )
  expect(child.kill).toHaveBeenCalled()
  service.dispose()
  await expect(service.start(p.id)).rejects.toThrow('shutting down')
})
it('validates owned arguments and keeps shell syntax as a literal argument', async () => {
  const p = profile(await freePort()),
    config: LocalModelsConfig = { executablePath: executable, profiles: [p] }
  expect(validateLocalModels(config)).toEqual(config)
  for (const name of ['--host', '--port', '-m', '--embedding', '--models-dir'])
    expect(() =>
      validateLocalModels({
        ...config,
        profiles: [{ ...p, arguments: [{ enabled: true, name, value: 'bad' }] }],
      }),
    ).toThrow('managed')
  expect(() => validateLocalModels({ ...config, profiles: [p, { ...p, id: 'other' }] })).toThrow(
    'different port',
  )
  p.arguments = [{ enabled: true, name: '--chat-template', value: '$(secret); & literal' }]
  expect(
    localModelArguments(validateLocalModels({ ...config, profiles: [p] }).profiles[0]),
  ).toContain('$(secret); & literal')
})
it('selects local chat without losing other providers or saved models and invalidates embedding identity', async () => {
  const p = profile(await freePort()),
    current = defaultAiSettings()
  const next = chatConnection(current, p)
  expect(next.provider).toBe('custom')
  expect(next.defaultChatModelId).toBe('runtime-local-test')
  expect(next.chatModels?.at(-1)?.config).toMatchObject({
    model: p.id,
    baseUrl: `http://127.0.0.1:${p.port}/v1`,
    apiKey: '',
    policy: { mode: 'local', contextTokens: 8192 },
  })
  expect(next.providers.openai).toEqual(current.providers.openai)
  expect(chatConnection(next, p).chatModels).toHaveLength(1)
  const embedding = embeddingConnection(
    {
      ...DEFAULT_RAG_SETTINGS,
      backend: 'native',
      documentPrefix: 'passage: ',
      queryPrefix: 'query: ',
    },
    { ...p, kind: 'embedding', contextSize: 256 },
    'new-weights',
  )
  expect(embedding).toMatchObject({
    backend: 'local',
    enabled: true,
    model: p.id,
    modelRevision: 'new-weights',
    dimensions: 0,
    documentPrefix: '',
    queryPrefix: '',
    maxInputTokens: 256,
    chunkTokens: 255,
  })
})
it('never deletes external models or a downloaded package referenced by a profile', async () => {
  service = new LocalModelsService(directory)
  await expect(service.removeModel(model)).rejects.toThrow('Only models downloaded')
  const packagePath = join(directory, 'models', '00000000-0000-0000-0000-000000000000')
  await mkdir(packagePath, { recursive: true })
  const path = join(packagePath, 'download.gguf')
  await writeFile(path, await readFile(model))
  const first = await service.inspect(),
    p = { ...profile(await freePort()), modelPath: path }
  await service.save({ executablePath: executable, profiles: [p] }, first.revision)
  await expect(service.removeModel(path)).rejects.toThrow('saved profiles')
  const current = await service.inspect()
  await service.save({ ...current.config, profiles: [] }, current.revision)
  await service.removeModel(path)
  await expect(stat(packagePath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await stat(model)).isFile()).toBe(true)
})

it('starts only opted-in profiles and reports unexpected process exits', async () => {
  const child = fakeChild(),
    launch = vi.fn(() => child as unknown as ChildProcess)
  service = new LocalModelsService(directory, {
    spawn: launch as unknown as typeof spawn,
    fetch: async () => Response.json({ status: 'ok' }),
    pollMs: 5,
  })
  const first = await service.inspect(),
    p = { ...profile(await freePort()), autoStart: true },
    other = { ...profile(await freePort()), id: 'manual-only' }
  await service.save({ executablePath: executable, profiles: [p, other] }, first.revision)
  await service.autoStart()
  expect(launch).toHaveBeenCalledTimes(1)
  await vi.waitFor(async () => expect((await service.inspect()).runtimes[0].state).toBe('running'))
  child.emit('exit', 7, null)
  expect((await service.inspect()).runtimes).toEqual([
    expect.objectContaining({ state: 'failed', error: expect.stringContaining('7') }),
    expect.objectContaining({ state: 'stopped' }),
  ])
})

it('preserves Gemma command aliases, automatic GPU layers, parallel context and generation limits', async () => {
  const p: LocalModelProfile = {
    ...profile(await freePort()),
    alias: 'gemma-4-e4b',
    gpuLayers: 'auto',
    contextSize: 65536,
    arguments: [
      { enabled: true, name: '-np', value: '2' },
      { enabled: true, name: '--n-predict', value: '1024' },
      {
        enabled: true,
        name: '--chat-template-file',
        value: join(directory, 'chat_template.jinja'),
      },
    ],
  }
  const valid = validateLocalModels({ executablePath: executable, profiles: [p] }).profiles[0]
  expect(valid.alias).toBe('gemma-4-e4b')
  expect(localModelArguments(valid)).toEqual(
    expect.arrayContaining([
      '--gpu-layers',
      'auto',
      '--alias',
      'gemma-4-e4b',
      '-np',
      '2',
      '--chat-template-file',
      join(directory, 'chat_template.jinja'),
    ]),
  )
  expect(chatConnection(defaultAiSettings(), valid).providers.custom).toMatchObject({
    model: 'gemma-4-e4b',
    policy: { contextTokens: 32768, outputTokens: 1024 },
  })
})
it('keeps the embedding model pooling default and configures EmbeddingGemma 2 retrieval prompts', async () => {
  const p: LocalModelProfile = {
    ...profile(await freePort(), 'embedding'),
    alias: 'embeddinggemma-2',
    gpuLayers: 'auto',
    contextSize: 8192,
    pooling: 'model',
    arguments: [
      {
        enabled: true,
        name: '--mmproj',
        value: join(directory, 'mmproj-embeddinggemma-2-Q8_0.gguf'),
      },
    ],
  }
  const valid = validateLocalModels({ executablePath: executable, profiles: [p] }).profiles[0]
  const args = localModelArguments(valid)
  expect(args).toContain('--embedding')
  expect(args).not.toContain('--pooling')
  expect(args).toContain('--mmproj')
  expect(embeddingConnection(DEFAULT_RAG_SETTINGS, valid, 'weights-v2')).toMatchObject({
    model: 'embeddinggemma-2',
    maxInputTokens: 8192,
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
    modelRevision: 'weights-v2',
  })
})
