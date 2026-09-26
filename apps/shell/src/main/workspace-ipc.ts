import { registerHistoryIpc } from './history/history-ipc'
import { registerDirectoryActionsIpc } from './directory-actions/ipc'
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceFileText } from '../shared/home-api'
import { HOME_CHANNELS } from '../shared/home-api'
import { WorkspaceFolderStore } from './workspace-folders'

interface WorkspaceIpcOptions {
  initialRoot: () => string
  isHomeSender: (sender: WebContents) => boolean
  getWindow: () => BrowserWindow | null
  readFile: (path: string, maxChars: number, offset?: number) => Promise<WorkspaceFileText>
  starredPaths: () => ReadonlySet<string>
}

export function registerWorkspaceIpc(options: WorkspaceIpcOptions): {
  contains: (path: unknown) => path is string
  isRoot: (path: string) => boolean
} {
  let store: WorkspaceFolderStore | null = null
  const getStore = () => store ??= new WorkspaceFolderStore({
    statePath: join(app.getPath('userData'), 'workspace-folders.json'),
    initialRoot: options.initialRoot,
  })
  registerHistoryIpc({
    isHomeSender: options.isHomeSender,
    roots: async () => (await getStore().list()).map(root => root.path),
  })
  const clients = new Set<WebContents>()
  const watchers = new Map<string, FSWatcher>()
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let picking = false

  const send = (channel: string, payload?: unknown) => {
    for (const client of clients) {
      if (client.isDestroyed()) clients.delete(client)
      else if (options.isHomeSender(client)) client.send(channel, payload)
    }
  }
  const rootsChanged = () => {
    for (const [dir, watcher] of watchers) {
      if (!getStore().contains(dir)) { watcher.close(); watchers.delete(dir) }
    }
    send('home:workspace-roots-changed')
  }
  const watchDirectory = (dir: string) => {
    if (watchers.has(dir) || watchers.size >= 128) return
    try {
      const watcher = watch(dir, { persistent: false }, () => {
        pending.add(dir)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          send(HOME_CHANNELS.folderChanged, [...pending])
          pending.clear()
        }, 200)
      })
      watcher.on('error', () => { watcher.close(); watchers.delete(dir) })
      watchers.set(dir, watcher)
    } catch { /* Focus/manual refresh still works when watching is unsupported. */ }
  }

  const handle = (channel: string, callback: (sender: WebContents, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (event.senderFrame !== event.sender.mainFrame || !options.isHomeSender(event.sender)) {
        throw new Error('Workspace access is only available from the Nawa home page.')
      }
      if (!clients.has(event.sender)) {
        clients.add(event.sender)
        event.sender.once('destroyed', () => clients.delete(event.sender))
      }
      return callback(event.sender, ...args)
    })
  }

  registerDirectoryActionsIpc({
    roots: async () => (await getStore().list()).map(root => root.path),
    isHomeSender: options.isHomeSender,
    extract: async path => {
      const result = await options.readFile(path, 12000, 0)
      if (!result.ok) throw new Error(result.error || 'Text extraction failed.')
      return result.text || ''
    },
    changed: dirs => send(HOME_CHANNELS.folderChanged, dirs),
  })
  handle('home:workspace-roots', () => getStore().list())
  handle('home:workspace-pick-folder', async (sender) => {
    if (picking) return null
    picking = true
    try {
      const parent = BrowserWindow.fromWebContents(sender) ?? options.getWindow()
      if (!parent || parent.isDestroyed()) throw new Error('The home window is not available.')
      const result = await dialog.showOpenDialog(parent, {
        title: 'Add folder to Nawa workspace',
        buttonLabel: 'Add folder',
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths[0] || sender.isDestroyed()) return null
      const root = await getStore().add(result.filePaths[0])
      rootsChanged()
      return root
    } finally { picking = false }
  })
  handle('home:workspace-remove-folder', async (_sender, path) => {
    if (typeof path !== 'string') throw new Error('Invalid workspace folder.')
    await getStore().remove(path)
    rootsChanged()
  })
  handle('home:workspace-list-folder', async (_sender, dir) => {
    if (typeof dir !== 'string') throw new Error('Invalid workspace directory.')
    const listing = await getStore().listFolder(dir, options.starredPaths())
    watchDirectory(listing.dir)
    return listing
  })
  handle('home:workspace-scope', async (_sender, folder) => {
    if (typeof folder !== 'string') throw new Error('Invalid chat folder.')
    return getStore().scope(folder)
  })
  handle('home:workspace-directories', async (_sender, folder) => {
    if (typeof folder !== 'string') throw new Error('Invalid chat folder.')
    return getStore().listDirectories(folder)
  })
  handle('home:workspace-search-files', async (_sender, folder, query, limit) => {
    if (typeof folder !== 'string' || typeof query !== 'string') throw new Error('Invalid search.')
    return getStore().searchFiles(folder, query, typeof limit === 'number' ? limit : 50)
  })
  handle('home:workspace-read-file', async (_sender, folder, path, maxChars, offset) => {
    if (typeof folder !== 'string' || typeof path !== 'string') {
      return { ok: false, error: 'Invalid chat file.' }
    }
    try {
      const canonical = await getStore().authorizeFile(folder, path)
      const limit = typeof maxChars === 'number' && Number.isFinite(maxChars)
        ? Math.max(1, Math.min(12_000, Math.floor(maxChars))) : 12_000
      const start = typeof offset === 'number' && Number.isFinite(offset)
        ? Math.max(0, Math.floor(offset)) : 0
      const result = await options.readFile(canonical, limit, start)
      // A removal while extraction was running must not deliver newly unauthorized content.
      await getStore().authorizeFile(folder, canonical)
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  app.once('will-quit', () => {
    if (timer) clearTimeout(timer)
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    clients.clear()
  })
  return {
    contains: (path: unknown): path is string => getStore().contains(path),
    isRoot: (path: string) => getStore().isRoot(path),
  }
}
