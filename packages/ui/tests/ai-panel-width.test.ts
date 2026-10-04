/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyAiPanelPrefs } from '../src/ai-panel-prefs-store'
import { clampAiPanelWidth, useAiPanelWidth } from '../src/use-ai-panel-width'

function Panel({ storageKey }: { storageKey?: string }) {
  const { asideRef, resizing, startResize } = useAiPanelWidth(storageKey)
  return createElement(
    'aside',
    { ref: asideRef, 'data-resizing': String(resizing) },
    createElement('div', { onPointerDown: startResize }),
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
  applyAiPanelPrefs({})
  vi.unstubAllGlobals()
})

it('restores the preferred width after a narrow viewport', () => {
  localStorage.setItem('test-panel-width', '600')
  act(() => root.render(createElement(Panel, { storageKey: 'test-panel-width' })))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('600px')

  vi.stubGlobal('innerWidth', 500)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('300px')

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
  expect(dock.style.getPropertyValue('--ai-panel-width')).toBe('450px')
  expect(dock.querySelector('aside')?.getAttribute('data-resizing')).toBe('true')

  act(() => window.dispatchEvent(new Event('pointerup')))
  expect(localStorage.getItem('test-panel-width')).toBe('450')
  expect(dock.querySelector('aside')?.getAttribute('data-resizing')).toBe('false')
  expect(document.body.style.cursor).toBe('')
})

it('keeps the minimum width when the viewport is transiently zero', () => {
  expect(clampAiPanelWidth(360, 0)).toBe(280)
})
