/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { RagAnalyticsPanel } from '../src/renderer/src/explorer/RagAnalyticsPanel'
import { DEFAULT_RAG_SETTINGS, type RagProgress } from '../src/shared/rag-api'
import { DEFAULT_ANALYTICS_SETTINGS } from '../src/shared/analytics-api'
import { snapshot } from './fixtures/myagent-settings'

function fixture() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const folder = 'C:\\Docs', path = folder + '\\survey.xlsx'
  const progress: RagProgress = { folder, running: false, scanned: 0, embedded: 0, failed: 0, chunks: 0, unchanged: 0, current: '', message: '', incomplete: false }
  const inspect = vi.fn().mockResolvedValue(structuredClone(snapshot)), diagnostics = vi.fn(), cancel = vi.fn(), statuses = vi.fn()
  const listeners = new Set<() => void>()
  Object.assign(window, {
    nawaRag: {
      settings: async () => ({ settings: { ...DEFAULT_RAG_SETTINGS, enabled: true }, hasKey: true, databasePath: 'mappings.json' }),
      progress: async () => ({ ...progress }), onChanged: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
      indexSelected: vi.fn().mockImplementation(async () => { Object.assign(progress, { running: true, scope: 'selected', files: [{ path, status: 'indexing' }] }); return { ...progress } }),
      cancel, statuses,
    },
    nawaAnalytics: { settings: async () => ({ settings: DEFAULT_ANALYTICS_SETTINGS, databasePath: 'analysis.sqlite' }), catalog: async () => ({ datasets: [], total: 0, nextOffset: null }), progress: async () => ({ running: false }), onChanged: () => () => {} },
    nawaMyAgent: { inspect, diagnostics, local: async () => ({ settings: { mode: 'process', serverPath: '', configurationDirectory: 'C:\\MyAgent' }, serviceState: 'stopped', processId: null }) },
  })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const visible = (element: Element) => !element.closest('[hidden]')
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => visible(element) && element.textContent === label)!
  const click = (label: string) => act(async () => button(label).click())
  const set = (element: HTMLInputElement | HTMLSelectElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
  const area = (value: string) => set(host.querySelector<HTMLSelectElement>('select[aria-label="Settings area"]')!, value)
  const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const render = () => act(async () => root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(RagAnalyticsPanel, { folder, selectedFiles: [path], onAddFolder: vi.fn() }))))
  const close = () => { act(() => root.unmount()); host.remove() }
  return { host, progress, listeners, inspect, diagnostics, statuses, cancel, visible, button, click, set, area, input, render, close }
}

it('provides one connection form and keeps settings drafts across views while blocking actions for an unsaved connection', async () => {
  const f = fixture()
  try {
    await f.render()
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.statuses).not.toHaveBeenCalled()
    expect(f.host.querySelector<HTMLDetailsElement>('.nawa-directory-indexing')!.open).toBe(false)
    await f.click('Setup'); await f.area('models')
    expect(f.inspect).toHaveBeenCalledOnce(); expect(f.diagnostics).not.toHaveBeenCalled()
    expect(f.host.querySelectorAll('input[aria-label="MyAgent server URL"]')).toHaveLength(1)
    expect(f.visible(f.input('Tesseract OCR executable path'))).toBe(false)
    await f.set(f.input('MyAgent chat model'), 'retained-chat')
    await f.area('extraction'); await f.set(f.input('Tesseract OCR executable path'), 'C:\\OCR\\tesseract.exe')
    await f.click('Files')
    expect(f.button('Setup · Unsaved MyAgent settings')).toBeTruthy()
    await f.click('Setup · Unsaved MyAgent settings')
    expect(f.visible(f.input('Tesseract OCR executable path'))).toBe(true)
    expect(f.input('Tesseract OCR executable path').value).toBe('C:\\OCR\\tesseract.exe')
    await f.area('models'); expect(f.input('MyAgent chat model').value).toBe('retained-chat')
    await f.click('Discard server changes'); await f.area('connection')
    await f.set(f.input('MyAgent server URL'), 'http://127.0.0.1:6000')
    await f.area('status')
    expect(f.button('Check readiness').disabled).toBe(true)
    expect(f.button('Start server').disabled).toBe(true)
    await f.area('connection'); await f.click('Discard changes'); await f.area('status')
    expect(f.button('Start server').disabled).toBe(false)
    expect(f.inspect).toHaveBeenCalledOnce()
  } finally { f.close() }
})

it('keeps a selected-file job running and reachable when navigating to setup', async () => {
  const f = fixture()
  try {
    await f.render()
    await act(async () => f.host.querySelector<HTMLInputElement>('.nawa-selected-refresh input[type=checkbox]')!.click())
    await f.click('Refresh selected files'); await f.click('Setup')
    expect(f.cancel).not.toHaveBeenCalled()
    const job = [...f.host.querySelectorAll<HTMLButtonElement>('.nawa-knowledge-notice')].find(button => button.textContent?.includes('Files · Indexing'))!
    expect(job).toBeTruthy()
    await act(async () => job.click())
    expect(f.button('Stop indexing')).toBeTruthy()
    await f.click('Tables'); await f.click('Setup')
    expect(f.cancel).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('suspends the shared connection form during server work without discarding the readiness result', async () => {
  const f = fixture()
  let complete!: (value: unknown) => void
  f.diagnostics.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  try {
    await f.render(); await f.click('Setup'); await f.area('status'); await f.click('Check readiness')
    await f.area('connection')
    expect(f.input('MyAgent server URL').disabled).toBe(true)
    expect(f.button('Generate new service key').disabled).toBe(true)
    await act(async () => complete({ serverUrl: snapshot.serverUrl, checkedAt: '2026-09-28T10:00:00Z', health: snapshot.health, readiness: { ready: true, status: 'Available', providerAvailable: true, startsOnDemand: false }, warnings: [] }))
    expect(f.input('MyAgent server URL').disabled).toBe(false)
    await f.area('status')
    expect([...f.host.querySelectorAll('[role=status]')].some(element => f.visible(element) && element.textContent?.includes('Chat model ready'))).toBe(true)
  } finally { f.close() }
})
