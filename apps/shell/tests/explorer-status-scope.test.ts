// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileList } from '../src/renderer/src/explorer/FileList'
import { DEFAULT_PREFERENCES, type Item } from '../src/renderer/src/explorer/model'
import type { FolderRoot } from '../src/shared/home-api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const workspace = 'C:\\Workspace'
const inside = `${workspace}\\budget.xlsx`
const outside = 'C:\\Other\\report.xlsx'
const unavailable = 'C:\\Offline\\old.xlsx'
const items: Item[] = [inside, outside, unavailable].map((path) => ({
  path,
  name: path.split('\\').at(-1)!,
  kind: 'file',
  ext: 'xlsx',
  mtimeMs: 0,
  sizeBytes: 1,
}))
const roots: FolderRoot[] = [
  { path: workspace, name: 'Workspace', usable: true },
  { path: 'C:\\Offline', name: 'Offline', usable: false },
]

let host: HTMLDivElement
let root: Root
let analyticsStatuses: ReturnType<typeof vi.fn>
let ragStatuses: ReturnType<typeof vi.fn>

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  analyticsStatuses = vi.fn(async () => [])
  ragStatuses = vi.fn(async () => [])
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  Object.assign(window, {
    aiOffice: { onFolderChanged: () => () => {} },
    nawaAnalytics: { statuses: analyticsStatuses, onChanged: () => () => {} },
    nawaRag: { statuses: ragStatuses, onChanged: () => () => {} },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render(workspaceRoots: FolderRoot[], entries: Item[] = items) {
  await act(async () =>
    root.render(
      createElement(FileList, {
        items: entries,
        roots: workspaceRoots,
        selected: new Set<string>(),
        cutPaths: new Set<string>(),
        preferences: DEFAULT_PREFERENCES,
        locale: 'en-US',
        text: (key) => key,
        onSelect: vi.fn(),
        onSelectAll: vi.fn(),
        onOpen: vi.fn(),
        onContext: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        onSort: vi.fn(),
      }),
    ),
  )
}

it('shows external recents without requesting their analytics or RAG status', async () => {
  await render(roots)
  expect(host.textContent).toContain('report.xlsx')
  expect(host.textContent).toContain('old.xlsx')
  expect(analyticsStatuses.mock.calls.map((call) => call[0])).toEqual([[inside]])
  expect(ragStatuses.mock.calls.map((call) => call[0])).toEqual([[inside]])

  analyticsStatuses.mockClear()
  ragStatuses.mockClear()
  await render([])
  expect(analyticsStatuses).not.toHaveBeenCalled()
  expect(ragStatuses).not.toHaveBeenCalled()
})

it('shows live per-file indexing and analysis icons with details on hover and focus', async () => {
  const entries = ['active', 'queued', 'ready', 'failed', 'partial', 'changed', 'document'].map(name => ({
    ...items[0], name: name + '.xlsx', path: workspace + '\\' + name + '.xlsx',
  }))
  const ragValues = ['embedding', 'embedded', 'embedded', 'failed', 'embedded', 'stale', 'embedded']
  const dataValues = ['ready', 'not-imported', 'ready', 'failed', 'needs-review', 'changed', 'unsupported']
  ragStatuses.mockImplementation(async () => entries.map((entry, index) => ({
    path: entry.path, status: ragValues[index], chunks: 10,
    partial: index === 4, error: index === 3 ? 'OCR unavailable' : undefined,
  })))
  analyticsStatuses.mockImplementation(async () => entries.map((entry, index) => ({
    path: entry.path, state: dataValues[index], tables: 1, rows: 500,
    message: index === 3 ? 'Invalid date on row 8' : '',
  })))
  Object.assign(window.nawaRag, { progress: async () => ({
    running: true, current: entries[0].path, message: 'Embedding passages',
    files: [
      { path: entries[0].path, status: 'indexing', completedChunks: 4, totalChunks: 10 },
      { path: entries[1].path, status: 'pending' },
    ],
  }) })
  Object.assign(window.nawaAnalytics, { progress: async () => ({
    running: true, current: entries[0].path, paths: entries.slice(0, 2).map(entry => entry.path),
    currentRows: 42, message: 'Preparing selected table data',
  }) })
  await render(roots, entries)
  const icons = (column: string) => [...host.querySelectorAll<HTMLElement>(`.ex-file-row .ex-column-${column} [data-state]`)]
  expect(icons('indexed').map(icon => icon.dataset.state)).toEqual(['busy', 'waiting', 'ready', 'failed', 'attention', 'attention', 'ready'])
  expect(icons('data').map(icon => icon.dataset.state)).toEqual(['busy', 'waiting', 'ready', 'failed', 'attention', 'attention', 'unavailable'])
  expect(icons('indexed')[0].textContent).toBe('')
  expect(icons('indexed')[0].getAttribute('aria-label')).toBe('Search: Indexing…')
  await act(async () => icons('indexed')[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('4 of 10 passages embedded · 40%')
  await act(async () => icons('indexed')[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => icons('data')[0].focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('42 rows processed')
  await act(async () => icons('data')[0].blur())
  await act(async () => icons('indexed')[3].focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('OCR unavailable')
})

it('updates progress while a file status request is still waiting and drops the active overlay after completion', async () => {
  vi.useFakeTimers()
  let changed: () => void = () => {}
  let complete: (values: unknown[]) => void = () => {}
  let progress = { running: true, current: inside, files: [{ path: inside, status: 'indexing', completedChunks: 1, totalChunks: 10 }] }
  ragStatuses.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  Object.assign(window.nawaRag, {
    progress: async () => progress,
    onChanged: (callback: () => void) => { changed = callback; return () => {} },
  })
  try {
    await render(roots)
    const icon = () => host.querySelector<HTMLElement>('.ex-file-row .ex-column-indexed [data-state]')!
    expect(icon().dataset.state).toBe('busy')
    progress = { ...progress, files: progress.files.map(file => ({ ...file, completedChunks: 8 })) }
    await act(async () => { changed(); await vi.advanceTimersByTimeAsync(250) })
    await act(async () => icon().focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('8 of 10 passages embedded · 80%')
    progress = { ...progress, running: false }
    await act(async () => {
      complete([{ path: inside, status: 'stale', chunks: 10 }])
      changed()
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(icon().dataset.state).toBe('attention')
  } finally { vi.useRealTimers() }
})
