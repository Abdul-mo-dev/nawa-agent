/** CSS-pixel measurements supplied only by the trusted shell renderer. */
export interface ExplorerLayout {
  left: number
  top: number
  bottom: number
  suspended: boolean
}
export const EXPLORER_LAYOUT_CHANNEL = 'nawa:explorer-layout'
export const DEFAULT_EXPLORER_LAYOUT: ExplorerLayout = { left: 0, top: 40, bottom: 0, suspended: false }
export function validExplorerLayout(value: unknown): value is ExplorerLayout {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return ['left', 'top', 'bottom'].every(key => typeof p[key] === 'number' && Number.isFinite(p[key]) && (p[key] as number) >= 0 && (p[key] as number) <= 10_000)
    && typeof p.suspended === 'boolean'
}
/** Fullscreen/Present bypass this helper in TabManager. Sizes are Electron DIPs. */
export function explorerBounds(width: number, height: number, layout: ExplorerLayout) {
  const left = Math.min(Math.round(layout.left), Math.max(0, width - 320))
  const top = Math.min(Math.max(40, Math.round(layout.top)), Math.max(0, height - 120))
  const bottom = Math.min(Math.round(layout.bottom), Math.max(0, height - top - 120))
  return { x: left, y: top, width: Math.max(0, width - left), height: Math.max(0, height - top - bottom) }
}
