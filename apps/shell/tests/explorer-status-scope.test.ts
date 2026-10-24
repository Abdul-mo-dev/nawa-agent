// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileList } from '../src/renderer/src/explorer/FileList'
import { DEFAULT_PREFERENCES, type Item } from '../src/renderer/src/explorer/model'
import type { FolderRoot } from '../src/shared/home-api'
import { RAG_IMAGE_OCR_NOTICE } from '@genoffice/file-parse/formats'
import { LocaleProvider } from '../src/renderer/src/locale'
import { RagBadge } from '../src/renderer/src/rag/RagStatus'

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
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  })
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
  const entries = ['active', 'queued', 'ready', 'failed', 'partial', 'changed', 'document'].map(
    (name) => ({
      ...items[0],
      name: name + '.xlsx',
      path: workspace + '\\' + name + '.xlsx',
    }),
  )
  const ragValues = ['embedding', 'embedded', 'embedded', 'failed', 'embedded', 'stale', 'embedded']
  const dataValues = [
    'ready',
    'not-imported',
    'ready',
    'failed',
    'needs-review',
    'changed',
    'unsupported',
  ]
  ragStatuses.mockImplementation(async () =>
    entries.map((entry, index) => ({
      path: entry.path,
      status: ragValues[index],
      chunks: 10,
      partial: index === 4,
      error: index === 3 ? 'OCR unavailable' : undefined,
    })),
  )
  analyticsStatuses.mockImplementation(async () =>
    entries.map((entry, index) => ({
      path: entry.path,
      state: dataValues[index],
      tables: 1,
      rows: 500,
      message: index === 3 ? 'Invalid date on row 8' : '',
    })),
  )
  Object.assign(window.nawaRag, {
    progress: async () => ({
      running: true,
      current: entries[0].path,
      message: 'Embedding passages',
      files: [
        { path: entries[0].path, status: 'indexing', completedChunks: 4, totalChunks: 10 },
        { path: entries[1].path, status: 'pending' },
      ],
    }),
  })
  Object.assign(window.nawaAnalytics, {
    progress: async () => ({
      running: true,
      current: entries[0].path,
      paths: entries.slice(0, 2).map((entry) => entry.path),
      currentRows: 42,
      message: 'Preparing selected table data',
    }),
  })
  await render(roots, entries)
  const icons = (column: string) => [
    ...host.querySelectorAll<HTMLElement>(`.ex-file-row .ex-column-${column} [data-state]`),
  ]
  expect(icons('indexed').map((icon) => icon.dataset.state)).toEqual([
    'busy',
    'waiting',
    'ready',
    'failed',
    'attention',
    'attention',
    'ready',
  ])
  expect(icons('data').map((icon) => icon.dataset.state)).toEqual([
    'busy',
    'waiting',
    'ready',
    'failed',
    'attention',
    'attention',
    'unavailable',
  ])
  expect(icons('indexed')[0].textContent).toBe('')
  expect(icons('indexed')[0].getAttribute('aria-label')).toBe('Search: Indexing…')
  await act(async () =>
    icons('indexed')[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  )
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    '4 of 10 passages embedded · 40%',
  )
  await act(async () =>
    icons('indexed')[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
  )
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => icons('data')[0].focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('42 rows processed')
  await act(async () => icons('data')[0].blur())
  await act(async () => icons('indexed')[3].focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('OCR unavailable')
})

it.each(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'])(
  'shows successful %s OCR as indexed text while keeping its coverage notice',
  async (extension) => {
    const image = {
      ...items[0],
      path: `${workspace}\\scan.${extension}`,
      name: `scan.${extension}`,
      ext: extension,
    }
    ragStatuses.mockResolvedValue([
      {
        path: image.path,
        status: 'embedded',
        chunks: 1,
        partial: true,
        warnings: [RAG_IMAGE_OCR_NOTICE],
      },
    ])
    await render(roots, [image])
    const icon = host.querySelector<HTMLElement>('.ex-column-indexed [data-state]')!
    expect(icon.dataset.state).toBe('ready')
    expect(icon.getAttribute('aria-label')).toBe('Search: Image text indexed (OCR)')
    await act(async () => icon.focus())
    const details = document.querySelector('[role="tooltip"]')?.textContent
    expect(details).toContain('1 passages')
    expect(details).toContain('Layout and visual meaning are not embedded')
  },
)

