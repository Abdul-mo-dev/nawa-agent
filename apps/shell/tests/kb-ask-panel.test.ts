/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcStreamChunk, IpcStreamStart, KbFileInfo } from '@genoffice/agent-core'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import { loadKnowledgeBaseRequest } from '../src/renderer/src/ai/knowledge-base-request'

const corpus: KbFileInfo[] = [
  {
    path: '/documents/note.txt',
    name: 'note.txt',
    folder: 'documents',
    ext: '.txt',
    sizeBytes: 20,
  },
]
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function settings() {
  const result = defaultAiSettings()
  result.provider = 'openai'
  result.chatModels = [
    {
      id: 'local',
      name: 'Local model',
      provider: 'custom',
      config: {
        model: 'local-model',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8082/v1',
        policy: { contextTokens: 8192 },
      },
    },
  ]
  return result
}

const cleanup: (() => void)[] = []
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  localStorage.clear()
})
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function panel() {
  const configured = settings()
  const listeners = new Set<(chunk: IpcStreamChunk) => void>()
  const api = {
    getAiSettings: vi.fn(async () => configured),
    kbList: vi.fn(async () => corpus.map((file) => ({ ...file }))),
    kbSearch: vi.fn(async () => []),
    kbRead: vi.fn(async () => ({ text: 'Current note.', totalChars: 13, offset: 0 })),
    aiStream: vi.fn(async (_request: IpcStreamStart<AiSettings>) => undefined),
    aiStreamCancel: vi.fn(async (requestId: string) => {
      for (const listener of listeners) listener({ requestId, type: 'done' })
    }),
    onAiStreamChunk: (listener: (chunk: IpcStreamChunk) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  Object.assign(window, { aiOffice: api })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanup.push(() => {
    act(() => root.unmount())
    host.remove()
  })
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(KbAskPanel, { onOpenPath: vi.fn() }),
        ),
      ),
    )
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const send = async (text: string) => {
    await act(async () => {
      const textarea = host.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        text,
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      button('Send')!.click()
    })
  }
  const emit = (chunk: Omit<IpcStreamChunk, 'requestId'>) =>
    act(async () => {
      const requestId = api.aiStream.mock.calls.at(-1)![0].requestId
      for (const listener of listeners) listener({ ...chunk, requestId })
    })
  return { api, configured, host, render, button, send, emit }
}

it('awaits the current settings and corpus, then captures the selected local profile immutably', async () => {
  const freshSettings = deferred<AiSettings>(),
    freshCorpus = deferred<KbFileInfo[]>()
  const done = vi.fn()
  const request = loadKnowledgeBaseRequest(
    { getAiSettings: () => freshSettings.promise, kbList: () => freshCorpus.promise },
    'local',
  ).then((value) => {
    done()
    return value
  })
  const configured = settings()
  freshSettings.resolve(configured)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  const files = corpus.map((file) => ({ ...file }))
  freshCorpus.resolve(files)
  const prepared = await request
  expect(prepared.settings).toMatchObject({
    provider: 'custom',
    selectedChatModelId: 'local',
    providers: {
      custom: { baseUrl: 'http://127.0.0.1:8082/v1', model: 'local-model', apiKey: '' },
    },
  })
  configured.chatModels![0]!.config.model = 'changed-model'
  files[0]!.path = '/removed.txt'
  expect(prepared.settings.providers.custom.model).toBe('local-model')
  expect(prepared.corpus[0]!.path).toBe('/documents/note.txt')
  expect(configured.provider).toBe('openai')
})

it('invalidates conversation evidence when a corpus file changes without changing size', async () => {
  const first = { ...corpus[0]!, mtimeMs: 1000 }
  const second = { ...first, path: '/documents/other.txt' }
  const api = { getAiSettings: async () => settings(), kbList: vi.fn(async () => [first, second]) }
  const before = await loadKnowledgeBaseRequest(api, 'local')
  api.kbList.mockResolvedValueOnce([second, first])
  expect((await loadKnowledgeBaseRequest(api, 'local')).corpusKey).toBe(before.corpusKey)
  api.kbList.mockResolvedValueOnce([second, { ...first, mtimeMs: 2000 }])
  expect((await loadKnowledgeBaseRequest(api, 'local')).corpusKey).not.toBe(before.corpusKey)
})

it('uses the persisted local chat profile without a Genspark login and permits retry after a stream failure', async () => {
  localStorage.setItem('nawa:knowledge-base-chat-model', 'local')
  const p = panel()
  await p.render()
  expect(p.host.textContent).not.toMatch(/sign in.*genspark/i)
  p.api.kbList.mockResolvedValueOnce([
    { ...corpus[0]!, path: '/documents/current.txt', name: 'current.txt' },
  ])
  await p.send('What does the current note say?')
  expect(p.api.aiStream).toHaveBeenCalledOnce()
  expect(p.api.aiStream.mock.calls[0]![0]).toMatchObject({
    settings: { provider: 'custom', selectedChatModelId: 'local' },
  })
  expect(JSON.stringify(p.api.aiStream.mock.calls[0]![0].messages)).toContain(
    '/documents/current.txt',
  )
  await p.emit({ type: 'error', error: 'Local endpoint is unavailable.' })
  expect(p.host.textContent).toContain('Local endpoint is unavailable.')
  expect(p.button('Stop')).toBeNull()
  await p.send('Try the request again.')
  expect(p.api.aiStream).toHaveBeenCalledTimes(2)
  await p.emit({ type: 'delta', text: 'Recovered answer.' })
  await p.emit({ type: 'done' })
  expect(p.host.textContent).toContain('Recovered answer.')
  expect(p.button('Stop')).toBeNull()
})

it('does not send with stale data after a refresh fails and allows another question', async () => {
  const p = panel()
  await p.render()
  p.api.kbList.mockRejectedValueOnce(new Error('The starred corpus could not be refreshed.'))
  await p.send('Read the notes.')
  expect(p.api.aiStream).not.toHaveBeenCalled()
  expect(p.host.textContent).toContain('The starred corpus could not be refreshed.')
  expect(p.button('Stop')).toBeNull()
  await p.send('Try again.')
  expect(p.api.aiStream).toHaveBeenCalledOnce()
  await p.emit({ type: 'error', error: 'Test cleanup.' })
})

it('cancels during request preparation and ignores its late settings/corpus completion', async () => {
  const p = panel()
  await p.render()
  const refresh = deferred<KbFileInfo[]>()
  p.api.kbList.mockReturnValueOnce(refresh.promise)
  await p.send('Read the notes.')
  expect(p.api.aiStream).not.toHaveBeenCalled()
  await act(async () => {
    p.button('Stop')!.click()
  })
  await act(async () => {
    refresh.resolve(corpus)
  })
  expect(p.api.aiStream).not.toHaveBeenCalled()
  expect(p.host.textContent).toContain('Stopped.')
  await p.send('New question.')
  expect(p.api.aiStream).toHaveBeenCalledOnce()
  await p.emit({ type: 'error', error: 'Test cleanup.' })
})
