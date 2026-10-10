import { expect, it } from 'vitest'
import type { AgentMessage, AgentToolCall } from '@genoffice/agent-core'
import { streamForProvider } from '../src/stream'

// Opt-in only: regular tests never need or contact a local inference server.
const baseUrl = process.env.NAWA_LLAMA_TEST_URL
it.skipIf(!baseUrl)(
  'completes a real llama.cpp streaming function-call round trip',
  async () => {
    const config = {
      apiKey: '',
      model: process.env.NAWA_LLAMA_TEST_MODEL || 'Agent-A1-4B',
      baseUrl,
    }
    const messages: AgentMessage[] = [
      {
        role: 'user',
        text: 'Call show_number with number 7. After the tool responds, reply with the returned number only.',
      },
    ]
    const tools = [
      {
        name: 'show_number',
        description: 'Return the requested number.',
        inputSchema: {
          type: 'object',
          properties: { number: { type: 'integer' } },
          required: ['number'],
        },
      },
    ]
    const calls: AgentToolCall[] = []
    const deltas: string[] = []
    const stops: string[] = []
    const cb = {
      signal: AbortSignal.timeout(90_000),
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => calls.push(call),
      onStopReason: (reason: string) => stops.push(reason),
    }
    const system = 'Use the provided tool to obtain the answer. Keep the final answer brief.'
    await streamForProvider('custom', config, system, messages, tools, 1024, cb)
    expect(stops).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'show_number', input: { number: 7 } })
    expect(calls[0]?.inputError).toBeUndefined()
    messages.push(
      { role: 'assistant', text: deltas.join(''), toolCalls: calls },
      {
        role: 'tool',
        results: [{ id: calls[0]!.id, name: 'show_number', output: '{"number":7}' }],
      },
    )
    deltas.length = 0
    await streamForProvider('custom', config, system, messages, [], 512, cb)
    expect(stops).toEqual([])
    expect(deltas.join('')).toMatch(/\b7\b/)
  },
  100_000,
)
