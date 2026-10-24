import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { RuntimeSetupService } from '../src/main/runtime-setup/service'
import { LocalModelsService } from '../src/main/local-models/service'
import { MODEL_ASSETS } from '../src/main/runtime-setup/assets'
import { localModelArguments, localChatLimits } from '../src/shared/local-model-command'

vi.mock('@genoffice/electron-utils/legacy-office', () => ({
  findLibreOffice: vi.fn(async () => null),
}))
const gguf = Buffer.from([71, 71, 85, 70, 3, 0, 0, 0])
const assets = MODEL_ASSETS.map((asset) => ({
  ...asset,
  bytes: gguf.length,
  sha256: createHash('sha256').update(gguf).digest('hex'),
}))
const install = {
  models: true,
  office: false,
  startModels: false,
  useDefaults: true,
  backend: 'cuda' as const,
}
let directory: string, models: LocalModelsService
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nawa-runtime-setup-'))
  models = new LocalModelsService(join(directory, 'local-models'))
  const snapshot = await models.inspect(),
    executablePath = join(directory, 'llama-server.exe')
  await writeFile(executablePath, 'placeholder, never executed')
  await models.save({ executablePath, profiles: [] }, snapshot.revision)
})
afterEach(async () => {
  await models.dispose()
  await rm(directory, { recursive: true, force: true })
})
const setup = (fetcher: typeof fetch = async () => new Response(gguf)) =>
  new RuntimeSetupService(directory, models, {
    packaged: true,
    platform: 'win32',
    arch: 'x64',
    ocrAvailable: () => true,
    run: vi.fn(async () => 'version'),
    needsVc: () => false,
    assets,
    fetch: fetcher,
  })

it('offers setup on a fresh install and saves portable defaults with the template and projector', async () => {
  const service = setup()
  expect((await service.inspect()).offer).toBe(true)
  const result = await service.install(install)
  expect(result.state).toBe('ready')
  expect(result.needsActivation).toBe(true)
  expect(result.profiles).toHaveLength(2)
  const [chat, embedding] = result.profiles
  expect(localChatLimits(chat)).toEqual({ contextTokens: 32768, outputTokens: 1024 })
  const args = localModelArguments(chat)
  expect(args[args.indexOf('--chat-template-file') + 1]).toBe(
    join(directory, 'local-models/defaults-v1/chat_template.jinja'),
  )
  expect(localModelArguments(embedding)).toContain(
    join(directory, 'local-models/defaults-v1/mmproj-embeddinggemma-2-Q8_0.gguf'),
  )
  expect(chat.autoStart).toBe(false)
  expect(await readFile(join(directory, 'setup/Start-chat.ps1'), 'utf8')).toContain('@runtimeArgs')
  expect(
    JSON.parse(await readFile(join(directory, 'setup/chat.command.json'), 'utf8')).arguments,
  ).toEqual(args)
  // A crash before connection activation offers a finish step on the next launch.
  expect((await setup().inspect()).offer).toBe(true)
  await service.activated()
  expect((await setup().inspect()).offer).toBe(false)
})
it('preserves customized profiles and reuses verified downloads on a retry', async () => {
  const fetcher = vi.fn(async () => new Response(gguf)),
    service = setup(fetcher)
  expect((await service.install(install)).state).toBe('ready')
  let current = await models.inspect()
  const chat = current.config.profiles[0]
  chat.name = 'My customized chat'
  chat.contextSize = 8192
  await models.save(current.config, current.revision)
  fetcher.mockClear()
  const result = await service.install(install)
  expect(result.state).toBe('ready')
  expect(result.profiles[0]).toMatchObject({ name: 'My customized chat', contextSize: 8192 })
  expect(fetcher).not.toHaveBeenCalled()
  current = await models.inspect()
  expect(current.config.profiles).toHaveLength(2)
})
it('does not publish profiles after a download failure and can dismiss the first-run offer', async () => {
  const service = setup(async () => new Response('missing', { status: 404 }))
  expect((await service.install(install)).state).toBe('failed')
  expect((await models.inspect()).config.profiles).toEqual([])
  await service.dismiss()
  expect((await setup().inspect()).offer).toBe(false)
})
it('rejects arbitrary options and concurrent installations', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = setup(async () => {
    await gate
    return new Response(gguf)
  })
  await expect(service.install({ ...install, backend: 'shell-command' })).rejects.toThrow(
    'Choose models',
  )
  const pending = service.install(install)
  await vi.waitFor(async () => expect((await service.inspect()).state).toBe('installing'))
  await expect(service.install(install)).rejects.toThrow('already running')
  release()
  expect((await pending).state).toBe('ready')
})

