/** Isolated rendering fixture: real sidebar components, synthetic desktop data, no network/provider calls. */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider, useI18n } from '../../apps/shell/src/renderer/src/locale'
import { WorkspaceControlPanel } from '../../apps/shell/src/renderer/src/explorer/WorkspaceControlPanel'
import { WorkspaceChat } from '../../apps/shell/src/renderer/src/WorkspaceChat'
import { DEFAULT_RAG_SETTINGS } from '../../apps/shell/src/shared/rag-api'
import { DEFAULT_ANALYTICS_SETTINGS } from '../../apps/shell/src/shared/analytics-api'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/dropdown.css'
import '../../apps/shell/src/renderer/src/home.css'
import '../../apps/shell/src/renderer/src/workspace.css'
import '../../apps/shell/src/renderer/src/explorer/explorer.css'
import './fixture.css'

const clone = <T,>(value: T): T => structuredClone(value)
const folder = 'C:\\Review workspace\\Quarterly reports'
const config = { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:8000/v1', model: 'local-model' }
let settings = {
  provider: 'custom',
  providers: { custom: config },
  gskToolsEnabled: false,
  maxOutputTokens: 8192,
  chatModels: [
    { id: 'one', name: 'Local research model', provider: 'custom', config },
    {
      id: 'two',
      name: 'Writing model',
      provider: 'custom',
      config: { ...config, model: 'writer' },
    },
  ],
}
let rag = { ...DEFAULT_RAG_SETTINGS, backend: 'local', model: 'local-embedding', enabled: true }
let analytics = { ...DEFAULT_ANALYTICS_SETTINGS }
const now = Date.now()
let record = {
  id: 'conversation',
  folder,
  folderName: 'Quarterly reports',
  title: 'Quarterly revenue and expense review',
  createdAt: now,
  updatedAt: now,
  revision: 0,
  draft: '',
  modelId: '',
  baselineId: null,
  lastChatAt: null,
  messageCount: 2,
  messages: [
    { id: 'q', role: 'user', text: 'Summarize this report.', createdAt: now },
    {
      id: 'a',
      role: 'assistant',
      text: 'The selected report compares **revenue and expenses**. Select additional files to include them in the analysis.\n\nEvery proposed file change will ask for your approval.',
      createdAt: now,
    },
  ],
}
const activityMode = new URLSearchParams(location.search).has('activity')
if (activityMode) {
  const saved = sessionStorage.getItem('fixture.activity-history')
  if (saved) record = JSON.parse(saved)
}
const columns = Array.from({ length: 16 }, (_, i) => ({
  id: `c${i}`,
  name: i ? `Amount ${i}` : 'Invoice ID',
  type: i ? 'decimal' : 'text',
  scale: 2,
  role: i ? 'measure' : 'identifier',
  unit: i ? 'JPY' : '',
  nullable: false,
  description: '',
}))
const dataset = {
  id: 'table',
  generation: 'v1',
  name: 'Quarterly revenue and expense data',
  path: folder + '\\revenue.xlsx',
  sourceHash: 'a'.repeat(64),
  sheet: 'Revenue',
  range: 'A1:P100',
  kind: 'xlsx',
  status: 'needs-review',
  rows: 99,
  rawRows: 100,
  excludedRows: 1,
  formulaCells: 0,
  warnings: [],
  profile: {},
  importedAt: now,
  policy: {
    name: 'Revenue',
    description: '',
    grain: '',
    headerRow: 1,
    firstRow: 2,
    lastRow: null,
    firstColumn: 0,
    lastColumn: 15,
    columns,
    key: ['c0'],
    currencyColumn: null,
    includeHiddenRows: false,
    skipRows: [],
    formulaPolicy: 'reject',
    confirmed: false,
  },
  preview: Array.from({ length: 3 }, (_, i) => ({
    row: i + 2,
    values: columns.map((_, c) => (c ? String((i + 1) * 100) : `INV-${i}`)),
  })),
}
const callbacks = new Set<() => void>()
let running = false
const state = {
  failLoad: false,
  failSave: false,
  failHistorySave: false,
  saved: 0,
  reviewed: 0,
  compares: 0,
  cancelScans: 0,
  scenario: 'read',
  catalogCalls: 0,
  executionCalls: 0,
  commits: 0,
  catalogUnavailable: false,
  holdCapture: false,
  staleCitation: false,
  openedFiles: [] as string[],
  requests: [] as any[],
  toolRequests: [] as any[],
  rejectHistory: false,
}
const runSources = new Map<string, Map<string, any>>()
const streamListeners = new Set<(chunk: any) => void>()
const turns = new Map<string, number>()
let releaseTool: (() => void) | undefined
let releaseCapture: (() => void) | undefined
const stream = async (request: any) => {
  state.requests.push(clone(request))
  const emit = (chunk: any) => streamListeners.forEach(listener => listener({ ...chunk, requestId: request.requestId }))
  const turn = (turns.get(request.sessionId) ?? 0) + 1; turns.set(request.sessionId, turn)
  await new Promise(resolve => setTimeout(resolve, 50))
  if (state.scenario === 'connection-error') { emit({ type: 'error', error: 'Fixture provider unavailable' }); return }
  if (state.scenario === 'cutoff') { emit({ type: 'delta', text: 'This answer stopped midway.' }); emit({ type: 'done', stopReason: 'max_tokens' }); return }
  if (state.scenario.startsWith('overview')) {
    if (state.scenario === 'overview-missing' && turn <= 2) emit({ type: 'tool-call', toolCall: {
      id: crypto.randomUUID(), name: turn === 1 ? 'discover_file_tools' : 'inspect_file', input: turn === 1 ? { capability: 'reading' } : { path: surveySource.path },
    } })
    else {
      const citation = JSON.stringify(request.messages).match(/RAG:[a-z\d-]+/i)?.[0]
      emit({ type: 'delta', text: state.scenario === 'overview-missing' ? 'The saved workbook contains questions about safety and neighbors.'
        : `The indexed sheets Survey 1 and Survey 2 contain questions about safety and neighbor interaction. [Survey source](${citation})` })
    }
    emit({ type: 'done' }); return
  }
  if (['listing', 'count', 'citation', 'intermediate-failure'].includes(state.scenario)) {
    if (turn === 1) {
      if (state.scenario === 'intermediate-failure') emit({ type: 'delta', text: 'Unverified intermediate claim.' })
      emit({ type: 'tool-call', toolCall: { id: crypto.randomUUID(), name: state.scenario === 'listing' ? 'list_directory' : 'spreadsheet_query_sql',
        input: state.scenario === 'listing' ? { path: '.' } : { sql: 'SELECT COUNT(*) FROM revenue', _nawaFiles: [folder + '\\revenue.xlsx'] } } })
    } else {
      if (state.scenario === 'intermediate-failure') { emit({ type: 'error', error: 'Fixture failed after commentary' }); return }
      const tools = request.messages.filter((message: any) => message.role === 'tool').flatMap((message: any) => message.results)
      const result = tools.length ? JSON.parse(tools.at(-1).output) : {}
      emit({ type: 'delta', text: state.scenario === 'listing' ? 'revenue.xlsx' : state.scenario === 'citation'
        ? `The count is 99. [Source](${result.citations[0].id}) [Unregistered](RAG:unknown)` : 'The workbook contains 99 data rows.' })
    }
    emit({ type: 'done' }); return
  }
  const native = request.system.includes('editing a private staging copy')
  if (native && turn === 1) emit({ type: 'tool-call', toolCall: { id: crypto.randomUUID(), name: 'native_format', input: { range: 'A1:B4' } } })
  else if (!native && state.scenario === 'edit' && turn === 1) emit({ type: 'tool-call', toolCall: { id: crypto.randomUUID(), name: 'update_file', input: { path: folder + '\\revenue.xlsx', instruction: 'Format the revenue table' } } })
  else if (!native && state.scenario !== 'edit' && turn === 1) {
    for (let i = 0; i < 2; i++) emit({ type: 'tool-call', toolCall: { id: crypto.randomUUID(), name: 'discover_knowledge_tools', input: { scope: 'selected', query: 'spreadsheet' } } })
  } else if (!native && state.scenario !== 'edit' && turn === 2) emit({ type: 'tool-call', toolCall: { id: crypto.randomUUID(), name: 'use_knowledge_tool', input: { tool: 'spreadsheet_query_sql', paths: [folder + '\\revenue.xlsx'], arguments: { sql: 'SELECT COUNT(*) FROM revenue' } } } })
  else {
    const declined = JSON.stringify(request.messages).includes('user declined')
    const text = native ? 'Formatting is ready for review.' : state.scenario === 'edit' ? declined ? 'No changes were saved.' : 'The approved changes were saved.' : state.scenario === 'fail' ? 'The file needs a refresh before I can calculate the total.' : 'The selected table contains **99 rows**.'
    for (const character of text) emit({ type: 'delta', text: character })
  }
  emit({ type: 'done' })
}
const source = { path: folder + '\\revenue.xlsx', server: 'http://127.0.0.1:5187', documentId: 'doc', contentHash: 'a'.repeat(64), indexRevision: 'v1', datasetRevision: 'table-v1' }
const surveySource = { ...source, path: folder + '\\Survey data.xlsx', documentId: 'survey' }
const definition = { name: 'spreadsheet_query_sql', description: 'Query the selected workbook', inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } }
let proposal: any
Object.assign(window, {
  sidebarFixture: {
    state,
    release: () => releaseTool?.(),
    releaseCapture: () => releaseCapture?.(),
    messages: () => clone(record.messages),
    refresh: () => {
      dataset.generation = 'v2'
      callbacks.forEach((fn) => fn())
    },
    job: (value: boolean) => {
      running = value
      callbacks.forEach((fn) => fn())
    },
  },
  aiOffice: {
    listWorkspaceFolder: async () => ({ files: [{ name: 'revenue.xlsx', path: source.path, sizeBytes: 2048 }], folders: [] }),
    getAiProviders: () => [
      { id: 'custom', label: 'Custom provider', defaultModel: '', models: [], needsBaseUrl: true },
    ],
    getAiSettings: async () => {
      if (state.failLoad) throw new Error('Could not load model settings')
      return clone(settings)
    },
    setAiSettings: async (value: typeof settings) => {
      if (state.failSave) throw new Error('Could not save model settings')
      settings = clone(value)
      state.saved++
    },
    testAiSettings: async () => ({ ok: true }),
    setLanguage: async () => {},
    onAiStreamChunk: (listener: (chunk: any) => void) => { streamListeners.add(listener); return () => streamListeners.delete(listener) },
    aiStream: stream,
    aiStreamCancel: async () => {},
  },
  nawaDirectory: {
    begin: async () => { const id = crypto.randomUUID(); runSources.set(id, new Map()); return id }, cancel: async (id: string) => { runSources.delete(id) }, verifyInspections: async () => null,
    validateEvidence: async (run: string) => {
      if (state.scenario === 'overview-changed') throw new Error('Survey source changed during the answer.')
      const sources = [...(runSources.get(run)?.values() ?? [])]
      return { evidence: sources.map(value => ({ path: value.path, hash: value.contentHash, myAgent: value })), sourceCount: sources.length, durationMs: 2, httpRequests: sources.length ? 1 : 0 }
    },
    restoreEvidence: async (_run: string, requests: any[]) => {
      if (state.rejectHistory) return []
      for (const request of requests) for (const value of request.evidence) if (value.myAgent) runSources.get(_run)?.set(value.path, value.myAgent)
      return requests.map(request => request.id)
    },
    inspect: async (run: string, path: string) => {
      runSources.get(run)?.set(path, surveySource)
      return { id: 'inspection', path, sourceHash: source.contentHash, kind: 'sheets', systemPrompt: 'Read only', context: 'Survey 1: safety and neighbor interaction questions.', tools: [] }
    },
    checkCitation: async () => !state.staleCitation,
    myAgentTools: async (_run: string, action: string, payload: any) => {
      state.toolRequests.push({ action, payload: clone(payload) })
      if (action === 'catalog') {
        if (state.holdCapture) await new Promise<void>(resolve => { releaseCapture = resolve })
        state.catalogCalls++
        if (state.catalogUnavailable) throw new Error('MyAgent tool API not found (HTTP 404). Rebuild and restart MyAgent.')
        const definitions = state.scenario === 'count' || state.scenario.startsWith('overview') ? [definition, { name: 'spreadsheet_catalog_search', description: 'Dataset catalog', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } }] : [definition]
        if (state.scenario.startsWith('overview')) definitions.push({ name: 'spreadsheet_describe_dataset', description: 'Describe dataset', inputSchema: { type: 'object', properties: { datasetId: { type: 'string' } } } } as any)
        return { available: true, tools: definitions, initialTools: payload.initial ? definitions : [], total: definitions.length, nextOffset: null,
          sources: [], files: [{ path: source.path, status: 'unchecked', documentId: 'doc' }], warnings: [], diagnostics: { httpRequests: 1, durationMs: 2 } }
      }
      state.executionCalls++
      if (state.scenario === 'slow') await new Promise<void>(resolve => { releaseTool = resolve })
      const target = payload.paths?.[0] === surveySource.path ? surveySource : source
      runSources.get(_run)?.set(target.path, target)
      const datasets = state.scenario === 'overview-missing' ? [] : target === surveySource
        ? [1, 2].map(n => ({ Id: `survey-${n}`, SqlObjectName: `survey_sql_${n}`, DisplayName: `Logical survey ${n}`, SheetNames: [`Survey ${n}`], ColumnNames: ['Safety perception', 'Neighbor interaction'], ColumnCount: 2, SchemaSignature: 'Large repeated schema '.repeat(1000) }))
        : [{ Id: 'table', SqlObjectName: 'revenue', RowCount: 99, ColumnNames: ['id', 'amount'] }]
      return { tool: payload.tool, succeeded: state.scenario !== 'fail', sources: [target], warnings: [],
        content: state.scenario === 'fail' ? '' : payload.tool === 'spreadsheet_catalog_search' ? JSON.stringify({ datasets }) : JSON.stringify({ rows: [{ count: 99 }], apiKey: 'fixture-secret-must-be-redacted' }),
        error: state.scenario === 'fail' ? 'revenue.xlsx needs indexing/refresh.' : null }
    },
    propose: async (_run: string, input: any) => { proposal = { ...input, id: crypto.randomUUID(), run: _run }; return proposal },
    prepare: async () => ({ kind: 'sheets', systemPrompt: 'Fixture native editor.', context: 'Selected staged workbook.', tools: [{ name: 'native_format', description: 'Format workbook', inputSchema: { type: 'object', properties: { range: { type: 'string' } } } }] }),
    execute: async () => ({ output: 'Formatted 8 cells', summary: 'Formatted the revenue table', mutated: true }),
    verify: async () => null,
    preview: async () => ({ ...proposal, bytes: 2048, beforeText: 'Before formatting', afterText: 'After formatting' }),
    commit: async () => { state.commits++; return { path: proposal.path, operation: 'update', backupPath: proposal.path + '.backup' } },
    discard: async () => {},
  },
  nawaHistory: {
    initialize: async () => ({ databasePath: 'fixture/history.sqlite', imported: 0 }),
    list: async () => ({ conversations: [clone(record)], total: 1 }),
    get: async () => clone(record),
    create: async () => clone(record),
    save: async (input: Partial<typeof record> & { delta?: boolean; removedIds?: string[] }) => {
      if (state.failHistorySave) throw new Error('Local storage temporarily unavailable')
      const { delta, removedIds, ...next } = clone(input)
      if (delta) {
        const updates = new Map((next.messages ?? []).map(message => [message.id, message]))
        next.messages = record.messages.filter(message => !removedIds?.includes(message.id)).map(message => {
          const update = updates.get(message.id); updates.delete(message.id); return update ?? message
        }).concat([...updates.values()])
      }
      record = { ...record, ...next, revision: record.revision + 1 }
      if (activityMode) sessionStorage.setItem('fixture.activity-history', JSON.stringify(record))
      return { revision: record.revision, updatedAt: now, title: record.title }
    },
    compare: async () => {
      state.compares++
      return {
        status: 'unchanged',
        since: now,
        checkedAt: now,
        added: 0,
        removed: 0,
        modified: 0,
        unverified: 0,
        changes: [],
        issues: [],
        complete: true,
        truncated: false,
      }
    },
    cancelScan: async () => {
      state.cancelScans++
    },
    capture: async () => {
      if (state.holdCapture) await new Promise<void>(resolve => { releaseCapture = resolve })
      return { id: crypto.randomUUID(), hash: 'a'.repeat(64), complete: true, startedAt: Date.now(), finishedAt: Date.now(), fileCount: 1, directoryCount: 1, bytesHashed: 2048, issues: [] }
    },
    rename: async (_: string, title: string) => {
      record.title = title
    },
    delete: async () => {},
    revealDatabase: async () => {},
  },
  nawaRag: {
    settings: async () => ({
      settings: clone(rag),
      hasKey: false,
      databasePath: 'fixture/search.sqlite',
    }),
    save: async (value: typeof rag) => {
      rag = clone(value)
      return { settings: clone(rag), hasKey: false, databasePath: 'fixture/search.sqlite' }
    },
    test: async () => ({ dimensions: 768, message: 'Connection successful.' }),
    progress: async () => ({
      running,
      folder: 'C:\\Other directory',
      scanned: 3,
      embedded: 2,
      failed: 0,
      message: running ? 'Indexing files' : '',
      chunks: 20,
      unchanged: 0,
      current: '',
      incomplete: false,
    }),
    onChanged: (fn: () => void) => {
      callbacks.add(fn)
      return () => callbacks.delete(fn)
    },
    clear: async () => {},
    cancel: async () => {
      running = false
    },
  },
  nawaAnalytics: {
    settings: async () => ({ settings: clone(analytics), databasePath: 'fixture/analysis.sqlite' }),
    saveSettings: async (value: typeof analytics) => {
      analytics = clone(value)
    },
    catalog: async () => ({
      datasets: [clone(dataset)],
      total: 1,
      nextOffset: null,
      files: [],
      truncated: false,
    }),
    progress: async () => ({
      running,
      folder: 'C:\\Other directory',
      scanned: 3,
      imported: 2,
      failed: 0,
      rows: 100,
      message: running ? 'Importing records' : '',
      unchanged: 0,
      current: '',
      incomplete: false,
    }),
    onChanged: (fn: () => void) => {
      callbacks.add(fn)
      return () => callbacks.delete(fn)
    },
    review: async (_id: string, generation: string) => {
      if (generation !== dataset.generation) throw new Error('Source changed. Reopen the review.')
      state.reviewed++
      return clone(dataset)
    },
    clear: async () => {},
    cancel: async () => {
      running = false
    },
  },
})
function Fixture() {
  const [visible, setVisible] = useState(true),
    [active, setActive] = useState<'ai' | 'ragAnalytics' | 'provider'>('ai'),
    [width, setWidth] = useState(360),
    [screen, setScreen] = useState(innerWidth)
  const { setLang } = useI18n()
  useEffect(() => {
    const resize = () => setScreen(innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  return (
    <div
      className="explorer"
      style={{ '--ex-inspector-width': `${width}px` } as React.CSSProperties}
    >
      <header className="fixture-controls">
        <button onClick={() => setVisible(true)}>Open sidebar</button>
        <button onClick={() => setWidth(300)}>300px</button>
        <button onClick={() => setWidth(560)}>560px</button>
        <button
          onClick={() => {
            setLang('ar')
            document.documentElement.dataset.theme = 'dark'
          }}
        >
          Arabic dark
        </button>
      </header>
      <div className="ex-body">
        <main className="ex-center">
          <h1>Quarterly reports</h1>
          <p>Synthetic test workspace</p>
        </main>
        <WorkspaceControlPanel
          visible={visible}
          drawer={screen < 1100}
          active={active}
          onChange={setActive}
          onClose={() => setVisible(false)}
          assistantLabel="Nawa"
          closeLabel="Close sidebar"
          folder={folder}
          onAddFolder={() => {}}
          assistant={
            <WorkspaceChat
              folder={folder}
              folderName="Quarterly reports"
              scopePaths={[folder + '\\revenue.xlsx', surveySource.path]}
              scopeDirs={[]}
              onOpenFile={path => { state.openedFiles.push(path) }}
              onClose={() => setVisible(false)}
            />
          }
        />
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <LocaleProvider initial="en">
    <Fixture />
  </LocaleProvider>,
)
