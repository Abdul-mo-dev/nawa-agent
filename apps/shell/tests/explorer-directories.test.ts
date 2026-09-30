// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FolderListing, FolderRoot } from '../src/shared/home-api'
import { DirectoryTree } from '../src/renderer/src/explorer/Tree'
import { EXPANDED_KEY } from '../src/renderer/src/explorer/model'
import { useDirectories } from '../src/renderer/src/explorer/useDirectories'

vi.mock('../src/renderer/src/WorkspaceChat', () => ({ WorkspaceChat: () => null }))
vi.mock('../src/renderer/src/explorer/WorkspaceControlPanel', () => ({ WorkspaceControlPanel: () => null }))
vi.mock('../src/renderer/src/explorer/Settings', () => ({ ExplorerSettings: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const folder: FolderRoot = { path: 'C:\\Workspace', name: 'Workspace', usable: true }
const child = `${folder.path}\\Reports`, grandchild = `${child}\\Monthly`
const listing = (path: string, children: string[] = []): FolderListing => ({
  dir: path, folders: children.map(path => ({ path, name: path.split('\\').at(-1)!, mtimeMs: 0, hasSubfolders: true })), files: [],
})
let root: Root, host: HTMLDivElement, directories: ReturnType<typeof useDirectories>
let list: ReturnType<typeof vi.fn<(path: string) => Promise<FolderListing>>>
function Harness({ current = folder, selectedPath, revision = 0 }: { current?: FolderRoot; selectedPath?: string; revision?: number }) {
  directories = useDirectories()
  return createElement(DirectoryTree, {
    root: current, selectedPath, revision, get: directories.get, load: directories.load,
    navigate: vi.fn(), openFile: vi.fn(), onContext: vi.fn(),
  })
}
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  list = vi.fn(async path => listing(path))
  Object.assign(window, { aiOffice: { listWorkspaceFolder: list } })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const render = async (props: Parameters<typeof Harness>[0] = {}) => {
  await act(async () => root.render(createElement(Harness, props)))
}

it('restores expansions through current parent listings without requesting deleted, hidden or detached folders', async () => {
  const deleted = `${folder.path}\\Nawa table exports deleted`
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([folder.path, child, grandchild, deleted, `${folder.path}\\.staging`, 'C:\\Detached']))
  list.mockImplementation(async path => {
    if (path === folder.path) return listing(path, [child])
    if (path === child) return listing(path, [grandchild])
    if (path === grandchild) return listing(path)
    throw new Error('This folder is not in the workspace.')
  })
  await render()
  expect(list.mock.calls.map(([path]) => path)).toEqual([folder.path, child, grandchild])
  expect(host.textContent).not.toContain('This folder is not in the workspace.')
})

it('loads saved descendants only after their parent is expanded', async () => {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([grandchild]))
  list.mockImplementation(async path => listing(path, path === folder.path ? [child] : path === child ? [grandchild] : []))
  await render()
  expect(list.mock.calls.map(([path]) => path)).toEqual([folder.path])
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Reports"]')!.click())
  expect(list.mock.calls.map(([path]) => path)).toEqual([folder.path, child, grandchild])
})

it('keeps an unavailable root visible without attempting workspace reads', async () => {
  await render({ current: { ...folder, usable: false } })
  expect(list).not.toHaveBeenCalled()
  expect(host.textContent).toContain('unavailable')
})

it('caches a failed read until an explicit retry or invalidation', async () => {
  list.mockRejectedValue(new Error('Folder access failed.'))
  await render()
  expect(directories.get(folder.path)?.error).toBe('Folder access failed.')
  await render({ selectedPath: `${folder.path}\\report.csv` })
  await act(async () => { await directories.load(folder.path) })
  expect(list).toHaveBeenCalledTimes(1)
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click())
  expect(list).toHaveBeenCalledTimes(2)
  list.mockResolvedValue(listing(folder.path))
  await act(async () => directories.invalidate())
  expect(list).toHaveBeenCalledTimes(3)
  expect(directories.get(folder.path)?.error).toBeUndefined()
})

it('does not let a request from before refresh replace a newer folder listing', async () => {
  let finishOld!: (result: FolderListing) => void
  list.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  await render()
  list.mockResolvedValue(listing(folder.path, [child]))
  await act(async () => directories.invalidate())
  await act(async () => finishOld(listing(folder.path)))
  expect(directories.get(folder.path)?.listing?.folders.map(item => item.path)).toEqual([child])
})

it('shows a restored disconnected folder as unavailable without a loading spinner or rejected listing requests', async () => {
  const { ExplorerHome } = await import('../src/renderer/src/explorer/ExplorerHome')
  const { LAST_LOCATION_KEY } = await import('../src/renderer/src/explorer/model')
  const { LocaleProvider } = await import('../src/renderer/src/locale')
  localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ kind: 'folder', path: folder.path }))
  Object.assign(window.aiOffice, {
    workspaceRoots: vi.fn(async () => [{ ...folder, usable: false }]),
    onWorkspaceRootsChanged: () => () => {}, onFolderChanged: () => () => {},
    recents: async () => ({ entries: [], total: 0, totalAll: 0 }),
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  try {
    await act(async () => root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(ExplorerHome, { onOpenLegacy: vi.fn() }))))
    expect(list).not.toHaveBeenCalled()
    expect(host.querySelector('.ex-empty h2')?.textContent).toBe('Unavailable')
    expect(host.querySelector('.ex-spinner')).toBeNull()
    expect(host.textContent).not.toContain('This folder is not in the workspace.')
  } finally { vi.unstubAllGlobals() }
})
