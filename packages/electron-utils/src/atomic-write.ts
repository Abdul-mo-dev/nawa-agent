import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRIES = 4

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const stagedPathFor = (filePath: string) =>
  join(dirname(filePath), `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)

export interface StagedSaveOptions {
  /** Keep the existing Windows save fallback for editors that already use it. */
  onLockedRename?: 'fail' | 'write-in-place'
}

/** The completed staged copy remains on disk if committing the save fails. */
export class StagedSaveError extends Error {
  constructor(
    readonly stagedPath: string,
    cause: unknown,
  ) {
    super(`Save failed; a complete staged copy remains at ${stagedPath}: ${String(cause)}`, {
      cause,
    })
    this.name = 'StagedSaveError'
  }
}

/**
 * Stage bytes beside the destination and retry transient Windows rename locks.
 * Callers that previously used an in-place fallback can retain that behavior.
 */
export async function saveFileWithStaging(
  filePath: string,
  data: Uint8Array,
  options: StagedSaveOptions = {},
): Promise<void> {
  const stagedPath = stagedPathFor(filePath)

  try {
    await writeFile(stagedPath, data, { flag: 'wx', flush: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await rm(stagedPath, { force: true }).catch(() => {})
    }
    throw error
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(stagedPath, filePath)
      return
    } catch (error) {
      const retryable = RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
      if (retryable && attempt < RENAME_RETRIES) {
        await sleep(50 * 2 ** attempt)
        continue
      }

      if (retryable && options.onLockedRename === 'write-in-place') {
        try {
          await writeFile(filePath, data, { flush: true })
        } catch (fallbackError) {
          throw new StagedSaveError(stagedPath, fallbackError)
        }
        await rm(stagedPath, { force: true }).catch(() => {})
        return
      }

      throw new StagedSaveError(stagedPath, error)
    }
  }
}

/** Synchronous variant for CLI output; keeps the target's existing file mode. */
export function saveFileWithStagingSync(
  filePath: string,
  data: Uint8Array | string,
  options: StagedSaveOptions = {},
): void {
  const stagedPath = stagedPathFor(filePath)
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o7777 : undefined

  try {
    writeFileSync(stagedPath, data, {
      flag: 'wx',
      flush: true,
      ...(mode === undefined ? {} : { mode }),
    })
    if (mode !== undefined) chmodSync(stagedPath, mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        rmSync(stagedPath, { force: true })
      } catch {
        // Keep the original write error.
      }
    }
    throw error
  }

  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(stagedPath, filePath)
      return
    } catch (error) {
      const retryable = RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
      if (retryable && attempt < RENAME_RETRIES) {
        Atomics.wait(waitCell, 0, 0, 50 * 2 ** attempt)
        continue
      }

      if (retryable && options.onLockedRename === 'write-in-place') {
        try {
          writeFileSync(filePath, data, { flush: true })
        } catch (fallbackError) {
          throw new StagedSaveError(stagedPath, fallbackError)
        }
        try {
          rmSync(stagedPath, { force: true })
        } catch {
          // The destination has the complete bytes; a stale temp can be cleaned later.
        }
        return
      }

      throw new StagedSaveError(stagedPath, error)
    }
  }
}
