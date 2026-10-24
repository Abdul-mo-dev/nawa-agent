import { expect, it, vi } from 'vitest'
import { REMOTE_EMBEDDING_CHANNEL } from '../src/shared/remote-models-api'
const state = vi.hoisted(() => ({
  handler: undefined as any,
  save: vi.fn(async () => ({})),
  list: vi.fn(async () => ({})),
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'test-directory' },
  safeStorage: {},
  ipcMain: {
    handle: (_channel: string, handler: any) => {
      state.handler = handler
    },
  },
  webContents: { getAllWebContents: () => [] },
}))
vi.mock('../src/main/remote-models/embeddings', () => ({
  RemoteEmbeddingProfiles: class {
    list = state.list
    save = state.save
  },
}))
import { registerRemoteEmbeddingIpc } from '../src/main/remote-models/ipc'
it('allows profile credentials and mutations only from the trusted home frame', async () => {
  const home = { mainFrame: {} },
    other = { mainFrame: {} }
  registerRemoteEmbeddingIpc((sender) => sender === home, {} as any)
  expect(REMOTE_EMBEDDING_CHANNEL).toBe('nawa:remote-embeddings:v1')
  await expect(
    state.handler({ sender: other, senderFrame: other.mainFrame }, 'save', {}),
  ).rejects.toThrow('only in Nawa settings')
  await expect(state.handler({ sender: home, senderFrame: {} }, 'save', {})).rejects.toThrow(
    'only in Nawa settings',
  )
  expect(state.save).not.toHaveBeenCalled()
  await expect(
    state.handler({ sender: home, senderFrame: home.mainFrame }, 'run-command'),
  ).rejects.toThrow('Unknown remote profile')
  await state.handler({ sender: home, senderFrame: home.mainFrame }, 'list')
  expect(state.list).toHaveBeenCalledOnce()
})
