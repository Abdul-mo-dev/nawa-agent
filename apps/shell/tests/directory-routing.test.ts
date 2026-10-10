import { expect, it, vi } from 'vitest'
import { directoryRoute, routedDirectorySkill } from '../src/renderer/src/directory-actions/routing'
import type { AgentSkill } from '@genoffice/agent-core'
import { analyticsSkill } from '../src/renderer/src/analytics/skill'
import { prepareMyAgentKnowledgeSkill } from '../src/renderer/src/rag/myagent-skill'

// Keep spreadsheets selected: a routing miss would otherwise load MyAgent tools.
const scope = {
  opened: 'C:\\sample files',
  files: ['C:\\sample files\\employee-data.xlsx', 'C:\\sample files\\notes.txt'],
  directories: [],
}

it.each([
  'prepare these tables for analysis',
  'prepare employee-data.xlsx for native analysis',
  'help with data preparation',
  'analysis preparation for selected files',
])('routes agent preparation to native table tools: %s', (task) => {
  expect(directoryRoute(task, scope)).toMatchObject({ intent: 'reviewed', prepareKnowledge: false })
})

it.each([
  'give me data insights from the selected files',
  'analyze employee-data.xlsx',
  'analyse the selected files',
  'calculate descriptive statistics for this big workbook',
  'show the median and standard deviation of salary',
  'find outliers and trends in employee-data.xlsx',
  'check the distribution of salaries',
])(
  'routes insights and statistics to local analysis without eager server discovery: %s',
  (task) => {
    expect(directoryRoute(task, scope)).toMatchObject({
      intent: 'analysis',
      prepareKnowledge: false,
    })
  },
)

it.each(['records.json', 'records.jsonl', 'records.ndjson'])(
  'enables full-table calculation for streaming data files: %s',
  (file) => {
    const selected = { ...scope, files: [`C:\\sample files\\${file}`] }
    expect(directoryRoute('count records grouped by region', selected)).toMatchObject({
      intent: 'table',
      prepareKnowledge: false,
    })
  },
)

it('does not treat an analytical word in a selected filename as an insights request', () => {
  expect(
    directoryRoute('find Hollie Parker in statistics.csv', {
      ...scope,
      files: ['C:\\sample files\\statistics.csv'],
    }).intent,
  ).toBe('lookup')
})

it.each([
  'count employees in employee-data.xlsx',
  'calculate correlation in employee-data.xlsx',
  'give me data insights',
])('keeps existing inspection available alongside analysis: %s', (task) => {
  const part = (names: string[]): AgentSkill => ({
    id: names[0],
    systemPrompt: '',
    tools: names.map((name) => ({ name, description: '', inputSchema: {} })),
    executeTool: () => ({ output: '{}', summary: 'done' }),
  })
  const skill = routedDirectorySkill(directoryRoute(task, scope), {
    reader: part(['list_files', 'read_file']),
    inspection: part(['inspect_file', 'query_file']),
    analytics: analyticsSkill({ analytics: async () => ({}), cancel: () => {} }),
    knowledge: part(['discover_knowledge_tools', 'use_knowledge_tool', 'spreadsheet_query_sql']),
    mutation: part(['update_file']),
  })
  const names = skill.tools.map((tool) => tool.name)
  expect(names).toEqual(
    expect.arrayContaining([
      'read_file',
      'inspect_file',
      'query_file',
      'prepare_data',
      'describe_dataset',
      'query_data',
      'analyze_data',
    ]),
  )
  expect(names).not.toContain('update_file')
  expect(names.some((name) => /export/.test(name))).toBe(false)
})

