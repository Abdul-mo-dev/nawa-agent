/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { MyAgentDocumentTools } from '../src/renderer/src/myagent/MyAgentDocumentTools'

it('loads on opening, filters by extensions, searches and pages metadata while keeping descriptions optional', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const page = (name: string, nextOffset: number | null = null) => ({ serverUrl: 'http://127.0.0.1:5187', checkedAt: '2026-09-28', filtered: true, total: 2, nextOffset, tools: [{ name, description: 'A long explanation.', inputSchema: { type: 'object' } }] })
  const documentTools = vi.fn().mockResolvedValueOnce(page('spreadsheet_catalog_search', 1)).mockResolvedValueOnce(page('spreadsheet_query_sql')).mockResolvedValueOnce({ ...page('pdf_search'), total: 1 })
  Object.assign(window, { nawaMyAgent: { documentTools } })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const render = (active: boolean) => act(async () => root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(MyAgentDocumentTools, { active, disabled: false, selectedFiles: ['C:\\Docs\\table.xlsx', 'C:\\Docs\\copy.XLSX'] }))))
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!
  try {
    await render(false); expect(documentTools).not.toHaveBeenCalled()
    await render(true); expect(documentTools).toHaveBeenCalledWith({ query: '', offset: 0, extensions: ['.xlsx'] })
    expect(host.querySelector<HTMLDetailsElement>('.nawa-document-tool-list details')!.open).toBe(false)
    await act(async () => button('Load more tools').click())
    expect(documentTools).toHaveBeenLastCalledWith({ query: '', offset: 1, extensions: ['.xlsx'] })
    expect(host.querySelectorAll('.nawa-document-tool-list>li')).toHaveLength(2)
    await act(async () => {
      const scope = host.querySelector<HTMLSelectElement>('select')!
      scope.value = 'server'; scope.dispatchEvent(new Event('change', { bubbles: true }))
      const query = host.querySelector<HTMLInputElement>('input')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, 'pdf')
      query.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(documentTools).toHaveBeenLastCalledWith({ query: 'pdf', offset: 0 })
    expect(host.querySelectorAll('.nawa-document-tool-list>li')).toHaveLength(1)
  } finally { act(() => root.unmount()); host.remove() }
})

it('discards an in-flight result after the saved connection changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let complete!: (value: unknown) => void
  const documentTools = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve }))
  Object.assign(window, { nawaMyAgent: { documentTools } })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(MyAgentDocumentTools, { active: true, disabled: false }))))
    await act(async () => window.dispatchEvent(new Event('nawa:rag-settings-changed')))
    await act(async () => complete({ serverUrl: 'old-server', checkedAt: '', filtered: false, total: 1, nextOffset: null, tools: [{ name: 'old_tool', description: '', inputSchema: {} }] }))
    expect(host.textContent).not.toContain('old_tool')
    expect(documentTools).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); host.remove() }
})
