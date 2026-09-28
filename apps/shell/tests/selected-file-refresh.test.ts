/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SelectedFileRefresh } from '../src/renderer/src/rag/SelectedFileRefresh'
import type { RagProgress } from '../src/shared/rag-api'

it('checks selected snapshots on demand and retries only failed files still selected', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const folder = 'C:\\Docs', first = folder + '\\a.txt', failed = folder + '\\b.txt', unselected = folder + '\\c.txt'
  const statuses = vi.fn().mockResolvedValue([{ path: first, status: 'embedded', chunks: 2, verified: true }, { path: failed, status: 'failed', chunks: 0, error: 'OCR missing' }])
  const progress: RagProgress = { scope: 'selected', folder, running: false, scanned: 3, embedded: 1, unchanged: 0, chunks: 2, failed: 2, current: '', message: 'Finished', incomplete: false, files: [{ path: first, status: 'embedded' }, { path: failed, status: 'failed' }, { path: unselected, status: 'failed' }] }
  const indexSelected = vi.fn().mockResolvedValue({ ...progress, running: true })
  Object.assign(window, { nawaRag: { statuses, indexSelected } })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!
  try {
    await act(async () => root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(SelectedFileRefresh, { folder, selectedFiles: [first, failed, 'C:\\Other\\outside.txt'], configured: true, progress, onProgress: vi.fn() }))))
    expect(statuses).not.toHaveBeenCalled()
    expect(button('Refresh selected files').disabled).toBe(true)
    await act(async () => button('Check selected files').click())
    expect(statuses).toHaveBeenCalledWith([first, failed], true)
    expect(host.textContent).toContain('Ready — snapshot verified')
    expect(host.textContent).toContain('OCR missing')
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    await act(async () => button('Retry failed files').click())
    expect(indexSelected).toHaveBeenCalledWith(folder, [failed], true)
    await act(async () => window.dispatchEvent(new Event('nawa:rag-settings-changed')))
    expect(host.textContent).not.toContain('Ready — snapshot verified')
    expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false)
  } finally { act(() => root.unmount()); host.remove() }
})

it('keeps an admitted refresh tied to its original selection and resets consent for the next selection', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const folder = 'C:\\Docs', first = folder + '\\a.txt', second = folder + '\\b.txt', onProgress = vi.fn()
  let complete!: (value: RagProgress) => void
  const indexSelected = vi.fn().mockImplementation(() => new Promise<RagProgress>(resolve => { complete = resolve }))
  Object.assign(window, { nawaRag: { indexSelected } })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const render = (selectedFiles: string[]) => act(async () => root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(SelectedFileRefresh, { folder, selectedFiles, configured: true, progress: null, onProgress }))))
  try {
    await render([first])
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh selected files')!.click())
    await render([second])
    await act(async () => complete({ folder, running: true, scanned: 0, embedded: 0, unchanged: 0, failed: 0, chunks: 0, current: first, message: 'Starting', incomplete: false }))
    expect(indexSelected).toHaveBeenCalledWith(folder, [first], true)
    expect(onProgress).toHaveBeenCalledOnce()
    expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false)
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh selected files')!.disabled).toBe(true)
  } finally { act(() => root.unmount()); host.remove() }
})
