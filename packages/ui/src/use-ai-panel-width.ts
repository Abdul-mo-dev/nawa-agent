import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { aiPanelWidthAtPointer } from './ai-panel-prefs-store'

const DEFAULT_WIDTH = 360
const MIN_WIDTH = 280
const MAX_WIDTH = 720

function clampPreferredWidth(width: number): number {
  return Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH)
}

/** Keep the preferred width even while a temporarily narrow viewport displays less. */
export function clampAiPanelWidth(width: number, viewportWidth: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(viewportWidth * 0.6)))
  return Math.min(Math.max(width, MIN_WIDTH), max)
}

function loadPreferredWidth(storageKey?: string): number {
  if (!storageKey) return DEFAULT_WIDTH
  const saved = Number(localStorage.getItem(storageKey))
  return Number.isFinite(saved) && saved > 0 ? clampPreferredWidth(saved) : DEFAULT_WIDTH
}

export interface AiPanelWidth {
  asideRef: RefObject<HTMLElement | null>
  resizing: boolean
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/** Shared dock width, pointer drag, and optional per-app persistence. */
export function useAiPanelWidth(storageKey?: string, open?: boolean): AiPanelWidth {
  const [preferredWidth] = useState(() => loadPreferredWidth(storageKey))
  const preferredWidthRef = useRef(preferredWidth)
  const [panelWidth, setPanelWidth] = useState(() =>
    clampAiPanelWidth(preferredWidth, window.innerWidth),
  )
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const dock = asideRef.current?.closest('.ai-dock') as HTMLElement | null
    dock?.style.setProperty('--ai-panel-width', `${panelWidth}px`)
  }, [panelWidth, open])

  useEffect(() => {
    const onResize = (): void =>
      setPanelWidth(clampAiPanelWidth(preferredWidthRef.current, window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => () => resizeCleanupRef.current?.(), [])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const resizer = event.currentTarget
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (pointer: PointerEvent): void => {
      const width = clampAiPanelWidth(aiPanelWidthAtPointer(pointer.clientX), window.innerWidth)
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

  return { asideRef, resizing, startResize }
}
