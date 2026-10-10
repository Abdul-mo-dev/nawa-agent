import { expect, it, vi } from 'vitest'
import { AgentLoop, type AgentStreamRequest, type AgentTransport } from '../src'

it('preserves active opaque tool state and removes it when a new request begins', async () => {
  const state = {
    protocol: 'gemini' as const,
    model: 'gemini-3',
    endpoint: 'https://example',
    parts: [{ thoughtSignature: 'opaque', functionCall: { name: 'read', args: {} } }],
  }
  const requests: AgentStreamRequest[] = []
  const transport: AgentTransport = {
    stream(request, cb) {
      requests.push(structuredClone(request))
      queueMicrotask(() => {
        if (requests.length === 1) {
          cb.onProviderState?.(state)
          cb.onToolCall({ id: 'call', name: 'read', input: {} })
        } else cb.onDelta('verified')
        cb.onDone()
      })
      return { cancel() {} }
    },
  }
  const execute = vi.fn(() => ({ output: 'saved contents', summary: 'read' }))
  const loop = new AgentLoop({
    transport,
    skill: { id: 'files', systemPrompt: '', tools: [], executeTool: execute },
  })
  loop.run('read')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const assistant = requests[1]?.messages.find((message) => message.role === 'assistant')
  expect(assistant).toMatchObject({ providerState: state })
  expect(execute).toHaveBeenCalledOnce()
  loop.run('follow up with another model')
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(
    requests[2].messages.some((message) => message.role === 'assistant' && message.providerState),
  ).toBe(false)
})
