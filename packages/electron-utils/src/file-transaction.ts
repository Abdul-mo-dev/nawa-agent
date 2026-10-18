import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const writes = new Map<string, Promise<void>>()
const retryable = new Set(['EPERM', 'EACCES', 'EBUSY'])
const flushUnsupported = new Set(['EPERM', 'EACCES', 'EBUSY', 'EINVAL', 'ENOSYS'])

/** Serialize writes through different editor adapters to the same local file. */
export async function withFileWriteLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  let key = await realpath(path).catch(() => resolve(path))
  if (process.platform === 'win32') key = key.toLowerCase()
  const previous = writes.get(key) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>((done) => {
    release = done
  })
  const tail = previous.then(() => pending)
  writes.set(key, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (writes.get(key) === tail) writes.delete(key)
  }
}

export async function fileRevision(path: string): Promise<string | null> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

export class FileConflictError extends Error {
  constructor(readonly path: string) {
    super('The file changed outside Nawa. Reload it or use Save As to keep your edits in a copy.')
    this.name = 'FileConflictError'
  }
}

export interface FileTransactionOptions {
  /** null requires a new destination; undefined is an explicitly authorized replacement. */
  expectedRevision?: string | null
  beforeCommit?(): void | Promise<void>
}

/** The writer must create its stage exclusively; never stream into the destination. */
export async function replaceFileTransaction(
  path: string,
  writeStage: (stage: string) => Promise<void>,
  options: FileTransactionOptions = {},
): Promise<void> {
  await withFileWriteLock(path, async () => {
    const check = async () => {
      if (
        options.expectedRevision !== undefined &&
        (await fileRevision(path)) !== options.expectedRevision
      )
        throw new FileConflictError(path)
    }
    await check()
    const stage = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`)
    let created = false
    try {
      const mode = await stat(path).then(
        (s) => s.mode & 0o777,
        (cause) => {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw cause
        },
      )
      await writeStage(stage)
      created = true
      if (mode !== undefined) await chmod(stage, mode)
      const handle = await open(stage, 'r+')
      try {
        await handle.sync()
      } catch (cause) {
        if (!flushUnsupported.has((cause as NodeJS.ErrnoException).code ?? '')) throw cause
      } finally {
        await handle.close()
      }
      await options.beforeCommit?.()
      await check()
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(stage, path)
          break
        } catch (cause) {
          if (!retryable.has((cause as NodeJS.ErrnoException).code ?? '') || attempt >= 4)
            throw cause
          await new Promise((done) => setTimeout(done, 50 * 2 ** attempt))
          await options.beforeCommit?.()
          await check()
        }
      }
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r').catch(() => null)
        if (directory) {
          try {
            await directory.sync()
          } catch {
            /* Some filesystems cannot flush directories. */
          } finally {
            await directory.close().catch(() => {})
          }
        }
      }
    } catch (cause) {
      // A partial stage has no recovery value. A complete stage stays available if a
      // locked destination cannot be committed; the original is always untouched.
      if (
        (!created || cause instanceof FileConflictError) &&
        (cause as NodeJS.ErrnoException).code !== 'EEXIST'
      )
        await rm(stage, { force: true }).catch(() => {})
      if (created && !(cause instanceof FileConflictError)) {
        throw new Error(
          `Save failed; the original is unchanged and a completed copy remains at ${stage}`,
          { cause },
        )
      }
      throw cause
    }
  })
}
