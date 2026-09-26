import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { AgentToolCall, ToolExecution, DirectoryEditorDescription } from '@genoffice/agent-core'
import type { DirectoryActionScope, DirectoryApproval, DirectoryCommit, DirectoryProposal } from '../../shared/directory-actions-api'
import { authorizePath, exists, hashFile, publishFile, regularFile, safeName, samePath, validAbsolute } from './file-safety'

export interface NativeStage {
  describe(): Promise<DirectoryEditorDescription>
  execute(call: AgentToolCall): Promise<ToolExecution>
  save(): Promise<void>
  close(): Promise<void>
}
export interface ActionDependencies {
  roots(): Promise<string[]>
  stateDirectory: string
  blank(ext: string): Promise<Uint8Array | string>
  open(path: string): Promise<NativeStage>
  assertClosed(path: string): Promise<void>
  trash(path: string): Promise<void>
  extract(path: string): Promise<string>
  changed(path: string): void
}
interface Run { owner: number; scope: DirectoryActionScope; expires: number; cancelled: boolean }
interface Pending extends DirectoryApproval {
  run: string
  stagePath?: string
  native?: NativeStage
  phase: 'proposed' | 'editing' | 'preview' | 'committing' | 'done' | 'discarded'
  locked: boolean
  tools: Set<string>
}
const FORMATS = new Set(['.docx','.xlsx','.pptx','.pdf','.md','.markdown','.html','.htm'])
const error = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/** Main-process authority for immutable proposals. Renderer/model never supplies saved bytes. */
export class DirectoryActionManager {
  private runs = new Map<string, Run>()
  private pending = new Map<string, Pending>()
  constructor(private deps: ActionDependencies) {}
  async begin(owner: number, raw: DirectoryActionScope): Promise<string> {
    if (!raw || !Array.isArray(raw.files) || !Array.isArray(raw.directories) || raw.files.length + raw.directories.length > 256) throw new Error('Invalid directory selection.')
    const scope = { opened: raw.opened, files: [...new Set(raw.files)], directories: [...new Set(raw.directories)] }
    const roots = await this.deps.roots()
    for (const path of [scope.opened, ...scope.files, ...scope.directories].filter((p): p is string => p !== null)) await authorizePath(roots, path)
    // Only one active directory run per home renderer; old permissions are revoked.
    await this.cancelOwner(owner)
    const id = randomUUID(); this.runs.set(id, { owner, scope, expires: Date.now() + 30 * 60 * 1000, cancelled: false }); return id
  }
  private run(owner: number, id: string): Run {
    const run = this.runs.get(id)
    if (!run || run.owner !== owner || run.cancelled || Date.now() > run.expires) throw new Error('Directory request expired or was cancelled. Send again.')
    return run
  }
  private item(owner: number, id: string): Pending {
    const item = this.pending.get(id)
    if (!item || item.phase === 'done' || item.phase === 'discarded') throw new Error('This approval is no longer active.')
    this.run(owner, item.run); return item
  }
  private view(item: Pending): DirectoryApproval {
    const { id, operation, path, instruction, beforeHash, afterHash, beforeText, afterText, bytes } = item
    return { id, operation, path, instruction, beforeHash, afterHash, beforeText, afterText, bytes }
  }
  private async validate(owner: number, item: Pending): Promise<void> {
    const run = this.run(owner, item.run), roots = await this.deps.roots()
    if (item.operation === 'create') {
      if (![run.scope.opened, ...run.scope.directories].some(p => p && samePath(p, dirname(item.path)))) throw new Error('Creation is limited to the opened or explicitly selected folder.')
      await authorizePath(roots, dirname(item.path))
      if (!(await lstat(dirname(item.path))).isDirectory() || !safeName(basename(item.path))) throw new Error('Invalid creation destination.')
      if (await exists(item.path)) throw new Error('The destination already exists. Choose a different name.')
    } else {
      if (!run.scope.files.some(p => samePath(p, item.path))) throw new Error('Select this individual file in the main panel first.')
      await regularFile(roots, item.path)
      if (item.beforeHash !== await hashFile(item.path)) throw new Error('The original file changed after the proposal. Nothing was overwritten; request the edit again.')
    }
    await this.deps.assertClosed(item.path)
    this.run(owner, item.run)
  }
  async propose(owner: number, runId: string, raw: DirectoryProposal): Promise<DirectoryApproval> {
    const run = this.run(owner, runId)
    if (!raw || !['create','update','delete'].includes(raw.operation) || typeof raw.instruction !== 'string' || raw.instruction.length > 16000) throw new Error('Invalid file action.')
    validAbsolute(raw.path)
    if ([...this.pending.values()].some(p => p.run === runId && !['done','discarded'].includes(p.phase))) throw new Error('Finish or discard the current file proposal first.')
    if (raw.operation !== 'delete' && !FORMATS.has(extname(raw.path).toLowerCase())) throw new Error('Staged editing supports DOCX, XLSX, PPTX, PDF, Markdown and HTML. Legacy spreadsheet formats must first be saved as XLSX.')
    if (raw.operation !== 'create' && !run.scope.files.some(p => samePath(p, raw.path))) throw new Error('The target file is not explicitly selected.')
    const item: Pending = { operation: raw.operation, path: raw.path, instruction: raw.instruction, id: randomUUID(), run: runId, beforeHash: null, phase: 'proposed', locked: false, tools: new Set() }
    if (raw.operation !== 'create') { await regularFile(await this.deps.roots(), raw.path); item.beforeHash = await hashFile(raw.path) }
    await this.validate(owner, item)
    this.pending.set(item.id, item)
    return this.view(item)
  }
  private async locked<T>(owner: number, id: string, work: (item: Pending) => Promise<T>): Promise<T> {
    const item = this.item(owner, id)
    if (item.locked) throw new Error('This file action is already running.')
    item.locked = true
    try { return await work(item) }
    finally { item.locked = false; if (item.phase === 'discarded') await this.cleanup(item) }
  }
  /** Called only by the inline approval controller, never exposed as a model tool. */
  async prepare(owner: number, id: string): Promise<DirectoryEditorDescription | null> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'proposed') throw new Error('This proposal was already approved.')
      await this.validate(owner, item)
      if (item.operation === 'delete') { item.phase = 'preview'; return null }
      const directory = join(this.deps.stateDirectory, 'directory-staging', item.id)
      await mkdir(directory, { recursive: true })
      item.stagePath = join(directory, basename(item.path))
      if (item.operation === 'update') await copyFile(item.path, item.stagePath, constants.COPYFILE_EXCL)
      else await writeFile(item.stagePath, await this.deps.blank(extname(item.path).toLowerCase()), { flag: 'wx' })
      this.item(owner, id)
      item.native = await this.deps.open(item.stagePath)
      const description = await item.native.describe()
      this.item(owner, id)
      item.tools = new Set(description.tools.map(tool => tool.name)); item.phase = 'editing'
      return description
    })
  }
  async execute(owner: number, id: string, call: AgentToolCall): Promise<ToolExecution> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'editing' || !item.native || !call || !item.tools.has(call.name)) throw new Error('Staged tool is not approved or is not available.')
      if (JSON.stringify(call).length > 512000) throw new Error('Tool arguments are too large.')
      const result = await item.native.execute(call)
      this.item(owner, id); return result
    })
  }
  async preview(owner: number, id: string): Promise<DirectoryApproval> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'editing' || !item.native || !item.stagePath) throw new Error('No staged result is ready.')
      await item.native.save()
      await item.native.close(); item.native = undefined
      this.item(owner, id)
      await regularFile([dirname(item.stagePath)], item.stagePath)
      item.afterHash = await hashFile(item.stagePath)
      item.bytes = (await lstat(item.stagePath)).size
      const preview = async (path: string) => this.deps.extract(path).then(s => s.slice(0, 12000)).catch(cause => `Text preview unavailable: ${error(cause)}`)
      item.beforeText = item.operation === 'update' ? await preview(item.path) : ''
      item.afterText = await preview(item.stagePath)
      this.item(owner, id); item.phase = 'preview'
      return this.view(item)
    })
  }
  async commit(owner: number, id: string): Promise<DirectoryCommit> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'preview') throw new Error('Review the staged result before approving the save.')
      await this.validate(owner, item)
      item.phase = 'committing'
      let backupPath: string | undefined
      try {
        if (item.operation === 'delete') {
          this.item(owner, id)
          await this.deps.trash(item.path)
        } else {
          if (!item.stagePath || !item.afterHash || await hashFile(item.stagePath) !== item.afterHash) throw new Error('The staged copy changed after the preview. Request a fresh preview.')
          if (item.operation === 'update') {
            const backupDirectory = join(this.deps.stateDirectory, 'history', 'file-backups', item.id)
            await mkdir(backupDirectory, { recursive: true })
            backupPath = join(backupDirectory, basename(item.path))
            await copyFile(item.path, backupPath, constants.COPYFILE_EXCL)
            if (await hashFile(backupPath) !== item.beforeHash) throw new Error('The original changed during backup; save cancelled.')
          }
          await publishFile(item.stagePath, item.path, item.operation === 'update', () => this.validate(owner, item))
        }
        // Once the filesystem commit completes, cancellation cannot undo it.
        item.phase = 'done'
        try { this.deps.changed(item.path) } catch (cause) { console.warn('Nawa: refresh notification failed after file commit.', cause) }
        await this.cleanup(item)
        return { path: item.path, operation: item.operation, ...(backupPath ? { backupPath } : {}) }
      } catch (cause) { if (!['discarded', 'done'].includes(item.phase)) item.phase = 'preview'; throw cause }
    })
  }
  private async cleanup(item: Pending): Promise<void> {
    try { await item.native?.close() } catch { /* Already closed; remove our private stage. */ }
    item.native = undefined
    if (item.stagePath) await rm(dirname(item.stagePath), { recursive: true, force: true }).catch(() => undefined)
    this.pending.delete(item.id)
  }
  async discard(owner: number, id: string): Promise<void> {
    const item = this.pending.get(id)
    if (!item) return
    if (this.runs.get(item.run)?.owner !== owner) throw new Error('This proposal belongs to another window.')
    item.phase = 'discarded'
    // Closing the stage also rejects any pending native RPC and prevents later writes.
    try { await item.native?.close() } catch { /* Nothing can be committed after discard. */ }
    if (!item.locked) await this.cleanup(item)
  }
  async cancel(owner: number, id: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    if (run.owner !== owner) throw new Error('This run belongs to another window.')
    run.cancelled = true
    await Promise.all([...this.pending.values()].filter(item => item.run === id).map(item => this.discard(owner, item.id)))
    this.runs.delete(id)
  }
  async expire(): Promise<void> {
    for (const [id, run] of this.runs) if (Date.now() > run.expires) await this.cancel(run.owner, id)
  }
  async cancelOwner(owner: number): Promise<void> {
    for (const [id, run] of this.runs) if (run.owner === owner) await this.cancel(owner, id)
  }
}
