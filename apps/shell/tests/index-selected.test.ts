/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { IndexSelectedButton } from '../src/renderer/src/explorer/IndexSelectedButton'
import { LocaleProvider } from '../src/renderer/src/locale'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'

function fixture() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  const listeners = new Set<() => void>()
  let running = false
  const onChanged = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } }
  const settings = vi.fn(async () => ({ settings: { ...DEFAULT_RAG_SETTINGS, enabled: true, model: 'local-embed' } }))
  const indexSelected = vi.fn(async () => ({ running: false }))
  const prepareSelected = vi.fn(async () => ({ failedFiles: 0, blockedTables: 0 }))
  const save = vi.fn(), openSettings = vi.fn()
  Object.assign(window, {
    nawaRag: { settings, indexSelected, progress: async () => ({ running }), onChanged, save },
    nawaAnalytics: { prepareSelected, progress: async () => ({ running: false }), onChanged, saveSettings: save },
  })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), folder = 'C:\\Docs', first = folder + '\\sales.xlsx', second = folder + '\\notes.docx'
  const render = (paths = [first, second]) => act(async () => root.render(createElement(LocaleProvider, { initial: 'en' },
    createElement(IndexSelectedButton, { folder, selectedFiles: paths, onOpenSettings: openSettings }))))
  const button = () => host.querySelector<HTMLButtonElement>('.nawa-index-selected')!
  const click = () => act(async () => { button().click() })
  const close = () => { act(() => root.unmount()); host.remove() }
  const busy = (value: boolean) => act(async () => { running = value; listeners.forEach(callback => callback()) })
  return { host, folder, first, second, render, button, click, close, busy, settings, indexSelected, prepareSelected, save, openSettings }
}

it('indexes and prepares the same selected files directly without changing settings', async () => {
  const f = fixture()
  try {
    await f.render(); await f.click()
    expect(f.indexSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first, f.second], true)
    expect(f.prepareSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first, f.second])
    expect(f.save).not.toHaveBeenCalled()
    expect(f.button().disabled).toBe(false)
  } finally { f.close() }
})

it('prepares tables when embeddings are unconfigured and provides a direct settings link', async () => {
  const f = fixture()
  try {
    f.settings.mockResolvedValue({ settings: { ...DEFAULT_RAG_SETTINGS, enabled: false, model: '' } })
    await f.render(); await f.click()
    expect(f.prepareSelected).toHaveBeenCalledOnce(); expect(f.indexSelected).not.toHaveBeenCalled()
    expect(document.querySelector('dialog[open]')?.textContent).toContain('Choose an embedding model')
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(button => button.textContent === 'Knowledge settings')!.click())
    expect(f.openSettings).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('keeps the invocation scope when selection changes and prevents duplicate clicks', async () => {
  const f = fixture()
  try {
    let finish!: (value: { failedFiles: number; blockedTables: number }) => void
    f.prepareSelected.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await f.render()
    await act(async () => { f.button().click(); f.button().click() })
    await f.render([f.second]); expect(f.button().disabled).toBe(true)
    expect(f.indexSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first, f.second], true)
    expect(f.prepareSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first, f.second])
    await act(async () => finish({ failedFiles: 0, blockedTables: 0 }))
    await f.busy(true); expect(f.button().disabled).toBe(true)
    await f.busy(false); expect(f.button().disabled).toBe(false)
  } finally { f.close() }
})

it('blocks empty, oversized, or outside-folder selections before invoking either engine', async () => {
  const f = fixture()
  try {
    for (const paths of [[], [f.first, 'C:\\Other\\private.xlsx'], Array.from({ length: 257 }, (_, i) => f.folder + `\\file-${i}.xlsx`)]) {
      await f.render(paths); expect(f.button().disabled).toBe(true); await f.click()
    }
    expect(f.indexSelected).not.toHaveBeenCalled(); expect(f.prepareSelected).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('starts embeddings even when table preparation fails and reports the failure', async () => {
  const f = fixture()
  try {
    f.prepareSelected.mockRejectedValue(new Error('Selected source changed. Retry.'))
    await f.render(); await f.click()
    expect(f.indexSelected).toHaveBeenCalledOnce()
    expect(document.querySelector('dialog[open]')?.textContent).toContain('Selected source changed. Retry.')
  } finally { f.close() }
})
