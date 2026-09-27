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
}
Object.assign(window, {
  sidebarFixture: {
    state,
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
  },
  nawaHistory: {
    initialize: async () => ({ databasePath: 'fixture/history.sqlite', imported: 0 }),
    list: async () => ({ conversations: [clone(record)], total: 1 }),
    get: async () => clone(record),
    create: async () => clone(record),
    save: async (input: Partial<typeof record>) => {
      if (state.failHistorySave) throw new Error('Local storage temporarily unavailable')
      record = { ...record, ...clone(input), revision: record.revision + 1 }
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
              scopePaths={[folder + '\\revenue.xlsx']}
              scopeDirs={[]}
              onOpenFile={() => {}}
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
