/**
 * Windows-native engine host. Real editor models still live in their original
 * main modules. Empty WebContentsViews supply the original per-renderer identity;
 * the actual renderer/preload run in the user's browser through the HTTP bridge.
 *
 * This is a loopback, single-user service, NOT a multi-user/network deployment.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog, ipcMain, protocol, type WebContentsView, type WebContents } from 'electron'
import { setDefaultSaveDirProvider } from '@genoffice/electron-utils'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { blankXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { blankPdfBuffer } from '../../../pdf/src/main/blank-pdf'
import * as docs from '../../../docs/src/main/docs-main'
import * as sheets from '../../../sheets/src/main/sheets-main'
import * as slides from '../../../slides/src/main/slides-main'
import { configureSlidesRuntime } from '../../../slides/src/main/session-state'
import * as pdf from '../../../pdf/src/main/pdf-main'
import * as markdown from '../../../markdown/src/main/markdown-main'
import * as html from '../../../html/src/main/html-main'
import { DEFAULT_AI_PANEL_PREFS, normalizeAiPanelPrefs } from '../../../../packages/ui/src/ai-panel-prefs'
import { validateRpc } from '../../server/policy.mjs'
import { HttpError, requireValue } from '../../server/errors.mjs'
import { KeyedLock, relativeParts } from '../../server/workspace.mjs'

// HTTP DTOs are intentionally structural: the .mjs server is independently
// executable/testable under Node without Electron, TypeScript or npm packages.
type Tab = {
  id: string; mount: string; path: string; absolute: string; kind: string;
  revision: string; view?: WebContentsView; dirty?: boolean;
  eventQueue?: Promise<void>; resources?: Map<string, string>;
}
type Services = {
  workspace: any; tabs: Map<string, Tab>; origin: () => string;
  emit: (tab: Tab, channel: string, ...args: any[]) => void;
  addResource: (tab: Tab, descriptor: any) => string;
}
type PendingDialog = {
  tab: Tab; kind: string; options: any;
  resolve: (value: any) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const SAVE_CHANNELS = new Set(['docs:save', 'docs:save-as', 'docs:save-new', 'slides:save', 'slides:save-as', 'workbook:save', 'pdf:save'])
const OPEN_CHANNELS = new Set(['docs:open', 'docs:open-path', 'docs:open-decrypt', 'docs:consume-pending-open', 'slides:open', 'slides:open-path', 'slides:consume-pending-open', 'workbook:select'])
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' }
const ASSETS: Record<string, string> = { ...IMAGES, '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.htm': 'text/html', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' }

export class NativeHost {
  kinds = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']
  private services!: Services
  private context = new AsyncLocalStorage<Tab>()
  private handlers = new Map<string, (...args: any[]) => any>()
  private protocols = new Map<string, (request: any) => any>()
  private dialogs = new Map<string, PendingDialog>()
  private tabLocks = new KeyedLock()
  private nativeOpenDialog = dialog.showOpenDialog.bind(dialog)
  private prefs = { ...DEFAULT_AI_PANEL_PREFS }
  private sidecar: string

  constructor(private repoRoot: string, private browserRoot: string) {
    this.sidecar = path.join(repoRoot, 'apps/sheets/native/xlsx-engine/target/release', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar')
    if (!existsSync(this.sidecar)) this.kinds = this.kinds.filter(k => k !== 'sheets')
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = ((channel: string, listener: any) => {
      // Preserve Electron's duplicate-registration error; do not alter desktop semantics.
      handle(channel, listener); this.handlers.set(channel, listener)
    }) as typeof ipcMain.handle
    const remove = ipcMain.removeHandler.bind(ipcMain)
    ipcMain.removeHandler = (channel: string) => { this.handlers.delete(channel); remove(channel) }
    const protocolHandle = protocol.handle.bind(protocol)
    protocol.handle = ((scheme: string, handler: any) => {
      this.protocols.set(scheme, handler); return protocolHandle(scheme, handler)
    }) as typeof protocol.handle

    for (const [method, kind] of [['showOpenDialog', 'open'], ['showSaveDialog', 'save'], ['showMessageBox', 'message']] as const) {
      const original = (dialog[method] as any).bind(dialog)
      ;(dialog as any)[method] = (...args: any[]) => {
        const tab = this.context.getStore()
        if (!tab) return original(...args)
        return this.askDialog(tab, kind, args.at(-1) ?? {})
      }
    }
    // Disable silent fallbacks to Documents/Nawa outside the selected mount.
    setDefaultSaveDirProvider(() => {
      const tab = this.context.getStore()
      if (!tab) throw new Error('No browser tab owns this file operation')
      const mount = this.services.workspace.get(tab.mount)
      if (mount.readOnly) throw new Error('This folder is mounted read-only')
      return path.dirname(tab.absolute)
    })
  }

  attach(services: Services): void {
    this.services = services
    const common = {
      preloadPath: path.join(this.browserRoot, 'out/preload/empty.js'),
      rendererUrl: `${services.origin()}/service.html`,
      rendererFile: path.join(this.browserRoot, 'public/index.html'),
      openGeneratedPath: () => false,
    }
    // origin() is finalized after the HTTP server listens; refresh before openTab.
    docs.configureDocsRuntime(common)
    docs.registerDocsIpc()
    sheets.configureSheetsRuntime({ ...common, sidecarPath: this.sidecar })
    configureSlidesRuntime({ preloadPath: common.preloadPath, rendererDevUrl: common.rendererUrl, rendererFilePath: common.rendererFile })
    pdf.configurePdfRuntime(common)
    markdown.configureMarkdownRuntime(common)
    html.configureHtmlRuntime(common)
  }

  async pickMount(): Promise<string | null> {
    const selected = await this.nativeOpenDialog({ title: 'Mount a folder in Nawa Browser', properties: ['openDirectory'] })
    return selected.canceled ? null : selected.filePaths[0] ?? null
  }
  async blank(kind: string): Promise<Buffer> {
    const creators: Record<string, () => Promise<any>> = { docs: buildBlankDocx, sheets: blankXlsxBuffer, slides: createBlankPptx, pdf: blankPdfBuffer }
    requireValue(creators[kind], 400, 'Unsupported new document type.')
    return Buffer.from(await creators[kind]())
  }
  async openTab(tab: Tab): Promise<void> {
    // Refresh for --port 0 (used by tests/CI).
    this.attachRuntime()
    await this.context.run(tab, async () => {
      if (tab.kind === 'docs') tab.view = docs.createDocsView(tab.absolute)
      else if (tab.kind === 'sheets') {
        tab.view = sheets.createSheetsView({ includeAiHandlers: false })
        sheets.queueWorkbookForView(tab.view.webContents, tab.absolute)
      } else if (tab.kind === 'slides') tab.view = slides.createSlidesView(tab.absolute)
      else if (tab.kind === 'pdf') tab.view = pdf.createPdfView(tab.absolute)
      else if (tab.kind === 'markdown') tab.view = markdown.createMarkdownView(tab.absolute)
      else if (tab.kind === 'html') tab.view = html.createHtmlView(tab.absolute)
      else throw new HttpError(415, 'Unknown editor.')
      const wc = tab.view!.webContents
      wc.send = ((channel: string, ...args: any[]) => {
        // Native events are ordered, including async capability URL conversion.
        tab.eventQueue = (tab.eventQueue ?? Promise.resolve()).then(async () => {
          const mapped = await this.mapResult(tab, args)
          this.services.emit(tab, channel, ...mapped)
          if (/history-changed|dirty-changed|pending-edits/.test(channel)) this.publishDirty(tab)
        }).catch(error => this.services.emit(tab, 'browser:error', error.message))
      }) as WebContents['send']
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      // This view hosts NO editor UI or user-authored HTML. Its sole role is
      // identity/lifecycle compatibility for the original engine modules.
      tab.dirty = false
    })
  }
  private attachRuntime(): void {
    const common = { preloadPath: path.join(this.browserRoot, 'out/preload/empty.js'), rendererUrl: `${this.services.origin()}/service.html`, rendererFile: path.join(this.browserRoot, 'public/index.html'), openGeneratedPath: () => false }
    docs.configureDocsRuntime(common); sheets.configureSheetsRuntime({ ...common, sidecarPath: this.sidecar })
    configureSlidesRuntime({ preloadPath: common.preloadPath, rendererDevUrl: common.rendererUrl, rendererFilePath: common.rendererFile })
    pdf.configurePdfRuntime(common); markdown.configureMarkdownRuntime(common); html.configureHtmlRuntime(common)
  }
  async closeTab(tab: Tab): Promise<void> {
    for (const [id, request] of this.dialogs) if (request.tab === tab) {
      clearTimeout(request.timer); request.reject(new HttpError(410, 'The editor closed.')); this.dialogs.delete(id)
    }
    const wc = tab.view?.webContents
    if (wc && !wc.isDestroyed()) {
      if (tab.kind === 'docs') docs.teardownDocsRenderer(wc)
      wc.close({ waitForBeforeUnload: false })
    }
  }
  async shutdown(): Promise<void> {
    sheets.stopSheetsSidecar()
  }
  private event(tab: Tab): any {
    const sender = tab.view?.webContents
    requireValue(sender && !sender.isDestroyed(), 410, 'This editor is closed.')
    return { sender, senderFrame: sender!.mainFrame, reply: (channel: string, ...args: any[]) => sender!.send(channel, ...args) }
  }
  private publishDirty(tab: Tab): void {
    const id = tab.view!.webContents.id
    if (tab.kind === 'slides') tab.dirty = slides.slidesIsDirty(id)
    this.services.emit(tab, 'browser:dirty', Boolean(tab.dirty))
  }
  private async setPath(tab: Tab, absolute: string, saved: boolean): Promise<void> {
    const relative = await this.services.workspace.fromAbsolute(tab.mount, absolute)
    const snapshot = await this.services.workspace.read(tab.mount, relative)
    tab.path = relative; tab.absolute = absolute; tab.revision = snapshot.revision
    if (saved) tab.dirty = false
    this.services.emit(tab, saved ? 'browser:saved' : 'browser:opened', { path: relative, revision: snapshot.revision })
  }
  private resultPath(result: any): string | undefined {
    const found = typeof result === 'string' ? result : result?.path ?? result?.file?.path ?? result?.workbook?.path
    return typeof found === 'string' && path.isAbsolute(found) ? found : undefined
  }

  async invoke(tab: Tab, channel: string, args: any[]): Promise<any> {
    await validateRpc(this.services.workspace, tab, channel, args)
    // Capability queries are honest: no pending export/generation job and no
    // cloud credentials exist in this service. Editing needs no AI login.
    if (/:consume-headless-export$|^docs:consume-ai-doc-content$/.test(channel)) return null
    if (channel === 'ai:get-settings') return { ...defaultAiSettings(), gskToolsEnabled: false }
    if (channel === 'ai:gsk-status') return { loggedIn: false }
    if (channel === 'app:get-language') return 'en'
    if (channel === 'app:get-theme') return 'light'
    if (channel === 'app:get-auto-save-default') return { on: false, updatedAt: 0 }
    if (channel === 'app:get-ai-panel-prefs') return this.prefs
    if (channel === 'app:set-ai-panel-prefs') {
      this.prefs = normalizeAiPanelPrefs({ ...this.prefs, ...(args[0] ?? {}) })
      this.services.emit(tab, 'app:ai-panel-prefs-changed', this.prefs)
      return this.prefs
    }
    if (/:recent$|^slides:private-font-faces$/.test(channel)) return []
    if (channel === 'pdf:get-username') return 'Nawa'
    // Browser mode keeps no cross-file AI chat history: resolve to an ephemeral
    // per-tab conversation so open never surfaces DESKTOP_ONLY.
    if (channel === 'project:resolveChat') return { projectId: 'default', chatId: args[0]?.tempChatId ?? `unsaved-${Date.now()}` }
    if (channel === 'project:rebindChat') return { projectId: args[0]?.projectId ?? 'default', chatId: args[0]?.newChatId ?? args[0]?.tempChatId ?? `unsaved-${Date.now()}` }
    if (channel === 'project:loadChat') return []
    if (channel === 'project:appendChat') return null

    return this.tabLocks.run(tab.id, () => this.context.run(tab, async () => {
      if ((tab.kind === 'markdown' || tab.kind === 'html') && channel === `${tab.kind}:save`) return this.saveText(tab, args[0])
      if ((tab.kind === 'markdown' || tab.kind === 'html') && channel === `${tab.kind}:read-file`) {
        const absolute = args[0]
        const relative = await this.services.workspace.fromAbsolute(tab.mount, absolute)
        return (await this.services.workspace.text(tab.mount, relative)).text
      }
      if ((tab.kind === 'markdown' || tab.kind === 'html') && channel === `${tab.kind}:read-image`) {
        if (typeof args[0] !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(args[0])) return null
        let source: string
        try { source = decodeURIComponent(args[0]) } catch { throw new HttpError(400, 'Invalid image path encoding.') }
        const absolute = path.resolve(path.dirname(tab.absolute), source)
        const relative = await this.services.workspace.fromAbsolute(tab.mount, absolute)
        const mime = IMAGES[path.extname(absolute).toLowerCase()]
        if (!mime) return null
        const file = await this.services.workspace.read(tab.mount, relative)
        return { mime, base64: file.bytes.toString('base64') }
      }
      const handler = this.handlers.get(channel)
      requireValue(handler, 501, 'This operation has no browser-compatible handler.', 'UNSUPPORTED_OPERATION')
      const save = SAVE_CHANNELS.has(channel)
      // These engines save their in-memory snapshot to a new, picker-approved
      // target. PDF instead reads its source from disk and must still check it.
      const snapshotSaveAs = channel === 'docs:save-as' || channel === 'docs:save-new' || channel === 'slides:save-as' || (channel === 'workbook:save' && args[0]?.mode === 'save-as')
      const pdfCopy = channel === 'pdf:save' && args[0]?.targetPath && args[0].targetPath !== args[0].path
      if (channel === 'docs:save') requireValue(args[0] === tab.absolute, 403, 'Save must target the currently open file.')
      if (channel === 'pdf:save') requireValue(args[0]?.path === tab.absolute, 403, 'Save must use the currently open PDF.')
      const call = async () => {
        if (save) {
          requireValue(!this.services.workspace.get(tab.mount).readOnly, 403, 'This folder is mounted read-only.')
          if (!snapshotSaveAs) {
            const snapshot = await this.services.workspace.read(tab.mount, tab.path)
            requireValue(snapshot.revision === tab.revision, 409, tab.kind === 'pdf'
              ? 'The PDF changed on disk. Copy any unsaved text elsewhere, then reload before saving or saving a copy.'
              : 'The file changed on disk. Save As a new file, or reload before saving.', 'REVISION_CONFLICT')
          }
          if (pdfCopy) requireValue(!existsSync(args[0].targetPath), 409, 'The copy target already exists. Choose a new filename.')
        }
        const result = await handler!(this.event(tab), ...args)
        if (save && result?.ok !== false && !result?.canceled && result !== false && result != null) {
          if (pdfCopy) {
            // Original PDF semantics: save a copy, keep the source open and dirty.
            const relative = await this.services.workspace.fromAbsolute(tab.mount, args[0].targetPath)
            this.services.emit(tab, 'browser:copied', { path: relative })
          } else await this.setPath(tab, this.resultPath(result) ?? tab.absolute, true)
        } else if (OPEN_CHANNELS.has(channel)) {
          const opened = this.resultPath(result)
          if (opened) await this.setPath(tab, opened, false)
        }
        if (tab.kind === 'slides') this.publishDirty(tab)
        return this.mapResult(tab, result)
      }
      // Same lock as raw PUT: two browser clients cannot pass the same revision
      // concurrently. External OS writers remain outside this process's lock.
      return save ? this.services.workspace.locks.run(this.services.workspace.fileKey(tab.mount, tab.path), call) : call()
    }))
  }

  private async saveText(tab: Tab, request: any): Promise<any> {
    requireValue(request && typeof request.text === 'string', 400, 'Invalid document source.')
    let target = tab.absolute
    const saveAs = request.mode === 'saveAs'
    if (saveAs) {
      const answer = await this.askDialog(tab, 'save', { title: 'Save As', defaultPath: request.suggestedName || path.basename(tab.absolute), filters: [{ extensions: [tab.kind === 'markdown' ? 'md' : 'html'] }] })
      if (answer.canceled) return { ok: true, canceled: true }
      target = answer.filePath
      // Keep authored relative asset URLs valid, without copying arbitrary local
      // files or running the desktop asset-garbage-collection pipeline.
      requireValue(path.dirname(target) === path.dirname(tab.absolute), 400, 'For a rich Markdown/HTML Save As, choose the same folder to preserve relative asset links. Use Source mode to save elsewhere.')
    }
    const relative = await this.services.workspace.fromAbsolute(tab.mount, target, { missingLeaf: true, write: true })
    await this.services.workspace.write(tab.mount, relative, Buffer.from(request.text, 'utf8'), saveAs ? null : tab.revision)
    await this.setPath(tab, target, true)
    return { ok: true, path: target }
  }

  async send(tab: Tab, channel: string, args: any[]): Promise<void> {
    await validateRpc(this.services.workspace, tab, channel, args)
    // Responses to engine requests must NOT take tabLocks: an invoke may be
    // awaiting one of them (CSV confirmation, recovery or save completion).
    await this.context.run(tab, async () => {
      if (/:dirty-changed$/.test(channel)) tab.dirty = args[0] === true
      if (channel === 'workbook:pending-edits') tab.dirty = Number(args[0]) > 0
      if (channel === 'docs:close-check-result') tab.dirty = args[0]?.dirty === true
      const event = this.event(tab)
      for (const listener of ipcMain.rawListeners(channel)) await (listener as any).call(ipcMain, event, ...args)
      this.publishDirty(tab)
    })
  }
  async command(tab: Tab, command: string): Promise<void> {
    await this.context.run(tab, async () => {
      if (command === 'queryDirty') { tab.view!.webContents.send('docs:close-check'); this.publishDirty(tab); return }
      requireValue(!this.services.workspace.get(tab.mount).readOnly, 403, 'This folder is mounted read-only.')
      const wc = tab.view!.webContents
      const as = command === 'saveAs'
      if (tab.kind === 'docs') wc.send('menu:command', as ? 'save-as' : 'save')
      else if (tab.kind === 'sheets') wc.send('menu:action', as ? 'save-as' : 'save')
      else if (tab.kind === 'slides') wc.send('slides:menu', as ? 'save-as' : 'save')
      else if (tab.kind === 'pdf') {
        if (as) {
          const answer = await this.askDialog(tab, 'save', { title: 'Save PDF As', defaultPath: path.basename(tab.absolute), filters: [{ extensions: ['pdf'] }] })
          if (!answer.canceled) await pdf.requestPdfSaveAs(wc, answer.filePath)
        } else wc.send('pdf:close-save-request')
      } else wc.send(`${tab.kind}:save-request`, as ? 'saveAs' : 'save')
    })
  }

  private async askDialog(tab: Tab, kind: string, options: any): Promise<any> {
    const id = randomUUID()
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.dialogs.delete(id); reject(new HttpError(408, 'The file picker timed out. Try the operation again.')) }, 240000)
      this.dialogs.set(id, { tab, kind, options, resolve, reject, timer })
      this.services.emit(tab, 'browser:dialog', { id, kind, title: options.title, message: options.message, detail: options.detail, buttons: options.buttons, cancelId: options.cancelId, directoryOnly: options.properties?.includes('openDirectory'), defaultName: options.defaultPath ? path.basename(options.defaultPath) : undefined, extensions: options.filters?.flatMap((f: any) => f.extensions).filter((e: string) => e !== '*') })
    })
    if (kind === 'message') return { response: result?.response ?? options.cancelId ?? 0, checkboxChecked: false }
    if (!result) return kind === 'save' ? { canceled: true, filePath: undefined } : { canceled: true, filePaths: [] }
    return kind === 'save' ? { canceled: false, filePath: result.absolute } : { canceled: false, filePaths: [result.absolute] }
  }
  async replyDialog(tab: Tab, answer: any): Promise<void> {
    const pending = this.dialogs.get(answer?.id)
    requireValue(pending && pending.tab === tab, 404, 'This file picker expired.')
    let value = answer.value
    if (value && pending!.kind !== 'message') {
      const absolute = await this.services.workspace.resolve(tab.mount, value.path, { missingLeaf: pending!.kind === 'save', write: pending!.kind === 'save' })
      if (pending!.kind === 'save') {
        requireValue(!existsSync(absolute), 409, 'Save As requires a new filename. Existing files are never overwritten through a picker.')
      } else {
        const info = await fs.stat(absolute)
        requireValue(pending!.options.properties?.includes('openDirectory') ? info.isDirectory() : info.isFile(), 400, 'Choose the expected file or folder type.')
        if (info.isFile()) requireValue(info.size <= this.services.workspace.maxBytes, 413, 'This file exceeds the configured size limit.')
      }
      const extensions = pending!.options.filters?.flatMap((f: any) => f.extensions) ?? []
      if (!pending!.options.properties?.includes('openDirectory') && extensions.length && !extensions.includes('*')) requireValue(extensions.some((e: string) => path.extname(absolute).toLowerCase() === `.${e.toLowerCase()}`), 400, 'Choose a file with the expected extension.')
      value = { absolute }
    } else if (value && pending!.kind === 'message') {
      requireValue(Number.isInteger(value.response) && value.response >= 0 && value.response < (pending!.options.buttons?.length ?? 1), 400, 'Invalid dialog response.')
    }
    this.dialogs.delete(answer.id); clearTimeout(pending!.timer); pending!.resolve(value)
  }

  private async mapResult(tab: Tab, value: any): Promise<any> {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value == null) return value
    if (typeof value === 'string' && /^(genoffice-docx-media|html-preview):\/\//.test(value)) {
      tab.resources ??= new Map()
      if (!tab.resources.has(value)) tab.resources.set(value, this.services.addResource(tab, { uri: value, preview: value.startsWith('html-preview:') }))
      return tab.resources.get(value)
    }
    if (Array.isArray(value)) return Promise.all(value.map(v => this.mapResult(tab, v)))
    if (typeof value === 'object') {
      const out: Record<string, any> = {}
      for (const [key, entry] of Object.entries(value)) out[key] = await this.mapResult(tab, entry)
      return out
    }
    return value
  }
  async readResource(resource: any, suffix: string): Promise<any> {
    const tab: Tab = resource.tab
    if (resource.directory) {
      relativeParts(suffix, false)
      const absolute = path.resolve(resource.directory, ...suffix.split('/'))
      const rel = await this.services.workspace.fromAbsolute(tab.mount, absolute)
      const type = ASSETS[path.extname(absolute).toLowerCase()]
      requireValue(type, 415, 'This preview asset type is not supported.')
      return { type, bytes: (await this.services.workspace.read(tab.mount, rel)).bytes }
    }
    requireValue(suffix === '', 404, 'Resource not found.')
    const scheme = new URL(resource.uri).protocol.slice(0, -1)
    const handler = this.protocols.get(scheme)
    requireValue(handler, 404, 'This resource is not available.')
    let response = await handler!(new Request(resource.uri))
    // The first HTML preview can race its asynchronous update event.
    for (let retry = 0; resource.preview && response.status === 404 && retry < 20; retry++) {
      await new Promise(resolve => setTimeout(resolve, 50)); response = await handler!(new Request(resource.uri))
    }
    const type = response.headers.get('content-type') ?? 'application/octet-stream'
    let bytes = Buffer.from(await response.arrayBuffer())
    if (resource.preview && type.includes('text/html')) {
      const folder = path.dirname(tab.absolute)
      // A stable capability root lets nested CSS/img/script URLs resolve while
      // opaque sandbox origins never gain access to authenticated API routes.
      resource.assetRoot ??= this.services.addResource(tab, { directory: folder, preview: true })
      let source = bytes.toString('utf8')
      source = source.replace(/<base\b[^>]*>/gi, '')
      const base = `<base href="${this.services.origin()}${resource.assetRoot}">`
      source = /<head\b[^>]*>/i.test(source) ? source.replace(/<head\b[^>]*>/i, (head: string) => head + base) : base + source
      bytes = Buffer.from(source, 'utf8')
    }
    return { type, bytes, status: response.status }
  }
  async readAsset(tab: Tab, source: string): Promise<any> {
    requireValue(typeof source === 'string' && source.startsWith('md-asset://'), 400, 'Invalid local image URL.')
    let absolute: string
    try { absolute = decodeURIComponent(source.slice('md-asset://'.length)) } catch { throw new HttpError(400, 'Invalid image URL encoding.') }
    if (/^\/[a-z]:\//i.test(absolute)) absolute = absolute.slice(1)
    const relative = await this.services.workspace.fromAbsolute(tab.mount, absolute)
    const type = IMAGES[path.extname(absolute).toLowerCase()]
    requireValue(type, 415, 'This local image type is not supported.')
    return { type, bytes: (await this.services.workspace.read(tab.mount, relative)).bytes }
  }
}
