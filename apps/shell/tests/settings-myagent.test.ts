/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'
import { snapshot } from './fixtures/myagent-settings'

it('opens MyAgent from Settings and retains the server draft across section changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const inspect = vi.fn().mockResolvedValue(structuredClone(snapshot))
  Object.assign(window, {
    aiOffice: { getTheme: async () => 'system', getDefaultSaveDir: async () => '', getAnalyticsEnabled: async () => true, getAutoSaveDefault: async () => ({ on: false }), getAiPanelPrefs: async () => ({ fontSize: 'default', spellcheck: true }), getUpdateChannel: async () => 'stable', getAppVersion: async () => '1.0.0' },
    nawaRag: { settings: async () => ({ settings: DEFAULT_RAG_SETTINGS, hasKey: true, databasePath: 'fixture.json' }) },
    nawaMyAgent: { inspect, local: async () => ({ settings: { mode: 'process', serverPath: '', configurationDirectory: 'C:\\MyAgent' }, serviceState: 'not-installed', processId: null }) },
  })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const nav = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.set-nav-item')].find(button => button.textContent === label)!
  const click = async (label: string) => { await act(async () => { nav(label).click() }) }
  try {
    await act(async () => root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(SettingsModal, { status: null, loggingOut: false, loginWaiting: false, loginUrl: null, urlCopied: false, onOpenLoginUrl: vi.fn(), onCopyLoginUrl: vi.fn(), onClose: vi.fn(), onLogin: vi.fn(), onLogout: vi.fn() }))))
    expect(inspect).not.toHaveBeenCalled()
    await click('MyAgent')
    const input = host.querySelector<HTMLInputElement>('input[aria-label="MyAgent chat model"]')!
    expect(input).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'retained-draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('General'); await click('MyAgent')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="MyAgent chat model"]')?.value).toBe('retained-draft')
    expect(inspect).toHaveBeenCalledTimes(1)
    expect([...host.querySelectorAll('button')].find(button => button.textContent === 'Save server settings')?.disabled).toBe(false)
  } finally { act(() => root.unmount()); host.remove() }
})
