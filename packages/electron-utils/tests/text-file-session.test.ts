import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextFileSessions } from '../src/text-file-session'
import { decodeSource } from '../../file-parse/src/source-text'
import { FileConflictError } from '../src/file-transaction'

const directories: string[] = []
async function fixture(bytes: Uint8Array | string) {
  const directory = await mkdtemp(join(tmpdir(), 'nawa-text-session-'))
  directories.push(directory)
  const path = join(directory, 'source.json')
  await writeFile(path, bytes)
  return { path, session: new TextFileSessions(decodeSource) }
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

it.each(['utf8', 'bom', 'le', 'be'])(
  'preserves %s encoding and CRLF across editor serialization',
  async (encoding) => {
    const original = '{"text":"مرحبا 日本語"}\r\n'
    let bytes: Buffer
    if (encoding === 'le' || encoding === 'be') {
      const body = Buffer.from(original, 'utf16le')
      if (encoding === 'be') body.swap16()
      bytes = Buffer.concat([Buffer.from(encoding === 'le' ? [255, 254] : [254, 255]), body])
    } else
      bytes = Buffer.concat([
        encoding === 'bom' ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
        Buffer.from(original),
      ])
    const { path, session } = await fixture(bytes)
    expect(await session.read(1, path)).toBe(original)
    await session.save(1, path, original.replace(/\r\n/g, '\n'))
    expect(await readFile(path)).toEqual(bytes)
    await session.save(1, path, original.replace('text', 'edited'))
    expect(decodeSource(await readFile(path)).text).toBe(original.replace('text', 'edited'))
  },
)

it('rejects invalid source bytes without rewriting the original', async () => {
  const bytes = Buffer.from([0xff, 0x61])
  const { path, session } = await fixture(bytes)
  await expect(session.read(1, path)).rejects.toThrow()
  await expect(session.save(1, path, 'lossy')).rejects.toBeInstanceOf(FileConflictError)
  expect(await readFile(path)).toEqual(bytes)
})

it('refuses external edits and two editors saving the same revision', async () => {
  const { path, session } = await fixture('initial')
  await session.read(1, path)
  await session.read(2, path)
  await session.save(1, path, 'first editor')
  await expect(session.save(2, path, 'stale second editor')).rejects.toBeInstanceOf(
    FileConflictError,
  )
  await writeFile(path, 'external editor')
  await expect(session.save(1, path, 'stale first editor')).rejects.toBeInstanceOf(
    FileConflictError,
  )
  expect(await readFile(path, 'utf8')).toBe('external editor')
})

it('keeps Save As encoding, updates its identity, and does not write back to the old file', async () => {
  const original = Buffer.concat([Buffer.from([255, 254]), Buffer.from('one\r\n', 'utf16le')])
  const { path, session } = await fixture(original)
  await session.read(1, path)
  const target = path + '.txt'
  await session.save(1, target, 'two\n')
  await session.save(1, target, 'three\n')
  expect(await readFile(path)).toEqual(original)
  expect(decodeSource(await readFile(target)).text).toBe('three\r\n')
})

it('does not commit a queued save after its view closes', async () => {
  const { path, session } = await fixture('original')
  await session.read(1, path)
  const saving = session.save(1, path, 'closed view edit')
  session.forget(1)
  await expect(saving).rejects.toThrow('original is unchanged')
  expect(await readFile(path, 'utf8')).toBe('original')
})
