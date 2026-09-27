import { expect, it, vi } from 'vitest'
import type { DirectoryActivity } from '../src/shared/directory-activity'
import { diagnosticText, finishActivity, finishActivityStep, startActivityStep, TextFrameBuffer } from '../src/renderer/src/directory-actions/activity'
import { ApprovalController, DirectoryActionClient } from '../src/renderer/src/directory-actions/controller'
import type { DirectoryActionsApi } from '../src/shared/directory-actions-api'

const trace = (): DirectoryActivity => ({ id: 'run', model: 'model', selectedFiles: 2, startedAt: 1, status: 'running', steps: [], omitted: 0 })
it('keeps a bounded timeline and records failed, completed and interrupted steps', () => {
  let value = trace()
  for (let i = 0; i < 110; i++) value = startActivityStep(value, { id: `tool-${i}`, tool: 'read', kind: 'tool', status: 'running', startedAt: 1, summary: 'Read', targets: [] })
  value = finishActivityStep(value, 'tool-108', 'failed', 'Source changed', 'Refresh the source')
  value = finishActivityStep(value, 'tool-109', 'completed', 'Done')
  value = finishActivity(value, 'cancelled')
  expect(value.omitted).toBe(10); expect(value.steps).toHaveLength(100)
  expect(value.steps.at(-2)).toMatchObject({ status: 'failed', output: 'Refresh the source' })
  expect(value.steps.at(-1)?.status).toBe('completed')
  expect(value.steps[0].status).toBe('cancelled')
})
it('redacts credential fields, bearer tokens, URL credentials and embedded binary data before truncation', () => {
  const result = diagnosticText({ nested: { apiKey: 'dont-store-me', password: 'private-password' }, headers: { Authorization: 'secret-header' },
    content: JSON.stringify({ apiKey: 'nested-json-secret', rows: [99] }),
    error: 'Bearer my-token at https://user:pass@example.com/?api_key=my-key', image: 'data:image/png;base64,abcdeFGH123==' })
  for (const secret of ['dont-store-me', 'private-password', 'secret-header', 'nested-json-secret', 'my-token', 'user:pass', 'my-key', 'abcdeFGH123']) expect(result).not.toContain(secret)
  expect(diagnosticText('x'.repeat(5000))).toHaveLength(2420)
})
it('batches streamed text and flushes exactly once at a turn boundary', () => {
  const publish = vi.fn(), schedule = vi.fn(() => 1), unschedule = vi.fn()
  const buffer = new TextFrameBuffer(publish, schedule, unschedule)
  buffer.push('a'); buffer.push('ab'); buffer.push('abc')
  expect(schedule).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled()
  buffer.flush(); buffer.flush()
  expect(publish).toHaveBeenCalledExactlyOnceWith('abc')
  buffer.push('late'); buffer.discard(); buffer.flush()
  expect(publish).toHaveBeenCalledOnce()
})

function setupClient() {
  const api = { begin: vi.fn().mockResolvedValue('run'), cancel: vi.fn().mockResolvedValue(undefined), myAgentTools: vi.fn() }
  const approvals = new ApprovalController()
  const client = new DirectoryActionClient({ api: api as unknown as DirectoryActionsApi, selection: { opened: null, files: ['C:\\a.txt'], directories: [] },
    approvals, transport: vi.fn(), current: () => true, activity: vi.fn(), committed: vi.fn() })
  return { api, client, approvals }
}
it('deduplicates catalog requests within a run but executes every content call', async () => {
  const { api, client } = setupClient()
  api.myAgentTools.mockResolvedValue({ available: true, tools: [], sources: [], warnings: [], total: 0, nextOffset: null })
  const [first, second] = await Promise.all([
    client.myAgentTools('catalog', { query: 'text', scope: 'selected' }), client.myAgentTools('catalog', { scope: 'selected', query: 'text' }),
  ])
  expect(api.myAgentTools).toHaveBeenCalledOnce(); expect(first).not.toBe(second)
  expect(second).toMatchObject({ cacheHit: true })
  await client.myAgentTools('execute', { tool: 'text_read_lines', arguments: {} })
  await client.myAgentTools('execute', { tool: 'text_read_lines', arguments: {} })
  expect(api.myAgentTools).toHaveBeenCalledTimes(3)
  client.cancel()
  await expect(client.myAgentTools('catalog', { query: 'text', scope: 'selected' })).rejects.toThrow('cancelled')
})
it('does not cache failed or unavailable catalogs, allowing recovery', async () => {
  const { api, client } = setupClient()
  api.myAgentTools.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ available: false, sources: [] }).mockResolvedValue({ available: true, sources: [] })
  await expect(client.myAgentTools('catalog', {})).rejects.toThrow('offline')
  await client.myAgentTools('catalog', {}); await client.myAgentTools('catalog', {})
  expect(api.myAgentTools).toHaveBeenCalledTimes(3)
})
it('rejects a late cached result after cancellation', async () => {
  const { api, client } = setupClient()
  let resolve: (value: unknown) => void = () => {}
  api.myAgentTools.mockImplementation(() => new Promise(done => { resolve = done }))
  const pending = client.myAgentTools('catalog', {})
  await vi.waitFor(() => expect(api.myAgentTools).toHaveBeenCalledOnce())
  client.cancel(); resolve({ available: true, tools: [], sources: [] })
  await expect(pending).rejects.toThrow('cancelled')
})
it('invalidates catalog metadata after an approved file commit', async () => {
  const { api, client, approvals } = setupClient()
  api.myAgentTools.mockResolvedValue({ available: true, tools: [], sources: [], warnings: [], total: 0, nextOffset: null })
  Object.assign(api, { verifyInspections: vi.fn().mockResolvedValue(null), validateEvidence: vi.fn().mockResolvedValue({ evidence: [], sourceCount: 0, durationMs: 0 }),
    propose: vi.fn().mockResolvedValue({ id: 'proposal', path: 'C:\\a.txt', operation: 'delete' }),
    prepare: vi.fn().mockResolvedValue(null), commit: vi.fn().mockResolvedValue({ path: 'C:\\a.txt', operation: 'delete' }), discard: vi.fn().mockResolvedValue(undefined) })
  await client.myAgentTools('catalog', {})
  const unsubscribe = approvals.subscribe(() => { const request = approvals.getSnapshot(); if (request) approvals.decide(request.key, true) })
  await client.perform({ operation: 'delete', path: 'C:\\a.txt', instruction: 'Delete the fixture' }); unsubscribe()
  await client.myAgentTools('catalog', {})
  expect(api.myAgentTools).toHaveBeenCalledTimes(2)
})
