import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import {
  TRANSLATE_LANGS,
  appLangKey,
  ribbonLangKey,
} from '../src/renderer/components/translate-langs'

describe('translation language menu', () => {
  it('offers only the three supported languages', () => {
    expect(TRANSLATE_LANGS.map((entry) => entry.code)).toEqual(LANGS)
  })
  it.each([
    ['en', 'English'],
    ['ja', 'Japanese'],
    ['ar', 'Arabic'],
  ] as const)('maps %s to the labels on both surfaces', (code, key) => {
    expect(appLangKey(code)).toBe('appLang' + key)
    expect(ribbonLangKey(code)).toBe('ribbonLang' + key)
  })
  it('has distinct labels on each surface', () => {
    expect(new Set(TRANSLATE_LANGS.map((entry) => appLangKey(entry.code))).size).toBe(3)
    expect(new Set(TRANSLATE_LANGS.map((entry) => ribbonLangKey(entry.code))).size).toBe(3)
  })
})
