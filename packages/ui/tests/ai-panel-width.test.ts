/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyAiPanelPrefs } from '../src/ai-panel-prefs-store'
import { clampAiPanelWidth, useAiPanelWidth } from '../src/use-ai-panel-width'
import { AiPanelResizer } from '../src/AiPanelResizer'

function Panel({ storageKey, grid = false }: { storageKey?: string; grid?: boolean }) {
  const panel = useAiPanelWidth(storageKey, true, grid ? 'sheet-grid' : 'dock')
  const { asideRef, resizing } = panel
  return createElement(
    'aside',
    { ref: asideRef, id: panel.panelId, 'data-resizing': String(resizing) },
    createElement(AiPanelResizer, { panel, lang: 'ar' }),
  )
}

let dock: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('innerWidth', 1200)
  localStorage.clear()
  applyAiPanelPrefs({ side: 'left' })
  dock = document.createElement('div')
  dock.className = 'ai-dock'
  document.body.append(dock)
  root = createRoot(dock)
})

afterEach(() => {
  act(() => root.unmount())
  dock.remove()
  localStorage.clear()
  vi.restoreAllMocks()
  applyAiPanelPrefs({})
  vi.unstubAllGlobals()
})

it('restores the preferred width after a narrow viewport', () => {
  localStorage.setItem('test-panel-width', '600')
  act(() => root.render(createElement(Panel, { storageKey: 'test-panel-width' })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('600px')

  vi.stubGlobal('innerWidth', 500)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('280px')

  vi.stubGlobal('innerWidth', 1200)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('600px')
  expect(localStorage.getItem('test-panel-width')).toBe('600')
})

it('resizes from the selected side and saves the width after drag', () => {
  applyAiPanelPrefs({ side: 'right' })
  act(() => root.render(createElement(Panel, { storageKey: 'test-panel-width' })))
  const handle = dock.querySelector('aside div') as HTMLDivElement
  handle.setPointerCapture = vi.fn()

  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 850 })
  Object.defineProperty(down, 'pointerId', { value: 1 })
  act(() => handle.dispatchEvent(down))
  act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 750 })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('460px')
  expect(dock.querySelector('aside')?.getAttribute('data-resizing')).toBe('true')

  act(() => window.dispatchEvent(new Event('pointerup')))
  expect(localStorage.getItem('test-panel-width')).toBe('460')
  expect(dock.querySelector('aside')?.getAttribute('data-resizing')).toBe('false')
  expect(document.body.style.cursor).toBe('')
})

it('keeps the minimum width when the viewport is transiently zero', () => {
  expect(clampAiPanelWidth(360, 0)).toBe(280)
})

it('resizes a preview dock offset from the window edge without jumping to the pointer position', () => {
  act(() => root.render(createElement(Panel, { storageKey: 'preview-panel-width' })))
  vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue({
    width: 360,
    left: 240,
    right: 600,
  } as DOMRect)
  const handle = dock.querySelector('aside div') as HTMLDivElement
  handle.setPointerCapture = vi.fn()
  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 597 })
  Object.defineProperty(down, 'pointerId', { value: 1 })
  act(() => handle.dispatchEvent(down))
  act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 717 })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('480px')
  act(() => window.dispatchEvent(new Event('pointerup')))
  expect(localStorage.getItem('preview-panel-width')).toBe('480')
})

it('limits preview width to its content area and restores the preference after that area widens', () => {
  let available = 800
  vi.spyOn(document.body, 'clientWidth', 'get').mockImplementation(() => available)
  localStorage.setItem('preview-panel-width', '600')
  act(() => root.render(createElement(Panel, { storageKey: 'preview-panel-width' })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('560px')
  available = 500
  act(() => window.dispatchEvent(new Event('resize')))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('280px')
  available = 1200
  act(() => window.dispatchEvent(new Event('resize')))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('600px')
  expect(localStorage.getItem('preview-panel-width')).toBe('600')
})

it.each(['left', 'right'] as const)(
  'supports accessible keyboard resizing on the %s side',
  (side) => {
    applyAiPanelPrefs({ side })
    act(() => root.render(createElement(Panel, { storageKey: 'keyboard-width' })))
    const handle = dock.querySelector('[role="separator"]') as HTMLDivElement
    expect(handle.tabIndex).toBe(0)
    expect(handle.getAttribute('aria-label')).toContain('عرض')
    expect(handle.getAttribute('aria-controls')).toBe(dock.querySelector('aside')!.id)
    const press = (key: string) =>
      act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    press('ArrowRight')
    expect(handle.getAttribute('aria-valuenow')).toBe(side === 'right' ? '350' : '370')
    press('End')
    expect(handle.getAttribute('aria-valuenow')).toBe('960')
    expect(handle.getAttribute('aria-valuemax')).toBe('960')
    press('Home')
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
    expect(localStorage.getItem('keyboard-width')).toBe('280')
  },
)

it('uses the same keyboard behavior and available-width bound in the spreadsheet grid', () => {
  dock.className = 'sheet-body'
  vi.spyOn(dock, 'clientWidth', 'get').mockReturnValue(800)
  act(() => root.render(createElement(Panel, { storageKey: 'grid-width', grid: true })))
  const handle = dock.querySelector('[role="separator"]') as HTMLDivElement
  act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(dock.style.getPropertyValue('--copilot-width')).toBe('560px')
  expect(handle.getAttribute('aria-valuemax')).toBe('560')
})

it('restores a width above the former cap after reopening and temporarily narrowing the window', () => {
  vi.stubGlobal('innerWidth', 1920)
  localStorage.setItem('wide-panel', '1200')
  act(() => root.render(createElement(Panel, { storageKey: 'wide-panel' })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('1200px')
  vi.stubGlobal('innerWidth', 800)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('560px')
  vi.stubGlobal('innerWidth', 1920)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('1200px')
  expect(localStorage.getItem('wide-panel')).toBe('1200')
})

it('drags beyond the former fixed and percentage caps while retaining space for the file', () => {
  vi.stubGlobal('innerWidth', 1600)
  act(() => root.render(createElement(Panel, { storageKey: 'wide-panel' })))
  const handle = dock.querySelector('[role="separator"]') as HTMLDivElement
  handle.setPointerCapture = vi.fn()
  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 360 })
  Object.defineProperty(down, 'pointerId', { value: 1 })
  act(() => handle.dispatchEvent(down))
  act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1300 })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('1300px')
  act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1800 })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('1360px')
  act(() => window.dispatchEvent(new Event('pointerup')))
  expect(localStorage.getItem('wide-panel')).toBe('1360')
})
