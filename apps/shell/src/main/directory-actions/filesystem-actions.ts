import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { DirectoryActionScope, DirectoryApproval, DirectoryCommit, DirectoryProposal } from '../../shared/directory-actions-api'
import { isPermanentAction } from '../../shared/directory-actions-api'
import { authorizePath, exists, hashFile, publishFile, regularFile, safeName, samePath, validAbsolute, within } from './file-safety'

interface Entry { path: string; directory: boolean; bytes: number; hash?: string; identity: string }
export interface FilesystemSnapshot { entries: Entry[]; digest: string; inventory: NonNullable<DirectoryApproval['inventory']> }
interface Context { roots: string[]; scope: DirectoryActionScope; assertClosed(path: string): Promise<void>; check(): void }
const identity = (stat: Awaited<ReturnType<typeof lstat>>) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
const fingerprint = (entries: Entry[]) => createHash('sha256').update(JSON.stringify(entries)).digest('hex')

/** Folder selection permits this local integrity inventory, never child content in model context. */
async function snapshot(path: string, folder: boolean, ctx: Context): Promise<FilesystemSnapshot> {
  const entries: Entry[] = []; let bytes = 0
  const started = Date.now()
  const visit = async (current: string) => {
    ctx.check()
    if (entries.length >= 2000 || Date.now() - started > 30000) throw new Error('Folder inventory limit reached (2,000 entries / 30 seconds). Select a smaller folder.')
    await authorizePath(ctx.roots, current)
    const stat = await lstat(current)
    if (stat.isDirectory()) {
      entries.push({ path: current, directory: true, bytes: 0, identity: identity(stat) })
      for (const child of (await readdir(current)).sort()) await visit(join(current, child))
    } else {
      await regularFile(ctx.roots, current)
      bytes += stat.size
      if (bytes > 512 * 1024 * 1024) throw new Error('Folder inventory exceeds 512 MiB. Select a smaller folder.')
      await ctx.assertClosed(current)
      entries.push({ path: current, directory: false, bytes: stat.size, hash: await hashFile(current), identity: identity(stat) })
    }
  }
  await authorizePath(ctx.roots, path)
  if ((await lstat(path)).isDirectory() !== folder) throw new Error(folder ? 'Select a folder.' : 'Select an individual file.')
  await visit(path); ctx.check()
  return { entries, digest: fingerprint(entries), inventory: {
    files: entries.filter(e => !e.directory).length, folders: entries.filter(e => e.directory).length,
    bytes, entries: entries.map(e => (relative(path, e.path) || basename(path)) + (e.directory ? '/' : '')),
  } }
}

async function authority(request: DirectoryProposal, ctx: Context): Promise<void> {
  ctx.check(); validAbsolute(request.path)
  if (request.workflow) throw new Error('Filesystem actions do not use document-generation workflows.')
  if (request.permanent !== undefined && (request.operation !== 'delete-folder' || typeof request.permanent !== 'boolean')) throw new Error('Invalid permanent-delete option.')
  const target = request.operation === 'create-folder' ? request.path : request.destination
  if (request.operation === 'create-folder') {
    if (request.destination !== undefined) throw new Error('Folder creation takes one destination path.')
  } else if (request.operation === 'delete-folder') {
    if (!ctx.scope.directories.some(p => samePath(p, request.path))) throw new Error('Select the individual folder before deleting it.')
    if (ctx.roots.some(root => within(request.path, root)) || ctx.scope.opened && within(request.path, ctx.scope.opened)) throw new Error('Cannot delete a workspace root or a folder containing the opened directory.')
  } else if (!ctx.scope.files.some(p => samePath(p, request.path))) throw new Error('Select the individual source file first.')
  if (['rename', 'move', 'copy'].includes(request.operation) && !request.destination) throw new Error('A destination filename is required.')
  if (!['rename', 'move', 'copy', 'create-folder'].includes(request.operation) && request.destination !== undefined) throw new Error('Deletion does not accept a destination.')
  if (target) {
    validAbsolute(target)
    if (!safeName(basename(target))) throw new Error('Choose a valid plain filename or folder name.')
    if (request.operation === 'rename') {
      if (!samePath(dirname(request.path), dirname(target))) throw new Error('Rename must stay in the source folder; use move_file to change folders.')
    } else if (![ctx.scope.opened, ...ctx.scope.directories].some(p => p && samePath(p, dirname(target)))) throw new Error('The destination folder must be opened or explicitly selected.')
    await authorizePath(ctx.roots, dirname(target))
    if (!(await lstat(dirname(target))).isDirectory()) throw new Error('Destination parent must be a folder.')
    if (request.operation !== 'create-folder' && samePath(request.path, target)) throw new Error('Source and destination must differ. Case-only renames are not supported.')
    if (await exists(target)) throw new Error('The destination already exists. Choose a different name; existing items are never overwritten.')
  }
  ctx.check()
}

