import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileRevision, replaceFileTransaction, FileConflictError } from '../src/file-transaction'

const state = vi.hoisted(() => ({ renameFails: false }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (state.renameFails) throw Object.assign(new Error('locked'), { code: 'EACCES' })
      return actual.rename(...args)
    },
  }
})
const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nawa-transaction-'))
  directories.push(directory)
  const path = join(directory, 'original.bin')
  await writeFile(path, 'ORIGINAL')
  return { directory, path }
}
afterEach(async () => {
  state.renameFails = false
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

it('keeps the original and removes a partially written stage after a stream failure', async () => {
  const { path, directory } = await fixture()
  await expect(
    replaceFileTransaction(path, async (stage) => {
      await writeFile(stage, 'PARTIAL', { flag: 'wx' })
      throw new Error('ENOSPC')
    }),
  ).rejects.toThrow('ENOSPC')
  expect(await readFile(path, 'utf8')).toBe('ORIGINAL')
  expect(await readdir(directory)).toEqual(['original.bin'])
})

it('retains the original and a complete recovery stage if replacing a locked file fails', async () => {
  const { path, directory } = await fixture()
  state.renameFails = true
  await expect(
    replaceFileTransaction(path, (stage) => writeFile(stage, 'COMPLETE', { flag: 'wx' })),
  ).rejects.toThrow('original is unchanged')
  expect(await readFile(path, 'utf8')).toBe('ORIGINAL')
  const stage = (await readdir(directory)).find((name) => name.endsWith('.tmp'))!
  expect(await readFile(join(directory, stage), 'utf8')).toBe('COMPLETE')
})

it('checks the source again at commit after a slow write or user interaction', async () => {
  const { path, directory } = await fixture()
  const revision = await fileRevision(path)
  await expect(
    replaceFileTransaction(path, (stage) => writeFile(stage, 'LOCAL', { flag: 'wx' }), {
      expectedRevision: revision,
      beforeCommit: () => writeFile(path, 'EXTERNAL'),
    }),
  ).rejects.toBeInstanceOf(FileConflictError)
  expect(await readFile(path, 'utf8')).toBe('EXTERNAL')
  expect(await readdir(directory)).toEqual(['original.bin'])
})

it('commits a complete file and refuses an unexpected existing destination', async () => {
  const { path } = await fixture()
  await expect(
    replaceFileTransaction(path, (stage) => writeFile(stage, 'NEW', { flag: 'wx' }), {
      expectedRevision: null,
    }),
  ).rejects.toBeInstanceOf(FileConflictError)
  await replaceFileTransaction(path, (stage) => writeFile(stage, 'NEW', { flag: 'wx' }), {
    expectedRevision: await fileRevision(path),
  })
  expect(await readFile(path, 'utf8')).toBe('NEW')
})
