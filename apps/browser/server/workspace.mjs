import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError, requireValue } from './errors.mjs'

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const PRIVATE = /^\.genoffice-(?:write|stage)-/i
export const revisionOf = bytes => createHash('sha256').update(bytes).digest('hex')

/** Apply Windows filename rules on every platform, so tests cover Windows paths too. */
export function relativeParts(value, allowRoot = true) {
  requireValue(typeof value === 'string' && value.length <= 4096, 400, 'Invalid relative path.')
  if (!value && allowRoot) return []
  requireValue(value.length > 0 && !path.win32.isAbsolute(value) && !path.posix.isAbsolute(value), 400, 'Use a path relative to the mounted folder.')
  requireValue(!value.includes('\\'), 400, 'Use / between folders, not backslashes.')
  const parts = value.split('/')
  for (const part of parts) {
    requireValue(part && part !== '.' && part !== '..' && part.length <= 255 &&
      !/[\x00-\x1f<>:"|?*\\]/.test(part) && !/[. ]$/.test(part) && !DEVICE.test(part) && !PRIVATE.test(part),
      400, 'The path contains an invalid or reserved Windows name.', 'INVALID_PATH')
  }
  return parts
}

export function inside(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}

/** FIFO keyed locks. Rejected operations never poison the queue. */
export class KeyedLock {
  #tails = new Map()
  async run(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    this.#tails.set(key, current)
    await previous
    try { return await task() }
    finally {
      release()
      if (this.#tails.get(key) === current) this.#tails.delete(key)
    }
  }
}

export class Workspace {
  mounts = new Map()
  locks = new KeyedLock()
  constructor({ stateDir, maxBytes = DEFAULT_MAX_BYTES }) {
    this.stateDir = stateDir
    this.maxBytes = maxBytes
  }
  async initialize() {
    await fs.mkdir(this.stateDir, { recursive: true })
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.stateDir, 'mounts.json'), 'utf8'))
      for (const item of Array.isArray(saved) ? saved : []) {
        if (typeof item.id !== 'string' || typeof item.root !== 'string') continue
        try { await this.mount(item.root, { id: item.id, readOnly: item.readOnly === true, persist: false }) }
        catch { /* Removed/unplugged folders are not silently replaced with another folder. */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('Could not restore saved mounts:', error.message) }
  }
  async persist() {
    await this.locks.run('settings', async () => {
      const dest = path.join(this.stateDir, 'mounts.json')
      const tmp = `${dest}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmp, JSON.stringify([...this.mounts.values()], null, 2), { flag: 'wx', mode: 0o600 })
        await fs.rename(tmp, dest)
      } finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
    })
  }
  async mount(directory, { id = randomUUID(), readOnly = false, persist = true } = {}) {
    requireValue(typeof directory === 'string' && path.isAbsolute(directory) && !directory.includes('\0'), 400, 'Enter an absolute folder path, for example C:\\Users\\You\\Documents.')
    // Resolve the selected root once. Descendant symlinks/junctions remain forbidden.
    const root = await fs.realpath(directory)
    requireValue((await fs.stat(root)).isDirectory(), 400, 'The mount must be a directory.')
    await fs.access(root, constants.R_OK | (readOnly ? 0 : constants.W_OK))
    const duplicate = [...this.mounts.values()].find(m => path.relative(m.root, root) === '')
    if (duplicate) return duplicate
    const mount = { id, root, name: path.basename(root) || root, readOnly }
    this.mounts.set(id, mount)
    if (persist) await this.persist()
    return mount
  }
  get(id) {
    const mount = this.mounts.get(id)
    requireValue(mount, 404, 'This folder is not mounted.', 'MOUNT_NOT_FOUND')
    return mount
  }
  async unmount(id) { this.get(id); this.mounts.delete(id); await this.persist() }
  async resolve(id, relative = '', { missingLeaf = false, write = false } = {}) {
    const mount = this.get(id)
    requireValue(!write || !mount.readOnly, 403, 'This folder is mounted read-only.')
    const parts = relativeParts(relative)
    const currentRoot = await fs.realpath(mount.root)
    requireValue(path.relative(mount.root, currentRoot) === '', 403, 'The mount root changed. Unmount and mount it again.')
    let target = mount.root
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i])
      try {
        const info = await fs.lstat(target)
        requireValue(!info.isSymbolicLink(), 403, 'Symbolic links and junctions are not accessible through a mount.', 'LINK_BLOCKED')
        requireValue(info.isDirectory() || info.isFile(), 403, 'Only ordinary files and directories are supported.')
        requireValue(!info.isFile() || info.nlink <= 1, 403, 'Files with multiple hard links are not accessible through a mount.', 'LINK_BLOCKED')
        if (i < parts.length - 1) requireValue(info.isDirectory(), 400, 'A parent path is not a directory.')
        requireValue(inside(mount.root, await fs.realpath(target)), 403, 'The path is outside the mounted folder.')
      } catch (error) {
        if (error.code === 'ENOENT' && missingLeaf && i === parts.length - 1) return target
        throw error
      }
    }
    return target
  }
  async fromAbsolute(id, absolute, options = {}) {
    requireValue(typeof absolute === 'string' && path.isAbsolute(absolute), 400, 'An absolute file path was expected.')
    const mount = this.get(id)
    requireValue(inside(mount.root, absolute), 403, 'The path is outside this tab’s mounted folder.', 'OUTSIDE_MOUNT')
    const rel = path.relative(mount.root, absolute).split(path.sep).join('/')
    await this.resolve(id, rel, options)
    return rel
  }
  async list(id, relative = '') {
    const target = await this.resolve(id, relative)
    const entries = await fs.readdir(target, { withFileTypes: true })
    requireValue(entries.length <= 20000, 413, 'This directory has more than 20,000 entries. Open a smaller folder.')
    const visible = entries.filter(e => !PRIVATE.test(e.name))
    const result = []
    // Bounded batches avoid opening thousands of handles at once on Windows.
    for (let offset = 0; offset < visible.length; offset += 64) {
      result.push(...await Promise.all(visible.slice(offset, offset + 64).map(async entry => {
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        try {
          relativeParts(rel)
          const info = await fs.lstat(path.join(target, entry.name))
          const blocked = info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || (!info.isDirectory() && !info.isFile())
          return { name: entry.name, path: rel, kind: blocked ? 'blocked' : info.isDirectory() ? 'directory' : 'file', size: info.size, modified: info.mtime.toISOString() }
        } catch { return { name: entry.name, path: rel, kind: 'blocked', size: 0, modified: null } }
      })))
    }
    result.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    return result
  }
  async read(id, relative) {
    relativeParts(relative, false)
    const target = await this.resolve(id, relative)
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat()
      requireValue(info.isFile() && info.nlink <= 1, 403, 'This is not an ordinary file.')
      requireValue(info.size <= this.maxBytes, 413, `Files must be smaller than ${Math.round(this.maxBytes / 1024 / 1024)} MB.`)
      const bytes = await handle.readFile()
      requireValue(bytes.length <= this.maxBytes, 413, 'The file grew beyond the configured limit.')
      return { bytes, revision: revisionOf(bytes) }
    } finally { await handle.close() }
  }
  async text(id, relative) {
    const { bytes, revision } = await this.read(id, relative)
    requireValue(bytes.length <= 8 * 1024 * 1024, 413, 'The source editor supports text files up to 8 MB.')
    requireValue(!bytes.includes(0), 415, 'This is a binary or UTF-16 file. The source editor supports UTF-8 only.')
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new HttpError(415, 'This file is not valid UTF-8. It has not been modified.') }
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const crlf = (text.match(/\r\n/g) ?? []).length
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length
    return { text, revision, bom, eol: crlf && !lf ? 'crlf' : !crlf ? 'lf' : 'mixed' }
  }
  fileKey(id, relative) {
    const parts = relativeParts(relative, false)
    // Overlapping mounts must serialize writes to the same physical path too.
    return path.resolve(this.get(id).root, ...parts).toLowerCase()
  }
  async write(id, relative, bytes, expectedRevision) {
    relativeParts(relative, false)
    requireValue(Buffer.isBuffer(bytes) && bytes.length <= this.maxBytes, 413, 'The file exceeds the configured size limit.')
    requireValue(expectedRevision === null || /^[a-f0-9]{64}$/.test(expectedRevision ?? ''), 428, 'A file revision is required to save safely.', 'REVISION_REQUIRED')
    const key = this.fileKey(id, relative)
    return this.locks.run(key, async () => {
      const target = await this.resolve(id, relative, { missingLeaf: true, write: true })
      let existing = null
      try { existing = await this.read(id, relative) } catch (error) { if (error.code !== 'ENOENT') throw error }
      requireValue((existing?.revision ?? null) === expectedRevision, 409, 'The file changed on disk. Your edits were not overwritten. Reload it or use Save As.', 'FILE_CONFLICT')
      const temp = path.join(path.dirname(target), `.genoffice-write-${randomUUID()}.tmp`)
      let handle
      try {
        handle = await fs.open(temp, 'wx', existing ? (await fs.stat(target)).mode & 0o777 : 0o600)
        await handle.writeFile(bytes)
        await handle.sync()
        await handle.close(); handle = null
        // Revalidate immediately before commit; do not fall back to unlink + rename.
        await this.resolve(id, relative, { missingLeaf: true, write: true })
        if (expectedRevision === null) {
          // Atomic no-clobber creation on NTFS and POSIX filesystems.
          await fs.link(temp, target)
          await fs.unlink(temp)
        } else {
          const latest = await this.read(id, relative)
          requireValue(latest.revision === expectedRevision, 409, 'The file changed while saving.', 'FILE_CONFLICT')
          for (let attempt = 0; ; attempt++) {
            try { await fs.rename(temp, target); break }
            catch (error) {
              if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error
              await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
            }
          }
        }
        return { revision: revisionOf(bytes), size: bytes.length }
      } finally {
        await handle?.close().catch(() => {})
        await fs.rm(temp, { force: true }).catch(() => {})
      }
    })
  }
  async mkdir(id, relative) {
    relativeParts(relative, false)
    const target = await this.resolve(id, relative, { missingLeaf: true, write: true })
    await fs.mkdir(target) // Never recursive: every parent must have passed mount validation.
    return { path: relative }
  }
}
