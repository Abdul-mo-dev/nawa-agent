import { beforeEach, expect, it, vi } from 'vitest'
import { RUNTIME_SETUP_CHANNEL } from '../src/shared/runtime-setup-api'
const state = vi.hoisted(() => ({
  handler: undefined as any,
  inspect: vi.fn(async () => ({})),
  install: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'test-user-data', isPackaged: true, once: vi.fn() },
  ipcMain: {
    handle: (_channel: string, handler: any) => {
      state.handler = handler
    },
  },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}))
vi.mock('../src/main/pdf2docx-local', () => ({ ensureOcrEngine: () => null }))
vi.mock('../src/main/runtime-setup/service', () => ({
  RuntimeSetupService: class {
    inspect = state.inspect
    install = state.install
    cancel = state.cancel
  },
}))
import { registerRuntimeSetupIpc } from '../src/main/runtime-setup/ipc'
beforeEach(() => {
  vi.clearAllMocks()
})
it('restricts dependency downloads and installers to the trusted top-level settings renderer', async () => {
  const home = { mainFrame: {} },
    other = { mainFrame: {} }
  registerRuntimeSetupIpc((sender) => sender === home, {} as any)
  expect(RUNTIME_SETUP_CHANNEL).toBe('nawa:runtime-setup:v1')
  await expect(
    state.handler({ sender: other, senderFrame: other.mainFrame }, 'install', {}),
  ).rejects.toThrow('only in Nawa settings')
  await expect(state.handler({ sender: home, senderFrame: {} }, 'install', {})).rejects.toThrow(
    'only in Nawa settings',
  )
  expect(state.install).not.toHaveBeenCalled()
  await expect(
    state.handler({ sender: home, senderFrame: home.mainFrame }, 'run-shell'),
  ).rejects.toThrow('Unknown runtime setup')
  await state.handler({ sender: home, senderFrame: home.mainFrame }, 'install', {
    embeddingModel: true,
  })
  expect(state.install).toHaveBeenCalledWith({ embeddingModel: true })
})
