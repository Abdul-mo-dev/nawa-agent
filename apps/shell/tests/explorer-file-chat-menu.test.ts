// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ExplorerHome } from '../src/renderer/src/explorer/ExplorerHome'
import { LocaleProvider } from '../src/renderer/src/locale'
import { LAST_LOCATION_KEY, type Item } from '../src/renderer/src/explorer/model'
import { DEFAULT_RAG_SETTINGS, type RagFileStatus } from '../src/shared/rag-api'
import type { AnalyticsFileStatus } from '../src/shared/analytics-api'
import { fileCapabilities } from '../src/shared/file-capabilities'

vi.mock('../src/renderer/src/WorkspaceChat', () => ({
  WorkspaceChat: (props: { scopePaths: string[] }) =>
    createElement('div', { 'data-chat-paths': JSON.stringify(props.scopePaths) }),
}))
vi.mock('../src/renderer/src/explorer/Settings', () => ({ ExplorerSettings: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const folder = 'C:\\Workspace'
const file = (name: string): Item => ({
  path: folder + '\\' + name,
  name,
  kind: 'file',
  ext: name.split('.').at(-1)!,
  mtimeMs: 1,
  sizeBytes: 50,
})
const sales = file('sales.xlsx'),
  notes = file('notes.docx'),
  other = file('other.csv')
let host: HTMLDivElement, root: Root
let ragValues: Record<string, RagFileStatus>, dataValues: Record<string, AnalyticsFileStatus>
let indexSelected: ReturnType<typeof vi.fn>,
  prepareSelected: ReturnType<typeof vi.fn>,
  settings: ReturnType<typeof vi.fn>
let ragStatuses: ReturnType<typeof vi.fn>, analyticsStatuses: ReturnType<typeof vi.fn>
let changed: Set<() => void>

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ kind: 'folder', path: folder }))
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  })
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  ragValues = {}
  dataValues = {}
  changed = new Set()
  const onChanged = (callback: () => void) => {
    changed.add(callback)
    return () => {
      changed.delete(callback)
    }
  }
  indexSelected = vi.fn(async () => ({ running: false }))
  prepareSelected = vi.fn(async () => ({ failedFiles: 0, blockedTables: 0 }))
  settings = vi.fn(async () => ({
    settings: { ...DEFAULT_RAG_SETTINGS, enabled: true, model: 'local-embed' },
  }))
  ragStatuses = vi.fn(async (paths: string[]) =>
    paths.map(
      (path) =>
        ragValues[path] ?? {
          path,
          status: 'not-indexed',
          chunks: 0,
          unsupported: !fileCapabilities(path).search,
        },
    ),
  )
  analyticsStatuses = vi.fn(async (paths: string[]) =>
    paths.map(
      (path) =>
        dataValues[path] ?? {
          path,
          state: fileCapabilities(path).analysis ? 'not-imported' : 'unsupported',
          tables: 0,
          rows: 0,
        },
    ),
  )
  Object.assign(window, {
    aiOffice: {
      workspaceRoots: async () => [{ path: folder, name: 'Workspace', usable: true }],
      onWorkspaceRootsChanged: () => () => {},
      onFolderChanged: () => () => {},
      recents: async () => ({ entries: [], total: 0, totalAll: 0 }),
      listWorkspaceFolder: async () => ({
        dir: folder,
        folders: [{ path: folder + '\\Subfolder', name: 'Subfolder', mtimeMs: 1 }],
        files: [sales, notes, other],
      }),
    },
    aiOfficeTabs: { activate: vi.fn(async () => {}) },
    nawaRag: {
      settings,
      statuses: ragStatuses,
      indexSelected,
      progress: async () => ({ running: false }),
      onChanged,
    },
    nawaAnalytics: {
      statuses: analyticsStatuses,
      prepareSelected,
      progress: async () => ({ running: false }),
      onChanged,
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(ExplorerHome, { onOpenLegacy: vi.fn() }),
      ),
    ),
  )
}
const row = (item: Item) =>
  [...host.querySelectorAll<HTMLElement>('.ex-file-row')].find(
    (node) => node.dataset.path === item.path,
  )!
const action = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.children[1]?.textContent === name,
  )!
const rightClick = (item: Item) =>
  act(async () =>
    row(item).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 150 }),
    ),
  )
const select = (item: Item, additive = false) =>
  act(async () =>
    row(item).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: additive })),
  )
const click = (name: string) => act(async () => action(name).click())

