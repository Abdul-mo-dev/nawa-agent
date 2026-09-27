import { expect, it, vi } from 'vitest'
import type { DirectoryActionsApi, DirectoryInspection } from '../src/shared/directory-actions-api'
import { ApprovalController, DirectoryActionClient } from '../src/renderer/src/directory-actions/controller'
import { directoryInspectionSkill } from '../src/renderer/src/directory-actions/inspection-skill'

function fixture() {
  const path = 'C:\\data\\employees.xlsx'
  const context = 'Active sheet data area: A1:F1001 (answer data-size questions directly from this — do not tally block by block with read_range)'
  const description: DirectoryInspection = { id: 'inspection', path, sourceHash: 'saved-hash', source: 'saved-file-snapshot', openedAt: 1,
    kind: 'sheets', systemPrompt: 'Native editor', context, tools: [
      { name: 'get_workbook_context', description: 'Answer from the data extent.', inputSchema: {} },
      { name: 'read_range', description: 'Infer record count from get_workbook_context.', inputSchema: {} },
      { name: 'aggregate_range', description: 'Count non-empty and distinct values.', inputSchema: {} },
    ] }
  const api = { begin: vi.fn().mockResolvedValue('run'), inspect: vi.fn().mockResolvedValue(description),
    query: vi.fn().mockResolvedValue({ output: context, summary: 'Read workbook info', mutated: false }),
    searchContents: vi.fn(), cancel: vi.fn() }
  const selection = { opened: 'C:\\data', files: [path], directories: [] }
  const client = new DirectoryActionClient({ api: api as unknown as DirectoryActionsApi, selection,
    approvals: new ApprovalController(), transport: vi.fn(), current: () => true, activity: vi.fn(), committed: vi.fn() })
  return { api, client, skill: directoryInspectionSkill(client, selection), description, path }
}

it('separates workbook bounds from record counts in both inspection discovery and query results', async () => {
  const { skill, description, path } = fixture()
  const inventory = await skill.executeTool({ id: 'open', name: 'inspect_file', input: { path } })
  const parsed = JSON.parse(inventory.output)
  expect(parsed.sourceHash).toBe('saved-hash')
  expect(parsed.context).toContain('A1:F1001')
  expect(parsed.context).toContain('not employee, record, non-empty or distinct counts')
  expect(parsed.context).not.toContain('answer data-size questions directly')
  expect(parsed.tools.find((tool: { name: string }) => tool.name === 'get_workbook_context').description).not.toContain('Answer from the data extent')
  expect(parsed.tools.find((tool: { name: string }) => tool.name === 'aggregate_range')).toEqual(description.tools[2])
  const queried = await skill.executeTool({ id: 'read', name: 'query_file', input: { inspectionId: 'inspection', tool: 'get_workbook_context', arguments: {} } })
  expect(queried.output).toContain('worksheet bounds only')
  expect(queried.output).toContain('aggregate_range')
  expect(queried.output).not.toContain('answer data-size questions directly')
  // The opened-file editor's descriptor is not mutated by the directory adapter.
  expect(description.context).toContain('answer data-size questions directly')
})

it('preserves an actual aggregate that differs from the worksheet dimensions', async () => {
  const { skill, api, path } = fixture()
  await skill.executeTool({ id: 'open', name: 'inspect_file', input: { path } })
  const output = JSON.stringify({ range: 'A2:A1001', nonEmptyCount: 500, distinctCount: 490, complete: true })
  api.query.mockResolvedValueOnce({ output, summary: 'Aggregated IDs', mutated: false })
  const result = await skill.executeTool({ id: 'count', name: 'query_file', input: { inspectionId: 'inspection', tool: 'aggregate_range', arguments: { range: 'A2:A1001' } } })
  expect(JSON.parse(result.output.split('\n')[0])).toEqual({ range: 'A2:A1001', nonEmptyCount: 500, distinctCount: 490, complete: true })
  expect(result.output).toContain('Source citation:')
  expect(result.mutated).toBe(false)
  expect(api.query.mock.calls.at(-1)?.[2]).toMatchObject({ name: 'aggregate_range', input: { range: 'A2:A1001' } })
})

it('reports retrieved candidate files without asserting exact matches for semantic hits', async () => {
  const { skill, api, path } = fixture()
  api.searchContents.mockResolvedValue({ backend: 'myagent', hits: [
    { path, excerpt: 'Exact name appears here.' }, { path, excerpt: 'A neighboring chunk.' },
    { path: 'C:\\data\\other.xlsx', excerpt: 'Semantically similar text.' },
  ], total: 2, warnings: ['Not exhaustive.'] })
  const result = await skill.executeTool({ id: 'search', name: 'search_contents', input: { query: 'A name' } })
  expect(result.summary).toBe('MyAgent search: 2 candidate files')
  expect(JSON.parse(result.output).warnings).toEqual(['Not exhaustive.'])
})
