import { expect, it, vi, beforeEach } from 'vitest'
import { LOCAL_MODELS_CHANNEL } from '../src/shared/local-models-api'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  inspect: vi.fn(async () => ({ config: { executablePath: '', profiles: [] } })),
  start: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
  autoStart: vi.fn(),
  choose: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'test-user-data', once: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => Promise<any>) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.choose },
  shell: { openPath: vi.fn() },
}))
vi.mock('../src/main/local-models/service', () => ({
  LocalModelsService: class {
    inspect = mocks.inspect
    start = mocks.start
    stop = mocks.stop
    dispose = mocks.dispose
    autoStart = mocks.autoStart
  },
}))
import { registerLocalModelsIpc } from '../src/main/local-models/ipc'
beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
})
it('refuses model administration from non-workspace senders and child frames', async () => {
  const home = { mainFrame: {} },
    other = { mainFrame: {} }
  registerLocalModelsIpc((sender) => sender === home)
  const handler = mocks.handlers.get(LOCAL_MODELS_CHANNEL)!
  await expect(handler({ sender: other, senderFrame: other.mainFrame }, 'inspect')).rejects.toThrow(
    'only in Nawa settings',
  )
  await expect(
    handler({ sender: home, senderFrame: {} }, 'control', 'start', 'profile'),
  ).rejects.toThrow('only in Nawa settings')
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.inspect).not.toHaveBeenCalled()
  await expect(
    handler({ sender: home, senderFrame: home.mainFrame }, 'inspect'),
  ).resolves.toMatchObject({ config: { profiles: [] } })
})
it('rejects unknown operations before starting or stopping any runtime', async () => {
  const home = { mainFrame: {} }
  registerLocalModelsIpc(() => true)
  const handler = mocks.handlers.get(LOCAL_MODELS_CHANNEL)!,
    event = { sender: home, senderFrame: home.mainFrame }
  await expect(handler(event, 'control', 'arbitrary-command', 'profile')).rejects.toThrow(
    'Invalid runtime action',
  )
  await expect(handler(event, 'agent-run')).rejects.toThrow('Unknown local model')
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.stop).not.toHaveBeenCalled()
})