it('can inspect, prepare and calculate statistics without contacting MyAgent', async () => {
  const task = 'give me insights and statistics for employee-data.xlsx',
    route = directoryRoute(task, scope)
  const knowledgeClient = {
    myAgentTools: vi.fn().mockRejectedValue(new Error('Server offline')),
    cancel: vi.fn(),
  }
  const knowledge = await prepareMyAgentKnowledgeSkill(
    knowledgeClient,
    task,
    route.prepareKnowledge,
  )
  expect(knowledge.preparation.status).toBe('not-needed')
  const nativeRead = vi.fn(async () => ({
    output: '{"columns":["id","salary"]}',
    summary: 'Inspected saved source',
  }))
  const client = {
    analytics: vi.fn(async (action: string) => {
      if (action === 'prepare')
        return { preparation: { approvedTables: 1, readyTables: 1, draftTables: 0 } }
      if (action === 'describe')
        return {
          id: 'employees',
          rows: 1000000,
          policy: {
            grain: 'One employee',
            columns: [{ id: 'c1', name: 'salary', type: 'decimal' }],
          },
        }
      if (action === 'analyze')
        return { resultId: 'stats-receipt', coverage: { rows: 1000000 }, mean: '250000' }
      throw new Error(`Unexpected action: ${action}`)
    }),
    cancel: vi.fn(),
  }
  const empty: AgentSkill = {
    id: 'empty',
    systemPrompt: '',
    tools: [],
    executeTool: () => ({ output: '{}', summary: '' }),
  }
  const skill = routedDirectorySkill(route, {
    reader: empty,
    knowledge,
    mutation: empty,
    inspection: {
      id: 'inspection',
      systemPrompt: '',
      tools: [{ name: 'inspect_file', description: '', inputSchema: {} }],
      executeTool: nativeRead,
    },
    analytics: analyticsSkill(client),
  })
  await skill.executeTool({ id: 'inspect', name: 'inspect_file', input: { path: scope.files[0] } })
  const prepared = await skill.executeTool({
    id: 'prepare',
    name: 'prepare_data',
    input: { paths: [scope.files[0]] },
  })
  expect(prepared.isError).not.toBe(true)
  await skill.executeTool({
    id: 'schema',
    name: 'describe_dataset',
    input: { datasetId: 'employees' },
  })
  const result = await skill.executeTool({
    id: 'stats',
    name: 'analyze_data',
    input: { datasetIds: ['employees'], method: 'describe', column: 'c1' },
  })
  expect(JSON.parse(result.output)).toMatchObject({
    resultId: 'stats-receipt',
    coverage: { rows: 1000000 },
  })
  expect(nativeRead).toHaveBeenCalledTimes(1)
  expect(client.analytics.mock.calls.map(([action]) => action)).toEqual([
    'prepare',
    'describe',
    'analyze',
  ])
  expect(knowledgeClient.myAgentTools).not.toHaveBeenCalled()
})

it('preserves native preparation verification through the directory router', async () => {
  const empty: AgentSkill = {
    id: 'empty',
    systemPrompt: '',
    tools: [],
    executeTool: () => ({ output: '{}', summary: '' }),
  }
  const analytics = analyticsSkill({
    analytics: async () => ({ preparation: { draftsPrepared: 3 } }),
    cancel: () => {},
  })
  const skill = routedDirectorySkill(
    directoryRoute('Prepare these tables for native analysis', scope),
    { reader: empty, inspection: empty, analytics, knowledge: empty, mutation: empty },
  )
  await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
  expect(
    skill.verifyResponse?.('No table policies have been drafted yet.', [
      { name: 'prepare_data', ok: true },
    ]),
  ).toContain('3 validated policy drafts')
})

it('reports reused Ready tables without claiming that review drafts are pending', async () => {
  const skill = analyticsSkill({
    analytics: async () => ({
      preparation: {
        approvedTables: 0,
        alreadyReady: 1,
        readyTables: 1,
        draftTables: 0,
        reviewTables: 0,
        blockedTables: 0,
      },
    }),
    cancel: () => {},
  })
  const result = await skill.executeTool({ id: 'prepare', name: 'prepare_data', input: {} })
  expect(result.summary).toBe('Selected tables are ready for native analysis')
})

it.each([
  'list file in this dir',
  'list files in this dir',
  'list file in this directory',
  'list files in current folder',
  'list all the files in this dir',
  'please show me the files in the current directory',
  'could you list the file names here, please?',
  'LIST  FILE\nIN THIS DIR!!!',
  'show selected files',
  'list filenames',
  'list dirs',
  'list directories in this folder',
  'show me files and folders in this directory',
  'what files are in this dir?',
  'which folders are in the opened directory?',
  'what’s in this folder?',
  'what is in this directory',
  'give me a list of files here',
])('routes a filename-only listing without MyAgent preparation: %s', (task) => {
  expect(directoryRoute(task, scope)).toMatchObject({
    intent: 'metadata',
    prepareKnowledge: false,
    maxTurns: 12,
  })
})

