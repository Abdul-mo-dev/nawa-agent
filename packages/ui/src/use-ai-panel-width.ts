import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject, HTMLAttributes } from 'react'
import { useAiPanelPrefs } from './ai-panel-prefs-store'

const DEFAULT_WIDTH = 360
const MIN_WIDTH = 280
const MIN_CONTENT_WIDTH = 240

function clampPreferredWidth(width: number): number {
  return Math.max(width, MIN_WIDTH)
}

/** Keep the preferred width even while a temporarily narrow viewport displays less. */
export function clampAiPanelWidth(width: number, viewportWidth: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(viewportWidth - MIN_CONTENT_WIDTH))
  return Math.min(Math.max(width, MIN_WIDTH), max)
}

function loadPreferredWidth(storageKey?: string): number {
  if (!storageKey) return DEFAULT_WIDTH
  const saved = Number(localStorage.getItem(storageKey))
  return Number.isFinite(saved) && saved > 0 ? clampPreferredWidth(saved) : DEFAULT_WIDTH
}

export interface AiPanelWidth {
  panelId: string
  asideRef: RefObject<HTMLElement | null>
  resizing: boolean
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void
  resizerProps: Pick<
    HTMLAttributes<HTMLDivElement>,
    'tabIndex' | 'onKeyDown' | 'aria-valuenow' | 'aria-valuemin' | 'aria-valuemax'
  >
}

/** Shared dock width, pointer drag, and optional per-app persistence. */
export function useAiPanelWidth(
  storageKey?: string,
  open?: boolean,
  layout: 'dock' | 'sheet-grid' = 'dock',
): AiPanelWidth {
  const { side } = useAiPanelPrefs()
  const panelId = useId()
  const [preferredWidth] = useState(() => loadPreferredWidth(storageKey))
  const preferredWidthRef = useRef(preferredWidth)
  const [panelWidth, setPanelWidth] = useState(() =>
    clampAiPanelWidth(preferredWidth, window.innerWidth),
  )
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const hostSelector = layout === 'sheet-grid' ? '.sheet-body' : '.ai-dock'
  const widthVariable = layout === 'sheet-grid' ? '--copilot-width' : '--ai-panel-width'
  const availableWidth = useCallback(() => {
    const host = asideRef.current?.closest(hostSelector)
    return (
      (layout === 'sheet-grid' ? host?.clientWidth : host?.parentElement?.clientWidth) ||
      window.innerWidth
    )
  }, [hostSelector, layout])

  useEffect(() => {
    const dock = asideRef.current?.closest(hostSelector) as HTMLElement | null
    dock?.style.setProperty(widthVariable, `${panelWidth}px`)
  }, [panelWidth, open, hostSelector, widthVariable])

  useEffect(() => {
    const onResize = (): void =>
      setPanelWidth(clampAiPanelWidth(preferredWidthRef.current, availableWidth()))
    onResize()
    window.addEventListener('resize', onResize)
    const host = asideRef.current?.closest(hostSelector)
    const parent = layout === 'sheet-grid' ? host : host?.parentElement
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize)
    if (parent) observer?.observe(parent)
    return () => {
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
    }
  }, [open, availableWidth, hostSelector, layout])

  useEffect(() => () => resizeCleanupRef.current?.(), [])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const resizer = event.currentTarget
    const dock =
      layout === 'sheet-grid'
        ? asideRef.current
        : (asideRef.current?.closest(hostSelector) ?? asideRef.current)
    const startWidth = dock?.getBoundingClientRect().width || panelWidth
    const startX = event.clientX
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (pointer: PointerEvent): void => {
      const delta = (pointer.clientX - startX) * (side === 'right' ? -1 : 1)
      const width = clampAiPanelWidth(startWidth + delta, availableWidth())
      preferredWidthRef.current = width
      setPanelWidth(width)
    }
    let done = false
    const cleanup = (): void => {
      if (done) return
      done = true
      resizeCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      resizer.removeEventListener('lostpointercapture', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
      if (storageKey) {
        localStorage.setItem(storageKey, String(Math.round(preferredWidthRef.current)))
      }
    }
    resizeCleanupRef.current = cleanup

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    resizer.addEventListener('lostpointercapture', cleanup)
    resizer.setPointerCapture(event.pointerId)
  }

  const resizerProps: AiPanelWidth['resizerProps'] = {
    tabIndex: 0,
    'aria-valuenow': Math.round(panelWidth),
    'aria-valuemin': MIN_WIDTH,
    'aria-valuemax': clampAiPanelWidth(availableWidth(), availableWidth()),
    onKeyDown(event) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const width =
        event.key === 'Home'
          ? MIN_WIDTH
          : event.key === 'End'
            ? availableWidth()
            : panelWidth + (event.key === 'ArrowRight' ? 10 : -10) * (side === 'right' ? -1 : 1)
      const clamped = clampAiPanelWidth(width, availableWidth())
      preferredWidthRef.current = clamped
      setPanelWidth(clamped)
      if (storageKey) localStorage.setItem(storageKey, String(Math.round(clamped)))
    },
  }
  return { panelId, asideRef, resizing, startResize, resizerProps }
}
