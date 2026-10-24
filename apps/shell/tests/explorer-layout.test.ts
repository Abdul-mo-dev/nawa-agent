import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPLORER_LAYOUT,
  explorerBounds,
  validExplorerLayout,
} from '../src/shared/explorer-layout'

describe('native editor bounds', () => {
  it('reserves both sidebars and mirrors the central slot', () => {
    const ltr = { left: 600, right: 80, top: 100, bottom: 30, suspended: false }
    const rtl = { ...ltr, left: ltr.right, right: ltr.left }
    expect(explorerBounds(1400, 900, ltr)).toEqual({ x: 600, y: 100, width: 720, height: 770 })
    expect(explorerBounds(1400, 900, rtl)).toEqual({ x: 80, y: 100, width: 720, height: 770 })
  })
  it('keeps the legacy full-width slot and clamps oversized insets', () => {
    expect(explorerBounds(1200, 800, DEFAULT_EXPLORER_LAYOUT)).toEqual({
      x: 0,
      y: 40,
      width: 1200,
      height: 760,
    })
    const bounds = explorerBounds(800, 600, { ...DEFAULT_EXPLORER_LAYOUT, left: 900, right: 900 })
    expect(bounds.width).toBe(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(800)
  })
  it('keeps a narrow editor inside its slot without covering navigation', () => {
    expect(
      explorerBounds(800, 600, { ...DEFAULT_EXPLORER_LAYOUT, left: 300, right: 300 }).width,
    ).toBe(200)
  })
  it('rejects invalid right-side measurements at the IPC boundary', () => {
    expect(validExplorerLayout(DEFAULT_EXPLORER_LAYOUT)).toBe(true)
    for (const right of [undefined, -1, NaN, Infinity, 10_001, '200']) {
      expect(validExplorerLayout({ ...DEFAULT_EXPLORER_LAYOUT, right })).toBe(false)
    }
  })
})
