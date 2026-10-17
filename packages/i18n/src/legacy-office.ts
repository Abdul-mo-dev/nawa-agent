import { createI18n } from './core'
import type { Lang, Params } from './core'
import { en } from './legacy-office/en'
import { ja } from './legacy-office/ja'
import { ar } from './legacy-office/ar'

const messages = {
  en,
  ja,
  ar,
}
const translate = createI18n(messages)

export function legacyOfficeMessage(lang: Lang, key: keyof typeof en, params?: Params): string {
  return translate(lang, key, params)
}
