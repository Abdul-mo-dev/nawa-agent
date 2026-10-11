import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RagEngine } from '../src/main/rag/engine'
import { RagStore } from '../src/main/rag/store'
import { DEFAULT_RAG_SETTINGS, type RagFileStatus, type RagProgress } from '../src/shared/rag-api'
import { hashFile } from '../src/main/directory-actions/file-safety'
import type { FileSearchResult } from '../src/shared/file-search-api'

const mocks = vi.hoisted(() => ({ embed: vi.fn() }))
vi.mock('../src/main/rag/native-embedding', () => ({
  embeddingProvider: () => ({
    countTokens: async (text: string) => Math.ceil(text.length / 4),
    embed: mocks.embed,
  }),
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nawa-prepared-search-'))
  const file = join(directory, 'notes.txt')
  await writeFile(file, 'Original refund policy: 30 days.')
  const store = new RagStore(join(directory, 'rag.sqlite3'))
  const engine = new RagEngine(store, directory)
  const settings = {
    ...DEFAULT_RAG_SETTINGS,
    enabled: true,
    model: 'test-embedding',
    tokenizer: 'conservative' as const,
  }
  const signal = new AbortController().signal
  mocks.embed
    .mockReset()
    .mockImplementation(async (texts: string[]) =>
      texts.map(() => ({ vector: new Float32Array([1, 0]), dimensions: 2 })),
    )
  const job = { roots: [directory], settings, apiKey: '', paths: [file] }
  const index = () =>
    engine.execute(
      { ...job, action: 'index', folder: directory },
      signal,
      () => {},
    ) as Promise<RagProgress>
  const statuses = () =>
    engine.execute({ ...job, action: 'statuses', verify: true }, signal, () => {}) as Promise<
      RagFileStatus[]
    >
  const search = () =>
    engine.execute(
      { ...job, action: 'retrieve', query: 'refund policy' },
      signal,
      () => {},
    ) as Promise<FileSearchResult>
  cleanups.push(async () => {
    store.close()
    if (
      resolve(dirname(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('nawa-prepared-search-')
    )
      throw new Error('Unexpected test cleanup path.')
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, file, store, engine, job, signal, index, statuses, search }
}

it('excludes changed search snapshots and publishes a complete fresh generation without chat calls', async () => {
  const f = await fixture()
  expect((await f.index()).embedded).toBe(1)
  const before = f.store.get(f.file)!.source_hash
  expect((await f.search()).hits).toHaveLength(1)
  await writeFile(f.file, 'Updated refund policy: 60 days.')
  expect((await f.statuses())[0].status).toBe('stale')
  expect((await f.search()).hits).toEqual([])
  expect((await f.index()).embedded).toBe(1)
  const after = f.store.get(f.file)!
  expect(after.source_hash).toBe(await hashFile(f.file))
  expect(after.source_hash).not.toBe(before)
  expect((await f.search()).hits[0].excerpt).toContain('60 days')
  const count = mocks.embed.mock.calls.length
  expect((await f.index()).unchanged).toBe(1)
  expect(mocks.embed).toHaveBeenCalledTimes(count)
})

it('retains cached passages through temporary source unavailability and recovers identical bytes', async () => {
  const f = await fixture()
  await f.index()
  const content = await readFile(f.file)
  await rm(f.file)
  expect((await f.statuses())[0].status).toBe('unavailable')
  expect((await f.search()).hits).toEqual([])
  expect(f.store.get(f.file)!.chunks).toBeGreaterThan(0)
  await writeFile(f.file, content)
  expect((await f.search()).hits).toHaveLength(1)
  expect((await f.statuses())[0].status).toBe('embedded')
})

it('reports the access failure for a file that has never been indexed', async () => {
  const f = await fixture()
  await rm(f.file)
  expect((await f.statuses())[0]).toMatchObject({
    status: 'unavailable',
    error: expect.stringContaining('File unavailable:'),
  })
  expect((await f.statuses())[0].error).toContain('ENOENT')
  expect(f.store.get(f.file)).toBeUndefined()
})

it('prunes only a confirmed missing source and leaves other indexed records intact', async () => {
  const f = await fixture()
  await f.index()
  await expect(f.engine.execute({ ...f.job, action: 'prune' }, f.signal, () => {})).rejects.toThrow(
    'not confirmed',
  )
  expect(f.store.get(f.file)).toBeDefined()
  const second = join(f.directory, 'other.txt')
  await writeFile(second, 'Other authorized indexed document.')
  await f.engine.execute(
    { ...f.job, action: 'index', folder: f.directory, paths: [second] },
    f.signal,
    () => {},
  )
  await rm(f.file)
  await f.engine.execute({ ...f.job, action: 'prune' }, f.signal, () => {})
  expect(f.store.get(f.file)).toBeUndefined()
  expect(f.store.get(second)!.status).toBe('embedded')
})
