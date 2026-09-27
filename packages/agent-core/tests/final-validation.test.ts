import { expect, it, vi } from 'vitest'
import { AgentLoop, type AgentStreamCallbacks, type AgentLoopOptions } from '../src'

function run(script: ((cb: AgentStreamCallbacks) => void)[], options: Partial<AgentLoopOptions> = {}) {
  const validate = vi.fn(), verify = vi.fn(), finished = vi.fn(), error = vi.fn()
  let index = 0
  const loop = new AgentLoop({
    transport: { stream(_request, cb) { queueMicrotask(() => script[index++]!(cb)); return { cancel() {} } } },
    skill: { id: 'read', systemPrompt: '', tools: [{ name: 'read', description: '', inputSchema: {} }], executeTool: () => ({ output: 'evidence', summary: 'Read' }) },
    validateResponse: validate, verifyResponse: verify, events: { onDone: finished, onError: error }, ...options,
  })
  loop.run('Read the source')
  return { loop, validate, verify, finished, error }
}
const answer = (text = 'Answer') => (cb: AgentStreamCallbacks) => { cb.onDelta(text); cb.onDone() }
it('validates a corrected answer and rejects a source change during the corrective turn', async () => {
  const integrity = vi.fn(() => { throw new Error('source changed') })
  const result = run([answer('Unsupported claim'), answer('Corrected claim')], { verifyResponse: () => 'Correct that claim', validateResponse: integrity })
  await vi.waitFor(() => expect(result.error).toHaveBeenCalled())
  expect(integrity).toHaveBeenCalledExactlyOnceWith('Corrected claim', [])
  expect(result.finished).not.toHaveBeenCalled()
})
it('validates finalization at the turn limit', async () => {
  const result = run([cb => { cb.onToolCall({ id: 'read', name: 'read', input: {} }); cb.onDone() }, answer()], { maxTurns: 1 })
  await vi.waitFor(() => expect(result.finished).toHaveBeenCalled())
  expect(result.validate).toHaveBeenCalledExactlyOnceWith('Answer', [{ name: 'read', ok: true }])
  expect(result.finished).toHaveBeenCalledWith(expect.objectContaining({ turnLimit: true }))
})
it('validates an empty final answer and keeps cutoff information', async () => {
  const result = run([cb => { cb.onStopReason?.('max_tokens'); cb.onDone() }])
  await vi.waitFor(() => expect(result.finished).toHaveBeenCalled())
  expect(result.validate).toHaveBeenCalledExactlyOnceWith('', [])
  expect(result.finished).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }))
})
it('does not publish a late validation result after reset', async () => {
  let finish!: () => void
  const result = run([answer()], { validateResponse: () => new Promise<void>(resolve => { finish = resolve }) })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  result.loop.reset(); finish(); await new Promise(resolve => setTimeout(resolve, 0))
  expect(result.finished).not.toHaveBeenCalled(); expect(result.error).not.toHaveBeenCalled()
})
it('batches independent reads while retaining result order and serial mutation barriers', async () => {
  const started: string[] = [], releases = new Map<string, () => void>(), requests: any[] = [], done = vi.fn()
  let turn = 0
  const loop = new AgentLoop({ transport: { stream(request, cb) {
    requests.push(request); queueMicrotask(() => {
      if (!turn++) for (const id of ['a', 'b', 'write', 'c']) cb.onToolCall({ id, name: id === 'write' ? 'write' : 'read', input: {} })
      else cb.onDelta('Done')
      cb.onDone()
    }); return { cancel() {} }
  } }, skill: { id: 'parallel', systemPrompt: '', tools: ['read', 'write'].map(name => ({ name, description: '', inputSchema: {} })),
    canExecuteParallel: call => call.name === 'read', async executeTool(call) {
      started.push(call.id)
      await new Promise<void>(resolve => releases.set(call.id, resolve))
      return { output: call.id, summary: call.id, mutated: call.name === 'write' }
    } }, events: { onDone: done } })
  loop.run('Read then write')
  await vi.waitFor(() => expect(started).toEqual(['a', 'b']))
  releases.get('b')!(); await Promise.resolve(); expect(started).toEqual(['a', 'b'])
  releases.get('a')!(); await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'write']))
  releases.get('write')!(); await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'write', 'c']))
  releases.get('c')!(); await vi.waitFor(() => expect(done).toHaveBeenCalled())
  expect(requests[1].messages.find((message: any) => message.role === 'tool').results.map((result: any) => result.id)).toEqual(['a', 'b', 'write', 'c'])
})