it.each([
  'list files containing Hollie Parker',
  'list file in this dir containing Hollie Parker',
  'list files in this dir and count employees',
  'show files in this folder with overdue invoices',
  'list files and summarize their contents',
  'what is in employee-data.xlsx?',
  'show file contents',
  'list directories mentioned in notes.txt',
])('does not mistake content or combined work for a metadata-only listing: %s', (task) => {
  const route = directoryRoute(task, scope)
  expect(route.intent).not.toBe('metadata')
  expect(route.prepareKnowledge).toBe(route.intent === 'overview')
})

it.each([
  'Why did Q2 revenue fall?',
  'What drove the decline in sales?',
  'Explain the change in revenue this quarter',
])('routes a quantitative explanation to calculation and document search: %s', (task) => {
  const route = directoryRoute(task, scope)
  expect(route).toMatchObject({ intent: 'analysis', prepareKnowledge: false })
  const part = (names: string[]): AgentSkill => ({
    id: names[0],
    systemPrompt: '',
    tools: names.map((name) => ({ name, description: '', inputSchema: {} })),
    executeTool: () => ({ output: '{}', summary: 'done' }),
  })
  const skill = routedDirectorySkill(route, {
    reader: part(['list_files', 'read_file']),
    inspection: part(['search_contents', 'inspect_file']),
    analytics: part(['discover_datasets', 'query_data']),
    knowledge: part(['discover_knowledge_tools']),
    mutation: part(['update_file']),
  })
  expect(skill.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['search_contents', 'discover_datasets', 'query_data']),
  )
  expect(skill.tools.some((tool) => tool.name === 'discover_knowledge_tools')).toBe(false)
  expect(skill.systemPrompt).toContain(
    'If the selected evidence does not explain the change, say its cause is unknown.',
  )
})

const survey = 'C:\\sample files\\Survey data.xlsx',
  overviewScope = { ...scope, files: [...scope.files, survey] }
it.each([
  'what is Survey data.xlsx about',
  'What does "Survey data.xlsx" contain?',
  'please describe Survey data.xlsx',
  'Could you give me an overview of `Survey data.xlsx`, please?',
  'tell me about Survey data.xlsx',
  'what is in Survey data.xlsx?',
  'summarize the structure of Survey data.xlsx',
  'show me the columns in Survey data.xlsx',
  'what is C:\\sample files\\Survey data.xlsx about?',
])('prepares a named-workbook overview for %s', (task) => {
  expect(directoryRoute(task, overviewScope)).toMatchObject({
    intent: 'overview',
    target: survey,
    prepareKnowledge: true,
  })
})
it('uses a sole workbook for deictic overview questions, but does not guess among multiple files', () => {
  expect(
    directoryRoute("what's this workbook about?", { ...scope, files: [survey] }),
  ).toMatchObject({ intent: 'overview', target: survey })
  expect(directoryRoute("what's this workbook about?", overviewScope).intent).not.toBe('overview')
  expect(
    directoryRoute('what is sales totals.xlsx about', {
      ...scope,
      files: ['C:\\sample files\\sales totals.xlsx'],
    }).intent,
  ).toBe('overview')
})
it.each([
  'summarize the survey results in Survey data.xlsx',
  'what is Survey data.xlsx about and how many respondents feel unsafe?',
  'compare Survey data.xlsx and employee-data.xlsx',
  'describe Survey data.xlsx and update its headers',
  'what is unselected.xlsx about',
  'what is notes.txt about',
])(
  'keeps findings, combined work and other files out of the workbook-overview shortcut: %s',
  (task) => {
    expect(directoryRoute(task, overviewScope).intent).not.toBe('overview')
  },
)
it('advertises eight focused tools for an overview and retains native/SQL discovery fallbacks', async () => {
  const part = (names: string[]): AgentSkill => ({
    id: names[0],
    systemPrompt: 'General capability guidance',
    tools: names.map((name) => ({ name, description: '', inputSchema: {} })),
    executeTool: () => ({ output: '{}', summary: 'done' }),
  })
  const skill = routedDirectorySkill(
    directoryRoute('what is Survey data.xlsx about', overviewScope),
    {
      reader: part(['list_directory', 'list_files', 'read_file']),
      inspection: part(['inspect_file', 'query_file']),
      analytics: part(['discover_datasets']),
      mutation: part(['update_file']),
      knowledge: part([
        'discover_knowledge_tools',
        'use_knowledge_tool',
        'spreadsheet_catalog_search',
        'spreadsheet_describe_dataset',
        'spreadsheet_query_sql',
        'word_read_sections',
        'knowledge_search',
      ]),
    },
  )
  expect(skill.tools.map((tool) => tool.name)).toEqual([
    'list_directory',
    'list_files',
    'discover_knowledge_tools',
    'use_knowledge_tool',
    'spreadsheet_catalog_search',
    'spreadsheet_describe_dataset',
    'discover_file_tools',
  ])
  expect(skill.systemPrompt).toContain('not respondent findings')
  await skill.executeTool({
    id: 'read',
    name: 'discover_file_tools',
    input: { capability: 'reading' },
  })
  expect(skill.tools.some((tool) => tool.name === 'inspect_file')).toBe(true)
  await skill.executeTool({
    id: 'sql',
    name: 'discover_file_tools',
    input: { capability: 'knowledge' },
  })
  expect(skill.tools.some((tool) => tool.name === 'spreadsheet_query_sql')).toBe(true)
})

