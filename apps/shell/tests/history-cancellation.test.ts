import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ConversationHistoryApi } from '../src/shared/conversation-api'

const electron = vi.hoisted(() => ({
  directory: '',
  handle: vi.fn(),
  on: vi.fn(),
  quit: vi.fn(),
  invoke: vi.fn(),
  exposed: new Map<string, unknown>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => electron.directory, on: electron.on, quit: electron.quit },
  ipcMain: { handle: electron.handle },
  shell: { showItemInFolder: vi.fn() },
  ipcRenderer: { invoke: electron.invoke },
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => electron.exposed.set(name, api),
  },
}))

import { registerHistoryIpc } from '../src/main/history/history-ipc'
import '../src/preload/conversation-history'

const api = electron.exposed.get('nawaHistory') as ConversationHistoryApi
let handler: (event: unknown, operation: string, payload?: unknown) => Promise<unknown>
const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} }) as unknown as WebContents
const event = { sender, senderFrame: sender.mainFrame }
beforeAll(async () => {
  electron.directory = await mkdtemp(join(tmpdir(), 'nawa-history-cancel-'))
  registerHistoryIpc({ isHomeSender: () => true, roots: async () => [electron.directory] })
  handler = electron.handle.mock.calls[0][1]
  electron.invoke.mockImplementation((_channel, operation, payload) =>
    handler(event, operation, payload),
  )
  await api.initialize()
})
afterAll(async () => {
  await new Promise<void>((resolve) => {
    electron.quit.mockImplementation(resolve)
    const beforeQuit = electron.on.mock.calls.find(([name]) => name === 'before-quit')![1]
    beforeQuit({ preventDefault() {} })
  })
  await rm(electron.directory, { recursive: true, force: true })
})

describe('history cancellation through the worker, IPC and preload', () => {
  it('resolves intentional cancellations at the IPC boundary for both scan operations', async () => {
    const conversation = await api.create({ folder: null, folderName: 'Test' })
    for (const operation of ['capture', 'compare']) {
      const scanId = randomUUID()
      await api.cancelScan(scanId)
      await expect(handler(event, operation, { id: conversation.id, scanId })).resolves.toEqual({
        cancelled: true,
      })
    }
  })

  it('rejects locally in the preload so a cancelled capture cannot become a chat baseline', async () => {
    const conversation = await api.create({ folder: null, folderName: 'Test' })
    const scope = { opened: null, files: [], directories: [] }
    for (const operation of ['capture', 'compare'] as const) {
      const scanId = randomUUID()
      await api.cancelScan(scanId)
      await expect(api[operation]({ id: conversation.id, scanId, scope })).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Fingerprint check cancelled.',
      })
      // Electron received a successful invoke result, rather than a thrown handler error.
      await expect(electron.invoke.mock.results.at(-1)!.value).resolves.toEqual({ cancelled: true })
    }
    expect((await api.get(conversation.id)).baselineId).toBeNull()
  })

  it('still returns successful fingerprints and reports genuine history errors', async () => {
    const conversation = await api.create({ folder: null, folderName: 'Test' })
    const file = join(electron.directory, 'source.txt')
    await writeFile(file, 'verified contents')
    const snapshot = await api.capture({
      id: conversation.id,
      scanId: randomUUID(),
      scope: { opened: null, files: [file], directories: [] },
    })
    expect(snapshot.complete).toBe(true)
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/)
    await expect(api.compare({ id: conversation.id, scanId: randomUUID() })).resolves.toMatchObject(
      { status: 'no-baseline' },
    )
    await expect(api.get(randomUUID())).rejects.toThrow()
    await expect(handler(event, 'unsupported')).rejects.toThrow('Unsupported history operation')
  })
})
