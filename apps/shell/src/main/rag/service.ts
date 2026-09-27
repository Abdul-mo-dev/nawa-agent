import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, ipcMain, safeStorage, type WebContents } from 'electron'
import type { MyAgentToolAction, MyAgentToolResponse } from '../../shared/myagent-tools-api'
import workerPath from './worker?modulePath'
import { RAG_CHANNEL, RAG_CHANGED, DEFAULT_RAG_SETTINGS, type RagProgress, type RagSettings, type RagSettingsView, type RagFileStatus } from '../../shared/rag-api'
import type { FileSearchResult } from '../../shared/file-search-api'
import type { RagJob } from './engine'
import { authorizePath, regularFile, hashFile } from '../directory-actions/file-safety'
import { validateSettings, credentialScope, profileId } from './config'
import { MyAgentRag } from './myagent'
interface Options { roots(): Promise<string[]>; isHomeSender(sender: WebContents): boolean }
interface Saved { settings: RagSettings; encryptedKey: string }
interface Slot { worker: Worker | null }
const blankProgress = (): RagProgress => ({ running: false, folder: '', scanned: 0, embedded: 0, unchanged: 0, failed: 0, chunks: 0, current: '', message: '', incomplete: false })
export class RagService {
  private indexer: Slot = { worker: null }
  private reader: Slot = { worker: null }
  private clients = new Map<number, WebContents>()
  private saved: Saved | null = null
  private state = blankProgress()
  private indexing: { owner: number; id: string; abort: AbortController; done: Promise<unknown> } | null = null
  private settingsWrite: Promise<unknown> = Promise.resolve()
  private settingsBusy = false
  private stopped = false
  private activeRequests = 0
  private readonly directory = join(app.getPath('userData'), 'rag')
  private readonly databasePath = join(this.directory, 'content-v1.sqlite3')
  private readonly mappingPath = join(this.directory, 'myagent-files-v1.json')
  private remote?: MyAgentRag
  constructor(private options: Options) {}
  private myAgent(): MyAgentRag { return this.remote ??= new MyAgentRag(this.mappingPath, () => this.options.roots()) }
  private changed(): void { for (const [id, client] of this.clients) { if (client.isDestroyed()) this.clients.delete(id); else if (this.options.isHomeSender(client)) client.send(RAG_CHANGED) } }
  track(sender: WebContents): void {
    if (this.clients.has(sender.id)) return
    this.clients.set(sender.id, sender)
    const revoke = () => { if (this.indexing?.owner === sender.id) this.indexing.abort.abort(); this.clients.delete(sender.id) }
    sender.once('destroyed', revoke); sender.on('render-process-gone', revoke)
    sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) revoke() })
  }
  private async load(): Promise<Saved> {
    if (this.saved) return this.saved
    try {
      const raw = JSON.parse(await readFile(join(this.directory, 'settings-v1.json'), 'utf8')) as Saved
      if (typeof raw.encryptedKey !== 'string') throw new Error('Invalid protected embedding key.')
      return this.saved = { settings: validateSettings(raw.settings), encryptedKey: raw.encryptedKey }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      return this.saved = { settings: { ...DEFAULT_RAG_SETTINGS }, encryptedKey: '' }
    }
  }
  private async key(settings?: RagSettings, replacement?: string): Promise<string> {
    const current = await this.load()
    if (replacement !== undefined) {
      if (typeof replacement !== 'string' || replacement.length > 8192) throw new Error('Invalid embedding API key.')
      return replacement.trim()
    }
    if (current.encryptedKey && settings && credentialScope(settings) !== credentialScope(current.settings)) throw new Error('The RAG backend or endpoint changed. Re-enter its key or explicitly remove the stored key before saving.')
    if (!current.encryptedKey) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS-protected key storage is unavailable.')
    return safeStorage.decryptString(Buffer.from(current.encryptedKey, 'base64'))
  }
  async settings(): Promise<RagSettingsView> { const saved = await this.load(); return { settings: saved.settings, hasKey: !!saved.encryptedKey, databasePath: saved.settings.backend === 'myagent' ? this.mappingPath : this.databasePath } }
  async save(raw: unknown, replacement?: string): Promise<RagSettingsView> {
    const run = async () => {
      if (this.indexing) throw new Error('Stop indexing before changing embedding settings.')
      this.settingsBusy = true
      try {
        const settings = validateSettings(raw), key = await this.key(settings, replacement)
        if (key && (!safeStorage.isEncryptionAvailable() || (safeStorage as typeof safeStorage & { getSelectedStorageBackend?(): string }).getSelectedStorageBackend?.() === 'basic_text')) throw new Error('Secure OS storage is unavailable. No API key was saved.')
        const next: Saved = { settings, encryptedKey: key ? safeStorage.encryptString(key).toString('base64') : '' }
        await mkdir(this.directory, { recursive: true })
        const tmp = join(this.directory, `settings-${randomUUID()}.tmp`)
        try { await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' }); await rename(tmp, join(this.directory, 'settings-v1.json')) }
        finally { await rm(tmp, { force: true }).catch(() => undefined) }
        this.saved = next; this.changed(); return this.settings()
      } finally { this.settingsBusy = false }
    }
    const result = this.settingsWrite.then(run, run); this.settingsWrite = result.catch(() => undefined); return result
  }
  private getWorker(slot: Slot): Worker {
    if (this.stopped) throw new Error('RAG service is stopping.')
    if (!slot.worker) {
      const worker = new Worker(workerPath, { workerData: { databasePath: this.databasePath, indexer: slot === this.indexer }, resourceLimits: { maxOldGenerationSizeMb: 768 } })
      slot.worker = worker
      worker.on('error', () => { if (slot.worker === worker) slot.worker = null })
      worker.on('exit', () => { if (slot.worker === worker) slot.worker = null })
    }
    return slot.worker
  }
  private async request(slot: Slot, job: RagJob, signal?: AbortSignal, onProgress?: (p: RagProgress) => void, id = randomUUID()): Promise<unknown> {
    signal?.throwIfAborted()
    if (++this.activeRequests > 24) { this.activeRequests--; throw new Error('Too many pending RAG requests. Retry shortly.') }
    try {
      const roots = await this.options.roots()
      job.roots = roots
      if (job.folder) await authorizePath(roots, job.folder)
      if (job.paths) for (const path of job.paths) await authorizePath(roots, job.action === 'statuses' ? dirname(path) : path)
      const worker = this.getWorker(slot)
      const value = await new Promise<unknown>((resolve, reject) => {
        let ended = false, killing: ReturnType<typeof setTimeout> | undefined, checking = false
        const cleanup = () => { clearTimeout(timer); clearTimeout(killing); clearInterval(watch); signal?.removeEventListener('abort', abort); worker.off('message', message); worker.off('error', fail); worker.off('exit', exit); worker.off('message', updateActivity) }
        const finish = (error?: Error, result?: unknown) => { if (ended) return; ended = true; cleanup(); error ? reject(error) : resolve(result) }
        const drop = () => { if (slot.worker === worker) slot.worker = null; void worker.terminate() }
        const fail = (error: Error) => { drop(); finish(error) }
        const exit = () => finish(new Error('RAG worker stopped. Completed file generations are retained; retry indexing.'))
        const abort = () => {
          worker.postMessage({ id, cancel: true })
          if (slot === this.indexer) killing ??= setTimeout(() => { drop(); finish(new Error('Indexing cancelled.')) }, 2500)
          else { drop(); finish(new Error('RAG request cancelled.')) }
        }
        const message = (raw: { id: string; progress?: RagProgress; error?: string; result?: unknown }) => {
          if (raw.id !== id) return
          if (raw.progress) { onProgress?.(raw.progress); return }
          finish(raw.error ? new Error(raw.error) : undefined, raw.result)
        }
        // Index jobs have an inactivity watchdog, not a five-minute whole-folder limit.
        let lastActivity = Date.now()
        const updateActivity = (raw: { id?: string }) => { if (raw.id === id) lastActivity = Date.now() }
        worker.on('message', updateActivity)
        const timer = slot === this.indexer ? setInterval(() => { if (Date.now() - lastActivity > Math.max(600000, job.settings.timeoutMs * 4)) fail(new Error('Indexing worker became unresponsive. Retry; completed files are retained.')) }, 10000)
          : setTimeout(() => fail(new Error('RAG request timed out. Narrow the selected files or retry.')), Math.max(120000, job.settings.timeoutMs * 4))
        const watch = setInterval(() => {
          if (checking) return
          checking = true
          void this.options.roots().then(current => { if (roots.some(root => !current.includes(root))) { drop(); finish(new Error('Workspace permissions changed; RAG request cancelled.')) } }, () => { drop(); finish(new Error('Workspace unavailable.')) }).finally(() => { checking = false })
        }, 1000)
        worker.on('message', message); worker.once('error', fail); worker.once('exit', exit)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        else worker.postMessage({ id, job })
      })
      if (slot !== this.indexer) signal?.throwIfAborted()
      if (job.folder) await authorizePath(await this.options.roots(), job.folder)
      return value
    } finally { this.activeRequests-- }
  }
  async test(raw: unknown, replacement?: string): Promise<{ dimensions: number; message: string }> {
    const settings = validateSettings(raw)
    if (settings.backend === 'myagent') return this.myAgent().test(settings, await this.key(settings, replacement))
    if (!settings.model) throw new Error('Enter the embedding model ID/alias first.')
    return await this.request(this.reader, { action: 'test', roots: [], settings, apiKey: await this.key(settings, replacement) }) as { dimensions: number; message: string }
  }
  async index(owner: number, folder: string, recursive: boolean, consent: boolean): Promise<RagProgress> {
    if (!consent) throw new Error('Confirm that the configured RAG backend may index and store this directory’s contents.')
    if (this.indexing || this.settingsBusy) throw new Error('An indexing or settings operation is already running.')
    const saved = await this.load()
    if (!saved.settings.enabled || (saved.settings.backend === 'local' && !saved.settings.model)) throw new Error('Configure and enable the RAG backend in Search settings first.')
    await authorizePath(await this.options.roots(), folder)
    const apiKey = await this.key(saved.settings), abort = new AbortController(), id = randomUUID()
    // No await between the second check and reserving the slot.
    if (this.indexing || this.settingsBusy) throw new Error('Indexing is already running.')
    if (this.saved !== saved) throw new Error('Embedding settings changed while indexing was starting. Review the current endpoint and retry.')
    this.state = { ...blankProgress(), folder, running: true, message: 'Starting directory indexing…' }
    const report = (p: RagProgress) => { this.state = p; this.changed() }
    const done = saved.settings.backend === 'myagent'
      ? this.myAgent().index(saved.settings, apiKey, folder, recursive, abort.signal, report)
      : this.request(this.indexer, { action: 'index', folder, recursive, roots: [], settings: saved.settings, apiKey }, abort.signal, report, id)
    this.indexing = { owner, id, abort, done }
    void done.then(result => { this.state = result as RagProgress }, async e => { this.state = { ...this.state, running: false, incomplete: true, message: e instanceof Error ? e.message : String(e) }; if (saved.settings.backend === 'local') await this.request(this.reader, { action: 'recover', roots: [], settings: saved.settings, apiKey: '' }).catch(() => undefined) }).finally(() => { if (this.indexing?.id === id) this.indexing = null; this.changed() })
    this.changed(); return { ...this.state }
  }
  progress(): RagProgress { return { ...this.state } }
  async cancel(owner: number): Promise<void> {
    if (this.indexing && this.indexing.owner !== owner) throw new Error('The index job belongs to another window.')
    this.indexing?.abort.abort()
    await this.indexing?.done.catch(() => undefined)
  }
  async statuses(paths: string[], verify = false): Promise<RagFileStatus[]> {
    const settings = (await this.load()).settings
    if (settings.backend === 'myagent') return this.myAgent().statuses(settings, paths)
    return await this.request(this.reader, { action: 'statuses', roots: [], settings, apiKey: '', paths, verify }) as RagFileStatus[]
  }
  async clear(folder: string): Promise<void> {
    if (this.indexing) throw new Error('Stop indexing before clearing a folder index.')
    const settings = (await this.load()).settings
    if (settings.backend === 'myagent') { await this.myAgent().clear(settings, folder); this.changed(); return }
    await this.request(this.reader, { action: 'clear', roots: [], settings: (await this.load()).settings, apiKey: '', folder }); this.changed()
  }
  async searchSelected(_owner: number, paths: string[], query: string, signal: AbortSignal, fallback: () => Promise<FileSearchResult>): Promise<FileSearchResult> {
    const saved = await this.load()
    if (!saved.settings.enabled) return { ...await fallback(), backend: 'local-text' }
    if (paths.length > 256) throw new Error('Select at most 256 files for one retrieval request.')
    const roots = await this.options.roots()
    for (const path of paths) await regularFile(roots, path)
    const result = saved.settings.backend === 'myagent'
      ? await this.myAgent().search(saved.settings, await this.key(saved.settings), paths, query, signal)
      : await this.request(this.reader, { action: 'retrieve', roots, paths, query, settings: saved.settings, apiKey: await this.key(saved.settings) }, signal) as FileSearchResult
    if (profileId((await this.load()).settings) !== profileId(saved.settings)) throw new Error('Embedding settings changed during retrieval. Retry with the current profile.')
    const currentRoots = await this.options.roots()
    for (const hit of result.hits) {
      signal.throwIfAborted()
      if (!paths.includes(hit.path)) throw new Error('RAG scope validation failed.')
      await regularFile(currentRoots, hit.path)
      if (await hashFile(hit.path) !== hit.sourceHash) throw new Error('Retrieved source changed; request fresh evidence.')
    }
    return { ...result, localSourcesVerified: true, backend: saved.settings.backend === 'myagent' ? 'myagent' : 'local-rag' }
  }
  async toolsSelected(paths: string[], sessionId: string, action: MyAgentToolAction, payload: unknown, signal: AbortSignal): Promise<MyAgentToolResponse> {
    const saved = await this.load()
    if (!saved.settings.enabled || saved.settings.backend !== 'myagent') {
      if (action !== 'catalog') throw new Error('Enable the MyAgent backend in File search settings to use its document tools.')
      return { available: false, disabled: true, tools: [], total: 0, nextOffset: null, sources: [], warnings: ['Enable the MyAgent backend in File search settings. Nawa native inspection and reviewed-table tools remain available.'] }
    }
    const result = await this.myAgent().tools(saved.settings, await this.key(saved.settings), paths, sessionId, action, payload, signal)
    const current = (await this.load()).settings
    if (!current.enabled || profileId(current) !== profileId(saved.settings)) throw new Error('MyAgent settings changed during tool execution. Start a new request.')
    signal.throwIfAborted()
    return result
  }
  stop(): void { this.stopped = true; this.indexing?.abort.abort(); for (const slot of [this.indexer, this.reader]) { void slot.worker?.terminate(); slot.worker = null } }
}
export function registerRagIpc(options: Options): RagService {
  const service = new RagService(options)
  ipcMain.handle(RAG_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !options.isHomeSender(event.sender)) throw new Error('RAG is available only from the Nawa workspace.')
    service.track(event.sender)
    const folder = () => { if (typeof args[0] !== 'string') throw new Error('Choose an opened workspace directory.'); return args[0] }
    switch (action) {
      case 'settings': return service.settings()
      case 'save': return service.save(args[0], args[1] as string | undefined)
      case 'test': return service.test(args[0], args[1] as string | undefined)
      case 'index': return service.index(event.sender.id, folder(), args[1] === true, args[2] === true)
      case 'progress': return service.progress()
      case 'cancel': return service.cancel(event.sender.id)
      case 'clear': return service.clear(folder())
      case 'statuses': {
        if (!Array.isArray(args[0]) || args[0].length > 256 || !args[0].every(p => typeof p === 'string')) throw new Error('Invalid status request.')
        return service.statuses(args[0] as string[], args[1] === true)
      }
      default: throw new Error('Unknown RAG action.')
    }
  })
  app.once('before-quit', () => service.stop())
  return service
}
