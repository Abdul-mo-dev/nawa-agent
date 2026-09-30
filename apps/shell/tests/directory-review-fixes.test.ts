import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DirectoryActionManager, type ActionDependencies } from '../src/main/directory-actions/manager'
import { analyticsSkill } from '../src/renderer/src/analytics/skill'
import { directoryRoute, routedDirectorySkill } from '../src/renderer/src/directory-actions/routing'
import { createDirectorySkill } from '../src/renderer/src/ai/directory-skill'
import { directoryInspectionSkill } from '../src/renderer/src/directory-actions/inspection-skill'
import { analyticsSkill } from '../src/renderer/src/analytics/skill'
import { myAgentKnowledgeSkill, prepareMyAgentKnowledgeSkill } from '../src/renderer/src/rag/myagent-skill'
import { DirectoryActionClient, ApprovalController, directoryMutationSkill } from '../src/renderer/src/directory-actions/controller'
import { actionClaimCorrection, historyCandidates, restoreCompletedHistory } from '../src/renderer/src/directory-actions/evidence'
import { activityFacts } from '../src/renderer/src/directory-actions/activity'
import type { HistoryMessage } from '../src/shared/conversation-api'
import type { DirectoryActionsApi } from '../src/shared/directory-actions-api'

let root: string, file: string, other: string, manager: DirectoryActionManager, run: string, deps: ActionDependencies
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nawa-review-')); file = join(root, 'report.txt'); other = join(root, 'unselected.txt')
  await writeFile(file, 'x'.repeat(14000) + 'end'); await writeFile(other, 'unselected')
  deps = { roots: async () => [root], stateDirectory: root, extract: path => readFile(path, 'utf8'),
    readText: async (path, max, offset) => { const text = await readFile(path, 'utf8'); return { ok: true, text: text.slice(offset, offset + max), totalChars: text.length, offset } },
    blank: vi.fn(), open: vi.fn(), assertClosed: vi.fn(), trash: vi.fn(), changed: vi.fn() }
  manager = new DirectoryActionManager(deps); run = await manager.begin(1, { opened: root, files: [file], directories: [] })
})
afterEach(async () => { await manager.cancelOwner(1); await rm(root, { recursive: true, force: true }) })
it('keeps button consent scoped to its run and forwards only fully described table generations for export', async () => {
  deps.analytics = vi.fn().mockImplementation(async (_owner, _paths, action) => ({ value: action === 'describe' ? { id: 'table', generation: 'draft', totalColumns: 3, policy: { columns: [{}, {}] } } : {}, sources: [] }))
  await expect(manager.analyticsData(1, run, 'export-sqlite', {})).rejects.toThrow('Prepare & export')
  run = await manager.begin(1, { opened: root, files: [file], directories: [], prepareTables: true })
  await manager.analyticsData(1, run, 'describe', { datasetId: 'table', columnOffset: 0 })
  await manager.analyticsData(1, run, 'export-sqlite', {})
  expect(deps.analytics).toHaveBeenLastCalledWith(1, [file], 'export-sqlite', {}, expect.any(AbortSignal), { folder: root, reviewedDatasets: [] })
  await manager.analyticsData(1, run, 'describe', { datasetId: 'table', columnOffset: 1 })
  await manager.analyticsData(1, run, 'export-sqlite', {})
  expect(deps.analytics).toHaveBeenLastCalledWith(1, [file], 'export-sqlite', {}, expect.any(AbortSignal), { folder: root, reviewedDatasets: [{ datasetId: 'table', generation: 'draft' }] })
  run = await manager.begin(1, { opened: root, files: [file], directories: [] })
  await expect(manager.analyticsData(1, run, 'export-sqlite', {})).rejects.toThrow('Prepare & export')
})
it('guides a premature multi-table export through the manager review ledger before publishing once', async () => {
  run = await manager.begin(1, { opened: root, files: [file], directories: [], prepareTables: true })
  const ids = ['files', 'data', 'budget']
  const exported = vi.fn()
  deps.analytics = vi.fn(async (_owner, _paths, action, payload, _signal, preparation) => {
    if (action === 'prepare') return { value: { preparation: { draftsPrepared: 3 } }, sources: [] }
    if (action === 'discover') return { value: { datasets: ids.map(id => ({ id, generation: 'draft', name: id, status: 'needs-review' })), nextOffset: null }, sources: [] }
    if (action === 'describe') {
      const id = (payload as { datasetId: string }).datasetId
      return { value: { id, generation: 'draft', totalColumns: 2, policy: { columns: [{ id: 'c0' }, { id: 'c1' }] } },
        sources: [{ path: file, hash: 'source-hash', datasetId: id, generation: 'draft' }] }
    }
    if (action === 'export-sqlite') {
      exported(preparation?.reviewedDatasets)
      return { value: { databasePath: join(root, 'tables.sqlite3') }, sources: [] }
    }
    throw new Error(`Unexpected ${action}`)
  })
  const skill = analyticsSkill({ analytics: (action, payload) => manager.analyticsData(1, run, action, payload), cancel: vi.fn() }, { prepareExport: true })
  await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
  for (const [index, id] of ids.entries()) {
    const result = await skill.executeTool({ id: String(index), name: 'export_sqlite', input: {} })
    expect(JSON.parse(result.output)).toMatchObject({ status: 'review-required', datasetId: id })
    expect(exported).not.toHaveBeenCalled()
  }
  expect(JSON.parse((await skill.executeTool({ id: 'export', name: 'export_sqlite', input: {} })).output).databasePath).toBe(join(root, 'tables.sqlite3'))
  expect(exported).toHaveBeenCalledExactlyOnceWith(ids.map(datasetId => ({ datasetId, generation: 'draft' })))
})
it('advances discovery evidence only for trusted policy publication and then allows native calculation', async () => {
  const previous = { path: file, hash: 'source-hash', datasetId: 'table', generation: 'draft' }
  const current = { ...previous, generation: 'applied' }
  deps.analytics = vi.fn().mockResolvedValueOnce({ value: {}, sources: [previous] }).mockResolvedValueOnce({ value: { readyTables: 1 }, sources: [current], policyChanges: [{ datasetId: 'table', previousGeneration: 'draft', generation: 'applied', sourceHash: 'source-hash' }] }).mockResolvedValueOnce({ value: { total: '30' }, sources: [current] })
  await manager.analyticsData(1, run, 'discover', {})
  expect(await manager.analyticsData(1, run, 'prepare', {})).toEqual({ readyTables: 1 })
  expect(await manager.analyticsData(1, run, 'query', { datasetIds: ['table'] })).toEqual({ total: '30' })
})
it('rejects unexplained analytical revisions and changed source hashes even with a policy transition', async () => {
  const previous = { path: file, hash: 'original', datasetId: 'table', generation: 'draft' }
  deps.analytics = vi.fn().mockResolvedValueOnce({ value: {}, sources: [previous] }).mockResolvedValueOnce({ value: {}, sources: [{ ...previous, generation: 'unexplained' }] }).mockResolvedValueOnce({ value: {}, sources: [{ ...previous, hash: 'changed', generation: 'applied' }], policyChanges: [{ datasetId: 'table', previousGeneration: 'draft', generation: 'applied', sourceHash: 'changed' }] })
  await manager.analyticsData(1, run, 'discover', {})
  await expect(manager.analyticsData(1, run, 'prepare', {})).rejects.toThrow('revisions changed')
  await expect(manager.analyticsData(1, run, 'prepare', {})).rejects.toThrow('revisions changed')
})
it('stops policy writes before execution after numerical results have been used', async () => {
  deps.analytics = vi.fn().mockResolvedValue({ value: { total: '30' }, sources: [{ path: file, hash: 'source', datasetId: 'table', generation: 'approved' }] })
  await manager.analyticsData(1, run, 'query', { datasetIds: ['table'] })
  await expect(manager.analyticsData(1, run, 'prepare', {})).rejects.toThrow('Start a new request')
  await expect(manager.analyticsData(1, run, 'propose-policy', {})).rejects.toThrow('Start a new request')
  expect(deps.analytics).toHaveBeenCalledTimes(1)
})
it('pages plain text beyond 12000 characters and rejects changed evidence at final validation', async () => {
  const first = await manager.readFile(1, run, file)
  expect(first).toMatchObject({ end: 12000, total: 14003, nextOffset: 12000 })
  const second = await manager.readFile(1, run, file, first.nextOffset!)
  expect(second.untrustedDocumentText).toBe('x'.repeat(2000) + 'end'); expect(second.nextOffset).toBeNull()
  expect((await manager.validateEvidence(1, run)).evidence).toEqual([{ path: file, hash: first.sourceHash }])
  await writeFile(file, 'changed')
  await expect(manager.validateEvidence(1, run)).rejects.toThrow('source changed')
})
it('denies unselected reads, changed sources during extraction, and stale run authority', async () => {
  await expect(manager.readFile(1, run, other)).rejects.toThrow('Select')
  deps.readText = async path => { await writeFile(path, 'modified while reading'); return { ok: true, text: 'old' } }
  await expect(manager.readFile(1, run, file)).rejects.toThrow('changed while reading')
  await manager.cancel(1, run)
  await expect(manager.readFile(1, run, file)).rejects.toThrow('expired')
})
it('restores only receipts with current source versions; unrelated files do not invalidate them', async () => {
  await manager.readFile(1, run, file)
  const receipt = await manager.validateEvidence(1, run)
  run = await manager.begin(1, { opened: root, files: [file], directories: [] })
  await writeFile(other, 'unrelated change')
  expect(await manager.restoreEvidence(1, run, [{ id: 'previous', evidence: receipt.evidence }])).toEqual(['previous'])
  await writeFile(file, 'new version')
  run = await manager.begin(1, { opened: root, files: [file], directories: [] })
  expect(await manager.restoreEvidence(1, run, [{ id: 'previous', evidence: receipt.evidence }])).toEqual([])
})
it('searches only the requested selected subset and rejects broadened search targets', async () => {
  deps.search = vi.fn().mockResolvedValue({ hits: [], total: 0, warnings: [] })
  await manager.searchContents(1, run, 'needle', [file])
  expect(deps.search).toHaveBeenCalledWith(1, [file], 'needle', expect.any(AbortSignal))
  await expect(manager.searchContents(1, run, 'needle', [other])).rejects.toThrow('selected')
})
it('never restores intermediate, failed, incomplete, or legacy messages as successful pairs', () => {
  const msg = (id: string, phase: 'user' | 'intermediate' | 'final', outcome: 'completed' | 'failed' | 'incomplete'): HistoryMessage => ({ id: id + phase, role: phase === 'user' ? 'user' : 'assistant', text: phase, createdAt: 1, contextKey: 'scope', request: { id, phase, outcome, evidence: [] } })
  const messages = [msg('ok', 'user', 'completed'), msg('ok', 'intermediate', 'completed'), msg('ok', 'final', 'completed'),
    msg('failed', 'user', 'failed'), msg('failed', 'final', 'failed'), msg('partial', 'final', 'incomplete'), { id: 'old', role: 'assistant' as const, text: 'Legacy unverified', createdAt: 1 }]
  expect(historyCandidates(messages, 'scope').map(r => r.id)).toEqual(['ok'])
  expect(restoreCompletedHistory(messages, 'scope', ['ok', 'failed', 'partial'])).toEqual([{ role: 'user', text: 'user' }, { role: 'assistant', text: 'final' }])
})
it('uses a small metadata tool set and activates editing only through explicit discovery', async () => {
  const scope = { opened: root, files: [file], directories: [] }, client = {} as DirectoryActionClient
  const parts = { reader: createDirectorySkill({ selection: scope, api: {} as any }), inspection: directoryInspectionSkill(client, scope), analytics: analyticsSkill(client), knowledge: myAgentKnowledgeSkill(client), mutation: directoryMutationSkill(client, scope) }
  const route = directoryRoute('list files in this directory', scope), skill = routedDirectorySkill(route, parts)
  expect(route.prepareKnowledge).toBe(false)
  expect(skill.tools.map(t => t.name)).toEqual(['list_directory', 'list_files', 'search_files', 'discover_file_tools'])
  expect(skill.systemPrompt).not.toContain('decimal accounting')
  await skill.executeTool({ id: 'activate', name: 'discover_file_tools', input: { capability: 'editing' } })
  expect(skill.tools.some(t => t.name === 'update_file')).toBe(true)
  expect((await skill.executeTool({ id: 'bad', name: 'query_data', input: {} })).isError).toBe(true)
})
it('identifies an unambiguous workbook typo and keeps unrelated-file questions out of metadata routing', () => {
  const workbook = join(root, 'employee-data.xlsx'), scope = { opened: root, files: [workbook, file], directories: [] }
  expect(directoryRoute('how many employees in employee-date.xlsx', scope)).toMatchObject({ intent: 'table', target: workbook })
  expect(directoryRoute('list files containing Hollie Parker', scope).intent).not.toBe('metadata')
})
it('skips optional preparation and reports disabled integration without a failure state', async () => {
  const client = { myAgentTools: vi.fn(), cancel: vi.fn() }
  expect((await prepareMyAgentKnowledgeSkill(client, 'list files', false)).preparation.status).toBe('not-needed')
  expect(client.myAgentTools).not.toHaveBeenCalled()
  client.myAgentTools.mockResolvedValue({ available: false, disabled: true, tools: [], sources: [], warnings: [], total: 0, nextOffset: null })
  expect((await prepareMyAgentKnowledgeSkill(client, 'read')).preparation.status).toBe('disabled')
})
it('keeps coverage, result identity and HTTP diagnostics when raw output is large', () => {
  const facts = activityFacts({ content: JSON.stringify({ text: 'x'.repeat(50000), resultId: 'result', Truncated: true, rows: [1] }),
    coverage: { selected: 101, requested: [file], covered: [file], completeSelection: false }, diagnostics: { httpRequests: 1, durationMs: 10 }, warnings: ['Partial coverage'] })
  expect(facts).toMatchObject({ resultId: 'result', Truncated: true, returnedRows: 1, coverage: { selected: 101, requested: 1, covered: 1, completeSelection: false }, diagnostics: { httpRequests: 1 } })
  expect(JSON.stringify(facts)).not.toContain('xxxxx')
})
it('returns a structured decline, prevents retries, and rejects an unsupported save claim', async () => {
  const approvals = new ApprovalController(), api = { begin: vi.fn().mockResolvedValue('run'), cancel: vi.fn(),
    validateEvidence: vi.fn().mockResolvedValue({ evidence: [], durationMs: 0, sourceCount: 0 }),
    propose: vi.fn().mockResolvedValue({ id: 'proposal', path: file, operation: 'delete' }), discard: vi.fn().mockResolvedValue(undefined), commit: vi.fn() }
  const client = new DirectoryActionClient({ api: api as unknown as DirectoryActionsApi, selection: { opened: root, files: [file], directories: [] }, approvals, transport: vi.fn(), current: () => true, activity: vi.fn(), committed: vi.fn() })
  approvals.subscribe(() => { const view = approvals.getSnapshot(); if (view) approvals.decide(view.key, false) })
  const request = { operation: 'delete' as const, path: file, instruction: 'Delete fixture' }
  expect(JSON.parse(await client.perform(request)).status).toBe('declined')
  expect(JSON.parse(await client.perform(request)).status).toBe('declined')
  expect(api.propose).toHaveBeenCalledOnce(); expect(api.commit).not.toHaveBeenCalled()
  await expect(client.validateEvidence('I deleted the file.')).rejects.toThrow('No file commit receipt')
  expect(client.actionCorrection('No changes were saved.')).toBeNull()
})
it('does not use a commit for one target or operation to justify another claimed action', () => {
  const receipts = [{ operation: 'update' as const, path: file }]
  expect(actionClaimCorrection(`I updated ${file}.`, receipts, [file, other])).toBeNull()
  expect(actionClaimCorrection(`I updated ${other}.`, receipts, [file, other])).toContain('No file commit receipt')
  expect(actionClaimCorrection('I deleted the file.', receipts)).toContain('No file commit receipt')
})
it('batches history verification and stops retrying when the server is unavailable', async () => {
  const hash = (await manager.readFile(1, run, file)).sourceHash
  const secondHash = (await import('../src/main/directory-actions/file-safety')).hashFile
  const remote = (path: string, contentHash: string, documentId: string) => ({ path, hash: contentHash, myAgent: { path, contentHash, server: 'http://localhost:5187', documentId, indexRevision: '1', datasetRevision: null } })
  const evidence = [remote(file, hash, 'one'), remote(other, await secondHash(other), 'two')]
  run = await manager.begin(1, { opened: root, files: [file, other], directories: [] })
  deps.myAgentTools = vi.fn().mockRejectedValue(new Error('offline'))
  expect(await manager.restoreEvidence(1, run, [{ id: 'one', evidence: [evidence[0]] }, { id: 'two', evidence: [evidence[1]] }])).toEqual([])
  expect(deps.myAgentTools).toHaveBeenCalledOnce()
  expect(deps.myAgentTools).toHaveBeenCalledWith([file, other], run, 'verify', { sources: evidence.map(source => source.myAgent) }, expect.any(AbortSignal))
})
it('restores citation links only for accepted history with a matching evidence version', async () => {
  const api = { begin: vi.fn().mockResolvedValue('run'), restoreEvidence: vi.fn().mockResolvedValue(['accepted']) }
  const client = new DirectoryActionClient({ api: api as unknown as DirectoryActionsApi, selection: { opened: root, files: [file], directories: [] }, approvals: new ApprovalController(), transport: vi.fn(), current: () => true, activity: vi.fn(), committed: vi.fn() })
  const hash = 'a'.repeat(64), citation = { id: 'RAG:old', path: file, sourceHash: hash, locator: 'line 1', excerpt: 'verified' }
  await client.restoreEvidence([{ id: 'accepted', evidence: [{ path: file, hash }], citations: [citation, { ...citation, id: 'RAG:stale', sourceHash: 'b'.repeat(64) }] },
    { id: 'rejected', evidence: [{ path: file, hash }], citations: [{ ...citation, id: 'RAG:rejected' }] }])
  expect(client.citationSnapshot()).toEqual([citation])
})
