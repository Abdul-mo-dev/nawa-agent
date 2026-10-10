/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { RagSettings } from '../src/renderer/src/rag/RagSettings'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'

it('preserves an existing built-in model until the user switches to llama.cpp', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const test = vi.fn(async () => ({ dimensions: 384, message: 'Native model ready.' }))
  Object.assign(window, {
    nawaRag: {
      settings: async () => ({
        settings: { ...DEFAULT_RAG_SETTINGS, backend: 'native', model: 'Xenova/multilingual-e5-small', dimensions: 384, documentPrefix: 'passage: ', queryPrefix: 'query: ' },
        hasKey: false,
        databasePath: 'rag.sqlite3',
      }),
      test,
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(RagSettings))),
    )
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Search engine"]')?.value).toBe(
      'native',
    )
    expect(host.querySelector('input[aria-label="Server address"]')).toBeNull()
    expect(host.querySelector('input[aria-label="MyAgent server URL"]')).toBeNull()
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === 'Download / test model',
    )!
    await act(async () => button.click())
    expect(test).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('Native model ready.')
    await act(async () => [...host.querySelectorAll('button')].find(item => item.textContent === 'Use llama.cpp')!.click())
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Embedding model"]')?.value).toBe('')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Document prefix"]')?.value).toBe('')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Query prefix / instruction"]')?.value).toBe('')
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Search engine"]')?.value).toBe('local')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Server address"]')?.value).toBe(DEFAULT_RAG_SETTINGS.baseUrl)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
