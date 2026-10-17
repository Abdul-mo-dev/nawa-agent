import type { StringKey } from '../i18n/locale'

/** Shared English, Japanese and Arabic translation targets for both menus. */
export const TRANSLATE_LANGS = [
  { code: 'en', key: 'English' },
  { code: 'ja', key: 'Japanese' },
  { code: 'ar', key: 'Arabic' },
] as const

export type TranslateLang = (typeof TRANSLATE_LANGS)[number]['code']

/** The right-click menu's i18n key for a language. */
export function appLangKey(code: TranslateLang): StringKey {
  const entry = TRANSLATE_LANGS.find((l) => l.code === code)
  return `appLang${entry?.key ?? ''}` as StringKey
}

/** The ribbon dropdown's i18n key for a language. */
export function ribbonLangKey(code: TranslateLang): StringKey {
  const entry = TRANSLATE_LANGS.find((l) => l.code === code)
  return `ribbonLang${entry?.key ?? ''}` as StringKey
}
