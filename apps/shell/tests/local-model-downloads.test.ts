import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { ModelDownloads, safeArchivePath } from '../src/main/local-models/downloads'

let directory: string
const revision = 'a'.repeat(40),
  gguf = Buffer.from([71, 71, 85, 70, 3, 0, 0, 0]),
  digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nawa-downloads-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
const catalog = (names: string[], hash = digest(gguf)) => ({
  sha: revision,
  siblings: names.map((name) => ({ rfilename: name, lfs: { sha256: hash, size: gguf.length } })),
})
it('pins a GGUF revision, verifies every shard, and publishes the complete package together', async () => {
  const names = ['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('/api/') ? Response.json(catalog(names)) : new Response(gguf),
  )
  const manager = new ModelDownloads(directory, fetcher)
  const files = await manager.modelFiles('owner/model')
  expect(files).toHaveLength(2)
  await manager.downloadModel('owner/model', revision, names[1])
  const library = await manager.models()
  expect(library).toHaveLength(1)
  expect(library[0].name).toBe(names[0])
  expect(await readFile(library[0].path)).toEqual(gguf)
  expect(
    fetcher.mock.calls.slice(1).every(([url]) => String(url).includes(`/resolve/${revision}/`)),
  ).toBe(true)
  expect(manager.progress).toMatchObject({ state: 'completed', received: 16, total: 16 })
})
it('rejects corrupt downloads and removes partial packages', async () => {
  const manager = new ModelDownloads(directory, async (url) =>
    String(url).includes('/api/')
      ? Response.json(catalog(['model.gguf'], '0'.repeat(64)))
      : new Response(gguf),
  )
  await manager.modelFiles('owner/model')
  await expect(manager.downloadModel('owner/model', revision, 'model.gguf')).rejects.toThrow(
    'SHA-256',
  )
  expect(await manager.models()).toEqual([])
  expect(await readdir(join(directory, 'staging'))).toEqual([])
  expect(manager.progress.state).toBe('failed')
})
it('cancels an active download and rejects concurrent downloads', async () => {
  const manager = new ModelDownloads(directory, async (url, options) => {
    if (String(url).includes('/api/')) return Response.json(catalog(['model.gguf']))
    return new Promise<Response>((_resolve, reject) =>
      options?.signal?.addEventListener('abort', () => reject(new Error('canceled')), {
        once: true,
      }),
    )
  })
  await manager.modelFiles('owner/model')
  const pending = manager.downloadModel('owner/model', revision, 'model.gguf')
  await expect(manager.downloadModel('owner/model', revision, 'model.gguf')).rejects.toThrow(
    'current download',
  )
  manager.cancel()
  await expect(pending).rejects.toThrow('canceled')
  expect(manager.progress.state).toBe('canceled')
  expect(await manager.models()).toEqual([])
})
it('verifies official release assets and safely extracts an engine', async () => {
  const archive = new JSZip()
  archive.file('llama-server.exe', 'test engine')
  archive.file('ggml.dll', 'test DLL')
  const bytes = await archive.generateAsync({ type: 'nodebuffer' })
  const manager = new ModelDownloads(directory, async (url) =>
    String(url).includes('/api.github.com/')
      ? Response.json([
          { tag_name: 'no-binaries', assets: [] },
          {
            tag_name: 'test-release',
            prerelease: true,
            assets: [
              {
                id: 1,
                name: 'llama-test-bin-win-cpu-x64.zip',
                size: bytes.length,
                digest: 'sha256:' + digest(bytes),
                browser_download_url:
                  'https://github.com/ggml-org/llama.cpp/releases/download/test/llama.zip',
              },
            ],
          },
        ])
      : new Response(bytes),
  )
  expect((await manager.releases()).assets).toHaveLength(1)
  await manager.installEngine(1)
  const engines = await manager.engines()
  expect(engines).toHaveLength(1)
  expect(await readFile(engines[0], 'utf8')).toBe('test engine')
})
it('rejects archive traversal and release assets without digests', async () => {
  for (const name of ['../escape', '/absolute', 'C:/outside', 'safe/../../bad', 'back\\slash'])
    expect(() => safeArchivePath(directory, name)).toThrow('Unsafe')
  const zip = new JSZip()
  zip.file('../outside.exe', 'bad')
  zip.file('llama-server.exe', 'fake')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const manager = new ModelDownloads(directory, async (url) =>
    String(url).includes('/api.github.com/')
      ? Response.json([
          {
            tag_name: 'test',
            assets: [
              {
                id: 1,
                name: 'llama-test-bin-win-cpu.zip',
                size: bytes.length,
                digest: 'sha256:' + digest(bytes),
                browser_download_url:
                  'https://github.com/ggml-org/llama.cpp/releases/download/test/llama.zip',
              },
              {
                id: 2,
                name: 'llama-test-bin-win-unsafe.zip',
                size: bytes.length,
                browser_download_url: 'https://example.com/unsafe.zip',
              },
            ],
          },
        ])
      : new Response(bytes),
  )
  expect((await manager.releases()).assets.map((a) => a.id)).toEqual([1])
  await expect(manager.installEngine(1)).rejects.toThrow('Unsafe')
  expect(await manager.engines()).toEqual([])
})
