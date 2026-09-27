import { expect, it, vi } from 'vitest'
import { myAgentKnowledgeSkill, prepareMyAgentKnowledgeSkill } from '../src/renderer/src/rag/myagent-skill'

it('discovers schemas on demand, invokes the bridge and preserves evidence and failure status', async () => {
  const client = { myAgentTools: vi.fn(), cancel: vi.fn() }, skill = myAgentKnowledgeSkill(client)
  expect(skill.tools.map(v => v.name)).toEqual(['discover_knowledge_tools', 'use_knowledge_tool'])
  client.myAgentTools.mockResolvedValueOnce({ available: true, tools: [{ name: 'pdf_read_pages' }], sources: [{ path: 'a.pdf' }], nextOffset: 8 })
  const catalog = await skill.executeTool({ id: '1', name: 'discover_knowledge_tools', input: { query: 'pdf' } })
  expect(client.myAgentTools).toHaveBeenLastCalledWith('catalog', { scope: 'selected', query: 'pdf' })
  expect(JSON.parse(catalog.output)).toMatchObject({ nextOffset: 8, sources: [{ path: 'a.pdf' }] })
  client.myAgentTools.mockResolvedValueOnce({ tool: 'pdf_read_pages', succeeded: false, content: '', error: 'Unavailable', sources: [] })
  const result = await skill.executeTool({ id: '2', name: 'use_knowledge_tool', input: { tool: 'pdf_read_pages', arguments: { pages: [2] } } })
  expect(result).toMatchObject({ isError: true, mutated: false })
  expect(result.output).toContain('Unavailable')
})

it('preloads the server-selected bundle and routes direct calls with explicit targets', async () => {
  const client = { myAgentTools: vi.fn().mockResolvedValueOnce({ available: true, tools: [], initialTools: [
    { name: 'spreadsheet_query_sql', description: 'SQL', inputSchema: { type: 'object', additionalProperties: false, properties: { sql: { type: 'string' } }, required: ['sql'] } },
  ], files: [{ path: 'ready.xlsx', status: 'ready', documentId: 'doc' }, { path: 'missing.xlsx', status: 'needs-index' }], sources: [], warnings: [] }), cancel: vi.fn() }
  const skill = await prepareMyAgentKnowledgeSkill(client, 'Count rows')
  expect(client.myAgentTools).toHaveBeenCalledWith('catalog', { scope: 'selected', initial: true, task: 'Count rows' })
  expect(skill.tools.map(tool => tool.name)).toEqual(['spreadsheet_query_sql', 'discover_knowledge_tools', 'use_knowledge_tool'])
  expect(skill.preparation).toMatchObject({ available: true, loadedTools: 1, warnings: [] })
  expect(skill.tools[0].inputSchema).toMatchObject({ additionalProperties: false, required: ['sql'], properties: { sql: { type: 'string' }, _nawaFiles: { type: 'array' } } })
  expect(skill.buildContext?.()).toContain('needs-index')
  client.myAgentTools.mockResolvedValueOnce({ succeeded: true, tool: 'spreadsheet_query_sql', content: '3', sources: [], warnings: [] })
  const result = await skill.executeTool({ id: 'sql', name: 'spreadsheet_query_sql', input: { sql: 'SELECT COUNT(*) FROM data', _nawaFiles: ['ready.xlsx'] } })
  expect(result.isError).toBe(false)
  expect(client.myAgentTools).toHaveBeenLastCalledWith('execute', { tool: 'spreadsheet_query_sql', arguments: { sql: 'SELECT COUNT(*) FROM data' }, paths: ['ready.xlsx'] })
})

it('keeps the bridge available when automatic preparation fails, without pretending tools were loaded', async () => {
  const client = { myAgentTools: vi.fn().mockRejectedValue(new Error('Server offline')), cancel: vi.fn() }
  const skill = await prepareMyAgentKnowledgeSkill(client, 'Read this file')
  expect(skill.tools.map(tool => tool.name)).toEqual(['discover_knowledge_tools', 'use_knowledge_tool'])
  expect(skill.buildContext?.()).toContain('Server offline')
  expect(skill.preparation).toMatchObject({ available: false, loadedTools: 0, warnings: [expect.stringContaining('Server offline')] })
  expect(skill.systemPrompt).toContain('No MyAgent tools were preloaded')
})
it('cancels in-flight calls and rejects late results', async () => {
  const abort = new AbortController(), client = { myAgentTools: vi.fn(async () => { abort.abort(); return { available: true, tools: [], sources: [], warnings: [], total: 0, nextOffset: null } }), cancel: vi.fn() }
  const result = await myAgentKnowledgeSkill(client).executeTool({ id: '1', name: 'discover_knowledge_tools', input: {} }, abort.signal)
  expect(client.cancel).toHaveBeenCalledOnce(); expect(result.isError).toBe(true)
})
it('returns a compact names-only list as metadata and reports the correct count', async () => {
  const client = { myAgentTools: vi.fn().mockResolvedValue({ available: true, tools: [], names: ['pdf_read_pages', 'spreadsheet_query_sql'], sources: [], scopeChecked: false, nextOffset: null }), cancel: vi.fn() }
  const result = await myAgentKnowledgeSkill(client).executeTool({ id: '1', name: 'discover_knowledge_tools', input: { scope: 'server', namesOnly: true } })
  expect(client.myAgentTools).toHaveBeenCalledWith('catalog', { scope: 'server', namesOnly: true })
  expect(result.summary).toBe('MyAgent: discovered 2 tools')
  expect(JSON.parse(result.output)).toMatchObject({ names: ['pdf_read_pages', 'spreadsheet_query_sql'], sources: [], scopeChecked: false })
  expect(result.isError).toBe(false)
})
