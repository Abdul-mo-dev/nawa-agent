/** @vitest-environment jsdom */
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'
import { WorkspaceControlPanel } from '../src/renderer/src/explorer/WorkspaceControlPanel'
import { DEFAULT_RAG_SETTINGS } from '../src/shared/rag-api'
import { DEFAULT_ANALYTICS_SETTINGS } from '../src/shared/analytics-api'

function fixture() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const saved = { ...DEFAULT_RAG_SETTINGS, model: 'embed-old', enabled: true }
  const statuses = vi.fn(),
    inspect = vi.fn(),
    onClose = vi.fn()
  const save = vi.fn(async (settings) => ({
    settings,
    hasKey: false,
    databasePath: 'local.sqlite',
  }))
  const models = vi.fn(async () => ['embed-loaded'])
  const test = vi.fn(async () => ({ dimensions: 768, message: 'Embeddings verified.' }))
  Object.assign(window, {
    aiOffice: {
      getTheme: async () => 'system',
      getDefaultSaveDir: async () => '',
      getAnalyticsEnabled: async () => true,
      getAutoSaveDefault: async () => ({ on: false }),
      getAiPanelPrefs: async () => ({ fontSize: 'default', spellcheck: true }),
      getUpdateChannel: async () => 'stable',
      getAppVersion: async () => '1.0.0',
    },
    nawaRag: {
      settings: async () => ({ settings: saved, hasKey: false, databasePath: 'local.sqlite' }),
      save,
      models,
      test,
      statuses,
      progress: async () => ({ running: false }),
      onChanged: () => () => {},
    },
    nawaAnalytics: {
      settings: async () => ({
        settings: DEFAULT_ANALYTICS_SETTINGS,
        databasePath: 'tables.sqlite',
      }),
      saveSettings: vi.fn(),
      statuses,
      progress: async () => ({ running: false }),
      onChanged: () => () => {},
    },
    nawaMyAgent: { inspect },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function App() {
    const [open, setOpen] = useState(false)
    return createElement(
      'div',
      {},
      createElement(WorkspaceControlPanel, {
        folder: 'C:\\Docs',
        closeLabel: 'Hide chat',
        assistant: createElement('p', {}, 'Ask about your files'),
        onClose: vi.fn(),
        onOpenSettings: () => setOpen(true),
      }),
      open &&
        createElement(SettingsModal, {
          initialSection: 'knowledge',
          status: null,
          loggingOut: false,
          loginWaiting: false,
          loginUrl: null,
          urlCopied: false,
          onClose: () => {
            onClose()
            setOpen(false)
          },
          onOpenLoginUrl: vi.fn(),
          onCopyLoginUrl: vi.fn(),
          onLogin: vi.fn(),
          onLogout: vi.fn(),
        }),
    )
  }
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === text && !node.closest('[hidden]'),
    )!
  const click = (text: string) => act(async () => button(text).click())
  const input = (label: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const fill = (element: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        element,
        value,
      )
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const render = () =>
    act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(App))),
    )
  const open = () =>
    act(async () => host.querySelector<HTMLButtonElement>('.nawa-workspace-settings')!.click())
  const close = () => {
    act(() => root.unmount())
    host.remove()
  }
  return {
    host,
    render,
    open,
    close,
    click,
    input,
    fill,
    button,
    save,
    test,
    models,
    statuses,
    inspect,
    onClose,
  }
}

it('opens the main Settings Knowledge tab from chat without duplicated setup or file status', async () => {
  const f = fixture()
  try {
    await f.render()
    expect(f.host.querySelector('.set-overlay')).toBeNull()
    await f.open()
    expect(f.host.querySelector('.set-nav-item.active')?.textContent).toBe('Knowledge')
    expect(f.input('Server address')).toBeNull()
    expect(f.host.querySelector<HTMLDetailsElement>('.nawa-analysis-limits')?.open).toBe(false)
    await f.click('Configure models in AI & Models')
    expect(f.host.querySelector('.set-nav-item.active')?.textContent).toBe('AI & Models')
    expect(f.input('Server address').value).toBe(DEFAULT_RAG_SETTINGS.baseUrl)
    expect(f.host.querySelector('.nawa-workspace-control-panel .nawa-rag-settings')).toBeNull()
    expect(f.host.querySelectorAll('input[aria-label="Server address"]')).toHaveLength(1)
    expect(f.host.querySelectorAll('[role="tab"]')).toHaveLength(0)
    expect(f.host.querySelector<HTMLDetailsElement>('.nawa-embedding-advanced')?.open).toBe(false)
    expect(f.inspect).not.toHaveBeenCalled()
    expect(f.statuses).not.toHaveBeenCalled()
    expect(f.models).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})

it('keeps the embedding draft between main sections and protects it after a failed save', async () => {
  const f = fixture()
  try {
    await f.render()
    await f.open()
    await f.click('Configure models in AI & Models')
    await f.fill(f.input('Server address'), 'http://127.0.0.1:8099/v1')
    await f.click('General')
    await f.click('Knowledge')
    await f.click('Configure models in AI & Models')
    expect(f.input('Server address').value).toBe('http://127.0.0.1:8099/v1')
    f.save.mockRejectedValueOnce(new Error('Connection settings could not be saved'))
    await f.click('Save')
    expect(f.host.textContent).toContain('Connection settings could not be saved')
    await act(async () => f.host.querySelector<HTMLButtonElement>('.set-close')!.click())
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.host.textContent).toContain('Discard unsaved settings?')
    await f.click('Keep editing')
    expect(f.input('Server address').value).toBe('http://127.0.0.1:8099/v1')
    await f.click('Discard changes')
    await act(async () => f.host.querySelector<HTMLButtonElement>('.set-close')!.click())
    expect(f.onClose).toHaveBeenCalledOnce()
  } finally {
    f.close()
  }
})

it('loads the served llama.cpp model and tests and saves that same embedding configuration', async () => {
  const f = fixture()
  try {
    await f.render()
    await f.open()
    await f.click('Configure models in AI & Models')
    await f.click('Load models')
    expect(f.models).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'local',
        tokenizer: 'llama.cpp',
        baseUrl: DEFAULT_RAG_SETTINGS.baseUrl,
      }),
      undefined,
    )
    expect(f.input('Embedding model').value).toBe('embed-loaded')
    await f.click('Test connection')
    await f.click('Save')
    expect(f.test).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'embed-loaded',
        dimensions: 0,
        documentPrefix: '',
        queryPrefix: '',
      }),
      undefined,
    )
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'embed-loaded', backend: 'local' }),
      undefined,
    )
    expect(f.host.textContent).toContain('Settings saved.')
    expect(f.host.querySelector('[role="status"]')?.textContent).not.toContain('Unsaved')
  } finally {
    f.close()
  }
})
