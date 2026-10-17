import type { Lang } from '@genoffice/i18n'

export interface NamedFontSize {
  readonly name: string
  readonly pt: number
}

export const FONT_SIZE_MIN_PT = 1
export const FONT_SIZE_MAX_PT = 1638

const SIZES_LATIN_UI = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]
const SIZES_JA_UI = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]

/** Supported UI languages use numeric font sizes. */
export function namedFontSizes(_lang: Lang): readonly NamedFontSize[] {
  return []
}

/** The numeric part of Word's size list for this UI language */
export function fontSizeList(lang: Lang): readonly number[] {
  switch (lang) {
    case 'ja':
      return SIZES_JA_UI
    default:
      return SIZES_LATIN_UI
  }
}

/** Every dropdown row: named sizes first, then the numeric list */
export function fontSizeOptions(lang: Lang): readonly NamedFontSize[] {
  return [...namedFontSizes(lang), ...fontSizeList(lang).map((pt) => ({ name: String(pt), pt }))]
}

function sameSize(a: number, b: number): boolean {
  return Math.round(a * 2) === Math.round(b * 2)
}

/** What the size box shows: the CJK name when the size has one in this UI, else the number */
export function fontSizeLabel(pt: number, lang: Lang): string {
  return namedFontSizes(lang).find((n) => sameSize(n.pt, pt))?.name ?? String(pt)
}

export function clampFontSize(pt: number): number {
  return Math.min(FONT_SIZE_MAX_PT, Math.max(FONT_SIZE_MIN_PT, Math.round(pt * 2) / 2))
}

/** Typed text \u2192 points: a CJK size name, or a number rounded to half points; null when unusable */
export function parseFontSize(text: string, lang: Lang): number | null {
  const raw = text.trim().normalize('NFKC')
  if (!raw) return null
  const named = namedFontSizes(lang).find((n) => n.name === raw)
  if (named) return named.pt
  const n = Number(raw.replace(/\s*(pt|\u78c5)$/i, ''))
  return Number.isFinite(n) && n > 0 ? clampFontSize(n) : null
}

/**
 * Increase / Decrease Font Size: walk the language's list; above its top go
 * 80, 90, 100, ... by tens up to 1638; below its bottom move one point at a time
 * down to 1.
 */
export function stepFontSize(base: number, dir: 1 | -1, lang: Lang): number {
  const list = fontSizeList(lang)
  const min = list[0]
  const max = list[list.length - 1]
  if (dir === 1) {
    if (base >= max)
      return Math.min(FONT_SIZE_MAX_PT, base < 80 ? 80 : Math.floor(base / 10) * 10 + 10)
    if (base < min) return Math.min(min, Math.floor(base) + 1)
    return list.find((s) => s > base) ?? max
  }
  if (base > max) return base > 80 ? Math.ceil(base / 10) * 10 - 10 : max
  if (base <= min) return Math.max(FONT_SIZE_MIN_PT, Math.ceil(base) - 1)
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] < base) return list[i]
  return min
}