async function cudaSetup({ devices = true, missingLibraries = false } = {}) {
  const current = await models.inspect()
  const cpu = join(directory, 'local-models/engines/default-b11541-cpu-x64/llama-server.exe')
  await mkdir(join(cpu, '..'), { recursive: true })
  await writeFile(cpu, 'old managed CPU engine')
  await models.save({ ...current.config, executablePath: cpu }, current.revision)
  const engine = new JSZip()
    .file('llama-server.exe', 'CUDA engine')
    .file('ggml-cuda.dll', 'GPU backend')
  const libraries = new JSZip()
    .file('cublas64_12.dll', 'CUDA runtime')
    .file('CUDA-LICENSE.txt', 'NVIDIA notices')
  const buffers = await Promise.all(
    [engine, libraries].map((zip) =>
      zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    ),
  )
  const packages = buffers.map((bytes, index) => ({
    id: index ? 'cudaRuntime' : 'runtime',
    name: index ? 'cudart.zip' : 'engine.zip',
    url: `https://releases.example.test/${index}.zip`,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }))
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const index = packages.findIndex((asset) => asset.url === String(url))
    return index < 0
      ? new Response(gguf)
      : index === 1 && missingLibraries
        ? new Response('missing', { status: 404 })
        : new Response(new Uint8Array(buffers[index]))
  })
  const service = new RuntimeSetupService(directory, models, {
    platform: 'win32',
    arch: 'x64',
    ocrAvailable: () => true,
    needsVc: () => false,
    assets,
    engines: () => packages,
    fetch: fetcher,
    run: async (_executable, args) =>
      args.includes('--list-devices')
        ? devices
          ? 'Available devices:\n CUDA0: NVIDIA test GPU'
          : 'Available devices:\n (none)'
        : 'version',
  })
  return { service, fetcher, root: join(directory, 'local-models/engines/default-b11541-cuda-x64') }
}
it('upgrades a managed CPU runtime to CUDA with both verified archives and exports CUDA commands', async () => {
  const { service, root } = await cudaSetup()
  const result = await service.install(install)
  expect(result.state, result.error).toBe('ready')
  expect(await readFile(join(root, 'cublas64_12.dll'), 'utf8')).toBe('CUDA runtime')
  expect(await readFile(join(root, 'CUDA-LICENSE.txt'), 'utf8')).toBe('NVIDIA notices')
  expect((await models.inspect()).config.executablePath).toBe(join(root, 'llama-server.exe'))
  const command = JSON.parse(await readFile(join(directory, 'setup/chat.command.json'), 'utf8'))
  expect(command.executable).toBe(join(root, 'llama-server.exe'))
  expect(command.arguments).toContain('--chat-template-file')
  expect(command.arguments).toContain('auto')
})
it('does not publish an incomplete CUDA runtime when its redistributable download fails', async () => {
  const { service, root } = await cudaSetup({ missingLibraries: true })
  expect((await service.install(install)).state).toBe('failed')
  await expect(readFile(join(root, 'llama-server.exe'))).rejects.toThrow('ENOENT')
  expect((await models.inspect()).config.profiles).toEqual([])
})
it('reports missing CUDA devices before downloading models instead of silently using the CPU', async () => {
  const { service, fetcher } = await cudaSetup({ devices: false })
  expect(await service.install(install)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('NVIDIA GPU'),
  })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect((await models.inspect()).config.profiles).toEqual([])
})
