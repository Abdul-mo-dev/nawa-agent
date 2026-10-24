/** @vitest-environment jsdom */
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { REDACTED_AI_KEY } from '@genoffice/ai-provider/browser'
import type { RemoteEmbeddingProfile } from '../src/shared/remote-models-api'
import { RemoteModelPicker } from '../src/renderer/src/remote-models/RemoteModelPicker'
import { LocaleProvider } from '../src/renderer/src/locale'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
let chat: ReturnType<typeof vi.fn>, embeddings: ReturnType<typeof vi.fn>
type Profile = RemoteEmbeddingProfile & {
  role: 'chat' | 'embedding'
  key?: string
  hasKey: boolean
  isNew: boolean
}
const initial = (): Profile => ({
  id: 'remote-example',
  name: '',
  baseUrl: '',
  model: '',
  modelRevision: '',
  dimensions: 0,
  maxInputTokens: 8192,
  documentPrefix: '',
  queryPrefix: '',
  allowRemote: false,
  role: 'chat',
  key: '',
  hasKey: false,
  isNew: true,
})
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  chat = vi.fn(async () => ({ models: ['chat-a', 'chat-b'], defaultModel: '' }))
  embeddings = vi.fn(async () => ['embed-a'])
  window.aiOffice = { getCustomModels: chat } as unknown as typeof window.aiOffice
  window.nawaRemoteEmbeddings = {
    models: embeddings,
  } as unknown as typeof window.nawaRemoteEmbeddings
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})
async function render(profile: Profile, onChange = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(RemoteModelPicker, { profile, onChange }),
      ),
    ),
  )
}
async function discover() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
}
function ids() {
  return [...host.querySelectorAll('option')].map((option) => option.textContent)
}

it('waits for a real URL and discovers without guessing a selected model', async () => {
  const onChange = vi.fn()
  await render(initial(), onChange)
  await discover()
  expect(chat).not.toHaveBeenCalled()
  await render({ ...initial(), baseUrl: 'https://models.example/v1', key: 'server-key' }, onChange)
  await discover()
  expect(chat).toHaveBeenCalledWith('https://models.example/v1', 'server-key', 'remote-example')
  expect(ids()).toEqual(['Custom model ID…', 'chat-a', 'chat-b'])
  expect(onChange).not.toHaveBeenCalled()
})
it('identifies the saved chat profile so two keys at one URL cannot be confused', async () => {
  await render({
    ...initial(),
    baseUrl: 'https://models.example/v1',
    key: undefined,
    hasKey: true,
    isNew: false,
    id: 'remote-second',
    model: 'chat-b',
  })
  await discover()
  expect(chat).toHaveBeenCalledWith('https://models.example/v1', REDACTED_AI_KEY, 'remote-second')
  expect(host.querySelector('select')!.value).toBe('model:chat-b')
})
it('supports explicit custom IDs even when the server advertises that same ID', async () => {
  function Harness() {
    const [profile, setProfile] = useState({ ...initial(), baseUrl: 'https://models.example/v1' })
    return createElement(RemoteModelPicker, {
      profile,
      onChange: (model: string) => setProfile((value) => ({ ...value, model })),
    })
  }
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(Harness))),
  )
  await discover()
  await act(async () => {
    const select = host.querySelector('select')!
    select.value = 'model:chat-a'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.querySelector('input')).toBeNull()
  await act(async () => {
    const select = host.querySelector('select')!
    select.value = 'custom'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.querySelector('input')!.value).toBe('chat-a')
  expect(host.querySelector('select')!.value).toBe('custom')
  expect(chat).toHaveBeenCalledTimes(1)
})
it('discards replies from a previous URL or API key', async () => {
  let first!: (value: { models: string[] }) => void
  chat.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        first = resolve
      }),
  )
  await render({ ...initial(), baseUrl: 'https://first.example/v1', key: 'old-key' })
  await discover()
  await render({
    ...initial(),
    baseUrl: 'https://second.example/v1',
    key: 'new-key',
    model: 'my-custom-model',
  })
  await discover()
  await act(async () => {
    first({ models: ['stale'] })
  })
  expect(ids()).not.toContain('stale')
  expect(ids()).toContain('chat-a')
  expect(host.querySelector('input')!.value).toBe('my-custom-model')
})
it('keeps custom entry available when discovery is unavailable or empty', async () => {
  chat.mockRejectedValueOnce(new Error('Unavailable'))
  await render({ ...initial(), baseUrl: 'https://models.example/v1', model: 'custom-name' })
  await discover()
  expect(host.querySelector('input')!.value).toBe('custom-name')
  expect(host.textContent).toContain('You can still enter a custom model ID')
})
it('discovers embedding metadata without a model ID, name, or file-text consent', async () => {
  await render({
    ...initial(),
    role: 'embedding',
    baseUrl: 'https://embedding.example/v1',
    key: 'embedding-key',
  })
  await discover()
  expect(embeddings).toHaveBeenCalledWith(
    expect.objectContaining({
      role: 'embedding',
      model: '',
      name: 'Remote model',
      allowRemote: false,
    }),
    'embedding-key',
  )
  expect(ids()).toEqual(['Custom model ID…', 'embed-a'])
  expect(chat).not.toHaveBeenCalled()
})
