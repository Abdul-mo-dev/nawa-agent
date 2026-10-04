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

async function render(workspaceRoots: FolderRoot[]) {
  await act(async () =>
    root.render(
      createElement(FileList, {
        items,
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
