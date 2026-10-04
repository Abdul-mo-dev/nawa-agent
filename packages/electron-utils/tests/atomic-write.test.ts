import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveFileWithStaging, StagedSaveError } from '../src/atomic-write'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  vi.mocked(rename).mockClear()
})

describe('saveFileWithStaging', () => {
  it('preserves the completed bytes and the original when the final rename fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'staged-save-'))
    const target = join(dir, 'file.pdf')
    writeFileSync(target, 'old')
    const locked = Object.assign(new Error('locked'), { code: 'EPERM' })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.mocked(rename).mockRejectedValueOnce(locked)
    }

    const error = await saveFileWithStaging(target, Buffer.from('new')).catch((cause) => cause)

    expect(error).toBeInstanceOf(StagedSaveError)
    expect(error.cause).toBe(locked)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readFileSync(error.stagedPath, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toHaveLength(2)
  })
})
