/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { RuntimeSetupPanel } from '../src/renderer/src/local-models/RuntimeSetupPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'
import type { RuntimeSetupOptions, RuntimeSetupSnapshot } from '../src/shared/runtime-setup-api'

vi.mock('../src/renderer/src/explorer/panel-state', () => ({ usePanelActivity: () => {} }))
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, snapshot: RuntimeSetupSnapshot
let install: ReturnType<typeof vi.fn>,
  saveChat: ReturnType<typeof vi.fn>,
  saveEmbedding: ReturnType<typeof vi.fn>
const profile = (kind: 'chat' | 'embedding') => ({
  id: `nawa-default-${kind}`,
  name: kind,
  kind,
  modelPath: kind === 'chat' ? '/models/chat.gguf' : '/models/embeddinggemma-2-Q8_0.gguf',
  alias: kind === 'chat' ? 'gemma-4-e4b' : 'embeddinggemma-2',
  port: kind === 'chat' ? 18083 : 18086,
  contextSize: kind === 'chat' ? 65536 : 8192,
  gpuLayers: 'auto' as const,
  threads: 0,
  pooling: 'model' as const,
  autoStart: false,
  arguments: [],
})
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  snapshot = {
    supported: true,
    offer: false,
    state: 'idle',
    stage: '',
    received: 0,
    total: 0,
    directory: '/setup',
    ocr: true,
    office: null,
    runtime: '/existing/llama-server.exe',
    reuseRuntime: true,
    needsActivation: false,
    activationKinds: [],
    profiles: [],
  }
  install = vi.fn(async (options: RuntimeSetupOptions) => {
    const kinds = [
      ...(options.chatModel ? ['chat' as const] : []),
      ...(options.embeddingModel ? ['embedding' as const] : []),
    ]
    snapshot = {
      ...snapshot,
      state: 'ready',
      profiles: kinds.map(profile),
      activationKinds: options.useDefaults ? kinds : [],
      needsActivation: options.useDefaults && kinds.length > 0,
    }
    return snapshot
  })
  window.nawaRuntimeSetup = {
    inspect: async () => snapshot,
    install,
    activated: async (kinds) => {
      snapshot = {
        ...snapshot,
        activationKinds: snapshot.activationKinds.filter((kind) => !kinds?.includes(kind)),
        needsActivation: false,
      }
    },
  } as typeof window.nawaRuntimeSetup
  saveChat = vi.fn(async () => {})
  saveEmbedding = vi.fn(async () => ({}))
  window.aiOffice = {
    getAiSettings: async () => defaultAiSettings(),
    setAiSettings: saveChat,
  } as unknown as typeof window.aiOffice
  window.nawaRag = {
    settings: async () => ({ settings: DEFAULT_RAG_SETTINGS }),
    save: saveEmbedding,
  } as unknown as typeof window.nawaRag
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})
async function open() {
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(RuntimeSetupPanel))),
  )
}
async function choose(index: number, checked: boolean) {
  await act(async () => {
    const input = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[index]
    if (input.checked !== checked) input.click()
  })
}
async function submit() {
  await act(async () => {
    ;[...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Install and set up')!
      .click()
  })
}
it('activates only embedding settings when only the embedding model is selected', async () => {
  await open()
  await choose(0, false)
  await choose(3, false)
  await submit()
  expect(install).toHaveBeenCalledWith(
    expect.objectContaining({
      chatModel: false,
      embeddingModel: true,
      runtime: false,
      office: false,
    }),
  )
  expect(saveEmbedding).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'embeddinggemma-2', enabled: true }),
    '',
  )
  expect(saveChat).not.toHaveBeenCalled()
})
it('activates only chat settings when only the chat model is selected', async () => {
  await open()
  await choose(1, false)
  await choose(3, false)
  await submit()
  expect(host.querySelector('[role=alert]')?.textContent).toBeUndefined()
  expect(saveChat).toHaveBeenCalledWith(
    expect.objectContaining({ defaultChatModelId: 'runtime-nawa-default-chat' }),
  )
  expect(saveEmbedding).not.toHaveBeenCalled()
})
it('allows model-only downloads without a runtime and disables connection actions', async () => {
  snapshot = { ...snapshot, runtime: null, reuseRuntime: false }
  await open()
  await choose(0, false)
  await choose(2, false)
  await choose(3, false)
  expect(host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[4].disabled).toBe(true)
  expect(host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[4].checked).toBe(false)
  await submit()
  expect(install).toHaveBeenCalledWith(
    expect.objectContaining({
      chatModel: false,
      embeddingModel: true,
      runtime: false,
      startModels: false,
      useDefaults: false,
    }),
  )
  expect(saveChat).not.toHaveBeenCalled()
  expect(saveEmbedding).not.toHaveBeenCalled()
})
it('allows downloading llama.cpp without downloading or activating any models', async () => {
  await open()
  await choose(0, false)
  await choose(1, false)
  await choose(2, true)
  await choose(3, false)
  await submit()
  expect(install).toHaveBeenCalledWith(
    expect.objectContaining({
      chatModel: false,
      embeddingModel: false,
      runtime: true,
      startModels: false,
      useDefaults: false,
    }),
  )
  expect(saveChat).not.toHaveBeenCalled()
  expect(saveEmbedding).not.toHaveBeenCalled()
})