function evidenceSkill(task: string, files = scope.files) {
  const selected = { ...scope, files }
  const part = (names: string[], execute: AgentSkill['executeTool']): AgentSkill => ({
    id: names[0], systemPrompt: '',
    tools: names.map(name => ({ name, description: '', inputSchema: {} })),
    executeTool: execute,
  })
  return routedDirectorySkill(directoryRoute(task, selected), {
    reader: part(['read_file'], call => ({ output: JSON.stringify({ path: call.input.path, sourceHash: 'a'.repeat(64), untrustedDocumentText: 'Verified source text' }), summary: 'read' })),
    inspection: part(['search_contents', 'inspect_file', 'query_file'], call => ({
      output: call.name === 'inspect_file'
        ? JSON.stringify({ id: 'inspection-1', path: call.input.path, sourceHash: 'a'.repeat(64) })
        : call.name === 'search_contents'
          ? JSON.stringify({ hits: [{ path: files[0], sourceHash: 'a'.repeat(64), excerpt: 'Candidate text' }] })
          : 'Verified source text',
      summary: call.name,
    })),
    analytics: part(['query_data', 'query_sql', 'analyze_data'], call => ({
      output: JSON.stringify({
        id: 'receipt-1',
        sources: [{ path: call.input.path ?? files[0], hash: 'a'.repeat(64) }],
        population: { sourceRows: [{ grain: 'One source data record' }] },
        rows: [{ count: '42' }],
        totalResultRows: call.input.mockTotalRows ?? 1,
        displayedRows: call.input.mockDisplayedRows ?? 1,
        outputTruncated: call.input.mockTruncated === true,
      }),
      summary: 'calculated',
    })),
    knowledge: part(['discover_knowledge_tools'], () => ({ output: '{}', summary: 'knowledge' })),
    mutation: part(['update_file'], () => ({ output: '{}', summary: 'edit' })),
  })
}

it('uses RAG for candidate lookup without forcing a direct read', async () => {
  const skill = evidenceSkill('find Hollie Parker in employee-data.xlsx')
  await skill.executeTool({ id: 'search', name: 'search_contents', input: { query: 'Hollie Parker' } })
  expect(skill.verifyResponse?.('Found a candidate in employee-data.xlsx.', [{ name: 'search_contents', ok: true }])).toBeNull()
})

