/** @vitest-environment jsdom */
import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  IndexSelectedButton,
  type SelectedFileActions,
} from '../src/renderer/src/explorer/IndexSelectedButton'
import { LocaleProvider } from '../src/renderer/src/locale'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'

function fixture() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  const listeners = new Set<() => void>()
  let running = false
  const onChanged = (callback: () => void) => {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  }
  const settings = vi.fn(async () => ({
    settings: { ...DEFAULT_RAG_SETTINGS, enabled: true, model: 'local-embed' },
  }))
  const indexSelected = vi.fn(async () => ({ running: false }))
  const prepareSelected = vi.fn(async () => ({ failedFiles: 0, blockedTables: 0 }))
  const save = vi.fn(),
    openSettings = vi.fn()
  Object.assign(window, {
    nawaRag: { settings, indexSelected, progress: async () => ({ running }), onChanged, save },
    nawaAnalytics: {
      prepareSelected,
      progress: async () => ({ running: false }),
      onChanged,
      saveSettings: save,
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host),
    folder = 'C:\\Docs',
    first = folder + '\\sales.xlsx',
    second = folder + '\\notes.docx'
  const actionsRef = createRef<SelectedFileActions>()
  const render = (paths = [first, second]) =>
    act(async () =>
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(IndexSelectedButton, {
            folder,
            selectedFiles: paths,
            onOpenSettings: openSettings,
            actionsRef,
          }),
        ),
      ),
    )
  const button = () => host.querySelector<HTMLButtonElement>('.nawa-index-selected')!
  const click = () =>
    act(async () => {
      button().click()
    })
  const close = () => {
    act(() => root.unmount())
    host.remove()
  }
  const busy = (value: boolean) =>
    act(async () => {
      running = value
      listeners.forEach((callback) => callback())
    })
  return {
    host,
    folder,
    first,
    second,
    render,
    button,
    click,
    close,
    busy,
    settings,
    indexSelected,
    prepareSelected,
    save,
    openSettings,
    actionsRef,
  }
}

it('indexes selected files and prepares only their tables without changing settings', async () => {
  const f = fixture()
  try {
    await f.render()
    await f.click()
    expect(f.indexSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first, f.second], true)
    expect(f.prepareSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first])
    expect(f.save).not.toHaveBeenCalled()
    expect(f.button().disabled).toBe(false)
  } finally {
    f.close()
  }
})

it('prepares tables when embeddings are unconfigured and provides a direct settings link', async () => {
  const f = fixture()
  try {
    f.settings.mockResolvedValue({
      settings: { ...DEFAULT_RAG_SETTINGS, enabled: false, model: '' },
    })
    f.indexSelected.mockRejectedValue(
      new Error('Choose an embedding model in Knowledge settings, then click Index again.'),
    )
    await f.render()
    await f.click()
    expect(f.prepareSelected).toHaveBeenCalledOnce()
    expect(f.indexSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first, f.second], true)
    expect(document.querySelector('dialog[open]')).toBeNull()
    await act(async () => f.host.querySelector<HTMLButtonElement>('.nawa-index-warning')!.click())
    expect(document.querySelector('dialog[open]')?.textContent).toContain(
      'Choose an embedding model',
    )
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
        .find((button) => button.textContent === 'Knowledge settings')!
        .click(),
    )
    expect(f.openSettings).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})

it('keeps the invocation scope when selection changes and prevents duplicate clicks', async () => {
  const f = fixture()
  try {
    let finish!: (value: { failedFiles: number; blockedTables: number }) => void
    f.prepareSelected.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await f.render()
    await act(async () => {
      f.button().click()
      f.button().click()
    })
    await f.render([f.second])
    expect(f.button().disabled).toBe(true)
    expect(f.indexSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first, f.second], true)
    expect(f.prepareSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first])
    await act(async () => finish({ failedFiles: 0, blockedTables: 0 }))
    await f.busy(true)
    expect(f.button().disabled).toBe(true)
    await f.busy(false)
    expect(f.button().disabled).toBe(false)
  } finally {
    f.close()
  }
})

