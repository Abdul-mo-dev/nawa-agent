import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveFileWithStagingSync, StagedSaveError } from '../src/atomic-write'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  vi.mocked(renameSync).mockImplementation(actualFs.renameSync)
  vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync)
})

describe('saveFileWithStagingSync', () => {
  it('keeps the complete staged copy if the locked-target fallback fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'staged-save-sync-'))
    const target = join(dir, 'file.docx')
    writeFileSync(target, 'old')
    const locked = Object.assign(new Error('locked'), { code: 'EPERM' })
    const fallbackError = Object.assign(new Error('fallback failed'), { code: 'EIO' })
    vi.mocked(renameSync).mockImplementation(() => {
      throw locked
    })
    vi.mocked(writeFileSync)
      .mockImplementationOnce(actualFs.writeFileSync)
      .mockImplementationOnce(() => {
        throw fallbackError
      })

    let error: unknown
    try {
      saveFileWithStagingSync(target, Buffer.from('new'), { onLockedRename: 'write-in-place' })
    } catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(StagedSaveError)
    const staged = (error as StagedSaveError).stagedPath
    expect((error as StagedSaveError).cause).toBe(fallbackError)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readFileSync(staged, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toHaveLength(2)
  })
})
