/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SelectedFileRefresh } from '../src/renderer/src/rag/SelectedFileRefresh'
import type { RagProgress } from '../src/shared/rag-api'

function statusApis(statuses: (paths: string[], verify: boolean) => Promise<unknown>) {
  Object.assign(window, {
    nawaRag: { statuses, onChanged: () => () => {} },
    nawaAnalytics: {
      statuses: vi.fn(async (paths: string[]) =>
        paths.map((path) => ({ path, state: 'unsupported', tables: 0, rows: 0, message: '' })),
      ),
      onChanged: () => () => {},
    },
  })
}

it('keeps readiness in Explorer and retries only failed selected files', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const folder = 'C:\\Docs',
    first = folder + '\\a.txt',
    failed = folder + '\\b.txt',
    unselected = folder + '\\c.txt'
  const statuses = vi.fn(async (_paths: string[], verify: boolean) => [
    { path: first, status: 'embedded', chunks: 2, verified: verify },
    { path: failed, status: 'failed', chunks: 0, error: 'OCR missing' },
  ])
  const progress: RagProgress = {
    scope: 'selected',
    folder,
    running: false,
    scanned: 3,
    embedded: 1,
    unchanged: 0,
    chunks: 2,
    failed: 2,
    current: '',
    message: 'Finished',
    incomplete: false,
    files: [
      { path: first, status: 'embedded' },
      { path: failed, status: 'failed' },
      { path: unselected, status: 'failed' },
    ],
  }
  const indexSelected = vi.fn().mockResolvedValue({ ...progress, running: true })
  statusApis(statuses)
  Object.assign(window.nawaRag, { indexSelected })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label,
    )!
  try {
    await act(async () =>
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(SelectedFileRefresh, {
            folder,
            selectedFiles: [first, failed, 'C:\\Other\\outside.txt'],
            backend: 'local',
            configured: true,
            progress,
            onProgress: vi.fn(),
          }),
        ),
      ),
    )
    expect(statuses).toHaveBeenCalledWith([first, failed], false)
    expect(host.querySelector('.nawa-rag-file-results')).toBeNull()
    expect(host.textContent).not.toContain('Tables:')
    expect(button('Refresh selected files').disabled).toBe(true)
    expect(button('Verify selected files')).toBeUndefined()
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    await act(async () => button('Retry failed files').click())
    expect(indexSelected).toHaveBeenCalledWith(folder, [failed], true)
    await act(async () => window.dispatchEvent(new Event('nawa:rag-settings-changed')))
    expect(host.textContent).not.toContain('Ready — snapshot verified')
    expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

it('keeps an admitted refresh tied to its original selection and resets consent for the next selection', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const folder = 'C:\\Docs',
    first = folder + '\\a.txt',
    second = folder + '\\b.txt',
    onProgress = vi.fn()
  let complete!: (value: RagProgress) => void
  const indexSelected = vi.fn().mockImplementation(
    () =>
      new Promise<RagProgress>((resolve) => {
        complete = resolve
      }),
  )
  statusApis(async (paths) => paths.map((path) => ({ path, status: 'not-indexed', chunks: 0 })))
  Object.assign(window.nawaRag, { indexSelected })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = (selectedFiles: string[]) =>
    act(async () =>
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(SelectedFileRefresh, {
            folder,
            selectedFiles,
            backend: 'myagent',
            configured: true,
            progress: null,
            onProgress,
          }),
        ),
      ),
    )
  try {
    await render([first])
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Refresh selected files')!
        .click(),
    )
    await render([second])
    await act(async () =>
      complete({
        folder,
        running: true,
        scanned: 0,
        embedded: 0,
        unchanged: 0,
        failed: 0,
        chunks: 0,
        current: first,
        message: 'Starting',
        incomplete: false,
      }),
    )
    expect(indexSelected).toHaveBeenCalledWith(folder, [first], true)
    expect(onProgress).toHaveBeenCalledOnce()
    expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false)
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Refresh selected files',
      )!.disabled,
    ).toBe(true)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

it('allows an explicit native indexing action without a repeated consent checkbox', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const folder = 'C:\\Docs', path = folder + '\\a.txt'
  const indexSelected = vi.fn(async () => ({ running: true, folder }))
  statusApis(async () => [{ path, status: 'not-indexed', chunks: 0 }])
  Object.assign(window.nawaRag, { indexSelected })
  const host = document.createElement('div'), root = createRoot(host)
  document.body.append(host)
  try {
    await act(async () => root.render(createElement(LocaleProvider, { initial: 'en' },
      createElement(SelectedFileRefresh, { folder, selectedFiles: [path], backend: 'native', configured: true, progress: null, onProgress: vi.fn() }))))
    expect(host.querySelector('input[type=checkbox]')).toBeNull()
    const refresh = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh selected files')!
    expect(refresh.disabled).toBe(false)
    await act(async () => refresh.click())
    expect(indexSelected).toHaveBeenCalledWith(folder, [path], true)
  } finally { act(() => root.unmount()); host.remove() }
})
