import { afterEach, expect, it, vi } from 'vitest'
import { chatForProvider } from '../src/chat'
import { streamForProvider } from '../src/stream'
import { defaultAiSettings, resolveAiSettings } from '../src/providers'
import { sanitizeAiSettings } from '../src/ai-settings-guard'
import { jsonResponse } from './test-utils'

afterEach(() => vi.unstubAllGlobals())
it('preserves local per-slot context and output caps through saved-model normalization', () => {
  const current = defaultAiSettings()
  const config = {
    apiKey: '',
    model: 'gemma-4-e4b',
    baseUrl: 'http://127.0.0.1:8083/v1',
    policy: {
      mode: 'local' as const,
      contextTokens: 32768,
      outputTokens: 1024,
    },
  }
  current.provider = 'custom'
  current.providers.custom = config
  current.customEndpoints = [{ id: 'local-gemma', name: 'Gemma', ...config }]
  current.customEndpoint = 'local-gemma'
  current.chatModels = [{ id: 'local-gemma', name: 'Gemma', provider: 'custom', config }]
  const settings = resolveAiSettings(sanitizeAiSettings(current), defaultAiSettings())
  for (const policy of [
    settings.providers.custom.policy,
    settings.customEndpoints?.[0].policy,
    settings.chatModels?.[0].config.policy,
  ])
    expect(policy).toMatchObject({ mode: 'local', contextTokens: 32768, outputTokens: 1024 })
})
it('lets the local server own temperature for both chat and streaming requests', async () => {
  const fetcher = vi.fn(async () =>
    jsonResponse({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] }),
  )
  vi.stubGlobal('fetch', fetcher)
  const config = {
    apiKey: '',
    model: 'gemma-4-e4b',
    baseUrl: 'http://127.0.0.1:8083/v1',
    policy: {
      mode: 'local' as const,
      contextTokens: 32768,
      outputTokens: 1024,
    },
  }
  await chatForProvider('custom', config, 'Reply concisely.', 'Hi')
  await streamForProvider(
    'custom',
    config,
    'Reply concisely.',
    [{ role: 'user', text: 'Hi' }],
    [],
    1024,
    { signal: new AbortController().signal, onDelta: vi.fn(), onToolCall: vi.fn() },
  )
  const requests = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>).filter(([url]) =>
    String(url).endsWith('/chat/completions'),
  )
  expect(requests).toHaveLength(2)
  for (const [, options] of requests) {
    const body = JSON.parse(String(options.body))
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body.model).toBe('gemma-4-e4b')
  }
})
it('retains the existing default temperature for connections without server sampling', async () => {
  const fetcher = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
  vi.stubGlobal('fetch', fetcher)
  await chatForProvider(
    'custom',
    {
      apiKey: '',
      model: 'other',
      baseUrl: 'https://inference.example/v1',
      policy: { mode: 'cloud' },
    },
    '',
    'Hi',
  )
  const request = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>).find(([url]) =>
    String(url).endsWith('/chat/completions'),
  )!
  expect(JSON.parse(String(request[1].body)).temperature).toBe(0.3)
})