it('indexes the right-clicked file rather than a previously selected file', async () => {
  await render()
  await select(other)
  await rightClick(sales)
  expect(action('Chat with this file')).toBeDefined()
  await click('Index for file chat')
  expect(indexSelected).toHaveBeenCalledExactlyOnceWith(folder, [sales.path], true)
  expect(prepareSelected).toHaveBeenCalledExactlyOnceWith(folder, [sales.path])
  expect(host.querySelector('[data-chat-paths]')?.getAttribute('data-chat-paths')).toBe(
    JSON.stringify([sales.path]),
  )
})

it('preserves a multi-selection and prepares only its supported tables', async () => {
  await render()
  await select(sales)
  await select(notes, true)
  await rightClick(sales)
  expect(action('Chat with selected files')).toBeDefined()
  await click('Index for file chat')
  expect(indexSelected).toHaveBeenCalledExactlyOnceWith(folder, [sales.path, notes.path], true)
  expect(prepareSelected).toHaveBeenCalledExactlyOnceWith(folder, [sales.path])
})

it('offers refresh for changed or previously indexed sources and preserves menu keyboard focus', async () => {
  await render()
  let finish!: (values: RagFileStatus[]) => void
  ragStatuses.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await rightClick(sales)
  const before = action('Index for file chat')
  await act(async () => before.focus())
  await act(async () => finish([{ path: sales.path, status: 'stale', chunks: 12 }]))
  const refresh = action('Reindex / refresh for file chat')
  expect(document.activeElement).toBe(refresh)
  expect(refresh.title).toContain('reuses unchanged data')
  await click('Reindex / refresh for file chat')
  expect(indexSelected).toHaveBeenCalledExactlyOnceWith(folder, [sales.path], true)
})

it('prepares tables even when embedding setup is unavailable', async () => {
  settings.mockResolvedValue({ settings: { ...DEFAULT_RAG_SETTINGS, enabled: false } })
  await render()
  await rightClick(sales)
  await click('Prepare tables for analysis')
  expect(prepareSelected).toHaveBeenCalledExactlyOnceWith(folder, [sales.path])
  expect(indexSelected).not.toHaveBeenCalled()
  expect(settings).not.toHaveBeenCalled()
  expect(document.querySelector('dialog[open]')).toBeNull()
})

it('shows verified status, population counts, warnings and review reasons in a file details dialog', async () => {
  ragValues[sales.path] = {
    path: sales.path,
    status: 'embedded',
    chunks: 12,
    warnings: ['Some text needs OCR.'],
  }
  dataValues[sales.path] = { path: sales.path, state: 'ready', tables: 1, rows: 500 }
  await render()
  await rightClick(sales)
  await click('Indexing & analysis details')
  const details = document.querySelector('dialog[open]')!
  expect(details.textContent).toContain('sales.xlsx')
  expect(details.textContent).toContain('Indexed for search')
  expect(details.textContent).toContain('12 passages')
  expect(details.textContent).toContain('Some text needs OCR.')
  expect(details.textContent).toContain('1 tables · 500 included rows')
  expect(details.textContent).not.toContain(other.path)
  dataValues[sales.path] = {
    path: sales.path,
    state: 'needs-review',
    tables: 1,
    rows: 500,
    message: 'Confirm the currency unit.',
  }
  await act(async () => {
    changed.forEach((callback) => callback())
    await new Promise((resolve) => setTimeout(resolve, 250))
  })
  expect(details.textContent).toContain('Needs a decision')
  expect(details.textContent).toContain('Confirm the currency unit.')
})

it('shows failures without blocking chat or file commands', async () => {
  await render()
  ragStatuses.mockRejectedValue(new Error('Search database unavailable.'))
  await rightClick(sales)
  expect(action('Chat with this file').disabled).toBe(false)
  expect(action('Rename').disabled).toBe(false)
  await click('Indexing & analysis details')
  expect(document.querySelector('dialog[open]')?.textContent).toContain(
    'Search database unavailable.',
  )
})

it('keeps folder menus nonrecursive and does not offer table or indexing actions for them', async () => {
  await render()
  const subfolder = { ...file('Subfolder'), kind: 'folder' as const }
  await rightClick(subfolder)
  expect(action('Ask about selection')).toBeDefined()
  expect(action('Index for file chat')).toBeUndefined()
  expect(action('Prepare tables for analysis')).toBeUndefined()
  expect(indexSelected).not.toHaveBeenCalled()
  expect(prepareSelected).not.toHaveBeenCalled()
})
