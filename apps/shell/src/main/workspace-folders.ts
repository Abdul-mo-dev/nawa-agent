import { constants, existsSync, lstatSync, realpathSync } from 'node:fs'
import { access, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FolderRoot, FolderListing } from '../shared/home-api'
import type { WorkspaceScope } from '../shared/workspace-api'

const MAX_ROOTS = 32
const MAX_ENTRIES = 10_000
const MAX_SCOPE_FILES = 256
const MAX_SCOPE_DIRECTORIES = 512
const MAX_SCOPE_DEPTH = 32
const OFFICE_EXTENSIONS = new Set([
  'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'csv', 'pptx', 'ppt',
  'pdf', 'md', 'markdown', 'html', 'htm',
])

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 &&
    !value.includes('\0') && isAbsolute(value)
}

/** path.relative handles filesystem roots and Windows drive/UNC boundaries correctly. */
export function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === ''
}

function hidden(dir: string, name: string, directory: boolean): boolean {
  const lower = name.toLowerCase()
  return name.startsWith('.') || name.startsWith('~$') ||
    (directory
      ? lower === 'node_modules' || lower === '__macosx' ||
        (lower === 'assets' && existsSync(join(dir, name, '.genoffice-assets.json')))
      : lower === 'thumbs.db' || lower === 'desktop.ini')
}

function supported(name: string): boolean {
  return OFFICE_EXTENSIONS.has(extname(name).slice(1).toLowerCase())
}

function nameOrder(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true })
}

export interface WorkspaceFolderStoreOptions {
  statePath: string
  /** Used ONCE to migrate the old single-folder workspace; never used after an empty list is saved. */
  initialRoot?: () => string
}

/**
 * Only metadata is written by this store. Native picker results, never renderer-provided
 * paths, are passed to add(). List/read operations require an explicitly registered root.
 */
