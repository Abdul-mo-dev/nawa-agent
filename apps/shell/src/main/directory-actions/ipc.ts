import { discoverLinkedImages, stageLinkedImages, finalizeWorkflowAssets } from './assets'
import { DirectorySearchService } from '../file-index/service'
import { FILE_SEARCH_CHANNEL } from '../../shared/file-search-api'
import { convertWorkflowFile, reviewWorkflowFile } from './workflow-cli'
import { reviewFileChanges } from '@genoffice/file-parse'
import { app, ipcMain, shell, type WebContents } from 'electron'
import { dirname } from 'node:path'
import type { AgentToolCall, DirectoryInteractionReply } from '@genoffice/agent-core'
import type { DirectoryActionScope, DirectoryProposal, DirectoryPrepareContext } from '../../shared/directory-actions-api'
import { DIRECTORY_ACTION_CHANNEL } from '../../shared/directory-actions-api'
import { DirectoryActionManager } from './manager'
import { assertOriginalClosed, nativeBlank, openNativeStage } from './native-runtime'
import { copyWorkspacePaths } from './file-safety'

export function registerDirectoryActionsIpc(options: {
  roots(): Promise<string[]>
  isHomeSender(sender: WebContents): boolean
  extract(path: string): Promise<string>
  changed(directories: string[]): void
}): void {
  const search = new DirectorySearchService({ stateDirectory: app.getPath('userData'), roots: options.roots })
  let manager: DirectoryActionManager | undefined
  const owners = new Set<number>()
  const getManager = () => manager ??= new DirectoryActionManager({
    roots: options.roots, stateDirectory: app.getPath('userData'),
    open: openNativeStage, blank: nativeBlank, assertClosed: assertOriginalClosed,
    trash: path => shell.trashItem(path), extract: options.extract,
    linkedImages: discoverLinkedImages, stageImages: stageLinkedImages, finalizeAssets: finalizeWorkflowAssets,
    search: (owner, paths, query, signal) => search.selected(owner, paths, query, signal),
    review: reviewFileChanges, convert: convertWorkflowFile, quality: reviewWorkflowFile,
    changed: path => options.changed([dirname(path)]),
  })
  const trackOwner = (sender: WebContents): void => {
    const owner = sender.id
    if (!owners.has(owner)) {
      owners.add(owner)
      const revoke = () => { search.cancel(owner); void manager?.cancelOwner(owner).catch(console.error) }
      sender.once('destroyed', () => { revoke(); owners.delete(owner) })
      sender.on('render-process-gone', revoke)
      sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) revoke() })
    }
  }
  ipcMain.handle(FILE_SEARCH_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !options.isHomeSender(event.sender)) throw new Error('File search is available only from Nawa workspace.')
    const owner = event.sender.id
    trackOwner(event.sender)
    const folder = () => { if (typeof args[0] !== 'string') throw new Error('Choose a mounted directory.'); return args[0] }
    switch (action) {
      case 'index': return search.indexFolder(owner, folder())
      case 'search': if (typeof args[1] !== 'string') throw new Error('Enter a query.'); return search.search(owner, folder(), args[1], args[2] === true)
      case 'progress': return search.progress(owner)
      case 'cancel': return search.cancel(owner)
      case 'clear': return search.clear(owner)
      case 'settings': return search.settings()
      case 'saveSettings': if ((args[0] !== 'direct' && args[0] !== 'openrouter') || typeof args[1] !== 'string') throw new Error('Invalid reranker settings.'); return search.saveSettings(args[0], args[1])
      default: throw new Error('Unknown file-search action.')
    }
  })
  ipcMain.handle(DIRECTORY_ACTION_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !options.isHomeSender(event.sender)) throw new Error('Directory actions are available only from the Nawa workspace.')
    const owner = event.sender.id
    trackOwner(event.sender)
    const m = getManager()
    const id = () => { if (typeof args[0] !== 'string' || args[0].length > 100) throw new Error('Invalid action identifier.'); return args[0] }
    switch (action) {
      case 'searchContents': {
        if (typeof args[1] !== 'string') throw new Error('Invalid search query.')
        return m.searchContents(owner, id(), args[1])
      }
      case 'validateFile': {
        if (typeof args[1] !== 'string') throw new Error('Invalid validation path.')
        return m.validateFile(owner, id(), args[1])
      }
      case 'inspect': {
        if (typeof args[1] !== 'string') throw new Error('Invalid inspection path.')
        return m.inspections.open(owner, id(), args[1])
      }
      case 'query': {
        if (typeof args[1] !== 'string' || args[1].length > 100) throw new Error('Invalid inspection identifier.')
        return m.inspections.execute(owner, id(), args[1], args[2] as AgentToolCall)
      }
      case 'closeInspection': {
        if (typeof args[1] !== 'string' || args[1].length > 100) throw new Error('Invalid inspection identifier.')
        return m.inspections.close(owner, id(), args[1])
      }
      case 'verifyInspections': {
        if (typeof args[1] !== 'string') throw new Error('Invalid response text.')
        await m.verifySources(owner, id())
        return m.inspections.verify(owner, id(), args[1])
      }
      case 'verify': {
        if (typeof args[1] !== 'string') throw new Error('Invalid response text.')
        return m.verify(owner, id(), args[1])
      }
      case 'begin': return m.begin(owner, args[0] as DirectoryActionScope)
      case 'propose': return m.propose(owner, id(), args[1] as DirectoryProposal)
      case 'prepare': return m.prepare(owner, id(), args[1] as DirectoryPrepareContext)
      case 'pollWorkflow': return m.pollWorkflow(owner, id())
      case 'respondWorkflow': return m.respondWorkflow(owner, id(), args[1] as DirectoryInteractionReply)
      case 'execute': return m.execute(owner, id(), args[1] as AgentToolCall)
      case 'preview': return m.preview(owner, id())
      case 'commit': return m.commit(owner, id())
      case 'discard': return m.discard(owner, id())
      case 'cancel': return m.cancel(owner, id())
      case 'copyPaths': {
        if (!Array.isArray(args[0]) || !args[0].every(p => typeof p === 'string') || typeof args[1] !== 'string') throw new Error('Invalid clipboard selection.')
        const result = await copyWorkspacePaths(await options.roots(), args[0], args[1])
        if (result.copied.length) options.changed([args[1]])
        return result
      }
      default: throw new Error('Unknown directory action.')
    }
  })
  const expiry = setInterval(() => { void manager?.expire().catch(console.error) }, 60000)
  expiry.unref()
  app.once('before-quit', () => { search.stop(); clearInterval(expiry); for (const owner of owners) void manager?.cancelOwner(owner).catch(console.error) })
}