it('keeps image failures and incomplete extraction warnings visible', async () => {
  const images = ['failed', 'incomplete', 'unknown'].map((name) => ({
    ...items[0],
    path: `${workspace}\\${name}.png`,
    name: `${name}.png`,
    ext: 'png',
  }))
  ragStatuses.mockResolvedValue([
    {
      path: images[0].path,
      status: 'failed',
      chunks: 0,
      error: 'Local OCR found no readable text in this image.',
    },
    {
      path: images[1].path,
      status: 'embedded',
      chunks: 1,
      partial: true,
      warnings: [RAG_IMAGE_OCR_NOTICE, 'Later image pages could not be extracted.'],
    },
    { path: images[2].path, status: 'embedded', chunks: 1, partial: true, warnings: [] },
  ])
  await render(roots, images)
  const icons = [...host.querySelectorAll<HTMLElement>('.ex-column-indexed [data-state]')]
  expect(icons.map((icon) => icon.dataset.state)).toEqual(['failed', 'attention', 'attention'])
  await act(async () => icons[0].focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Local OCR found no readable text',
  )
})

it.each([
  { extension: 'pdf', warning: 'No text recovered on pages: 3. These pages are not embedded.' },
  { extension: 'xlsx', warning: 'Missing worksheet: Annual totals' },
  {
    extension: 'zip',
    warning:
      'attachments/archive.7z: unsupported or hidden archive entry; content was not embedded.',
  },
])(
  'identifies indexed $extension text without hiding missing content',
  async ({ extension, warning }) => {
    const entry = {
      ...items[0],
      path: `${workspace}\\partial.${extension}`,
      name: `partial.${extension}`,
      ext: extension,
    }
    ragStatuses.mockResolvedValue([
      { path: entry.path, status: 'embedded', chunks: 3, partial: true, warnings: [warning] },
    ])
    await render(roots, [entry])
    const icon = host.querySelector<HTMLElement>('.ex-column-indexed [data-state]')!
    expect(icon.dataset.state).toBe('attention')
    expect(icon.getAttribute('aria-label')).toBe('Search: Text indexed with limitations')
    await act(async () => icon.focus())
    const details = document.querySelector('[role="tooltip"]')?.textContent
    expect(details).toContain('3 passages')
    expect(details).toContain('Extracted text was embedded.')
    expect(details).toContain(warning)
  },
)

it.each([
  {
    lang: 'ar' as const,
    label: 'تمت فهرسة نص الصورة بالتعرف الضوئي',
    detail: 'تم التعرف على نص الصورة محلياً وفهرسته.',
  },
  {
    lang: 'ja' as const,
    label: '画像内のテキストを索引登録済み（OCR）',
    detail: '画像内のテキストをローカルでOCR認識し、索引登録しました。',
  },
])('explains successful OCR in $lang', async ({ lang, label, detail }) => {
  await act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: lang },
        createElement(RagBadge, {
          value: {
            path: `${workspace}\\scan.png`,
            status: 'embedded',
            chunks: 1,
            partial: true,
            warnings: [RAG_IMAGE_OCR_NOTICE],
          },
        }),
      ),
    ),
  )
  const icon = host.querySelector<HTMLElement>('[data-state]')!
  expect(icon.dataset.state).toBe('ready')
  expect(icon.getAttribute('aria-label')).toContain(label)
  await act(async () => icon.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(detail)
})