it('requires a content read of the named saved file for verbatim answers', async () => {
  const skill = evidenceSkill('quote the exact wording in notes.txt')
  await skill.executeTool({ id: 'search', name: 'search_contents', input: { query: 'wording' } })
  expect(skill.verifyResponse?.('“Candidate text”', [{ name: 'search_contents', ok: true }])).toContain('exact saved-file content')
  await skill.executeTool({ id: 'inspect', name: 'inspect_file', input: { path: scope.files[1] } })
  expect(skill.verifyResponse?.('“Candidate text”', [{ name: 'inspect_file', ok: true }])).toContain('exact saved-file content')
  await skill.executeTool({ id: 'context', name: 'query_file', input: { inspectionId: 'inspection-1', tool: 'get_document_context' } })
  expect(skill.verifyResponse?.('“Candidate text”', [{ name: 'query_file', ok: true }])).toContain('exact saved-file content')
  await skill.executeTool({ id: 'blocks', name: 'query_file', input: { inspectionId: 'inspection-1', tool: 'read_blocks' } })
  expect(skill.verifyEvidence('“Candidate text”')).toContain('quoted passage does not match')
  expect(skill.verifyResponse?.('“Verified source text”', [{ name: 'query_file', ok: true }])).toBeNull()
})

it('requires a native calculation receipt from the named table', async () => {
  const skill = evidenceSkill('how many employees in employee-data.xlsx')
  await skill.executeTool({ id: 'search', name: 'search_contents', input: { query: 'employees' } })
  expect(skill.verifyResponse?.('There are 42 employees.', [{ name: 'search_contents', ok: true }])).toContain('native analytical result')
  await skill.executeTool({ id: 'wrong', name: 'query_data', input: { path: scope.files[1] } })
  expect(skill.verifyResponse?.('There are 42 employees.', [{ name: 'query_data', ok: true }])).toContain('native analytical result')
  await skill.executeTool({ id: 'count', name: 'query_data', input: { path: scope.files[0] } })
  expect(skill.verifyResponse?.('There are 42 employees.', [{ name: 'query_data', ok: true }])).toContain('receipt-1')
  expect(skill.verifyResponse?.('There are 42 employees. Receipt receipt-1.', [{ name: 'query_data', ok: true }])).toContain('structural source-record grain')
  expect(skill.verifyResponse?.('There are 42 included records. If each included row represents one employee, that corresponds to 42 employees. Receipt receipt-1.', [{ name: 'query_data', ok: true }])).toBeNull()
})

it('allows an explicit inability to verify without fabricating an exact answer', () => {
  const skill = evidenceSkill('quote the exact wording in notes.txt')
  expect(skill.verifyResponse?.('I cannot verify the exact wording from the available reader.', [])).toBeNull()
  expect(skill.verifyEvidence('I cannot verify the source, but it says “Candidate text”.')).toContain('exact saved-file content')
  expect(skill.systemPrompt).toContain('OCR text is recognized text')
})

it('retains the evidence gate after the single corrective turn', () => {
  const exact = evidenceSkill('what is the formula in cell B2 of employee-data.xlsx')
  expect(exact.verifyEvidence('Cell B2 is =SUM(A1:A2).')).toContain('exact saved-file content')
  const calculation = evidenceSkill('what is the exact number of employees in employee-data.xlsx')
  expect(calculation.verifyEvidence('There are 42 employees.')).toContain('native analytical result')
  expect(directoryRoute('what is the exact number of employees in employee-data.xlsx', scope).evidence).toEqual({ direct: false, calculation: true, quote: false, entityCount: true, exhaustiveGroups: false })
  expect(directoryRoute('what is the total in cell B2 of employee-data.xlsx', scope).evidence).toEqual({ direct: true, calculation: false, quote: false, entityCount: false, exhaustiveGroups: false })
  expect(directoryRoute('how many rows are in employee-data.xlsx', scope).evidence.entityCount).toBe(false)
})

it('does not present a bounded grouped result as the complete list', async () => {
  const sales = 'C:\\sample files\\sales-data.xlsx'
  const skill = evidenceSkill('what is the average amount of each product in sales-data.xlsx', [sales])
  await skill.executeTool({
    id: 'average',
    name: 'query_data',
    input: { path: sales, mockTotalRows: 490, mockDisplayedRows: 100, mockTruncated: true },
  })
  expect(skill.verifyEvidence('All 490 products are listed. [Analysis receipt](RAG:receipt-1:1)')).toContain('visible answer')
  expect(skill.verifyEvidence('All 490 products are listed. Receipt receipt-1.')).toContain('returned only 100 display rows')
  expect(skill.verifyEvidence('Showing 20 of 490 product groups; 470 not shown. Receipt receipt-1.')).toBeNull()
})
