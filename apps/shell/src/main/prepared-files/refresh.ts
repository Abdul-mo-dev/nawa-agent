import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  authorizePath,
  hashFile,
  regularFile,
  validAbsolute,
  within,
} from '../directory-actions/file-safety'
import { confirmedMissing } from './source'

export type PreparationKind = 'search' | 'analysis'
interface Pipeline {
  hash: string
  profile: string
}
interface SavedFile {
  folder: string
  path: string
  search?: Pipeline
  analysis?: Pipeline
}
interface ObservedFile extends SavedFile {
  stamp?: string
  stableSince?: number
  verifiedStamp?: string
  verifiedAt?: number
  missingSince?: number
  retry?: Partial<Record<PreparationKind, number>>
}
interface Options {
  stateDirectory: string
  roots(): Promise<string[]>
  refresh(
    kind: PreparationKind,
    folder: string,
    path: string,
    profile: string,
    signal: AbortSignal,
  ): Promise<void>
  remove(kind: PreparationKind, path: string, signal: AbortSignal): Promise<void>
  changed(directory?: string): void
  /** Injected only by tests; production uses directory notifications plus polling. */
  watchDirectory?: typeof watch
  now?: () => number
  stableMs?: number
  missingMs?: number
}
const kinds: PreparationKind[] = ['analysis', 'search']
const key = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const MAX_FILES = 4096
const POLL_MS = 30000
const VERIFY_MS = 300000

/** Tracks only explicitly prepared paths. Parsing and validation stay in the native services. */
export class PreparedFileRefresh {
  private files = new Map<string, ObservedFile>()
  private watchers = new Map<string, FSWatcher>()
  private paused = new Set<PreparationKind>()
  private pauseVersion: Record<PreparationKind, number> = { analysis: 0, search: 0 }
  private clearVersion: Record<PreparationKind, number> = { analysis: 0, search: 0 }
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private stopped = false
  private manifest: string
  private readonly ready: Promise<void>
  private readonly now: () => number
  private readonly stableMs: number
  private readonly missingMs: number