it('updates progress while a file status request is still waiting and drops the active overlay after completion', async () => {
  vi.useFakeTimers()
  let changed: () => void = () => {}
  let complete: (values: unknown[]) => void = () => {}
  let progress = {
    running: true,
    current: inside,
    files: [{ path: inside, status: 'indexing', completedChunks: 1, totalChunks: 10 }],
  }
  ragStatuses.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  Object.assign(window.nawaRag, {
    progress: async () => progress,
    onChanged: (callback: () => void) => {
      changed = callback
      return () => {}
    },
  })
  try {
    await render(roots)
    const icon = () =>
      host.querySelector<HTMLElement>('.ex-file-row .ex-column-indexed [data-state]')!
    expect(icon().dataset.state).toBe('busy')
    progress = {
      ...progress,
      files: progress.files.map((file) => ({ ...file, completedChunks: 8 })),
    }
    await act(async () => {
      changed()
      await vi.advanceTimersByTimeAsync(250)
    })
    await act(async () => icon().focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      '8 of 10 passages embedded · 80%',
    )
    progress = { ...progress, running: false }
    await act(async () => {
      complete([{ path: inside, status: 'stale', chunks: 10 }])
      changed()
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(icon().dataset.state).toBe('attention')
  } finally {
    vi.useRealTimers()
  }
})

it.each([
  ['Embedding server HTTP 404: the embedding model is unavailable.', 'Load an embedding model'],
  ['fetch failed: ECONNREFUSED 127.0.0.1:8081', 'embedding server is running'],
  ['EACCES: permission denied opening the file', 'Check file permissions'],
  ['ENOENT: file missing from the drive', 'file still exists'],
])(
  'shows the original failure and a recovery hint on hover after indexing completes: %s',
  async (reason, hint) => {
    ragStatuses.mockResolvedValue([{ path: inside, status: 'failed', chunks: 0, error: reason }])
    Object.assign(window.nawaRag, {
      progress: async () => ({
        running: false,
        current: '',
        files: [{ path: inside, status: 'failed', error: reason }],
      }),
    })
    await render(roots, [items[0]])
    const icon = host.querySelector<HTMLElement>('.ex-column-indexed [data-state]')!
    expect(icon.dataset.state).toBe('failed')
    await act(async () => icon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const tooltip = document.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain(reason)
    expect(tooltip.textContent).toContain(hint)
  },
)

it('shows a terminal worker reason even before the file metadata has refreshed', async () => {
  ragStatuses.mockResolvedValue([{ path: inside, status: 'not-indexed', chunks: 0 }])
  const reason = 'Embedding worker failed to load the model.'
  Object.assign(window.nawaRag, {
    progress: async () => ({
      running: false,
      current: '',
      files: [{ path: inside, status: 'failed', error: reason }],
    }),
  })
  await render(roots, [items[0]])
  const icon = host.querySelector<HTMLElement>('.ex-column-indexed [data-state]')!
  expect(icon.dataset.state).toBe('failed')
  await act(async () => icon.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(reason)
})

it('explains changed content in both tooltips and keeps its reason alongside a failed refresh', async () => {
  const reason =
    'File content changed since the last successful embedding.\nEmbedding server HTTP 404: model unavailable.'
  ragStatuses.mockResolvedValue([{ path: inside, status: 'stale', chunks: 10, error: reason }])
  analyticsStatuses.mockResolvedValue([
    {
      path: inside,
      state: 'changed',
      tables: 1,
      rows: 500,
      message: 'Source fingerprint changed.',
    },
  ])
  Object.assign(window.nawaRag, {
    progress: async () => ({
      running: false,
      files: [
        { path: inside, status: 'failed', error: 'Embedding server HTTP 404: model unavailable.' },
      ],
    }),
  })
  await render(roots, [items[0]])
  const search = host.querySelector<HTMLElement>('.ex-column-indexed [data-state]')!
  const data = host.querySelector<HTMLElement>('.ex-column-data [data-state]')!
  expect(search.dataset.state).toBe('attention')
  await act(async () => search.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(reason)
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Reindex / refresh for file chat',
  )
  await act(async () => data.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Source fingerprint changed.',
  )
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Prepare tables for analysis',
  )
})

it('distinguishes changed embedding settings and stops showing old job failures for a Ready file', async () => {
  ragStatuses.mockResolvedValue([
    {
      path: inside,
      status: 'stale',
      chunks: 10,
      error: 'Embedding model/settings changed. Re-index this file.',
    },
  ])
  await render(roots, [items[0]])
  let icon = host.querySelector<HTMLElement>('.ex-column-indexed [data-state]')!
  await act(async () => icon.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Embedding settings changed — index needs updating',
  )
  ragStatuses.mockResolvedValue([{ path: inside, status: 'embedded', chunks: 10 }])
  Object.assign(window.nawaRag, {
    progress: async () => ({
      running: false,
      files: [{ path: inside, status: 'failed', error: 'Old failure' }],
    }),
  })
  await render(roots, [{ ...items[0], mtimeMs: 2 }])
  icon = host.querySelector<HTMLElement>('.ex-column-indexed [data-state]')!
  expect(icon.dataset.state).toBe('ready')
  await act(async () => icon.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain('Old failure')
})

it('shows analytical file failures and unresolved table decisions with recovery guidance', async () => {
  analyticsStatuses.mockResolvedValue([
    { path: inside, state: 'failed', tables: 1, rows: 0, message: 'Invalid date on source row 8.' },
  ])
  await render(roots, [items[0]])
  let icon = host.querySelector<HTMLElement>('.ex-column-data [data-state]')!
  await act(async () => icon.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Invalid date on source row 8.',
  )
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Prepare tables for analysis',
  )
  analyticsStatuses.mockResolvedValue([
    {
      path: inside,
      state: 'needs-review',
      tables: 1,
      rows: 0,
      message: 'Select a formula policy before analysis.',
    },
  ])
  await render(roots, [{ ...items[0], mtimeMs: 2 }])
  icon = host.querySelector<HTMLElement>('.ex-column-data [data-state]')!
  await act(async () => icon.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Select a formula policy before analysis.',
  )
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Review table data in More actions',
  )
})
