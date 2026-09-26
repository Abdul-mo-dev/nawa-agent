import { app, ipcMain, shell, type WebContents } from 'electron'
import { dirname } from 'node:path'
import type { AgentToolCall } from '@genoffice/agent-core'
import type { DirectoryActionScope, DirectoryProposal } from '../../shared/directory-actions-api'
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
  let manager: DirectoryActionManager | undefined
  const owners = new Set<number>()
  const getManager = () => manager ??= new DirectoryActionManager({
    roots: options.roots, stateDirectory: app.getPath('userData'),
    open: openNativeStage, blank: nativeBlank, assertClosed: assertOriginalClosed,
    trash: path => shell.trashItem(path), extract: options.extract,
    changed: path => options.changed([dirname(path)]),
  })
  ipcMain.handle(DIRECTORY_ACTION_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !options.isHomeSender(event.sender)) throw new Error('Directory actions are available only from the Nawa workspace.')
    const owner = event.sender.id
    if (!owners.has(owner)) {
      owners.add(owner)
      const revoke = () => { void manager?.cancelOwner(owner).catch(console.error) }
      event.sender.once('destroyed', () => { revoke(); owners.delete(owner) })
      event.sender.on('render-process-gone', revoke)
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) revoke() })
    }
    const m = getManager()
    const id = () => { if (typeof args[0] !== 'string' || args[0].length > 100) throw new Error('Invalid action identifier.'); return args[0] }
    switch (action) {
      case 'begin': return m.begin(owner, args[0] as DirectoryActionScope)
      case 'propose': return m.propose(owner, id(), args[1] as DirectoryProposal)
      case 'prepare': return m.prepare(owner, id())
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
  app.once('before-quit', () => { clearInterval(expiry); for (const owner of owners) void manager?.cancelOwner(owner).catch(console.error) })
}
