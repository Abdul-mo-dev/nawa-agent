import { afterEach, expect, it, vi } from 'vitest'
import { testModelCapabilities } from '../src/capability-test'
import { jsonResponse, okResponse, sseStream } from './test-utils'

afterEach(() => vi.unstubAllGlobals())
it.each(['custom', 'openai', 'anthropic', 'gemini'] as const)(
  'verifies the %s tool and result contract with synthetic data',
  async (provider) => {
    const bodies: Record<string, any>[] = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      bodies.push(body)
      const raw = JSON.stringify(body)
      const nonce = /nawa_[a-f\d]{16}/.exec(raw)?.[0]
      const proof = /VERIFIED_[a-f\d]{16}/.exec(raw)?.[0]
      if (provider === 'gemini')
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: proof
                  ? [{ text: proof }]
                  : [
                      {
                        functionCall: { name: 'nawa_capability_check', args: { nonce } },
                        thoughtSignature: 'opaque-signature',
                      },
                    ],
              },
              finishReason: 'STOP',
            },
          ],
        })
      if (provider === 'anthropic')
        return okResponse(
          sseStream(
            proof
              ? [
                  'data: ' +
                    JSON.stringify({
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: proof },
                    }),
                  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
                ]
              : [
                  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"nawa_capability_check","input":{}}}',
                  'data: ' +
                    JSON.stringify({
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ nonce }) },
                    }),
                  'data: {"type":"content_block_stop","index":0}',
                  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
                ],
          ),
        )
      return jsonResponse({
        choices: [
          {
            message: proof
              ? { content: proof }
              : {
                  tool_calls: [
                    {
                      id: 'call',
                      type: 'function',
                      function: {
                        name: 'nawa_capability_check',
                        arguments: JSON.stringify({ nonce }),
                      },
                    },
                  ],
                },
            finish_reason: proof ? 'stop' : 'tool_calls',
          },
        ],
      })
    })
    vi.stubGlobal('fetch', fetch)
    const config = {
      apiKey: provider === 'custom' ? '' : 'key',
      model: 'fixture',
      ...(provider === 'custom' ? { baseUrl: 'http://127.0.0.1:8082/v1' } : {}),
    }
    const result = await testModelCapabilities(provider, config)
    expect(result).toMatchObject({ ok: true, capabilities: { tools: true } })
    expect(result.capabilities).not.toHaveProperty('vision')
    expect(bodies).toHaveLength(2)
    if (provider === 'gemini') expect(JSON.stringify(bodies[1])).toContain('opaque-signature')
  },
)

it('does not accept a text ping as tool support', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }),
    )
  vi.stubGlobal('fetch', fetch)
  const result = await testModelCapabilities('custom', {
    apiKey: '',
    model: 'fixture',
    baseUrl: 'http://localhost/v1',
  })
  expect(result).toMatchObject({ ok: false, capabilities: { tools: false, vision: false } })
  expect(fetch).toHaveBeenCalledOnce()
})

it('does not cache a transient outage as unsupported tools', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  const result = await testModelCapabilities('openai', { apiKey: 'key', model: 'fixture' })
  expect(result.ok).toBe(false)
  expect(result.capabilities).toBeUndefined()
})
