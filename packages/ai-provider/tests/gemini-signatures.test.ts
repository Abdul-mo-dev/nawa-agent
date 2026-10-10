import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentProviderState, AgentToolCall } from '@genoffice/agent-core'
import { streamForProvider } from '../src/stream'
import { jsonResponse, okResponse, sseStream } from './test-utils'

afterEach(() => vi.unstubAllGlobals())
const config = { apiKey: 'key', model: 'gemini-3-fixture' }
const parts = [
  { text: 'private thought', thought: true, thoughtSignature: 'text-signature' },
  {
    functionCall: { id: 'original_1', name: 'read', args: { path: 'a' } },
    thoughtSignature: 'call-signature',
    extraOpaqueField: 'preserve',
  },
  { functionCall: { id: 'original_2', name: 'read', args: { path: 'b' } } },
]
it.each(['json', 'sse'] as const)(
  'retains signed parallel parts in their original order through %s transport',
  async (format) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        format === 'json'
          ? jsonResponse({ candidates: [{ content: { parts }, finishReason: 'STOP' }] })
          : okResponse(
              sseStream(
                parts
                  .map(
                    (part) =>
                      'data: ' + JSON.stringify({ candidates: [{ content: { parts: [part] } }] }),
                  )
                  .concat('data: {"candidates":[{"finishReason":"STOP"}]}'),
              ),
            ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        }),
      )
    vi.stubGlobal('fetch', fetch)
    const calls: AgentToolCall[] = []
    const text: string[] = [],
      thoughts: string[] = []
    let providerState: AgentProviderState | undefined
    const cb = {
      signal: new AbortController().signal,
      onDelta: (value: string) => text.push(value),
      onReasoningDelta: (value: string) => thoughts.push(value),
      onToolCall: (call: AgentToolCall) => calls.push(call),
      onProviderState: (value: AgentProviderState) => {
        providerState = value
      },
    }
    const messages: AgentMessage[] = [{ role: 'user', text: 'Read both selected files.' }]
    await streamForProvider('gemini', config, 'system', messages, [], 1024, cb)
    expect(text).toEqual([])
    expect(thoughts).toEqual(['private thought'])
    expect(providerState?.parts).toEqual(parts)
    expect(calls.map((call) => call.id)).toEqual(['original_1', 'original_2'])
    messages.push(
      { role: 'assistant', text: '', toolCalls: calls, providerState },
      {
        role: 'tool',
        results: calls.map((call) => ({ id: call.id, name: call.name, output: 'saved bytes' })),
      },
    )
    await streamForProvider('gemini', config, 'system', messages, [], 1024, cb)
    const body = JSON.parse(fetch.mock.calls[1][1].body)
    expect(body.contents[1].parts).toEqual(parts)
    expect(
      body.contents[2].parts.map(
        (part: { functionResponse: { id: string } }) => part.functionResponse.id,
      ),
    ).toEqual(['original_1', 'original_2'])
    expect(text).toEqual(['done'])
  },
)

it('rejects active signatures from another model before sending', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(
    streamForProvider(
      'gemini',
      config,
      '',
      [
        {
          role: 'assistant',
          text: '',
          providerState: {
            protocol: 'gemini',
            model: 'different',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            parts,
          },
        },
      ],
      [],
      1024,
      { signal: new AbortController().signal, onDelta() {}, onToolCall() {} },
    ),
  ).rejects.toThrow('model changed')
  expect(fetch).not.toHaveBeenCalled()
})

it('marks function calls from a token-limited Gemini response unusable', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ candidates: [{ content: { parts }, finishReason: 'MAX_TOKENS' }] }),
      ),
  )
  const onToolCall = vi.fn()
  await streamForProvider('gemini', config, '', [{ role: 'user', text: 'task' }], [], 1024, {
    signal: new AbortController().signal,
    onDelta() {},
    onToolCall,
  })
  expect(onToolCall.mock.calls.every(([call]) => call.truncated === true)).toBe(true)
})
