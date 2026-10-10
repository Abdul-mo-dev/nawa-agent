import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentToolCall } from '@genoffice/agent-core'
import { isLoopbackApiUrl, usesLocalOpenAi } from '../src/local-endpoint'
import { defaultAiSettings, maxOutputTokensOf } from '../src/providers'
import { applyChatModel } from '../src/chat-models'
import { chatForProvider } from '../src/chat'
import { streamForProvider } from '../src/stream'
import { jsonResponse, okResponse, sseStream } from './test-utils'

afterEach(() => vi.unstubAllGlobals())

describe('local OpenAI-compatible policy', () => {
  it.each([
    'http://127.0.0.1:8082/v1',
    'http://127.0.0.2/v1',
    'https://localhost/v1',
    'http://[::1]:8082/v1',
  ])('recognizes loopback: %s', (url) => expect(isLoopbackApiUrl(url)).toBe(true))

  it.each([
    'http://127.example.com/v1',
    'https://localhost.example/v1',
    'http://192.168.1.2/v1',
    'file://localhost/v1',
    'bad-url',
    undefined,
  ])('keeps other URLs outside the local policy: %s', (url) =>
    expect(isLoopbackApiUrl(url)).toBe(false),
  )

  it('uses a smaller local default while honoring saved limits and the selected chat profile', () => {
    const settings = defaultAiSettings()
    settings.provider = 'custom'
    settings.providers.custom = {
      apiKey: '',
      model: 'Agent-A1-4B',
      baseUrl: 'http://127.0.0.1:8082/v1',
    }
    expect(usesLocalOpenAi(settings)).toBe(true)
    expect(maxOutputTokensOf(settings)).toBe(4096)
    expect(maxOutputTokensOf({ ...settings, maxOutputTokens: Number.NaN })).toBe(4096)
    expect(maxOutputTokensOf({ ...settings, maxOutputTokens: 2048 })).toBe(2048)
    expect(maxOutputTokensOf({ ...settings, maxOutputTokens: 32768 })).toBe(8192)
    settings.provider = 'genspark'
    settings.chatModels = [
      {
        id: 'local',
        name: 'Local agent',
        provider: 'custom',
        config: { model: 'Agent-A1-4B', baseUrl: 'http://127.0.0.1:8082/v1', apiKey: '' },
      },
    ]
    expect(maxOutputTokensOf(settings)).toBe(8192)
    const selected = applyChatModel(settings, 'local')
    expect(usesLocalOpenAi(selected)).toBe(true)
    expect(maxOutputTokensOf(selected)).toBe(4096)
    selected.providers.custom.baseUrl = 'https://host.example/v1'
    expect(maxOutputTokensOf(selected)).toBe(8192)
  })

  it('caps one-shot local calls and leaves server sampling unchanged', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ choices: [{ message: { content: 'OK' } }] })),
      )
    vi.stubGlobal('fetch', fetchMock)
    await chatForProvider(
      'custom',
      { apiKey: '', model: 'Agent-A1-4B', baseUrl: 'http://127.0.0.1:8082/v1' },
      'sys',
      'hello',
    )
    const [url, request] = fetchMock.mock.calls[0]!
    const body = JSON.parse(request.body)
    expect(url).toBe('http://127.0.0.1:8082/v1/chat/completions')
    expect(body.model).toBe('Agent-A1-4B')
    expect(body.max_tokens).toBe(4096)
    expect(body).not.toHaveProperty('temperature')
    expect(request.headers).not.toHaveProperty('Authorization')
    await chatForProvider(
      'custom',
      { apiKey: 'key', model: 'remote', baseUrl: 'https://host.example/v1' },
      'sys',
      'hello',
    )
    const remote = JSON.parse(fetchMock.mock.calls[1]![1].body)
    expect(remote.temperature).toBe(0.3)
    expect(remote.max_tokens).toBe(8192)
  })

  it('streams fragmented tool arguments and sends a valid local tool-result follow-up', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          okResponse(
            sseStream([
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"show_number","arguments":"{\\\"number\\\":"}}]}}]}',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"7}"}}]},"finish_reason":"tool_calls"}]}',
              'data: [DONE]',
            ]),
          ),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          okResponse(
            sseStream([
              'data: {"choices":[{"delta":{"content":"7"},"finish_reason":"stop"}]}',
              'data: [DONE]',
            ]),
          ),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const config = { apiKey: '', model: 'Agent-A1-4B', baseUrl: 'http://127.0.0.1:8082/v1' }
    const calls: AgentToolCall[] = []
    const onDelta = vi.fn()
    const cb = {
      signal: new AbortController().signal,
      onDelta,
      onToolCall: (call: AgentToolCall) => calls.push(call),
    }
    const messages: AgentMessage[] = [{ role: 'user', text: 'Call show_number with 7.' }]
    const tools = [
      {
        name: 'show_number',
        description: 'Show the supplied number.',
        inputSchema: {
          type: 'object',
          properties: { number: { type: 'integer' } },
          required: ['number'],
        },
      },
    ]
    await streamForProvider('custom', config, 'Use the supplied tool.', messages, tools, 1024, cb)
    expect(calls).toEqual([
      { id: 'call_1', name: 'show_number', input: { number: 7 }, inputError: undefined },
    ])
    messages.push(
      { role: 'assistant', text: '', toolCalls: calls },
      { role: 'tool', results: [{ id: 'call_1', name: 'show_number', output: '{"number":7}' }] },
    )
    await streamForProvider('custom', config, 'Use the supplied tool.', messages, [], 512, cb)
    expect(onDelta).toHaveBeenCalledWith('7')
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body)
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body)
    expect(first.max_tokens).toBe(1024)
    expect(first).not.toHaveProperty('temperature')
    expect(second.max_tokens).toBe(512)
    expect(second).not.toHaveProperty('temperature')
    expect(second.messages.at(-2).tool_calls[0].function.arguments).toBe('{"number":7}')
    expect(second.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"number":7}',
    })
  })
})
