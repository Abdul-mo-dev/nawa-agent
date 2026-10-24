import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { downloadAsset } from '../src/main/runtime-setup/download'

let directory: string
const bytes = Buffer.from('verified model content'),
  asset = {
    id: 'test',
    name: 'model.gguf',
    url: 'https://example.invalid/model.gguf',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nawa-setup-download-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('resumes an interrupted download and publishes it only after verifying SHA-256', async () => {
  const path = join(directory, asset.name)
  await writeFile(`${path}.part`, bytes.subarray(0, 8))
  const fetcher = vi.fn(
    async () =>
      new Response(bytes.subarray(8), {
        status: 206,
        headers: { 'Content-Range': `bytes 8-${bytes.length - 1}/${bytes.length}` },
      }),
  )
  await downloadAsset(asset, path, new AbortController().signal, vi.fn(), fetcher)
  expect(fetcher).toHaveBeenCalledWith(
    asset.url,
    expect.objectContaining({ headers: expect.objectContaining({ Range: 'bytes=8-' }) }),
  )
  expect(await readFile(path)).toEqual(bytes)
  expect(await readFile(`${path}.part`).catch(() => null)).toBeNull()
  fetcher.mockClear()
  await downloadAsset(asset, path, new AbortController().signal, vi.fn(), fetcher)
  expect(fetcher).not.toHaveBeenCalled()
})
it('restarts safely when a server ignores Range and rejects a wrong range', async () => {
  const path = join(directory, asset.name)
  await writeFile(`${path}.part`, bytes.subarray(0, 8))
  await downloadAsset(
    asset,
    path,
    new AbortController().signal,
    vi.fn(),
    async () => new Response(bytes),
  )
  expect(await readFile(path)).toEqual(bytes)
  await rm(path)
  await writeFile(`${path}.part`, bytes.subarray(0, 8))
  await expect(
    downloadAsset(
      asset,
      path,
      new AbortController().signal,
      vi.fn(),
      async () =>
        new Response(bytes.subarray(8), {
          status: 206,
          headers: { 'Content-Range': 'bytes 1-2/3' },
        }),
    ),
  ).rejects.toThrow('unexpected byte range')
})
it('does not publish corrupted or truncated files and retains useful partial data', async () => {
  const path = join(directory, asset.name)
  await expect(
    downloadAsset(
      asset,
      path,
      new AbortController().signal,
      vi.fn(),
      async () => new Response(Buffer.alloc(bytes.length)),
    ),
  ).rejects.toThrow('SHA-256')
  expect(await readFile(path).catch(() => null)).toBeNull()
  expect(await readFile(`${path}.part`).catch(() => null)).toBeNull()
  await expect(
    downloadAsset(
      asset,
      path,
      new AbortController().signal,
      vi.fn(),
      async () => new Response(bytes.subarray(0, 8)),
    ),
  ).rejects.toThrow('verification failed')
  expect(await readFile(`${path}.part`)).toEqual(bytes.subarray(0, 8))
})
it('retains bytes on cancel and replaces a corrupt completed file', async () => {
  const path = join(directory, asset.name),
    controller = new AbortController()
  await expect(
    downloadAsset(
      asset,
      path,
      controller.signal,
      (received) => {
        if (received) controller.abort()
      },
      async () => new Response(bytes.subarray(0, 8)),
    ),
  ).rejects.toThrow()
  expect(await readFile(`${path}.part`)).toEqual(bytes.subarray(0, 8))
  await writeFile(path, 'bad cache')
  await downloadAsset(
    asset,
    path,
    new AbortController().signal,
    vi.fn(),
    async () => new Response(bytes),
  )
  expect(await readFile(path)).toEqual(bytes)
})
