import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { agentStatusText } from '../src/strings-agent-status'

it('provides localized history, stopped, incomplete and transport states in all supported languages', () => {
  const en = agentStatusText('en')
  for (const lang of ['ja', 'ar'] as const) {
    const translated = agentStatusText(lang)
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(translated[key].trim()).not.toBe('')
      expect(translated[key]).not.toBe(en[key])
    }
  }
})

it('keeps chat placeholders at readable contrast in light, dark and system dark themes', () => {
  const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8')
  const colors = [...css.matchAll(/--text-placeholder:\s*(#[\da-f]{6})/g)].map((match) => match[1]!)
  const sidebarColors = [...css.matchAll(/--sidebar-background:\s*(#[\da-f]{6})/g)].map(
    (match) => match[1]!,
  )
  expect(colors).toHaveLength(3)
  expect(sidebarColors).toHaveLength(3)
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5]
      .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
  }
  for (let index = 0; index < colors.length; index++) {
    const fg = luminance(colors[index]!)
    for (const background of [
      ...(index ? ['#20242b', '#1e1e1e'] : ['#ffffff']),
      sidebarColors[index]!,
    ]) {
      const bg = luminance(background)
      expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  }
})
