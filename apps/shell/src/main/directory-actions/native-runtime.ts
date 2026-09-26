import { registerDirectoryStage, configureDirectoryStage, revokeDirectoryStage, assertDirectoryStageToolInput, directoryStageNetworkAllowed } from '../../../../../packages/electron-utils/src/directory-stage'
import { ipcMain, webContents, type WebContents, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { blankXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { blankPdfBuffer } from '../../../../pdf/src/main/blank-pdf'
import type { AgentToolCall, ToolExecution, DirectoryEditorDescription, DirectoryWorkflowOptions, DirectoryWorkflowStatus, DirectoryInteractionReply } from '@genoffice/agent-core'
import type { TabManager } from '../tab-manager'
import type { DocumentTabKind } from '../../shared/tabs-api'
import type { NativeStage } from './manager'
import { samePath } from './file-safety'

interface Options {
  tabs(): TabManager | null
  listOpen(): Promise<{ filePath?: string }[]>
  save(kind: DocumentTabKind, contents: WebContents, path: string): Promise<unknown>
}
let options: Options | null = null
let installed = false
const guardedSessions = new WeakSet<Session>()
/** The baseline has no other onBeforeRequest handler. Register once, pass ordinary views through. */
function guardStageRendererNetwork(contents: WebContents): void {
  const session = contents.session
  if (!session || guardedSessions.has(session)) return
  guardedSessions.add(session)
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const sender = details.webContents ?? (details.webContentsId ? webContents.fromId(details.webContentsId) : undefined)
    callback({ cancel: !!sender && !directoryStageNetworkAllowed(sender, details.url, sender.getURL()) })
  })
}
const requests = new Map<string, { wc: number; resolve(value: unknown): void; reject(cause: Error): void; timer: ReturnType<typeof setTimeout> }>()
export function configureDirectoryNative(value: Options): void {
  options = value
  if (installed) return
  installed = true
  ipcMain.on('nawa:editor-result', (event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const result = raw as { id?: unknown; error?: unknown; result?: unknown }
    if (typeof result.id !== 'string') return
    const pending = requests.get(result.id)
    if (!pending || pending.wc !== event.sender.id || event.senderFrame !== event.sender.mainFrame) return
    requests.delete(result.id); clearTimeout(pending.timer)
    if (result.error) pending.reject(new Error(String(result.error)))
    else pending.resolve(result.result)
  })
}
function configured(): Options { if (!options) throw new Error('Directory editing is not initialized. Restart Nawa.'); return options }
function kindFor(path: string): DocumentTabKind {
  const ext = extname(path).toLowerCase()
  const result = ({ '.docx': 'docs', '.xlsx': 'sheets', '.pptx': 'slides', '.pdf': 'pdf', '.md': 'markdown', '.markdown': 'markdown', '.html': 'html', '.htm': 'html' } as Record<string, DocumentTabKind>)[ext]
  if (!result) throw new Error('Unsupported native editor format.')
  return result
}
export async function nativeBlank(ext: string): Promise<Uint8Array | string> {
  if (ext === '.docx') return buildBlankDocx()
  if (ext === '.xlsx') return blankXlsxBuffer()
  if (ext === '.pptx') return createBlankPptx()
  if (ext === '.pdf') return blankPdfBuffer()
  if (ext === '.md' || ext === '.markdown') return ''
  if (ext === '.html' || ext === '.htm') return '<!doctype html>\n<html><head><meta charset="utf-8"><title>New document</title></head><body><main><h1>New document</h1><p></p></main></body></html>'
  throw new Error('No blank-document engine for this extension.')
}
export async function assertOriginalClosed(path: string): Promise<void> {
  if ((await configured().listOpen()).some(tab => tab.filePath && samePath(tab.filePath, path))) {
    throw new Error('This file is open in an editor. Save and close its tab before applying a directory action, to avoid overwriting unsaved edits.')
  }
}
function rpc(contents: WebContents, path: string, command: 'describe' | 'execute' | 'verify' | 'poll' | 'respond', call?: AgentToolCall, mode?: 'read' | 'edit', text?: string, workflow?: DirectoryWorkflowOptions, response?: DirectoryInteractionReply): Promise<unknown> {
  if (contents.isDestroyed()) return Promise.reject(new Error('Staged editor was closed.'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('Staged editor did not respond. Rebuild all editors and retry.')) }, command === 'describe' ? 1500 : command === 'execute' ? 1200000 : 60000)
    requests.set(id, { wc: contents.id, resolve, reject, timer })
    try { contents.send('nawa:editor-command', { id, path, command, call, mode, text, workflow, response }) }
    catch (cause) { clearTimeout(timer); requests.delete(id); reject(cause) }
  })
}
export async function openNativeStage(path: string): Promise<NativeStage> {
  const configuration = configured(), tabs = configuration.tabs()
  if (!tabs) throw new Error('The workspace window is unavailable.')
  const kind = kindFor(path)
  // Never activates a tab: switching away from Home would unmount directory chat.
  const tabId = tabs.openDirectoryStage(kind, path)
  const contents = tabs.webContentsForTab(tabId)
  if (!contents) { tabs.closeTabWithoutPrompt(tabId); throw new Error('Could not open staged editor.') }
  registerDirectoryStage(contents, path)
  guardStageRendererNetwork(contents)
  contents.setBackgroundThrottling(false)
  let closed = false
  return {
    async describe(mode: 'read' | 'edit' = 'edit', workflow?: DirectoryWorkflowOptions) {
      configureDirectoryStage(contents, mode, workflow)
      const deadline = Date.now() + 40000
      let last: unknown
      while (!closed && !contents.isDestroyed() && Date.now() < deadline) {
        try { return await rpc(contents, path, 'describe', undefined, mode, undefined, workflow) as DirectoryEditorDescription }
        catch (cause) { last = cause; await new Promise(resolve => setTimeout(resolve, 250)) }
      }
      throw new Error(`The ${kind} editor was not ready. Rebuild all editor bundles. ${last instanceof Error ? last.message : ''}`)
    },
    async pollWorkflow() {
      if (closed) throw new Error('Staged editor was closed.')
      return await rpc(contents, path, 'poll') as DirectoryWorkflowStatus
    },
    async respondWorkflow(response) {
      if (closed) throw new Error('Staged editor was closed.')
      await rpc(contents, path, 'respond', undefined, undefined, undefined, undefined, response)
    },
    async verify(text) {
      if (closed) throw new Error('Staged editor was closed.')
      return await rpc(contents, path, 'verify', undefined, undefined, text) as string | null
    },
    async execute(call) {
      if (closed) throw new Error('Staged editor was closed.')
      assertDirectoryStageToolInput(contents, call)
      return await rpc(contents, path, 'execute', call) as ToolExecution
    },
    async save() {
      if (closed) throw new Error('Staged editor was closed.')
      const result = await configuration.save(kind, contents, path)
      if (result === false || (result && typeof result === 'object' && 'ok' in result && result.ok === false)) {
        throw new Error('The native editor refused to save the staged file.')
      }
    },
    async close() {
      if (closed) return
      closed = true
      revokeDirectoryStage(contents)
      if (!contents.isDestroyed()) contents.send('nawa:editor-command', { id: randomUUID(), path, command: 'cancel' })
      for (const [id, pending] of requests) if (pending.wc === contents.id) {
        clearTimeout(pending.timer); requests.delete(id); pending.reject(new Error('Staged editor was cancelled.'))
      }
      tabs.closeDirectoryStage(tabId)
    },
  }
}