  constructor(private options: Options) {
    this.manifest = join(options.stateDirectory, 'prepared-files-v1.json')
    this.now = options.now ?? Date.now
    this.stableMs = options.stableMs ?? 1500
    this.missingMs = options.missingMs ?? 5000
    this.ready = this.load()
  }
  private async load(): Promise<void> {
    try {
      const stat = await lstat(this.manifest)
      if (stat.size > 2 * 1024 * 1024) return
      const saved = JSON.parse(await readFile(this.manifest, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.files)) return
      if (Array.isArray(saved.paused))
        for (const kind of kinds) if (saved.paused.includes(kind)) this.paused.add(kind)
      for (const file of saved.files.slice(0, MAX_FILES)) {
        try {
          validAbsolute(file.folder)
          validAbsolute(file.path)
          if (!within(file.folder, file.path) || key(file.folder) === key(file.path)) continue
          const entry: ObservedFile = { folder: file.folder, path: file.path }
          for (const kind of kinds) {
            const pipeline = file[kind]
            if (
              pipeline &&
              typeof pipeline.hash === 'string' &&
              /^(?:[a-f0-9]{64})?$/.test(pipeline.hash) &&
              typeof pipeline.profile === 'string' &&
              pipeline.profile.length <= 128
            )
              entry[kind] = { hash: pipeline.hash, profile: pipeline.profile }
          }
          if (entry.search || entry.analysis) this.files.set(key(entry.path), entry)
        } catch {
          /* Ignore malformed records; they confer no indexing scope. */
        }
      }
    } catch {
      /* A missing/damaged manifest does not widen background access. */
    }
  }
  start(): void {
    if (this.stopped || this.interval) return
    this.interval = setInterval(() => this.schedule(), POLL_MS)
    this.interval.unref()
    this.schedule()
  }
  private save(): Promise<void> {
    const files: SavedFile[] = [...this.files.values()].map(
      ({ folder, path, search, analysis }) => ({ folder, path, search, analysis }),
    )
    const content = JSON.stringify({ version: 1, files, paused: [...this.paused] })
    const write = async () => {
      if (this.stopped) return
      await mkdir(dirname(this.manifest), { recursive: true })
      const temporary = this.manifest + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
        await rename(temporary, this.manifest)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
    const result = this.writes.then(write, write)
    this.writes = result.catch(() => undefined)
    return result
  }
  async remember(
    kind: PreparationKind,
    folder: string,
    sources: { path: string; hash: string }[],
    profile = '',
  ): Promise<void> {
    const pauseVersion = this.pauseVersion[kind],
      clearVersion = this.clearVersion[kind]
    await this.ready
    if (this.stopped) return
    const roots = await this.options.roots()
    await authorizePath(roots, folder)
    const authorized: { path: string; hash: string }[] = []
    for (const source of sources) {
      if (!within(folder, source.path) || !/^[a-f0-9]{64}$/.test(source.hash)) continue
      try {
        await regularFile(roots, source.path, Number.MAX_SAFE_INTEGER)
      } catch {
        continue
      }
      authorized.push(source)
    }
    if (this.stopped || this.clearVersion[kind] !== clearVersion) return
    for (const source of authorized) {
      const id = key(source.path)
      if (!this.files.has(id) && this.files.size >= MAX_FILES) continue
      const entry = this.files.get(id) ?? { folder, path: source.path }
      entry[kind] = { hash: source.hash, profile }
      if (entry.retry) delete entry.retry[kind]
      this.files.set(id, entry)
    }
    if (this.pauseVersion[kind] === pauseVersion) this.paused.delete(kind)
    await this.save()
    this.start()
    this.schedule()
  }
  async forget(kind: PreparationKind, folder: string): Promise<void> {
    this.clearVersion[kind]++
    await this.ready
    for (const [id, entry] of this.files)
      if (within(folder, entry.path)) {
        delete entry[kind]
        if (!entry.analysis && !entry.search) this.files.delete(id)
      }
    await this.save()
    this.schedule()
  }
  /** Stop remains stopped until the user explicitly prepares this engine again. */
  pause(kind: PreparationKind): void {
    this.pauseVersion[kind]++
    this.paused.add(kind)
    void this.ready.then(() => this.save()).catch(() => undefined)
  }
  private schedule(delay = this.stableMs): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check().catch(() => undefined)
    }, delay)
    this.timer.unref()
  }
  private async syncWatchers(roots: string[]): Promise<void> {
    const directories = new Set(
      [...this.files.values()]
        .filter((file) => roots.some((root) => within(root, file.path)))
        .map((file) => dirname(file.path)),
    )
    for (const [dir, watcher] of this.watchers)
      if (!directories.has(dir)) {
        watcher.close()
        this.watchers.delete(dir)
      }
    for (const dir of directories) {
      if (this.stopped || this.watchers.has(dir) || this.watchers.size >= 128) continue
      try {
        await authorizePath(roots, dir)
        if (this.stopped) return
        const watcher = (this.options.watchDirectory ?? watch)(dir, { persistent: false }, () => {
          this.options.changed(dir)
          this.schedule()
        })
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, watcher)
      } catch {
        /* Polling covers unavailable directories and watcher limits. */
      }
    }
  }
  /** Public for deterministic integration checks; concurrent notifications share one pass. */
  async check(): Promise<void> {
    await this.ready
    if (this.stopped) return
    if (this.running) {
      this.schedule()
      return this.running
    }
    const run = this.run()
    this.running = run
    try {
      await run
    } finally {
      this.running = undefined
    }
  }
  private async run(): Promise<void> {
    const roots = await this.options.roots()
    await this.syncWatchers(roots)
    const work: Record<PreparationKind, (() => Promise<void>)[]> = { analysis: [], search: [] }
    for (const entry of [...this.files.values()]) {
      if (this.stopped) return
      if (!roots.some((root) => within(root, entry.path))) continue
      const time = this.now()
      try {
        await regularFile(roots, entry.path, Number.MAX_SAFE_INTEGER)
        const stat = await lstat(entry.path)
        const stamp = JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino])
        entry.missingSince = undefined
        if (entry.stamp !== stamp) {
          entry.stamp = stamp
          entry.stableSince = time
          this.options.changed(dirname(entry.path))
          this.schedule()
          continue
        }
        if (time - entry.stableSince! < this.stableMs) {
          this.schedule()
          continue
        }
        const retryDue = kinds.some(
          (kind) => entry.retry?.[kind] !== undefined && entry.retry[kind]! <= time,
        )
        if (!retryDue && entry.verifiedStamp === stamp && time - entry.verifiedAt! < VERIFY_MS)
          continue
        const hash = await hashFile(entry.path)
        entry.verifiedStamp = stamp
        entry.verifiedAt = time
        // Separate promises keep an unavailable embedding service from blocking table preparation.
        for (const kind of kinds)
          work[kind].push(async () => {
            const pipeline = entry[kind]
            if (
              !pipeline ||
              this.paused.has(kind) ||
              pipeline.hash === hash ||
              (entry.retry?.[kind] ?? 0) > time
            )
              return
            try {
              await this.options.refresh(
                kind,
                entry.folder,
                entry.path,
                pipeline.profile,
                this.controller.signal,
              )
              if (this.stopped || entry[kind] !== pipeline) return
              if ((await hashFile(entry.path)) !== hash) {
                entry.verifiedStamp = undefined
                this.schedule()
                return
              }
              pipeline.hash = hash
              if (entry.retry) delete entry.retry[kind]
              await this.save()
            } catch {
              entry.retry ??= {}
              entry.retry[kind] = this.now() + 60000
            }
          })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        try {
          if (!(await confirmedMissing(roots, entry.path))) continue
          if (entry.missingSince === undefined) {
            entry.missingSince = time
            this.options.changed(dirname(entry.path))
            this.schedule(this.missingMs)
            continue
          }
          if (time - entry.missingSince < this.missingMs) {
            this.schedule(this.missingMs)
            continue
          }
          for (const kind of kinds)
            work[kind].push(async () => {
              const pipeline = entry[kind]
              if (!pipeline?.hash || this.paused.has(kind)) return
              await this.options.remove(kind, entry.path, this.controller.signal)
              if (this.stopped || entry[kind] !== pipeline) return
              pipeline.hash = ''
              entry.verifiedStamp = undefined
              await this.save()
            })
        } catch {
          /* Disconnected roots and access errors never justify cache deletion. */
        }
      }
    }
    await Promise.allSettled(
      kinds.map(async (kind) => {
        for (const job of work[kind]) {
          if (this.stopped) return
          try {
            await job()
          } catch {
            /* Retry deletion when access and the engine are available. */
          }
        }
      }),
    )
  }
  stop(): void {
    this.stopped = true
    this.controller.abort()
    clearTimeout(this.timer)
    clearInterval(this.interval)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}