export class WorkspaceFolderStore {
  private roots: string[] = []
  private loaded: Promise<void> | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: WorkspaceFolderStoreOptions) {}

  private async initialize(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.options.statePath, 'utf8'))
      if (!data || typeof data !== 'object' || !('roots' in data) ||
          !Array.isArray(data.roots) || !('version' in data) || data.version !== 1) {
        throw new Error('The workspace folder list is invalid. Restore its backup before adding folders.')
      }
      const roots: string[] = []
      for (const path of data.roots) {
        if (!validPath(path)) throw new Error('The workspace folder list contains an invalid path.')
        const normalized = resolve(path)
        if (!roots.some((root) => samePath(root, normalized))) roots.push(normalized)
      }
      if (roots.length > MAX_ROOTS) throw new Error('The workspace folder limit was exceeded.')
      this.roots = roots
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const oldRoot = this.options.initialRoot?.()
      let roots: string[] = []
      if (oldRoot) {
        try { roots = [await this.canonicalDirectory(oldRoot)] } catch { /* no usable legacy root */ }
      }
      await this.persist(roots)
      this.roots = roots
    }
  }

  private ready(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.initialize().catch((error) => {
        this.loaded = null
        throw error
      })
    }
    return this.loaded
  }

  private async canonicalDirectory(path: string): Promise<string> {
    if (!validPath(path)) throw new Error('Choose an existing absolute folder path.')
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('The selected path is not a folder.')
    await access(canonical, constants.R_OK)
    return canonical
  }

  private async persist(roots: string[]): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true })
    const temporary = `${this.options.statePath}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, roots }, null, 2) + '\n', 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, this.options.statePath)
    } finally { await unlink(temporary).catch(() => {}) }
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => { await this.ready(); return action() })
    this.writes = result.catch(() => {})
    return result
  }

  private async describe(path: string): Promise<FolderRoot> {
    let usable = false
    try {
      // A root replaced by a symlink is not silently granted access to its new destination.
      usable = samePath(await this.canonicalDirectory(path), path)
    } catch { /* Keep disconnected/missing roots visible so the user can detach them. */ }
    return { path, name: basename(path) || path, usable }
  }

  async list(): Promise<FolderRoot[]> {
    await this.ready()
    await this.writes
    return Promise.all(this.roots.map((root) => this.describe(root)))
  }

  async add(pickerPath: string): Promise<FolderRoot> {
    return this.mutate(async () => {
      const canonical = await this.canonicalDirectory(pickerPath)
      const existing = this.roots.find((root) => samePath(root, canonical))
      if (existing) return this.describe(existing)
      if (this.roots.length >= MAX_ROOTS) throw new Error(`You can add up to ${MAX_ROOTS} folders.`)
      const next = [...this.roots, canonical]
      await this.persist(next)
      this.roots = next
      return this.describe(canonical)
    })
  }

  async remove(path: string): Promise<void> {
    if (!validPath(path)) throw new Error('Invalid workspace folder.')
    return this.mutate(async () => {
      // Do not stat/realpath here: disconnected roots must still be removable.
      const next = this.roots.filter((root) => !samePath(root, path))
      if (next.length === this.roots.length) return
      await this.persist(next)
      this.roots = next
    })
  }

  /** Synchronous guard for the existing, explicitly user-invoked file-management handlers. */
  contains(path: unknown): path is string {
    if (!validPath(path)) return false
    try {
      const canonical = realpathSync.native(path)
      return this.roots.some((root) => {
        if (!containsPath(root, resolve(path)) || !containsPath(root, canonical)) return false
        return samePath(realpathSync.native(root), root)
      })
    } catch { return false }
  }

  isRoot(path: string): boolean {
    return this.roots.some((root) => samePath(root, resolve(path)))
  }

  async authorize(folder: string, path = folder): Promise<string> {
    await this.ready()
    if (!this.contains(folder) || !this.contains(path)) throw new Error('This folder is not in the workspace.')
    if (!containsPath(resolve(folder), resolve(path))) throw new Error('The file is outside the selected chat folder.')
    const realFolder = await this.canonicalDirectory(folder)
    const canonical = await realpath(path)
    if (!containsPath(realFolder, canonical)) throw new Error('The file is outside the selected chat folder.')
    // Reject aliases below the selected directory, even when their target is also authorized.
    if (!samePath(resolve(path), canonical)) throw new Error('Linked workspace entries are not supported.')
    return canonical
  }

  async authorizeFile(folder: string, path: string): Promise<string> {
    const canonical = await this.authorize(folder, path)
    const info = lstatSync(canonical)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new Error('Choose a regular document, not a link or directory.')
    }
    if (info.size > 64 * 1024 * 1024) throw new Error('This file exceeds the 64 MiB chat limit.')
    if (!supported(canonical)) throw new Error('This document format is not supported in folder chat.')
    return canonical
  }

  async listFolder(dir: string, starred: ReadonlySet<string> = new Set()): Promise<FolderListing> {
    const canonical = await this.authorize(dir)
    const entries = await readdir(canonical, { withFileTypes: true })
    if (entries.length > MAX_ENTRIES) throw new Error('This directory has too many entries. Choose a smaller subfolder.')
    const folders: FolderListing['folders'] = []
    const files: FolderListing['files'] = []
    for (const entry of entries.sort(nameOrder)) {
      if (entry.isSymbolicLink() || hidden(canonical, entry.name, entry.isDirectory())) continue
      if (!entry.isDirectory() && (!entry.isFile() || !supported(entry.name))) continue
      const path = join(canonical, entry.name)
      try {
        const info = await stat(path)
        if (entry.isDirectory()) {
          // Lazy expansion also covers leaf directories containing documents, not just subfolders.
          folders.push({ path, name: entry.name, mtimeMs: info.mtimeMs, hasSubfolders: true })
        } else if (info.nlink === 1) {
          files.push({ path, name: entry.name, ext: extname(path).slice(1).toLowerCase(),
            mtimeMs: info.mtimeMs, sizeBytes: info.size, starred: starred.has(path) })
        }
      } catch { /* A concurrent rename must not discard the rest of the listing. */ }
    }
    return { dir: canonical, folders, files }
  }

  async scope(folder: string): Promise<WorkspaceScope> {
    const root = await this.authorize(folder)
    const queue = [{ path: root, depth: 0 }]
    const paths: string[] = []
    let visited = 0
    let truncated = false
    while (queue.length && visited < MAX_SCOPE_DIRECTORIES && paths.length < MAX_SCOPE_FILES) {
      const current = queue.shift()!
      visited++
      // Recheck on each awaited iteration: removing a root revokes outstanding scans too.
      await this.authorize(folder, current.path)
      let entries
      try { entries = await readdir(current.path, { withFileTypes: true }) } catch {
        truncated = true
        continue
      }
      if (entries.length > MAX_ENTRIES) truncated = true
      for (const entry of entries.sort(nameOrder).slice(0, MAX_ENTRIES)) {
        if (entry.isSymbolicLink() || hidden(current.path, entry.name, entry.isDirectory())) continue
        const path = join(current.path, entry.name)
        if (entry.isDirectory()) {
          if (current.depth >= MAX_SCOPE_DEPTH || queue.length + visited >= MAX_SCOPE_DIRECTORIES) {
            truncated = true
          } else { queue.push({ path, depth: current.depth + 1 }) }
        } else if (entry.isFile() && supported(entry.name)) {
          if (paths.length >= MAX_SCOPE_FILES) { truncated = true; break }
          paths.push(path)
        }
      }
    }
    return { paths, truncated: truncated || queue.length > 0 }
  }
}