export async function prepareFilesystemAction(request: DirectoryProposal, ctx: Context): Promise<FilesystemSnapshot> {
  await authority(request, ctx)
  return request.operation === 'create-folder'
    ? { entries: [], digest: '', inventory: { files: 0, folders: 0, bytes: 0, entries: [] } }
    : snapshot(request.path, request.operation === 'delete-folder', ctx)
}
export async function validateFilesystemAction(request: DirectoryProposal, expected: FilesystemSnapshot, ctx: Context): Promise<void> {
  const current = await prepareFilesystemAction(request, ctx)
  if (current.digest !== expected.digest) throw new Error('The source or folder contents changed after review. Request a fresh action.')
}

/** Non-recursive removal of precisely inventoried entries; never follow new links or delete new children. */
export async function commitFilesystemAction(request: DirectoryProposal, expected: FilesystemSnapshot, ctx: Context, trash: (path: string) => Promise<void>, confirmation?: unknown): Promise<DirectoryCommit> {
  if (isPermanentAction(request) && confirmation !== basename(request.path)) throw new Error('Type the exact target name in the permanent-deletion approval.')
  await validateFilesystemAction(request, expected, ctx)
  const receipt: DirectoryCommit = { operation: request.operation, path: request.path, destination: request.destination, permanent: isPermanentAction(request) }
  if (request.operation === 'create-folder') { ctx.check(); await mkdir(request.path); return receipt }
  if (request.operation === 'delete-folder' && !request.permanent) { ctx.check(); await trash(request.path); return receipt }
  const validateEntry = async (entry: Entry) => {
    ctx.check(); await authorizePath(ctx.roots, entry.path)
    const stat = await lstat(entry.path)
    if (identity(stat) !== entry.identity || stat.isDirectory() !== entry.directory) throw new Error('A reviewed filesystem entry was replaced.')
    if (!entry.directory) {
      await ctx.assertClosed(entry.path)
      if (await hashFile(entry.path) !== entry.hash) throw new Error('A reviewed file changed.')
    }
    ctx.check()
  }
  if (request.destination) {
    await publishFile(request.path, request.destination, false, () => validateFilesystemAction(request, expected, ctx))
    if (request.operation === 'copy') return receipt
    try {
      await validateEntry(expected.entries[0]!)
      await regularFile(ctx.roots, request.destination)
      if (await hashFile(request.destination) !== expected.entries[0]!.hash) throw new Error('The destination changed before the source could be removed.')
      ctx.check(); await unlink(request.path)
      return receipt
    } catch (cause) {
      // The destination was published. Do not hide it or delete either path during rollback.
      return { ...receipt, status: 'partial', warnings: [`The destination copy was created, but the source was not removed: ${String(cause)}. Review both paths before retrying.`] }
    }
  }
  let removed = 0
  try {
    for (const entry of [...expected.entries].reverse()) {
      await validateEntry(entry)
      if (entry.directory) await rmdir(entry.path)
      else await unlink(entry.path)
      removed++
    }
    return receipt
  } catch (cause) {
    if (!removed) throw cause
    return { ...receipt, status: 'partial', warnings: [`Permanent deletion stopped after removing ${removed} of ${expected.entries.length} entries: ${String(cause)}. Remaining entries were left in place.`] }
  }
}
