import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { directoryToolAllowed, DIRECTORY_PROTOCOL_VERSION, type AgentToolCall, type ToolExecution } from '@genoffice/agent-core'
import type { DirectoryInspection } from '../../shared/directory-actions-api'
import type { ActionDependencies, NativeStage } from './manager'
import { hashFile, samePath } from './file-safety'

const FORMATS = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown', '.html', '.htm'])
const MAX_SESSIONS_PER_RUN = 3
interface Session {
  id: string; owner: number; run: string; path: string; stagePath: string
  hash: string; native?: NativeStage; description?: DirectoryInspection
  busy: boolean; cancelled: boolean; openedAt: number
}

/** Saved-byte snapshots only. This service has no save, commit, trash or creation API. */
export class DirectoryInspectionManager {
  private sessions = new Map<string, Session>()
  private sources = new Map<string, { owner: number; run: string; path: string; hash: string }>()
  constructor(private deps: ActionDependencies,
    private authorize: (owner: number, run: string, path: string) => Promise<void>) {}
  private item(owner: number, run: string, id: string): Session {
    const item = this.sessions.get(id)
    if (!item || item.owner !== owner || item.run !== run || item.cancelled) throw new Error('Native inspection expired or was cancelled.')
    return item
  }
  private async validate(item: Session): Promise<void> {
    this.item(item.owner, item.run, item.id)
    await this.authorize(item.owner, item.run, item.path)
    if (await hashFile(item.path) !== item.hash) throw new Error('The saved file changed. Close this inspection and inspect the file again.')
    this.item(item.owner, item.run, item.id)
  }
  async open(owner: number, run: string, path: string): Promise<DirectoryInspection> {
    await this.authorize(owner, run, path)
    if (!FORMATS.has(extname(path).toLowerCase())) throw new Error('Native inspection supports DOCX, XLSX, PPTX, PDF, Markdown and HTML. Use read_file for other supported text formats.')
    const existing = [...this.sessions.values()].find(s => s.owner === owner && s.run === run && samePath(s.path, path))
    if (existing) {
      if (existing.busy || !existing.description) throw new Error('Native inspection is still opening or running.')
      try { await this.validate(existing); return existing.description }
      catch (cause) { await this.close(owner, run, existing.id); throw cause }
    }
    if ([...this.sessions.values()].filter(s => s.owner === owner && s.run === run).length >= MAX_SESSIONS_PER_RUN) {
      throw new Error('Three native inspections are already open. Close one with close_inspection before opening another.')
    }
    const id = randomUUID()
    const stagePath = join(this.deps.stateDirectory, 'directory-inspection', id, basename(path))
    const item: Session = { id, owner, run, path, stagePath, hash: '', busy: true, cancelled: false, openedAt: Date.now() }
    // Reserve the slot before asynchronous work; also lets cancellation find an opening session.
    this.sessions.set(id, item)
    try {
      item.hash = await hashFile(path)
      await mkdir(dirname(stagePath), { recursive: true })
      await copyFile(path, stagePath, constants.COPYFILE_EXCL)
      if (await hashFile(stagePath) !== item.hash) throw new Error('The file changed while its inspection snapshot was copied.')
      await this.validate(item)
      item.native = await this.deps.open(stagePath)
      this.item(owner, run, id)
      const description = await item.native.describe('read')
      if (description.protocolVersion !== DIRECTORY_PROTOCOL_VERSION || description.mode !== 'read' || !description.capabilities?.lifecycle) throw new Error('Native read-only bridge is missing or stale. Rebuild all editors and the shell.')
      // Main process applies its own policy; the renderer descriptor cannot grant writes.
      description.tools = description.tools.filter(t => directoryToolAllowed(description.kind, 'read', t.name))
      if (!description.tools.length) throw new Error('No native read tools are available.')
      await this.validate(item)
      item.description = { ...description, id, path, sourceHash: item.hash, source: 'saved-file-snapshot', openedAt: item.openedAt }
      for (const [oldId, source] of this.sources) if (source.owner === owner && source.run === run && samePath(source.path, path)) this.sources.delete(oldId)
      this.sources.set(id, { owner, run, path, hash: item.hash })
      return item.description
    } catch (cause) {
      item.cancelled = true
      throw cause
    } finally {
      item.busy = false
      if (item.cancelled) await this.cleanup(item)
    }
  }
  async execute(owner: number, run: string, id: string, call: AgentToolCall): Promise<ToolExecution> {
    const item = this.item(owner, run, id)
    if (item.busy || !item.description || !item.native) throw new Error('Native inspection is not ready.')
    if (!call || typeof call.name !== 'string' || typeof call.id !== 'string' ||
      !item.description.tools.some(t => t.name === call.name) || !directoryToolAllowed(item.description.kind, 'read', call.name)) {
      throw new Error('This tool is not allowed in a read-only inspection.')
    }
    if (JSON.stringify(call).length > 512000) throw new Error('Native tool arguments are too large.')
    item.busy = true
    try {
      await this.validate(item)
      const result = await item.native.execute(call)
      if (result.mutated) throw new Error('A native read tool reported a mutation. Inspection revoked; original remains unchanged.')
      await this.validate(item)
      return result
    } catch (cause) {
      item.cancelled = true
      throw cause
    } finally {
      item.busy = false
      if (item.cancelled) await this.cleanup(item)
    }
  }
  async verify(owner: number, run: string, text: string): Promise<string | null> {
    if (typeof text !== 'string' || text.length > 128000) throw new Error('Invalid response for native verification.')
    for (const source of this.sources.values()) if (source.owner === owner && source.run === run) {
      await this.authorize(owner, run, source.path)
      if (await hashFile(source.path) !== source.hash) throw new Error('An inspected source changed, including a closed inspection. Read it again before using its evidence.')
      await this.authorize(owner, run, source.path)
    }
    for (const item of [...this.sessions.values()].filter(s => s.owner === owner && s.run === run)) {
      if (item.busy || !item.native) throw new Error('An inspection is still running.')
      item.busy = true
      try {
        await this.validate(item)
        const correction = await item.native.verify(text)
        await this.validate(item)
        if (correction) return correction + '\nOnly a private read-only copy is open. Do not claim to select or modify the user’s visible document; reword any such claim.'
      } catch (cause) { item.cancelled = true; throw cause }
      finally { item.busy = false; if (item.cancelled) await this.cleanup(item) }
    }
    return null
  }
  private async cleanup(item: Session): Promise<void> {
    try { await item.native?.close() } catch { /* A dead renderer must not leak its snapshot. */ } finally {
      item.native = undefined
      await rm(dirname(item.stagePath), { recursive: true, force: true }).catch(() => undefined)
      this.sessions.delete(item.id)
    }
  }
  async close(owner: number, run: string, id: string): Promise<void> {
    const item = this.sessions.get(id)
    if (!item) return
    if (item.owner !== owner || item.run !== run) throw new Error('Inspection belongs to another workspace run.')
    item.cancelled = true
    // Interrupt native RPC immediately, but leave copying/initialization cleanup to finally.
    await item.native?.close().catch(() => undefined)
    if (!item.busy) await this.cleanup(item)
  }
  async invalidatePath(owner: number, run: string, path: string): Promise<void> {
    for (const [id, source] of this.sources) if (source.owner === owner && source.run === run && samePath(source.path, path)) this.sources.delete(id)
    await Promise.all([...this.sessions.values()].filter(s => s.owner === owner && s.run === run && samePath(s.path, path)).map(s => this.close(owner, run, s.id)))
  }
  async cancelRun(owner: number, run: string): Promise<void> {
    for (const [id, source] of this.sources) if (source.owner === owner && source.run === run) this.sources.delete(id)
    await Promise.all([...this.sessions.values()].filter(s => s.owner === owner && s.run === run).map(s => this.close(owner, run, s.id)))
  }
}