it('blocks empty, oversized, or outside-folder selections before invoking either engine', async () => {
  const f = fixture()
  try {
    for (const paths of [
      [],
      [f.first, 'C:\\Other\\private.xlsx'],
      Array.from({ length: 257 }, (_, i) => f.folder + `\\file-${i}.xlsx`),
    ]) {
      await f.render(paths)
      expect(f.button().disabled).toBe(true)
      await f.click()
    }
    expect(f.indexSelected).not.toHaveBeenCalled()
    expect(f.prepareSelected).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})

it('starts embeddings even when table preparation fails and reports the failure', async () => {
  const f = fixture()
  try {
    f.prepareSelected.mockRejectedValue(new Error('Selected source changed. Retry.'))
    await f.render()
    await f.click()
    expect(f.indexSelected).toHaveBeenCalledOnce()
    expect(document.querySelector('dialog[open]')).toBeNull()
    await act(async () => f.host.querySelector<HTMLButtonElement>('.nawa-index-warning')!.click())
    expect(document.querySelector('dialog[open]')?.textContent).toContain(
      'Selected source changed. Retry.',
    )
  } finally {
    f.close()
  }
})

it('prepares the captured context-menu tables without embedding settings or the toolbar selection', async () => {
  const f = fixture()
  try {
    await f.render([f.second])
    await act(async () => f.actionsRef.current!.prepare(f.folder, [f.first, f.second], 'analysis'))
    expect(f.prepareSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first])
    expect(f.settings).not.toHaveBeenCalled()
    expect(f.indexSelected).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})

it('shares the context-menu lock with the toolbar and captures another authorized directory', async () => {
  const f = fixture()
  try {
    const otherFolder = 'C:\\Other',
      otherFile = otherFolder + '\\sales.csv'
    let finish!: (value: { failedFiles: number; blockedTables: number }) => void
    f.prepareSelected.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await f.render()
    await act(async () => {
      void f.actionsRef.current!.prepare(otherFolder, [otherFile], 'analysis')
      f.button().click()
    })
    await f.render([f.second])
    expect(f.prepareSelected).toHaveBeenCalledExactlyOnceWith(otherFolder, [otherFile])
    expect(f.indexSelected).not.toHaveBeenCalled()
    await act(async () => finish({ failedFiles: 0, blockedTables: 0 }))
  } finally {
    f.close()
  }
})

it('rejects invalid context scopes and deduplicates Windows path aliases before any engine runs', async () => {
  const f = fixture()
  try {
    await f.render()
    for (const paths of [
      [],
      [f.first, 'C:\\Other\\secret.csv'],
      Array.from({ length: 257 }, (_, i) => f.folder + `\\${i}.csv`),
    ]) {
      await act(async () => f.actionsRef.current!.prepare(f.folder, paths))
    }
    expect(f.prepareSelected).not.toHaveBeenCalled()
    expect(f.indexSelected).not.toHaveBeenCalled()
    await act(async () =>
      f.actionsRef.current!.prepare(f.folder, [f.first, f.first.toUpperCase()], 'analysis'),
    )
    expect(f.prepareSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.first.toUpperCase()])
  } finally {
    f.close()
  }
})

it('skips analytics for narrative files and keeps MyAgent format support separate', async () => {
  const f = fixture()
  try {
    await f.render([f.second])
    await f.click()
    expect(f.prepareSelected).not.toHaveBeenCalled()
    expect(f.indexSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [f.second], true)
    f.indexSelected.mockClear()
    f.settings.mockResolvedValue({
      settings: { ...DEFAULT_RAG_SETTINGS, backend: 'myagent', enabled: true },
    })
    const legacy = f.folder + '\\old.xls'
    await act(async () => f.actionsRef.current!.prepare(f.folder, [legacy]))
    expect(f.indexSelected).toHaveBeenCalledExactlyOnceWith(f.folder, [legacy], true)
    expect(f.prepareSelected).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})
