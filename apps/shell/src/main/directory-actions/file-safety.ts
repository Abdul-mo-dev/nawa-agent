import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, rm, unlink, link, rename } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
export const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
export const within = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function safeName(name: string): boolean {
  return !!name && name.length <= 200 && name === name.trim() && !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) && name !== '.' && name !== '..'
}
export function validAbsolute(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || path.includes('\0') ||
    (process.platform === 'win32' && (path.slice(2).includes(':') || path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')))) {
    throw new Error('Choose an ordinary absolute workspace path.')
  }
}
/** Reject symlinks/junctions and hardlinked files. Registered roots are revalidated each time. */
export async function authorizePath(roots: readonly string[], path: string): Promise<void> {
  validAbsolute(path)
  const root = roots.find(value => within(value, path))
  if (!root) throw new Error('Path is outside the registered workspace folders.')
  const canonicalRoot = await realpath(root)
  if (!samePath(root, canonicalRoot)) throw new Error('The workspace root now points somewhere else.')
  const parts = relative(root, path).split(sep).filter(Boolean)
  let current = root
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) {
      throw new Error('Linked or special filesystem entries are not supported.')
    }
    if (!samePath(current, await realpath(current))) throw new Error('Workspace path aliases are not supported.')
  }
}
export async function regularFile(roots: readonly string[], path: string, max = MAX_DOCUMENT_BYTES): Promise<void> {
  await authorizePath(roots, path)
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error('Select an individual file, not a folder.')
  if (stat.size > max) throw new Error(`File exceeds the ${Math.round(max / 1048576)} MiB limit.`)
}
export async function hashFile(path: string): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new Error('Cannot hash linked or special file.')
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const data of stream) hash.update(data)
  const after = await lstat(path)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) {
    throw new Error('The file changed while it was being checked. Retry the action.')
  }
  return hash.digest('hex')
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause }
}
/** Same-directory temporary file; never overwrite a newly appeared create destination. */
export async function publishFile(stage: string, target: string, replace: boolean, validate: () => Promise<void>): Promise<void> {
  const temporary = join(dirname(target), `.nawa-${randomUUID()}.tmp`)
  try {
    await copyFile(stage, temporary, constants.COPYFILE_EXCL)
    const file = await open(temporary, 'r+'); try { await file.sync() } finally { await file.close() }
    await validate()
    if (replace) await rename(temporary, target)
    else { await link(temporary, target); await unlink(temporary) }
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

/** App-internal Explorer clipboard. A collision creates a copy name, never replaces data. */
export async function copyWorkspacePaths(roots: readonly string[], paths: string[], destination: string) {
  validAbsolute(destination)
  await authorizePath(roots, destination)
  if (!(await lstat(destination)).isDirectory()) throw new Error('Paste destination must be a directory.')
  if (!Array.isArray(paths) || paths.length > 200) throw new Error('Select at most 200 items to copy.')
  const copied: { from: string; to: string }[] = [], failed: { path: string; error: string }[] = []
  let count = 0, bytes = 0
  const started = Date.now()
  const sourcePaths = [...new Set(paths)].filter(p => !paths.some(parent => parent !== p && within(parent, p)))
  for (const source of sourcePaths) {
    let target: string | null = null
    try {
      validAbsolute(source); await authorizePath(roots, source)
      const stat = await lstat(source)
      if (stat.isDirectory() && within(source, destination)) throw new Error('A folder cannot be copied into itself or its descendants.')
      const ext = stat.isDirectory() ? '' : extname(source), stem = basename(source, ext)
      // Reserve atomically, including on case-insensitive Windows filesystems.
      for (let number = 0; number < 10000; number++) {
        const candidate = join(destination, number ? `${stem} - Copy${number > 1 ? ` (${number})` : ''}${ext}` : basename(source))
        try {
          if (stat.isDirectory()) await mkdir(candidate)
          else { const reservation = await open(candidate, 'wx'); await reservation.close() }
          target = candidate; break
        } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      }
      if (!target) throw new Error('Could not reserve a unique copy name.')
      const visit = async (from: string, to: string, reserved = false): Promise<void> => {
        if (++count > 20000 || Date.now() - started > 120000) throw new Error('Copy limit reached. Copy a smaller selection.')
        await authorizePath(roots, from)
        await authorizePath(roots, dirname(to))
        const info = await lstat(from)
        if (info.isDirectory()) {
          if (!reserved) await mkdir(to)
          for (const entry of await readdir(from)) await visit(join(from, entry), join(to, entry))
        } else {
          bytes += info.size
          if (bytes > 2 * 1024 * 1024 * 1024) throw new Error('Copy exceeds the 2 GiB per-operation limit.')
          // A reserved root is owned by this call; nested files must not exist.
          await copyFile(from, to, reserved ? 0 : constants.COPYFILE_EXCL)
        }
      }
      await visit(source, target, true)
      copied.push({ from: source, to: target })
    } catch (cause) {
      if (target) await rm(target, { recursive: true, force: true }).catch(() => undefined)
      failed.push({ path: String(source), error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return { copied, failed }
}
