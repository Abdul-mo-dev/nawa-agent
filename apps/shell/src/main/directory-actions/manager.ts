import type { LinkedImage } from '../../shared/directory-actions-api'
import type { FileSearchResult } from '../../shared/file-search-api'
import { conversionSupported } from '../../../../../packages/cli/src/conversion-routes'
import { directoryToolAllowed, DIRECTORY_PROTOCOL_VERSION } from '@genoffice/agent-core'
import { DirectoryInspectionManager } from './inspection-manager'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { AgentToolCall, ToolExecution, DirectoryEditorDescription, DirectoryWorkflowOptions, DirectoryWorkflowStatus, DirectoryInteractionReply } from '@genoffice/agent-core'
import type { DirectoryActionScope, DirectoryApproval, DirectoryCommit, DirectoryProposal, DirectoryReview, DirectoryPrepareContext, DirectoryConversion, DirectoryQuality } from '../../shared/directory-actions-api'
import { authorizePath, exists, hashFile, publishFile, regularFile, safeName, samePath, validAbsolute } from './file-safety'

export interface NativeStage {
  describe(mode?: 'read' | 'edit', workflow?: DirectoryWorkflowOptions): Promise<DirectoryEditorDescription>
  pollWorkflow?(): Promise<DirectoryWorkflowStatus>
  respondWorkflow?(reply: DirectoryInteractionReply): Promise<void>
  verify(text: string): Promise<string | null>
  execute(call: AgentToolCall): Promise<ToolExecution>
  save(): Promise<void>
  close(): Promise<void>
}
export interface ActionDependencies {
  search?(owner: number, paths: string[], query: string, signal: AbortSignal): Promise<FileSearchResult>
  linkedImages?(file: string, roots: string[]): Promise<LinkedImage[]>
  stageImages?(original: string, copy: string, images: readonly LinkedImage[]): Promise<void>
  finalizeAssets?(file: string, network: boolean): Promise<string[]>
  roots(): Promise<string[]>
  stateDirectory: string
  blank(ext: string): Promise<Uint8Array | string>
  open(path: string): Promise<NativeStage>
  assertClosed(path: string): Promise<void>
  trash(path: string): Promise<void>
  extract(path: string): Promise<string>
  changed(path: string): void
  review?(before: string | null, after: string): Promise<DirectoryReview>
  convert?(source: string, target: string, conversion: DirectoryConversion, signal: AbortSignal, network?: boolean): Promise<string[]>
  quality?(path: string, images: boolean, signal: AbortSignal): Promise<DirectoryQuality>
}
interface Run { owner: number; scope: DirectoryActionScope; expires: number; cancelled: boolean; abort: AbortController; evidence: Map<string, string> }
interface Pending extends DirectoryApproval {
  run: string
  stagePath?: string
  abort?: AbortController
  workflowWarnings?: string[]
  workflowOptions?: DirectoryWorkflowOptions
  sources?: { path: string; hash: string }[]
  imageSources?: LinkedImage[]
  imageDocument?: string
  native?: NativeStage
  phase: 'proposed' | 'editing' | 'preview' | 'committing' | 'done' | 'discarded'
  locked: boolean
  tools: Set<string>
  operations: { tool: string; summary: string; ok: boolean; input: string }[]
}
const FORMATS = new Set(['.docx','.xlsx','.pptx','.pdf','.md','.markdown','.html','.htm'])
const error = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/** Main-process authority for immutable proposals. Renderer/model never supplies saved bytes. */
export class DirectoryActionManager {
  private runs = new Map<string, Run>()
  private pending = new Map<string, Pending>()
  readonly inspections: DirectoryInspectionManager
  constructor(private deps: ActionDependencies) {
    this.inspections = new DirectoryInspectionManager(deps, async (owner, id, path) => {
      const run = this.run(owner, id)
      if (!run.scope.files.some(p => samePath(p, path))) throw new Error('Select this individual file before native inspection.')
      await regularFile(await this.deps.roots(), path)
      this.run(owner, id)
    })
  }
  async begin(owner: number, raw: DirectoryActionScope): Promise<string> {
    if (!raw || !Array.isArray(raw.files) || !Array.isArray(raw.directories) || raw.files.length + raw.directories.length > 256) throw new Error('Invalid directory selection.')
    const scope = { opened: raw.opened, files: [...new Set(raw.files)], directories: [...new Set(raw.directories)] }
    const roots = await this.deps.roots()
    for (const path of [scope.opened, ...scope.files, ...scope.directories].filter((p): p is string => p !== null)) await authorizePath(roots, path)
    // Only one active directory run per home renderer; old permissions are revoked.
    await this.cancelOwner(owner)
    const id = randomUUID(); this.runs.set(id, { owner, scope, expires: Date.now() + 30 * 60 * 1000, cancelled: false, abort: new AbortController(), evidence: new Map() }); return id
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
    const { id, operation, path, instruction, beforeHash, afterHash, beforeText, afterText, bytes, review, workflow, linkedImages } = item
    return { id, operation, path, instruction, beforeHash, afterHash, beforeText, afterText, bytes, review, workflow, linkedImages }
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
    for (const source of item.sources ?? []) {
      if (!run.scope.files.some(p => samePath(p, source.path))) throw new Error('A source is no longer selected.')
      await regularFile(roots, source.path)
      if (await hashFile(source.path) !== source.hash) throw new Error('A reference source changed. Nothing was overwritten; request a fresh workflow.')
    }
    for (const image of item.imageSources ?? []) {
      await regularFile(roots,image.path)
      if(await hashFile(image.path)!==image.hash)throw new Error('An approved linked image changed; request the workflow again.')
    }
    await this.verifySources(owner, item.run)
    await this.deps.assertClosed(item.path)
    this.run(owner, item.run)
  }
  async propose(owner: number, runId: string, raw: DirectoryProposal): Promise<DirectoryApproval> {
    const run = this.run(owner, runId)
    if (!raw || !['create','update','delete'].includes(raw.operation) || typeof raw.instruction !== 'string' || raw.instruction.length > 16000) throw new Error('Invalid file action.')
    validAbsolute(raw.path)
    if ([...this.pending.values()].some(p => p.run === runId && !['done','discarded'].includes(p.phase))) throw new Error('Finish or discard the current file proposal first.')
    if (raw.operation !== 'delete' && !raw.workflow?.conversion && !FORMATS.has(extname(raw.path).toLowerCase())) throw new Error('Staged editing supports DOCX, XLSX, PPTX, PDF, Markdown and HTML. Legacy spreadsheet formats must first be saved as XLSX.')
    if (raw.operation !== 'create' && !run.scope.files.some(p => samePath(p, raw.path))) throw new Error('The target file is not explicitly selected.')
    const item: Pending = { operation: raw.operation, path: raw.path, instruction: raw.instruction, id: randomUUID(), run: runId, beforeHash: null, phase: 'proposed', locked: false, tools: new Set(), operations: [] }
    if (raw.operation !== 'delete') {
      const request = raw.workflow
      if (request && (typeof request !== 'object' || Array.isArray(request))) throw new Error('Invalid workflow request.')
      if (request?.sources && (!Array.isArray(request.sources) || request.sources.length > 16)) throw new Error('Choose at most 16 workflow source files.')
      const conversion = request?.conversion
      if (conversion) {
        if (raw.operation !== 'create' || typeof conversion !== 'object' || typeof conversion.source !== 'string' || typeof conversion.to !== 'string' ||
            !conversionSupported(extname(conversion.source), conversion.to) || conversion.to !== conversion.to.toLowerCase() || extname(raw.path).slice(1).toLowerCase() !== conversion.to ||
            (conversion.sheet !== undefined && (typeof conversion.sheet !== 'string' || conversion.sheet.length > 256))) throw new Error('Invalid or unsupported conversion request.')
      }
      const rawSources = [...(request?.sources ?? []), ...(conversion ? [conversion.source] : [])]
      rawSources.forEach(validAbsolute)
      const sources = [...new Set(rawSources)].filter(path => !samePath(path, raw.path))
      let totalBytes = 0
      item.sources = []
      for (const path of sources) {
        validAbsolute(path)
        if (!run.scope.files.some(p => samePath(p, path))) throw new Error('Each workflow source must be individually selected.')
        await regularFile(await this.deps.roots(), path)
        totalBytes += (await lstat(path)).size
        if (totalBytes > 256 * 1024 * 1024) throw new Error('Workflow sources exceed 256 MiB.')
        item.sources.push({ path, hash: await hashFile(path) })
      }
      item.workflow = { network: request?.network === true, media: !conversion && request?.media === true && request?.network === true, sources, renderPreview: request?.renderPreview === true, ...(conversion ? { conversion: { source: conversion.source, to: conversion.to, sheet: conversion.sheet } } : {}) }
    }
    if (raw.operation !== 'create') { await regularFile(await this.deps.roots(), raw.path); item.beforeHash = await hashFile(raw.path) }
    const imageDocument = raw.operation === 'update' ? raw.path : item.workflow?.conversion?.source
    if (imageDocument && this.deps.linkedImages) {
      item.imageDocument=imageDocument
      item.imageSources=await this.deps.linkedImages(imageDocument,await this.deps.roots())
      item.linkedImages=item.imageSources.map(image=>image.path)
    }
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
  async prepare(owner: number, id: string, context?: DirectoryPrepareContext): Promise<DirectoryEditorDescription | null> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'proposed') throw new Error('This proposal was already approved.')
      await this.validate(owner, item)
      if (item.operation === 'delete') { item.phase = 'preview'; return null }
      const directory = join(this.deps.stateDirectory, 'directory-staging', item.id)
      await mkdir(directory, { recursive: true })
      item.stagePath = join(directory, basename(item.path))
      if (item.operation === 'update') await copyFile(item.path, item.stagePath, constants.COPYFILE_EXCL)
      else if (!item.workflow?.conversion) await writeFile(item.stagePath, await this.deps.blank(extname(item.path).toLowerCase()), { flag: 'wx' })
      this.item(owner, id)
      if (item.operation === 'update' && await hashFile(item.stagePath) !== item.beforeHash) throw new Error('The original changed while preparing its staging copy.')
      const sources: DirectoryWorkflowOptions['sources'] = []
      const referenceDir = join(directory, 'references')
      for (const [index, source] of (item.sources ?? []).entries()) {
        await mkdir(referenceDir, { recursive: true })
        const name = `${index + 1}-${basename(source.path)}`
        const path = join(referenceDir, String(index + 1), basename(source.path))
        await mkdir(dirname(path), { recursive: true })
        await copyFile(source.path, path, constants.COPYFILE_EXCL)
        if (await hashFile(path) !== source.hash) throw new Error('Reference changed while copying it.')
        sources.push({ path, name, ext: extname(path).slice(1).toLowerCase(), sizeBytes: (await lstat(path)).size })
      }
      if (context?.task !== undefined && (typeof context.task !== 'string' || context.task.length > 80000)) throw new Error('Invalid workflow task context.')
      if (context?.settings !== undefined && (!context.settings || typeof context.settings !== 'object' || JSON.stringify(context.settings).length > 256000)) throw new Error('Invalid workflow provider settings.')
      item.workflowOptions = {
        generation: true, network: item.workflow?.network === true, media: item.workflow?.media === true,
        sources, task: context?.task ?? item.instruction, settings: context?.settings,
      }
      if (item.imageDocument && item.imageSources?.length && this.deps.stageImages) {
        const copy = item.operation === 'update' ? item.stagePath : sources[item.sources!.findIndex(s => samePath(s.path, item.imageDocument!))]?.path
        if (!copy) throw new Error('No private image-bearing source copy.')
        await this.deps.stageImages(item.imageDocument, copy, item.imageSources)
      }
      item.abort = new AbortController()
      if (item.workflow?.conversion) {
        if (!this.deps.convert) throw new Error('Native conversion service is not configured.')
        const sourceIndex = item.sources!.findIndex(s => samePath(s.path, item.workflow!.conversion!.source))
        if (sourceIndex < 0 || !sources[sourceIndex]) throw new Error('Conversion source is not selected.')
        item.workflowWarnings = await this.deps.convert(sources[sourceIndex]!.path, item.stagePath, item.workflow.conversion, item.abort.signal, item.workflow.network === true)
        this.item(owner, id); await this.validate(owner, item)
        item.operations.push({ tool: 'convert', summary: `Converted to ${item.workflow.conversion.to} with the GenOffice CLI`, ok: true, input: JSON.stringify(item.workflow.conversion) })
        item.phase = 'editing'
        return null
      }
      item.native = await this.deps.open(item.stagePath)
      const description = await item.native.describe('edit', item.workflowOptions)
      this.item(owner, id)
      if (description.protocolVersion !== DIRECTORY_PROTOCOL_VERSION || description.mode !== 'edit' || !description.capabilities?.lifecycle) throw new Error('Native editing bridge is missing or stale. Rebuild every editor and the shell.')
      description.tools = description.tools.filter(tool => directoryToolAllowed(description.kind, 'edit', tool.name, item.workflowOptions))
      item.tools = new Set(description.tools.map(tool => tool.name)); item.phase = 'editing'
      return description
    })
  }
  async execute(owner: number, id: string, call: AgentToolCall): Promise<ToolExecution> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'editing' || !item.native || !call || !item.tools.has(call.name)) throw new Error('Staged tool is not approved or is not available.')
      if (JSON.stringify(call).length > 512000) throw new Error('Tool arguments are too large.')
      await this.validate(owner, item)
      const result = await item.native.execute(call)
      this.item(owner, id)
      if (item.operations.length < 200) item.operations.push({ tool: call.name, summary: result.summary.slice(0, 2000), ok: !result.isError, input: JSON.stringify(call.input).slice(0, 4000) })
      return result
    })
  }
  async pollWorkflow(owner: number, id: string): Promise<DirectoryWorkflowStatus> {
    const item = this.item(owner, id)
    if (item.phase !== 'editing' || !item.native?.pollWorkflow) throw new Error('No active native workflow.')
    return item.native.pollWorkflow()
  }
  async respondWorkflow(owner: number, id: string, reply: DirectoryInteractionReply): Promise<void> {
    const item = this.item(owner, id)
    if (item.phase !== 'editing' || !item.native?.respondWorkflow || !reply || typeof reply.id !== 'string') throw new Error('No active native workflow question.')
    await item.native.respondWorkflow(reply)
  }
  async verify(owner: number, id: string, text: string): Promise<string | null> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'editing' || !item.native || typeof text !== 'string' || text.length > 128000) throw new Error('No native task is ready for verification.')
      const correction = await item.native.verify(text)
      this.item(owner, id)
      return correction
    })
  }
  async preview(owner: number, id: string): Promise<DirectoryApproval> {
    return this.locked(owner, id, async item => {
      if (item.phase !== 'editing' || (!item.native && !item.workflow?.conversion) || !item.stagePath) throw new Error('No staged result is ready.')
      if (item.native) {
        const status = await item.native.pollWorkflow?.()
        item.workflowWarnings = [...(item.workflowWarnings ?? []), ...(status?.warnings ?? [])]
        await item.native.save(); await item.native.close(); item.native = undefined
      }
      this.item(owner, id)
      item.workflowWarnings = [...(item.workflowWarnings ?? []), ...(await this.deps.finalizeAssets?.(item.stagePath, item.workflow?.network === true) ?? [])]
      await regularFile([dirname(item.stagePath)], item.stagePath)
      item.afterHash = await hashFile(item.stagePath)
      item.bytes = (await lstat(item.stagePath)).size
      const preview = async (path: string) => this.deps.extract(path).then(s => s.slice(0, 12000)).catch(cause => `Text preview unavailable: ${error(cause)}`)
      item.beforeText = item.operation === 'update' ? await preview(item.path) : ''
      item.afterText = await preview(item.stagePath)
      item.review = await this.deps.review?.(item.operation === 'update' ? item.path : null, item.stagePath)
        .catch(cause => ({ format: extname(item.path), complete: false, changed: 0, entries: [], warnings: [`Structured review unavailable: ${error(cause)}`] }))
      if (!item.review) item.review = { format: extname(item.path), complete: false, changed: 0, entries: [], warnings: ['Only the text preview and native operation log are available.'] }
      item.review.operations = [...item.operations]
      item.review.warnings.push(...(item.workflowWarnings ?? []))
      if (this.deps.quality) {
        const signal = (item.abort ??= new AbortController()).signal
        item.review.quality = await this.deps.quality(item.stagePath, item.workflow?.renderPreview === true, signal)
          .catch(cause => ({ checked: false, summary: '', warnings: [`Native validation unavailable: ${error(cause)}`], images: [] }))
      }
      await this.validate(owner, item)
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
        this.runs.get(item.run)?.evidence.delete(item.path)
        try { await this.inspections.invalidatePath(owner, item.run, item.path) } catch (cause) { console.warn('Nawa: inspection cleanup after commit failed.', cause) }
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
    item.abort?.abort()
    // Closing the stage also rejects any pending native RPC and prevents later writes.
    try { await item.native?.close() } catch { /* Nothing can be committed after discard. */ }
    if (!item.locked) await this.cleanup(item)
  }
  async cancel(owner: number, id: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    if (run.owner !== owner) throw new Error('This run belongs to another window.')
    run.cancelled = true; run.abort.abort()
    await this.inspections.cancelRun(owner, id)
    await Promise.all([...this.pending.values()].filter(item => item.run === id).map(item => this.discard(owner, item.id)))
    this.runs.delete(id)
  }
  async verifySources(owner: number, id: string): Promise<void> {
    const run = this.run(owner, id), roots = await this.deps.roots()
    for (const [path, hash] of run.evidence) {
      await regularFile(roots, path)
      if (!run.scope.files.some(p => samePath(p, path)) || await hashFile(path) !== hash) throw new Error('A searched source changed; read it again in a new request.')
    }
    this.run(owner, id)
  }
  async searchContents(owner: number, id: string, query: string): Promise<FileSearchResult> {
    const run = this.run(owner, id)
    if (typeof query !== 'string' || !query.trim() || query.length > 256) throw new Error('Use a search query of 1–256 characters.')
    if (!this.deps.search) throw new Error('Content search is unavailable. Rebuild Nawa.')
    const result = await this.deps.search(owner, [...run.scope.files], query, run.abort.signal)
    this.run(owner, id)
    const roots = await this.deps.roots()
    for (const hit of result.hits) {
      if (!run.scope.files.some(path => samePath(path, hit.path))) throw new Error('Search returned an unselected file; results rejected.')
      await regularFile(roots, hit.path)
      if (await hashFile(hit.path) !== hit.sourceHash) throw new Error('Search source changed; results rejected.')
      run.evidence.set(hit.path, hit.sourceHash)
    }
    return result
  }
  async validateFile(owner: number, id: string, path: string): Promise<DirectoryQuality> {
    const run = this.run(owner, id)
    if (!run.scope.files.some(p => samePath(p, path))) throw new Error('Select the individual file before validation.')
    await regularFile(await this.deps.roots(), path)
    if (!this.deps.quality) throw new Error('Native validation service is unavailable.')
    const hash = await hashFile(path)
    const directory = join(this.deps.stateDirectory, 'directory-validation', randomUUID())
    const abort = new AbortController()
    const timer = setInterval(() => { try { this.run(owner, id) } catch { abort.abort() } }, 250)
    try {
      await mkdir(directory, { recursive: true })
      const copy = join(directory, basename(path))
      await copyFile(path, copy, constants.COPYFILE_EXCL)
      if (await hashFile(copy) !== hash) throw new Error('File changed while preparing validation.')
      const result = await this.deps.quality(copy, false, abort.signal)
      this.run(owner, id)
      await regularFile(await this.deps.roots(), path)
      if (await hashFile(path) !== hash) throw new Error('File changed during validation; results discarded.')
      return result
    } finally { clearInterval(timer); abort.abort(); await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
  }
  async expire(): Promise<void> {
    for (const [id, run] of this.runs) if (Date.now() > run.expires) await this.cancel(run.owner, id)
  }
  async cancelOwner(owner: number): Promise<void> {
    for (const [id, run] of this.runs) if (run.owner === owner) await this.cancel(owner, id)
  }
}
