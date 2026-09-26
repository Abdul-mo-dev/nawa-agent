import { app, ipcMain, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { CONVERSATION_CHANNEL } from '../../shared/conversation-api'
import workerSource from './history-worker.cjs?raw'

interface Options {
  isHomeSender: (sender: WebContents) => boolean
  roots: () => Promise<string[]>
}
interface WorkerReply { requestId?: number; result?: unknown; error?: string; ready?: boolean; startupError?: string }
const OPERATIONS = new Set(['initialize', 'list', 'create', 'get', 'save', 'rename', 'delete', 'capture', 'compare', 'cancelScan', 'revealDatabase'])

/** A single trusted worker owns the SQLite connection; filesystem scans are bounded and asynchronous. */
export function registerHistoryIpc(options: Options): void {
  const databasePath = join(app.getPath('userData'), 'history', 'conversations.sqlite3')
  let worker: Worker | null = null
  let ready: Promise<void> | null = null
  let nextId = 0
  let closing = false
  let quitRequested = false
  const clients = new Set<number>()
  const pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (reason: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const failAll = (error: Error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  const ensureWorker = (): Promise<void> => {
    if (closing) return Promise.reject(new Error('Nawa history is shutting down.'))
    if (ready) return ready
    ready = new Promise<void>((resolve, reject) => {
      const instance = new Worker(workerSource, { eval: true, workerData: { databasePath } })
      worker = instance
      const bootTimeout = setTimeout(() => {
        const error = new Error('The conversation database did not open. Check the history folder permissions.')
        reject(error); failAll(error); void instance.terminate()
      }, 15000)
      instance.on('message', (reply: WorkerReply) => {
        if (reply.ready) { clearTimeout(bootTimeout); resolve(); return }
        if (reply.startupError) {
          clearTimeout(bootTimeout)
          const error = new Error(reply.startupError)
          reject(error); failAll(error); return
        }
        if (typeof reply.requestId !== 'number') return
        const item = pending.get(reply.requestId)
        if (!item) return
        pending.delete(reply.requestId); clearTimeout(item.timer)
        if (reply.error) item.reject(new Error(reply.error))
        else item.resolve(reply.result)
      })
      instance.on('error', error => { clearTimeout(bootTimeout); reject(error); failAll(error) })
      instance.on('exit', () => {
        clearTimeout(bootTimeout)
        const error = new Error('History worker stopped. Unsaved text has not been discarded; retry saving.')
        reject(error); failAll(error)
        if (worker === instance) { worker = null; ready = null }
      })
    })
    return ready
  }
  const call = async (operation: string, payload: unknown, owner = 0, roots: string[] = []): Promise<unknown> => {
    await ensureWorker()
    if (pending.size >= 64) throw new Error('The history service is busy. Please retry the operation.')
    return new Promise((resolve, reject) => {
      const requestId = ++nextId
      const timer = setTimeout(() => {
        pending.delete(requestId)
        if ((operation === 'capture' || operation === 'compare') && payload && typeof payload === 'object') {
          worker?.postMessage({ requestId: ++nextId, operation: 'cancelScan', payload, owner })
        }
        reject(new Error(operation === 'capture' || operation === 'compare'
          ? 'Fingerprint check timed out. The directory has not been reported as unchanged.'
          : 'History operation timed out. Retry saving before leaving this conversation.'))
      }, operation === 'capture' || operation === 'compare' ? 45000 : 15000)
      pending.set(requestId, { resolve, reject, timer })
      try { worker!.postMessage({ requestId, operation, payload, roots, owner }) }
      catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error) }
    })
  }
  ipcMain.handle(CONVERSATION_CHANNEL, async (event, operation: unknown, payload: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !options.isHomeSender(event.sender)) {
      throw new Error('Conversation history is only available to the Nawa workspace.')
    }
    if (typeof operation !== 'string' || !OPERATIONS.has(operation)) throw new Error('Unsupported history operation.')
    const owner = event.sender.id
    if (!clients.has(owner)) {
      clients.add(owner)
      event.sender.once('destroyed', () => {
        clients.delete(owner)
        if (worker && !closing) void call('cancelOwner', {}, owner).catch(() => undefined)
      })
    }
    if (operation === 'revealDatabase') {
      await ensureWorker()
      shell.showItemInFolder(databasePath)
      return
    }
    const scanning = operation === 'capture' || operation === 'compare'
    const roots = scanning ? await options.roots() : []
    const result = await call(operation, payload, owner, roots)
    if (scanning && JSON.stringify(roots) !== JSON.stringify(await options.roots())) {
      throw new Error('Workspace folders changed during the fingerprint check. Check again.')
    }
    return result
  })
  // Let already-submitted writes finish before closing the connection. A failed worker cannot trap Quit.
  app.on('before-quit', event => {
    if (closing || !worker) return
    event.preventDefault()
    if (quitRequested) return
    quitRequested = true
    const instance = worker
    void (async () => {
      try { await call('close', {}) } catch { /* SQLite transactions remain crash-safe. */ }
      finally {
        closing = true
        await instance.terminate().catch(() => undefined)
        failAll(new Error('Nawa closed.'))
        app.quit()
      }
    })()
  })
}
